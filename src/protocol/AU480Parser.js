/**
 * AU480Parser.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Parses complete frame buffers delivered by MessageFramer.js.
 * Implements the Beckman Coulter AU480/AU680 proprietary online protocol
 * as documented in "AU680/AU480 Online Specification v9 (Jan 2011)".
 *
 * This is NOT standard ASTM E1394. Do not replace with a generic ASTM parser.
 *
 * Confirmed configuration at MMI Diagnostics (08 April 2026):
 *   Rack No. digits       : 4
 *   Online Test No. digits: 3
 *   Result digits         : 6
 *   Data marks (flags)    : 2 types
 *   Zero Suppress         : ENABLED
 *   BCC Check             : DISABLED
 *   Rack No./Cup Position : ENABLED
 *   Type field            : ENABLED
 *   Dilution Info         : DISABLED
 *   Reagent Info          : DISABLED
 *   System No.            : DISABLED (0 chars)
 *
 * Message distinction codes handled:
 *   DB    -> Analysis data transmission START  (session open)
 *   D     -> Normal sample data               (patient result - primary target)
 *   DH    -> Repeat run data                  (patient result on rerun)
 *   d     -> STAT quick output                (patient result - STAT)
 *   DR    -> Reagent blank data               (filtered out per MMI config)
 *   DA    -> Calibration data                 (filtered out per MMI config)
 *   DQ    -> QC data                          (filtered out per MMI config)
 *   DE    -> Analysis data transmission END   (session close)
 *
 * Events emitted:
 *   'sessionStart'   -> ()
 *   'sessionEnd'     -> ()
 *   'result'         -> (ParsedResult)
 *   'filtered'       -> (code: string, reason: string)
 *   'parseError'     -> (err: Error, rawHex: string)
 *
 * ParsedResult object shape:
 * {
 *   messageCode    : string,   // 'D ', 'DH', 'd '
 *   rackNo         : string,   // '0001'
 *   cupPosition    : string,   // '01'
 *   sampleType     : string,   // 'S'=Serum 'U'=Urine 'X'=Other 'W'=WholeBlood
 *   sampleNo       : string,   // '0001' / 'E001' / 'P001'
 *   sampleId       : string,   // barcode_uid scanned at analyser (13 chars at MMI)
 *   sex            : string,   // 'M'/'F'/'0'/' '
 *   ageYear        : string,   // '000'-'150' or '   '
 *   ageMonth       : string,   // '00'-'11' or '  '
 *   onlineTestNo   : string,   // '009' etc - key for parameter lookup
 *   rawValue       : string,   // 6-char raw string as received (zero-suppressed)
 *   numericValue   : number|null, // parsed float or null if unparseable
 *   dataFlag       : string,   // 2-char flag e.g. 'H ', 'ph', '  '
 *   flagMeaning    : string,   // human-readable flag for param_remark
 *   resultCategory : string,   // 'PATIENT' / 'QC' / 'CALIBRATION' / 'REAGENT_BLANK'
 *   rawMessage     : string,   // full frame as hex string for audit
 * }
 */

'use strict';

const { EventEmitter } = require('events');
const winston          = require('winston');

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
      return `[${timestamp}] [AU480] [${level.toUpperCase()}] ${message}${metaStr}`;
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
          `[${timestamp}] [AU480] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Flag meaning map
// Maps the 2-char AU480 data flag to the human-readable string stored in
// report_test_values_data.param_remark. Defined in Section 9.2 of foundation doc.
// ---------------------------------------------------------------------------
const FLAG_MEANINGS = {
  'N ' : 'Normal',
  'H ' : 'High',
  'L ' : 'Low',
  'ph' : 'Critical High',
  'pl' : 'Critical Low',
  '# ' : 'Insufficient Sample',
  '% ' : 'Clot Detected',
  '? ' : 'Calculation Error',
  'F ' : 'Above Range',
  'G ' : 'Below Range',
  'R ' : 'Reagent Low',
  '  ' : null   // two spaces = no flag, store NULL in param_remark
};

// ---------------------------------------------------------------------------
// Message type classification
// ---------------------------------------------------------------------------
const MESSAGE_CATEGORIES = {
  'D ' : 'PATIENT',
  'DH' : 'PATIENT',
  'd ' : 'PATIENT',
  'DR' : 'REAGENT_BLANK',
  'DA' : 'CALIBRATION',
  'DQ' : 'QC'
};

// Session control codes - no data payload
const SESSION_CODES = new Set(['DB', 'DE']);

// ---------------------------------------------------------------------------
// Field offset constants derived from the AU480 message structure.
// Section 3.3 of the foundation document defines these precisely.
//
// Frame bytes as delivered by MessageFramer (STX and ETX already stripped):
//
// [0-1]   Distinction code       2 chars  e.g. "D " or "DH"
// [2-5]   Rack No.               4 digits (config: rackNoDigits = 4)
// [6-7]   Cup Position           2 digits
// [8]     Sample Type            1 char   Space=Serum U=Urine X=Other W=WholeBlood
// [9-12]  Sample No.             4 chars  0001-9999 / E001-E999 / P001-P999
// [13-?]  Sample ID              variable (13 chars at MMI for barcode_uid)
// [?-?]   Dummy                  4 chars  0x20 x4
// [?]     Data Classification No 1 char   0-9 for blocks, E for last block
// -- variable part starts --
// [?]     Sex                    1 char
// [?-?+2] Year Age               3 chars
// [?-?+1] Month Age              2 chars
// -- patient info fields (disabled at MMI) --
// [?-?+2] Online Test No.        3 digits (repeated per test result)
// [?-?+5] Analysis Data          6 digits (zero-suppressed)
// [?-?+1] Data Flag              2 chars
//
// IMPORTANT: Sample ID length is variable. At MMI it is always 13 chars
// (the barcode_uid). The dummy field (4 x 0x20) acts as the delimiter
// between Sample ID and the rest of the fixed header. We locate the dummy
// field to find where Sample ID ends.
// ---------------------------------------------------------------------------
const OFFSET_DISTINCTION    = 0;
const OFFSET_RACK_NO        = 2;
const OFFSET_CUP_POSITION   = 6;
const OFFSET_SAMPLE_TYPE    = 8;
const OFFSET_SAMPLE_NO      = 9;
const OFFSET_SAMPLE_ID_START = 13;
const DUMMY_MARKER          = '    ';   // 4 spaces that follow Sample ID
const DATA_CLASS_FIELD_LEN  = 1;
const SEX_FIELD_LEN         = 1;
const AGE_YEAR_LEN          = 3;
const AGE_MONTH_LEN         = 2;
const ONLINE_TEST_NO_LEN    = 3;
const RESULT_VALUE_LEN      = 6;
const DATA_FLAG_LEN         = 2;

// ---------------------------------------------------------------------------
// AU480Parser class
// ---------------------------------------------------------------------------
class AU480Parser extends EventEmitter {

  /**
   * @param {object} options
   * @param {object} options.messageFilters - Which message categories to process.
   *   { patient_results: true, stat_results: true, qc_results: false,
   *     calibration_results: false, reagent_blank: false }
   * @param {number} [options.sampleIdLength] - Expected Sample ID length. 13 at MMI.
   *   If 0 or undefined, parser uses the dummy-marker search strategy.
   * @param {string} [options.analyzerUid]
   * @param {string} [options.labUid]
   */
  constructor(options = {}) {
    super();

    this._filters = {
      patient_results     : options.messageFilters?.patient_results     !== false,
      stat_results        : options.messageFilters?.stat_results        !== false,
      qc_results          : options.messageFilters?.qc_results          === true,
      calibration_results : options.messageFilters?.calibration_results === true,
      reagent_blank       : options.messageFilters?.reagent_blank       === true
    };

    // At MMI the Sample ID is always 13 chars (barcode_uid).
    // Storing it explicitly avoids the dummy-marker search for known-length deployments.
    this._sampleIdLength = options.sampleIdLength || 13;

    this._analyzerUid = options.analyzerUid || 'unknown';
    this._labUid      = options.labUid      || 'unknown';

    this.stats = {
      framesReceived  : 0,
      resultsEmitted  : 0,
      framesFiltered  : 0,
      parseErrors     : 0,
      sessionsStarted : 0,
      sessionsEnded   : 0
    };

    logger.info('AU480Parser initialised', {
      sampleIdLength: this._sampleIdLength,
      filters       : this._filters,
      analyzerUid   : this._analyzerUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse a complete frame buffer from MessageFramer.
   * Called via: framer.on('frame', (buf) => parser.parse(buf))
   *
   * @param {Buffer} frameBuffer - Complete message body, STX/ETX stripped.
   */
  parse(frameBuffer) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length < 2) {
      const err = new Error(`Invalid frame buffer: length ${frameBuffer?.length}`);
      logger.error(err.message);
      this.stats.parseErrors++;
      this.emit('parseError', err, '');
      return;
    }

    this.stats.framesReceived++;
    const rawHex = frameBuffer.toString('hex').toUpperCase();

    // Convert to ASCII string for field extraction.
    // The AU480 sends ASCII text only in message bodies (values, IDs, codes).
    const frameStr = frameBuffer.toString('ascii');

    // Extract 2-char distinction code
    const code = frameStr.substring(OFFSET_DISTINCTION, OFFSET_DISTINCTION + 2);

    logger.debug('Parsing frame', {
      code   : code,
      length : frameBuffer.length,
      hex    : rawHex
    });

    // Handle session control codes first - they carry no data payload
    if (SESSION_CODES.has(code)) {
      this._handleSessionCode(code);
      return;
    }

    // Determine result category from the distinction code
    const category = MESSAGE_CATEGORIES[code];

    if (!category) {
      // Unknown distinction code - log and skip without error
      // Future protocol extensions may add new codes; we should not crash on them.
      logger.warn('Unknown distinction code - frame skipped', {
        code  : code,
        rawHex: rawHex
      });
      this.stats.framesFiltered++;
      this.emit('filtered', code, 'unknown distinction code');
      return;
    }

    // Apply message filters per MMI config (patient_results only for now)
    if (!this._isCategoryEnabled(code, category)) {
      logger.debug('Frame filtered by message filter config', {
        code    : code,
        category: category
      });
      this.stats.framesFiltered++;
      this.emit('filtered', code, `category ${category} disabled in config`);
      return;
    }

    // Parse the data payload
    try {
      const results = this._parseDataFrame(frameStr, code, category, rawHex);
      for (const result of results) {
        this.stats.resultsEmitted++;
        logger.info('Result parsed', {
          sampleId    : result.sampleId,
          onlineTestNo: result.onlineTestNo,
          rawValue    : result.rawValue,
          numericValue: result.numericValue,
          dataFlag    : result.dataFlag,
          flagMeaning : result.flagMeaning
        });
        this.emit('result', result);
      }
    } catch (err) {
      this.stats.parseErrors++;
      logger.error('Frame parse error', {
        code   : code,
        rawHex : rawHex,
        error  : err.message,
        stack  : err.stack
      });
      this.emit('parseError', err, rawHex);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - session control
  // ---------------------------------------------------------------------------

  _handleSessionCode(code) {
    if (code === 'DB') {
      this.stats.sessionsStarted++;
      logger.info('Analysis data transmission START (DB) received');
      this.emit('sessionStart');
    } else if (code === 'DE') {
      this.stats.sessionsEnded++;
      logger.info('Analysis data transmission END (DE) received');
      this.emit('sessionEnd');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - filter check
  // ---------------------------------------------------------------------------

  _isCategoryEnabled(code, category) {
    if (category === 'PATIENT') {
      // STAT samples use code 'd ' - governed by stat_results filter
      if (code === 'd ') return this._filters.stat_results;
      return this._filters.patient_results;
    }
    if (category === 'QC')             return this._filters.qc_results;
    if (category === 'CALIBRATION')    return this._filters.calibration_results;
    if (category === 'REAGENT_BLANK')  return this._filters.reagent_blank;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Internal - data frame parser
  // ---------------------------------------------------------------------------

  /**
   * Parses one D-type message frame into one or more ParsedResult objects.
   *
   * The AU480 can pack MULTIPLE test results into a single D-space message
   * (one per online test number, repeating the [testNo + value + flag] triplet).
   * This method extracts the fixed header once, then iterates the variable
   * section to collect every result triplet in the frame.
   *
   * @param {string} frameStr  - ASCII string of the frame body.
   * @param {string} code      - 2-char distinction code.
   * @param {string} category  - 'PATIENT' / 'QC' / 'CALIBRATION' / 'REAGENT_BLANK'
   * @param {string} rawHex    - Hex representation for audit storage.
   * @returns {ParsedResult[]}
   */
  _parseDataFrame(frameStr, code, category, rawHex) {

    // --- Fixed header fields ---

    const rackNo      = frameStr.substring(OFFSET_RACK_NO,      OFFSET_RACK_NO + 4).trim();
    const cupPosition = frameStr.substring(OFFSET_CUP_POSITION, OFFSET_CUP_POSITION + 2).trim();
    const sampleType  = this._parseSampleType(frameStr.charAt(OFFSET_SAMPLE_TYPE));
    const sampleNo    = frameStr.substring(OFFSET_SAMPLE_NO, OFFSET_SAMPLE_NO + 4).trim();

    // --- Sample ID extraction ---
    // At MMI, Sample ID is always 13 chars (barcode_uid).
    // We use the known length when available. Fallback searches for the 4-space
    // dummy marker to find the ID boundary for non-MMI deployments.
    let sampleId;
    let postIdOffset;  // offset of the first char AFTER the dummy field

    if (this._sampleIdLength > 0) {
      sampleId     = frameStr.substring(OFFSET_SAMPLE_ID_START, OFFSET_SAMPLE_ID_START + this._sampleIdLength).trim();
      postIdOffset = OFFSET_SAMPLE_ID_START + this._sampleIdLength + DUMMY_MARKER.length;
    } else {
      const dummyIdx = frameStr.indexOf(DUMMY_MARKER, OFFSET_SAMPLE_ID_START);
      if (dummyIdx === -1) {
        throw new Error('Cannot locate dummy marker (4 spaces) in frame - Sample ID boundary unknown');
      }
      sampleId     = frameStr.substring(OFFSET_SAMPLE_ID_START, dummyIdx).trim();
      postIdOffset = dummyIdx + DUMMY_MARKER.length;
    }

    if (!sampleId) {
      throw new Error('Sample ID is empty in frame - barcode not scanned or not transmitted');
    }

    // --- Data Classification No. ---
    // 1 char: 0-9 for intermediate blocks, 'E' for the last block in a multi-block message.
    // We do not need to act on this for unidirectional patient results but we consume it.
    const dataClassNo  = frameStr.charAt(postIdOffset);
    let   variableStart = postIdOffset + DATA_CLASS_FIELD_LEN;

    // --- Variable section: Sex and Age ---
    const sex      = frameStr.charAt(variableStart);
    const ageYear  = frameStr.substring(variableStart + SEX_FIELD_LEN, variableStart + SEX_FIELD_LEN + AGE_YEAR_LEN);
    const ageMonth = frameStr.substring(
      variableStart + SEX_FIELD_LEN + AGE_YEAR_LEN,
      variableStart + SEX_FIELD_LEN + AGE_YEAR_LEN + AGE_MONTH_LEN
    );

    // Advance past the demographic fields
    // Patient Info fields 1-6 are DISABLED at MMI so we skip them entirely.
    let cursor = variableStart + SEX_FIELD_LEN + AGE_YEAR_LEN + AGE_MONTH_LEN;

    // --- Variable section: Result triplets ---
    // Each triplet = [Online Test No. (3)] + [Result Value (6)] + [Data Flag (2)]
    // Triplets repeat until the frame string is exhausted.
    // Total triplet size = 3 + 6 + 2 = 11 chars.
    const TRIPLET_LEN = ONLINE_TEST_NO_LEN + RESULT_VALUE_LEN + DATA_FLAG_LEN;  // 11

    const results = [];

    while (cursor + TRIPLET_LEN <= frameStr.length) {
      const onlineTestNo = frameStr.substring(cursor, cursor + ONLINE_TEST_NO_LEN);
      const rawValue     = frameStr.substring(cursor + ONLINE_TEST_NO_LEN, cursor + ONLINE_TEST_NO_LEN + RESULT_VALUE_LEN);
      const dataFlag     = frameStr.substring(cursor + ONLINE_TEST_NO_LEN + RESULT_VALUE_LEN, cursor + TRIPLET_LEN);

      cursor += TRIPLET_LEN;

      // Validate online test number is 3 digits
      if (!/^\d{3}$/.test(onlineTestNo)) {
        logger.warn('Non-numeric online test number encountered - skipping triplet', {
          onlineTestNo: onlineTestNo,
          sampleId    : sampleId,
          cursor      : cursor
        });
        continue;
      }

      const numericValue = this._parseResultValue(rawValue);
      const flagMeaning  = this._parseFlagMeaning(dataFlag);

      results.push({
        messageCode   : code,
        rackNo        : rackNo,
        cupPosition   : cupPosition,
        sampleType    : sampleType,
        sampleNo      : sampleNo,
        sampleId      : sampleId,
        sex           : sex.trim(),
        ageYear       : ageYear.trim(),
        ageMonth      : ageMonth.trim(),
        onlineTestNo  : onlineTestNo,
        rawValue      : rawValue,
        numericValue  : numericValue,
        dataFlag      : dataFlag,
        flagMeaning   : flagMeaning,
        resultCategory: category,
        rawMessage    : rawHex
      });
    }

    if (results.length === 0) {
      throw new Error(`No valid result triplets found in frame for sample ${sampleId}`);
    }

    logger.debug('Data frame parsed', {
      sampleId   : sampleId,
      code       : code,
      resultCount: results.length
    });

    return results;
  }

  // ---------------------------------------------------------------------------
  // Internal - field parsers
  // ---------------------------------------------------------------------------

  /**
   * Maps the 1-char Sample Type field to a readable string.
   * Space (0x20) means Serum - the AU480 default at MMI.
   *
   * @param {string} char - Single character from frame.
   * @returns {string}
   */
  _parseSampleType(char) {
    const map = {
      ' ' : 'S',   // Serum (default, space in protocol)
      'U' : 'U',   // Urine
      'X' : 'X',   // Other
      'W' : 'W',   // Whole Blood
      'Y' : 'Y'    // Other 2 (Y defined in spec but rare)
    };
    return map[char] || 'S';
  }

  /**
   * Parses the 6-char zero-suppressed result value into a float.
   *
   * Zero Suppress is ENABLED at MMI. Leading zeros are replaced by spaces (0x20).
   * Examples from Section 3.4 of the foundation document:
   *   ' 45.25' -> 45.25
   *   '   .  ' -> null  (fully suppressed = no result / zero)
   *   '999999' -> null  with overflow flag logged (above measurement range)
   *   ' 1.234' -> 1.234
   *
   * @param {string} raw - 6-char string exactly.
   * @returns {number|null}
   */
  _parseResultValue(raw) {
    if (raw.length !== RESULT_VALUE_LEN) {
      logger.warn('Unexpected result value length', {
        expected: RESULT_VALUE_LEN,
        actual  : raw.length,
        raw     : raw
      });
      return null;
    }

    // Overflow indicator - all 9s means above dynamic range
    if (raw === '999999') {
      logger.warn('Result value is overflow (999999) - above measurement range');
      return null;
    }

    // Trim spaces introduced by Zero Suppress
    const trimmed = raw.trim();

    // Fully suppressed = no meaningful result (typically 0.00 reported as '   .  ')
    if (!trimmed || trimmed === '.') {
      return null;
    }

    const parsed = parseFloat(trimmed);

    if (isNaN(parsed)) {
      logger.warn('Result value could not be parsed as float', { raw: raw, trimmed: trimmed });
      return null;
    }

    return parsed;
  }

  /**
   * Maps a 2-char AU480 data flag to its human-readable meaning.
   * Returns null for no-flag (two spaces) to store NULL in param_remark.
   *
   * Flags not in the map are returned as-is with a warning logged.
   *
   * @param {string} flag - 2-char string.
   * @returns {string|null}
   */
  _parseFlagMeaning(flag) {
    if (flag in FLAG_MEANINGS) {
      return FLAG_MEANINGS[flag];
    }

    // Unknown flag - log and pass through the raw code so it is visible in the LIMS
    logger.warn('Unknown data flag encountered', { flag: flag });
    return `Flag:${flag.trim()}`;
  }

  /**
   * Returns a snapshot of parser statistics.
   */
  getStats() {
    return { ...this.stats };
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = AU480Parser;
