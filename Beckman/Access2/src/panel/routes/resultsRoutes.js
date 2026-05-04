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

  // -------------------------------------------------------------------------
  // POST /api/results/barcode/:id/send-to-lims
  // Pushes every result row for the given barcode_uid to the configured
  // LIMS server REST API. The endpoint reads lims_api credentials from the
  // engine's loaded system config (config/system.config.json).
  // -------------------------------------------------------------------------
  r.post('/barcode/:id/send-to-lims', async (req, res) => {
    try {
      const pool    = getPool(engine);
      const limsApi = engine._systemConfig && engine._systemConfig.lims_api;

      if (!limsApi || !limsApi.base_url) {
        return res.status(400).json({
          success: false,
          error  : 'LIMS API is not configured. Set lims_api.base_url in config/system.config.json.'
        });
      }

      const [rows] = await pool.execute(
        `SELECT lab_uid, analyzer_uid, barcode_uid, parameter_code,
                value, flag, unit, patient_name, age, age_type, gender
         FROM lis_results
         WHERE barcode_uid = ?
         ORDER BY parameter_code ASC`,
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          error  : `No results found for sample ${req.params.id}.`
        });
      }

      const payload = {
        lab_uid     : rows[0].lab_uid,
        analyzer_uid: rows[0].analyzer_uid,
        api_key     : limsApi.api_key || '',
        data        : rows.map((row) => ({
          lab_uid       : row.lab_uid,
          analyzer_uid  : row.analyzer_uid,
          barcode_uid   : row.barcode_uid,
          parameter_code: row.parameter_code,
          value         : row.value != null ? String(row.value) : null,
          flag          : row.flag         || null,
          unit          : row.unit         || null,
          patient_name  : row.patient_name || null,
          age           : row.age          != null ? row.age : null,
          age_type      : row.age_type     || null,
          gender        : row.gender       || null,
          status        : 'final'
        }))
      };

      const url = new URL('/lis/store-analyzer-result', limsApi.base_url).toString();

      const response = await fetch(url, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(payload),
        signal : AbortSignal.timeout(15000)
      });

      const responseText = await response.text();

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          error  : `LIMS API responded with HTTP ${response.status}: ${responseText.substring(0, 300)}`
        });
      }

      res.json({
        success: true,
        data: {
          message    : `Sent ${rows.length} result${rows.length !== 1 ? 's' : ''} to LIMS.`,
          rows       : rows.length,
          barcode_uid: req.params.id,
          statusCode : response.status
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return r;
};
