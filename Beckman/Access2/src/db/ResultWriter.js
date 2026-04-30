/**
 * ResultWriter.js
 * SpeciGo LIS Integration Engine - Database Write Layer
 *
 * Receives MappedResult objects from ParameterMapper and writes them to the
 * SpeciGo LIMS MySQL database.
 *
 * Write sequence:
 *   1. Bulk INSERT all results into lis_results in a single statement.
 *   2. Log session boundary events (transmission start / end) to lis_integration_log.
 *
 * Both MAPPED and UNMAPPED results are written to lis_results. The mapping_status
 * column distinguishes them so the LIMS can filter appropriately.
 *
 * For UNMAPPED results (assay_code not in parameter_map):
 *   - The raw assay_code is stored in parameter_code.
 *   - loinc_id is NULL.
 *   - mapping_status = 'UNMAPPED'.
 *   - These rows are visible in the dashboard for administrator review.
 */

'use strict';

const http    = require('http');
const https   = require('https');
const { URL } = require('url');
const winston = require('winston');
require('winston-daily-rotate-file');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [WRITER] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname     : 'logs',
      filename    : 'error-%DATE%.log',
      datePattern : 'YYYY-MM-DD',
      level       : 'error',
      maxFiles    : '14d',
      zippedArchive: false
    }),
    new winston.transports.DailyRotateFile({
      dirname     : 'logs',
      filename    : 'combined-%DATE%.log',
      datePattern : 'YYYY-MM-DD',
      maxFiles    : '14d',
      zippedArchive: false
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [WRITER] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// ResultWriter class
// ---------------------------------------------------------------------------
class ResultWriter {

  /**
   * @param {object} options
   * @param {object} options.dbPool       - mysql2 promise pool.
   * @param {string} options.analyzerUid  - From lab_analyzers.analyzer_uid.
   * @param {string} options.analyzerCode - 'ACCESS2'.
   * @param {string} options.labUid       - Default lab_uid for log entries.
   * @param {object} [options.limsApi]    - LIMS server API config { base_url, api_key }.
   */
  constructor(options = {}) {
    if (!options.dbPool) {
      throw new Error('ResultWriter: options.dbPool is required');
    }

    this._pool         = options.dbPool;
    this._analyzerUid  = options.analyzerUid  || 'unknown';
    this._analyzerCode = options.analyzerCode || 'ACCESS2';
    this._labUid       = options.labUid       || '';
    this._limsApi      = options.limsApi      || null;

    logger.info('ResultWriter initialised', {
      analyzerUid : this._analyzerUid,
      analyzerCode: this._analyzerCode,
      labUid      : this._labUid,
      limsApiUrl  : this._limsApi ? this._limsApi.base_url : 'not configured'
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Bulk-write an array of MappedResult objects to lis_results.
   * Never throws - errors are caught and logged.
   *
   * @param {object[]} results - MappedResult array from ParameterMapper.
   * @returns {Promise<void>}
   */
  async write(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    const placeholders = results.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const sql = `
      INSERT INTO lis_results
        (lab_uid, analyzer_uid, barcode_uid, parameter_code, unit, value, flag,
         patient_name, age, age_type, gender)
      VALUES
        ${placeholders}
    `;

    const params = [];
    for (const r of results) {
      // Age is stored as the most precise available value.
      // If ageYear is available use that; otherwise fall back to ageMonth.
      const age     = r.age_year !== null ? r.age_year : (r.age_month !== null ? r.age_month : null);
      const ageType = r.age_type || null;

      params.push(
        r.lab_uid        ?? this._labUid,
        r.analyzer_uid   ?? this._analyzerUid,
        r.barcode_uid    ?? null,
        r.parameter_code ?? null,
        r.unit           ?? null,
        r.value          ?? null,
        r.flag           ?? null,
        r.patient_name   ?? null,
        age,
        ageType,
        r.gender         ?? null
      );
    }

    try {
      await this._pool.execute(sql, params);
      logger.info('lis_results bulk insert complete', {
        rows          : results.length,
        analyzerCode  : this._analyzerCode
      });
      // Fire-and-forget: push the same results to the LIMS server API.
      this._sendToLimsApi(results);
    } catch (err) {
      logger.error('Failed bulk insert into lis_results', {
        error       : err.message,
        analyzerCode: this._analyzerCode,
        rows        : results.length
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - LIMS server API push
  // ---------------------------------------------------------------------------

  /**
   * Sends a copy of the written results to the LIMS server REST API.
   * Fire-and-forget - errors are logged but never interrupt result processing.
   *
   * Endpoint: POST <lims_api.base_url>/lis/store-analyzer-result
   * Payload : { lab_uid, analyzer_uid, api_key, data: [...] }
   *
   * @param {object[]} results - MappedResult array (same objects passed to write()).
   */
  _sendToLimsApi(results) {
    if (!this._limsApi || !this._limsApi.base_url) return;

    const STATUS_MAP = { F: 'final', P: 'preliminary', C: 'corrected', X: 'cannot_be_done' };
    const AGE_TYPE_MAP = { YEAR: 'Y', MONTH: 'M' };

    const payload = {
      lab_uid     : this._labUid,
      analyzer_uid: this._analyzerUid,
      api_key     : this._limsApi.api_key || '',
      data        : results.map((r) => {
        const age     = r.age_year !== null && r.age_year !== undefined
          ? r.age_year
          : (r.age_month !== null && r.age_month !== undefined ? r.age_month : null);
        const ageType = AGE_TYPE_MAP[r.age_type] || null;
        return {
          lab_uid       : r.lab_uid        ?? this._labUid,
          analyzer_uid  : r.analyzer_uid   ?? this._analyzerUid,
          barcode_uid   : r.barcode_uid    ?? null,
          parameter_code: r.parameter_code ?? null,
          value         : r.value !== null && r.value !== undefined ? String(r.value) : null,
          flag          : r.flag           ?? null,
          unit          : r.unit           ?? null,
          patient_name  : r.patient_name   ?? null,
          age           : age,
          age_type      : ageType,
          gender        : r.gender         ?? null,
          status        : STATUS_MAP[r.result_status] || 'final'
        };
      })
    };

    let parsedUrl;
    try {
      parsedUrl = new URL('/lis/store-analyzer-result', this._limsApi.base_url);
    } catch (err) {
      logger.error('LIMS API: invalid base_url in config', { error: err.message });
      return;
    }

    const bodyStr   = JSON.stringify(payload);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port    : parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path    : parsedUrl.pathname,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = transport.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info('LIMS API push successful', {
            statusCode: res.statusCode,
            rows      : results.length
          });
        } else {
          logger.warn('LIMS API push returned non-2xx', {
            statusCode  : res.statusCode,
            responseBody: responseBody.substring(0, 200)
          });
        }
      });
    });

    req.on('error', (err) => {
      logger.error('LIMS API push failed', { error: err.message });
    });

    req.setTimeout(10000, () => {
      logger.error('LIMS API push timed out after 10s');
      req.destroy();
    });

    req.write(bodyStr);
    req.end();
  }

  /**
   * Writes an ASTM transmission event to lis_integration_log.
   * Called by IntegrationEngine on transmissionStart and transmissionEnd.
   *
   * @param {string} eventType - 'ENQ' (start) or 'EOT' (end).
   * @param {string} labUid
   * @returns {Promise<void>}
   */
  async logSessionEvent(eventType, labUid) {
    const sql = `
      INSERT INTO lis_integration_log
        (lab_uid, analyzer_uid, session_type, message_code, details, created_at)
      VALUES
        (?, ?, ?, ?, ?, NOW())
    `;

    const detail = eventType === 'ENQ'
      ? 'ASTM transmission session started (ENQ received)'
      : 'ASTM transmission session ended (EOT received)';

    try {
      await this._pool.execute(sql, [
        labUid || this._labUid,
        this._analyzerUid,
        eventType,
        eventType,
        detail
      ]);
      logger.info('Session event logged', { eventType, labUid });
    } catch (err) {
      // Session log failure is non-fatal - do not interrupt result processing
      logger.error('Failed to log session event', { eventType, error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ResultWriter;
