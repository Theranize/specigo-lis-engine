/**
 * ParameterMapper.js
 * SpeciGo LIS Integration Engine - Mapping Layer
 *
 * Receives a ParsedResult from Access2Parser and maps it to the LIMS parameter
 * identifiers required by ResultWriter.
 *
 * For the Access 2 the mapping key is the ASTM assay code string (e.g. 'TSH', 'FT4')
 * extracted from the R record Universal Test ID field. This differs from the AU480
 * which uses a 3-digit numeric online test number.
 *
 * The parameter_map is loaded directly from the analyser config JSON file.
 * No database lookup is performed here - mapping is resolved from config only,
 * which means the parameter mapping must be populated in access2_config.json
 * before the engine goes live.
 *
 * Output:
 *   Returns a MappedResult array on success. Each element contains all ParsedResult
 *   fields plus the LIMS identity fields added by this mapper.
 *
 * MappedResult shape:
 * {
 *   lab_uid          : string,
 *   analyzer_uid     : string,
 *   barcode_uid      : string,   // sampleId from Access2Parser
 *   parameter_code   : string,   // from parameter_map[assayCode].code
 *   loinc_id         : string,   // from parameter_map[assayCode].loinc_id
 *   unit             : string,   // from parameter_map[assayCode].unit (or R record)
 *   value            : number|null,
 *   flag             : string|null,
 *   patient_name     : string|null,
 *   age_year         : number|null,
 *   age_month        : number|null,
 *   age_type         : string|null,  // 'YEAR' | 'MONTH' | null
 *   gender           : string|null,  // 'MALE' | 'FEMALE' | null
 *   result_status    : string,       // F / P / C / X
 *   result_datetime  : string,       // YYYYMMDDHHMMSS from instrument
 *   mapping_status   : 'MAPPED' | 'UNMAPPED'
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
// ParameterMapper class
// ---------------------------------------------------------------------------
class ParameterMapper {

  /**
   * @param {object} options
   * @param {object} options.dbPool        - mysql2 promise pool from IntegrationEngine.
   * @param {string} options.analyzerCode  - 'ACCESS2'. Used in log context.
   * @param {string} options.analyzerUid   - From lab_analyzers.analyzer_uid.
   * @param {string} options.labUid        - lab_uid for all written records.
   * @param {object} options.parameter_map - From access2_config.json parameter_map block.
   *                                         Keys are ASTM assay codes (e.g. 'TSH').
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
    this._parameterMap = options.parameter_map || {};

    this.stats = {
      lookups          : 0,
      mapped           : 0,
      unmappedParameter: 0,
      errors           : 0
    };

    logger.info('ParameterMapper initialised', {
      analyzerCode      : this._analyzerCode,
      analyzerUid       : this._analyzerUid,
      labUid            : this._labUid,
      parameterMapKeys  : Object.keys(this._parameterMap).length
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Maps an array of ParsedResult objects from Access2Parser to MappedResult objects.
   * Never throws - unmapped parameters are returned with mapping_status='UNMAPPED'.
   *
   * @param {object[]} parsedResults - Array of ParsedResult from Access2Parser.
   * @returns {object[]}             Array of MappedResult objects.
   */
  map(parsedResults) {
    const mapped = [];

    for (const result of parsedResults) {
      this.stats.lookups++;

      const {
        assayCode,
        sampleId,
        numericValue,
        value,
        unit,
        flagMeaning,
        sex,
        ageYear,
        ageMonth,
        patientName,
        resultStatus,
        resultDateTime
      } = result;

      // Look up parameter in config map by ASTM assay code
      const paramEntry = this._parameterMap[assayCode]
        || this._parameterMap[assayCode.toUpperCase()]
        || null;

      if (!paramEntry) {
        this.stats.unmappedParameter++;
        logger.warn('Assay code not found in parameter_map - result will be stored as UNMAPPED', {
          assayCode,
          sampleId
        });
        mapped.push({
          lab_uid        : this._labUid,
          analyzer_uid   : this._analyzerUid,
          barcode_uid    : sampleId  || null,
          parameter_code : assayCode || null,
          loinc_id       : null,
          unit           : unit      || null,
          value          : numericValue !== null ? numericValue : null,
          raw_value      : value     || null,
          flag           : flagMeaning || null,
          patient_name   : patientName || null,
          age_year       : ageYear   !== undefined ? ageYear   : null,
          age_month      : ageMonth  !== undefined ? ageMonth  : null,
          age_type       : ageYear   !== null ? 'YEAR' : (ageMonth !== null ? 'MONTH' : null),
          gender         : this._mapSex(sex),
          result_status  : resultStatus   || 'F',
          result_datetime: resultDateTime || null,
          mapping_status : 'UNMAPPED'
        });
        continue;
      }

      this.stats.mapped++;
      mapped.push({
        lab_uid        : this._labUid,
        analyzer_uid   : this._analyzerUid,
        barcode_uid    : sampleId                  || null,
        parameter_code : paramEntry.code           || assayCode,
        loinc_id       : paramEntry.loinc_id       || null,
        // Prefer unit from config over instrument-reported unit for consistency.
        // Instrument unit is used as fallback if config entry has no unit (e.g. qualitative tests).
        unit           : paramEntry.unit           || unit || null,
        value          : numericValue !== null ? numericValue : null,
        raw_value      : value                     || null,
        flag           : flagMeaning               || null,
        patient_name   : patientName               || null,
        age_year       : ageYear   !== undefined   ? ageYear   : null,
        age_month      : ageMonth  !== undefined   ? ageMonth  : null,
        age_type       : ageYear   !== null        ? 'YEAR' : (ageMonth !== null ? 'MONTH' : null),
        gender         : this._mapSex(sex),
        result_status  : resultStatus              || 'F',
        result_datetime: resultDateTime            || null,
        mapping_status : 'MAPPED'
      });
    }

    logger.debug('Mapping complete', {
      inputCount  : parsedResults.length,
      mappedCount : mapped.filter((r) => r.mapping_status === 'MAPPED').length,
      unmappedCount: mapped.filter((r) => r.mapping_status === 'UNMAPPED').length
    });

    return mapped;
  }

  /**
   * Returns statistics snapshot for the dashboard status endpoint.
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Maps ASTM sex code to LIMS gender string.
   *
   * @param {string} sex - 'M' | 'F' | 'U' | 'I' | ''
   * @returns {string|null}
   */
  _mapSex(sex) {
    if (!sex) return null;
    const s = sex.toUpperCase();
    if (s === 'M') return 'MALE';
    if (s === 'F') return 'FEMALE';
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ParameterMapper;
