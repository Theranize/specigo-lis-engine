/**
 * MessageFramer.js
 * SpeciGo LIS Integration Engine - Protocol Layer (transport framing)
 *
 * Frames raw byte chunks from SerialPortManager into complete AU480 message
 * bodies. The AU480 wraps every message in:
 *
 *     STX <body...> ETX [CK1 CK2 CR LF]
 *
 * Confirmed at MMI Diagnostics (08 April 2026):
 *   - BCC Check is DISABLED. The analyser still appends the trailing
 *     CK1/CK2/CR/LF bytes but we do not validate them.
 *   - Frames are emitted on ETX and an ACK (0x06) is sent back so the
 *     analyser does not retransmit.
 *
 * A secondary "line mode" exists (CRLF-terminated lines) for future
 * deployments of analysers that emit plain ASCII without STX/ETX. Mode
 * is selected automatically: once any STX byte is observed, the framer
 * locks into ASTM-style framing for the rest of the run.
 *
 * Events emitted:
 *   'frame' -> (body: Buffer)   The body bytes between STX and ETX (inclusive
 *                               of neither). One emit per complete frame.
 *   'error' -> (err: Error)     Framing-level error (oversize body, etc.).
 */

'use strict';

const { EventEmitter } = require('events');

const logger = require('../logger').createLogger('FRAMER');

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
const STX = 0x02;
const ETX = 0x03;
const CR  = 0x0D;
const LF  = 0x0A;

const ACK = 0x06;
// const NAK = 0x15;   // reserved for the day BCC validation is enabled

// ---------------------------------------------------------------------------
// MessageFramer class
// ---------------------------------------------------------------------------
class MessageFramer extends EventEmitter {

  /**
   * @param {object}   options
   * @param {Function} options.writeFn       - async (Buffer) => void; used to send ACK
   * @param {boolean}  [options.bccCheck=false] - reserved; not currently validated
   * @param {number}   [options.maxBytes=4096]  - max body length before discard
   * @param {string}   [options.mode='auto']    - 'auto' | 'astm' | 'line'
   * @param {string}   [options.analyzerUid]
   * @param {string}   [options.labUid]
   */
  constructor(options = {}) {
    super();

    this._writeFn  = typeof options.writeFn === 'function' ? options.writeFn : null;
    this._bccCheck = options.bccCheck === true;
    this._maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 4096;
    this._mode     = options.mode || 'auto';

    this._analyzerUid = options.analyzerUid || 'unknown';
    this._labUid      = options.labUid      || 'unknown';

    this._stats = {
      chunksIngested: 0,
      bytesIngested : 0,
      framesEmitted : 0,
      errors        : 0,
      resets        : 0,
      astmFrames    : 0,
      lineFrames    : 0,
      lastFrameAt   : null,
      lastErrorAt   : null,
      sawStxEver    : false
    };

    this.reset();

    logger.info('MessageFramer initialised', {
      mode       : this._mode,
      bccCheck   : this._bccCheck,
      maxBytes   : this._maxBytes,
      analyzerUid: this._analyzerUid,
      labUid     : this._labUid
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  reset() {
    // ASTM state
    this._state = 'WAIT_STX';
    this._body  = [];

    // Line state
    this._lineBuf   = [];
    this._prevWasCR = false;

    this._stats.resets++;
  }

  getStats() {
    return { ...this._stats };
  }

  ingest(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      logger.debug('ingest() called with invalid chunk - ignoring');
      return;
    }

    this._stats.chunksIngested++;
    this._stats.bytesIngested += chunk.length;

    for (const b of chunk) {
      if (b === STX) this._stats.sawStxEver = true;

      const useAstm =
        this._mode === 'astm' ||
        (this._mode === 'auto' && this._stats.sawStxEver);

      if (useAstm) this._onByteAstm(b);
      else         this._onByteLine(b);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - ACK / error helpers
  // ---------------------------------------------------------------------------

  async _sendAck() {
    if (!this._writeFn) return;
    try {
      await this._writeFn(Buffer.from([ACK]));
      logger.debug('ACK sent');
    } catch (err) {
      logger.warn('Failed to send ACK', { error: err.message });
      // do not reset framing state for write failures
    }
  }

  _emitError(message, meta = {}) {
    this._stats.errors++;
    this._stats.lastErrorAt = new Date();
    logger.error(message, meta);
    this.emit('error', new Error(message));
    this.reset();
  }

  // ---------------------------------------------------------------------------
  // ASTM-like framing: STX ... body ... ETX [CK CK CR LF]
  // BCC is NOT validated at MMI. We emit the frame on ETX and ACK so the
  // analyser proceeds with the next frame instead of retransmitting.
  // ---------------------------------------------------------------------------
  _onByteAstm(b) {
    // Hard resync: STX always starts a new frame
    if (b === STX) {
      this._state = 'IN_BODY';
      this._body  = [];
      return;
    }

    switch (this._state) {
      case 'WAIT_STX':
        // Trailing CK/CR/LF after the prior frame's ETX falls here and is silently dropped
        return;

      case 'IN_BODY': {
        if (b === ETX) {
          const bodyBuf = Buffer.from(this._body);

          this._stats.framesEmitted++;
          this._stats.astmFrames++;
          this._stats.lastFrameAt = new Date();

          this.emit('frame', bodyBuf);
          void this._sendAck();

          this._state = 'WAIT_STX';
          this._body  = [];
          return;
        }

        this._body.push(b);
        if (this._body.length > this._maxBytes) {
          this._emitError('ASTM frame exceeded maxBytes; discarding', { maxBytes: this._maxBytes });
        }
        return;
      }

      default:
        this.reset();
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Line framing: CRLF terminates a record
  // Emits the line WITHOUT CRLF
  // ---------------------------------------------------------------------------
  _onByteLine(b) {
    if (this._prevWasCR) {
      this._prevWasCR = false;

      if (b === LF) {
        const line = Buffer.from(this._lineBuf);
        this._lineBuf = [];

        if (line.length === 0) return;

        const trimmed = this._trimRightSpaces(line);

        this._stats.framesEmitted++;
        this._stats.lineFrames++;
        this._stats.lastFrameAt = new Date();

        this.emit('frame', trimmed);
        return;
      }

      // CR not followed by LF => treat CR as data
      this._lineBuf.push(CR);
    }

    if (b === CR) {
      this._prevWasCR = true;
      return;
    }

    this._lineBuf.push(b);
    if (this._lineBuf.length > this._maxBytes) {
      this._emitError('Line frame exceeded maxBytes; discarding', { maxBytes: this._maxBytes });
    }
  }

  _trimRightSpaces(buf) {
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0x20) end--;
    return end === buf.length ? buf : buf.slice(0, end);
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = MessageFramer;
