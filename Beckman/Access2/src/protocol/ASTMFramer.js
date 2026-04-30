/**
 * ASTMFramer.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Implements the ASTM E1394 / LIS2-A2 transmission layer for the Beckman Coulter
 * Access 2 immunoassay analyser.
 *
 * Responsibilities:
 *   1. Receive raw byte chunks from SerialPortManager.
 *   2. Implement the ASTM transmission state machine:
 *        IDLE -> TRANSMISSION -> IN_FRAME -> CHECKSUM -> AWAIT_CR -> AWAIT_LF
 *   3. Respond with ACK (0x06) or NAK (0x15) at the correct protocol points.
 *   4. Accumulate frame bodies across ETB-delimited intermediate frames.
 *   5. Emit one 'message' event per complete logical ASTM message (H through L records).
 *   6. Emit 'transmissionStart' on ENQ and 'transmissionEnd' on EOT.
 *
 * ASTM E1394 Byte-level protocol (confirmed from DXI ACCESS LIS Vendor Information C03112AC):
 *
 *   Transmission sequence:
 *     Access 2 sends ENQ (0x05) to initiate.
 *     LIS responds with ACK (0x06).
 *     Access 2 sends one or more frames, each:
 *       STX (0x02) + frame_no (ASCII '1'-'7') + text + ETB/ETX + CS1 + CS2 + CR + LF
 *       ETB (0x17) = intermediate frame (more frames follow for this message).
 *       ETX (0x03) = final frame for this message.
 *     LIS responds with ACK after each valid frame, NAK if checksum fails.
 *     Access 2 sends EOT (0x04) after all messages have been transmitted.
 *
 *   Checksum calculation:
 *     Sum of all bytes from frame_no (inclusive) through ETX/ETB (inclusive).
 *     Take the least significant byte (modulo 256).
 *     Represent as 2 uppercase ASCII hex characters (e.g., 0xA3 -> "A3").
 *
 *   Multiple messages per transmission:
 *     A single ENQ-EOT transaction from the Access 2 may contain results for
 *     multiple samples. Each logical message starts with an H record and ends
 *     with an L record. After the L record's ETX frame the Access 2 either
 *     sends another H record frame (next sample) or sends EOT (end of session).
 *
 * Events emitted:
 *   'message'           -> (messageText: string)
 *     Complete concatenated ASTM text for one H...L message block.
 *     Text contains CR-delimited ASTM records (H, P, O, R, L).
 *
 *   'transmissionStart' -> ()
 *     Fired on ENQ receipt. Useful for session logging.
 *
 *   'transmissionEnd'   -> ()
 *     Fired on EOT receipt. Useful for session logging.
 *
 *   'error'             -> (err: Error)
 *     Framing-level error (checksum mismatch, oversized frame, unexpected byte).
 */

'use strict';

const { EventEmitter } = require('events');
const winston          = require('winston');

// ---------------------------------------------------------------------------
// Protocol constants - per ASTM E1394 specification
// ---------------------------------------------------------------------------
const ENQ = 0x05;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const STX = 0x02;
const ETX = 0x03;
const ETB = 0x17;
const CR  = 0x0D;
const LF  = 0x0A;

// Maximum allowed bytes in a single ASTM frame body (between STX and ETX/ETB).
// ASTM E1394 specifies a maximum of 240 characters per frame.
const MAX_FRAME_BODY_BYTES = 240;

// ---------------------------------------------------------------------------
// Framer internal states
// ---------------------------------------------------------------------------
const STATE = Object.freeze({
  IDLE        : 'IDLE',         // Waiting for ENQ
  TRANSMISSION: 'TRANSMISSION', // ENQ received - waiting for STX or EOT
  IN_FRAME    : 'IN_FRAME',     // Inside STX...ETX/ETB, collecting body
  CHECKSUM1   : 'CHECKSUM1',    // Received ETX/ETB, waiting for first CS byte
  CHECKSUM2   : 'CHECKSUM2',    // Received first CS byte, waiting for second CS byte
  AWAIT_CR    : 'AWAIT_CR',     // Received both CS bytes, waiting for CR
  AWAIT_LF    : 'AWAIT_LF'      // Received CR, waiting for LF
});

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
      return `[${timestamp}] [FRAMER] [${level.toUpperCase()}] ${message}${metaStr}`;
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
          `[${timestamp}] [FRAMER] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// ASTMFramer class
// ---------------------------------------------------------------------------
class ASTMFramer extends EventEmitter {

  /**
   * @param {object}   options
   * @param {Function} options.writeFn         - async (buffer: Buffer) => void
   *                                             Write function for ACK/NAK responses.
   *                                             Provided by IntegrationEngine via SerialPortManager.
   * @param {boolean}  [options.checksumEnabled] - Whether to validate ASTM checksum.
   *                                               true by default. Set false only for testing.
   * @param {number}   [options.maxFrameBytes]   - Max frame body length. Default 240.
   * @param {string}   [options.analyzerUid]     - For log context.
   * @param {string}   [options.labUid]          - For log context.
   */
  constructor(options = {}) {
    super();

    if (typeof options.writeFn !== 'function') {
      throw new Error('ASTMFramer: options.writeFn is required and must be a function');
    }

    this._writeFn          = options.writeFn;
    this._checksumEnabled  = options.checksumEnabled !== false;
    this._maxFrameBytes    = options.maxFrameBytes || MAX_FRAME_BODY_BYTES;
    this._analyzerUid      = options.analyzerUid   || 'unknown';
    this._labUid           = options.labUid        || 'unknown';

    // State machine
    this._state            = STATE.IDLE;

    // Current frame accumulation
    this._frameNo          = '';   // Single ASCII digit '1'-'7' from current frame
    this._frameBody        = [];   // Byte array for the body between frame_no and ETX/ETB
    this._terminator       = 0;    // ETX or ETB byte of the current frame
    this._cs1              = '';   // First checksum character received
    this._cs2              = '';   // Second checksum character received

    // Message accumulation across ETB-delimited frames within one logical message
    this._messageBuffer    = '';   // Concatenated text from all frames in a message

    this.stats = {
      enqReceived      : 0,
      eotReceived      : 0,
      framesReceived   : 0,
      framesAcked      : 0,
      framesNaked      : 0,
      messagesEmitted  : 0,
      checksumErrors   : 0,
      oversizedFrames  : 0,
      bytesDiscarded   : 0
    };

    logger.info('ASTMFramer initialised', {
      checksumEnabled: this._checksumEnabled,
      maxFrameBytes  : this._maxFrameBytes,
      analyzerUid    : this._analyzerUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Feed a raw chunk from SerialPortManager into the framer.
   * Call this from the 'data' event handler in IntegrationEngine:
   *
   *   serialManager.on('data', (chunk) => framer.ingest(chunk));
   *
   * @param {Buffer} chunk - Raw bytes as delivered by the serialport library.
   */
  ingest(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      logger.error('ingest() received non-Buffer input - ignoring', { type: typeof chunk });
      return;
    }

    logger.debug('Ingesting chunk', {
      bytes: chunk.length,
      hex  : chunk.toString('hex').toUpperCase()
    });

    for (let i = 0; i < chunk.length; i++) {
      this._processByte(chunk[i]);
    }
  }

  /**
   * Reset internal state. Call when the serial connection drops mid-frame.
   */
  reset() {
    if (this._frameBody.length > 0 || this._messageBuffer.length > 0) {
      logger.warn('ASTMFramer reset with buffered data - discarding', {
        frameBodyBytes  : this._frameBody.length,
        messageBufferLen: this._messageBuffer.length
      });
      this.stats.bytesDiscarded += this._frameBody.length;
    }
    this._state         = STATE.IDLE;
    this._frameNo       = '';
    this._frameBody     = [];
    this._terminator    = 0;
    this._cs1           = '';
    this._cs2           = '';
    this._messageBuffer = '';
    logger.info('ASTMFramer state reset');
  }

  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internal - state machine
  // ---------------------------------------------------------------------------

  /**
   * Single-byte state machine dispatcher.
   *
   * @param {number} byte - Single byte value (0-255).
   */
  _processByte(byte) {
    switch (this._state) {
      case STATE.IDLE:
        this._onIdle(byte);
        break;
      case STATE.TRANSMISSION:
        this._onTransmission(byte);
        break;
      case STATE.IN_FRAME:
        this._onInFrame(byte);
        break;
      case STATE.CHECKSUM1:
        this._onChecksum1(byte);
        break;
      case STATE.CHECKSUM2:
        this._onChecksum2(byte);
        break;
      case STATE.AWAIT_CR:
        this._onAwaitCr(byte);
        break;
      case STATE.AWAIT_LF:
        this._onAwaitLf(byte);
        break;
      default:
        logger.error('ASTMFramer in unknown state - resetting', { state: this._state });
        this.reset();
    }
  }

  _onIdle(byte) {
    if (byte === ENQ) {
      this.stats.enqReceived++;
      this._state         = STATE.TRANSMISSION;
      this._messageBuffer = '';
      logger.info('ENQ received - transmission started');
      this._sendAck();
      this.emit('transmissionStart');
    } else {
      // Noise before ENQ - discard silently at debug level
      this.stats.bytesDiscarded++;
      logger.debug('Byte discarded in IDLE state', {
        byte: byte.toString(16).toUpperCase().padStart(2, '0')
      });
    }
  }

  _onTransmission(byte) {
    if (byte === STX) {
      // New frame begins - reset current frame accumulation buffers
      this._frameNo    = '';
      this._frameBody  = [];
      this._terminator = 0;
      this._cs1        = '';
      this._cs2        = '';
      this._state      = STATE.IN_FRAME;
      logger.debug('STX received - frame started');
    } else if (byte === EOT) {
      // Transmission complete
      this.stats.eotReceived++;
      this._state = STATE.IDLE;
      logger.info('EOT received - transmission ended');
      this.emit('transmissionEnd');
    } else if (byte === ENQ) {
      // Re-ENQ: Access 2 may send ENQ again after a NAK timeout.
      // Respond with ACK and stay in TRANSMISSION state.
      this.stats.enqReceived++;
      logger.warn('Re-ENQ received during TRANSMISSION - responding with ACK');
      this._sendAck();
    } else {
      this.stats.bytesDiscarded++;
      logger.debug('Unexpected byte in TRANSMISSION state - discarding', {
        byte: byte.toString(16).toUpperCase().padStart(2, '0')
      });
    }
  }

  _onInFrame(byte) {
    // The first byte after STX is the frame number (ASCII digit '1'-'7').
    if (this._frameNo === '') {
      this._frameNo = String.fromCharCode(byte);
      logger.debug('Frame number received', { frameNo: this._frameNo });
      return;
    }

    if (byte === ETX || byte === ETB) {
      // Frame body complete. Store terminator for checksum calculation.
      this._terminator = byte;
      this._state      = STATE.CHECKSUM1;
      logger.debug('Frame terminator received', {
        terminator: byte === ETX ? 'ETX' : 'ETB',
        bodyBytes  : this._frameBody.length
      });
      return;
    }

    // Normal data byte - accumulate to frame body
    this._frameBody.push(byte);

    if (this._frameBody.length > this._maxFrameBytes) {
      logger.error('Frame body exceeded maximum byte length - sending NAK', {
        maxBytes   : this._maxFrameBytes,
        actualBytes: this._frameBody.length
      });
      this.stats.oversizedFrames++;
      this.stats.bytesDiscarded += this._frameBody.length;
      this._sendNak('frame body exceeded max length');
      this.emit('error', new Error(`Frame body exceeded max length of ${this._maxFrameBytes} bytes`));
      // Return to TRANSMISSION to allow Access 2 to retransmit
      this._frameBody = [];
      this._frameNo   = '';
      this._state     = STATE.TRANSMISSION;
    }
  }

  _onChecksum1(byte) {
    this._cs1   = String.fromCharCode(byte);
    this._state = STATE.CHECKSUM2;
  }

  _onChecksum2(byte) {
    this._cs2   = String.fromCharCode(byte);
    this._state = STATE.AWAIT_CR;
  }

  _onAwaitCr(byte) {
    if (byte === CR) {
      this._state = STATE.AWAIT_LF;
    } else {
      // Some implementations omit CR or send CR+LF in a single chunk.
      // Treat any non-CR byte as if we already had CR and process LF handling.
      logger.warn('Expected CR after checksum but received different byte - attempting recovery', {
        byte: byte.toString(16).toUpperCase().padStart(2, '0')
      });
      // If the byte is LF, process the frame now
      if (byte === LF) {
        this._dispatchFrame();
        this._state = STATE.TRANSMISSION;
      } else {
        this._sendNak('missing CR after checksum');
        this._state = STATE.TRANSMISSION;
      }
    }
  }

  _onAwaitLf(byte) {
    if (byte === LF) {
      this._dispatchFrame();
      this._state = STATE.TRANSMISSION;
    } else {
      // LF missing - still process the frame since the checksum was already read.
      logger.warn('Expected LF after CR but received different byte - processing frame anyway', {
        byte: byte.toString(16).toUpperCase().padStart(2, '0')
      });
      this._dispatchFrame();
      this._state = STATE.TRANSMISSION;
      // Reprocess this unexpected byte in the new state
      this._processByte(byte);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - frame dispatch
  // ---------------------------------------------------------------------------

  /**
   * Called when a complete STX...ETX/ETB + checksum + CR + LF has been collected.
   * Validates the checksum, sends ACK or NAK, and accumulates the message buffer.
   * When ETX is received, emits the complete 'message' event.
   */
  _dispatchFrame() {
    this.stats.framesReceived++;

    const frameBodyStr  = Buffer.from(this._frameBody).toString('ascii');
    const receivedCs    = (this._cs1 + this._cs2).toUpperCase();
    const expectedCs    = this._calculateChecksum(this._frameNo, this._frameBody, this._terminator);

    logger.debug('Frame dispatch', {
      frameNo   : this._frameNo,
      bodyLength: this._frameBody.length,
      terminator: this._terminator === ETX ? 'ETX' : 'ETB',
      receivedCs,
      expectedCs
    });

    if (this._checksumEnabled && receivedCs !== expectedCs) {
      this.stats.checksumErrors++;
      logger.error('ASTM checksum mismatch - sending NAK', {
        frameNo   : this._frameNo,
        receivedCs,
        expectedCs
      });
      this._sendNak('checksum mismatch');
      this.emit('error', new Error(
        `Checksum mismatch on frame ${this._frameNo}: received ${receivedCs}, expected ${expectedCs}`
      ));
      // Discard accumulated message buffer for this message to avoid partial data
      this._messageBuffer = '';
      return;
    }

    // Checksum valid (or check disabled) - send ACK
    this._sendAck();

    // Accumulate the frame body text into the message buffer.
    // The ASTM text records within a frame are already CR-delimited.
    // We append directly so the parser receives the full message as a
    // single CR-delimited string.
    this._messageBuffer += frameBodyStr;

    if (this._terminator === ETX) {
      // This is the final frame of the current logical ASTM message.
      // Emit the complete message and reset the message buffer.
      const completeMessage = this._messageBuffer;
      this._messageBuffer   = '';
      this.stats.messagesEmitted++;

      logger.info('Complete ASTM message assembled', {
        length   : completeMessage.length,
        frameNo  : this._frameNo
      });

      this.emit('message', completeMessage);

    } else {
      // ETB - intermediate frame. More frames follow for this message.
      logger.debug('Intermediate frame (ETB) accumulated', {
        bufferLength: this._messageBuffer.length
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - checksum calculation
  // ---------------------------------------------------------------------------

  /**
   * Computes the ASTM E1394 2-character hex checksum.
   *
   * Checksum = SUM(frame_no_byte + body_bytes + terminator_byte) mod 256
   * Expressed as 2 uppercase hex characters.
   *
   * @param {string}   frameNo    - Single ASCII character ('1'-'7').
   * @param {number[]} bodyBytes  - Array of body bytes.
   * @param {number}   terminator - ETX (0x03) or ETB (0x17).
   * @returns {string} 2-character uppercase hex checksum, e.g. 'A3'.
   */
  _calculateChecksum(frameNo, bodyBytes, terminator) {
    let sum = frameNo.charCodeAt(0);
    for (const byte of bodyBytes) {
      sum += byte;
    }
    sum += terminator;
    return (sum % 256).toString(16).toUpperCase().padStart(2, '0');
  }

  // ---------------------------------------------------------------------------
  // Internal - ACK / NAK transmission
  // ---------------------------------------------------------------------------

  _sendAck() {
    this._writeToPort(Buffer.from([ACK]), 'ACK');
    this.stats.framesAcked++;
  }

  _sendNak(reason) {
    this._writeToPort(Buffer.from([NAK]), 'NAK');
    this.stats.framesNaked++;
    logger.warn('NAK sent', { reason });
  }

  /**
   * Writes a buffer to the serial port via the injected writeFn.
   * Fire-and-forget - errors are logged but do not throw.
   *
   * @param {Buffer} buffer      - Bytes to write (ACK or NAK).
   * @param {string} description - For logging.
   */
  _writeToPort(buffer, description) {
    Promise.resolve()
      .then(() => this._writeFn(buffer))
      .then(() => {
        logger.debug(`${description} sent`, {
          hex: buffer.toString('hex').toUpperCase()
        });
      })
      .catch((err) => {
        logger.error(`Failed to send ${description}`, {
          error: err.message,
          hex  : buffer.toString('hex').toUpperCase()
        });
        this.emit('error', new Error(`${description} write failed: ${err.message}`));
      });
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = ASTMFramer;
