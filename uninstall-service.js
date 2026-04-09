/**
 * uninstall-service.js
 * SpeciGo LIS Integration Engine - Windows Service Uninstaller
 *
 * Stops and removes the "SpeciGo LIS Integration Engine" Windows Service.
 * Run this from an ADMINISTRATOR command prompt when:
 *   - Reinstalling the service after a code update.
 *   - Decommissioning the integration at this lab.
 *   - Troubleshooting a broken service registration.
 *
 * USAGE:
 *   node uninstall-service.js
 *
 * WHAT HAPPENS:
 *   1. The running service is stopped.
 *   2. The service is unregistered from Windows Services.
 *   3. The daemon\ folder (node-windows wrapper scripts) is cleaned up.
 *   4. index.js, logs\, and config\ are NOT touched - only the service registration.
 *
 * After uninstalling you can:
 *   - Run: node install-service.js    to reinstall.
 *   - Run: node index.js              to run without a service (development).
 */

'use strict';

const path    = require('path');
const winston = require('winston');

// ---------------------------------------------------------------------------
// Bootstrap logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [UNINST]  [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [UNINST]  ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// Load node-windows
// ---------------------------------------------------------------------------
let Service;
try {
  Service = require('node-windows').Service;
} catch (err) {
  logger.error('node-windows package not found.', {
    hint : 'Run: npm install --save-dev node-windows',
    error: err.message
  });
  process.exit(1);
}

const scriptPath = path.join(__dirname, 'index.js');

const svc = new Service({
  name  : 'SpeciGo LIS Integration Engine',
  script: scriptPath
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

svc.on('uninstall', () => {
  logger.info('Windows Service uninstalled successfully.');
  logger.info('The daemon\\ folder has been cleaned up by node-windows.');
  logger.info('Logs in logs\\ and config files are preserved.');
  logger.info('');
  logger.info('To reinstall: node install-service.js');
  logger.info('To run manually: node index.js');
  process.exit(0);
});

svc.on('stop', () => {
  logger.info('Service stopped. Proceeding with uninstall...');
});

svc.on('error', (err) => {
  logger.error('Error during uninstall', {
    error: err.message || String(err),
    hint : 'Ensure you are running from an Administrator command prompt.'
  });
  process.exit(1);
});

svc.on('notinstalled', () => {
  logger.warn('Service is not currently installed - nothing to uninstall.');
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------
logger.info('Stopping and uninstalling SpeciGo LIS Integration Engine Windows Service...');
svc.uninstall();
