/**
 * BS230Parser.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Parses complete ASTM E1394 / LIS2-A2 messages delivered by ASTMFramer.js
 * for the Mindray BS-230 chemistry analyser.
 *
 * The BS-230 follows the standard LIS2-A2 record layout (manual section
 * 1.4.8 / 8.6.2). Chemistries are identified by the operator-assigned
 * "Channel No." value (manual section 8.6.3) which appears in the R record
 * Universal Test ID field, the same slot used by the Access 2 driver. The
 * channel number can be a numeric string (e.g. '1', '12') or an
 * alphanumeric mnemonic (e.g. 'GLU', 'CHOL') depending on how the operator
 * provisioned the analyzer. Both forms are supported as keys in the
 * parameter_map.
 *
 * ASTM Record types handled:
 *   H  -> Header record        (transmission metadata, marks message start)
 *   P  -> Patient record       (demographics: name, DOB, sex)
 *   O  -> Order record         (specimen ID / barcode, test requested)
 *   R  -> Result record        (channel number, value, units, flag, status)
 *   L  -> Message terminator   (marks message end)
 *   Q  -> Query record         (host-query response - ignored in v1)
 *   C  -> Comment record       (ignored)
 *
 * ParsedResult object shape (one per R record):
 * {
 *   assayCode      : string,   // chemistry channel number, e.g. 'GLU' or '12'
 *   assayName      : string,   // full name from R record universal test id
 *   value          : string,   // raw string value from R record field 4
 *   numericValue   : number|null,
 *   unit           : string,   // e.g. 'mg/dL'
 *   referenceRange : string,   // e.g. '70-110'
 *   abnormalFlag   : string,   // 'N' | 'H' | 'L' | 'HH' | 'LL' | 'A' | '<' | '>'
 *   flagMeaning    : string,   // human-readable flag for param_remark
 *   resultStatus   : string,   // 'F'=Final 'P'=Preliminary 'C'=Correction 'X'=Cannot be done
 *   resultDateTime : string,   // YYYYMMDDHHMMSS from R field 13
 *   instrumentId   : string,   // from R field 14 or H record sender
 *   sampleId       : string,   // barcode_uid from O record field 3
 *   patientName    : string,   // from P record field 6
 *   patientDob     : string,   // from P record field 8 (YYYYMMDD)
 *   sex            : string,   // 'M'/'F'/'U' from P record field 9
 *   resultCategory : string,   // 'PATIENT' | 'QC' | 'CALIBRATION'
 *   rawRecord      : string    // full R record line for audit
 * }
 *
 * Events emitted:
 *   'results'        -> (ParsedResult[])   Array of parsed results from one ASTM message
 *   'sessionStart'   -> ()                 Fired on H record receipt
 *   'sessionEnd'     -> ()                 Fired on L record receipt
 *   'filtered'       -> (reason: string)   Non-patient result filtered
 *   'parseError'     -> (err: Error, rawMessage: string)
 */

'use strict';

const { EventEmitter } = require('events');

const logger = require('../logger').createLogger('BS230');

// ---------------------------------------------------------------------------
// ASTM field / component delimiter constants
// ---------------------------------------------------------------------------
const FIELD_DELIMITER     = '|';
const COMPONENT_DELIMITER = '^';
const RECORD_DELIMITER    = '\r';   // CR 0x0D separates ASTM records within a message

// ---------------------------------------------------------------------------
// Abnormal flag -> human-readable mapping
// Per ASTM E1394 Table 12.
// ---------------------------------------------------------------------------
const FLAG_MEANINGS = {
  'N'  : 'Normal',
  'H'  : 'High',
  'L'  : 'Low',
  'HH' : 'Critical High',
  'LL' : 'Critical Low',
  'A'  : 'Abnormal',
  '<'  : 'Below detection limit',
  '>'  : 'Above measurement range',
  'I'  : 'Indeterminate',
  ''   : null
};

// ---------------------------------------------------------------------------
// Result status descriptions
// ---------------------------------------------------------------------------
const STATUS_DESCRIPTIONS = {
  'F' : 'Final',
  'P' : 'Preliminary',
  'C' : 'Correction of previously transmitted result',
  'X' : 'Cannot be done',
  'I' : 'In instrument - results pending',
  'S' : 'Partial (instrument continues processing)',
  'M' : 'Microbiology - awaiting identification'
};

// ---------------------------------------------------------------------------
// BS230Parser class
// ---------------------------------------------------------------------------
class BS230Parser extends EventEmitter {

  /**
   * @param {object} options
   * @param {object} options.messageFilters - Which result categories to process.
   *   { patient_results: true, qc_results: false, calibration_results: false }
   * @param {string} [options.analyzerUid]
   * @param {string} [options.labUid]
   */
  constructor(options = {}) {
    super();

    this._filters = {
      patient_results     : options.messageFilters?.patient_results     !== false,
      qc_results          : options.messageFilters?.qc_results          === true,
      calibration_results : options.messageFilters?.calibration_results === true
    };

    this._analyzerUid = options.analyzerUid || 'unknown';
    this._labUid      = options.labUid      || 'unknown';

    this.stats = {
      messagesReceived : 0,
      resultsEmitted   : 0,
      messagesFiltered : 0,
      parseErrors      : 0,
      sessionsStarted  : 0,
      sessionsEnded    : 0
    };

    // Session-scoped state persisted across parse() calls (one call per ASTM
    // message). Reset on H record; used to correlate P, O context with R records.
    this._session = {
      headerSender   : '',
      sampleId       : '',
      patientName    : '',
      patientDob     : '',
      sex            : '',
      resultCategory : 'PATIENT'
    };

    // R records accumulate here until the L record triggers the 'results' emit.
    this._pendingResults = [];

    logger.info('BS230Parser initialised', {
      filters    : this._filters,
      analyzerUid: this._analyzerUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse a complete ASTM message string delivered by ASTMFramer.
   * Called via: framer.on('message', (text) => parser.parse(text))
   *
   * @param {string} messageText - Complete ASTM message body with CR-delimited records.
   */
  parse(messageText) {
    if (typeof messageText !== 'string' || messageText.length === 0) {
      const err = new Error('BS230Parser.parse(): received empty or non-string message');
      logger.error(err.message);
      this.stats.parseErrors++;
      this.emit('parseError', err, messageText || '');
      return;
    }

    this.stats.messagesReceived++;

    try {
      // Split the message into individual ASTM records by CR (0x0D).
      // Filter out any empty lines that may result from trailing CR or CRLF.
      const records = messageText
        .split(RECORD_DELIMITER)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);

      if (records.length === 0) {
        logger.warn('ASTM message contained no parseable records', {
          rawLength: messageText.length
        });
        this.stats.parseErrors++;
        this.emit('parseError', new Error('No records found in ASTM message'), messageText);
        return;
      }

      logger.debug('Parsing ASTM message', {
        totalRecords: records.length,
        firstRecord : records[0].substring(0, 20)
      });

      this._processRecords(records, messageText);

    } catch (err) {
      this.stats.parseErrors++;
      logger.error('Unhandled error during ASTM message parse', {
        error: err.message,
        stack: err.stack
      });
      this.emit('parseError', err, messageText);
    }
  }

  /**
   * Returns statistics snapshot for the dashboard status endpoint.
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internal - record processing
  // ---------------------------------------------------------------------------

  /**
   * Iterates the record list and extracts context (H, P, O) and results (R, L).
   *
   * @param {string[]} records     - Array of ASTM record lines.
   * @param {string}   rawMessage  - Full original message text for audit.
   */
  _processRecords(records, rawMessage) {
    for (const record of records) {
      if (record.length === 0) continue;

      const recordType = record.charAt(0);

      switch (recordType) {
        case 'H':
          // New transmission session - reset all session context and pending results.
          this._session = {
            headerSender   : '',
            sampleId       : '',
            patientName    : '',
            patientDob     : '',
            sex            : '',
            resultCategory : 'PATIENT'
          };
          this._pendingResults = [];
          this._parseHeaderRecord(record, (ctx) => {
            this._session.headerSender = ctx.sender;
          });
          this.stats.sessionsStarted++;
          this.emit('sessionStart');
          break;

        case 'P':
          this._parsePatientRecord(record, (ctx) => {
            this._session.patientName = ctx.patientName;
            this._session.patientDob  = ctx.patientDob;
            this._session.sex         = ctx.sex;
          });
          break;

        case 'O':
          this._parseOrderRecord(record, (ctx) => {
            this._session.sampleId       = ctx.sampleId;
            this._session.resultCategory = ctx.resultCategory;
          });
          break;

        case 'R':
          if (!this._session.sampleId) {
            logger.warn('R record received before O record - sampleId unknown, record skipped', {
              record: record.substring(0, 60)
            });
            break;
          }

          if (!this._isCategoryEnabled(this._session.resultCategory)) {
            this.stats.messagesFiltered++;
            logger.debug('R record filtered by category', { resultCategory: this._session.resultCategory });
            this.emit('filtered', `category ${this._session.resultCategory} disabled in config`);
            break;
          }

          try {
            const result = this._parseResultRecord(
              record,
              this._session.sampleId,
              this._session.patientName,
              this._session.patientDob,
              this._session.sex,
              this._session.resultCategory,
              this._session.headerSender,
              rawMessage
            );
            if (result) this._pendingResults.push(result);
          } catch (err) {
            this.stats.parseErrors++;
            logger.error('Error parsing R record', {
              error : err.message,
              record: record.substring(0, 80)
            });
          }
          break;

        case 'L': {
          // Message terminator - emit all accumulated R results for this session.
          const toEmit = this._pendingResults;
          this._pendingResults = [];
          this.stats.sessionsEnded++;
          this.emit('sessionEnd');

          if (toEmit.length > 0) {
            this.stats.resultsEmitted += toEmit.length;
            logger.info('Results parsed from ASTM message', {
              count   : toEmit.length,
              sampleId: this._session.sampleId
            });
            this.emit('results', toEmit);
          }
          break;
        }

        case 'Q':
        case 'C':
          // Query and Comment records - not used in v1
          logger.debug('Skipping non-result record', { recordType });
          break;

        default:
          logger.debug('Unknown ASTM record type - skipping', { recordType });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - individual record parsers
  // ---------------------------------------------------------------------------

  /**
   * Parses the H (Header) record.
   * H|field_separator_specs|message_control_id|access_password|sender...
   *
   * Field index 4: Sender name / instrument identifier (e.g. 'BS-230^x.y.z').
   *
   * @param {string}   record   - Full H record line.
   * @param {Function} callback - Receives { sender: string }.
   */
  _parseHeaderRecord(record, callback) {
    const fields      = record.split(FIELD_DELIMITER);
    const senderField = fields[4] || '';
    const senderParts = senderField.split(COMPONENT_DELIMITER);
    const sender      = senderParts[0] || '';

    logger.debug('H record parsed', { sender });
    callback({ sender });
  }

  /**
   * Parses the P (Patient) record per ASTM LIS2-A2 Table 11. The Mindray
   * BS-230 follows the standard layout: name in field 6, DOB in field 8,
   * sex in field 9.
   *
   * [0]  P
   * [1]  Sequence number
   * [2]  Practice-assigned patient ID
   * [3]  Laboratory-assigned patient ID
   * [4]  Patient ID No. 3
   * [5]  Patient name (Last^First^Middle)
   * [6]  Mother's maiden name
   * [7]  Birthdate (YYYYMMDD)
   * [8]  Sex (M/F/U)
   *
   * Some Mindray firmware variants emit the name at field 5 and others at
   * field 7 - this parser tolerates both.
   *
   * @param {string}   record   - Full P record line.
   * @param {Function} callback - Receives { patientName, patientDob, sex }.
   */
  _parsePatientRecord(record, callback) {
    const fields = record.split(FIELD_DELIMITER);

    // Probe the two common name field offsets and pick whichever has content.
    const nameFieldA = fields[5] || '';
    const nameFieldB = fields[7] || '';
    const nameField  = nameFieldA.includes(COMPONENT_DELIMITER) || nameFieldA.length > nameFieldB.length
      ? nameFieldA
      : nameFieldB;

    const nameParts  = nameField.split(COMPONENT_DELIMITER);
    const lastName   = (nameParts[0] || '').trim();
    const firstName  = (nameParts[1] || '').trim();
    const patientName = [firstName, lastName].filter(Boolean).join(' ') || lastName;

    // Same probe for DOB / sex offsets - vendor variants exist.
    const dobA = (fields[7]  || '').trim();
    const dobB = (fields[9]  || '').trim();
    const patientDob = /^\d{8}/.test(dobA) ? dobA : (/^\d{8}/.test(dobB) ? dobB : '');

    const sexA = (fields[8]  || '').trim().toUpperCase();
    const sexB = (fields[10] || '').trim().toUpperCase();
    const sex  = ['M', 'F', 'U'].includes(sexA) ? sexA
              : (['M', 'F', 'U'].includes(sexB) ? sexB : '');

    logger.debug('P record parsed', { patientName, patientDob, sex });
    callback({ patientName, patientDob, sex });
  }

  /**
   * Parses the O (Order) record to extract the Specimen ID (barcode) per
   * ASTM LIS2-A2 Table 13.
   *
   * [0] O
   * [1] Sequence number
   * [2] Specimen ID (barcode_uid - the primary LIS identifier for this tube)
   * [3] Instrument specimen ID
   * [4] Universal test ID (^^^channel_no^^)
   * [5] Priority (R=routine, S=stat)
   * ...
   * [25] Result report type
   *
   * @param {string}   record   - Full O record line.
   * @param {Function} callback - Receives { sampleId, resultCategory }.
   */
  _parseOrderRecord(record, callback) {
    const fields   = record.split(FIELD_DELIMITER);
    const sampleId = (fields[2] || '').trim();

    // Result-category heuristic. Mindray's QC and calibration samples
    // typically come without a P record, but some firmware tags the sample
    // ID with a 'QC' or 'CAL' prefix - both signals are checked here.
    let resultCategory = 'PATIENT';
    const upper = sampleId.toUpperCase();
    if (upper.startsWith('QC')) {
      resultCategory = 'QC';
    } else if (upper.startsWith('CAL')) {
      resultCategory = 'CALIBRATION';
    }

    if (!sampleId) {
      logger.warn('O record has empty Specimen ID field', {
        record: record.substring(0, 80)
      });
    }

    logger.debug('O record parsed', { sampleId, resultCategory });
    callback({ sampleId, resultCategory });
  }

  /**
   * Parses an R (Result) record into a ParsedResult object per ASTM LIS2-A2
   * Table 15.
   *
   * [0]  R
   * [1]  Sequence number
   * [2]  Universal Test ID  (^^^channel_no^^ format)
   * [3]  Measurement value
   * [4]  Units              (e.g. 'mg/dL')
   * [5]  Reference interval (e.g. '70-110')
   * [6]  Abnormal flag      (N / H / L / HH / LL / A / < / >)
   * [7]  Nature of abnormality test
   * [8]  Result status      (F / P / C / X)
   * [9]  Date/time of change
   * [10] Operator ID
   * [11] Date/time test started
   * [12] Date/time test completed (YYYYMMDDHHMMSS)
   * [13] Instrument ID
   *
   * @returns {object|null} ParsedResult or null if unparseable.
   */
  _parseResultRecord(record, sampleId, patientName, patientDob, sex,
    resultCategory, instrumentId, rawMessage) {

    const fields = record.split(FIELD_DELIMITER);

    // --- Universal Test ID (field index 2): ^^^channel_no^^ ---
    // Components are caret-delimited. The chemistry channel number is at
    // component index 3 by convention. Some BS-230 firmware writes the
    // channel number at component index 0 (no leading carets) - both
    // layouts are accepted.
    const testIdField  = fields[2] || '';
    const testIdParts  = testIdField.split(COMPONENT_DELIMITER);
    const channelCode  = (testIdParts[3] || testIdParts[0] || '').trim();
    const assayCode    = channelCode.toUpperCase();
    const assayName    = (testIdParts[4] || channelCode || '').trim();

    if (!assayCode) {
      logger.warn('R record has empty channel number in Universal Test ID field', {
        testIdField,
        sampleId
      });
      return null;
    }

    const rawValue       = (fields[3] || '').trim();
    const numericValue   = this._parseNumericValue(rawValue);
    const unit           = (fields[4] || '').trim();
    const referenceRange = (fields[5] || '').trim();

    const rawFlag      = (fields[6] || '').trim().toUpperCase();
    const flagMeaning  = this._parseFlagMeaning(rawFlag);

    const resultStatus   = (fields[8]  || 'F').trim().toUpperCase();
    const resultDateTime = (fields[12] || '').trim();
    const rInstrumentId  = (fields[13] || instrumentId || '').trim();

    const { ageYear, ageMonth } = this._deriveAge(patientDob);

    const parsedResult = {
      assayCode      : assayCode,
      assayName      : assayName,
      value          : rawValue,
      numericValue   : numericValue,
      unit           : unit,
      referenceRange : referenceRange,
      abnormalFlag   : rawFlag,
      flagMeaning    : flagMeaning,
      resultStatus   : resultStatus,
      resultDateTime : resultDateTime,
      instrumentId   : rInstrumentId,
      sampleId       : sampleId,
      patientName    : patientName,
      patientDob     : patientDob,
      sex            : sex,
      ageYear        : ageYear,
      ageMonth       : ageMonth,
      resultCategory : resultCategory,
      rawRecord      : record
    };

    logger.debug('R record parsed', {
      assayCode,
      sampleId,
      rawValue,
      numericValue,
      abnormalFlag: rawFlag,
      resultStatus
    });

    return parsedResult;
  }

  // ---------------------------------------------------------------------------
  // Internal - helper parsers
  // ---------------------------------------------------------------------------

  /**
   * Attempts to parse a numeric float from the raw ASTM value string.
   * Returns null for non-numeric values. Strips leading comparison
   * operators (< >) before parsing.
   */
  _parseNumericValue(rawValue) {
    if (!rawValue) return null;
    const stripped = rawValue.replace(/^[<>]+/, '').trim();
    const parsed   = parseFloat(stripped);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Maps the ASTM abnormal flag to a human-readable string.
   * Returns null for no-flag cases (empty string or 'N').
   */
  _parseFlagMeaning(flag) {
    if (!flag || flag === 'N') return null;
    return FLAG_MEANINGS[flag] || flag;
  }

  /**
   * Derives ageYear and ageMonth from a DOB string (YYYYMMDD).
   * Returns null values if DOB is absent or unparseable.
   */
  _deriveAge(dob) {
    if (!dob || dob.length < 8) return { ageYear: null, ageMonth: null };

    try {
      const year  = parseInt(dob.substring(0, 4), 10);
      const month = parseInt(dob.substring(4, 6), 10) - 1;
      const day   = parseInt(dob.substring(6, 8), 10);
      const dob_  = new Date(year, month, day);
      const now   = new Date();

      if (isNaN(dob_.getTime())) return { ageYear: null, ageMonth: null };

      let ageYear  = now.getFullYear() - dob_.getFullYear();
      let ageMonth = now.getMonth()    - dob_.getMonth();

      if (ageMonth < 0) {
        ageYear--;
        ageMonth += 12;
      }

      if (now.getDate() < dob_.getDate()) {
        ageMonth--;
        if (ageMonth < 0) {
          ageYear--;
          ageMonth += 12;
        }
      }

      return { ageYear, ageMonth };
    } catch {
      return { ageYear: null, ageMonth: null };
    }
  }

  /**
   * Returns true if the given result category is enabled in message_filters config.
   */
  _isCategoryEnabled(category) {
    if (category === 'PATIENT')     return this._filters.patient_results;
    if (category === 'QC')          return this._filters.qc_results;
    if (category === 'CALIBRATION') return this._filters.calibration_results;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = BS230Parser;
