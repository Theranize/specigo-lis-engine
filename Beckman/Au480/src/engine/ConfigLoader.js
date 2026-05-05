/**
 * ConfigLoader.js
 * SpeciGo LIS Integration Engine - Config bootstrap
 *
 * Reads and validates the two JSON files the engine depends on:
 *   1. The analyser-specific config passed in by the caller
 *      (e.g. config/analysers/au480_config.json).
 *   2. The system-wide config at config/system.config.json (DB
 *      credentials + LIMS API).
 *
 * Throws a descriptive Error on missing files, malformed JSON, or any
 * required field absent. The engine treats these as fatal at startup -
 * the operator must fix the config and restart.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const logger = require('../logger').createLogger('CONFIG');

const REQUIRED_TOP_LEVEL  = ['lab_uid', 'analyzer_uid', 'connection', 'protocol', 'parameter_map'];
const REQUIRED_CONNECTION = ['port', 'baudRate', 'dataBits', 'stopBits', 'parity'];

class ConfigLoader {

  /**
   * Load both config files.
   *
   * @param {string} analyserConfigPath - absolute or cwd-relative path
   * @returns {{ analyserConfig: object, systemConfig: object|null }}
   */
  static load(analyserConfigPath) {
    const analyserConfig = ConfigLoader._loadAnalyserConfig(analyserConfigPath);
    const systemConfig   = ConfigLoader._loadSystemConfig();
    return { analyserConfig, systemConfig };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  static _loadAnalyserConfig(filePath) {
    const absPath = path.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse config file ${absPath}: ${err.message}`);
    }

    for (const field of REQUIRED_TOP_LEVEL) {
      if (!cfg[field]) {
        throw new Error(`Config file missing required field: "${field}"`);
      }
    }

    for (const field of REQUIRED_CONNECTION) {
      if (cfg.connection[field] === undefined) {
        throw new Error(`Config connection block missing required field: "${field}"`);
      }
    }

    logger.info('Analyser config loaded', {
      analyser: cfg.model,
      site    : cfg.site,
      port    : cfg.connection.port
    });

    return cfg;
  }

  static _loadSystemConfig() {
    const systemConfigPath = path.join(process.cwd(), 'config', 'system.config.json');

    if (!fs.existsSync(systemConfigPath)) {
      logger.warn('system.config.json not found - falling back to environment variables', {
        path: systemConfigPath
      });
      return null;
    }

    try {
      const cfg = JSON.parse(fs.readFileSync(systemConfigPath, 'utf8'));
      logger.info('System config loaded', { path: systemConfigPath });
      return cfg;
    } catch (err) {
      throw new Error(`Failed to parse system config: ${err.message}`);
    }
  }
}

module.exports = ConfigLoader;
