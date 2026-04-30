/**
 * index.js
 * SpeciGo LIS Integration Engine - Application Entry Point (Access 2)
 *
 * This is the script that node-windows points to when running as a Windows Service.
 * It is also the script run manually during development and testing:
 *
 *   node index.js
 *   node index.js --config config/analysers/access2_config.json
 *
 * Responsibilities:
 *   1. Ensure the logs/ directory exists before Winston tries to write to it.
 *   2. Load environment variables from .env via dotenv.
 *   3. Resolve the analyser config file path (from CLI arg or default).
 *   4. Construct and start IntegrationEngine.
 *   5. Start IntegrationAPI (REST HTTP server).
 *   6. Log the startup banner.
 *
 * Config file resolution order:
 *   1. --config <path> CLI argument
 *   2. CONFIG_FILE environment variable
 *   3. Default: config/analysers/access2_config.json
 *
 * Environment variables (set in .env or Windows Service environment):
 *   DB_HOST        - MySQL host
 *   DB_PORT        - MySQL port (default 3306)
 *   DB_USER        - MySQL username
 *   DB_PASSWORD    - MySQL password
 *   DB_NAME        - MySQL database name
 *   DB_POOL_SIZE   - Connection pool size (default 5)
 *   CONFIG_FILE    - Path to analyser config JSON (optional)
 *   LOG_LEVEL      - Winston log level (default 'debug')
 *   API_PORT       - REST API port (default 3002)
 */

'use strict';

// ---------------------------------------------------------------------------
// Step 1: Ensure logs directory exists BEFORE requiring Winston-dependent modules.
// ---------------------------------------------------------------------------
const fs   = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Step 2: Load environment variables from .env
// ---------------------------------------------------------------------------
require('dotenv').config();

// ---------------------------------------------------------------------------
// Step 2.5: Read log_level from analyser config BEFORE requiring Winston.
// All module-level loggers use process.env.LOG_LEVEL, so it must be set
// before the first require() that loads a Winston-dependent module.
// .env LOG_LEVEL (if still present) takes precedence over config file.
// ---------------------------------------------------------------------------
{
  const configArgIdx    = process.argv.indexOf('--config');
  const earlyConfigPath = (
    (configArgIdx !== -1 && process.argv[configArgIdx + 1]) ||
    process.env.CONFIG_FILE                                  ||
    path.join(process.cwd(), 'config', 'analysers', 'access2_config.json')
  );
  try {
    const earlyConfig = JSON.parse(fs.readFileSync(path.resolve(earlyConfigPath), 'utf8'));
    if (earlyConfig.logger && earlyConfig.logger.log_level && !process.env.LOG_LEVEL) {
      process.env.LOG_LEVEL = earlyConfig.logger.log_level;
    }
  } catch {
    // If config is unreadable here the engine will fail properly in _loadConfig().
  }
}

// ---------------------------------------------------------------------------
// Step 3: Now safe to require modules that use Winston and process.env
// ---------------------------------------------------------------------------
const winston           = require('winston');
const IntegrationEngine = require('./src/engine/IntegrationEngine');
const IntegrationAPI    = require('./IntegrationAPI');

// ---------------------------------------------------------------------------
// Bootstrap logger (used only in index.js for startup/shutdown messages)
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

function parseConfigArg() {
  const args  = process.argv.slice(2);
  const index = args.indexOf('--config');
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return null;
}

const configFilePath = (
  parseConfigArg()                                ||
  process.env.CONFIG_FILE                         ||
  path.join(process.cwd(), 'config', 'analysers', 'access2_config.json')
);

// ---------------------------------------------------------------------------
// Step 5: Print startup banner
// ---------------------------------------------------------------------------
const BANNER = `
╔══════════════════════════════════════════════════════════════╗
║          SpeciGo LIS Integration Engine                      ║
║          Beckman Coulter Access 2  |  Immunoassay            ║
║          Node.js ${process.version.padEnd(8)} | PID ${String(process.pid).padEnd(8)}              ║
╚══════════════════════════════════════════════════════════════╝
`;

logger.info(BANNER);
logger.info('Starting engine', {
  configFile : configFilePath,
  nodeVersion: process.version,
  platform   : process.platform,
  pid        : process.pid,
  logLevel   : process.env.LOG_LEVEL || 'debug'
});

// ---------------------------------------------------------------------------
// Step 6: Construct and start the engine + API
// ---------------------------------------------------------------------------

async function main() {
  let engine;
  let api;

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
    logger.info('Engine started successfully - listening for Access 2 data');
  } catch (err) {
    logger.error('Engine failed to start', {
      error: err.message,
      stack: err.stack
    });
    try {
      await engine.stop();
    } catch (stopErr) {
      logger.error('Error during emergency stop after failed start', {
        error: stopErr.message
      });
    }
    process.exit(1);
  }

  // Start REST API after engine is running.
  // The API requires the engine to be running so getStatus() returns meaningful data.
  try {
    api = new IntegrationAPI({
      engine : engine,
      dbPool : engine._dbPool,   // may be null initially - API handles this gracefully
      port   : parseInt(process.env.API_PORT || '3002', 10)
    });
    await api.start();
    logger.info('REST API started', { port: process.env.API_PORT || '3002' });
  } catch (err) {
    logger.error('IntegrationAPI failed to start - engine continues without REST API', {
      error: err.message
    });
    // REST API failure is non-fatal. The engine continues collecting data.
  }
}

main();
