/**
 * BS230Parser.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Parses complete ASTM E1394 / LIS2-A2 messages delivered by ASTMFramer.js
 * for the Mindray BS-230 chemistry analyser.
 *
 * The BS-230 follows the Mindray Chemistry Analyzer Host Interface Manual
 * V1.0 (2014-03), section 2.2.3. Mindray's R record layout differs from the
 * Beckman/standard ASTM layout in field offsets, so this parser auto-
 * detects which dialect is in use:
 *
 *   Mindray native (per Host Interface Manual §2.2.3):
 *     R|seq|AssayNo^AssayName^Replicate^F|value^|unit||low^high|flag||F|||startTs|endTs|BS-XXX^123
 *           ^---field[2]: channel code at component[0]
 *                                                    ^---field[3]: value (split on ^)
 *                                                            ^---field[4]: unit
 *                                                                    ^---field[6]: reference range
 *                                                                            ^---field[7]: abnormal flag
 *                                                                                  ^---field[9]: result status
 *                                                                                                  ^---field[13]: completed timestamp
 *                                                                                                          ^---field[14]: instrument id
 *
 *   Standard ASTM E1394 (Beckman / older simulator):
 *     R|seq|^^^channel^^|value|unit|low^high|flag||F|||startTs|completedTs|instrument
 *           ^---channel at component[3]
 *
 * The detection picks Mindray when component[0] of the test-ID field is
 * non-empty AND maps to a known parameter; otherwise falls back to standard
 * ASTM offsets. This way both real-analyser output and existing simulator
 * fixtures parse correctly.
 *
 * Channel codes ("Channel No." per BS-230 Operator's Manual §8.6.3) are
 * operator-assigned alphanumeric mnemonics (e.g. 'Glu-G', 'T-bil-D II') and
 * must match keys in parameter_map.
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
      processingId   : '',     // PR/QR/CR/RQ/QA/SA from H record field 11
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
            processingId   : '',
            sampleId       : '',
            patientName    : '',
            patientDob     : '',
            sex            : '',
            resultCategory : 'PATIENT'
          };
          this._pendingResults = [];
          this._parseHeaderRecord(record, (ctx) => {
            this._session.headerSender   = ctx.sender;
            this._session.processingId   = ctx.processingId;
            this._session.resultCategory = this._categoryFromProcessingId(ctx.processingId);
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
            this._session.sampleId = ctx.sampleId;
            // Result category was set from H record's Processing ID. Only
            // fall back to the sample-ID prefix heuristic when H gave us no
            // signal (analyser shouldn't happen but defensive parsers help).
            if (!this._session.processingId && ctx.resultCategoryHint) {
              this._session.resultCategory = ctx.resultCategoryHint;
            }
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
   * Parses the H (Header) record per Mindray Host Interface Manual §2.2.3.
   *
   *   H|\^&|||BS-XXX^01.03.07.03^123456|||||||PR|1394-97|20090910102501
   *      [1]      [4]                       [11] [12]    [13]
   *
   * Field index 4: Sender = Instrument^Version^Serial
   * Field index 11: Processing ID — message type, the authoritative source
   *                 for resultCategory:
   *                   PR = patient result
   *                   QR = QC result
   *                   CR = calibration result
   *                   RQ = request query (analyser asking LIS for samples)
   *                   QA = query response
   *                   SA = sample request info (LIS sending samples to analyser)
   *
   * @param {string}   record   - Full H record line.
   * @param {Function} callback - Receives { sender, processingId }.
   */
  _parseHeaderRecord(record, callback) {
    const fields       = record.split(FIELD_DELIMITER);
    const senderField  = fields[4]  || '';
    const senderParts  = senderField.split(COMPONENT_DELIMITER);
    const sender       = senderParts[0] || '';
    const processingId = (fields[11] || '').trim().toUpperCase();

    logger.debug('H record parsed', { sender, processingId });
    callback({ sender, processingId });
  }

  /**
   * Maps the H record's Processing ID to a resultCategory.
   * Falls back to 'PATIENT' for unknown / empty values.
   */
  _categoryFromProcessingId(processingId) {
    switch (processingId) {
      case 'PR': return 'PATIENT';
      case 'QR': return 'QC';
      case 'CR': return 'CALIBRATION';
      case 'SA':
      case 'QA':
      case 'RQ': return 'PATIENT'; // analyser-side queries; we ignore but treat the carrier sample as patient context
      default  : return 'PATIENT';
    }
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
   * Parses the O (Order) record per Mindray Host Interface Manual §2.2.3.
   *
   *   O|1|1^1^1|SAMPLE123|1^Test1^2^1\2^Test2^2^1|R|...
   *      [1] [2]      [3]        [4]                 [5]
   *
   * [0] O
   * [1] Sequence number
   * [2] Sample ID ^ Tray No ^ Position (analyser-internal)
   * [3] Instrument Specimen ID — the SAMPLE BAR CODE (primary identifier)
   * [4] Universal Test ID list (TestNo^Name^Dilution^Repeat, multiple via \)
   * [5] Priority (R=routine, S=STAT)
   *
   * Mindray's preferred sample identifier is field[3] (the bar code); some
   * firmware variants and the older simulator put a flat ID in field[2]'s
   * first component instead. We prefer field[3] and fall back to field[2]
   * component[0] when field[3] is empty.
   *
   * @param {string}   record   - Full O record line.
   * @param {Function} callback - Receives { sampleId, resultCategoryHint }.
   */
  _parseOrderRecord(record, callback) {
    const fields = record.split(FIELD_DELIMITER);

    const barcode      = (fields[3] || '').trim();
    const internalParts = (fields[2] || '').split(COMPONENT_DELIMITER);
    const internalId   = (internalParts[0] || '').trim();
    const sampleId     = barcode || internalId;

    // Heuristic fallback used only when H record didn't carry a Processing ID.
    // Mindray's QC and calibration samples typically come with H processingId
    // = QR / CR; this is just a safety net for non-conforming firmware.
    let resultCategoryHint = null;
    const upper = sampleId.toUpperCase();
    if (upper.startsWith('QC'))       resultCategoryHint = 'QC';
    else if (upper.startsWith('CAL')) resultCategoryHint = 'CALIBRATION';

    if (!sampleId) {
      logger.warn('O record has empty Specimen ID and Sample ID fields', {
        record: record.substring(0, 80)
      });
    }

    logger.debug('O record parsed', { sampleId, source: barcode ? 'barcode(field3)' : 'internalId(field2)', resultCategoryHint });
    callback({ sampleId, resultCategoryHint });
  }

  /**
   * Parses an R (Result) record per Mindray Host Interface Manual §2.2.3.
   *
   * Mindray native layout (real BS-230 over TCP/IP):
   *
   *   R|1|1^Test1^1^F|14.5^|Mg/ml||5.6^99.9|N||F|||20090910134300|20090910135300|BS-XXX^123
   *      [1] [2]        [3]    [4]     [6]     [7] [8] [9]    [12]            [13]            [14]
   *
   *   [0]  R
   *   [1]  Sequence number
   *   [2]  AssayNo ^ AssayName ^ Replicate ^ ResultType    (channel = component[0])
   *   [3]  Measurement value (sub-components for interpretation/SI L/H/I separated by ^)
   *   [4]  Units
   *   [5]  (empty / SI L value reserved)
   *   [6]  Reference range  Lower ^ Upper
   *   [7]  Abnormal flag    (L / H / N / HH / LL / A / < / >)
   *   [8]  Nature of abnormality test
   *   [9]  Result status    (F=final, P=preliminary, C=correction, X=cannot be done)
   *   [10] Original measurement value (for rerun)
   *   [11] Operator ID / rerun flag
   *   [12] Test start time
   *   [13] Test completed time (YYYYMMDDHHMMSS)  ← prefer this
   *   [14] Instrument identification (e.g. BS-XXX^serial)
   *
   * Mindray name-only layout (observed on real on-site BS-230, 2026-05-08):
   *
   *   R|78|^Aspartate Aminotransferase^^F|112.51^^^^|U/L|^|N||F|112.51^^^^|0|20260507120326||Mindry^
   *       [1] [2]                          [3]       [4] [5][6] [8] [9]      [10][11]        [13]
   *
   *   Same component[1]=name layout as Mindray native, BUT field positions
   *   match Standard ASTM (range@[5], flag@[6], status@[8], datetime@[11]).
   *   component[0] is empty; the chemistry identifier is the full English
   *   name in component[1]. The simulator fixture and the real device do
   *   NOT use the same offsets — both must be supported.
   *
   * Standard ASTM E1394 / Beckman layout (older simulator fixtures):
   *
   *   R|1|^^^GLU^^|92|mg/dL|70-110|N||F|||...|20260507120000|BS-230
   *      [1]   [3]   [4]   [5]   [6]  [8]                [13]
   *
   *   Channel at component[3] of field[2]; value at field[3] (no double pipe);
   *   range at field[5]; flag at field[6]; status at field[8]; instrument at [13].
   *
   * Detection priority:
   *   1. component[0] non-empty  → mindray-channel (assay# present).
   *   2. component[1] non-empty  → mindray-name    (real BS-230 firmware).
   *   3. component[3] non-empty  → standard-astm   (Beckman / generic).
   *
   * @returns {object|null} ParsedResult or null if unparseable.
   */
  _parseResultRecord(record, sampleId, patientName, patientDob, sex,
    resultCategory, instrumentId, rawMessage) {

    const fields = record.split(FIELD_DELIMITER);

    // --- Universal Test ID (field[2]) ---
    const testIdField = fields[2] || '';
    const testIdParts = testIdField.split(COMPONENT_DELIMITER);
    const mindrayAssayNo  = (testIdParts[0] || '').trim();
    const mindrayAssayName = (testIdParts[1] || '').trim();
    const standardChannel = (testIdParts[3] || '').trim();

    let layout, channelCode, assayName;

    if (mindrayAssayNo.length > 0) {
      // Mindray simulator-style: assay# at [0], name at [1]
      layout      = 'mindray-channel';
      channelCode = mindrayAssayNo;
      assayName   = mindrayAssayName || mindrayAssayNo;
    } else if (mindrayAssayName.length > 0) {
      // Real BS-230 firmware: full chemistry name at [1], [0] empty
      layout      = 'mindray-name';
      channelCode = mindrayAssayName;
      assayName   = mindrayAssayName;
    } else if (standardChannel.length > 0) {
      // Standard ASTM / Beckman: code at [3], name at [4]
      layout      = 'standard-astm';
      channelCode = standardChannel;
      assayName   = (testIdParts[4] || standardChannel).trim();
    } else {
      logger.warn('R record has empty Universal Test ID field', {
        testIdField,
        sampleId
      });
      return null;
    }

    const assayCode = channelCode.toUpperCase();

    let rawValue, unit, referenceRange, rawFlag, resultStatus, resultDateTime, rInstrumentId;

    if (layout === 'mindray-channel') {
      // Simulator-style Mindray: shifted offsets (range@[6], flag@[7], status@[9],
      // datetime@[13]||[12], instrument@[14]).
      rawValue       = ((fields[3] || '').split(COMPONENT_DELIMITER)[0] || '').trim();
      unit           = (fields[4]  || '').trim();
      referenceRange = (fields[6]  || '').trim();
      rawFlag        = (fields[7]  || '').trim().toUpperCase();
      resultStatus   = (fields[9]  || 'F').trim().toUpperCase();
      resultDateTime = ((fields[13] || fields[12]) || '').trim();
      rInstrumentId  = ((fields[14] || '').split(COMPONENT_DELIMITER)[0] || instrumentId || '').trim();
    } else if (layout === 'mindray-name') {
      // Real BS-230 firmware: standard-ASTM offsets, but value field still
      // carries trailing ^-delimited interpretation components that must
      // be stripped before parseFloat. Datetime falls back to test-start
      // ([11]) when test-completed ([12]) is empty (the firmware leaves
      // [12] blank and writes only [11]).
      rawValue       = ((fields[3] || '').split(COMPONENT_DELIMITER)[0] || '').trim();
      unit           = (fields[4]  || '').trim();
      referenceRange = (fields[5]  || '').trim();
      if (referenceRange === '^') referenceRange = '';
      rawFlag        = (fields[6]  || '').trim().toUpperCase();
      resultStatus   = (fields[8]  || 'F').trim().toUpperCase();
      resultDateTime = ((fields[12] || fields[11]) || '').trim();
      rInstrumentId  = ((fields[13] || '').split(COMPONENT_DELIMITER)[0] || instrumentId || '').trim();
    } else {
      // Standard ASTM / Beckman: value at [3], unit at [4], range at [5],
      // flag at [6], status at [8], completed at [12], instrument at [13].
      rawValue       = (fields[3]  || '').trim();
      unit           = (fields[4]  || '').trim();
      referenceRange = (fields[5]  || '').trim();
      rawFlag        = (fields[6]  || '').trim().toUpperCase();
      resultStatus   = (fields[8]  || 'F').trim().toUpperCase();
      resultDateTime = (fields[12] || '').trim();
      rInstrumentId  = (fields[13] || instrumentId || '').trim();
    }

    const numericValue = this._parseNumericValue(rawValue);
    const flagMeaning  = this._parseFlagMeaning(rawFlag);
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
      layout,
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
