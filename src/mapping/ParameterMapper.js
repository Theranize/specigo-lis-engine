/**
 * ParameterMapper.js
 * SpeciGo LIS Integration Engine - Mapping Layer
 *
 * Receives a ParsedResult from AU480Parser and enriches it with LIMS identity
 * data by running two database lookups:
 *
 *   1. Barcode lookup  - Verifies sampleId exists in report_barcode and is active.
 *                        Returns barcode_uid, lab_uid, report_uid, patient_uid,
 *                        and all other fields needed by ResultWriter.
 *
 *   2. Parameter lookup - Resolves onlineTestNo to lims_parameter_uid and
 *                         lims_test_uid via lab_analyzer_parameters.
 *
 * Both lookups use a cache layer (simple in-memory Map) to avoid repeated DB
 * hits for the same barcode or parameter within a single analyser run.
 * Cache is intentionally short-lived (TTL-based) because LIMS data can change
 * between runs. Barcode cache TTL is 10 minutes. Parameter map cache is 60
 * minutes (parameter mappings change only when an admin updates them).
 *
 * Output:
 *   Returns a MappedResult object on success, or a MappingFailure object if
 *   either lookup fails. The engine writes both outcomes to lis_integration_results
 *   with the appropriate mapping_status ('MAPPED' or 'UNMAPPED').
 *
 * MappedResult shape:
 * {
 *   ...ParsedResult fields (all preserved),
 *   barcodeUid        : string,
 *   reportUid         : string,
 *   patientUid        : string,
 *   labUid            : string,
 *   processingLabUid  : string,
 *   limsParameterUid  : string,
 *   limsTestUid       : string,
 *   mappingStatus     : 'MAPPED',
 *   mappingError      : null
 * }
 *
 * MappingFailure shape:
 * {
 *   ...ParsedResult fields (all preserved),
 *   barcodeUid        : string|null,
 *   limsParameterUid  : null,
 *   limsTestUid       : null,
 *   mappingStatus     : 'UNMAPPED' | 'ERROR',
 *   mappingError      : string   (reason for failure)
 * }
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
      return `[${timestamp}] [MAPPER] [${level.toUpperCase()}] ${message}${metaStr}`;
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
          `[${timestamp}] [MAPPER] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Cache TTL constants
// ---------------------------------------------------------------------------
const BARCODE_CACHE_TTL_MS   = 10 * 60 * 1000;   // 10 minutes
const PARAMETER_CACHE_TTL_MS = 60 * 60 * 1000;   // 60 minutes

// ---------------------------------------------------------------------------
// Cache entry wrapper
// ---------------------------------------------------------------------------
class CacheEntry {
  constructor(value) {
    this.value     = value;
    this.createdAt = Date.now();
  }

  isAlive(ttlMs) {
    return (Date.now() - this.createdAt) < ttlMs;
  }
}

// ---------------------------------------------------------------------------
// ParameterMapper class
// ---------------------------------------------------------------------------
class ParameterMapper {

  /**
   * @param {object} options
   * @param {object} options.dbPool       - mysql2 promise pool from IntegrationEngine.
   * @param {string} options.analyzerCode - e.g. 'AU480'. Used in parameter lookup query.
   * @param {string} options.analyzerUid  - Used in log context.
   * @param {string} options.labUid       - Fallback lab_uid if barcode lookup fails.
   */
  constructor(options = {}) {
    if (!options.dbPool) {
      throw new Error('ParameterMapper: options.dbPool is required');
    }
    if (!options.analyzerCode) {
      throw new Error('ParameterMapper: options.analyzerCode is required');
    }

    this._pool         = options.dbPool;
    this._analyzerCode = options.analyzerCode;
    this._analyzerUid  = options.analyzerUid || 'unknown';
    this._labUid       = options.labUid      || '';

    // Separate caches for barcode rows and parameter mappings.
    // Keys:
    //   barcode cache   -> sampleId string
    //   parameter cache -> `${labUid}:${analyzerCode}:${onlineTestNo}`
    this._barcodeCache   = new Map();
    this._parameterCache = new Map();

    this.stats = {
      lookups          : 0,
      mapped           : 0,
      unmappedBarcode  : 0,
      unmappedParameter: 0,
      errors           : 0,
      barcodeCacheHits : 0,
      paramCacheHits   : 0
    };

    logger.info('ParameterMapper initialised', {
      analyzerCode: this._analyzerCode,
      analyzerUid : this._analyzerUid,
      labUid      : this._labUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Maps a single ParsedResult to a MappedResult or MappingFailure.
   * Never throws - all errors are caught and returned as MappingFailure objects.
   *
   * @param {object} parsedResult - ParsedResult from AU480Parser.
   * @returns {Promise<object>}   MappedResult or MappingFailure.
   */
  async map(parsedResult) {
    this.stats.lookups++;

    const { sampleId, onlineTestNo } = parsedResult;

    logger.debug('Mapping result', { sampleId, onlineTestNo });

    // --- Step 1: Barcode lookup ---
    let barcodeRow;
    try {
      barcodeRow = await this._lookupBarcode(sampleId);
    } catch (err) {
      this.stats.errors++;
      logger.error('Barcode lookup threw unexpected error', {
        sampleId,
        error: err.message
      });
      return this._buildFailure(parsedResult, null, 'ERROR',
        `Barcode lookup error: ${err.message}`);
    }

    if (!barcodeRow) {
      this.stats.unmappedBarcode++;
      logger.warn('Sample ID not found in report_barcode', { sampleId });
      return this._buildFailure(parsedResult, null, 'UNMAPPED',
        `Sample ID ${sampleId} not found in report_barcode or barcode_is_active = 0`);
    }

    const { lab_uid: labUid } = barcodeRow;

    // --- Step 2: Parameter mapping lookup ---
    let paramRow;
    try {
      paramRow = await this._lookupParameter(labUid, onlineTestNo);
    } catch (err) {
      this.stats.errors++;
      logger.error('Parameter lookup threw unexpected error', {
        sampleId,
        onlineTestNo,
        error: err.message
      });
      return this._buildFailure(parsedResult, barcodeRow, 'ERROR',
        `Parameter lookup error: ${err.message}`);
    }

    if (!paramRow) {
      this.stats.unmappedParameter++;
      logger.warn('Online test number not mapped in lab_analyzer_parameters', {
        sampleId,
        onlineTestNo,
        analyzerCode: this._analyzerCode,
        labUid
      });
      return this._buildFailure(parsedResult, barcodeRow, 'UNMAPPED',
        `Online test no ${onlineTestNo} not mapped for analyzer ${this._analyzerCode} in lab ${labUid}`);
    }

    // --- Both lookups succeeded: build MappedResult ---
    this.stats.mapped++;

    const mapped = {
      // All ParsedResult fields preserved unchanged
      ...parsedResult,

      // Barcode / identity fields from report_barcode
      barcodeUid       : barcodeRow.barcode_uid,
      reportUid        : barcodeRow.report_uid,
      patientUid       : barcodeRow.patient_uid,
      labUid           : barcodeRow.lab_uid,
      processingLabUid : barcodeRow.processing_lab_uid,
      processingLabType: barcodeRow.processing_lab_type,
      parentBarcodeUid : barcodeRow.parent_barcode_uid,
      testType         : barcodeRow.test_type,
      packageUid       : barcodeRow.package_uid,
      testUid          : barcodeRow.test_uid,
      sampleTypeUid    : barcodeRow.sample_type_uid,
      subDeptUid       : barcodeRow.sub_dept_uid,

      // Parameter identity fields from lab_analyzer_parameters
      limsParameterUid : paramRow.lims_parameter_uid,
      limsTestUid      : paramRow.lims_test_uid,
      parameterCode    : paramRow.parameter_code,
      unit             : paramRow.unit,

      // Mapping outcome
      mappingStatus    : 'MAPPED',
      mappingError     : null
    };

    logger.info('Result mapped successfully', {
      sampleId,
      onlineTestNo,
      limsParameterUid: paramRow.lims_parameter_uid,
      labUid
    });

    return mapped;
  }

  /**
   * Clears both in-memory caches.
   * Call at the start of each DB / DE session so stale barcode entries do not
   * persist across overnight analyser power cycles.
   */
  clearCache() {
    const barcodeCount   = this._barcodeCache.size;
    const parameterCount = this._parameterCache.size;
    this._barcodeCache.clear();
    this._parameterCache.clear();
    logger.info('ParameterMapper cache cleared', { barcodeCount, parameterCount });
  }

  /**
   * Returns a statistics snapshot for the dashboard status endpoint.
   */
  getStats() {
    return {
      ...this.stats,
      barcodeCacheSize  : this._barcodeCache.size,
      parameterCacheSize: this._parameterCache.size
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - barcode lookup
  // ---------------------------------------------------------------------------

  /**
   * Looks up a barcode in report_barcode.
   * Uses in-memory cache keyed by sampleId to avoid per-result DB hits.
   *
   * The barcode_uid IS the Sample ID at MMI (SpeciGo prints barcode_uid on the
   * tube label directly). The AU480 scans and transmits it unchanged.
   * Query confirmed in Section 9.1 of the foundation document.
   *
   * @param {string} sampleId - The barcode_uid from the analyser message.
   * @returns {Promise<object|null>} Row from report_barcode, or null if not found.
   */
  async _lookupBarcode(sampleId) {
    // Check cache first
    const cached = this._barcodeCache.get(sampleId);
    if (cached && cached.isAlive(BARCODE_CACHE_TTL_MS)) {
      this.stats.barcodeCacheHits++;
      logger.debug('Barcode cache hit', { sampleId });
      // null is a valid cached value (barcode confirmed not to exist)
      return cached.value;
    }

    logger.debug('Barcode cache miss - querying database', { sampleId });

    const sql = `
      SELECT
        rb.barcode_uid,
        rb.lab_uid,
        rb.report_uid,
        rb.patient_uid,
        rb.processing_lab_uid,
        rb.processing_lab_type,
        rb.parent_barcode_uid,
        rb.test_type,
        rb.package_uid,
        rb.test_uid,
        rb.sample_type_uid,
        rb.sub_dept_uid
      FROM report_barcode rb
      WHERE rb.barcode_uid = ?
        AND rb.barcode_is_active = 1
      LIMIT 1
    `;

    const [rows] = await this._pool.execute(sql, [sampleId]);
    const row    = rows.length > 0 ? rows[0] : null;

    // Cache the result (including null so we do not re-query missing barcodes
    // repeatedly within the same run - reduces DB load on unmapped samples)
    this._barcodeCache.set(sampleId, new CacheEntry(row));

    if (row) {
      logger.debug('Barcode found in database', {
        sampleId,
        labUid   : row.lab_uid,
        reportUid: row.report_uid
      });
    } else {
      logger.warn('Barcode not found in database', { sampleId });
    }

    return row;
  }

  // ---------------------------------------------------------------------------
  // Internal - parameter lookup
  // ---------------------------------------------------------------------------

  /**
   * Resolves an online test number to a LIMS parameter UID.
   * Uses lab_analyzer_parameters keyed on (lab_uid, analyzer_code, online_test_no).
   *
   * Cache key includes lab_uid because different labs may map the same online
   * test number to different LIMS parameters.
   *
   * Query confirmed in Section 9.1 of the foundation document.
   *
   * @param {string} labUid       - From the barcode row.
   * @param {string} onlineTestNo - 3-digit string e.g. '021'.
   * @returns {Promise<object|null>} Row from lab_analyzer_parameters or null.
   */
  async _lookupParameter(labUid, onlineTestNo) {
    const cacheKey = `${labUid}:${this._analyzerCode}:${onlineTestNo}`;

    // Check cache
    const cached = this._parameterCache.get(cacheKey);
    if (cached && cached.isAlive(PARAMETER_CACHE_TTL_MS)) {
      this.stats.paramCacheHits++;
      logger.debug('Parameter cache hit', { cacheKey });
      return cached.value;
    }

    logger.debug('Parameter cache miss - querying database', { cacheKey });

    const sql = `
      SELECT
        lap.lims_parameter_uid,
        lap.lims_test_uid,
        lap.parameter_code,
        lap.unit
      FROM lab_analyzer_parameters lap
      WHERE lap.lab_uid       = ?
        AND lap.analyzer_code = ?
        AND lap.online_test_no = ?
        AND lap.is_active      = 1
      LIMIT 1
    `;

    const [rows] = await this._pool.execute(sql, [labUid, this._analyzerCode, onlineTestNo]);
    const row    = rows.length > 0 ? rows[0] : null;

    this._parameterCache.set(cacheKey, new CacheEntry(row));

    if (row) {
      logger.debug('Parameter mapping found', {
        onlineTestNo,
        limsParameterUid: row.lims_parameter_uid
      });
    } else {
      logger.warn('Parameter mapping not found in lab_analyzer_parameters', {
        labUid,
        analyzerCode: this._analyzerCode,
        onlineTestNo
      });
    }

    return row;
  }

  // ---------------------------------------------------------------------------
  // Internal - failure builder
  // ---------------------------------------------------------------------------

  /**
   * Builds a MappingFailure object preserving all ParsedResult fields.
   * barcodeRow may be null if the barcode lookup itself failed.
   *
   * @param {object}      parsedResult
   * @param {object|null} barcodeRow
   * @param {string}      status        - 'UNMAPPED' or 'ERROR'
   * @param {string}      reason        - Human-readable failure reason.
   * @returns {object} MappingFailure
   */
  _buildFailure(parsedResult, barcodeRow, status, reason) {
    return {
      ...parsedResult,

      // Populate what we have from barcode row if it was retrieved
      barcodeUid       : barcodeRow?.barcode_uid        || null,
      reportUid        : barcodeRow?.report_uid         || null,
      patientUid       : barcodeRow?.patient_uid        || null,
      labUid           : barcodeRow?.lab_uid            || this._labUid,
      processingLabUid : barcodeRow?.processing_lab_uid || null,
      processingLabType: barcodeRow?.processing_lab_type || null,
      parentBarcodeUid : barcodeRow?.parent_barcode_uid || null,
      testType         : barcodeRow?.test_type          || null,
      packageUid       : barcodeRow?.package_uid        || null,
      testUid          : barcodeRow?.test_uid           || null,
      sampleTypeUid    : barcodeRow?.sample_type_uid    || null,
      subDeptUid       : barcodeRow?.sub_dept_uid       || null,

      // Parameter fields unknown
      limsParameterUid : null,
      limsTestUid      : null,
      parameterCode    : parsedResult.onlineTestNo,   // store test no as fallback code
      unit             : null,

      mappingStatus    : status,
      mappingError     : reason
    };
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ParameterMapper;
