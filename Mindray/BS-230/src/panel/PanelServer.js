/**
 * PanelServer.js
 * SpeciGo LIS Integration Engine - Control Panel HTTP Server
 *
 * Serves the web-based control panel UI and exposes JSON API endpoints
 * consumed exclusively by that UI.
 *
 * Runs on PANEL_PORT (default 3004 for BS-230 - chosen so it does not
 * collide with the Access 2 default of 3003 when both engines run on
 * the same workstation).
 * Binds to 127.0.0.1 only - not exposed to the network.
 *
 * Routes:
 *   GET  /                       -> Control panel UI (public/index.html)
 *   GET  /api/engine/status      -> Full engine status object
 *   POST /api/engine/start       -> Start the engine
 *   POST /api/engine/stop        -> Stop the engine
 *   POST /api/engine/restart     -> Stop + start (re-reads config from disk)
 *   GET  /api/results            -> Paginated results with filters
 *   GET  /api/results/stats      -> Aggregate counts (today, total, abnormal, patients)
 *   GET  /api/results/barcode/:id-> All results for one barcode_uid
 */

'use strict';

const express = require('express');
const path    = require('path');

const engineRoutes  = require('./routes/engineRoutes');
const resultsRoutes = require('./routes/resultsRoutes');
const logsRoutes    = require('./routes/logsRoutes');

const logger = require('../logger').createLogger('PANEL');

// ---------------------------------------------------------------------------
// PanelServer class
// ---------------------------------------------------------------------------
class PanelServer {

  /**
   * @param {object} options
   * @param {object} options.engine - IntegrationEngine instance.
   * @param {number} [options.port] - HTTP port. Default: PANEL_PORT env or 3004.
   */
  constructor({ engine, port }) {
    if (!engine) throw new Error('PanelServer: engine is required');

    this._engine = engine;
    this._port   = port || parseInt(process.env.PANEL_PORT || '3004', 10);
    this._server = null;
    this._app    = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this._app = express();
    this._app.use(express.json());

    // CORS - panel is local-only but permit browser fetch from same host
    this._app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin',  '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Serve control panel UI (index.html + assets)
    this._app.use(express.static(path.join(__dirname, 'public')));

    // API routes
    this._app.use('/api/engine',  engineRoutes(this._engine));
    this._app.use('/api/results', resultsRoutes(this._engine));
    this._app.use('/api/logs',    logsRoutes());

    // 404
    this._app.use((req, res) => {
      res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.url}` });
    });

    // Global error handler
    this._app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
      logger.error('Panel request error', { error: err.message, url: req.url });
      res.status(500).json({ success: false, error: err.message });
    });

    await new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, '127.0.0.1', (err) => {
        if (err) return reject(err);
        resolve();
      });
      this._server.on('error', reject);
    });

    logger.info('Control panel ready', {
      url: `http://localhost:${this._port}`
    });
  }

  async stop() {
    if (!this._server) return;
    await new Promise((resolve, reject) => {
      this._server.close((err) => (err ? reject(err) : resolve()));
    });
    this._server = null;
    logger.info('Control panel stopped');
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = PanelServer;
