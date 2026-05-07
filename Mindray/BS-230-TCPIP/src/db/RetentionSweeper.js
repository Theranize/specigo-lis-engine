/**
 * RetentionSweeper.js
 * SpeciGo LIS Integration Engine - Database retention cleanup
 *
 * Periodically deletes rows older than the configured retention window
 * from the operational tables (lis_results, lis_integration_log).
 *
 * The sweeper runs:
 *   1. Once at engine startup (via start()).
 *   2. Every `interval_minutes` minutes thereafter.
 *
 * Configuration is read from `system.config.json` under the
 * `data_retention` block:
 *
 *     "data_retention": {
 *       "days": 15,
 *       "interval_minutes": 60,
 *       "tables": ["lis_results", "lis_integration_log"]
 *     }
 *
 * Set `days` to 0 to disable cleanup entirely (useful for sites that
 * archive data via a different mechanism).
 *
 * Safety:
 *   - Uses parameterized DELETE statements
 *   - Restricts cleanup to a hardcoded allow-list of table names so a
 *     misconfigured config file cannot drop arbitrary tables
 *   - Continues on error - one table failing does not abort the run
 *   - Logs row counts for every sweep so operators can audit
 */

'use strict';

const logger = require('../logger').createLogger('CLEANUP');

// Hardcoded allow-list. Any table name in the config that is not in
// this set is rejected at construction time. This guards against
// typos and against an attacker with config-file write access turning
// the sweeper into an arbitrary DROP TABLE primitive.
const ALLOWED_TABLES = Object.freeze({
  lis_results        : { dateColumn: 'created_at' },
  lis_integration_log: { dateColumn: 'created_at' }
});

class RetentionSweeper {

  /**
   * @param {object}   options
   * @param {object}   options.dbPool          - mysql2 promise pool
   * @param {number}   [options.days=15]       - retain rows newer than this many days; 0 disables
   * @param {number}   [options.intervalMinutes=60] - sweep cadence
   * @param {string[]} [options.tables]        - subset of ALLOWED_TABLES to clean
   */
  constructor({ dbPool, days = 15, intervalMinutes = 60, tables } = {}) {
    if (!dbPool) {
      throw new Error('RetentionSweeper: dbPool is required');
    }

    this._pool             = dbPool;
    this._days             = Number(days) || 0;
    this._intervalMinutes  = Math.max(1, Number(intervalMinutes) || 60);

    const requested = Array.isArray(tables) && tables.length > 0
      ? tables
      : Object.keys(ALLOWED_TABLES);

    this._tables = requested.filter((t) => {
      if (!ALLOWED_TABLES[t]) {
        logger.warn('Ignoring unknown table in data_retention.tables', { table: t });
        return false;
      }
      return true;
    });

    this._timer   = null;
    this._running = false;

    logger.info('RetentionSweeper initialised', {
      days           : this._days,
      intervalMinutes: this._intervalMinutes,
      tables         : this._tables,
      enabled        : this._days > 0
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Begin the periodic sweep. Runs once immediately, then every
   * intervalMinutes. Idempotent.
   */
  start() {
    if (this._running) return;
    if (this._days <= 0) {
      logger.info('Retention cleanup disabled (days = 0)');
      return;
    }

    this._running = true;

    // First sweep is fire-and-forget so start() returns quickly.
    this.sweep().catch((err) => {
      logger.error('Initial sweep failed', { error: err.message });
    });

    const intervalMs = this._intervalMinutes * 60 * 1000;
    this._timer = setInterval(() => {
      this.sweep().catch((err) => {
        logger.error('Scheduled sweep failed', { error: err.message });
      });
    }, intervalMs);

    // Allow the process to exit even if the timer is pending.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * Cancel the periodic sweep. Idempotent.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
  }

  /**
   * Run one sweep across every configured table. Returns an object
   * mapping table name to deleted-row count.
   *
   * @returns {Promise<Object<string, number>>}
   */
  async sweep() {
    if (this._days <= 0) return {};

    const startedAt = Date.now();
    const result    = {};

    for (const table of this._tables) {
      const meta = ALLOWED_TABLES[table];
      try {
        const [res] = await this._pool.execute(
          `DELETE FROM \`${table}\` WHERE \`${meta.dateColumn}\` < (NOW() - INTERVAL ? DAY)`,
          [this._days]
        );
        const deleted = res.affectedRows || 0;
        result[table] = deleted;

        if (deleted > 0) {
          logger.info('Retention sweep deleted rows', {
            table,
            deleted,
            olderThanDays: this._days
          });
        } else {
          logger.debug('Retention sweep: nothing to delete', { table });
        }
      } catch (err) {
        result[table] = -1;
        logger.error('Retention sweep failed for table', {
          table,
          error: err.message
        });
      }
    }

    logger.info('Retention sweep completed', {
      durationMs: Date.now() - startedAt,
      deleted   : result
    });

    return result;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = RetentionSweeper;
