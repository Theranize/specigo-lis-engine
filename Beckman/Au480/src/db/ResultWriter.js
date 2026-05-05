/**
 * ResultWriter.js
 * SpeciGo LIS Integration Engine - Database Write Layer
 *
 * Receives MappedResult objects from ParameterMapper and writes them to
 * the SpeciGo LIMS MySQL database. Mirrors the Access 2 writer so both
 * analysers share the same downstream LIMS contract.
 *
 * Write sequence:
 *   1. Bulk INSERT all results into lis_results in a single statement.
 *   2. Fire-and-forget POST to the LIMS server REST API (if configured).
 *   3. Log session boundary events (DB / DE) to lis_integration_log.
 *
 * Both MAPPED and UNMAPPED results are written. The mapping_status column
 * (when present) lets the LIMS filter unknown online_test_no rows for
 * administrator review.
 */

'use strict';

const http    = require('http');
const https   = require('https');
const { URL } = require('url');

const logger = require('../logger').createLogger('WRITER');

// ---------------------------------------------------------------------------
// ResultWriter class
// ---------------------------------------------------------------------------
class ResultWriter {

  /**
   * @param {object} options
   * @param {object} options.dbPool       - mysql2 promise pool.
   * @param {string} options.analyzerUid  - From lab_analyzers.analyzer_uid.
   * @param {string} options.analyzerCode - 'AU480'.
   * @param {string} options.labUid       - Default lab_uid for log entries.
   * @param {object} [options.limsApi]    - LIMS server API config { base_url, api_key }.
   */
  constructor(options = {}) {
    if (!options.dbPool) {
      throw new Error('ResultWriter: options.dbPool is required');
    }

    this._pool         = options.dbPool;
    this._analyzerUid  = options.analyzerUid  || 'unknown';
    this._analyzerCode = options.analyzerCode || 'AU480';
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
  // Internal - value sanitization
  // ---------------------------------------------------------------------------

  /**
   * Converts empty / whitespace / undefined values to NULL.
   * Keeps 0 and false intact.
   */
  _nullIfEmpty(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    return v;
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

    const placeholders = results.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const sql = `
      INSERT INTO lis_results
        (lab_uid, analyzer_uid, barcode_uid, parameter_code, unit, value, flag,
         patient_name, age, age_type, gender, status, received_at)
      VALUES
        ${placeholders}
    `;

    const params = [];
    for (const r of results) {
      // age: prefer ageYear, fall back to ageMonth (both are integers).
      const age = r.age_year !== null && r.age_year !== undefined
        ? r.age_year
        : (r.age_month !== null && r.age_month !== undefined ? r.age_month : null);

      // age_type: DB column is char(1) — 'Y' for years, 'M' for months.
      const ageTypeMap = { YEAR: 'Y', MONTH: 'M', Y: 'Y', M: 'M' };
      const ageType    = r.age_type ? (ageTypeMap[r.age_type] || null) : null;

      // gender: DB column is char(1) — 'M' or 'F'.
      const genderMap = { MALE: 'M', FEMALE: 'F', M: 'M', F: 'F' };
      const gender    = r.gender ? (genderMap[r.gender] || null) : null;

      // received_at: AU480 frames carry no instrument datetime, so we
      // record the receive time at the engine. Use whatever the parser
      // surfaces in result_datetime if a future deployment provides one.
      const received = this._parseAstmDatetime(r.result_datetime) || new Date();

      params.push(
        this._nullIfEmpty(r.lab_uid)        ?? this._labUid,
        this._nullIfEmpty(r.analyzer_uid)   ?? this._analyzerUid,
        this._nullIfEmpty(r.barcode_uid),
        this._nullIfEmpty(r.parameter_code),
        this._nullIfEmpty(r.unit),
        this._nullIfEmpty(r.value),
        this._nullIfEmpty(r.flag),
        this._nullIfEmpty(r.patient_name),
        age,
        ageType,
        gender,
        0,
        received
      );
    }

    try {
      await this._pool.execute(sql, params);
      logger.info('lis_results bulk insert complete', {
        rows        : results.length,
        analyzerCode: this._analyzerCode
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

    const STATUS_MAP   = { F: 'final', P: 'preliminary', C: 'corrected', X: 'cannot_be_done' };
    const AGE_TYPE_MAP = { YEAR: 'Y', MONTH: 'M' };

    const payload = {
      lab_uid     : this._labUid,
      analyzer_uid: this._analyzerUid,
      api_key     : this._limsApi.api_key || '',
      data: results.map((r) => {
        const age = r.age_year !== null && r.age_year !== undefined
          ? r.age_year
          : (r.age_month !== null && r.age_month !== undefined ? r.age_month : null);

        const ageType = AGE_TYPE_MAP[r.age_type] || null;

        return {
          lab_uid       : this._nullIfEmpty(r.lab_uid)        ?? this._labUid,
          analyzer_uid  : this._nullIfEmpty(r.analyzer_uid)   ?? this._analyzerUid,
          barcode_uid   : this._nullIfEmpty(r.barcode_uid),
          parameter_code: this._nullIfEmpty(r.parameter_code),
          value         : this._nullIfEmpty(
                            r.value !== null && r.value !== undefined
                              ? String(r.value)
                              : null
                          ),
          flag          : this._nullIfEmpty(r.flag),
          unit          : this._nullIfEmpty(r.unit),
          patient_name  : this._nullIfEmpty(r.patient_name),
          age           : age,
          age_type      : ageType,
          gender        : this._nullIfEmpty(r.gender),
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

  // ---------------------------------------------------------------------------
  // Internal - helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts an ASTM-style datetime string (YYYYMMDDHHMMSS) to a MySQL
   * datetime string (YYYY-MM-DD HH:MM:SS). Returns null for absent/invalid
   * input. The AU480 protocol does not include a result datetime field, so
   * this is normally a no-op - kept for parity with the Access 2 writer
   * and for any future deployment that surfaces one.
   *
   * @param {string} dt
   * @returns {string|null}
   */
  _parseAstmDatetime(dt) {
    if (!dt || typeof dt !== 'string' || dt.length < 8) return null;
    const s = dt.replace(/\D/g, '').padEnd(14, '0');
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`;
  }

  /**
   * Writes an AU480 transmission event to lis_integration_log.
   * Called by IntegrationEngine on parser sessionStart (DB code) and
   * sessionEnd (DE code).
   *
   * @param {string} eventType - 'DB' (start) or 'DE' (end).
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

    const detail = eventType === 'DB'
      ? 'AU480 analysis data transmission session started (DB received)'
      : 'AU480 analysis data transmission session ended (DE received)';

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
