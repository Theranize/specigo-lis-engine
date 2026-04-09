/**
 * SerialPortManager.js
 * SpeciGo LIS Integration Engine - Transport Layer
 *
 * Manages the RS-232 serial connection to the Beckman Coulter AU480 analyser.
 * Confirmed settings from MMI Diagnostics (08 April 2026):
 *   Port      : COM2
 *   Baud rate : 9600
 *   Data bits : 8
 *   Parity    : None
 *   Stop bits : 1
 *   Flow ctrl : None
 *
 * This module is an EventEmitter. IntegrationEngine.js subscribes to its events.
 * It does NOT parse data - it only delivers raw byte buffers to the engine.
 *
 * Events emitted:
 *   'connected'      -> ()
 *   'disconnected'   -> (reason: string)
 *   'data'           -> (chunk: Buffer)
 *   'error'          -> (err: Error)
 *   'reconnecting'   -> (attempt: number, delayMs: number)
 */

'use strict';

const { EventEmitter } = require('events');
const { SerialPort }   = require('serialport');
const winston          = require('winston');

// ---------------------------------------------------------------------------
// Logger setup
// All modules in SpeciGo LIS Engine write to the same transport-level log file
// so that a single tail command shows the full communication sequence.
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [SERIAL] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    // Daily rotating file - kept for 14 days to cover any audit window
    new winston.transports.File({
      filename: 'logs/serial-error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024,   // 5 MB
      maxFiles: 14,
      tailable: true
    }),
    new winston.transports.File({
      filename: 'logs/serial-combined.log',
      maxsize: 10 * 1024 * 1024,  // 10 MB
      maxFiles: 14,
      tailable: true
    }),
    // Console transport uses a simpler format for on-site monitoring by Umesh
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [SERIAL] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Reconnection policy constants
// These values are tuned for a lab environment where the AU480 may be powered
// off overnight and back on in the morning without manual intervention.
// ---------------------------------------------------------------------------
const RECONNECT_INITIAL_DELAY_MS  = 5000;    // 5 s before first retry
const RECONNECT_MAX_DELAY_MS      = 60000;   // cap at 60 s between retries
const RECONNECT_BACKOFF_MULTIPLIER = 2;      // exponential back-off factor
const RECONNECT_MAX_ATTEMPTS       = 0;      // 0 = retry forever (lab service)

// ---------------------------------------------------------------------------
// SerialPortManager class
// ---------------------------------------------------------------------------
class SerialPortManager extends EventEmitter {

  /**
   * @param {object} config - Connection configuration object
   * @param {string} config.port         - e.g. 'COM2'
   * @param {number} config.baudRate     - 9600 for AU480
   * @param {number} config.dataBits     - 8
   * @param {number} config.stopBits     - 1
   * @param {string} config.parity      - 'none'
   * @param {string} config.flowControl - 'none' (maps to xon/xoff + rtscts both false)
   * @param {string} config.analyzerUid - Used in log context only
   * @param {string} config.labUid      - Used in log context only
   */
  constructor(config) {
    super();

    // Validate required fields immediately so deployment errors are caught early
    const required = ['port', 'baudRate', 'dataBits', 'stopBits', 'parity'];
    for (const field of required) {
      if (config[field] === undefined || config[field] === null) {
        throw new Error(`SerialPortManager: missing required config field "${field}"`);
      }
    }

    this._config = config;

    // State tracking - allows safe polling from the REST status endpoint
    this._port             = null;
    this._isOpen           = false;
    this._isReconnecting   = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;
    this._destroyed        = false;   // set by destroy() to stop reconnect loop

    // Statistics exposed to the dashboard via IntegrationEngine -> API
    this.stats = {
      bytesReceived      : 0,
      messagesReceived   : 0,   // incremented by IntegrationEngine, not here
      connectedAt        : null,
      disconnectedAt     : null,
      lastByteAt         : null,
      reconnectAttempts  : 0,
      totalConnections   : 0
    };

    logger.info('SerialPortManager initialised', {
      port       : config.port,
      baudRate   : config.baudRate,
      dataBits   : config.dataBits,
      stopBits   : config.stopBits,
      parity     : config.parity,
      analyzerUid: config.analyzerUid || 'unknown',
      labUid     : config.labUid      || 'unknown'
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open the serial port and begin receiving data.
   * Safe to call multiple times - does nothing if already open.
   */
  async connect() {
    if (this._destroyed) {
      throw new Error('SerialPortManager has been destroyed. Create a new instance.');
    }

    if (this._isOpen) {
      logger.warn('connect() called but port is already open', { port: this._config.port });
      return;
    }

    if (this._isReconnecting) {
      logger.warn('connect() called while reconnect loop is active - ignoring', {
        port: this._config.port
      });
      return;
    }

    logger.info('Opening serial port', { port: this._config.port, baudRate: this._config.baudRate });
    await this._openPort();
  }

  /**
   * Gracefully close the port and stop any reconnection attempts.
   * Call this on application shutdown.
   */
  async disconnect() {
    this._destroyed = true;
    this._cancelReconnectTimer();
    await this._closePort('manual disconnect');
    logger.info('Serial port disconnected by application request', { port: this._config.port });
  }

  /**
   * Hard close and destroy. Frees OS resources. Instance cannot be reused.
   */
  async destroy() {
    this._destroyed = true;
    this._cancelReconnectTimer();
    if (this._port && this._isOpen) {
      await this._closePort('destroy');
    }
    this._port = null;
    logger.info('SerialPortManager destroyed', { port: this._config.port });
  }

  /**
   * Returns a plain object snapshot of current connection state.
   * Used by the REST API status endpoint.
   */
  getStatus() {
    return {
      port             : this._config.port,
      baudRate         : this._config.baudRate,
      isOpen           : this._isOpen,
      isReconnecting   : this._isReconnecting,
      reconnectAttempt : this._reconnectAttempt,
      stats            : { ...this.stats }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - port open / close
  // ---------------------------------------------------------------------------

  /**
   * Creates and opens a SerialPort instance with AU480-confirmed settings.
   * Resolves when the port is open. Rejects if the port cannot be opened.
   */
  async _openPort() {
    return new Promise((resolve, reject) => {

      // Build serialport options from config.
      // flowControl 'none' means both hardware (rtscts) and software (xon) are off.
      // This matches the AU480 which uses no flow control.
      const portOptions = {
        path    : this._config.port,
        baudRate: this._config.baudRate,
        dataBits: this._config.dataBits,
        stopBits: this._config.stopBits,
        parity  : this._config.parity,
        rtscts  : false,   // hardware flow control OFF - confirmed AU480 setting
        xon     : false,   // XON/XOFF software flow control OFF
        xoff    : false,
        xany    : false,
        // autoOpen false so we can attach listeners before open() is called
        autoOpen: false
      };

      let port;
      try {
        port = new SerialPort(portOptions);
      } catch (err) {
        // Thrown synchronously if options are invalid (e.g. bad baud rate value)
        logger.error('Failed to create SerialPort instance', {
          port : this._config.port,
          error: err.message
        });
        return reject(err);
      }

      // ------ Attach all event handlers before calling open() ------

      port.on('open', () => {
        this._port     = port;
        this._isOpen   = true;
        this._isReconnecting   = false;
        this._reconnectAttempt = 0;

        this.stats.connectedAt    = new Date();
        this.stats.totalConnections++;

        logger.info('Serial port opened successfully', {
          port    : this._config.port,
          baudRate: this._config.baudRate
        });

        this.emit('connected');
        resolve();
      });

      // 'data' fires for every chunk the OS delivers from the serial buffer.
      // We forward raw Buffer objects unchanged - framing (STX/ETX) is handled
      // by MessageFramer.js, not here. This keeps transport and protocol separate.
      port.on('data', (chunk) => {
        this.stats.bytesReceived += chunk.length;
        this.stats.lastByteAt    = new Date();

        logger.debug('Serial data received', {
          bytes: chunk.length,
          hex  : chunk.toString('hex').toUpperCase()
        });

        this.emit('data', chunk);
      });

      port.on('error', (err) => {
        logger.error('Serial port error', {
          port : this._config.port,
          error: err.message,
          code : err.code || 'UNKNOWN'
        });

        this.emit('error', err);

        // If the port was open when this error fired, treat as unexpected disconnect
        if (this._isOpen) {
          this._isOpen               = false;
          this.stats.disconnectedAt  = new Date();
          this.emit('disconnected', `port error: ${err.message}`);
          this._scheduleReconnect();
        } else {
          // Error during the initial open attempt - reject the connect() promise
          reject(err);
        }
      });

      port.on('close', (err) => {
        // 'close' fires after open() succeeds, then port closes unexpectedly
        // OR after we call port.close() ourselves.
        const wasOpen = this._isOpen;
        this._isOpen  = false;
        this.stats.disconnectedAt = new Date();

        if (err) {
          // Disconnected with an error (e.g. USB-to-serial adapter pulled)
          logger.warn('Serial port closed with error', {
            port : this._config.port,
            error: err.message
          });
          this.emit('disconnected', `close error: ${err.message}`);

          if (!this._destroyed && wasOpen) {
            this._scheduleReconnect();
          }
        } else {
          // Clean close - either we called disconnect() or OS closed it
          logger.info('Serial port closed cleanly', { port: this._config.port });
          this.emit('disconnected', 'clean close');
          // Do NOT schedule reconnect on a clean close - that would fight the
          // application trying to shut down orderly.
        }
      });

      // Now actually open the port
      port.open((err) => {
        if (err) {
          logger.error('port.open() callback error', {
            port : this._config.port,
            error: err.message,
            code : err.code
          });
          // 'error' event may also fire - but we reject here to be explicit
          reject(err);
        }
        // Success case is handled in the 'open' event above
      });
    });
  }

  /**
   * Closes the port instance cleanly.
   * Resolves even if the port was already closed (idempotent).
   */
  async _closePort(reason) {
    return new Promise((resolve) => {
      if (!this._port || !this._isOpen) {
        logger.debug('_closePort called but port is not open', {
          port  : this._config.port,
          reason: reason
        });
        return resolve();
      }

      logger.info('Closing serial port', { port: this._config.port, reason });

      this._port.close((err) => {
        if (err) {
          // Log but do not reject - if we are shutting down, we accept errors here
          logger.warn('Error while closing serial port', {
            port : this._config.port,
            error: err.message
          });
        }
        this._isOpen = false;
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal - reconnection logic
  // ---------------------------------------------------------------------------

  /**
   * Schedules a reconnection attempt using exponential back-off.
   * Backs off from 5 s up to a cap of 60 s to avoid hammering the OS
   * if the analyser is powered off for an extended period.
   */
  _scheduleReconnect() {
    if (this._destroyed) {
      logger.debug('Reconnect cancelled - manager is destroyed');
      return;
    }

    if (this._isReconnecting) {
      logger.debug('Reconnect already scheduled - skipping duplicate');
      return;
    }

    this._isReconnecting = true;
    this._reconnectAttempt++;
    this.stats.reconnectAttempts++;

    // Exponential back-off with jitter (+/- 500 ms) to avoid thundering-herd
    // if multiple integration instances restart at the same time.
    const baseDelay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, this._reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    const jitter    = Math.floor(Math.random() * 1000) - 500;
    const delay     = Math.max(1000, baseDelay + jitter);   // minimum 1 s

    logger.info('Scheduling reconnection attempt', {
      port   : this._config.port,
      attempt: this._reconnectAttempt,
      delayMs: delay
    });

    this.emit('reconnecting', this._reconnectAttempt, delay);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;

      if (this._destroyed) {
        logger.debug('Reconnect timer fired but manager is destroyed - aborting');
        return;
      }

      logger.info('Attempting to reconnect', {
        port   : this._config.port,
        attempt: this._reconnectAttempt
      });

      try {
        // Reset reconnecting flag before _openPort so that the 'error' handler
        // inside _openPort can schedule the NEXT reconnect correctly.
        this._isReconnecting = false;
        await this._openPort();
        // On success the 'open' event resets _reconnectAttempt to 0
        logger.info('Reconnection successful', {
          port   : this._config.port,
          attempt: this._reconnectAttempt
        });
      } catch (err) {
        logger.warn('Reconnection attempt failed', {
          port   : this._config.port,
          attempt: this._reconnectAttempt,
          error  : err.message
        });
        // _openPort's error handler will have called _scheduleReconnect again
        // BUT only if _isOpen was true when the error fired. Since we never
        // got to 'open', we need to schedule explicitly here.
        if (!this._isOpen && !this._isReconnecting && !this._destroyed) {
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Cancels any pending reconnect timer.
   * Must be called before a clean shutdown.
   */
  _cancelReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._isReconnecting = false;
      logger.debug('Reconnect timer cancelled', { port: this._config.port });
    }
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = SerialPortManager;
