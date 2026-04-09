/**
 * install-service.js
 * SpeciGo LIS Integration Engine - Windows Service Installer
 *
 * Registers index.js as a Windows Service using the node-windows package.
 * Run this ONCE on the lab PC during initial setup at MMI Diagnostics.
 *
 * PREREQUISITES:
 *   1. Node.js >= 18 installed on the Windows PC.
 *   2. npm install completed (node-windows in devDependencies).
 *   3. .env file created and populated with DB credentials.
 *   4. au480_mmi.json updated with the correct COM port (COM2 at MMI).
 *   5. Run this script from an ADMINISTRATOR command prompt.
 *      Right-click Command Prompt -> Run as Administrator.
 *
 * USAGE:
 *   node install-service.js
 *
 * WHAT HAPPENS:
 *   1. The script registers "SpeciGo LIS Integration Engine" in Windows Services.
 *   2. Startup type is set to Automatic (starts on boot, before user login).
 *   3. The service starts immediately after installation.
 *   4. Service logs (stdout + stderr) are written to:
 *        C:\speciго-lis-engine\daemon\
 *      as rotating files managed by node-windows.
 *
 * VERIFY AFTER RUNNING:
 *   - Open Windows Services (services.msc).
 *   - Find "SpeciGo LIS Integration Engine".
 *   - Status should be "Running".
 *   - Check daemon\ folder for log files.
 *   - Or tail logs\serial-combined.log to see Winston output.
 *
 * TO UNINSTALL:
 *   node uninstall-service.js
 *
 * node-windows reference: https://github.com/coreybutler/node-windows
 */

'use strict';

const path    = require('path');
const winston = require('winston');

// ---------------------------------------------------------------------------
// Bootstrap logger (file logging not available until service is running)
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] [INSTALL] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [INSTALL] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// node-windows Service definition
// Matches the specification in Section 9.3 of the foundation document exactly.
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

// Absolute path to index.js - node-windows requires absolute paths.
// __dirname here is the project root because install-service.js lives there.
const scriptPath = path.join(__dirname, 'index.js');

const svc = new Service({
  // Service name as it appears in services.msc
  name: 'SpeciGo LIS Integration Engine',

  // Description shown in services.msc detail view
  description: 'SpeciGo AU480 LIS Integration Engine - MMI Diagnostics, Raipur. '
             + 'Bridges Beckman Coulter AU480 analyser (COM2) to SpeciGo LIMS via RS-232.',

  // Absolute path to the Node.js entry point
  script: scriptPath,

  // No additional Node.js flags needed for production.
  // --max-old-space-size is not required - the engine is memory-efficient.
  nodeOptions: [],

  // Environment variables passed to the service process.
  // These supplement (do not replace) any .env file the service loads via dotenv.
  // Defining them here means they are baked into the service registration and
  // survive even if the .env file is accidentally deleted.
  // IMPORTANT: Set DB_PASSWORD here to the real value before running this script.
  // It will be stored in the Windows Service registry entry (encrypted by Windows).
  env: [
    { name: 'NODE_ENV',     value: 'production' },
    { name: 'LOG_LEVEL',    value: 'info'        },
    { name: 'CONFIG_FILE',  value: path.join(__dirname, 'config', 'analysers', 'au480_mmi.json') }
    // DB_HOST, DB_PORT, DB_USER, DB_PASSWORD are read from .env by dotenv.
    // Alternatively add them here as additional { name, value } objects if
    // you prefer not to use a .env file on the production machine.
  ],

  // Restart policy: if the service crashes, wait 2 seconds then restart.
  // grow: 0.5 increases the wait time by 50% on each consecutive failure
  // to avoid a rapid restart loop if there is a persistent startup error.
  wait: 2,
  grow: 0.5,

  // Maximum number of restart attempts before the service gives up.
  // 0 = unlimited restarts. For a 24/7 lab service, unlimited is correct.
  maxRetries: 0
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

svc.on('install', () => {
  logger.info('Windows Service installed successfully.');
  logger.info('Starting service...');
  svc.start();
});

svc.on('start', () => {
  logger.info('Windows Service started successfully.');
  logger.info('');
  logger.info('VERIFY:');
  logger.info('  1. Open services.msc -> find "SpeciGo LIS Integration Engine" -> Status: Running');
  logger.info(`  2. Tail logs: type logs\\serial-combined.log`);
  logger.info(`  3. Service daemon logs: ${path.join(__dirname, 'daemon')}`);
  logger.info('');
  logger.info('TO STOP:   net stop "SpeciGo LIS Integration Engine"');
  logger.info('TO START:  net start "SpeciGo LIS Integration Engine"');
  logger.info('TO REMOVE: node uninstall-service.js');
});

svc.on('error', (err) => {
  logger.error('Service installation error', {
    error: err.message || String(err),
    hint : 'Ensure you are running this script from an Administrator command prompt.'
  });
  process.exit(1);
});

svc.on('alreadyinstalled', () => {
  logger.warn('Service is already installed.');
  logger.warn('To reinstall: run uninstall-service.js first, then run this script again.');
  logger.warn('To restart an installed service: net stop / net start from an Admin prompt.');
  process.exit(0);
});

svc.on('invalidinstallation', () => {
  logger.error('Invalid installation detected.');
  logger.error('Run uninstall-service.js to clean up, then run this script again.');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
logger.info('Installing SpeciGo LIS Integration Engine as Windows Service...');
logger.info('Script path', { scriptPath });

svc.install();
