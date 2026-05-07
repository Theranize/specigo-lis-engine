/**
 * simulate_bs230_tcpip.js
 * SpeciGo LIS Integration Engine - Mindray BS-230 ASTM E1394 over TCP/IP simulator
 *
 * Simulates a Mindray BS-230 chemistry analyser dialing the LIS engine
 * over TCP/IP and transmitting clinical chemistry results.
 *
 * Usage:
 *   node test/simulate_bs230_tcpip.js
 *   node test/simulate_bs230_tcpip.js --host 127.0.0.1 --port 5100
 *
 * The simulator opens a TCP connection to the LIS engine's listener,
 * runs the ASTM E1394 transmission sequence (ENQ → frames → EOT) for two
 * sample patients, then closes the socket.
 */

'use strict';

const net = require('net');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_HOST = '69.62.77.70';
const DEFAULT_PORT = 7118;

function parseArg(name, fallback) {
  const args  = process.argv.slice(2);
  const index = args.indexOf(name);
  return (index !== -1 && args[index + 1]) ? args[index + 1] : fallback;
}

const HOST = parseArg('--host', DEFAULT_HOST);
const PORT = parseInt(parseArg('--port', String(DEFAULT_PORT)), 10);

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

// Build records in Mindray native ASTM layout per Host Interface Manual §2.2.3.
// Real BS-230 analyser format (NOT the older standard-ASTM/Beckman layout):
//   H field 11 = Processing ID (PR/QR/CR/RQ/QA/SA)
//   O field 3  = Sample ID^Tray^Pos, field 4 = Bar code (specimen ID)
//   R field 2  = AssayNo^Name^Replicate^F, value at [3], unit [4],
//                range [6], flag [7], status [9], end-time [13], instrument [14]
function buildMessage(sample) {
  const records = [];
  records.push(`H|\\^&|||BS-230^V8.0^123456|||||||PR|1394-97|${NOW}`);
  records.push(`P|1||${sample.sampleId}||${sample.patientName}||${sample.dob}|${sample.sex}`);
  records.push(`O|1|${sample.sampleId}^1^1|${sample.sampleId}|^^|R|${NOW}|${NOW}|||||||||serum|||||||||||F|||||`);
  sample.results.forEach((r, i) => {
    const seqNo   = i + 1;
    const flagStr = r.flag || 'N';
    records.push(
      `R|${seqNo}|${r.channelNo}^${r.channelNo}^1^F|${r.value}^|${r.unit}||${r.refRange}|${flagStr}||F|||${NOW}|${NOW}|BS-230^123456`
    );
  });
  records.push(`L|1|N`);
  return records;
}

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
// Simulator
// ---------------------------------------------------------------------------
class BS230TcpSimulator {

  constructor(host, port) {
    this._host          = host;
    this._port          = port;
    this._socket        = null;
    this._receiveBuffer = Buffer.alloc(0);
  }

  async run() {
    await this._connect();

    this._socket.on('data', (chunk) => {
      this._receiveBuffer = Buffer.concat([this._receiveBuffer, chunk]);
    });

    // Settle pause so the engine logs are clean before traffic starts.
    await this._sleep(500);

    for (let i = 0; i < SAMPLES.length; i++) {
      await this._transmitSession(SAMPLES[i]);
      await this._sleep(500);
    }

    this._socket.end();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      console.log(`[SIMULATOR] Connecting to LIS engine at ${this._host}:${this._port} ...`);
      this._socket = net.createConnection({ host: this._host, port: this._port }, () => {
        console.log('[SIMULATOR] Connected.');
        resolve();
      });
      this._socket.once('error', reject);
    });
  }

  async _transmitSession(sample) {
    this._socket.write(ENQ);

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
      this._socket.write(frame);

      const ackForFrame = await this._waitForByte(ACK, 3000);
      if (!ackForFrame) {
        console.error(`[SIMULATOR] No ACK received for frame ${frameNo} - aborting session`);
        return;
      }

      frameCounter = frameCounter >= 7 ? 1 : frameCounter + 1;
    }

    this._socket.write(EOT);
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
        if (Date.now() - startTime >= timeoutMs) return resolve(false);
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
const simulator = new BS230TcpSimulator(HOST, PORT);
simulator.run().catch((err) => {
  console.error('[SIMULATOR] Fatal error:', err.message);
  process.exit(1);
});
