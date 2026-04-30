/**
 * Access2Parser.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Parses complete ASTM E1394 / LIS2-A2 messages delivered by ASTMFramer.js.
 * Implements the Beckman Coulter Access 2 immunoassay analyser LIS protocol
 * as documented in "DXI ACCESS LIS Vendor Information C03112AC".
 *
 * The Access 2 sends ASTM-formatted messages in "Send All Results" auto-push mode.
 * No host query is required (though Host Query On is enabled as a fallback).
 *
 * ASTM Record types handled:
 *   H  -> Header record        (transmission metadata, marks message start)
 *   P  -> Patient record       (demographics: name, DOB, sex - if transmitted)
 *   O  -> Order record         (specimen ID / barcode, test requested)
 *   R  -> Result record        (assay code, numeric/text value, units, flag, status)
 *   L  -> Message terminator   (marks message end)
 *   Q  -> Query record         (ignored in push mode)
 *   C  -> Comment record       (ignored)
 *
 * ParsedResult object shape (one per R record):
 * {
 *   assayCode      : string,   // e.g. 'TSH', 'FT4' - key for parameter_map lookup
 *   assayName      : string,   // full name from R record universal test id if present
 *   value          : string,   // raw string value from R record field 4 (e.g. '2.50')
 *   numericValue   : number|null, // parsed float or null for non-numeric results
 *   unit           : string,   // e.g. 'uIU/mL'
 *   referenceRange : string,   // e.g. '0.27-4.20'
 *   abnormalFlag   : string,   // 'N' | 'H' | 'L' | 'HH' | 'LL' | 'A' | '<' | '>'
 *   flagMeaning    : string,   // human-readable flag for param_remark
 *   resultStatus   : string,   // 'F'=Final 'P'=Preliminary 'C'=Correction 'X'=Cannot be done
 *   resultDateTime : string,   // YYYYMMDDHHMMSS from R field 13
 *   instrumentId   : string,   // from R field 14 or H record sender
 *   sampleId       : string,   // barcode_uid from O record field 3 (Specimen ID)
 *   patientName    : string,   // from P record field 6 (last^first format)
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
const winston          = require('winston');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [ACCESS2] [${level.toUpperCase()}] ${message}${metaStr}`;
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
          `[${timestamp}] [ACCESS2] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// ASTM field / component delimiter constants
// ---------------------------------------------------------------------------
const FIELD_DELIMITER     = '|';
const COMPONENT_DELIMITER = '^';
const RECORD_DELIMITER    = '\r';   // CR 0x0D separates ASTM records within a message

// ---------------------------------------------------------------------------
// Abnormal flag -> human-readable mapping
// Per ASTM E1394 Table 12 and Beckman Coulter Access 2 documentation.
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
  'R'  : 'Reactive',
  'NR' : 'Non-Reactive',
  'E'  : 'Equivocal',
  ''   : null   // No flag - store NULL in param_remark
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
// Access2Parser class
// ---------------------------------------------------------------------------
class Access2Parser extends EventEmitter {

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

    // Session-scoped state persisted across parse() calls (one call per ASTM frame).
    // Reset on H record; used to correlate P, O context with subsequent R records.
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

    logger.info('Access2Parser initialised', {
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
      const err = new Error('Access2Parser.parse(): received empty or non-string message');
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
          // Query and Comment records - not relevant in push mode
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
   * H|field_separator_specs|message_control_id|sender...
   *
   * Field 5 (index 4): Sender name / instrument identifier.
   *
   * @param {string}   record   - Full H record line.
   * @param {Function} callback - Receives { sender: string }.
   */
  _parseHeaderRecord(record, callback) {
    const fields = record.split(FIELD_DELIMITER);
    // H field layout:
    // [0] H
    // [1] Field delimiter definitions (\^&)
    // [2] Message control ID
    // [3] Access password
    // [4] Sender name (instrument ID) - e.g. ACCESSII^3.4.0
    // [5] Sender address
    // ...
    const senderField  = fields[4] || '';
    const senderParts  = senderField.split(COMPONENT_DELIMITER);
    const sender       = senderParts[0] || '';

    logger.debug('H record parsed', { sender });
    callback({ sender });
  }

  /**
   * Parses the P (Patient) record.
   * Field layout as transmitted by the Beckman Coulter Access 2
   * (confirmed from device output - differs from vanilla ASTM LIS2-A2 offsets):
   *
   * [0]  P
   * [1]  Sequence number
   * [2]  Practice-assigned patient ID (empty on Access 2)
   * [3]  Laboratory-assigned patient ID (specimen barcode)
   * [4]  Patient ID No. 3 (empty on Access 2)
   * [5]  (empty on Access 2)
   * [6]  (empty on Access 2)
   * [7]  Patient name (last^first)
   * [8]  (empty on Access 2)
   * [9]  Birthdate (YYYYMMDD)
   * [10] Sex (M/F/U)
   *
   * @param {string}   record   - Full P record line.
   * @param {Function} callback - Receives { patientName, patientDob, sex }.
   */
  _parsePatientRecord(record, callback) {
    const fields = record.split(FIELD_DELIMITER);

    const nameField  = fields[7] || '';
    const nameParts  = nameField.split(COMPONENT_DELIMITER);
    // Reconstruct readable name: "First Last" from "Last^First"
    const lastName   = (nameParts[0] || '').trim();
    const firstName  = (nameParts[1] || '').trim();
    const patientName = [firstName, lastName].filter(Boolean).join(' ') || lastName;

    const patientDob = (fields[9]  || '').trim();
    const sex        = (fields[10] || '').trim().toUpperCase();

    logger.debug('P record parsed', { patientName, patientDob, sex });
    callback({ patientName, patientDob, sex });
  }

  /**
   * Parses the O (Order) record to extract the Specimen ID (barcode).
   * Field layout per ASTM LIS2-A2 Table 13:
   *
   * [0] O
   * [1] Sequence number
   * [2] Specimen ID (barcode_uid - the primary LIS identifier for this tube)
   * [3] Instrument specimen ID
   * [4] Universal test ID (^^^assay_code^^)
   * [5] Priority (R=routine, S=stat)
   * [6] Requested date/time
   * [7] Collection date/time
   * ...
   * [25] Result report type: 'O'=order 'C'=corrected 'P'=preliminary 'F'=final
   *
   * @param {string}   record   - Full O record line.
   * @param {Function} callback - Receives { sampleId, resultCategory }.
   */
  _parseOrderRecord(record, callback) {
    const fields   = record.split(FIELD_DELIMITER);
    const sampleId = (fields[2] || '').trim();

    // Determine result category from O record context.
    // Access 2 uses P-O-R hierarchy: patient samples go under P records.
    // QC samples typically have no P record (or have QC-specific sample IDs).
    // We use a simple heuristic: if sampleId starts with 'QC' it is QC data.
    let resultCategory = 'PATIENT';
    if (sampleId.toUpperCase().startsWith('QC')) {
      resultCategory = 'QC';
    } else if (sampleId.toUpperCase().startsWith('CAL')) {
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
   * Parses an R (Result) record into a ParsedResult object.
   * Field layout per ASTM LIS2-A2 Table 15:
   *
   * [0]  R
   * [1]  Sequence number
   * [2]  Universal Test ID  (^^^assay_code^^ format)
   * [3]  Measurement value  (numeric or text such as 'Reactive')
   * [4]  Units              (e.g. 'uIU/mL')
   * [5]  Reference interval (e.g. '0.27-4.20')
   * [6]  Abnormal flag      (N / H / L / HH / LL / A / < / >)
   * [7]  Nature of abnormality test
   * [8]  Result status      (F=final P=preliminary C=correction X=cannot be done)
   * [9]  Date/time of change
   * [10] Operator ID
   * [11] Date/time test started
   * [12] Date/time test completed (YYYYMMDDHHMMSS)
   * [13] Instrument ID
   *
   * @param {string}  record         - Full R record line.
   * @param {string}  sampleId       - From preceding O record.
   * @param {string}  patientName    - From preceding P record.
   * @param {string}  patientDob     - From preceding P record.
   * @param {string}  sex            - From preceding P record.
   * @param {string}  resultCategory - Derived from O record.
   * @param {string}  instrumentId   - From H record sender field.
   * @param {string}  rawMessage     - Full message for audit storage.
   * @returns {object|null} ParsedResult or null if unparseable.
   */
  _parseResultRecord(record, sampleId, patientName, patientDob, sex,
    resultCategory, instrumentId, rawMessage) {

    const fields = record.split(FIELD_DELIMITER);

    // --- Universal Test ID (field index 2): ^^^assay_code^^ ---
    // Components are caret-delimited. The assay code is always at component index 3.
    // Format examples:
    //   ^^^TSH^^       -> components: ['','','','TSH','','']
    //   ^^^FT4^FT4^    -> components: ['','','','FT4','FT4','']
    const testIdField  = fields[2] || '';
    const testIdParts  = testIdField.split(COMPONENT_DELIMITER);
    const assayCode    = (testIdParts[3] || '').trim().toUpperCase();
    const assayName    = (testIdParts[4] || testIdParts[3] || '').trim();

    if (!assayCode) {
      logger.warn('R record has empty assay code in Universal Test ID field', {
        testIdField,
        sampleId
      });
      return null;
    }

    // --- Measurement value (field index 3) ---
    const rawValue      = (fields[3] || '').trim();
    const numericValue  = this._parseNumericValue(rawValue);

    // --- Units (field index 4) ---
    const unit          = (fields[4] || '').trim();

    // --- Reference interval (field index 5) ---
    const referenceRange = (fields[5] || '').trim();

    // --- Abnormal flags (field index 6) ---
    const rawFlag    = (fields[6] || '').trim().toUpperCase();
    const flagMeaning = this._parseFlagMeaning(rawFlag);

    // --- Result status (field index 8) ---
    const resultStatus = (fields[8] || 'F').trim().toUpperCase();

    // --- Date/time completed (field index 12) ---
    const resultDateTime = (fields[12] || '').trim();

    // --- Instrument ID (field index 13, fallback to H record sender) ---
    const rInstrumentId = (fields[13] || instrumentId || '').trim();

    // --- Age derivation from DOB ---
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
   * Returns null for non-numeric values such as 'Reactive', 'Non-Reactive', '>250'.
   * Strips leading comparison operators (< >) before parsing.
   *
   * @param {string} rawValue
   * @returns {number|null}
   */
  _parseNumericValue(rawValue) {
    if (!rawValue) return null;

    // Strip comparison operators before numeric value, e.g. '>250' -> '250'
    const stripped = rawValue.replace(/^[<>]+/, '').trim();
    const parsed   = parseFloat(stripped);

    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Maps the ASTM abnormal flag to a human-readable string.
   * Returns null for no-flag cases (empty string or 'N').
   *
   * @param {string} flag
   * @returns {string|null}
   */
  _parseFlagMeaning(flag) {
    if (!flag || flag === 'N') return null;
    return FLAG_MEANINGS[flag] || flag;
  }

  /**
   * Derives ageYear and ageMonth from a DOB string (YYYYMMDD).
   * Returns null values if DOB is absent or unparseable.
   *
   * @param {string} dob - Date of birth in YYYYMMDD format.
   * @returns {{ ageYear: number|null, ageMonth: number|null }}
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
   *
   * @param {string} category - 'PATIENT' | 'QC' | 'CALIBRATION'
   * @returns {boolean}
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
module.exports = Access2Parser;
