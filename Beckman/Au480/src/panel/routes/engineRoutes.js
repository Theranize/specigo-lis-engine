/**
 * engineRoutes.js
 * Control panel - Engine control API routes
 *
 * Base path: /api/engine (mounted by PanelServer)
 *
 *   GET  /status   -> Full engine status (running, connected, stats, ...)
 *   POST /start    -> Start the engine if stopped
 *   POST /stop     -> Stop the engine if running
 *   POST /restart  -> Stop then start (re-reads config files from disk)
 */

'use strict';

const express = require('express');

module.exports = function engineRoutes(engine) {
  const r = express.Router();

  // ---------------------------------------------------------------------------
  // GET /api/engine/status
  // Returns the complete status snapshot from IntegrationEngine.getStatus().
  // ---------------------------------------------------------------------------
  r.get('/status', (req, res) => {
    try {
      res.json({ success: true, data: engine.getStatus() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/engine/start
  // ---------------------------------------------------------------------------
  r.post('/start', async (req, res) => {
    try {
      const { running } = engine.getStatus();
      if (running) {
        return res.json({ success: true, data: { message: 'Engine is already running.' } });
      }
      await engine.start();
      res.json({ success: true, data: { message: 'Engine started successfully.' } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/engine/stop
  // ---------------------------------------------------------------------------
  r.post('/stop', async (req, res) => {
    try {
      const { running } = engine.getStatus();
      if (!running) {
        return res.json({ success: true, data: { message: 'Engine is already stopped.' } });
      }
      await engine.stop();
      res.json({ success: true, data: { message: 'Engine stopped successfully.' } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/engine/restart
  // Stops the engine (if running), then starts it fresh.
  // IntegrationEngine.start() re-reads config files from disk on every call.
  // ---------------------------------------------------------------------------
  r.post('/restart', async (req, res) => {
    try {
      if (engine.getStatus().running) {
        await engine.stop();
      }
      await engine.start();
      res.json({ success: true, data: { message: 'Engine restarted successfully.' } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return r;
};
