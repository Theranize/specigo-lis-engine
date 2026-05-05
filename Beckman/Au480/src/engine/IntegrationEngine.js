/**
 * IntegrationEngine.js
 * SpeciGo LIS Integration Engine - Orchestrator (AU480)
 *
 * The single entry point that:
 *   1. Reads + validates config files (delegated to ConfigLoader).
 *   2. Creates the mysql2 connection pool to the SpeciGo LIMS database.
 *   3. Instantiates SerialPortManager, MessageFramer, AU480Parser,
 *      ParameterMapper, ResultWriter and wires them together.
 *   4. Owns the retry / reconnect policy via two ConnectionSupervisor
 *      instances (one for serial, one for DB). The transport-level
 *      modules no longer schedule their own reconnects.
 *   5. Manages the full connection lifecycle: start, stop, reconnect.
 *   6. Exposes getStatus() consumed by the local control panel.
 *   7. Handles graceful shutdown on SIGTERM / SIGINT for Windows Service.
 *
 * Called from index.js as:
 *   const engine = new IntegrationEngine(configPath);
 *   await engine.start();
 *
 * The Beckman Coulter AU480 uses the proprietary AU680/AU480 online
 * specification (ASTM-derived but NOT standard ASTM E1394). Frames are
 * STX-ETX delimited; session boundaries are signalled by 'DB' and 'DE'
 * distinction codes carried inside data frames (no ENQ/EOT).
 */

'use strict';

const mysql = require('mysql2/promise');

const SerialPortManager    = require('../transport/SerialPortManager');
const MessageFramer        = require('../protocol/MessageFramer');
const AU480Parser          = require('../protocol/AU480Parser');
const ParameterMapper      = require('../mapping/ParameterMapper');
const ResultWriter         = require('../db/ResultWriter');
const RetentionSweeper     = require('../db/RetentionSweeper');
const ConfigLoader         = require('./ConfigLoader');
const ConnectionSupervisor = require('./ConnectionSupervisor');

const logger = require('../logger').createLogger('ENGINE');

// ---------------------------------------------------------------------------
// Retry policy constants
// ---------------------------------------------------------------------------
const SERIAL_INITIAL_DELAY_MS = 5000;
const SERIAL_MAX_DELAY_MS     = 60000;
const DB_INITIAL_DELAY_MS     = 5000;
const DB_MAX_DELAY_MS         = 60000;

// ---------------------------------------------------------------------------
// IntegrationEngine class
// ---------------------------------------------------------------------------
class IntegrationEngine {

  /**
   * @param {string} configFilePath - Absolute or cwd-relative path to the
   *                                  analyser JSON config.
   */
  constructor(configFilePath) {
    if (!configFilePath) {
      throw new Error('IntegrationEngine: configFilePath is required');
    }

    this._configFilePath = configFilePath;
    this._config         = null;
    this._systemConfig   = null;

    this._dbPool         = null;
    this._dbReady        = false;

    this._serialManager  = null;
    this._framer         = null;
    this._parser         = null;
    this._mapper         = null;
    this._writer         = null;
    this._retentionSweeper = null;

    this._serialSupervisor = null;
    this._dbSupervisor     = null;

    this._running   = false;
    this._startedAt = null;

    this._stats = {
      resultsReceived: 0,
      resultsWritten : 0,
      resultsSkipped : 0,
      resultsFailed  : 0,
      sessionsStarted: 0,
      sessionsEnded  : 0,
      parseErrors    : 0,
      lastResultAt   : null
    };

    logger.info('IntegrationEngine constructed', { configFilePath });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the engine: load config, instantiate modules, wire events,
   * launch background supervisors for serial + DB connections.
   */
  async start() {
    if (this._running) {
      logger.warn('start() called but engine is already running');
      return;
    }

    logger.info('IntegrationEngine starting...');

    const { analyserConfig, systemConfig } = ConfigLoader.load(this._configFilePath);
    this._config       = analyserConfig;
    this._systemConfig = systemConfig;

    this._initialiseModules();
    this._registerShutdownHandlers();

    this._running   = true;
    this._startedAt = new Date();

    logger.info('IntegrationEngine running', {
      analyser: this._config.model,
      site    : this._config.site,
      port    : this._config.connection.port
    });

    this._buildSupervisors();

    // Both supervisors run in the background. The control panel and any
    // status callers see "running" immediately, even before connections
    // are established.
    this._serialSupervisor.run().catch((err) => {
      logger.error('Serial supervisor crashed', { error: err.message });
    });
    this._dbSupervisor.run().catch((err) => {
      logger.error('Database supervisor crashed', { error: err.message });
    });
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

    // Flip _running first so any in-flight retry sleep wakes up to a
    // false flag and exits cleanly.
    this._running = false;

    if (this._serialSupervisor) this._serialSupervisor.stop();
    if (this._dbSupervisor)     this._dbSupervisor.stop();

    if (this._retentionSweeper) {
      this._retentionSweeper.stop();
      this._retentionSweeper = null;
    }

    if (this._serialManager) {
      try {
        await this._serialManager.disconnect();
      } catch (err) {
        logger.warn('Error during serial port disconnect', { error: err.message });
      }
    }

    if (this._framer) this._framer.reset();

    if (this._dbPool) {
      try {
        await this._dbPool.end();
        logger.info('Database pool closed');
      } catch (err) {
        logger.warn('Error closing database pool', { error: err.message });
      }
      this._dbPool  = null;
      this._dbReady = false;
    }

    logger.info('IntegrationEngine stopped');
  }

  /**
   * Returns the active mysql2 connection pool.
   *
   * @throws {Error} when the database has not yet connected.
   * @returns {object} mysql2 promise pool
   */
  getDbPool() {
    if (!this._dbPool || !this._dbReady) {
      throw new Error('Database not yet connected. Please wait a moment and retry.');
    }
    return this._dbPool;
  }

  /**
   * Returns the LIMS API config block from system.config.json, or null
   * when LIMS push is not configured.
   *
   * @returns {{ base_url: string, api_key: string }|null}
   */
  getLimsApiConfig() {
    if (this._systemConfig && this._systemConfig.lims_api) {
      return this._systemConfig.lims_api;
    }
    return null;
  }

  /**
   * Returns a complete status snapshot for the control panel.
   */
  getStatus() {
    const serialStatus  = this._serialManager ? this._serialManager.getStatus() : {};
    const framerStats   = this._framer        ? this._framer.getStats()         : {};
    const parserStats   = this._parser        ? this._parser.getStats()         : {};
    const mapperStats   = this._mapper        ? this._mapper.getStats()         : {};
    const serialRetrying = this._serialSupervisor ? this._serialSupervisor.isRetrying() : false;
    const dbRetrying     = this._dbSupervisor     ? this._dbSupervisor.isRetrying()     : false;

    return {
      running        : this._running,
      startedAt      : this._startedAt,
      analyser       : this._config?.model        || null,
      site           : this._config?.site         || null,
      labUid         : this._config?.lab_uid      || null,
      analyzerUid    : this._config?.analyzer_uid || null,
      connected      : serialStatus.isOpen || false,
      port           : serialStatus.port           || null,
      baudRate       : serialStatus.baudRate       || null,
      isReconnecting : serialRetrying,
      serialRetrying : serialRetrying,
      lastByteAt     : serialStatus.stats?.lastByteAt || null,
      dbReady        : this._dbReady,
      dbRetrying     : dbRetrying,
      stats: {
        ...this._stats,
        serial: serialStatus.stats || {},
        framer: framerStats,
        parser: parserStats,
        mapper: mapperStats
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal - supervisors
  // ---------------------------------------------------------------------------

  _buildSupervisors() {
    this._serialSupervisor = new ConnectionSupervisor({
      name          : 'Serial port',
      connectFn     : () => this._serialManager.connect(),
      initialDelayMs: SERIAL_INITIAL_DELAY_MS,
      maxDelayMs    : SERIAL_MAX_DELAY_MS,
      logger
    });

    this._dbSupervisor = new ConnectionSupervisor({
      name          : 'Database',
      connectFn     : async () => {
        const pool = await this._createDbPool();
        this._dbPool = pool;
        this._initialiseDbModules(pool);
        this._dbReady = true;
      },
      initialDelayMs: DB_INITIAL_DELAY_MS,
      maxDelayMs    : DB_MAX_DELAY_MS,
      logger
    });
  }

  // ---------------------------------------------------------------------------
  // Internal - database pool
  // ---------------------------------------------------------------------------

  async _createDbPool() {
    const db       = (this._systemConfig && this._systemConfig.database) || {};
    const host     = db.host     || process.env.DB_HOST                  || '';
    const port     = db.port     || parseInt(process.env.DB_PORT     || '3306', 10);
    const user     = db.user     || process.env.DB_USER                  || '';
    const password = db.password || process.env.DB_PASSWORD              || '';
    const database = db.database || process.env.DB_NAME                  || '';
    const poolSize = db.poolSize || parseInt(process.env.DB_POOL_SIZE || '5', 10);

    if (!host || !user || !password || !database) {
      throw new Error(
        'Database credentials missing. Set in config/system.config.json or environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).'
      );
    }

    const pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections   : true,
      connectionLimit      : poolSize,
      queueLimit           : 0,
      enableKeepAlive      : true,
      keepAliveInitialDelay: 0,
      timezone             : '+00:00'
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
   * Instantiates the always-on processing modules and wires their events
   * together. Database-dependent modules (mapper + writer + sweeper) are
   * built later in _initialiseDbModules() once the pool is verified.
   */
  _initialiseModules() {
    const cfg = this._config;

    // --- 1. SerialPortManager ---
    this._serialManager = new SerialPortManager({
      port       : cfg.connection.port,
      baudRate   : cfg.connection.baudRate,
      dataBits   : cfg.connection.dataBits,
      stopBits   : cfg.connection.stopBits,
      parity     : cfg.connection.parity,
      analyzerUid: cfg.analyzer_uid,
      labUid     : cfg.lab_uid,
      rtscts     : cfg.connection.rtscts,
      xon        : cfg.connection.xon,
      xoff       : cfg.connection.xoff
    });

    // --- 2. MessageFramer ---
    // writeFn is a closure so the ACK byte always goes to the current port
    // instance even after the supervisor reconnects.
    this._framer = new MessageFramer({
      writeFn    : (buffer) => this._writeToPort(buffer),
      bccCheck   : cfg.protocol.bccCheck   === true,
      maxBytes   : cfg.protocol.textLength || 512,
      analyzerUid: cfg.analyzer_uid,
      labUid     : cfg.lab_uid
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
      sampleIdLength: cfg.sample_id?.length || 13,
      analyzerUid   : cfg.analyzer_uid,
      labUid        : cfg.lab_uid
    });

    // -----------------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------------

    // SerialPortManager -> MessageFramer
    this._serialManager.on('data', (chunk) => {
      this._framer.ingest(chunk);
    });

    this._serialManager.on('connected', () => {
      logger.info('Serial port connected - engine ready to receive AU480 data');
      this._framer.reset();
    });

    this._serialManager.on('disconnected', (reason) => {
      logger.warn('Serial port disconnected', { reason });
      // Reset framer so a partial frame is discarded before any reconnect.
      this._framer.reset();
      // Trigger the supervisor to retry the connection. The supervisor
      // is the single owner of retry policy; SerialPortManager itself
      // does not schedule reconnects anymore.
      if (this._running && this._serialSupervisor && reason !== 'clean close') {
        this._serialSupervisor.notifyDisconnected();
      }
    });

    this._serialManager.on('error', (err) => {
      logger.error('Serial port error', { error: err.message });
    });

    // MessageFramer -> AU480Parser
    this._framer.on('frame', (frameBuffer) => {
      this._parser.parse(frameBuffer);
    });

    this._framer.on('error', (err) => {
      logger.error('MessageFramer error', { error: err.message });
    });

    // AU480Parser session events
    // The AU480 signals session boundaries via 'DB' / 'DE' distinction codes
    // carried inside data frames (no ENQ/EOT). The parser surfaces these as
    // sessionStart / sessionEnd events identical in shape to the Access 2 path.
    this._parser.on('sessionStart', async () => {
      this._stats.sessionsStarted++;
      logger.info('AU480 session started (DB code received)');
      if (this._dbReady) {
        await this._writer.logSessionEvent('DB', cfg.lab_uid).catch((err) => {
          logger.error('Failed to log session start', { error: err.message });
        });
      }
    });

    this._parser.on('sessionEnd', async () => {
      this._stats.sessionsEnded++;
      logger.info('AU480 session ended (DE code received)');
      if (this._dbReady) {
        await this._writer.logSessionEvent('DE', cfg.lab_uid).catch((err) => {
          logger.error('Failed to log session end', { error: err.message });
        });
      }
    });

    // AU480Parser results -> ParameterMapper -> ResultWriter
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
          count: parsedResults.length,
          error: err.message,
          stack: err.stack
        });
      }
    });

    this._parser.on('parseError', (err, rawHex) => {
      this._stats.parseErrors++;
      logger.error('AU480 parse error', {
        error : err.message,
        rawHex
      });
    });

    this._parser.on('filtered', (code, reason) => {
      logger.debug('Frame filtered', { code, reason });
    });

    logger.info('All modules instantiated and events wired - waiting for database');
  }

  // ---------------------------------------------------------------------------
  // Internal - database modules (mapper + writer + retention)
  // ---------------------------------------------------------------------------

  _initialiseDbModules(pool) {
    const cfg       = this._config;
    const retention = (this._systemConfig && this._systemConfig.data_retention) || {};

    this._mapper = new ParameterMapper({
      dbPool       : pool,
      analyzerCode : 'AU480',
      analyzerUid  : cfg.analyzer_uid,
      labUid       : cfg.lab_uid,
      parameter_map: cfg.parameter_map
    });

    this._writer = new ResultWriter({
      dbPool      : pool,
      analyzerUid : cfg.analyzer_uid,
      analyzerCode: 'AU480',
      labUid      : cfg.lab_uid,
      limsApi     : (this._systemConfig && this._systemConfig.lims_api) || null
    });

    this._retentionSweeper = new RetentionSweeper({
      dbPool         : pool,
      days           : retention.days,
      intervalMinutes: retention.interval_minutes,
      tables         : retention.tables
    });
    this._retentionSweeper.start();

    logger.info('ParameterMapper, ResultWriter, and RetentionSweeper initialised - engine fully operational');
  }

  // ---------------------------------------------------------------------------
  // Internal - port write helper
  // ---------------------------------------------------------------------------

  /**
   * Writes a buffer to the serial port via SerialPortManager's public
   * write() method. Used by MessageFramer for ACK transmission.
   *
   * @param {Buffer} buffer - Bytes to write (1 byte for ACK).
   * @returns {Promise<void>}
   */
  _writeToPort(buffer) {
    if (!this._serialManager) {
      return Promise.reject(new Error('Cannot write to port: serial manager not initialised'));
    }
    return this._serialManager.write(buffer);
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
