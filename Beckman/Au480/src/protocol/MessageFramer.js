'use strict';

const { EventEmitter } = require('events');
const winston = require('winston');

const STX = 2;
const ETX = 3;
const CR  = 13;
const LF  = 10;

// Handshake
const ACK = 6;
// const NAK = 21; // future use if you enable checksum validation

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

class MessageFramer extends EventEmitter {
  constructor(options = {}) {
    super();

    this._writeFn = typeof options.writeFn === 'function' ? options.writeFn : null;
    this._bccCheck = options.bccCheck === true;
    this._maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 4096;
    this._mode = options.mode || 'auto';

    this._analyzerUid = options.analyzerUid || 'unknown';
    this._labUid = options.labUid || 'unknown';

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
      mode: this._mode,
      bccCheck: this._bccCheck,
      maxBytes: this._maxBytes,
      analyzerUid: this._analyzerUid,
      labUid: this._labUid
    });
  }

  reset() {
    // ASTM state
    this._state = 'WAIT_STX';
    this._body = [];
    this._ck1 = null;
    this._ck2 = null;

    // Line state
    this._lineBuf = [];
    this._prevWasCR = false;

    this._stats.resets++;
  }

  getStats() {
    return { ...this._stats };
  }

  ingest(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      console.log('MessageFramer.ingest called with invalid chunk; ignoring', { chunk });
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
      else this._onByteLine(b);
    }
  }

  async _sendAck() {
    if (!this._writeFn) return;
    try {
      await this._writeFn(Buffer.from([ACK]));
      logger.debug('ACK sent', { analyzerUid: this._analyzerUid, labUid: this._labUid });
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

  // -----------------------------
  // ASTM-like: STX ... ETX CK CK CR LF
  // Emits BODY ONLY (STX/ETX stripped) -> parser contract
  // -----------------------------
  _onByteAstm(b) {
    // resync hard: STX always starts new frame
    if (b === STX) {
      this._state = 'IN_BODY';
      this._body = [];
      this._ck1 = null;
      this._ck2 = null;
      return;
    }

    switch (this._state) {
      case 'WAIT_STX':
        return;

      case 'IN_BODY':
        if (b === ETX) {
          // this._state = 'WAIT_CK1';
          // return;

          const bodyBuf = Buffer.from(this._body);

          this._stats.framesEmitted++;
          this._stats.astmFrames++;
          this._stats.lastFrameAt = new Date();

          this.emit('frame', bodyBuf);
          void this._sendAck();

          this._state = 'WAIT_STX';
          this._body = [];
          this._ck1 = null;
          this._ck2 = null;
          console.log('Emit>>>>>>>>>>>ted ASTM frame, resetting to WAIT_STX');
          return;
        }
        this._body.push(b);
        if (this._body.length > this._maxBytes) {
          this._emitError('ASTM frame exceeded maxBytes; discarding', { maxBytes: this._maxBytes });
        }
        return;

      case 'WAIT_CK1':
        this._ck1 = b;
        this._state = 'WAIT_CK2';
        return;

      case 'WAIT_CK2':
        this._ck2 = b;
        this._state = 'WAIT_CR';
        return;

      case 'WAIT_CR':
        if (b !== CR) {
          this._emitError('ASTM expected CR after checksum', { received: b });
          return;
        }
        this._state = 'WAIT_LF';
        return;

      case 'WAIT_LF':
        if (b !== LF) {
          this._emitError('ASTM expected LF after CR', { received: b });
          return;
        }

        // If you later want checksum validation, do it here using ck1/ck2.
        // For now, just consume them and ACK the frame to stop analyzer retransmits.
        const bodyBuf = Buffer.from(this._body);

        this._stats.framesEmitted++;
        this._stats.astmFrames++;
        this._stats.lastFrameAt = new Date();

        this.emit('frame', bodyBuf);

        // IMPORTANT: ACK after we successfully framed a message
        void this._sendAck();

        this._state = 'WAIT_STX';
        this._body = [];
        this._ck1 = null;
        this._ck2 = null;
        return;

      default:
        this.reset();
        return;
    }
  }

  // -----------------------------
  // Line mode: CRLF terminates a record
  // Emits the line WITHOUT CRLF -> parser contract
  // -----------------------------
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

module.exports = MessageFramer;