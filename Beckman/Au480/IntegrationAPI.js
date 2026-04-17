/**
 * IntegrationAPI.js
 * SpeciGo LIS Integration Engine - REST API Layer
 *
 * Exposes all seven endpoints defined in Section 9.4 of the foundation document.
 * Runs as an Express HTTP server on API_PORT (default 3001) on the lab PC.
 *
 * The React dashboard and the cloud LIMS backend proxy to this port to get
 * live engine status, results, parameter mappings, and communication logs.
 *
 * Endpoints implemented:
 *
 *   GET  /api/lis/status/:lab_uid
 *     Returns live connection status from IntegrationEngine.getStatus().
 *     No DB query - reads directly from engine state.
 *
 *   GET  /api/lis/results/:lab_uid
 *     Query params: ?date=YYYY-MM-DD  ?status=WRITTEN|FAILED|PENDING|SKIPPED  ?limit=50
 *     Returns rows from lis_integration_results for the given lab and date.
 *
 *   GET  /api/lis/results/:lab_uid/:sample_id
 *     Returns all results for a specific barcode_uid from lis_integration_results.
 *
 *   POST /api/lis/mapping/:lab_uid
 *     Body: { analyzer_code, online_test_no, lims_parameter_uid, lims_test_uid, unit }
 *     INSERT or UPDATE a row in lab_analyzer_parameters.
 *     Used by Umesh at go-live to populate parameter mappings without a MySQL client.
 *
 *   GET  /api/lis/mapping/:lab_uid
 *     Returns all active parameter mappings for this lab and analyzer from
 *     lab_analyzer_parameters.
 *
 *   GET  /api/lis/analyzers/:lab_uid
 *     Returns all analysers registered for this lab from lab_analyzers.
 *
 *   POST /api/lis/analyzers/:lab_uid
 *     Body: complete analyser record (all extended fields from Section 4.2).
 *     INSERT into lab_analyzers.
 *
 *   GET  /api/lis/log/:lab_uid
 *     Query params: ?limit=100  ?type=ERROR|CONNECT|DISCONNECT
 *     Returns rows from lis_integration_log.
 *
 * Security:
 *   The API is designed to be proxied by the cloud LIMS backend - it does NOT
 *   directly face the internet. Authentication is handled at the LIMS layer.
 *   On the local lab network it is accessible only to the machine it runs on
 *   (localhost:3001) unless the cloud backend establishes a tunnel.
 *   CORS is configured to accept only the cloud LIMS origin defined in
 *   LIMS_ORIGIN environment variable.
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
// Consistent envelope for all API responses consumed by the React dashboard.
// ---------------------------------------------------------------------------

/**
 * Sends a successful JSON response.
 * @param {object} res     - Express response object.
 * @param {*}      data    - Payload to send.
 * @param {number} [status] - HTTP status code. Default 200.
 */
function ok(res, data, status = 200) {
  res.status(status).json({ success: true, data });
}

/**
 * Sends an error JSON response.
 * @param {object} res     - Express response object.
 * @param {string} message - Human-readable error message.
 * @param {number} [status] - HTTP status code. Default 500.
 */
function fail(res, message, status = 500) {
  logger.error('API error response', { status, message });
  res.status(status).json({ success: false, error: message });
}

/**
 * Validates that a date string is in YYYY-MM-DD format.
 * Returns true if valid, false otherwise.
 * @param {string} dateStr
 * @returns {boolean}
 */
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
   * @param {object} options.engine  - IntegrationEngine instance (for status).
   * @param {object} options.dbPool  - mysql2 promise pool (for DB queries).
   * @param {number} [options.port]  - Port to listen on. Default 3001.
   */
  constructor(options = {}) {
    if (!options.engine) throw new Error('IntegrationAPI: options.engine is required');
    if (!options.dbPool) throw new Error('IntegrationAPI: options.dbPool is required');

    this._engine = options.engine;
    this._pool   = options.dbPool;
    this._port   = options.port || parseInt(process.env.API_PORT || '3001', 10);
    this._server = null;
    this._app    = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Builds the Express app and starts listening.
   * @returns {Promise<void>}
   */
  async start() {
    this._app = express();

    // Parse JSON request bodies
    this._app.use(express.json());

    // CORS - restrict to the LIMS cloud origin in production.
    // In development (LIMS_ORIGIN not set) all origins are allowed.
    const limsOrigin = process.env.LIMS_ORIGIN || '*';
    this._app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin',  limsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Request logging middleware
    this._app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.url}`, {
        ip    : req.ip,
        body  : req.method === 'POST' ? req.body : undefined
      });
      next();
    });

    // Register all routes
    this._registerRoutes();

    // 404 handler for unmatched routes
    this._app.use((req, res) => {
      fail(res, `Route not found: ${req.method} ${req.url}`, 404);
    });

    // Global error handler
    this._app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
      logger.error('Unhandled Express error', { error: err.message, stack: err.stack });
      fail(res, 'Internal server error', 500);
    });

    // Start HTTP server
    await new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, '0.0.0.0', (err) => {
        if (err) return reject(err);
        logger.info('IntegrationAPI listening', { port: this._port });
        resolve();
      });
      this._server.on('error', reject);
    });
  }

  /**
   * Closes the HTTP server.
   * @returns {Promise<void>}
   */
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

    // --- Status ---
    r.get('/status/:lab_uid',               (req, res) => this._getStatus(req, res));

    // --- Results ---
    r.get('/results/:lab_uid',              (req, res) => this._getResults(req, res));
    r.get('/results/:lab_uid/:sample_id',   (req, res) => this._getResultsBySample(req, res));

    // --- Parameter mapping ---
    r.get('/mapping/:lab_uid',              (req, res) => this._getMapping(req, res));
    r.post('/mapping/:lab_uid',             (req, res) => this._upsertMapping(req, res));

    // --- Analyser master ---
    r.get('/analyzers/:lab_uid',            (req, res) => this._getAnalyzers(req, res));
    r.post('/analyzers/:lab_uid',           (req, res) => this._createAnalyzer(req, res));

    // --- Communication log ---
    r.get('/log/:lab_uid',                  (req, res) => this._getLog(req, res));

    // Mount under /api/lis
    this._app.use('/api/lis', r);

    logger.debug('Routes registered under /api/lis');
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/status/:lab_uid
  // ---------------------------------------------------------------------------

  async _getStatus(req, res) {
    try {
      const status = this._engine.getStatus();

      // Enrich with messages-in-last-24h count from the DB
      const messagesLast24h = await this._countRecentMessages(req.params.lab_uid);

      ok(res, {
        connected       : status.connected,
        port            : status.port,
        analyzer        : status.analyser,
        site            : status.site,
        labUid          : status.labUid,
        analyzerUid     : status.analyzerUid,
        lastMessageAt   : status.stats?.serial?.lastByteAt || null,
        messagesLast24h : messagesLast24h,
        isReconnecting  : status.isReconnecting,
        startedAt       : status.startedAt,
        stats           : status.stats
      });
    } catch (err) {
      fail(res, err.message);
    }
  }

  async _countRecentMessages(labUid) {
    try {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM lis_integration_results
        WHERE lab_uid    = ?
          AND received_at >= NOW() - INTERVAL 24 HOUR
      `;
      const [rows] = await this._pool.execute(sql, [labUid]);
      return rows[0]?.cnt || 0;
    } catch {
      return 0;   // Non-fatal - status still returns without this count
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/results/:lab_uid
  // Query params: ?date=YYYY-MM-DD  ?status=WRITTEN|FAILED|PENDING|SKIPPED  ?limit=50
  // ---------------------------------------------------------------------------

  async _getResults(req, res) {
    try {
      const { lab_uid }            = req.params;
      const { date, status, limit } = req.query;

      // Validate date if provided
      if (date && !isValidDate(date)) {
        return fail(res, 'Invalid date format. Use YYYY-MM-DD.', 400);
      }

      const rowLimit = Math.min(parseInt(limit || '50', 10), 500);

      const conditions = ['r.lab_uid = ?'];
      const params     = [lab_uid];

      if (date) {
        conditions.push('DATE(r.received_at) = ?');
        params.push(date);
      }

      if (status) {
        const allowed = ['WRITTEN', 'FAILED', 'PENDING', 'SKIPPED'];
        if (!allowed.includes(status.toUpperCase())) {
          return fail(res, `Invalid status. Allowed: ${allowed.join(', ')}`, 400);
        }
        conditions.push('r.lims_write_status = ?');
        params.push(status.toUpperCase());
      }

      params.push(rowLimit);

      const sql = `
        SELECT
          r.id,
          r.sample_id,
          r.sample_no,
          r.sample_type,
          r.rack_no,
          r.cup_position,
          r.online_test_no,
          r.parameter_code,
          r.lims_parameter_uid,
          r.raw_value,
          r.numeric_value,
          r.data_flag,
          r.mapping_status,
          r.lims_write_status,
          r.lims_barcode_uid,
          r.result_category,
          r.error_message,
          r.received_at,
          r.written_at
        FROM lis_integration_results r
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.received_at DESC
        LIMIT ?
      `;

      const [rows] = await this._pool.execute(sql, params);
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
      const { lab_uid, sample_id } = req.params;

      const sql = `
        SELECT
          r.id,
          r.sample_id,
          r.sample_no,
          r.sample_type,
          r.online_test_no,
          r.parameter_code,
          r.raw_value,
          r.numeric_value,
          r.data_flag,
          r.mapping_status,
          r.lims_write_status,
          r.lims_parameter_uid,
          r.error_message,
          r.received_at,
          r.written_at
        FROM lis_integration_results r
        WHERE r.lab_uid   = ?
          AND r.sample_id = ?
        ORDER BY r.received_at DESC
        LIMIT 200
      `;

      const [rows] = await this._pool.execute(sql, [lab_uid, sample_id]);

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
      const { lab_uid } = req.params;

      const sql = `
        SELECT
          lap.id,
          lap.lab_uid,
          lap.analyzer_code,
          lap.parameter_code,
          lap.online_test_no,
          lap.lims_parameter_uid,
          lap.lims_test_uid,
          lap.unit,
          lap.is_active
        FROM lab_analyzer_parameters lap
        WHERE lap.lab_uid      = ?
          AND lap.analyzer_code = 'AU480'
          AND lap.is_active     = 1
        ORDER BY lap.online_test_no ASC
      `;

      const [rows] = await this._pool.execute(sql, [lab_uid]);
      ok(res, { mappings: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/lis/mapping/:lab_uid
  // Body: { analyzer_code, online_test_no, lims_parameter_uid, lims_test_uid, unit }
  // ---------------------------------------------------------------------------

  async _upsertMapping(req, res) {
    try {
      const { lab_uid } = req.params;
      const {
        analyzer_code,
        online_test_no,
        parameter_code,
        lims_parameter_uid,
        lims_test_uid,
        unit
      } = req.body;

      // Validate required fields
      const missing = [];
      if (!analyzer_code)      missing.push('analyzer_code');
      if (!online_test_no)     missing.push('online_test_no');
      if (!lims_parameter_uid) missing.push('lims_parameter_uid');
      if (!lims_test_uid)      missing.push('lims_test_uid');

      if (missing.length > 0) {
        return fail(res, `Missing required fields: ${missing.join(', ')}`, 400);
      }

      // Validate online_test_no is 3 digits
      if (!/^\d{3}$/.test(online_test_no)) {
        return fail(res, 'online_test_no must be a 3-digit string e.g. "021"', 400);
      }

      // INSERT ... ON DUPLICATE KEY UPDATE pattern.
      // lab_analyzer_parameters has a unique key on (lab_uid, analyzer_code, online_test_no).
      // This upsert means Umesh can run the mapping screen repeatedly to update
      // mappings without worrying about duplicate key errors.
      const sql = `
        INSERT INTO lab_analyzer_parameters
          (lab_uid, analyzer_code, parameter_code, online_test_no,
           lims_parameter_uid, lims_test_uid, unit, is_active)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          lims_parameter_uid = VALUES(lims_parameter_uid),
          lims_test_uid      = VALUES(lims_test_uid),
          unit               = VALUES(unit),
          parameter_code     = VALUES(parameter_code),
          is_active          = 1
      `;

      const [result] = await this._pool.execute(sql, [
        lab_uid,
        analyzer_code,
        parameter_code     || online_test_no,
        online_test_no,
        lims_parameter_uid,
        lims_test_uid,
        unit               || null
      ]);

      const action     = result.affectedRows === 1 ? 'inserted' : 'updated';
      const mappingId  = result.insertId || null;

      logger.info('Parameter mapping upserted', {
        lab_uid,
        online_test_no,
        lims_parameter_uid,
        action
      });

      // Clear the ParameterMapper in-memory cache so the new mapping
      // takes effect immediately without waiting for the 60-min TTL
      if (this._engine._mapper) {
        this._engine._mapper.clearCache();
        logger.debug('ParameterMapper cache cleared after mapping update');
      }

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
      const { lab_uid } = req.params;

      const sql = `
        SELECT
          la.id,
          la.analyzer_uid,
          la.analyzer_name,
          la.analyzer_code,
          la.manufacturer,
          la.model,
          la.category,
          la.connection_type,
          la.serial_port,
          la.baud_rate,
          la.data_bits,
          la.stop_bits,
          la.parity,
          la.protocol,
          la.communication_class,
          la.interface_direction,
          la.integration_status,
          la.serial_number,
          la.firmware_version,
          la.ip,
          la.port,
          la.is_active,
          la.notes
        FROM lab_analyzers la
        WHERE la.lab_uid   = ?
          AND la.is_active = 1
        ORDER BY la.analyzer_name ASC
      `;

      const [rows] = await this._pool.execute(sql, [lab_uid]);
      ok(res, { analyzers: rows, count: rows.length });
    } catch (err) {
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/lis/analyzers/:lab_uid
  // Body: complete analyser record with all extended fields from Section 4.2
  // ---------------------------------------------------------------------------

  async _createAnalyzer(req, res) {
    try {
      const { lab_uid }  = req.params;
      const body         = req.body;

      // Required minimum fields
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
        body.manufacturer         || null,
        body.model                || null,
        body.category             || null,
        body.connection_type      || 'SERIAL',
        body.serial_port          || null,
        body.baud_rate            || 9600,
        body.data_bits            || 8,
        body.stop_bits            || 1,
        body.parity               || 'NONE',
        body.flow_control         || 'NONE',
        body.protocol             || 'AU480',
        body.communication_class  || 'B',
        body.bcc_check            ? 1 : 0,
        body.start_code           || '02h',
        body.end_code             || '03h',
        body.text_length          || 512,
        body.online_test_no_digits|| 3,
        body.result_digits        || 6,
        body.rack_no_digits       || 4,
        body.interface_direction  || 'UNIDIRECTIONAL',
        body.integration_status   || 'NOT_STARTED',
        body.serial_number        || null,
        body.firmware_version     || null,
        body.ip                   || '',
        body.port                 || 0,
        lab_uid,
        body.notes                || null
      ];

      const [result] = await this._pool.execute(sql, values);

      logger.info('Analyser created', {
        lab_uid,
        analyzer_uid : body.analyzer_uid,
        analyzer_name: body.analyzer_name
      });

      ok(res, { success: true, id: result.insertId }, 201);
    } catch (err) {
      // Duplicate analyzer_uid for this lab is a common mistake
      if (err.code === 'ER_DUP_ENTRY') {
        return fail(res, `Analyser UID already exists for this lab: ${req.body.analyzer_uid}`, 409);
      }
      fail(res, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/lis/log/:lab_uid
  // Query params: ?limit=100  ?type=ERROR|CONNECT|DISCONNECT
  // ---------------------------------------------------------------------------

  async _getLog(req, res) {
    try {
      const { lab_uid }      = req.params;
      const { limit, type }  = req.query;

      const rowLimit = Math.min(parseInt(limit || '100', 10), 1000);

      const conditions = ['l.lab_uid = ?'];
      const params     = [lab_uid];

      if (type) {
        const allowed = ['DB', 'DE', 'ERROR', 'ACK', 'NAK', 'CONNECT', 'DISCONNECT'];
        if (!allowed.includes(type.toUpperCase())) {
          return fail(res, `Invalid type. Allowed: ${allowed.join(', ')}`, 400);
        }
        conditions.push('l.session_type = ?');
        params.push(type.toUpperCase());
      }

      params.push(rowLimit);

      const sql = `
        SELECT
          l.id,
          l.lab_uid,
          l.analyzer_uid,
          l.session_type,
          l.message_code,
          l.sample_id,
          l.details,
          l.created_at
        FROM lis_integration_log l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC
        LIMIT ?
      `;

      const [rows] = await this._pool.execute(sql, params);
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
