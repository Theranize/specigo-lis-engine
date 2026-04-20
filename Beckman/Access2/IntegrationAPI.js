/**
 * IntegrationAPI.js
 * SpeciGo LIS Integration Engine - REST API Layer (Access 2)
 *
 * Exposes HTTP endpoints for the React dashboard and the cloud LIMS backend proxy.
 * Runs as an Express HTTP server on API_PORT (default 3002).
 *
 * Endpoints:
 *
 *   GET  /api/lis/status/:lab_uid
 *     Returns live engine status from IntegrationEngine.getStatus().
 *
 *   GET  /api/lis/results/:lab_uid
 *     Query params: ?date=YYYY-MM-DD  ?status=WRITTEN|FAILED|PENDING|SKIPPED  ?limit=50
 *
 *   GET  /api/lis/results/:lab_uid/:sample_id
 *     Returns all results for a specific barcode_uid.
 *
 *   GET  /api/lis/mapping/:lab_uid
 *     Returns all active parameter mappings for this lab (analyzer_code = ACCESS2).
 *
 *   POST /api/lis/mapping/:lab_uid
 *     Body: { assay_code, parameter_code, lims_parameter_uid, lims_test_uid, unit }
 *     Upserts a parameter mapping entry.
 *
 *   GET  /api/lis/analyzers/:lab_uid
 *     Returns all analysers registered for this lab.
 *
 *   POST /api/lis/analyzers/:lab_uid
 *     Registers a new analyser record in lab_analyzers.
 *
 *   GET  /api/lis/log/:lab_uid
 *     Query params: ?limit=100  ?type=ENQ|EOT|ERROR|CONNECT|DISCONNECT
 *
 * Security:
 *   Designed to be proxied by the cloud LIMS backend - does not face the internet
 *   directly. CORS is restricted to LIMS_ORIGIN environment variable in production.
 */

'use strict';

const express = require('express');
const winston = require('winston');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [API]    [${level.toUpperCase()}] ${message}${metaStr}`;
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
          `[${timestamp}] [API]    ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(res, data, status = 200) {
  res.status(status).json({ success: true, data });
}

function fail(res, message, status = 500) {
  logger.error('API error response', { status, message });
  res.status(status).json({ success: false, error: message });
}

function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

// ---------------------------------------------------------------------------
// IntegrationAPI class
// ---------------------------------------------------------------------------
class IntegrationAPI {

  /**
   * @param {object} options
   * @param {object} options.engine  - IntegrationEngine instance.
   * @param {object} options.dbPool  - mysql2 promise pool (may be null on startup).
   * @param {number} [options.port]  - Port to listen on. Default 3002.
   */
  constructor(options = {}) {
    if (!options.engine) throw new Error('IntegrationAPI: options.engine is required');

    this._engine = options.engine;
    this._pool   = options.dbPool || null;
    this._port   = options.port   || parseInt(process.env.API_PORT || '3002', 10);
    this._server = null;
    this._app    = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this._app = express();
    this._app.use(express.json());

    const limsOrigin = process.env.LIMS_ORIGIN || '*';
    this._app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin',  limsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    this._app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.url}`, {
        ip  : req.ip,
        body: req.method === 'POST' ? req.body : undefined
      });
      next();
    });

    this._registerRoutes();

    this._app.use((req, res) => {
      fail(res, `Route not found: ${req.method} ${req.url}`, 404);
    });

    this._app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
      logger.error('Unhandled Express error', { error: err.message, stack: err.stack });
      fail(res, 'Internal server error', 500);
    });

    await new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, '0.0.0.0', (err) => {
        if (err) return reject(err);
        logger.info('IntegrationAPI listening', { port: this._port });
        resolve();
      });
      this._server.on('error', reject);
    });
  }

  async stop() {
    if (!this._server) return;
    await new Promise((resolve, reject) => {
      this._server.close((err) => {
        if (err) return reject(err);
        logger.info('IntegrationAPI stopped');
        resolve();
      });
    });
    this._server = null;
  }

  // ---------------------------------------------------------------------------
  // Route registration
  // ---------------------------------------------------------------------------

  _registerRoutes() {
    const r = express.Router();

    r.get('/status/:lab_uid',               (req, res) => this._getStatus(req, res));
    r.get('/results/:lab_uid',              (req, res) => this._getResults(req, res));
    r.get('/results/:lab_uid/:sample_id',   (req, res) => this._getResultsBySample(req, res));
    r.get('/mapping/:lab_uid',              (req, res) => this._getMapping(req, res));
    r.post('/mapping/:lab_uid',             (req, res) => this._upsertMapping(req, res));
    r.get('/analyzers/:lab_uid',            (req, res) => this._getAnalyzers(req, res));
    r.post('/analyzers/:lab_uid',           (req, res) => this._createAnalyzer(req, res));
    r.get('/log/:lab_uid',                  (req, res) => this._getLog(req, res));

    this._app.use('/api/lis', r);
    logger.debug('Routes registered under /api/lis');
  }

  // ---------------------------------------------------------------------------
  // Helper - get active DB pool
  // The DB pool is created asynchronously after engine start.
  // Some requests may arrive before the pool is ready.
  // ---------------------------------------------------------------------------

  _getPool() {
    // The engine exposes its pool reference - use it if available
    const pool = this._engine._dbPool || this._pool;
    if (!pool) {
      throw new Error('Database not connected yet. Retry in a few seconds.');
    }
    return pool;
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/status/:lab_uid
  // ---------------------------------------------------------------------------

  async _getStatus(req, res) {
    try {
      const status = this._engine.getStatus();

      let messagesLast24h = 0;
      try {
        const pool = this._getPool();
        const sql  = `
          SELECT COUNT(*) AS cnt
          FROM lis_results
          WHERE lab_uid    = ?
            AND created_at >= NOW() - INTERVAL 24 HOUR
        `;
        const [rows] = await pool.execute(sql, [req.params.lab_uid]);
        messagesLast24h = rows[0]?.cnt || 0;
      } catch {
        // Non-fatal - status still returns without this count
      }

      ok(res, {
        connected       : status.connected,
        port            : status.port,
        analyser        : status.analyser,
        site            : status.site,
        labUid          : status.labUid,
        analyzerUid     : status.analyzerUid,
        lastMessageAt   : status.stats?.serial?.lastByteAt || null,
        messagesLast24h : messagesLast24h,
        isReconnecting  : status.isReconnecting,
        startedAt       : status.startedAt,
        dbReady         : status.dbReady,
        stats           : status.stats
      });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/results/:lab_uid
  // ---------------------------------------------------------------------------

  async _getResults(req, res) {
    try {
      const pool                    = this._getPool();
      const { lab_uid }             = req.params;
      const { date, status, limit } = req.query;

      if (date && !isValidDate(date)) {
        return fail(res, 'Invalid date format. Use YYYY-MM-DD.', 400);
      }

      const rowLimit   = Math.min(parseInt(limit || '50', 10), 500);
      const conditions = ['lab_uid = ?'];
      const params     = [lab_uid];

      if (date) {
        conditions.push('DATE(created_at) = ?');
        params.push(date);
      }

      if (status) {
        const allowed = ['MAPPED', 'UNMAPPED', 'ERROR'];
        if (!allowed.includes(status.toUpperCase())) {
          return fail(res, `Invalid status. Allowed: ${allowed.join(', ')}`, 400);
        }
        conditions.push('mapping_status = ?');
        params.push(status.toUpperCase());
      }

      params.push(rowLimit);

      const sql = `
        SELECT
          id, barcode_uid, parameter_code, unit, value, flag,
          patient_name, age, age_type, gender, mapping_status, created_at
        FROM lis_results
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
      `;

      const [rows] = await pool.execute(sql, params);
      ok(res, { results: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/results/:lab_uid/:sample_id
  // ---------------------------------------------------------------------------

  async _getResultsBySample(req, res) {
    try {
      const pool                   = this._getPool();
      const { lab_uid, sample_id } = req.params;

      const sql = `
        SELECT
          id, barcode_uid, parameter_code, unit, value, flag,
          patient_name, age, age_type, gender, mapping_status, created_at
        FROM lis_results
        WHERE lab_uid     = ?
          AND barcode_uid = ?
        ORDER BY created_at DESC
        LIMIT 200
      `;

      const [rows] = await pool.execute(sql, [lab_uid, sample_id]);

      if (rows.length === 0) {
        return fail(res, `No results found for sample_id: ${sample_id}`, 404);
      }

      ok(res, { sample_id, results: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/mapping/:lab_uid
  // ---------------------------------------------------------------------------

  async _getMapping(req, res) {
    try {
      const pool      = this._getPool();
      const { lab_uid } = req.params;

      const sql = `
        SELECT
          id, lab_uid, analyzer_code, parameter_code,
          online_test_no, lims_parameter_uid, lims_test_uid, unit, is_active
        FROM lab_analyzer_parameters
        WHERE lab_uid       = ?
          AND analyzer_code = 'ACCESS2'
          AND is_active     = 1
        ORDER BY parameter_code ASC
      `;

      const [rows] = await pool.execute(sql, [lab_uid]);
      ok(res, { mappings: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/lis/mapping/:lab_uid
  // Body: { assay_code, parameter_code, lims_parameter_uid, lims_test_uid, unit }
  // ---------------------------------------------------------------------------

  async _upsertMapping(req, res) {
    try {
      const pool      = this._getPool();
      const { lab_uid } = req.params;
      const {
        assay_code,
        parameter_code,
        lims_parameter_uid,
        lims_test_uid,
        unit
      } = req.body;

      const missing = [];
      if (!assay_code)         missing.push('assay_code');
      if (!lims_parameter_uid) missing.push('lims_parameter_uid');
      if (!lims_test_uid)      missing.push('lims_test_uid');

      if (missing.length > 0) {
        return fail(res, `Missing required fields: ${missing.join(', ')}`, 400);
      }

      // Validate assay_code is alphanumeric with hyphens (e.g. 'TSH', 'ANTI-HCV')
      if (!/^[A-Za-z0-9\-]{1,20}$/.test(assay_code)) {
        return fail(res, 'assay_code must be 1-20 alphanumeric characters (hyphens allowed)', 400);
      }

      const sql = `
        INSERT INTO lab_analyzer_parameters
          (lab_uid, analyzer_code, parameter_code, online_test_no,
           lims_parameter_uid, lims_test_uid, unit, is_active)
        VALUES
          (?, 'ACCESS2', ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          lims_parameter_uid = VALUES(lims_parameter_uid),
          lims_test_uid      = VALUES(lims_test_uid),
          unit               = VALUES(unit),
          parameter_code     = VALUES(parameter_code),
          is_active          = 1
      `;

      const [result] = await pool.execute(sql, [
        lab_uid,
        parameter_code     || assay_code,
        assay_code,          // stored in online_test_no for unified table structure
        lims_parameter_uid,
        lims_test_uid,
        unit               || null
      ]);

      const action    = result.affectedRows === 1 ? 'inserted' : 'updated';
      const mappingId = result.insertId || null;

      logger.info('Parameter mapping upserted', {
        lab_uid,
        assay_code,
        lims_parameter_uid,
        action
      });

      ok(res, { success: true, action, mapping_id: mappingId }, 201);
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/analyzers/:lab_uid
  // ---------------------------------------------------------------------------

  async _getAnalyzers(req, res) {
    try {
      const pool        = this._getPool();
      const { lab_uid } = req.params;

      const sql = `
        SELECT
          id, analyzer_uid, analyzer_name, analyzer_code, manufacturer, model,
          category, connection_type, serial_port, baud_rate, data_bits, stop_bits,
          parity, protocol, interface_direction, integration_status,
          serial_number, firmware_version, ip, port, is_active, notes
        FROM lab_analyzers
        WHERE lab_uid   = ?
          AND is_active = 1
        ORDER BY analyzer_name ASC
      `;

      const [rows] = await pool.execute(sql, [lab_uid]);
      ok(res, { analyzers: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/lis/analyzers/:lab_uid
  // ---------------------------------------------------------------------------

  async _createAnalyzer(req, res) {
    try {
      const pool        = this._getPool();
      const { lab_uid } = req.params;
      const body        = req.body;

      const required = ['analyzer_uid', 'analyzer_name', 'analyzer_code'];
      const missing  = required.filter((f) => !body[f]);
      if (missing.length > 0) {
        return fail(res, `Missing required fields: ${missing.join(', ')}`, 400);
      }

      const sql = `
        INSERT INTO lab_analyzers
          (analyzer_uid, analyzer_name, analyzer_code, manufacturer, model, category,
           connection_type, serial_port, baud_rate, data_bits, stop_bits, parity,
           flow_control, protocol, communication_class, bcc_check, start_code, end_code,
           text_length, online_test_no_digits, result_digits, rack_no_digits,
           interface_direction, integration_status, serial_number, firmware_version,
           ip, port, lab_uid, is_active, notes)
        VALUES
          (?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, 1, ?)
      `;

      const values = [
        body.analyzer_uid,
        body.analyzer_name,
        body.analyzer_code,
        body.manufacturer         || 'Beckman Coulter',
        body.model                || 'Access 2',
        body.category             || 'Immunoassay Analyser',
        body.connection_type      || 'SERIAL',
        body.serial_port          || 'COM2',
        body.baud_rate            || 9600,
        body.data_bits            || 8,
        body.stop_bits            || 1,
        body.parity               || 'NONE',
        body.flow_control         || 'NONE',
        body.protocol             || 'ASTM_E1394',
        body.communication_class  || 'ASTM',
        0,                          // bcc_check - not applicable for ASTM framing
        body.start_code           || '05h',   // ENQ
        body.end_code             || '04h',   // EOT
        body.text_length          || 240,
        0,                          // online_test_no_digits - N/A for ASTM
        0,                          // result_digits - N/A for ASTM
        0,                          // rack_no_digits - N/A for ASTM
        body.interface_direction  || 'UNIDIRECTIONAL',
        body.integration_status   || 'NOT_STARTED',
        body.serial_number        || null,
        body.firmware_version     || null,
        body.ip                   || '',
        body.port                 || 0,
        lab_uid,
        body.notes                || null
      ];

      const [result] = await pool.execute(sql, values);

      logger.info('Analyser created', {
        lab_uid,
        analyzer_uid : body.analyzer_uid,
        analyzer_name: body.analyzer_name
      });

      ok(res, { success: true, id: result.insertId }, 201);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return fail(res, `Analyser UID already exists for this lab: ${req.body.analyzer_uid}`, 409);
      }
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/log/:lab_uid
  // Query params: ?limit=100  ?type=ENQ|EOT|ERROR|CONNECT|DISCONNECT
  // ---------------------------------------------------------------------------

  async _getLog(req, res) {
    try {
      const pool             = this._getPool();
      const { lab_uid }      = req.params;
      const { limit, type }  = req.query;

      const rowLimit   = Math.min(parseInt(limit || '100', 10), 1000);
      const conditions = ['l.lab_uid = ?'];
      const params     = [lab_uid];

      if (type) {
        const allowed = ['ENQ', 'EOT', 'ERROR', 'CONNECT', 'DISCONNECT'];
        if (!allowed.includes(type.toUpperCase())) {
          return fail(res, `Invalid type. Allowed: ${allowed.join(', ')}`, 400);
        }
        conditions.push('l.session_type = ?');
        params.push(type.toUpperCase());
      }

      params.push(rowLimit);

      const sql = `
        SELECT
          l.id, l.lab_uid, l.analyzer_uid, l.session_type,
          l.message_code, l.sample_id, l.details, l.created_at
        FROM lis_integration_log l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC
        LIMIT ?
      `;

      const [rows] = await pool.execute(sql, params);
      ok(res, { log: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = IntegrationAPI;
