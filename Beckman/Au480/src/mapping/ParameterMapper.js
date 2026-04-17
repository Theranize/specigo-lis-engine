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

    this._pool          = options.dbPool;
    this._analyzerCode  = options.analyzerCode;
    this._analyzerUid   = options.analyzerUid || 'unknown';
    this._labUid        = options.labUid      || '';
    this._parameter_map = options.parameter_map      || {};

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
  async map(parsedResults) {
    const mapped = [];
    for (const result of parsedResults) {
      const {
        sampleId,
        onlineTestNo,
        flagMeaning,
        sex,
        ageYear,
        ageMonth,
        numericValue,
      } = result;    

      const parameterFromConfig = this._parameter_map[onlineTestNo];

      const mappedResult = {
        lab_uid          : this._labUid,
        barcode_uid      : sampleId,
        parameter_code   : parameterFromConfig?.code || null,
        loinc_id         : parameterFromConfig?.loinc_id || null,
        unit             : parameterFromConfig?.unit || null,
        value            : numericValue,
        flag             : flagMeaning,
        analyzer_uid     : this._analyzerUid,
        patient_uid      : parameterFromConfig?.patient_uid || null,  // To be filled by ResultWriter if barcode lookup succeeds
        patient_name     : parameterFromConfig?.patient_name || null,  // To be filled by ResultWriter if barcode lookup succeeds
        age_year         : ageYear !== null ? ageYear : (ageMonth !== null ? Math.floor(ageMonth / 12) : null),
        age_month        : ageMonth !== null ? ageMonth : (ageYear !== null ? ageYear * 12 : null),
        age_type         : ageYear !== null ? 'YEAR' : (ageMonth !== null ? 'MONTH' : null),
        gender           : sex === 'M' ? 'MALE' : (sex === 'F' ? 'FEMALE' : null),
      };
      mapped.push(mappedResult);
    }

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
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ParameterMapper;
