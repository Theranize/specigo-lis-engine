/**
 * TcpServerManager.js
 * SpeciGo LIS Integration Engine - Transport Layer (TCP/IP variant)
 *
 * Manages the TCP/IP connection to the Mindray BS-230 chemistry analyser.
 * In TCP mode the analyser is configured with the LIS host IP/port and
 * dials OUT to the LIS — therefore the engine runs a TCP listener and
 * accepts the analyser as the connecting client.
 *
 * The wire-level ASTM E1394 / LIS2-A2 framing transmitted over the socket
 * is byte-identical to the RS-232 variant (per BS-230 Operator's Manual
 * section 1.4.8). Only the physical transport differs, which means
 * ASTMFramer, BS230Parser, ParameterMapper, ResultWriter are reused
 * verbatim from the serial build.
 *
 * This module is an EventEmitter. IntegrationEngine subscribes to its
 * events. It does NOT parse data — it only delivers raw byte buffers to
 * the engine. It also does NOT implement reconnection logic — the engine
 * (via ConnectionSupervisor) is the sole owner of retry policy.
 *
 * Public API:
 *   await manager.connect()           - bind the TCP listener
 *   await manager.disconnect()        - close listener + active peer
 *   await manager.write(buffer)       - write bytes to the active peer
 *   manager.getStatus()               - snapshot for the dashboard
 *
 * Events emitted:
 *   'connected'        -> ()                     listener bound; supervisor's
 *                                                connectFn() resolves on this
 *   'disconnected'     -> (reason: string)       listener stopped — supervisor
 *                                                should retry
 *   'peerConnected'    -> (peerAddress: string)  analyser attached
 *   'peerDisconnected' -> (reason: string)       analyser detached; listener
 *                                                stays up, NO retry needed
 *   'data'             -> (chunk: Buffer)        bytes from the active peer
 *   'error'            -> (err: Error)
 */

'use strict';

const net           = require('net');
const { EventEmitter } = require('events');

const logger = require('../logger').createLogger('TCP');

// ---------------------------------------------------------------------------
// TcpServerManager class
// ---------------------------------------------------------------------------
class TcpServerManager extends EventEmitter {

  /**
   * @param {object} config
   * @param {string} [config.host='0.0.0.0']  - listen address; '0.0.0.0' for all interfaces
   * @param {number} config.port              - TCP port to listen on
   * @param {boolean} [config.keepAlive=true] - enable TCP keep-alive on peer sockets
   * @param {number}  [config.keepAliveInitialDelayMs=30000]
   * @param {string}  [config.analyzerUid]    - log context only
   * @param {string}  [config.labUid]         - log context only
   */
  constructor(config) {
    super();

    if (config.port === undefined || config.port === null) {
      throw new Error('TcpServerManager: missing required config field "port"');
    }

    this._config = {
      host                    : config.host                    || '0.0.0.0',
      port                    : config.port,
      keepAlive               : config.keepAlive               !== false,
      keepAliveInitialDelayMs : config.keepAliveInitialDelayMs || 30000,
      analyzerUid             : config.analyzerUid             || 'unknown',
      labUid                  : config.labUid                  || 'unknown'
    };

    this._server     = null;
    this._peer       = null;
    this._isListening = false;
    this._running    = false;

    this.stats = {
      bytesReceived    : 0,
      listenerBoundAt  : null,
      listenerClosedAt : null,
      peerConnectedAt  : null,
      peerDisconnectedAt: null,
      lastByteAt       : null,
      totalConnections : 0,
      totalPeers       : 0
    };

    logger.info('TcpServerManager initialised', {
      host       : this._config.host,
      port       : this._config.port,
      keepAlive  : this._config.keepAlive,
      analyzerUid: this._config.analyzerUid,
      labUid     : this._config.labUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Bind the TCP listener. Resolves once the listener is ready to accept
   * peers. Rejects on bind failure (e.g. EADDRINUSE) — supervisor retries.
   */
  async connect() {
    if (this._isListening) {
      logger.warn('connect() called but listener is already bound', {
        host: this._config.host,
        port: this._config.port
      });
      return;
    }
    this._running = true;
    logger.info('Starting TCP listener', {
      host: this._config.host,
      port: this._config.port
    });
    await this._startServer();
  }

  /**
   * Close the listener and any active peer socket cleanly.
   */
  async disconnect() {
    this._running = false;
    await this._stopServer('manual disconnect');
    logger.info('TCP listener disconnected by application request', {
      host: this._config.host,
      port: this._config.port
    });
  }

  /**
   * Write raw bytes to the active peer socket. Rejects when no peer is
   * currently attached. Used by ASTMFramer to send ACK / NAK responses.
   *
   * @param {Buffer} buffer
   * @returns {Promise<void>}
   */
  write(buffer) {
    return new Promise((resolve, reject) => {
      if (!this._peer || this._peer.destroyed) {
        return reject(new Error('Cannot write: no analyser peer connected'));
      }
      this._peer.write(buffer, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  getStatus() {
    return {
      host         : this._config.host,
      port         : this._config.port,
      isOpen       : this._isListening,
      peerConnected: !!(this._peer && !this._peer.destroyed),
      peerAddress  : this._peer && !this._peer.destroyed
        ? `${this._peer.remoteAddress}:${this._peer.remotePort}`
        : null,
      stats        : { ...this.stats }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — listener lifecycle
  // ---------------------------------------------------------------------------

  _startServer() {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false });

      let settled = false;

      const cleanupFailedServer = () => {
        try {
          server.removeAllListeners();
          if (server.listening) server.close();
        } catch { /* best-effort */ }
      };

      server.on('listening', () => {
        if (settled) return;
        settled = true;

        this._server            = server;
        this._isListening       = true;
        this.stats.listenerBoundAt = new Date();
        this.stats.totalConnections++;

        logger.info('TCP listener bound', {
          host: this._config.host,
          port: this._config.port
        });

        this.emit('connected');
        resolve();
      });

      server.on('connection', (socket) => this._onPeerConnection(socket));

      server.on('error', (err) => {
        logger.error('TCP listener error', {
          host : this._config.host,
          port : this._config.port,
          error: err.message,
          code : err.code
        });
        this.emit('error', err);

        if (!settled) {
          settled = true;
          cleanupFailedServer();
          return reject(err);
        }
        // After successful bind: any subsequent listener error is fatal for
        // this listener instance. The 'close' handler below will fire and
        // signal the engine to retry via the supervisor.
      });

      server.on('close', () => {
        const wasListening = this._isListening;
        this._isListening   = false;
        this.stats.listenerClosedAt = new Date();

        if (wasListening) {
          logger.info('TCP listener closed', {
            host: this._config.host,
            port: this._config.port
          });
          this.emit('disconnected', this._running ? 'unexpected close' : 'clean close');
        }

        if (!settled) {
          settled = true;
          cleanupFailedServer();
          return reject(new Error('TCP listener closed before binding'));
        }
      });

      try {
        server.listen(this._config.port, this._config.host);
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanupFailedServer();
          return reject(err);
        }
      }
    });
  }

  async _stopServer(reason) {
    return new Promise((resolve) => {
      const server = this._server;

      // Drop the active peer first so close() doesn't hang waiting for it.
      if (this._peer && !this._peer.destroyed) {
        try {
          this._peer.removeAllListeners('data');
          this._peer.removeAllListeners('error');
          this._peer.removeAllListeners('close');
          this._peer.destroy();
        } catch { /* best-effort */ }
        this._peer = null;
      }

      if (!server) {
        this._isListening = false;
        return resolve();
      }

      logger.info('Closing TCP listener', {
        host  : this._config.host,
        port  : this._config.port,
        reason
      });

      server.removeAllListeners('listening');
      server.removeAllListeners('connection');
      server.removeAllListeners('error');
      server.removeAllListeners('close');

      this._server      = null;
      this._isListening = false;

      try {
        server.close((err) => {
          if (err) {
            logger.warn('Error while closing TCP listener', {
              error: err.message,
              code : err.code
            });
          }
          resolve();
        });
      } catch (err) {
        logger.warn('Synchronous error while closing TCP listener', {
          error: err.message
        });
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — peer socket lifecycle
  // ---------------------------------------------------------------------------

  _onPeerConnection(socket) {
    const peerAddress = `${socket.remoteAddress}:${socket.remotePort}`;

    // Mindray analysers open one TCP connection at a time. If a previous
    // peer is still attached, drop it — the new connection is authoritative
    // (the previous session almost certainly died without a clean FIN).
    if (this._peer && !this._peer.destroyed) {
      logger.warn('New peer connecting while previous peer is still attached — dropping previous', {
        previous: `${this._peer.remoteAddress}:${this._peer.remotePort}`,
        current : peerAddress
      });
      try { this._peer.destroy(); } catch { /* best-effort */ }
    }

    this._peer = socket;
    this.stats.peerConnectedAt = new Date();
    this.stats.totalPeers++;

    if (this._config.keepAlive) {
      socket.setKeepAlive(true, this._config.keepAliveInitialDelayMs);
    }
    socket.setNoDelay(true);   // ASTM is interactive — disable Nagle

    const peerConnectedAtMs = Date.now();
    logger.info(`Analyser peer connected from ${peerAddress}`);
    this.emit('peerConnected', peerAddress);

    // Diagnostic: if the peer connects but sends nothing within 10s, log it.
    // Some misconfigured analyser/firewall combinations open the TCP socket
    // and then close it without sending a single byte — without this timer
    // we have no signal distinguishing that from a hung peer.
    let firstChunkLogged = false;
    const noDataTimer = setTimeout(() => {
      if (!firstChunkLogged && this._peer === socket && !socket.destroyed) {
        logger.warn(`Peer ${peerAddress} connected 10s ago but has sent ZERO bytes — analyser may be in a misconfigured state, behind a firewall stripping payloads, or expecting LIS to speak first`);
      }
    }, 10000);

    socket.on('data', (chunk) => {
      this.stats.bytesReceived += chunk.length;
      this.stats.lastByteAt = new Date();

      if (!firstChunkLogged && chunk.length > 0) {
        firstChunkLogged = true;
        const preview      = chunk.slice(0, 32);
        const previewHex   = preview.toString('hex').toUpperCase().match(/../g)?.join(' ') || '';
        const previewAscii = preview.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
        logger.info(`First peer bytes received from ${peerAddress} — ${chunk.length} bytes, hex: ${previewHex}, ascii: "${previewAscii}"`);
      }

      this.emit('data', chunk);
    });

    socket.on('error', (err) => {
      const ageMs = Date.now() - peerConnectedAtMs;
      logger.error(`Peer socket error from ${peerAddress} after ${ageMs}ms — code: ${err.code || 'NONE'}, message: ${err.message}`);
      this.emit('error', err);
    });

    socket.on('close', (hadError) => {
      clearTimeout(noDataTimer);
      this.stats.peerDisconnectedAt = new Date();
      const ageMs  = Date.now() - peerConnectedAtMs;
      const reason = hadError ? 'peer close with error' : 'peer close';
      logger.info(`Analyser peer disconnected from ${peerAddress} after ${ageMs}ms (bytesReceived=${this.stats.bytesReceived}) — ${reason}`);

      if (this._peer === socket) {
        this._peer = null;
      }

      this.emit('peerDisconnected', reason);
    });
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = TcpServerManager;
