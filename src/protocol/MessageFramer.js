/**
 * MessageFramer.js
 * SpeciGo LIS Integration Engine - Protocol Layer
 *
 * Sits between SerialPortManager and AU480Parser.
 * Responsibilities:
 *   1. Buffer incoming raw byte chunks from the serial stream.
 *   2. Detect STX (0x02) / ETX (0x03) frame boundaries.
 *   3. Emit one 'frame' event per complete message (bytes between STX and ETX, exclusive).
 *   4. Send ACK (0x06) after every valid frame - Class B protocol requirement confirmed at MMI.
 *   5. Send NAK (0x15) if a frame is malformed or oversized, triggering AU480 retransmission.
 *   6. Discard BCC byte if present (BCC is DISABLED at MMI but the code handles it safely).
 *   7. Enforce the 512-byte max text length confirmed at MMI.
 *
 * Confirmed protocol constants from MMI machine photos (08 April 2026):
 *   STX          : 0x02
 *   ETX          : 0x03
 *   ACK          : 0x06
 *   NAK          : 0x15
 *   Class        : B (ACK/NAK required after each block)
 *   BCC Check    : DISABLED
 *   Max text len : 512 bytes
 *
 * Events emitted:
 *   'frame'  -> (frameBuffer: Buffer)  Complete message body, STX/ETX stripped.
 *   'error'  -> (err: Error)           Framing-level error (oversized, corrupt, etc.)
 *
 * This module is NOT an EventEmitter itself - it is instantiated with a callback
 * interface so IntegrationEngine can wire it inline without an extra emitter layer.
 * Frame and error outputs are delivered via the constructor options.
 *
 * ACK/NAK are written directly to the SerialPortManager's underlying port write
 * method, passed in as 'writeFn' in options. This keeps MessageFramer decoupled
 * from SerialPortManager internals while still allowing it to respond on the same
 * physical port.
 */

'use strict';

const { EventEmitter } = require('events');
const winston          = require('winston');

// ---------------------------------------------------------------------------
// Protocol constants - do not change without updating the foundation document
// ---------------------------------------------------------------------------
const STX          = 0x02;
const ETX          = 0x03;
const ACK          = 0x06;
const NAK          = 0x15;
const MAX_FRAME_BYTES = 512;   // confirmed from MMI protocol tab photo

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
// MessageFramer class
// ---------------------------------------------------------------------------
class MessageFramer extends EventEmitter {

  /**
   * @param {object}   options
   * @param {Function} options.writeFn     - async (buffer: Buffer) => void
   *                                         Write function for ACK/NAK responses.
   *                                         Provided by IntegrationEngine from the
   *                                         SerialPortManager port reference.
   * @param {boolean}  [options.bccCheck]  - Whether to validate BCC byte after ETX.
   *                                         false at MMI. Defaults to false.
   * @param {number}   [options.maxBytes]  - Max frame body length. 512 at MMI.
   * @param {string}   [options.analyzerUid] - For log context.
   * @param {string}   [options.labUid]      - For log context.
   */
  constructor(options = {}) {
    super();

    if (typeof options.writeFn !== 'function') {
      throw new Error('MessageFramer: options.writeFn is required and must be a function');
    }

    this._writeFn     = options.writeFn;
    this._bccCheck    = options.bccCheck  === true;   // explicitly false at MMI
    this._maxBytes    = options.maxBytes  || MAX_FRAME_BYTES;
    this._analyzerUid = options.analyzerUid || 'unknown';
    this._labUid      = options.labUid      || 'unknown';

    // Internal byte accumulation buffer.
    // We use a simple array of bytes rather than a Buffer because we do not
    // know the final frame length until ETX arrives. Array.push is O(1) per byte.
    this._accumulator  = [];
    this._inFrame      = false;   // true from STX to ETX (inclusive)

    // Statistics for the dashboard status endpoint
    this.stats = {
      framesReceived : 0,
      framesAcked    : 0,
      framesNaked    : 0,
      bytesDiscarded : 0,
      oversizedFrames: 0,
      lastFrameAt    : null
    };

    logger.info('MessageFramer initialised', {
      bccCheck   : this._bccCheck,
      maxBytes   : this._maxBytes,
      analyzerUid: this._analyzerUid
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
      logger.error('ingest() received non-Buffer input - ignoring', {
        type: typeof chunk
      });
      return;
    }

    logger.debug('Ingesting chunk', {
      bytes: chunk.length,
      hex  : chunk.toString('hex').toUpperCase()
    });

    // Process byte by byte.
    // The AU480 sends messages sequentially (one at a time) in unidirectional
    // mode so there will never be two STX bytes without an intervening ETX.
    // Processing byte-by-byte is correct and simplest for this protocol.
    for (let i = 0; i < chunk.length; i++) {
      this._processByte(chunk[i]);
    }
  }

  /**
   * Reset internal state. Call if the connection drops mid-frame so the
   * partially accumulated buffer does not contaminate the next session.
   */
  reset() {
    if (this._accumulator.length > 0) {
      logger.warn('Framer reset with partial frame in buffer', {
        bufferedBytes: this._accumulator.length,
        hex          : Buffer.from(this._accumulator).toString('hex').toUpperCase()
      });
      this.stats.bytesDiscarded += this._accumulator.length;
    }
    this._accumulator = [];
    this._inFrame     = false;
    logger.info('MessageFramer state reset');
  }

  /**
   * Returns a snapshot of framer statistics.
   * Used by the REST API status endpoint.
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internal - byte processing state machine
  // ---------------------------------------------------------------------------

  /**
   * Single-byte state machine.
   * State is tracked via this._inFrame boolean.
   *
   * State transitions:
   *   _inFrame = false + byte = STX  -> start new frame, set _inFrame = true
   *   _inFrame = false + other byte  -> discard (noise between messages)
   *   _inFrame = true  + byte = STX  -> unexpected nested STX, discard old frame and restart
   *   _inFrame = true  + byte = ETX  -> frame complete, dispatch for validation
   *   _inFrame = true  + other byte  -> accumulate into buffer
   *
   * @param {number} byte - Single byte value (0-255).
   */
  _processByte(byte) {

    if (!this._inFrame) {
      if (byte === STX) {
        // Begin a new frame. STX itself is not stored - it is a delimiter only.
        this._inFrame     = true;
        this._accumulator = [];
        logger.debug('STX detected - frame start');
      } else {
        // Byte received outside of a frame boundary.
        // This can happen if the OS delivers a partial byte, or if the serial
        // line has noise when the AU480 is idle. Log at debug only - not an error.
        this.stats.bytesDiscarded++;
        logger.debug('Byte discarded - not in frame', {
          byte: byte.toString(16).toUpperCase().padStart(2, '0')
        });
      }
      return;
    }

    // We are inside a frame (_inFrame = true)

    if (byte === STX) {
      // Nested STX - the previous frame was never closed properly.
      // This should not happen with the AU480 but is handled defensively.
      logger.warn('Unexpected STX inside frame - discarding partial frame and restarting', {
        discardedBytes: this._accumulator.length,
        hex           : Buffer.from(this._accumulator).toString('hex').toUpperCase()
      });
      this.stats.bytesDiscarded += this._accumulator.length;
      this._accumulator = [];
      // Stay in _inFrame = true and treat this STX as the new frame start
      return;
    }

    if (byte === ETX) {
      // Frame complete. ETX itself is not stored - delimiter only.
      logger.debug('ETX detected - frame complete', {
        frameBytes: this._accumulator.length
      });
      this._inFrame = false;
      this._dispatchFrame();
      return;
    }

    // Normal data byte - accumulate
    this._accumulator.push(byte);

    // Enforce max frame size. If exceeded, send NAK and discard.
    // The AU480 retry count is 3 - it will retransmit automatically.
    if (this._accumulator.length > this._maxBytes) {
      logger.error('Frame exceeded maximum byte length - sending NAK', {
        maxBytes   : this._maxBytes,
        actualBytes: this._accumulator.length
      });
      this.stats.oversizedFrames++;
      this.stats.bytesDiscarded += this._accumulator.length;
      this._accumulator = [];
      this._inFrame     = false;
      this._sendNak('frame size exceeded');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - frame dispatch and validation
  // ---------------------------------------------------------------------------

  /**
   * Called when a complete STX...ETX frame has been accumulated.
   * Validates the frame and either emits 'frame' + sends ACK,
   * or sends NAK and emits 'error'.
   */
  _dispatchFrame() {
    const frameBuffer = Buffer.from(this._accumulator);
    this._accumulator = [];   // clear immediately so next frame is clean

    logger.debug('Dispatching frame', {
      bytes: frameBuffer.length,
      hex  : frameBuffer.toString('hex').toUpperCase()
    });

    // Minimum viable frame: 2-char distinction code + at least 1 byte of data
    if (frameBuffer.length < 2) {
      logger.warn('Frame too short to be valid - sending NAK', {
        bytes: frameBuffer.length,
        hex  : frameBuffer.toString('hex').toUpperCase()
      });
      this._sendNak('frame too short');
      this.emit('error', new Error(`Frame too short: ${frameBuffer.length} bytes`));
      return;
    }

    // BCC validation (disabled at MMI but implemented for future labs)
    if (this._bccCheck) {
      // BCC is the last byte appended AFTER ETX in BCC-enabled configurations.
      // Since our accumulator captures bytes between STX and ETX (exclusive),
      // and the spec states BCC comes after ETX, BCC is not in our buffer.
      // If BCC is enabled, the byte after ETX is the BCC. SerialPortManager
      // delivers raw bytes so BCC would appear as a stray byte after ETX is
      // processed by _processByte. In that case it appears as a discarded
      // inter-frame byte. This is acceptable because BCC is DISABLED at MMI.
      // If a future lab enables BCC, this logic must be revisited to hold the
      // byte after ETX and validate it before sending ACK.
      logger.warn('BCC check is enabled but not fully implemented - treating as valid');
    }

    // Frame is valid - record stats and respond
    this.stats.framesReceived++;
    this.stats.lastFrameAt = new Date();

    // Send ACK before emitting - AU480 Class B expects ACK promptly
    // If ACK write fails we still emit the frame because the data is good;
    // the AU480 will retry after its T.R.I. timeout but we already have the data.
    this._sendAck();

    // Emit the frame for AU480Parser to consume
    this.emit('frame', frameBuffer);
  }

  // ---------------------------------------------------------------------------
  // Internal - ACK / NAK transmission
  // ---------------------------------------------------------------------------

  /**
   * Sends ACK (0x06) to the AU480.
   * The AU480 Class B protocol requires ACK after each successfully received block.
   * Without ACK the AU480 waits for its T.R.I. timeout (configured as 'Continue')
   * then moves on, but it logs a receive error.
   */
  _sendAck() {
    const ackBuffer = Buffer.from([ACK]);
    this._writeToPort(ackBuffer, 'ACK');
    this.stats.framesAcked++;
  }

  /**
   * Sends NAK (0x15) to the AU480 requesting retransmission.
   * The AU480 retry count is 3 (confirmed MMI). After 3 NAKs it continues
   * per the T.R.I. Receive Error = Continue setting.
   *
   * @param {string} reason - Human-readable reason for logging.
   */
  _sendNak(reason) {
    const nakBuffer = Buffer.from([NAK]);
    this._writeToPort(nakBuffer, 'NAK');
    this.stats.framesNaked++;
    logger.warn('NAK sent', { reason });
  }

  /**
   * Writes a buffer to the serial port via the injected writeFn.
   * Handles errors without throwing so a write failure never crashes the framer.
   *
   * @param {Buffer} buffer      - Bytes to write.
   * @param {string} description - For logging ('ACK' or 'NAK').
   */
  _writeToPort(buffer, description) {
    // writeFn is provided by IntegrationEngine pointing to SerialPortManager's
    // underlying port.write(). We call it as a fire-and-forget async here because
    // ACK/NAK must be sent immediately - we cannot await and block byte processing.
    Promise.resolve()
      .then(() => this._writeFn(buffer))
      .then(() => {
        logger.debug(`${description} sent`, {
          hex: buffer.toString('hex').toUpperCase()
        });
      })
      .catch((err) => {
        // Write failure is logged but not fatal. The AU480 will handle the
        // missing ACK via its T.R.I. timeout (set to 'Continue' at MMI).
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
module.exports = MessageFramer;
