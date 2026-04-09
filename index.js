/**
 * index.js
 * SpeciGo LIS Integration Engine - Application Entry Point
 *
 * This is the script that node-windows points to when running as a Windows Service.
 * It is also the script Umesh runs manually during development and testing:
 *
 *   node index.js
 *   node index.js --config config/analysers/au480_mmi.json
 *
 * Responsibilities:
 *   1. Ensure the logs/ directory exists before Winston tries to write to it.
 *   2. Load environment variables from .env via dotenv.
 *   3. Resolve the analyser config file path (from CLI arg or default).
 *   4. Construct and start IntegrationEngine.
 *   5. Log the startup banner so Umesh can confirm the service is live in
 *      Windows Event Viewer or by tailing logs/serial-combined.log.
 *
 * Config file resolution order:
 *   1. --config <path> CLI argument
 *   2. CONFIG_FILE environment variable
 *   3. Default: config/analysers/au480_mmi.json
 *
 * Environment variables (set in .env or Windows Service environment):
 *   DB_HOST        - MySQL host
 *   DB_PORT        - MySQL port (default 3306)
 *   DB_USER        - MySQL username
 *   DB_PASSWORD    - MySQL password
 *   DB_POOL_SIZE   - Connection pool size (default 5)
 *   CONFIG_FILE    - Path to analyser config JSON (optional, see above)
 *   LOG_LEVEL      - Winston log level (default 'debug')
 */

'use strict';

// ---------------------------------------------------------------------------
// Step 1: Ensure logs directory exists BEFORE requiring Winston-dependent modules.
// Winston will throw if it cannot open the log file on first write.
// fs.mkdirSync with recursive:true is idempotent - safe to call on every boot.
// ---------------------------------------------------------------------------
const fs   = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Step 2: Load environment variables from .env
// Must happen before any module that reads process.env is required.
// dotenv.config() is silent if .env does not exist (production uses real env vars).
// ---------------------------------------------------------------------------
require('dotenv').config();

// ---------------------------------------------------------------------------
// Step 3: Now safe to require modules that use Winston and process.env
// ---------------------------------------------------------------------------
const winston          = require('winston');
const IntegrationEngine = require('./src/engine/IntegrationEngine');

// ---------------------------------------------------------------------------
// Bootstrap logger
// This logger is used only for startup/shutdown messages in index.js.
// Each module has its own logger instance writing to the same log files.
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [INDEX]  [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'serial-combined.log'),
      maxsize : 10 * 1024 * 1024,
      maxFiles: 14,
      tailable: true
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'serial-error.log'),
      level   : 'error',
      maxsize : 5 * 1024 * 1024,
      maxFiles: 14,
      tailable: true
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [INDEX]  ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Step 4: Resolve config file path
// ---------------------------------------------------------------------------

/**
 * Parse --config <path> from process.argv.
 * Returns the path string if found, null otherwise.
 */
function parseConfigArg() {
  const args  = process.argv.slice(2);
  const index = args.indexOf('--config');
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return null;
}

const configFilePath = (
  parseConfigArg()                              ||
  process.env.CONFIG_FILE                       ||
  path.join(__dirname, 'config', 'analysers', 'au480_mmi.json')
);

// ---------------------------------------------------------------------------
// Step 5: Print startup banner
// This appears in Windows Event Viewer when the service starts and is the
// first thing Umesh looks for to confirm successful launch.
// ---------------------------------------------------------------------------
const BANNER = `
╔══════════════════════════════════════════════════════════════╗
║          SpeciGo LIS Integration Engine                     ║
║          Beckman Coulter AU480  |  MMI Diagnostics, Raipur  ║
║          Node.js ${process.version.padEnd(8)} | PID ${String(process.pid).padEnd(8)}              ║
╚══════════════════════════════════════════════════════════════╝
`;

logger.info(BANNER);
logger.info('Starting engine', {
  configFile: configFilePath,
  nodeVersion: process.version,
  platform   : process.platform,
  pid        : process.pid,
  logLevel   : process.env.LOG_LEVEL || 'debug'
});

// ---------------------------------------------------------------------------
// Step 6: Construct and start the engine
// ---------------------------------------------------------------------------

/**
 * Main async function.
 * Wraps engine construction and start in a try/catch so any fatal startup
 * error (missing config, DB unreachable, COM port not found) is logged clearly
 * before the process exits with code 1, causing the Windows Service manager
 * to log a service failure event.
 */
async function main() {
  let engine;

  try {
    engine = new IntegrationEngine(configFilePath);
  } catch (err) {
    logger.error('Failed to construct IntegrationEngine', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  }

  try {
    await engine.start();
    logger.info('Engine started successfully - listening for AU480 data');
  } catch (err) {
    logger.error('Engine failed to start', {
      error: err.message,
      stack: err.stack
    });
    // Attempt clean resource release before exiting so DB connections
    // are returned to the pool and not left dangling
    try {
      await engine.stop();
    } catch (stopErr) {
      logger.error('Error during emergency stop after failed start', {
        error: stopErr.message
      });
    }
    process.exit(1);
  }
}

main();
