/**
 * ParameterMapper.js
 * SpeciGo LIS Integration Engine - Mapping Layer
 *
 * Receives a ParsedResult from BS230Parser and maps it to the LIMS parameter
 * identifiers required by ResultWriter.
 *
 * For the BS-230 the mapping key is the chemistry channel number (manual
 * section 8.6.3) extracted from the R record Universal Test ID field.
 * Channel numbers are operator-assigned on the analyzer and may be numeric
 * (e.g. '1', '12') or alphanumeric mnemonics (e.g. 'GLU', 'CHOL'). Both
 * forms are matched against parameter_map keys case-insensitively.
 *
 * The parameter_map is loaded directly from the analyser config JSON file.
 * No database lookup is performed here - mapping is resolved from config only,
 * which means the parameter mapping must be populated in bs230_config.json
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
 *   barcode_uid      : string,   // sampleId from BS230Parser
 *   parameter_code   : string,   // from parameter_map[channelNo].code
 *   loinc_id         : string|null,
 *   unit             : string,
 *   value            : number|null,
 *   raw_value        : string,
 *   flag             : string|null,
 *   patient_name     : string|null,
 *   age_year         : number|null,
 *   age_month        : number|null,
 *   age_type         : 'YEAR' | 'MONTH' | null,
 *   gender           : 'MALE' | 'FEMALE' | null,
 *   result_status    : string,       // F / P / C / X
 *   result_datetime  : string,       // YYYYMMDDHHMMSS from instrument
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
   * @param {string} options.analyzerCode  - 'BS230'. Used in log context.
   * @param {string} options.analyzerUid   - From lab_analyzers.analyzer_uid.
   * @param {string} options.labUid        - lab_uid for all written records.
   * @param {object} options.parameter_map - From bs230_config.json parameter_map block.
   *                                         Keys are chemistry channel numbers.
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

    // Pre-build a normalised lookup so case differences and whitespace in
    // either the config keys or the incoming channel numbers do not cause
    // false UNMAPPED rows. The original entry is kept by reference.
    this._normalisedMap = {};
    for (const key of Object.keys(this._parameterMap)) {
      if (key.startsWith('_')) continue;       // ignore comment fields
      const norm = String(key).trim().toUpperCase();
      this._normalisedMap[norm] = this._parameterMap[key];
    }

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
      parameterMapKeys  : Object.keys(this._normalisedMap).length
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Maps an array of ParsedResult objects from BS230Parser to MappedResult objects.
   * Never throws - unmapped channel numbers are returned with mapping_status='UNMAPPED'.
   *
   * @param {object[]} parsedResults - Array of ParsedResult from BS230Parser.
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

      const lookupKey = String(assayCode || '').trim().toUpperCase();
      const paramEntry = this._normalisedMap[lookupKey] || null;

      if (!paramEntry) {
        this.stats.unmappedParameter++;
        logger.warn('Channel number not found in parameter_map - result will be stored as UNMAPPED', {
          channelNo: assayCode,
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
        // Instrument unit is used as fallback if config entry has no unit.
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
