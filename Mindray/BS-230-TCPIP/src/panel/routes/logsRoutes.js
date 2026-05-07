/**
 * logsRoutes.js
 * Control panel - Log viewer API routes
 *
 * Base path: /api/logs (mounted by PanelServer)
 *
 *   GET /today
 *     Returns the last N lines of today's combined log file.
 *
 *     Query parameters:
 *       limit  - max lines to return (1-2000, default 500)
 *       level  - filter by log level: ERROR | WARN | INFO | DEBUG
 *       module - filter by module tag: ENGINE | SERIAL | FRAMER | ...
 *       search - case-insensitive substring filter on the full line
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const express  = require('express');

// Hard cap so a degenerate request cannot read an arbitrarily large slice.
const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 20 MB

module.exports = function logsRoutes() {
  const r = express.Router();

  // -------------------------------------------------------------------------
  // GET /api/logs/today
  // -------------------------------------------------------------------------
  r.get('/today', (req, res) => {
    try {
      const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
      const level  = (req.query.level  || '').toUpperCase().trim();
      const module = (req.query.module || '').toUpperCase().trim();
      const search = (req.query.search || '').toLowerCase().trim();

      const today   = new Date().toISOString().slice(0, 10);
      const logPath = path.join(process.cwd(), 'logs', `combined-${today}.log`);

      if (!fs.existsSync(logPath)) {
        return res.json({
          success: true,
          data: {
            date         : today,
            file         : path.basename(logPath),
            lines        : [],
            totalMatched : 0,
            totalReturned: 0,
            message      : 'No log file for today yet. Lines will appear as the engine writes them.'
          }
        });
      }

      const stat = fs.statSync(logPath);
      let buffer;

      if (stat.size > MAX_FILE_BYTES) {
        // For very large files read only the trailing slice. This keeps the
        // viewer usable even after a full day of debug-level logging.
        const fd = fs.openSync(logPath, 'r');
        try {
          buffer = Buffer.alloc(MAX_FILE_BYTES);
          fs.readSync(fd, buffer, 0, MAX_FILE_BYTES, stat.size - MAX_FILE_BYTES);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        buffer = fs.readFileSync(logPath);
      }

      // Split into lines. The first line of a tail-sliced read may be a
      // partial record - drop it to avoid showing a corrupted prefix.
      let lines = buffer.toString('utf8').split('\n');
      if (stat.size > MAX_FILE_BYTES && lines.length > 1) lines.shift();
      lines = lines.filter((l) => l.length > 0);

      // Apply filters in order: cheapest first.
      if (level)  lines = lines.filter((l) => l.includes(`[${level}]`));
      if (module) lines = lines.filter((l) => l.includes(`[${module}]`) || l.includes(`[${module} ]`));
      if (search) lines = lines.filter((l) => l.toLowerCase().includes(search));

      const totalMatched = lines.length;
      const tail         = lines.slice(-limit);

      res.json({
        success: true,
        data: {
          date         : today,
          file         : path.basename(logPath),
          lines        : tail,
          totalMatched : totalMatched,
          totalReturned: tail.length,
          fileSize     : stat.size,
          truncated    : stat.size > MAX_FILE_BYTES
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return r;
};
