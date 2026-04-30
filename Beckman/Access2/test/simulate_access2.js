/**
 * simulate_access2.js
 * SpeciGo LIS Integration Engine - Access 2 ASTM E1394 Protocol Simulator
 *
 * Simulates a Beckman Coulter Access 2 analyser transmitting immunoassay results
 * to the LIS engine via a virtual serial port pair.
 *
 * Usage:
 *   node test/simulate_access2.js
 *   node test/simulate_access2.js --port COM3
 *   node test/simulate_access2.js --port /dev/pts/1
 *
 * Prerequisites (Windows):
 *   Use com0com or a similar virtual serial port utility to create a connected
 *   pair, e.g. COM3 <-> COM4. Run the engine on COM4 and this simulator on COM3.
 *
 * Prerequisites (Linux):
 *   Use socat to create a virtual pair:
 *     socat -d -d pty,raw,echo=0 pty,raw,echo=0
 *   This prints two device paths like /dev/pts/1 and /dev/pts/2.
 *   Run engine on /dev/pts/2 and simulator on /dev/pts/1.
 *
 * What this simulator transmits:
 *   A complete ASTM E1394 session for two patient samples, each with
 *   multiple immunoassay results (TSH, FT4, FT3, LH, FSH).
 *
 * Protocol sequence transmitted:
 *   ENQ
 *   ACK <- (wait)
 *   STX 1 <H record> ETX CS CR LF
 *   ACK <- (wait)
 *   STX 2 <P record> ETX CS CR LF
 *   ACK <- (wait)
 *   STX 3 <O record> ETX CS CR LF
 *   ACK <- (wait)
 *   STX 4 <R record TSH> ETX CS CR LF
 *   ACK <- (wait)
 *   STX 5 <R record FT4> ETX CS CR LF
 *   ACK <- (wait)
 *   ... (more R records)
 *   STX N <L record> ETX CS CR LF
 *   ACK <- (wait)
 *   EOT
 *   (repeat for second sample)
 */

'use strict';

const { SerialPort } = require('serialport');
const path           = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// const DEFAULT_PORT = 'COM3';
const DEFAULT_PORT = '/dev/ttyV1';

function parsePortArg() {
  const args  = process.argv.slice(2);
  const index = args.indexOf('--port');
  return (index !== -1 && args[index + 1]) ? args[index + 1] : DEFAULT_PORT;
}

const SIMULATOR_PORT = parsePortArg();

// ASTM protocol control bytes
const ENQ = Buffer.from([0x05]);
const EOT = Buffer.from([0x04]);
const ACK = 0x06;
const NAK = 0x15;
const STX = 0x02;
const ETX = 0x03;
const CR  = 0x0D;
const LF  = 0x0A;

// ---------------------------------------------------------------------------
// ASTM checksum calculation
// ---------------------------------------------------------------------------

/**
 * Computes the 2-character hex ASTM checksum.
 *
 * @param {string} frameNo   - ASCII digit '1'-'7'.
 * @param {string} frameText - Frame body text.
 * @param {number} terminator - ETX (0x03) or ETB (0x17).
 * @returns {string} 2-character uppercase hex string.
 */
function computeChecksum(frameNo, frameText, terminator) {
  let sum = frameNo.charCodeAt(0);
  for (let i = 0; i < frameText.length; i++) {
    sum += frameText.charCodeAt(i);
  }
  sum += terminator;
  return (sum % 256).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Builds a complete ASTM frame buffer.
 *
 * @param {string} frameNo   - '1'-'7'.
 * @param {string} frameText - ASTM record text.
 * @param {boolean} isLast   - true = ETX (final frame), false = ETB (intermediate).
 * @returns {Buffer}
 */
function buildFrame(frameNo, frameText, isLast = true) {
  const terminator = isLast ? ETX : 0x17;
  const checksum   = computeChecksum(frameNo, frameText, terminator);

  const bytes = [];
  bytes.push(STX);
  bytes.push(frameNo.charCodeAt(0));
  for (let i = 0; i < frameText.length; i++) {
    bytes.push(frameText.charCodeAt(i));
  }
  bytes.push(terminator);
  bytes.push(checksum.charCodeAt(0));
  bytes.push(checksum.charCodeAt(1));
  bytes.push(CR);
  bytes.push(LF);

  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

/**
 * Returns the current date/time formatted as YYYYMMDDHHMMSS.
 */
function nowAstm() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const NOW = nowAstm();

/**
 * Builds an ASTM message (array of record strings) for one patient sample.
 *
 * @param {object} sample
 * @param {string} sample.sampleId    - Barcode UID (13 chars for SpeciGo)
 * @param {string} sample.patientName - Format: LastName^FirstName
 * @param {string} sample.dob         - YYYYMMDD
 * @param {string} sample.sex         - M | F | U
 * @param {object[]} sample.results   - Array of { assayCode, value, unit, flag, refRange }
 * @param {number} msgSeq             - Message sequence number for H record.
 * @returns {string[]} Array of ASTM record strings (without CR termination).
 */
function buildMessage(sample, msgSeq = 1) {
  const records = [];

  // H record - Header
  // H|\^&|||ACCESSII^A5.4.0|||||||P|1|YYYYMMDDHHMMSS
  records.push(`H|\\^&|||ACCESSII^A5.4.0||||||P|1|${NOW}`);

  // P record - Patient
  // P|1||patient_id||||name||dob|sex
  records.push(`P|1||${sample.sampleId}||||${sample.patientName}||${sample.dob}|${sample.sex}`);

  // O record - Order
  // O|1|specimen_id||^^^assay^^|R|collect_datetime||||||R
  records.push(`O|1|${sample.sampleId}||^^^PANEL^^|R|${NOW}||||||R`);

  // R records - one per test result
  sample.results.forEach((r, i) => {
    const seqNo    = i + 1;
    const flagStr  = r.flag || 'N';
    // R|seq|^^^assayCode^^||value|unit||refRange|flag||resultStatus|||resultDatetime|instrumentId
    records.push(
      `R|${seqNo}|^^^${r.assayCode}^^||${r.value}|${r.unit}||${r.refRange}|${flagStr}||F|||${NOW}|ACCESSII`
    );
  });

  // L record - Terminator
  records.push(`L|1|N`);

  return records;
}

// Test samples to transmit
const SAMPLES = [
  {
    sampleId   : '69DC9967EB3BB',
    patientName: 'SHARMA^RAMESH',
    dob        : '19750315',
    sex        : 'M',
    results    : [
      { assayCode: 'TSH',  value: '2.450', unit: 'uIU/mL', flag: 'N',  refRange: '0.27-4.20'  },
      { assayCode: 'FT4',  value: '1.180', unit: 'ng/dL',  flag: 'N',  refRange: '0.93-1.70'  },
      { assayCode: 'FT3',  value: '3.200', unit: 'pg/mL',  flag: 'N',  refRange: '2.00-4.40'  },
      { assayCode: 'LH',   value: '5.600', unit: 'mIU/mL', flag: 'N',  refRange: '1.70-8.60'  },
      { assayCode: 'FSH',  value: '4.100', unit: 'mIU/mL', flag: 'N',  refRange: '1.50-12.40' }
    ]
  },
  {
    sampleId   : '7A3C1D5E8F2B4',
    patientName: 'PATEL^SUNITA',
    dob        : '19900822',
    sex        : 'F',
    results    : [
      { assayCode: 'TSH',  value: '8.920', unit: 'uIU/mL', flag: 'H',  refRange: '0.27-4.20'  },
      { assayCode: 'FT4',  value: '0.780', unit: 'ng/dL',  flag: 'L',  refRange: '0.93-1.70'  },
      { assayCode: 'TPAB', value: '420.0', unit: 'IU/mL',  flag: 'HH', refRange: '0.00-34.00' },
      { assayCode: 'PRL',  value: '18.50', unit: 'ng/mL',  flag: 'N',  refRange: '4.10-28.90' },
      { assayCode: 'E2',   value: '95.00', unit: 'pg/mL',  flag: 'N',  refRange: '21.0-251.0' }
    ]
  }
];

// ---------------------------------------------------------------------------
// Simulator class
// ---------------------------------------------------------------------------
class Access2Simulator {

  constructor(portPath) {
    this._portPath    = portPath;
    this._port        = null;
    this._receiveBuffer = Buffer.alloc(0);
  }

  async run() {

    this._port = new SerialPort({
      path    : this._portPath,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity  : 'none',
      autoOpen: false
    });

    await new Promise((resolve, reject) => {
      this._port.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this._port.on('data', (chunk) => {
      this._receiveBuffer = Buffer.concat([this._receiveBuffer, chunk]);
    });

    // Wait 1 second for the LIS engine to settle
    await this._sleep(1000);

    // Transmit each sample as a separate ENQ-EOT session
    for (let i = 0; i < SAMPLES.length; i++) {
      await this._transmitSession(SAMPLES[i], i + 1);
      // Pause between samples to simulate realistic analyser timing
      await this._sleep(500);
    }

    await new Promise((resolve) => this._port.close(resolve));
  }

  /**
   * Transmits one complete ASTM session (ENQ through EOT) for one sample.
   *
   * @param {object} sample  - Sample data object.
   * @param {number} msgSeq  - Message sequence number.
   */
  async _transmitSession(sample, msgSeq) {
    // Send ENQ and wait for ACK
    this._port.write(ENQ);

    const ackForEnq = await this._waitForByte(ACK, 3000);
    if (!ackForEnq) {
      console.error('[SIMULATOR] No ACK received for ENQ - aborting session');
      return;
    }

    // Build the ASTM message records
    const records = buildMessage(sample, msgSeq);

    // Transmit each record as one frame
    // Frame numbers cycle 1-7 then wrap to 1
    let frameCounter = 1;

    for (let i = 0; i < records.length; i++) {
      const frameNo  = String(frameCounter);
      const isLast   = true;   // Each record is its own final frame in this simple implementation
      const frame    = buildFrame(frameNo, records[i], isLast);
      const csStr    = computeChecksum(frameNo, records[i], ETX);

      this._port.write(frame);

      const ackForFrame = await this._waitForByte(ACK, 3000);

      // Cycle frame number 1-7
      frameCounter = frameCounter >= 7 ? 1 : frameCounter + 1;
    }

    // Send EOT to close the session
    this._port.write(EOT);

    await this._sleep(200);
  }

  /**
   * Waits for a specific byte to arrive in the receive buffer.
   *
   * @param {number} expectedByte - Byte value to wait for.
   * @param {number} timeoutMs    - Maximum wait time in milliseconds.
   * @returns {Promise<boolean>}  true if byte received, false on timeout.
   */
  _waitForByte(expectedByte, timeoutMs) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        // Search the receive buffer for the expected byte
        for (let i = 0; i < this._receiveBuffer.length; i++) {
          if (this._receiveBuffer[i] === expectedByte) {
            // Consume all bytes up to and including the found byte
            this._receiveBuffer = this._receiveBuffer.slice(i + 1);
            return resolve(true);
          }
        }

        if (Date.now() - startTime >= timeoutMs) {
          return resolve(false);
        }

        // Poll again after 20ms
        setTimeout(check, 20);
      };

      check();
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const simulator = new Access2Simulator(SIMULATOR_PORT);
simulator.run().catch((err) => {
  console.error('[SIMULATOR] Fatal error:', err.message);
  process.exit(1);
});
