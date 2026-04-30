/**
 * IntegrationEngine.js
 * SpeciGo LIS Integration Engine - Orchestrator
 *
 * The single entry point that:
 *   1. Reads the analyser config JSON file (access2_config.json).
 *   2. Creates the mysql2 connection pool to the SpeciGo LIMS database.
 *   3. Instantiates SerialPortManager, ASTMFramer, Access2Parser,
 *      ParameterMapper, and ResultWriter.
 *   4. Wires all inter-module events together.
 *   5. Manages the full connection lifecycle: start, stop, reconnect.
 *   6. Exposes getStatus() consumed by the REST API (IntegrationAPI.js).
 *   7. Handles graceful shutdown on SIGTERM / SIGINT for Windows Service.
 *
 * Called from index.js as:
 *   const engine = new IntegrationEngine(configPath);
 *   await engine.start();
 *
 * The Beckman Coulter Access 2 uses the ASTM E1394 / LIS2-A2 protocol and
 * pushes results automatically in "Send All Results" mode without requiring
 * host queries from the LIS side.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const mysql   = require('mysql2/promise');
const winston = require('winston');
require('winston-daily-rotate-file');

const SerialPortManager = require('../transport/SerialPortManager');
const ASTMFramer        = require('../protocol/ASTMFramer');
const Access2Parser     = require('../protocol/Access2Parser');
const ParameterMapper   = require('../mapping/ParameterMapper');
const ResultWriter      = require('../db/ResultWriter');

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
      return `[${timestamp}] [ENGINE] [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname     : 'logs',
      filename    : 'error-%DATE%.log',
      datePattern : 'YYYY-MM-DD',
      level       : 'error',
      maxFiles    : '14d',
      zippedArchive: false
    }),
    new winston.transports.DailyRotateFile({
      dirname     : 'logs',
      filename    : 'combined-%DATE%.log',
      datePattern : 'YYYY-MM-DD',
      maxFiles    : '14d',
      zippedArchive: false
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] [ENGINE] ${level}: ${message}`
        )
      )
    })
  ]
});

// ---------------------------------------------------------------------------
// IntegrationEngine class
// ---------------------------------------------------------------------------
class IntegrationEngine {

  /**
   * @param {string} configFilePath - Absolute or relative path to analyser JSON config.
   */
  constructor(configFilePath) {
    if (!configFilePath) {
      throw new Error('IntegrationEngine: configFilePath is required');
    }

    this._configFilePath = configFilePath;
    this._config         = null;
    this._dbPool         = null;

    this._serialManager  = null;
    this._framer         = null;
    this._parser         = null;
    this._mapper         = null;
    this._writer         = null;

    this._running        = false;
    this._startedAt      = null;

    this._dbReady        = false;
    this._dbRetrying     = false;
    this._dbRetryTimer   = null;

    this._stats = {
      resultsReceived  : 0,
      resultsWritten   : 0,
      resultsSkipped   : 0,
      resultsFailed    : 0,
      sessionsStarted  : 0,
      sessionsEnded    : 0,
      transmissions    : 0,
      parseErrors      : 0,
      lastResultAt     : null
    };

    logger.info('IntegrationEngine constructed', { configFilePath });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the engine: load config, open DB pool, initialise modules, open serial port.
   */
  async start() {
    if (this._running) {
      logger.warn('start() called but engine is already running');
      return;
    }

    logger.info('IntegrationEngine starting...');

    this._config = this._loadConfig(this._configFilePath);
    this._initialiseModules();
    this._registerShutdownHandlers();

    await this._serialManager.connect();

    this._running   = true;
    this._startedAt = new Date();

    logger.info('IntegrationEngine running - serial port open', {
      analyser: this._config.model,
      site    : this._config.site,
      port    : this._config.connection.port
    });

    // Connect to database in the background - does NOT block the serial port.
    this._connectDbWithRetry();
  }

  /**
   * Stop the engine cleanly.
   */
  async stop() {
    if (!this._running) {
      logger.warn('stop() called but engine is not running');
      return;
    }

    logger.info('IntegrationEngine stopping...');

    this._dbRetrying = false;
    if (this._dbRetryTimer) {
      clearTimeout(this._dbRetryTimer);
      this._dbRetryTimer = null;
    }

    if (this._serialManager) {
      await this._serialManager.disconnect();
    }

    if (this._framer) {
      this._framer.reset();
    }

    if (this._dbPool) {
      await this._dbPool.end();
      this._dbPool  = null;
      this._dbReady = false;
      logger.info('Database pool closed');
    }

    this._running = false;
    logger.info('IntegrationEngine stopped');
  }

  /**
   * Returns a complete status snapshot for the REST API status endpoint.
   */
  getStatus() {
    const serialStatus = this._serialManager ? this._serialManager.getStatus() : {};
    const framerStats  = this._framer        ? this._framer.getStats()         : {};
    const parserStats  = this._parser        ? this._parser.getStats()         : {};
    const mapperStats  = this._mapper        ? this._mapper.getStats()         : {};

    return {
      running       : this._running,
      startedAt     : this._startedAt,
      analyser      : this._config?.model       || null,
      site          : this._config?.site        || null,
      labUid        : this._config?.lab_uid     || null,
      analyzerUid   : this._config?.analyzer_uid|| null,
      connected     : serialStatus.isOpen       || false,
      port          : serialStatus.port         || null,
      baudRate      : serialStatus.baudRate      || null,
      isReconnecting: serialStatus.isReconnecting || false,
      lastByteAt    : serialStatus.stats?.lastByteAt || null,
      dbReady       : this._dbReady,
      dbRetrying    : this._dbRetrying,
      stats         : {
        ...this._stats,
        serial : serialStatus.stats  || {},
        framer : framerStats,
        parser : parserStats,
        mapper : mapperStats
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - config loading
  // ---------------------------------------------------------------------------

  _loadConfig(filePath) {
    const absPath = path.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }

    let config;
    try {
      const raw = fs.readFileSync(absPath, 'utf8');
      config    = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse config file ${absPath}: ${err.message}`);
    }

    const required = ['lab_uid', 'analyzer_uid', 'connection', 'protocol', 'parameter_map'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Config file missing required field: "${field}"`);
      }
    }

    const connRequired = ['port', 'baudRate', 'dataBits', 'stopBits', 'parity'];
    for (const field of connRequired) {
      if (config.connection[field] === undefined) {
        throw new Error(`Config connection block missing required field: "${field}"`);
      }
    }

    logger.info('Config loaded successfully', {
      analyser: config.model,
      site    : config.site,
      port    : config.connection.port
    });

    return config;
  }

  // ---------------------------------------------------------------------------
  // Internal - database pool
  // ---------------------------------------------------------------------------

  async _createDbPool() {
    const host     = '127.0.0.1';
    const port     = 3306;
    const user     = 'admin';
    const password = 'admin';
    const poolSize = 5;
    const database = 'lis_db';

    if (!host || !user || !password) {
      throw new Error(
        'Database credentials missing. Set DB_HOST, DB_USER, DB_PASSWORD in environment.'
      );
    }

    const pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections     : true,
      connectionLimit        : poolSize,
      queueLimit             : 0,
      enableKeepAlive        : true,
      keepAliveInitialDelay  : 0,
      timezone               : '+00:00'
    });

    try {
      const [rows] = await pool.execute('SELECT 1 AS connected');
      if (rows[0]?.connected !== 1) {
        throw new Error('Database connectivity test returned unexpected result');
      }
      logger.info('Database pool created and verified', { host, port, database, poolSize });
    } catch (err) {
      throw new Error(`Cannot connect to database at ${host}:${port} - ${err.message}`);
    }

    return pool;
  }

  // ---------------------------------------------------------------------------
  // Internal - module wiring
  // ---------------------------------------------------------------------------

  /**
   * Instantiates all five processing modules and wires their events together.
   * This method contains the complete event graph for the engine.
   */
  _initialiseModules() {
    const cfg = this._config;

    // --- 1. SerialPortManager ---
    this._serialManager = new SerialPortManager({
      port        : cfg.connection.port,
      baudRate    : cfg.connection.baudRate,
      dataBits    : cfg.connection.dataBits,
      stopBits    : cfg.connection.stopBits,
      parity      : cfg.connection.parity,
      analyzerUid : cfg.analyzer_uid,
      labUid      : cfg.lab_uid
    });

    // --- 2. ASTMFramer ---
    // writeFn is a closure so ACK/NAK always go to the current port instance
    // even after a reconnect creates a new SerialPort object internally.
    this._framer = new ASTMFramer({
      writeFn         : (buffer) => this._writeToPort(buffer),
      checksumEnabled : cfg.protocol.checksumEnabled !== false,
      maxFrameBytes   : cfg.protocol.maxFrameBytes   || 240,
      analyzerUid     : cfg.analyzer_uid,
      labUid          : cfg.lab_uid
    });

    // --- 3. Access2Parser ---
    this._parser = new Access2Parser({
      messageFilters: cfg.message_filters || {
        patient_results    : true,
        qc_results         : false,
        calibration_results: false
      },
      analyzerUid: cfg.analyzer_uid,
      labUid     : cfg.lab_uid
    });

    // ParameterMapper and ResultWriter are created later in _initialiseDbModules()
    // once the database connection is confirmed. The serial port starts immediately
    // so no data is lost during DB connection establishment.

    // -----------------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------------

    // SerialPortManager -> ASTMFramer
    this._serialManager.on('data', (chunk) => {
      this._framer.ingest(chunk);
    });

    this._serialManager.on('connected', () => {
      logger.info('Serial port connected - engine ready to receive Access 2 data');
      this._framer.reset();
    });

    this._serialManager.on('disconnected', (reason) => {
      logger.warn('Serial port disconnected', { reason });
      // Reset framer so a partial ASTM transmission is discarded on reconnect
      this._framer.reset();
    });

    this._serialManager.on('reconnecting', (attempt, delayMs) => {
      logger.info('Reconnecting to serial port', { attempt, delayMs });
    });

    this._serialManager.on('error', (err) => {
      logger.error('Serial port error', { error: err.message });
    });

    // ASTMFramer -> Access2Parser
    this._framer.on('message', (messageText) => {
      this._parser.parse(messageText);
    });

    this._framer.on('error', (err) => {
      logger.error('ASTMFramer error', { error: err.message });
    });

    // ASTMFramer transmission lifecycle events
    this._framer.on('transmissionStart', async () => {
      this._stats.transmissions++;
      logger.info('ASTM transmission started (ENQ received)');
      if (this._dbReady) {
        await this._writer.logSessionEvent('ENQ', cfg.lab_uid).catch((err) => {
          logger.error('Failed to log transmission start', { error: err.message });
        });
      }
    });

    this._framer.on('transmissionEnd', async () => {
      logger.info('ASTM transmission ended (EOT received)');
      if (this._dbReady) {
        await this._writer.logSessionEvent('EOT', cfg.lab_uid).catch((err) => {
          logger.error('Failed to log transmission end', { error: err.message });
        });
      }
    });

    // Access2Parser session (H/L record) events
    this._parser.on('sessionStart', () => {
      this._stats.sessionsStarted++;
      logger.info('ASTM message session started (H record received)');
    });

    this._parser.on('sessionEnd', () => {
      this._stats.sessionsEnded++;
      logger.info('ASTM message session ended (L record received)');
    });

    // Access2Parser result events -> ParameterMapper -> ResultWriter
    this._parser.on('results', async (parsedResults) => {
      this._stats.resultsReceived += parsedResults.length;
      this._stats.lastResultAt = new Date();

      if (!this._dbReady) {
        this._stats.resultsSkipped += parsedResults.length;
        logger.warn('Results received but database not ready - skipping', {
          count    : parsedResults.length,
          sampleIds: parsedResults.map((r) => r.sampleId).join(', ')
        });
        return;
      }

      try {
        const mapped = this._mapper.map(parsedResults);
        await this._writer.write(mapped);
        this._stats.resultsWritten += mapped.length;
      } catch (err) {
        this._stats.resultsFailed += parsedResults.length;
        logger.error('Unhandled error in result processing pipeline', {
          count : parsedResults.length,
          error : err.message,
          stack : err.stack
        });
      }
    });

    this._parser.on('parseError', (err, rawMessage) => {
      this._stats.parseErrors++;
      logger.error('Access 2 parse error', {
        error     : err.message,
        rawLength : rawMessage.length
      });
    });

    this._parser.on('filtered', (reason) => {
      logger.debug('Result filtered', { reason });
    });

    logger.info('All modules instantiated and events wired - waiting for database');
  }

  // ---------------------------------------------------------------------------
  // Internal - database modules (mapper + writer)
  // ---------------------------------------------------------------------------

  _initialiseDbModules(pool) {
    const cfg = this._config;

    this._mapper = new ParameterMapper({
      dbPool       : pool,
      analyzerCode : 'ACCESS2',
      analyzerUid  : cfg.analyzer_uid,
      labUid       : cfg.lab_uid,
      parameter_map: cfg.parameter_map
    });

    this._writer = new ResultWriter({
      dbPool      : pool,
      analyzerUid : cfg.analyzer_uid,
      analyzerCode: 'ACCESS2',
      labUid      : cfg.lab_uid,
      limsApi     : cfg.lims_api || null
    });

    logger.info('ParameterMapper and ResultWriter initialised - engine fully operational');
  }

  // ---------------------------------------------------------------------------
  // Internal - background database connection with retry
  // ---------------------------------------------------------------------------

  async _connectDbWithRetry() {
    const INITIAL_DELAY_MS = 5000;
    const MAX_DELAY_MS     = 60000;
    let   delayMs          = INITIAL_DELAY_MS;

    this._dbRetrying = true;
    logger.info('Background DB connection started');

    while (this._running && !this._dbReady) {
      try {
        logger.info('Attempting database connection...');
        const pool = await this._createDbPool();

        this._dbPool  = pool;
        this._initialiseDbModules(pool);
        this._dbReady    = true;
        this._dbRetrying = false;

        logger.info('Database connected - engine fully operational');
        break;

      } catch (err) {
        if (!this._running) break;

        logger.warn(
          `Database connection failed, retrying in ${delayMs / 1000}s`,
          { error: err.message }
        );

        await new Promise((resolve) => {
          this._dbRetryTimer = setTimeout(resolve, delayMs);
        });
        this._dbRetryTimer = null;

        delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
      }
    }

    if (!this._dbReady) {
      this._dbRetrying = false;
      logger.info('DB retry loop cancelled (engine stopped)');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal - port write helper
  // ---------------------------------------------------------------------------

  /**
   * Writes a buffer to the serial port.
   * Used by ASTMFramer for ACK/NAK transmission.
   *
   * @param {Buffer} buffer - Bytes to write (1 byte for ACK/NAK).
   * @returns {Promise<void>}
   */
  _writeToPort(buffer) {
    return new Promise((resolve, reject) => {
      if (!this._serialManager || !this._serialManager._port || !this._serialManager._isOpen) {
        return reject(new Error('Cannot write to port: port is not open'));
      }
      this._serialManager._port.write(buffer, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal - graceful shutdown
  // ---------------------------------------------------------------------------

  _registerShutdownHandlers() {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    const shutdown = async (signal) => {
      logger.info(`${signal} received - shutting down IntegrationEngine`);
      try {
        await this.stop();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', { error: err.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    process.on('uncaughtException', async (err) => {
      logger.error('Uncaught exception - attempting graceful shutdown', {
        error: err.message,
        stack: err.stack
      });
      try {
        await this.stop();
      } catch (shutdownErr) {
        logger.error('Error during emergency shutdown', { error: shutdownErr.message });
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack : reason instanceof Error ? reason.stack   : undefined
      });
      // Do not exit on unhandled rejection - log and continue.
    });

    logger.debug('Shutdown handlers registered');
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = IntegrationEngine;
