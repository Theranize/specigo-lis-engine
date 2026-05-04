/**
 * resultsRoutes.js
 * Control panel - Results data API routes
 *
 * Base path: /api/results (mounted by PanelServer)
 *
 * Table: lis_results
 *   id, lab_uid, analyzer_uid, barcode_uid, parameter_code,
 *   value, flag, unit, patient_uid, patient_name,
 *   age, age_type, gender, status, received_at, created_at
 *
 *   GET  /              -> Paginated results list with optional filters
 *   GET  /stats         -> Aggregate counts for the dashboard stat cards
 *   GET  /barcode/:id   -> All results for a specific barcode_uid (sample detail)
 */

'use strict';

const express = require('express');

// ---------------------------------------------------------------------------
// Helper - get active DB pool from engine
// ---------------------------------------------------------------------------
function getPool(engine) {
  const pool = engine._dbPool;
  if (!pool) throw new Error('Database not yet connected. Please wait a moment and retry.');
  return pool;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
module.exports = function resultsRoutes(engine) {
  const r = express.Router();

  // -------------------------------------------------------------------------
  // GET /api/results
  //
  // Query params:
  //   date      - YYYY-MM-DD  (filters by DATE(created_at))
  //   barcode   - partial match on barcode_uid
  //   parameter - exact match on parameter_code (case-insensitive)
  //   flag      - exact match on flag (N / H / HH / L / LL / A)
  //   limit     - rows per page, 1-500, default 50
  //   page      - page number, default 1
  // -------------------------------------------------------------------------
  r.get('/', async (req, res) => {
    try {
      const pool = getPool(engine);

      const { date, barcode, parameter, flag, limit = '50', page = '1' } = req.query;

      const rowLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const pageNum  = Math.max(parseInt(page,  10) || 1, 1);
      const offset   = (pageNum - 1) * rowLimit;

      const where  = [];
      const params = [];

      if (date) {
        where.push('DATE(created_at) = ?');
        params.push(date);
      }
      if (barcode && barcode.trim()) {
        where.push('barcode_uid LIKE ?');
        params.push('%' + barcode.trim() + '%');
      }
      if (parameter && parameter.trim()) {
        where.push('parameter_code = ?');
        params.push(parameter.trim().toUpperCase());
      }
      if (flag && flag !== 'ALL') {
        where.push('flag = ?');
        params.push(flag.toUpperCase());
      }

      const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

      // Total count for pagination
      const [[{ total }]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM lis_results ${whereSQL}`,
        params
      );

      // Data page
      const [rows] = await pool.execute(
        `SELECT
           id, barcode_uid, parameter_code, value, flag, unit,
           patient_name, age, age_type, gender, status, received_at, created_at
         FROM lis_results
         ${whereSQL}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, rowLimit, offset]
      );

      res.json({
        success: true,
        data: {
          results : rows,
          total   : Number(total),
          page    : pageNum,
          limit   : rowLimit,
          pages   : Math.ceil(Number(total) / rowLimit) || 1
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/results/stats
  // Returns aggregate counts used by the dashboard stat cards.
  // -------------------------------------------------------------------------
  r.get('/stats', async (req, res) => {
    try {
      const pool = getPool(engine);

      const [[{ todayResults }]] = await pool.execute(
        `SELECT COUNT(*) AS todayResults
         FROM lis_results
         WHERE DATE(created_at) = CURDATE()`
      );
      const [[{ totalResults }]] = await pool.execute(
        `SELECT COUNT(*) AS totalResults FROM lis_results`
      );
      const [[{ todayAbnormal }]] = await pool.execute(
        `SELECT COUNT(*) AS todayAbnormal
         FROM lis_results
         WHERE DATE(created_at) = CURDATE()
           AND flag IS NOT NULL
           AND flag NOT IN ('N', '')`
      );
      const [[{ todayPatients }]] = await pool.execute(
        `SELECT COUNT(DISTINCT barcode_uid) AS todayPatients
         FROM lis_results
         WHERE DATE(created_at) = CURDATE()`
      );

      res.json({
        success: true,
        data: {
          todayResults : Number(todayResults),
          totalResults : Number(totalResults),
          todayAbnormal: Number(todayAbnormal),
          todayPatients: Number(todayPatients)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/results/barcode/:id
  // Returns all parameters for a single sample (sample detail modal).
  // -------------------------------------------------------------------------
  r.get('/barcode/:id', async (req, res) => {
    try {
      const pool = getPool(engine);

      const [rows] = await pool.execute(
        `SELECT
           id, barcode_uid, parameter_code, value, flag, unit,
           patient_name, age, age_type, gender, status, received_at, created_at
         FROM lis_results
         WHERE barcode_uid = ?
         ORDER BY parameter_code ASC`,
        [req.params.id]
      );

      res.json({
        success: true,
        data: { results: rows, count: rows.length }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return r;
};
