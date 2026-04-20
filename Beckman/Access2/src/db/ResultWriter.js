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
      return `[${timestamp}] [WRITER] [${level.toUpperCase()}] ${message}${metaStr}`;
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
   */
  constructor(options = {}) {
    if (!options.dbPool) {
      throw new Error('ResultWriter: options.dbPool is required');
    }

    this._pool         = options.dbPool;
    this._analyzerUid  = options.analyzerUid  || 'unknown';
    this._analyzerCode = options.analyzerCode || 'ACCESS2';
    this._labUid       = options.labUid       || '';

    logger.info('ResultWriter initialised', {
      analyzerUid : this._analyzerUid,
      analyzerCode: this._analyzerCode,
      labUid      : this._labUid
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
    } catch (err) {
      logger.error('Failed bulk insert into lis_results', {
        error       : err.message,
        analyzerCode: this._analyzerCode,
        rows        : results.length
      });
    }
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
