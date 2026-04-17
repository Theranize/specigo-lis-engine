/**
 * ResultWriter.js
 * SpeciGo LIS Integration Engine - Database Write Layer
 *
 * Receives MappedResult and MappingFailure objects from ParameterMapper and
 * executes the complete write sequence against the SpeciGo LIMS MySQL database.
 *
 * For MAPPED results the sequence (within a single transaction) is:
 *   1. Write result value to report_test_values_data
 *   2. Check whether all parameters for this barcode now have values
 *   3. Update report_tests.test_status to 'TC' (all done) or 'PC' (partial)
 *   4. Insert audit row into lis_integration_results with lims_write_status=WRITTEN
 *   5. Insert communication event into lis_integration_log
 *
 * For UNMAPPED results (barcode not found OR parameter not mapped):
 *   - Insert into lis_integration_results with mapping_status=UNMAPPED,
 *     lims_write_status=SKIPPED. No LIMS tables touched.
 *
 * For ERROR results:
 *   - Insert into lis_integration_results with mapping_status=ERROR,
 *     lims_write_status=FAILED plus error_message.
 *
 * All SQL queries are identical to those defined in Section 9.1 of the
 * foundation document. No deviation from the spec.
 *
 * test_status enum reference (Section 9.1):
 *   TP = Test Pending
 *   TS = Test Started
 *   PC = Partial Complete  <- set when some but not all params received
 *   TC = Test Completed    <- set when all params for barcode received
 *   RS = Resample
 *   RT = Retest
 *   TR = Test Rejected
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
   * @param {string} options.analyzerCode - e.g. 'AU480'.
   * @param {string} options.labUid       - Default lab_uid for log entries.
   */
  constructor(options = {}) {
    if (!options.dbPool) {
      throw new Error('ResultWriter: options.dbPool is required');
    }

    this._pool         = options.dbPool;
    this._analyzerUid  = options.analyzerUid  || 'unknown';
    this._analyzerCode = options.analyzerCode  || 'AU480';
    this._labUid       = options.labUid        || '';

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
   * Write a single mapped or unmapped result to the database.
   * Never throws - all errors are caught, logged, and recorded in lis_integration_results.
   *
   * @param {object} result - MappedResult or MappingFailure from ParameterMapper.
   * @returns {Promise<void>}
   */
  async write(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    const placeholders = results.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const sql = `
      INSERT INTO lis_results
        (lab_uid, analyzer_uid, barcode_uid, parameter_code, unit, value, flag, patient_name, age, age_type, gender)
      VALUES
        ${placeholders}
    `;

    const params = [];
    for (const r of results) {
      params.push(
        r.lab_uid        ?? this._labUid,
        r.analyzer_uid   ?? this._analyzerUid,
        r.barcode_uid    ?? null,
        r.parameter_code ?? null,
        r.unit           ?? null,
        r.value          ?? null,
        r.flag           ?? null,
        r.patient_name   ?? null,
        r.age            ?? null,
        r.age_type       ?? null,
        r.gender         ?? null
      );
    }

    try {
      await this._pool.execute(sql, params);
      logger.info('lis_results bulk insert complete', { rows: results.length });


      // const loincCodes = [];
      // for (const r of results) {        
      //   loincCodes.push(r.loinc_id);
      // }

      // const parameterSql = `
      //   SELECT test_uid, parameter_uid, loinc as loinc_id
      //   FROM lab_test_parameters
      //   WHERE lab_uid = ?
      //     AND loinc IN (${loincCodes.map(() => '?').join(', ')})
      // `;

      // const [parameterRows] = await this._pool.execute(parameterSql, [this._labUid, ...loincCodes]);
      // console.log('Fetched parameter codes for LOINC IDs', parameterRows);

      // const loincToParamCode = {};

      // for (const parameter of parameterRows) {  
      //   loincToParamCode[parameter.loinc_id] = loincToParamCode[parameter.loinc_id] || [];
      //   loincToParamCode[parameter.loinc_id].push(parameter.parameter_uid);    
      // }

      // for (const r of results) {     
      //   const paramCodes = loincToParamCode[r.loinc_id] || [];
      //   for (const paramCode of paramCodes) {
      //     const updateSql = `
      //       UPDATE report_test_values_data
      //       SET value = ?,
      //       quantitative_value = ?,
      //       qualitative_value = ?
      //       WHERE barcode_uid = ?
      //         AND parameter_uid = ?
      //         AND lab_uid = ?
      //     `;

      //     await this._pool.execute(updateSql, [
      //       r.value,
      //       r.value,
      //       r.flag,
      //       r.barcode_uid,
      //       paramCode,
      //       this._labUid
      //     ]);

      //     logger.info('Updated report_test_values_data', {
      //       barcodeUid: r.barcode_uid,
      //       parameterCode: paramCode,
      //       value: r.value
      //     });
      //   }
      // }

      // Map LOINC IDs to parameter codes
      // const loincToParamCode = {};
    } catch (err) {
      logger.error('Failed bulk insert into lis_results', { error: err.message });
      // agar non-fatal rakhna hai, to yahin swallow kar do; warna throw
    }
  }

  /**
   * Writes a session event to lis_integration_log.
   * Called by IntegrationEngine on DB (session start) and DE (session end).
   *
   * @param {string} sessionType - 'DB' or 'DE'.
   * @param {string} labUid
   */
  async logSessionEvent(sessionType, labUid) {
    const sql = `
      INSERT INTO lis_integration_log
        (lab_uid, analyzer_uid, session_type, message_code, details, created_at)
      VALUES
        (?, ?, ?, ?, ?, NOW())
    `;

    const detail = sessionType === 'DB'
      ? 'Analysis data transmission session started'
      : 'Analysis data transmission session ended';

    try {
      await this._pool.execute(sql, [
        labUid || this._labUid,
        this._analyzerUid,
        sessionType,
        sessionType,
        detail
      ]);
      logger.info('Session event logged', { sessionType, labUid });
    } catch (err) {
      // Session log failure is non-fatal - do not interrupt processing
      logger.error('Failed to log session event', {
        sessionType,
        error: err.message
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - MAPPED result write (full transaction)
  // ---------------------------------------------------------------------------



  // ---------------------------------------------------------------------------
  // Internal - lis_integration_results insert (used by both paths)
  // ---------------------------------------------------------------------------

  /**
   * Inserts a single row into lis_integration_results.
   * This is the audit trail for every result received from the analyser,
   * regardless of whether it was successfully written to the LIMS.
   *
   * Uses the pool directly (not a transaction connection) because this method
   * is called both inside and outside transaction contexts.
   * When called after a transaction failure, it must use an independent connection
   * to ensure the audit row is committed even though the main transaction rolled back.
   *
   * @param {object} result
   * @param {string} mappingStatus   - 'MAPPED' | 'UNMAPPED' | 'ERROR'
   * @param {string} limsWriteStatus - 'WRITTEN' | 'SKIPPED' | 'FAILED' | 'PENDING'
   * @param {string|null} errorMsg   - Failure reason if applicable.
   */
  async _insertIntegrationResult(result, mappingStatus, limsWriteStatus, errorMsg) {
    const sql = `
      INSERT INTO lis_integration_results
        (lab_uid, analyzer_uid, sample_id, sample_no, sample_type,
         rack_no, cup_position, online_test_no, parameter_code,
         lims_parameter_uid, raw_value, numeric_value, data_flag,
         mapping_status, lims_write_status, lims_barcode_uid,
         result_category, error_message, raw_message, received_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, NOW())
    `;

    const values = [
      result.labUid      || this._labUid,
      this._analyzerUid,
      result.sampleId    || null,
      result.sampleNo    || null,
      result.sampleType  || null,
      result.rackNo      || null,
      result.cupPosition || null,
      result.onlineTestNo,
      result.parameterCode || result.onlineTestNo,
      result.limsParameterUid || null,
      result.rawValue    || null,
      result.numericValue !== undefined ? result.numericValue : null,
      result.dataFlag    || null,
      mappingStatus,
      limsWriteStatus,
      result.barcodeUid  || null,
      result.resultCategory || 'PATIENT',
      errorMsg           || null,
      result.rawMessage  || null
    ];

    try {
      await this._pool.execute(sql, values);
      logger.debug('lis_integration_results row inserted', {
        sampleId     : result.sampleId,
        onlineTestNo : result.onlineTestNo,
        mappingStatus,
        limsWriteStatus
      });
    } catch (err) {
      // Audit insert failure is logged but not re-thrown.
      // The result processing pipeline must not halt because the audit table
      // has an issue (e.g. disk full, table lock). The LIMS write already
      // succeeded at this point for WRITTEN results.
      logger.error('Failed to insert into lis_integration_results', {
        sampleId    : result.sampleId,
        onlineTestNo: result.onlineTestNo,
        error       : err.message
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ResultWriter;
