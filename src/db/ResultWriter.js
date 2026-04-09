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

    this.stats = {
      totalReceived : 0,
      written       : 0,
      skipped       : 0,
      failed        : 0,
      transactionErrors: 0
    };

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
  async write(result) {
    this.stats.totalReceived++;

    const { mappingStatus, sampleId, onlineTestNo } = result;

    logger.debug('ResultWriter.write called', {
      sampleId,
      onlineTestNo,
      mappingStatus
    });

    if (mappingStatus === 'MAPPED') {
      await this._writeMapped(result);
    } else {
      // UNMAPPED or ERROR - write audit row only, do not touch LIMS tables
      await this._writeUnmapped(result);
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

  /**
   * Returns a statistics snapshot for the REST status endpoint.
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internal - MAPPED result write (full transaction)
  // ---------------------------------------------------------------------------

  /**
   * Executes the complete 5-step write sequence inside a MySQL transaction.
   * On any failure the transaction is rolled back and the result is recorded
   * in lis_integration_results with lims_write_status=FAILED.
   *
   * @param {object} result - MappedResult from ParameterMapper.
   */
  async _writeMapped(result) {
    const {
      sampleId,
      barcodeUid,
      labUid,
      onlineTestNo,
      limsParameterUid,
      limsTestUid,
      parameterCode,
      numericValue,
      rawValue,
      dataFlag,
      flagMeaning,
      resultCategory,
      rawMessage
    } = result;

    // Format the numeric value as a string for the LIMS value field.
    // NULL numeric value (overflow, zero-suppress) is stored as empty string.
    const valueStr = numericValue !== null ? String(numericValue) : '';

    // param_remark stores null when flag is '  ' (no flag), else the meaning string
    const paramRemark = flagMeaning || null;

    let connection;
    try {
      connection = await this._pool.getConnection();
      await connection.beginTransaction();

      // STEP 1: Write result value to report_test_values_data
      // Uses the exact UPDATE from Section 9.1. If the row does not exist
      // (parameter not ordered for this sample) affectedRows will be 0.
      const updateValueSql = `
        UPDATE report_test_values_data
        SET
          value              = ?,
          quantitative_value = ?,
          param_remark       = ?,
          updated_at         = NOW()
        WHERE barcode_uid   = ?
          AND parameter_uid = ?
          AND lab_uid       = ?
      `;

      const [updateResult] = await connection.execute(updateValueSql, [
        valueStr,
        valueStr,
        paramRemark,
        barcodeUid,
        limsParameterUid,
        labUid
      ]);

      if (updateResult.affectedRows === 0) {
        // Parameter exists in mapping but no row in report_test_values_data.
        // This means the test was not ordered for this sample in the LIMS.
        // Record as SKIPPED rather than FAILED - it is a data mismatch not an error.
        logger.warn('report_test_values_data row not found - test not ordered for this sample', {
          sampleId,
          barcodeUid,
          limsParameterUid,
          onlineTestNo
        });

        await connection.rollback();
        connection.release();

        await this._insertIntegrationResult(result, 'MAPPED', 'SKIPPED',
          'Parameter row not found in report_test_values_data - test not ordered');
        this.stats.skipped++;
        return;
      }

      logger.debug('report_test_values_data updated', {
        barcodeUid,
        limsParameterUid,
        value: valueStr
      });

      // STEP 2: Check completion status for this barcode
      // Count parameters that still have no value (empty string or NULL).
      // If count is 0, all parameters received -> set TC. Otherwise set PC.
      const completionSql = `
        SELECT COUNT(*) AS pending_count
        FROM report_test_values_data
        WHERE barcode_uid = ?
          AND lab_uid     = ?
          AND (value IS NULL OR value = '')
      `;

      const [completionRows] = await connection.execute(completionSql, [barcodeUid, labUid]);
      const pendingCount = completionRows[0]?.pending_count ?? 1;
      const newStatus    = pendingCount === 0 ? 'TC' : 'PC';

      logger.debug('Completion check', {
        barcodeUid,
        pendingCount,
        newStatus
      });

      // STEP 3: Update test status in report_tests
      // Only updates ACTIVE ROUTINE tests as per the spec in Section 9.1.
      const updateTestSql = `
        UPDATE report_tests
        SET
          test_status = ?,
          updated_at  = NOW()
        WHERE barcode_uid         = ?
          AND lab_uid             = ?
          AND test_active_status  = 'ACTIVE'
          AND test_class          = 'ROUTINE'
      `;

      await connection.execute(updateTestSql, [newStatus, barcodeUid, labUid]);

      logger.debug('report_tests status updated', {
        barcodeUid,
        newStatus
      });

      // STEP 4: Insert audit row into lis_integration_results
      const insertResultSql = `
        INSERT INTO lis_integration_results
          (lab_uid, analyzer_uid, sample_id, sample_no, sample_type,
           rack_no, cup_position, online_test_no, parameter_code,
           lims_parameter_uid, raw_value, numeric_value, data_flag,
           mapping_status, lims_write_status, lims_barcode_uid,
           result_category, raw_message, received_at, written_at)
        VALUES
          (?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?,
           'MAPPED', 'WRITTEN', ?,
           ?, ?, NOW(), NOW())
      `;

      await connection.execute(insertResultSql, [
        labUid,
        this._analyzerUid,
        sampleId,
        result.sampleNo   || null,
        result.sampleType || null,
        result.rackNo     || null,
        result.cupPosition|| null,
        onlineTestNo,
        parameterCode,
        limsParameterUid,
        rawValue,
        numericValue,
        dataFlag,
        barcodeUid,
        resultCategory,
        rawMessage        || null
      ]);

      // STEP 5: Log communication event to lis_integration_log
      const insertLogSql = `
        INSERT INTO lis_integration_log
          (lab_uid, analyzer_uid, session_type, message_code, sample_id, details, created_at)
        VALUES
          (?, ?, 'ACK', ?, ?, ?, NOW())
      `;

      const logDetail = `Result written: ${parameterCode} = ${valueStr}${dataFlag.trim() ? ' [' + dataFlag.trim() + ']' : ''}`;

      await connection.execute(insertLogSql, [
        labUid,
        this._analyzerUid,
        result.messageCode || 'D ',
        sampleId,
        logDetail
      ]);

      await connection.commit();
      connection.release();

      this.stats.written++;

      logger.info('Result written to LIMS successfully', {
        sampleId,
        barcodeUid,
        onlineTestNo,
        parameterCode,
        value     : valueStr,
        testStatus: newStatus
      });

    } catch (err) {
      this.stats.transactionErrors++;

      // Always attempt rollback on transaction error
      if (connection) {
        try {
          await connection.rollback();
          logger.debug('Transaction rolled back after error', { sampleId });
        } catch (rollbackErr) {
          logger.error('Rollback failed', {
            sampleId,
            rollbackError: rollbackErr.message
          });
        }
        connection.release();
      }

      logger.error('LIMS write transaction failed', {
        sampleId,
        onlineTestNo,
        limsParameterUid,
        error: err.message,
        code : err.code || 'UNKNOWN'
      });

      this.stats.failed++;

      // Record the failure in lis_integration_results outside the failed transaction
      await this._insertIntegrationResult(result, 'MAPPED', 'FAILED', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - UNMAPPED / ERROR result write (audit only, no transaction)
  // ---------------------------------------------------------------------------

  /**
   * Writes a MappingFailure to lis_integration_results only.
   * No LIMS tables (report_test_values_data, report_tests) are touched.
   *
   * @param {object} result - MappingFailure from ParameterMapper.
   */
  async _writeUnmapped(result) {
    const limsWriteStatus = result.mappingStatus === 'ERROR' ? 'FAILED' : 'SKIPPED';

    logger.warn('Writing unmapped result to audit table', {
      sampleId     : result.sampleId,
      onlineTestNo : result.onlineTestNo,
      mappingStatus: result.mappingStatus,
      reason       : result.mappingError
    });

    await this._insertIntegrationResult(
      result,
      result.mappingStatus,
      limsWriteStatus,
      result.mappingError
    );

    this.stats.skipped++;
  }

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
