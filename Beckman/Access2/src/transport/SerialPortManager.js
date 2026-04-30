/**
 * SerialPortManager.js
 * SpeciGo LIS Integration Engine - Transport Layer
 *
 * Manages the RS-232 serial connection to the Beckman Coulter Access 2 analyser.
 * Confirmed settings from MMI Diagnostics (07 April 2026) via the Access 2
 * LIS Settings screen photograph:
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
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [SERIAL] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.File({
      filename: 'logs/serial-error.log',
      level   : 'error',
      maxsize : 5 * 1024 * 1024,
      maxFiles: 14,
      tailable: true
    }),
    new winston.transports.File({
      filename: 'logs/serial-combined.log',
      maxsize : 10 * 1024 * 1024,
      maxFiles: 14,
      tailable: true
    }),
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
// Tuned for a lab environment where the Access 2 may be powered off overnight.
// ---------------------------------------------------------------------------
const RECONNECT_INITIAL_DELAY_MS   = 5000;
const RECONNECT_MAX_DELAY_MS       = 60000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// SerialPortManager class
// ---------------------------------------------------------------------------
class SerialPortManager extends EventEmitter {

  /**
   * @param {object} config
   * @param {string} config.port         - e.g. 'COM2'
   * @param {number} config.baudRate     - 9600 for Access 2
   * @param {number} config.dataBits     - 8
   * @param {number} config.stopBits     - 1
   * @param {string} config.parity      - 'none'
   * @param {string} config.flowControl - 'none'
   * @param {string} config.analyzerUid - Used in log context only
   * @param {string} config.labUid      - Used in log context only
   */
  constructor(config) {
    super();

    const required = ['port', 'baudRate', 'dataBits', 'stopBits', 'parity'];
    for (const field of required) {
      if (config[field] === undefined || config[field] === null) {
        throw new Error(`SerialPortManager: missing required config field "${field}"`);
      }
    }

    this._config = config;

    this._port             = null;
    this._isOpen           = false;
    this._isReconnecting   = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;
    this._destroyed        = false;

    this.stats = {
      bytesReceived    : 0,
      connectedAt      : null,
      disconnectedAt   : null,
      lastByteAt       : null,
      reconnectAttempts: 0,
      totalConnections : 0
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

  async disconnect() {
    this._destroyed = true;
    this._cancelReconnectTimer();
    await this._closePort('manual disconnect');
    logger.info('Serial port disconnected by application request', { port: this._config.port });
  }

  async destroy() {
    this._destroyed = true;
    this._cancelReconnectTimer();
    if (this._port && this._isOpen) {
      await this._closePort('destroy');
    }
    this._port = null;
    logger.info('SerialPortManager destroyed', { port: this._config.port });
  }

  getStatus() {
    return {
      port          : this._config.port,
      baudRate      : this._config.baudRate,
      isOpen        : this._isOpen,
      isReconnecting: this._isReconnecting,
      stats         : { ...this.stats }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - port open
  // ---------------------------------------------------------------------------

  _openPort() {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path    : this._config.port,
        baudRate: this._config.baudRate,
        dataBits: this._config.dataBits,
        stopBits: this._config.stopBits,
        parity  : this._config.parity,
        rtscts  : false,
        xon     : false,
        xoff    : false,
        autoOpen: false
      });

      port.on('open', () => {
        this._port             = port;
        this._isOpen           = true;
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

      port.on('data', (chunk) => {
        this.stats.bytesReceived += chunk.length;
        this.stats.lastByteAt    = new Date();
        this.emit('data', chunk);
      });

      port.on('error', (err) => {
        logger.error('Serial port error', {
          port : this._config.port,
          error: err.message,
          code : err.code
        });
        this.emit('error', err);

        if (!this._isOpen) {
          this._scheduleReconnect();
        } else {
          reject(err);
        }
      });

      port.on('close', (err) => {
        const wasOpen = this._isOpen;
        this._isOpen  = false;
        this.stats.disconnectedAt = new Date();

        if (err) {
          logger.warn('Serial port closed with error', {
            port : this._config.port,
            error: err.message
          });
          this.emit('disconnected', `close error: ${err.message}`);
          if (!this._destroyed && wasOpen) {
            this._scheduleReconnect();
          }
        } else {
          logger.info('Serial port closed cleanly', { port: this._config.port });
          this.emit('disconnected', 'clean close');
        }
      });

      port.open((err) => {
        if (err) {
          logger.error('port.open() callback error', {
            port : this._config.port,
            error: err.message,
            code : err.code
          });
          reject(err);
        }
      });
    });
  }

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
  // Internal - reconnection
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this._destroyed || this._isReconnecting) return;

    this._isReconnecting = true;
    this._reconnectAttempt++;
    this.stats.reconnectAttempts++;

    const baseDelay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, this._reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    const jitter = Math.floor(Math.random() * 1000) - 500;
    const delay  = Math.max(1000, baseDelay + jitter);

    logger.info('Scheduling reconnection attempt', {
      port   : this._config.port,
      attempt: this._reconnectAttempt,
      delayMs: delay
    });

    this.emit('reconnecting', this._reconnectAttempt, delay);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed) return;

      logger.info('Attempting to reconnect', {
        port   : this._config.port,
        attempt: this._reconnectAttempt
      });

      try {
        this._isReconnecting = false;
        await this._openPort();
      } catch (err) {
        logger.warn('Reconnection attempt failed', {
          port   : this._config.port,
          attempt: this._reconnectAttempt,
          error  : err.message
        });
        this._scheduleReconnect();
      }
    }, delay);
  }

  _cancelReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._isReconnecting = false;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = SerialPortManager;
