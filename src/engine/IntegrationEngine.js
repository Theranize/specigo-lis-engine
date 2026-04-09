/**
 * IntegrationEngine.js
 * SpeciGo LIS Integration Engine - Orchestrator
 *
 * The single entry point that:
 *   1. Reads the analyser config JSON file (au480_mmi.json or any other).
 *   2. Creates the mysql2 connection pool to the SpeciGo LIMS database.
 *   3. Instantiates SerialPortManager, MessageFramer, AU480Parser,
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
 * Config file path is passed in so the same engine code runs for any lab
 * and any analyser simply by switching the config file - no code change needed.
 *
 * Database: u151751738_theranizeDevh1 (SpeciGo LIMS production)
 * Connection credentials are read from environment variables (never hardcoded).
 * See .env.example for required variables.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const mysql   = require('mysql2/promise');
const winston = require('winston');

const SerialPortManager = require('../transport/SerialPortManager');
const MessageFramer     = require('../protocol/MessageFramer');
const AU480Parser       = require('../protocol/AU480Parser');
const ParameterMapper   = require('../mapping/ParameterMapper');
const ResultWriter      = require('../db/ResultWriter');

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
      return `[${timestamp}] [ENGINE] [${level.toUpperCase()}] ${message}${metaStr}`;
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
   *   e.g. path.join(__dirname, '../../config/analysers/au480_mmi.json')
   */
  constructor(configFilePath) {
    if (!configFilePath) {
      throw new Error('IntegrationEngine: configFilePath is required');
    }

    this._configFilePath = configFilePath;
    this._config         = null;   // loaded in start()
    this._dbPool         = null;

    // Module instances - created in _initialiseModules()
    this._serialManager  = null;
    this._framer         = null;
    this._parser         = null;
    this._mapper         = null;
    this._writer         = null;

    // Engine lifecycle state
    this._running        = false;
    this._startedAt      = null;

    // Counters for the dashboard status endpoint
    this._stats = {
      resultsReceived    : 0,
      resultsWritten     : 0,
      resultsSkipped     : 0,
      resultsFailed      : 0,
      sessionsStarted    : 0,
      sessionsEnded      : 0,
      parseErrors        : 0,
      lastResultAt       : null
    };

    logger.info('IntegrationEngine constructed', { configFilePath });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the engine: load config, open DB pool, initialise modules, open serial port.
   * Idempotent - safe to call if already running.
   */
  async start() {
    if (this._running) {
      logger.warn('start() called but engine is already running');
      return;
    }

    logger.info('IntegrationEngine starting...');

    // Step 1: Load and validate analyser config
    this._config = this._loadConfig(this._configFilePath);

    // Step 2: Create MySQL connection pool
    this._dbPool = await this._createDbPool();

    // Step 3: Instantiate and wire all modules
    this._initialiseModules();

    // Step 4: Register graceful shutdown handlers
    this._registerShutdownHandlers();

    // Step 5: Open the serial port
    // SerialPortManager handles reconnection automatically from this point on.
    await this._serialManager.connect();

    this._running   = true;
    this._startedAt = new Date();

    logger.info('IntegrationEngine running', {
      analyser: this._config.model,
      site    : this._config.site,
      port    : this._config.connection.port
    });
  }

  /**
   * Stop the engine cleanly.
   * Closes the serial port, destroys the DB pool, marks engine as stopped.
   */
  async stop() {
    if (!this._running) {
      logger.warn('stop() called but engine is not running');
      return;
    }

    logger.info('IntegrationEngine stopping...');

    // Disconnect serial port first so no more data arrives while we shut down
    if (this._serialManager) {
      await this._serialManager.disconnect();
    }

    // Reset framer so partial frames are not retained across stop/start cycles
    if (this._framer) {
      this._framer.reset();
    }

    // Close database pool
    if (this._dbPool) {
      await this._dbPool.end();
      this._dbPool = null;
      logger.info('Database pool closed');
    }

    this._running = false;
    logger.info('IntegrationEngine stopped');
  }

  /**
   * Returns a complete status snapshot for the REST API status endpoint.
   * Structure matches the GET /api/lis/status/:lab_uid response spec from
   * Section 9.4 of the foundation document.
   */
  getStatus() {
    const serialStatus = this._serialManager ? this._serialManager.getStatus() : {};
    const framerStats  = this._framer         ? this._framer.getStats()        : {};
    const parserStats  = this._parser         ? this._parser.getStats()        : {};
    const mapperStats  = this._mapper         ? this._mapper.getStats()        : {};
    const writerStats  = this._writer         ? this._writer.getStats()        : {};

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
      stats         : {
        ...this._stats,
        serial : serialStatus.stats  || {},
        framer : framerStats,
        parser : parserStats,
        mapper : mapperStats,
        writer : writerStats
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - config loading
  // ---------------------------------------------------------------------------

  /**
   * Loads and validates the analyser JSON config file.
   * Fails fast with a clear error if required fields are missing.
   *
   * @param {string} filePath
   * @returns {object} Parsed config object.
   */
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

    // Validate required top-level fields
    const required = ['lab_uid', 'analyzer_uid', 'connection', 'protocol', 'parameter_map'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Config file missing required field: "${field}"`);
      }
    }

    // Validate connection sub-fields
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

  /**
   * Creates a mysql2 promise-based connection pool.
   * Credentials are read from environment variables only.
   * The database name is fixed to u151751738_theranizeDevh1 per the foundation doc.
   *
   * Required environment variables:
   *   DB_HOST     - e.g. localhost or remote IP
   *   DB_PORT     - e.g. 3306
   *   DB_USER     - MySQL username
   *   DB_PASSWORD - MySQL password
   *
   * Optional:
   *   DB_POOL_SIZE - Connection pool size (default 5)
   *
   * @returns {Promise<mysql2.Pool>}
   */
  async _createDbPool() {
    const host     = process.env.DB_HOST;
    const port     = parseInt(process.env.DB_PORT || '3306', 10);
    const user     = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const poolSize = parseInt(process.env.DB_POOL_SIZE || '5', 10);

    // Database name is fixed - confirmed from foundation document
    const database = process.env.DB_NAME || 'u151751738_theranizeDevh1';

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
      waitForConnections : true,
      connectionLimit    : poolSize,
      queueLimit         : 0,
      // Keep connections alive across the overnight idle period when the lab
      // is closed. Without this, MySQL closes idle connections after wait_timeout
      // (typically 8 hours) and the pool gets stale connection errors.
      enableKeepAlive    : true,
      keepAliveInitialDelay: 0,
      // Timezone UTC prevents any date conversion surprises between the Windows
      // lab PC (which may be IST) and the MySQL server.
      timezone           : '+00:00'
    });

    // Verify connectivity with a test query before declaring the pool ready
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

    // --- 2. MessageFramer ---
    // writeFn is a closure over _serialManager so that if the port instance
    // is recreated on reconnect, the closure always writes to the current port.
    // SerialPortManager exposes _port (the raw serialport instance).
    // We write ACK/NAK via port.write() which is the correct low-level method.
    this._framer = new MessageFramer({
      writeFn     : (buffer) => this._writeToPort(buffer),
      bccCheck    : cfg.protocol.bccCheck    || false,
      maxBytes    : cfg.protocol.textLength  || 512,
      analyzerUid : cfg.analyzer_uid,
      labUid      : cfg.lab_uid
    });

    // --- 3. AU480Parser ---
    this._parser = new AU480Parser({
      messageFilters: cfg.message_filters || {
        patient_results    : true,
        stat_results       : true,
        qc_results         : false,
        calibration_results: false,
        reagent_blank      : false
      },
      sampleIdLength: 13,   // barcode_uid is always 13 chars at MMI
      analyzerUid   : cfg.analyzer_uid,
      labUid        : cfg.lab_uid
    });

    // --- 4. ParameterMapper ---
    this._mapper = new ParameterMapper({
      dbPool      : this._dbPool,
      analyzerCode: 'AU480',
      analyzerUid : cfg.analyzer_uid,
      labUid      : cfg.lab_uid
    });

    // --- 5. ResultWriter ---
    this._writer = new ResultWriter({
      dbPool      : this._dbPool,
      analyzerUid : cfg.analyzer_uid,
      analyzerCode: 'AU480',
      labUid      : cfg.lab_uid
    });

    // -----------------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------------

    // SerialPortManager -> MessageFramer
    // Every raw byte chunk delivered to the framer for STX/ETX extraction
    this._serialManager.on('data', (chunk) => {
      this._framer.ingest(chunk);
    });

    // SerialPortManager connection events -> log and framer reset
    this._serialManager.on('connected', () => {
      logger.info('Serial port connected - engine ready to receive data');
      // Reset framer so no stale partial frame from before the reconnect contaminates the stream
      this._framer.reset();
    });

    this._serialManager.on('disconnected', (reason) => {
      logger.warn('Serial port disconnected', { reason });
      // Reset framer immediately on disconnect so partial frames are discarded
      this._framer.reset();
    });

    this._serialManager.on('reconnecting', (attempt, delayMs) => {
      logger.info('Reconnecting to serial port', { attempt, delayMs });
    });

    this._serialManager.on('error', (err) => {
      logger.error('Serial port error', { error: err.message });
    });

    // MessageFramer -> AU480Parser
    // Complete frames passed to the parser
    this._framer.on('frame', (frameBuffer) => {
      this._parser.parse(frameBuffer);
    });

    this._framer.on('error', (err) => {
      logger.error('MessageFramer error', { error: err.message });
    });

    // AU480Parser session events
    this._parser.on('sessionStart', async () => {
      this._stats.sessionsStarted++;
      logger.info('Analyser session started (DB received)');
      // Clear mapper cache at session start so barcode cache from previous
      // runs (e.g. previous day) does not serve stale data
      this._mapper.clearCache();
      // Log session boundary to lis_integration_log
      await this._writer.logSessionEvent('DB', cfg.lab_uid).catch((err) => {
        logger.error('Failed to log session start', { error: err.message });
      });
    });

    this._parser.on('sessionEnd', async () => {
      this._stats.sessionsEnded++;
      logger.info('Analyser session ended (DE received)');
      await this._writer.logSessionEvent('DE', cfg.lab_uid).catch((err) => {
        logger.error('Failed to log session end', { error: err.message });
      });
    });

    // AU480Parser result events -> ParameterMapper -> ResultWriter
    // This is the critical data path. Each result is processed sequentially.
    // async is safe here because Node.js EventEmitter fires listeners synchronously
    // but the async body runs in the microtask queue without blocking the event loop.
    this._parser.on('result', async (parsedResult) => {
      this._stats.resultsReceived++;
      this._stats.lastResultAt = new Date();

      try {
        // Map barcode and parameter
        const mapped = await this._mapper.map(parsedResult);

        // Write to LIMS (or audit table if unmapped)
        await this._writer.write(mapped);

        // Update engine-level counters from writer state
        const writerStats = this._writer.getStats();
        this._stats.resultsWritten  = writerStats.written;
        this._stats.resultsSkipped  = writerStats.skipped;
        this._stats.resultsFailed   = writerStats.failed;

      } catch (err) {
        // This catch handles unexpected errors not already handled inside mapper/writer.
        // The individual modules are designed to not throw, but this is a safety net.
        this._stats.resultsFailed++;
        logger.error('Unhandled error in result processing pipeline', {
          sampleId    : parsedResult.sampleId,
          onlineTestNo: parsedResult.onlineTestNo,
          error       : err.message,
          stack       : err.stack
        });
      }
    });

    // AU480Parser parse errors
    this._parser.on('parseError', (err, rawHex) => {
      this._stats.parseErrors++;
      logger.error('AU480 parse error', {
        error : err.message,
        rawHex: rawHex
      });
    });

    this._parser.on('filtered', (code, reason) => {
      logger.debug('Message filtered', { code, reason });
    });

    logger.info('All modules instantiated and events wired');
  }

  // ---------------------------------------------------------------------------
  // Internal - port write helper
  // ---------------------------------------------------------------------------

  /**
   * Writes a buffer to the serial port.
   * Used by MessageFramer for ACK/NAK transmission.
   *
   * SerialPortManager keeps a reference to the raw SerialPort instance in _port.
   * We call port.write() via a Promise wrapper because the serialport library
   * uses callbacks for write operations.
   *
   * @param {Buffer} buffer - Bytes to write (1 byte for ACK/NAK).
   * @returns {Promise<void>}
   */
  _writeToPort(buffer) {
    return new Promise((resolve, reject) => {
      if (!this._serialManager || !this._serialManager._port || !this._serialManager._isOpen) {
        // Port is not open - cannot send ACK/NAK.
        // This can happen during reconnection. Not fatal.
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

  /**
   * Registers SIGTERM and SIGINT handlers for clean shutdown.
   * SIGTERM is sent by the Windows Service wrapper (node-windows) on stop.
   * SIGINT is Ctrl+C during development.
   *
   * Guards against double-registration if start() is somehow called twice.
   */
  _registerShutdownHandlers() {
    // Remove any previously registered handlers to avoid duplicates
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

    // Handle uncaught exceptions to prevent the Windows Service from silently dying.
    // Log and attempt graceful shutdown rather than hard crash.
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
      // Exiting would take down the Windows Service for what may be a
      // transient network blip or a single bad message.
    });

    logger.debug('Shutdown handlers registered');
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = IntegrationEngine;
