/**
 * simulate_bs230.js
 * SpeciGo LIS Integration Engine - Mindray BS-230 ASTM E1394 Protocol Simulator
 *
 * Simulates a Mindray BS-230 chemistry analyser transmitting clinical
 * chemistry results to the LIS engine via a virtual serial port pair.
 *
 * Usage:
 *   node test/simulate_bs230.js
 *   node test/simulate_bs230.js --port COM3
 *   node test/simulate_bs230.js --port /dev/pts/1
 *
 * Prerequisites (Windows):
 *   Use com0com or a similar virtual serial port utility to create a connected
 *   pair, e.g. COM3 <-> COM4. Run the engine on COM4 and this simulator on COM3.
 *
 * Prerequisites (Linux):
 *   Use socat to create a virtual pair:
 *     socat -d -d pty,raw,echo=0 pty,raw,echo=0
 *   This prints two device paths like /dev/pts/1 and /dev/pts/2.
 *   Run the engine on /dev/pts/2 and this simulator on /dev/pts/1.
 *
 * What this simulator transmits:
 *   A complete ASTM E1394 session for two patient samples, each with
 *   common BS-230 chemistries (GLU, UREA, CREA, ALT, AST, CHOL, TG, HDL).
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
 *   STX 4 <R record GLU> ETX CS CR LF
 *   ...
 *   STX N <L record> ETX CS CR LF
 *   ACK <- (wait)
 *   EOT
 *   (repeat for second sample)
 */

'use strict';

const { SerialPort } = require('serialport');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_PORT = process.platform === 'win32' ? 'COM3' : '/dev/ttyV1';

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
const STX = 0x02;
const ETX = 0x03;
const CR  = 0x0D;
const LF  = 0x0A;

// ---------------------------------------------------------------------------
// ASTM checksum calculation
// ---------------------------------------------------------------------------

function computeChecksum(frameNo, frameText, terminator) {
  let sum = frameNo.charCodeAt(0);
  for (let i = 0; i < frameText.length; i++) {
    sum += frameText.charCodeAt(i);
  }
  sum += terminator;
  return (sum % 256).toString(16).toUpperCase().padStart(2, '0');
}

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

function nowAstm() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const NOW = nowAstm();

/**
 * Builds an ASTM message (array of record strings) for one patient sample.
 * H, P, O, R*, L records following standard LIS2-A2 layout. Mindray BS-230
 * sender identifier is "BS-230^V8.0".
 */
function buildMessage(sample) {
  const records = [];

  // H record - Header
  records.push(`H|\\^&|||BS-230^V8.0||||||P|1|${NOW}`);

  // P record - Patient
  // Layout used here matches the standard LIS2-A2 offsets the parser falls
  // back to: name in field 5, DOB in field 7, sex in field 8.
  records.push(`P|1|${sample.sampleId}|||${sample.patientName}||${sample.dob}|${sample.sex}`);

  // O record - Order (universal test ID can list a panel; results carry the
  // chemistry channel numbers individually)
  records.push(`O|1|${sample.sampleId}||^^^PANEL^^|R|${NOW}||||||R`);

  // R records - one per chemistry result
  sample.results.forEach((r, i) => {
    const seqNo   = i + 1;
    const flagStr = r.flag || 'N';
    records.push(
      `R|${seqNo}|^^^${r.channelNo}^^||${r.value}|${r.unit}||${r.refRange}|${flagStr}||F|||${NOW}|BS-230`
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
      { channelNo: 'GLU',  value: '92',     unit: 'mg/dL',  flag: 'N',  refRange: '70-110'      },
      { channelNo: 'UREA', value: '28.0',   unit: 'mg/dL',  flag: 'N',  refRange: '15-40'       },
      { channelNo: 'CREA', value: '0.95',   unit: 'mg/dL',  flag: 'N',  refRange: '0.7-1.3'     },
      { channelNo: 'ALT',  value: '32',     unit: 'U/L',    flag: 'N',  refRange: '5-40'        },
      { channelNo: 'AST',  value: '28',     unit: 'U/L',    flag: 'N',  refRange: '5-40'        },
      { channelNo: 'CHOL', value: '188',    unit: 'mg/dL',  flag: 'N',  refRange: '0-200'       },
      { channelNo: 'TG',   value: '142',    unit: 'mg/dL',  flag: 'N',  refRange: '0-150'       },
      { channelNo: 'HDL',  value: '48',     unit: 'mg/dL',  flag: 'N',  refRange: '40-60'       }
    ]
  },
  {
    sampleId   : '7A3C1D5E8F2B4',
    patientName: 'PATEL^SUNITA',
    dob        : '19900822',
    sex        : 'F',
    results    : [
      { channelNo: 'GLU',  value: '174',    unit: 'mg/dL',  flag: 'H',  refRange: '70-110'      },
      { channelNo: 'UREA', value: '52',     unit: 'mg/dL',  flag: 'H',  refRange: '15-40'       },
      { channelNo: 'CREA', value: '1.78',   unit: 'mg/dL',  flag: 'H',  refRange: '0.7-1.3'     },
      { channelNo: 'ALT',  value: '95',     unit: 'U/L',    flag: 'H',  refRange: '5-40'        },
      { channelNo: 'AST',  value: '110',    unit: 'U/L',    flag: 'HH', refRange: '5-40'        },
      { channelNo: 'CHOL', value: '262',    unit: 'mg/dL',  flag: 'H',  refRange: '0-200'       },
      { channelNo: 'TG',   value: '288',    unit: 'mg/dL',  flag: 'H',  refRange: '0-150'       },
      { channelNo: 'HDL',  value: '34',     unit: 'mg/dL',  flag: 'L',  refRange: '40-60'       }
    ]
  }
];

// ---------------------------------------------------------------------------
// Simulator class
// ---------------------------------------------------------------------------
class BS230Simulator {

  constructor(portPath) {
    this._portPath      = portPath;
    this._port          = null;
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
      await this._transmitSession(SAMPLES[i]);
      await this._sleep(500);
    }

    await new Promise((resolve) => this._port.close(resolve));
  }

  async _transmitSession(sample) {
    // Send ENQ and wait for ACK
    this._port.write(ENQ);

    const ackForEnq = await this._waitForByte(ACK, 3000);
    if (!ackForEnq) {
      console.error('[SIMULATOR] No ACK received for ENQ - aborting session');
      return;
    }

    const records = buildMessage(sample);
    let frameCounter = 1;

    for (let i = 0; i < records.length; i++) {
      const frameNo = String(frameCounter);
      const frame   = buildFrame(frameNo, records[i], true);
      this._port.write(frame);

      const ackForFrame = await this._waitForByte(ACK, 3000);
      if (!ackForFrame) {
        console.error(`[SIMULATOR] No ACK received for frame ${frameNo} - aborting session`);
        return;
      }

      frameCounter = frameCounter >= 7 ? 1 : frameCounter + 1;
    }

    // Send EOT to close the session
    this._port.write(EOT);
    await this._sleep(200);
  }

  _waitForByte(expectedByte, timeoutMs) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        for (let i = 0; i < this._receiveBuffer.length; i++) {
          if (this._receiveBuffer[i] === expectedByte) {
            this._receiveBuffer = this._receiveBuffer.slice(i + 1);
            return resolve(true);
          }
        }

        if (Date.now() - startTime >= timeoutMs) {
          return resolve(false);
        }

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
const simulator = new BS230Simulator(SIMULATOR_PORT);
simulator.run().catch((err) => {
  console.error('[SIMULATOR] Fatal error:', err.message);
  process.exit(1);
});
