/**
 * SerialPortManager.js
 * SpeciGo LIS Integration Engine - Transport Layer
 *
 * Manages the RS-232 serial connection to the Beckman Coulter Access 2
 * analyser. Confirmed settings from MMI Diagnostics (07 April 2026) via
 * the Access 2 LIS Settings screen photograph:
 *   Port      : COM2
 *   Baud rate : 9600
 *   Data bits : 8
 *   Parity    : None
 *   Stop bits : 1
 *   Flow ctrl : None
 *
 * This module is an EventEmitter. IntegrationEngine subscribes to its
 * events. It does NOT parse data - it only delivers raw byte buffers to
 * the engine. It also does NOT implement reconnection logic - the engine
 * (via ConnectionSupervisor) is the sole owner of retry policy.
 *
 * Public API:
 *   await manager.connect()           - open the serial port
 *   await manager.disconnect()        - close the port and stop emitting
 *   await manager.write(buffer)       - write bytes (used by ASTM ACK/NAK)
 *   manager.getStatus()               - snapshot for the dashboard
 *
 * Events emitted:
 *   'connected'    -> ()
 *   'disconnected' -> (reason: string)
 *   'data'         -> (chunk: Buffer)
 *   'error'        -> (err: Error)
 */

'use strict';

const { EventEmitter } = require('events');
const { SerialPort }   = require('serialport');

const logger = require('../logger').createLogger('SERIAL');

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
   * @param {string} config.parity       - 'none'
   * @param {string} [config.analyzerUid] - log context only
   * @param {string} [config.labUid]      - log context only
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

    this._port    = null;
    this._isOpen  = false;
    this._running = false;

    this.stats = {
      bytesReceived   : 0,
      connectedAt     : null,
      disconnectedAt  : null,
      lastByteAt      : null,
      totalConnections: 0
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
    if (this._isOpen) {
      logger.warn('connect() called but port is already open', { port: this._config.port });
      return;
    }
    this._running = true;
    logger.info('Opening serial port', {
      port    : this._config.port,
      baudRate: this._config.baudRate
    });
    await this._openPort();
  }

  async disconnect() {
    this._running = false;
    await this._closePort('manual disconnect');
    logger.info('Serial port disconnected by application request', { port: this._config.port });
  }

  /**
   * Write raw bytes to the serial port. Rejects when the port is closed.
   * Used by ASTMFramer to send ACK / NAK responses.
   *
   * @param {Buffer} buffer
   * @returns {Promise<void>}
   */
  write(buffer) {
    return new Promise((resolve, reject) => {
      if (!this._port || !this._isOpen) {
        return reject(new Error('Cannot write to port: port is not open'));
      }
      this._port.write(buffer, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  getStatus() {
    return {
      port    : this._config.port,
      baudRate: this._config.baudRate,
      isOpen  : this._isOpen,
      stats   : { ...this.stats }
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
        rtscts  : this._config.rtscts,
        xon     : this._config.xon,
        xoff    : this._config.xoff,
        // autoOpen MUST be false. The library otherwise opens the port
        // before our event listeners are attached, which can race the
        // 'open' event and leave _openPort() hanging forever.
        autoOpen: false
      });

      // Settle guard. The 'error' event and the open() callback can fire
      // for the same underlying failure - we resolve / reject exactly once.
      let settled = false;

      const cleanupFailedPort = () => {
        try {
          port.removeAllListeners('open');
          port.removeAllListeners('data');
          port.removeAllListeners('error');
          port.removeAllListeners('close');
          if (port.isOpen) port.close(() => {});
          if (typeof port.destroy === 'function') port.destroy();
        } catch { /* best-effort */ }
      };

      port.on('open', () => {
        if (settled) return;
        settled = true;

        this._port              = port;
        this._isOpen            = true;
        this.stats.connectedAt  = new Date();
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

        if (!settled) {
          settled = true;
          cleanupFailedPort();
          return reject(err);
        }
        // Errors after the port was successfully opened: surfaced via the
        // 'error' event above. The 'close' handler below tells the engine
        // about the disconnect; the engine (via ConnectionSupervisor)
        // owns the retry policy.
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
        } else {
          logger.info('Serial port closed cleanly', { port: this._config.port });
          this.emit('disconnected', this._running ? 'unexpected close' : 'clean close');
        }

        // Reject the open promise if close fired before 'open'. This can
        // happen on systems where a failed open emits close instead of (or
        // in addition to) error.
        if (!settled) {
          settled = true;
          cleanupFailedPort();
          return reject(err || new Error('Serial port closed before open completed'));
        }

        // Note: no internal reconnect. The engine listens for the
        // 'disconnected' event and decides whether to retry.
        void wasOpen;
      });

      port.open((err) => {
        if (err) {
          logger.error('port.open() callback error', {
            port : this._config.port,
            error: err.message,
            code : err.code
          });
          if (!settled) {
            settled = true;
            cleanupFailedPort();
            return reject(err);
          }
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal - port close with Windows handle-release grace period
  // ---------------------------------------------------------------------------

  async _closePort(reason) {
    return new Promise((resolve) => {
      const port = this._port;

      if (!port) {
        logger.debug('_closePort called but no port instance present', {
          port  : this._config.port,
          reason
        });
        this._isOpen = false;
        return resolve();
      }

      logger.info('Closing serial port', { port: this._config.port, reason });

      // Detach all listeners on the dying port instance so stale
      // data/error/close events do not interfere with shutdown or with
      // the next SerialPort instance opened on the same path.
      port.removeAllListeners('data');
      port.removeAllListeners('error');
      port.removeAllListeners('open');
      port.removeAllListeners('close');

      this._port   = null;
      this._isOpen = false;

      // Grace period applied AFTER the close callback fires. On Windows
      // the kernel does not always release the COM handle synchronously;
      // without this delay an immediate restart on the same COM path can
      // fail with "Access denied".
      const PORT_RELEASE_GRACE_MS = 1500;
      const finish = () => setTimeout(resolve, PORT_RELEASE_GRACE_MS);

      const forceTearDown = () => {
        try {
          if (typeof port.destroy === 'function') port.destroy();
        } catch { /* best-effort */ }
      };

      const finalize = (err) => {
        if (err) {
          logger.warn('Error while closing serial port', {
            port : this._config.port,
            error: err.message,
            code : err.code
          });
        } else {
          logger.info('Serial port closed - waiting for OS handle release', {
            port   : this._config.port,
            graceMs: PORT_RELEASE_GRACE_MS
          });
        }
        forceTearDown();
        finish();
      };

      try {
        if (typeof port.isOpen === 'boolean' ? port.isOpen : true) {
          port.close(finalize);
        } else {
          finalize();
        }
      } catch (err) {
        finalize(err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = SerialPortManager;
