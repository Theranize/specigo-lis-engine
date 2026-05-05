/**
 * ParameterMapper.js
 * SpeciGo LIS Integration Engine - Mapping Layer
 *
 * Receives ParsedResult objects from AU480Parser and maps them to the LIMS
 * parameter identifiers required by ResultWriter.
 *
 * For the AU480 the mapping key is the 3-digit Online Test Number (e.g.
 * '009', '021') from the AU480 frame variable section. This differs from
 * the Access 2 which keys by ASTM assay code string.
 *
 * The parameter_map is loaded directly from the analyser config JSON file.
 * No database lookup is performed here - mapping is resolved from config
 * only, which means the parameter mapping must be populated in
 * au480_config.json before the engine goes live.
 *
 * MappedResult shape:
 * {
 *   lab_uid          : string,
 *   analyzer_uid     : string,
 *   barcode_uid      : string,   // sampleId from AU480Parser
 *   parameter_code   : string,   // from parameter_map[onlineTestNo].code
 *   loinc_id         : string,   // from parameter_map[onlineTestNo].loinc_id
 *   unit             : string,   // from parameter_map[onlineTestNo].unit
 *   value            : number|null,
 *   raw_value        : string,
 *   flag             : string|null,
 *   patient_name     : string|null,
 *   age_year         : number|null,
 *   age_month        : number|null,
 *   age_type         : string|null,  // 'YEAR' | 'MONTH' | null
 *   gender           : string|null,  // 'MALE' | 'FEMALE' | null
 *   result_status    : string,
 *   result_datetime  : string|null,  // AU480 frames carry no datetime; null
 *   mapping_status   : 'MAPPED' | 'UNMAPPED'
 * }
 */

'use strict';

const logger = require('../logger').createLogger('MAPPER');

// ---------------------------------------------------------------------------
// ParameterMapper class
// ---------------------------------------------------------------------------
class ParameterMapper {

  /**
   * @param {object} options
   * @param {object} options.dbPool        - mysql2 promise pool from IntegrationEngine.
   * @param {string} options.analyzerCode  - 'AU480'. Used in log context.
   * @param {string} options.analyzerUid   - From lab_analyzers.analyzer_uid.
   * @param {string} options.labUid        - lab_uid for all written records.
   * @param {object} options.parameter_map - From au480_config.json parameter_map block.
   *                                         Keys are 3-digit Online Test numbers (e.g. '009').
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
      analyzerCode    : this._analyzerCode,
      analyzerUid     : this._analyzerUid,
      labUid          : this._labUid,
      parameterMapKeys: Object.keys(this._parameterMap).length
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Maps an array of ParsedResult objects from AU480Parser to MappedResult
   * objects. Never throws - unmapped online test numbers come back with
   * mapping_status='UNMAPPED' so they are still visible in the LIMS for
   * administrator review.
   *
   * @param {object[]} parsedResults - Array of ParsedResult from AU480Parser.
   * @returns {object[]}             Array of MappedResult objects.
   */
  map(parsedResults) {
    const mapped = [];

    for (const result of parsedResults) {
      this.stats.lookups++;

      const {
        onlineTestNo,
        sampleId,
        numericValue,
        rawValue,
        flagMeaning,
        sex,
        ageYear,
        ageMonth
      } = result;

      // Look up parameter in config map by Online Test Number string.
      // Tolerate callers that pass the test number with stray whitespace or
      // a numeric type by normalising both sides of the lookup.
      const key       = String(onlineTestNo || '').trim();
      const paramEntry = this._parameterMap[key] || null;

      const ageYearNum  = this._toNumber(ageYear);
      const ageMonthNum = this._toNumber(ageMonth);

      const ageType = ageYearNum !== null
        ? 'YEAR'
        : (ageMonthNum !== null ? 'MONTH' : null);

      if (!paramEntry) {
        this.stats.unmappedParameter++;
        logger.warn('Online test number not found in parameter_map - result will be stored as UNMAPPED', {
          onlineTestNo: key,
          sampleId
        });
        mapped.push({
          lab_uid        : this._labUid,
          analyzer_uid   : this._analyzerUid,
          barcode_uid    : sampleId  || null,
          parameter_code : key       || null,
          loinc_id       : null,
          unit           : null,
          value          : numericValue !== null && numericValue !== undefined ? numericValue : null,
          raw_value      : rawValue !== undefined ? rawValue : null,
          flag           : flagMeaning || null,
          patient_name   : null,
          age_year       : ageYearNum,
          age_month      : ageMonthNum,
          age_type       : ageType,
          gender         : this._mapSex(sex),
          result_status  : 'F',
          result_datetime: null,
          mapping_status : 'UNMAPPED'
        });
        continue;
      }

      this.stats.mapped++;
      mapped.push({
        lab_uid        : this._labUid,
        analyzer_uid   : this._analyzerUid,
        barcode_uid    : sampleId             || null,
        parameter_code : paramEntry.code      || key,
        loinc_id       : paramEntry.loinc_id  || null,
        unit           : paramEntry.unit      || null,
        value          : numericValue !== null && numericValue !== undefined ? numericValue : null,
        raw_value      : rawValue !== undefined ? rawValue : null,
        flag           : flagMeaning          || null,
        patient_name   : null,
        age_year       : ageYearNum,
        age_month      : ageMonthNum,
        age_type       : ageType,
        gender         : this._mapSex(sex),
        result_status  : 'F',
        result_datetime: null,
        mapping_status : 'MAPPED'
      });
    }

    logger.debug('Mapping complete', {
      inputCount   : parsedResults.length,
      mappedCount  : mapped.filter((r) => r.mapping_status === 'MAPPED').length,
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
   * Coerces an AU480-parsed age field (which may be a 3-char/2-char string
   * with leading spaces or empty) to a finite number, or null.
   *
   * @param {*} v
   * @returns {number|null}
   */
  _toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Maps an AU480 sex code to LIMS gender string.
   *
   * @param {string} sex - 'M' | 'F' | '' | '0'
   * @returns {string|null}
   */
  _mapSex(sex) {
    if (!sex) return null;
    const s = String(sex).trim().toUpperCase();
    if (s === 'M') return 'MALE';
    if (s === 'F') return 'FEMALE';
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ParameterMapper;
