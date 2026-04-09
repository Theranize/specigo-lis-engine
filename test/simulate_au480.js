/**
 * simulate_au480.js
 * SpeciGo LIS Integration Engine - AU480 Analyser Simulator
 *
 * Sends syntactically correct AU480 proprietary protocol messages over a
 * serial port to test the integration engine end-to-end without the physical
 * analyser present.
 *
 * SETUP REQUIRED BEFORE RUNNING:
 * ─────────────────────────────────────────────────────────────────────────────
 * Windows (Umesh at MMI):
 *   Install com0com (free null-modem emulator):
 *     https://sourceforge.net/projects/com0com/
 *   Create a virtual port pair, e.g. COM10 <-> COM11
 *   Set the integration engine to listen on COM10 (in au480_mmi.json).
 *   Run this simulator on COM11.
 *
 * Linux / CI (development):
 *   sudo apt-get install -y socat
 *   socat -d -d pty,raw,echo=0 pty,raw,echo=0
 *   Note the two /dev/pts/N paths printed and set them in --engine-port / --sim-port.
 *
 * USAGE:
 *   node test/simulate_au480.js [options]
 *
 * OPTIONS:
 *   --sim-port   <port>  Serial port this simulator writes to.  Default: COM11
 *   --barcode    <id>    Sample ID (barcode_uid) to embed in messages. Default: see below
 *   --delay      <ms>    Milliseconds between message blocks.    Default: 500
 *   --runs       <n>     Number of complete DB..DE sessions to send. Default: 1
 *   --scenario   <name>  Which test scenario to run (see SCENARIOS below). Default: standard
 *
 * SCENARIOS:
 *   standard   - 1 sample, 5 tests (GLU, ALT, AST, UREA, CRE), normal results
 *   flags      - 1 sample, 3 tests with H, ph, L flags
 *   stat       - 1 STAT sample using 'd ' distinction code
 *   multi      - 3 samples in one session
 *   overflow   - 1 sample with one 999999 overflow result
 *   zero       - 1 sample with one fully zero-suppressed result
 *
 * WHAT TO VERIFY AFTER RUNNING:
 *   1. The engine console shows [FRAMER] ACK sent for each message block.
 *   2. The engine console shows [AU480]  Result parsed for each test result.
 *   3. SELECT * FROM lis_integration_results WHERE sample_id = '<barcode>' shows rows.
 *   4. If the barcode exists in report_barcode: mapping_status = MAPPED, lims_write_status = WRITTEN.
 *   5. If the barcode does not exist: mapping_status = UNMAPPED, lims_write_status = SKIPPED.
 *      This is expected during simulator testing before real LIMS data is present.
 *
 * MESSAGE FORMAT REFERENCE (from foundation document Section 3):
 *   [STX] [2-char code] [rack 4] [cup 2] [type 1] [sample_no 4] [sample_id 13] [dummy 4]
 *   [data_class 1] [sex 1] [age_year 3] [age_month 2]
 *   [online_test_no 3] [result 6] [flag 2]  <- repeats per test
 *   [ETX]
 *
 * ACK/NAK listening:
 *   The simulator reads the ACK (0x06) or NAK (0x15) byte sent back by the
 *   engine after each message block and logs it. On NAK it retransmits once
 *   (matching the AU480 retry behaviour).
 */

'use strict';

require('dotenv').config();

const { SerialPort } = require('serialport');
const winston        = require('winston');
const path           = require('path');
const fs             = require('fs');

// ---------------------------------------------------------------------------
// Ensure logs directory exists
// ---------------------------------------------------------------------------
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [SIM]    [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [SIM]    ${level}: ${message}`
        )
      )
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'simulator.log'),
      maxsize : 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    })
  ]
});

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
const STX = 0x02;
const ETX = 0x03;
const ACK = 0x06;
const NAK = 0x15;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args    = process.argv.slice(2);
  const options = {
    simPort : 'COM11',
    barcode : '69D5DCF585189',   // example barcode_uid format from foundation doc
    delayMs : 500,
    runs    : 1,
    scenario: 'standard'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sim-port' : options.simPort  = args[++i]; break;
      case '--barcode'  : options.barcode  = args[++i]; break;
      case '--delay'    : options.delayMs  = parseInt(args[++i], 10); break;
      case '--runs'     : options.runs     = parseInt(args[++i], 10); break;
      case '--scenario' : options.scenario = args[++i]; break;
      default:
        logger.warn(`Unknown argument: ${args[i]}`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Message builder
// Building AU480 messages byte-by-byte following Section 3.3 of the
// foundation document exactly.
// ---------------------------------------------------------------------------

/**
 * Pads a string to an exact length.
 * Truncates if too long. Pads with spaces on the right if too short.
 * Used for all fixed-width ASCII fields in the AU480 protocol.
 *
 * @param {string} value
 * @param {number} length
 * @param {string} [padChar] - Default space (0x20)
 * @returns {string}
 */
function pad(value, length, padChar = ' ') {
  const str = String(value);
  if (str.length >= length) return str.substring(0, length);
  return str + padChar.repeat(length - str.length);
}

/**
 * Pads a number string on the LEFT with zeros to exact length.
 * Used for Rack No, Cup Position, Online Test No.
 *
 * @param {string|number} value
 * @param {number} length
 * @returns {string}
 */
function zeroPad(value, length) {
  return String(value).padStart(length, '0');
}

/**
 * Formats a numeric result value into the 6-char zero-suppressed format.
 * Zero Suppress ON: leading zeros become spaces.
 * e.g. 45.25 -> ' 45.25', 5.1 -> '   5.1', 0 -> '   .  '
 *
 * @param {number|null} value
 * @returns {string} Exactly 6 characters.
 */
function formatResult(value) {
  if (value === null || value === undefined) {
    // Fully suppressed (no result)
    return '   .  ';
  }

  if (value === 999999) {
    // Overflow sentinel
    return '999999';
  }

  // Format to 2 decimal places to match typical AU480 result precision,
  // then apply zero suppression (replace leading zeros with spaces).
  // The result field is always 6 chars. We place the decimal point correctly
  // and suppress leading zeros.
  let str = value.toFixed(2);

  // Ensure exactly 6 chars total (including decimal point)
  // AU480 result field format: up to 3 integer digits + decimal + 2 fractional = 6 chars
  // e.g. ' 45.25' for 45.25, '  5.10' for 5.1 -> ' 5.10' after suppression
  str = str.padStart(6, '0');

  // Zero suppression: replace leading '0' characters with spaces.
  // Do not suppress the character immediately before the decimal point
  // (units digit must be preserved even if it is 0).
  let suppressed = '';
  let suppressMode = true;
  for (let i = 0; i < str.length; i++) {
    const ch   = str[i];
    const next = str[i + 1];
    if (suppressMode && ch === '0' && next !== '.') {
      // Leading zero that is not the units digit - suppress
      suppressed += ' ';
    } else {
      suppressMode = false;
      suppressed  += ch;
    }
  }

  return suppressed.substring(0, 6);
}

/**
 * Builds a complete STX-framed AU480 message buffer.
 *
 * @param {object} params
 * @param {string} params.code        - 2-char distinction code e.g. 'D '
 * @param {string} params.rackNo      - 4-digit rack number string
 * @param {string} params.cupPosition - 2-digit cup position string
 * @param {string} params.sampleType  - 1 char: ' '=Serum U X W
 * @param {string} params.sampleNo    - 4-char sample number
 * @param {string} params.sampleId    - 13-char barcode_uid
 * @param {string} params.dataClassNo - 1 char: '0'-'9' or 'E'
 * @param {string} params.sex         - 1 char M/F/0/ 
 * @param {string} params.ageYear     - 3 chars
 * @param {string} params.ageMonth    - 2 chars
 * @param {Array}  params.results     - Array of { testNo, value, flag }
 * @returns {Buffer}
 */
function buildDataMessage(params) {
  const {
    code        = 'D ',
    rackNo      = '0001',
    cupPosition = '01',
    sampleType  = ' ',     // space = Serum
    sampleNo    = '0001',
    sampleId,
    dataClassNo = 'E',     // E = last (and only) block
    sex         = ' ',
    ageYear     = '   ',
    ageMonth    = '  ',
    results     = []
  } = params;

  // Build the body string
  // Fixed header
  let body = '';
  body += pad(code, 2);                   // [0-1]  distinction code
  body += zeroPad(rackNo, 4);             // [2-5]  rack no
  body += zeroPad(cupPosition, 2);        // [6-7]  cup position
  body += sampleType.charAt(0);           // [8]    sample type (space=serum)
  body += pad(sampleNo, 4);              // [9-12] sample no
  body += pad(sampleId, 13);             // [13-25] sample ID (13 chars at MMI)
  body += '    ';                          // [26-29] dummy (4 spaces)
  body += dataClassNo.charAt(0);          // [30]   data classification no

  // Variable section: demographics
  body += sex.charAt(0);                  // sex
  body += pad(ageYear, 3);               // age year
  body += pad(ageMonth, 2);              // age month

  // Variable section: result triplets
  for (const result of results) {
    body += zeroPad(result.testNo, 3);    // online test no (3 digits)
    body += formatResult(result.value);   // result value (6 chars, zero-suppressed)
    body += pad(result.flag || 'N ', 2); // data flag (2 chars)
  }

  // Frame: STX + body bytes + ETX
  const bodyBuffer = Buffer.from(body, 'ascii');
  const frame      = Buffer.allocUnsafe(bodyBuffer.length + 2);
  frame[0]         = STX;
  bodyBuffer.copy(frame, 1);
  frame[frame.length - 1] = ETX;

  return frame;
}

/**
 * Builds a session control message (DB or DE).
 * These have only the 2-char distinction code in the body.
 *
 * @param {string} code - 'DB' or 'DE'
 * @returns {Buffer}
 */
function buildSessionMessage(code) {
  const body   = Buffer.from(code, 'ascii');
  const frame  = Buffer.allocUnsafe(body.length + 2);
  frame[0]     = STX;
  body.copy(frame, 1);
  frame[frame.length - 1] = ETX;
  return frame;
}

// ---------------------------------------------------------------------------
// Test scenarios
// Each scenario returns an array of message descriptors.
// Each descriptor is either:
//   { type: 'session', code: 'DB' | 'DE' }
//   { type: 'data', params: {...} }
// ---------------------------------------------------------------------------
const SCENARIOS = {

  /**
   * Standard: 1 sample, 5 tests, all normal results.
   * Tests: GLU(021) ALT(011) AST(013) UREA(030) CRE(017)
   * All values within normal reference range.
   */
  standard: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code       : 'D ',
        rackNo     : '0001',
        cupPosition: '01',
        sampleType : ' ',
        sampleNo   : '0001',
        sampleId   : barcode,
        dataClassNo: 'E',
        sex        : 'M',
        ageYear    : '045',
        ageMonth   : '00',
        results    : [
          { testNo: '021', value: 95.20,  flag: 'N ' },   // Glucose
          { testNo: '011', value: 28.00,  flag: 'N ' },   // ALT
          { testNo: '013', value: 24.50,  flag: 'N ' },   // AST
          { testNo: '030', value: 32.10,  flag: 'N ' },   // Urea
          { testNo: '017', value: 0.90,   flag: 'N ' }    // Creatinine
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ],

  /**
   * Flags: 1 sample, 3 tests with pathological flags.
   * Demonstrates H, ph, L flag handling.
   */
  flags: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code       : 'D ',
        rackNo     : '0002',
        cupPosition: '01',
        sampleType : ' ',
        sampleNo   : '0002',
        sampleId   : barcode,
        dataClassNo: 'E',
        sex        : 'F',
        ageYear    : '062',
        ageMonth   : '06',
        results    : [
          { testNo: '021', value: 520.00, flag: 'ph' },   // Glucose CRITICAL HIGH
          { testNo: '030', value: 85.40,  flag: 'H ' },   // Urea HIGH
          { testNo: '009', value: 2.10,   flag: 'L ' }    // Albumin LOW
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ],

  /**
   * STAT: 1 STAT sample using 'd ' distinction code.
   * STAT samples use 'd ' code and P-prefixed sample numbers.
   */
  stat: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code       : 'd ',     // STAT quick output
        rackNo     : '0001',
        cupPosition: '01',
        sampleType : ' ',
        sampleNo   : 'P001',   // P prefix for STAT
        sampleId   : barcode,
        dataClassNo: 'E',
        sex        : ' ',
        ageYear    : '   ',
        ageMonth   : '  ',
        results    : [
          { testNo: '021', value: 210.50, flag: 'H ' },   // Glucose HIGH
          { testNo: '017', value: 1.20,   flag: 'N ' }    // Creatinine
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ],

  /**
   * Multi: 3 samples in one session.
   * Simulates a full rack run at the lab.
   */
  multi: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code: 'D ', rackNo: '0001', cupPosition: '01', sampleType: ' ',
        sampleNo: '0001', sampleId: barcode, dataClassNo: 'E',
        sex: 'M', ageYear: '045', ageMonth: '00',
        results: [
          { testNo: '021', value: 95.20,  flag: 'N ' },
          { testNo: '011', value: 28.00,  flag: 'N ' }
        ]
      }
    },
    {
      type  : 'data',
      params: {
        code: 'D ', rackNo: '0001', cupPosition: '02', sampleType: ' ',
        sampleNo: '0002', sampleId: '1A2B3C4D5E6F7', dataClassNo: 'E',
        sex: 'F', ageYear: '033', ageMonth: '03',
        results: [
          { testNo: '013', value: 42.00,  flag: 'H ' },
          { testNo: '026', value: 1.80,   flag: 'N ' }
        ]
      }
    },
    {
      type  : 'data',
      params: {
        code: 'D ', rackNo: '0001', cupPosition: '03', sampleType: 'U',
        sampleNo: '0003', sampleId: 'AABBCCDDEEFF0', dataClassNo: 'E',
        sex: ' ', ageYear: '   ', ageMonth: '  ',
        results: [
          { testNo: '031', value: 6.80,   flag: 'N ' }
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ],

  /**
   * Overflow: 1 sample with one result that exceeded the dynamic range.
   * The result value is 999999 (overflow sentinel).
   * The data flag will be 'F ' (Above Range).
   */
  overflow: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code: 'D ', rackNo: '0001', cupPosition: '01', sampleType: ' ',
        sampleNo: '0001', sampleId: barcode, dataClassNo: 'E',
        sex: 'M', ageYear: '028', ageMonth: '00',
        results: [
          { testNo: '015', value: 999999, flag: 'F ' },   // Cholesterol overflow
          { testNo: '022', value: 38.50,  flag: 'N ' }    // HDL normal
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ],

  /**
   * Zero: 1 sample with one fully zero-suppressed result.
   * Transmitted as '   .  ' - should parse to null numeric value.
   */
  zero: (barcode) => [
    { type: 'session', code: 'DB' },
    {
      type  : 'data',
      params: {
        code: 'D ', rackNo: '0001', cupPosition: '01', sampleType: ' ',
        sampleNo: '0001', sampleId: barcode, dataClassNo: 'E',
        sex: 'F', ageYear: '055', ageMonth: '00',
        results: [
          { testNo: '021', value: null,  flag: '  ' },   // No result / zero suppress
          { testNo: '013', value: 18.30, flag: 'N ' }
        ]
      }
    },
    { type: 'session', code: 'DE' }
  ]
};

// ---------------------------------------------------------------------------
// Serial port operations
// ---------------------------------------------------------------------------

/**
 * Opens a serial port for the simulator to write to.
 * Uses the same settings as the AU480 (9600 baud, 8N1, no flow control).
 *
 * @param {string} portPath - e.g. 'COM11' or '/dev/pts/3'
 * @returns {Promise<SerialPort>}
 */
async function openSimPort(portPath) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path    : portPath,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity  : 'none',
      rtscts  : false,
      xon     : false,
      xoff    : false,
      autoOpen: false
    });

    port.on('error', reject);

    port.open((err) => {
      if (err) return reject(err);
      logger.info('Simulator port opened', { port: portPath });
      resolve(port);
    });
  });
}

/**
 * Writes a buffer to the serial port.
 *
 * @param {SerialPort} port
 * @param {Buffer}     buffer
 * @returns {Promise<void>}
 */
async function writeToPort(port, buffer) {
  return new Promise((resolve, reject) => {
    port.write(buffer, (err) => {
      if (err) return reject(err);
      // drain() waits until all bytes have been physically transmitted.
      // Without drain, the next write might start before the OS has sent
      // all bytes of the previous one, which can cause framing errors.
      port.drain((drainErr) => {
        if (drainErr) return reject(drainErr);
        resolve();
      });
    });
  });
}

/**
 * Waits for a single ACK or NAK byte from the engine.
 * Times out after 3000 ms (the AU480 T.R.I. timeout is similar).
 *
 * @param {SerialPort} port
 * @returns {Promise<number>} - The received byte value (ACK=0x06, NAK=0x15).
 */
async function waitForResponse(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeListener('data', onData);
      reject(new Error('Timeout waiting for ACK/NAK from engine (3000 ms)'));
    }, 3000);

    function onData(chunk) {
      // We expect a single byte. If more bytes arrive (unlikely), take the first.
      clearTimeout(timeout);
      port.removeListener('data', onData);
      resolve(chunk[0]);
    }

    port.on('data', onData);
  });
}

/**
 * Sends a single framed message and waits for ACK/NAK.
 * Retransmits once on NAK, matching AU480 retry behaviour.
 *
 * @param {SerialPort} port
 * @param {Buffer}     messageBuffer
 * @param {string}     label - Human-readable label for logging.
 * @returns {Promise<boolean>} - true if ACK received, false if NAK or timeout.
 */
async function sendMessageWithAck(port, messageBuffer, label) {
  const MAX_RETRIES = 1;   // AU480 retry count is 3, we simulate 1 for simplicity

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      logger.warn(`Retransmitting ${label} (attempt ${attempt + 1})`);
    }

    logger.debug(`Sending ${label}`, {
      bytes: messageBuffer.length,
      hex  : messageBuffer.toString('hex').toUpperCase()
    });

    await writeToPort(port, messageBuffer);
    logger.info(`Sent: ${label}`, { bytes: messageBuffer.length });

    let response;
    try {
      response = await waitForResponse(port);
    } catch (err) {
      logger.error(`No response for ${label}`, { error: err.message });
      return false;
    }

    if (response === ACK) {
      logger.info(`ACK received for ${label}`);
      return true;
    } else if (response === NAK) {
      logger.warn(`NAK received for ${label} - will retry`);
      // Continue loop to retransmit
    } else {
      logger.warn(`Unexpected response byte for ${label}`, {
        received: response.toString(16).toUpperCase()
      });
      return false;
    }
  }

  logger.error(`${label} failed after ${MAX_RETRIES + 1} attempts`);
  return false;
}

/**
 * Sends a delay between messages.
 * The AU480 has inter-message timing. We replicate a realistic delay
 * so the engine's serial buffer does not receive back-to-back frames
 * faster than the real analyser would send them.
 *
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main simulator logic
// ---------------------------------------------------------------------------

async function runSimulator() {
  const opts = parseArgs();

  logger.info('AU480 Simulator starting', {
    simPort : opts.simPort,
    barcode : opts.barcode,
    delayMs : opts.delayMs,
    runs    : opts.runs,
    scenario: opts.scenario
  });

  // Validate scenario
  const scenarioFn = SCENARIOS[opts.scenario];
  if (!scenarioFn) {
    logger.error('Unknown scenario', {
      scenario: opts.scenario,
      available: Object.keys(SCENARIOS).join(', ')
    });
    process.exit(1);
  }

  // Open the simulator serial port
  let port;
  try {
    port = await openSimPort(opts.simPort);
  } catch (err) {
    logger.error('Failed to open simulator port', {
      port : opts.simPort,
      error: err.message,
      hint : 'On Windows, install com0com and create a virtual port pair (e.g. COM10 <-> COM11). '
           + 'On Linux, use socat to create a PTY pair.'
    });
    process.exit(1);
  }

  // Run for the specified number of sessions
  let totalSent = 0;
  let totalAcked = 0;

  for (let run = 1; run <= opts.runs; run++) {
    logger.info(`Starting session run ${run} of ${opts.runs}`);

    const messages = scenarioFn(opts.barcode);

    for (const msg of messages) {
      let buffer;
      let label;

      if (msg.type === 'session') {
        buffer = buildSessionMessage(msg.code);
        label  = `Session(${msg.code})`;
      } else if (msg.type === 'data') {
        buffer = buildDataMessage(msg.params);
        label  = `Data(${msg.params.code.trim()}|${msg.params.sampleId}|${msg.params.results.length} tests)`;
      } else {
        logger.warn('Unknown message type in scenario', { type: msg.type });
        continue;
      }

      totalSent++;
      const acked = await sendMessageWithAck(port, buffer, label);
      if (acked) totalAcked++;

      // Pause between messages to simulate analyser timing
      if (opts.delayMs > 0) {
        await delay(opts.delayMs);
      }
    }

    logger.info(`Session run ${run} complete`);

    // Pause between sessions if running multiple
    if (run < opts.runs) {
      await delay(opts.delayMs * 4);
    }
  }

  // Final summary
  logger.info('Simulation complete', {
    totalMessagesSent: totalSent,
    totalAcked       : totalAcked,
    totalNakedOrFailed: totalSent - totalAcked
  });

  logger.info('VERIFICATION STEPS:');
  logger.info('1. Check engine console for [FRAMER] ACK sent and [AU480] Result parsed messages.');
  logger.info(`2. Run in MySQL: SELECT * FROM lis_integration_results WHERE sample_id = '${opts.barcode}' ORDER BY received_at DESC LIMIT 20;`);
  logger.info('3. MAPPED + WRITTEN = barcode existed in LIMS and result was written.');
  logger.info('4. UNMAPPED + SKIPPED = barcode not in report_barcode (expected in test environment).');

  // Close the simulator port cleanly
  port.close((err) => {
    if (err) logger.error('Error closing simulator port', { error: err.message });
    else logger.info('Simulator port closed');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
runSimulator().catch((err) => {
  logger.error('Simulator crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
