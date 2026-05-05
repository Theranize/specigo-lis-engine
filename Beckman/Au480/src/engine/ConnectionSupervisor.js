/**
 * ConnectionSupervisor.js
 * SpeciGo LIS Integration Engine - Generic connect-with-retry helper
 *
 * Encapsulates the exponential-backoff retry loop used by the engine to
 * bring up the serial port and the database. Both subsystems used to
 * carry near-identical retry code; this module is the single source of
 * truth for that pattern.
 *
 * Lifecycle:
 *   const sup = new ConnectionSupervisor({
 *     name          : 'Serial port',
 *     connectFn     : () => serialManager.connect(),
 *     initialDelayMs: 5000,
 *     maxDelayMs    : 60000,
 *     logger
 *   });
 *
 *   sup.run();                 // start the retry loop (fire-and-forget)
 *   sup.notifyDisconnected();  // call when the resource drops mid-session
 *   sup.stop();                // cancel and exit
 *   sup.isRetrying();          // -> true while retrying after failure
 *   sup.isConnected();         // -> true once connectFn() resolved
 */

'use strict';

class ConnectionSupervisor {

  /**
   * @param {object}   options
   * @param {string}   options.name           - human label, used in logs
   * @param {Function} options.connectFn      - async () => void; resolves on success
   * @param {number}   [options.initialDelayMs=5000]
   * @param {number}   [options.maxDelayMs=60000]
   * @param {object}   options.logger         - winston logger instance
   */
  constructor({ name, connectFn, initialDelayMs = 5000, maxDelayMs = 60000, logger }) {
    if (!name || typeof name !== 'string') {
      throw new Error('ConnectionSupervisor: name is required');
    }
    if (typeof connectFn !== 'function') {
      throw new Error('ConnectionSupervisor: connectFn must be a function');
    }
    if (!logger) {
      throw new Error('ConnectionSupervisor: logger is required');
    }

    this._name           = name;
    this._connectFn      = connectFn;
    this._initialDelayMs = initialDelayMs;
    this._maxDelayMs     = maxDelayMs;
    this._logger         = logger;

    this._running   = false;
    this._connected = false;
    this._retrying  = false;
    this._delayTimer = null;
    this._loopActive = false;
  }

  // -------------------------------------------------------------------------
  // Public state queries
  // -------------------------------------------------------------------------

  isConnected() { return this._connected; }
  isRetrying()  { return this._retrying;  }

  // -------------------------------------------------------------------------
  // Public control
  // -------------------------------------------------------------------------

  /**
   * Start the retry loop. Resolves the moment `connectFn()` succeeds,
   * or when `stop()` is invoked. Safe to call multiple times - a second
   * invocation while the loop is active is a no-op.
   */
  async run() {
    if (this._loopActive) return;
    this._loopActive = true;
    this._running    = true;
    this._retrying   = true;

    let delayMs = this._initialDelayMs;

    while (this._running && !this._connected) {
      try {
        this._logger.info(`Attempting ${this._name} connection...`);
        await this._connectFn();
        this._connected = true;
        this._retrying  = false;
        this._logger.info(`${this._name} connected`);
        break;
      } catch (err) {
        if (!this._running) break;

        this._logger.warn(
          `${this._name} unavailable, retrying in ${delayMs / 1000}s`,
          { error: err.message }
        );

        await this._sleep(delayMs);
        delayMs = Math.min(delayMs * 2, this._maxDelayMs);
      }
    }

    this._retrying   = false;
    this._loopActive = false;

    if (!this._connected && !this._running) {
      this._logger.info(`${this._name} retry loop cancelled (supervisor stopped)`);
    }
  }

  /**
   * Mark the connection as broken and re-enter the retry loop. Used when
   * the underlying resource emits a disconnect event mid-session.
   */
  notifyDisconnected() {
    this._connected = false;
    if (!this._running) return;
    if (this._loopActive) return;
    this.run().catch((err) => {
      this._logger.error(`${this._name} supervisor crashed`, { error: err.message });
    });
  }

  /**
   * Cancel any in-flight retry sleep and exit the loop on its next tick.
   */
  stop() {
    this._running   = false;
    this._connected = false;
    this._retrying  = false;
    if (this._delayTimer) {
      clearTimeout(this._delayTimer);
      this._delayTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _sleep(ms) {
    return new Promise((resolve) => {
      this._delayTimer = setTimeout(() => {
        this._delayTimer = null;
        resolve();
      }, ms);
    });
  }
}

module.exports = ConnectionSupervisor;
