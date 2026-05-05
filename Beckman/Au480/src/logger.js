/**
 * logger.js
 * SpeciGo LIS Integration Engine - Shared Winston logger factory
 *
 * Every module in the engine should obtain its logger instance from here:
 *
 *     const logger = require('./logger').createLogger('ENGINE');
 *
 * The factory configures three transports identically for all callers:
 *   1. logs/error-YYYY-MM-DD.log   (level: error only)
 *   2. logs/combined-YYYY-MM-DD.log (all levels)
 *   3. Console (colorized)
 *
 * Log line format (file):
 *     [2026-05-04 10:45:30.123] [ENGINE ] [INFO] message {"key":"value"}
 *
 * Log line format (console):
 *     [10:45:30.123] [ENGINE ] info: message
 *
 * The label is padded to a fixed width so columns align cleanly across
 * every module.
 *
 * IMPORTANT: process.env.LOG_LEVEL must be populated before this module is
 * required for the first time. index.js handles that during bootstrap by
 * reading system.config.json before requiring any engine module.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LABEL_WIDTH        = 7;
const LOGS_DIR           = path.join(process.cwd(), 'logs');
const DEFAULT_RETENTION  = 14;

// Ensure the logs directory exists. Idempotent - safe across multiple
// requires because Node caches modules.
try {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
} catch {
  /* If we cannot create logs/ here the daily-rotate transport will surface
     the error on first write. */
}

// ---------------------------------------------------------------------------
// Read retention setting from config/system.config.json
//
// This is read once at module load. If the file is missing or the field is
// not present, the default (14 days) is used. winston-daily-rotate-file
// accepts a "<n>d" string for day-based retention.
// ---------------------------------------------------------------------------
function resolveRetention() {
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'system.config.json');
    const raw     = fs.readFileSync(cfgPath, 'utf8');
    const cfg     = JSON.parse(raw);
    const days    = cfg && cfg.logger && cfg.logger.retention_days;
    if (Number.isInteger(days) && days > 0) {
      return `${days}d`;
    }
  } catch {
    /* Config not readable - fall through to default. */
  }
  return `${DEFAULT_RETENTION}d`;
}

const RETENTION = resolveRetention();

// ---------------------------------------------------------------------------
// Format builders
// ---------------------------------------------------------------------------
const padLabel = (label) => String(label).padEnd(LABEL_WIDTH, ' ');

function fileFormat(label) {
  const padded = padLabel(label);
  return winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [${padded}] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  );
}

function consoleFormat(label) {
  const padded = padLabel(label);
  return winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] [${padded}] ${level}: ${message}`
    )
  );
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a configured winston logger with the standard transports for this
 * project.
 *
 * @param {string} label - Short module identifier (e.g. 'ENGINE', 'SERIAL').
 *                         Will appear bracketed in every log line.
 * @returns {winston.Logger}
 */
function createLogger(label) {
  return winston.createLogger({
    level : process.env.LOG_LEVEL || 'debug',
    format: fileFormat(label),
    transports: [
      new winston.transports.DailyRotateFile({
        dirname      : LOGS_DIR,
        filename     : 'error-%DATE%.log',
        datePattern  : 'YYYY-MM-DD',
        level        : 'error',
        maxFiles     : RETENTION,
        zippedArchive: false
      }),
      new winston.transports.DailyRotateFile({
        dirname      : LOGS_DIR,
        filename     : 'combined-%DATE%.log',
        datePattern  : 'YYYY-MM-DD',
        maxFiles     : RETENTION,
        zippedArchive: false
      }),
      new winston.transports.Console({
        format: consoleFormat(label)
      })
    ]
  });
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  createLogger,
  getLogsDir: () => LOGS_DIR
};
