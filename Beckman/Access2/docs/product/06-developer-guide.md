# 06 — Developer Guide

This chapter is for engineers contributing to the codebase. It covers
project conventions, where to find things, and how to extend the
engine safely.

## Setup

```powershell
git clone <repo-url>
cd Access2
npm install
```

Create a local `config/system.config.json` with development credentials
(see [04 Configuration](04-configuration.md)). Pointing at a local
MySQL instance is fastest for iteration:

```json
{
  "database": { "host": "127.0.0.1", "port": 3306, "user": "root",
                "password": "root", "database": "lis_db", "poolSize": 5 },
  "lims_api": { "base_url": "http://127.0.0.1:9000", "api_key": "dev" },
  "logger":   { "log_level": "debug", "retention_days": 7 }
}
```

Run with verbose logging:

```powershell
node index.js
```

## Repository conventions

### Code style

- **Strict mode everywhere** — every file starts with `'use strict';`
- **No build step** — pure CommonJS, no TypeScript, no transpilation
- **Tabular alignment for option blocks** is permitted and used
  consistently, e.g.:
  ```js
  const port = new SerialPort({
    path    : 'COM4',
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity  : 'none',
    autoOpen: false
  });
  ```
- **Constants are SCREAMING_SNAKE** — `MAX_FRAME_BODY_BYTES`,
  `RECONNECT_INITIAL_DELAY_MS`
- **Private fields prefixed with `_`** — `_dbPool`, `_running`,
  `_isOpen`. ES private fields (`#field`) are not used (avoiding
  build-step compatibility concerns)
- **JSDoc on every public method**, including `@param` types and
  `@returns`
- **Module headers** — every file starts with a multi-line `/** … */`
  block describing its purpose
- **Comments stay in English** — even when the rest of the team is
  speaking another language. This rule is hard.

### Naming patterns

- **Method names**: `verbNoun()` — `loadConfig`, `openPort`, `mapResults`
- **Event names**: lower-case single words — `'data'`, `'connected'`,
  `'message'`, `'transmissionStart'` (camelCase for compound names)
- **Internal helpers**: `_camelCase()` with leading underscore
- **DB-shaped objects**: `snake_case` (matches column names) —
  `parameter_code`, `lab_uid`, `barcode_uid`
- **Code-shaped objects**: `camelCase` — `parsedResult.assayCode`,
  `parsedResult.numericValue`

The mix is intentional — DB fields use snake_case because that's what
MySQL columns use; in-memory parsed objects use camelCase because
that's idiomatic JS. The ParameterMapper is the place where the two
shapes meet and convert.

### Logging conventions

Every module gets its logger via:

```js
const logger = require('./logger').createLogger('MODULE_NAME');
```

The label is uppercased and padded to 7 characters (e.g. `[ENGINE ]`,
`[ACCESS2]`). Use these labels:

| Module | Label |
|---|---|
| `index.js` | `INDEX` |
| `IntegrationEngine` | `ENGINE` |
| `ConfigLoader` | `CONFIG` |
| `SerialPortManager` | `SERIAL` |
| `ASTMFramer` | `FRAMER` |
| `Access2Parser` | `ACCESS2` |
| `ParameterMapper` | `MAPPER` |
| `ResultWriter` | `WRITER` |
| `PanelServer` | `PANEL` |

Levels:
- `error` — something failed; operator may need to act
- `warn` — degraded but recoverable; auto-recovery in progress
- `info` — normal lifecycle event (start/stop, connect, message)
- `debug` — byte-level traces; off in production

Always pass a context object as the second arg:
```js
logger.info('Frame dispatch', { frameNo, bodyLength, terminator });
```

## Module-level reference

### `index.js`

Entry point. Performs:
1. Logs directory creation
2. `.env` loading
3. Reading `log_level` from `system.config.json` and copying to
   `process.env.LOG_LEVEL` **before** any module-level logger is
   constructed
4. Creating `IntegrationEngine` and `PanelServer`
5. Starting both

The ordering in step 3 matters — Winston loggers freeze their level at
construction time. If a module is required before LOG_LEVEL is set,
its logger uses the default `'debug'` level forever.

### `src/logger.js`

Single source of truth for logger config. Exports:
- `createLogger(label)` — returns a configured Winston logger
- `getLogsDir()` — returns the absolute path to `logs/`

Reads `retention_days` from `system.config.json` once at module load.
Creates the `logs/` directory if missing.

### `src/engine/ConfigLoader.js`

Static class with one public method:
- `ConfigLoader.load(analyserConfigPath)` →
  `{ analyserConfig, systemConfig }`

Throws on missing/malformed files or required fields absent.

### `src/engine/ConnectionSupervisor.js`

Generic retry-with-exponential-backoff loop. Used twice in the engine
(once for serial, once for DB).

```js
const sup = new ConnectionSupervisor({
  name: 'X',
  connectFn: async () => { /* throws on failure */ },
  initialDelayMs: 5000,
  maxDelayMs: 60000,
  logger
});

sup.run();                  // start the loop (fire-and-forget)
sup.notifyDisconnected();   // re-enter loop after a runtime disconnect
sup.stop();                 // cancel
sup.isConnected();          // true once connectFn() succeeded
sup.isRetrying();           // true while waiting between attempts
```

### `src/engine/IntegrationEngine.js`

Orchestrator. Public API:
- `new IntegrationEngine(configFilePath)`
- `await engine.start()`
- `await engine.stop()`
- `engine.getStatus()` — full snapshot
- `engine.getDbPool()` — throws if DB not yet ready
- `engine.getLimsApiConfig()` — `{ base_url, api_key }` or `null`

Private methods of note:
- `_initialiseModules()` — constructs SerialPortManager / Framer /
  Parser and wires events
- `_initialiseDbModules(pool)` — constructs Mapper / Writer
- `_buildSupervisors()` — instantiates the two supervisors
- `_createDbPool()` — actually creates the mysql2 pool
- `_writeToPort(buffer)` — thin wrapper around
  `_serialManager.write(buffer)`, used by ASTMFramer for ACK/NAK

### `src/transport/SerialPortManager.js`

Wraps node-serialport. EventEmitter-based.

Public:
- `await connect()`
- `await disconnect()`
- `await write(buffer)` — for ACK/NAK
- `getStatus()`

Events: `'connected'`, `'disconnected'`, `'data'`, `'error'`.

Notable defensive code:
- Settle guard in `_openPort` so duplicate `error`/`close`/`open`
  events don't double-resolve
- Listener detach + 1.5 s grace period in `_closePort` for Windows
  COM-handle release
- `cleanupFailedPort()` on initial-open failure

### `src/protocol/ASTMFramer.js`

State machine for ASTM E1394. State diagram:

```
    IDLE  ──ENQ──→  TRANSMISSION  ──STX──→  IN_FRAME
                       ↑              │
                       │       (ETX or ETB)
                       │              ↓
                       └─ CHECKSUM1 ←┘
                                ↓
                          CHECKSUM2
                                ↓
                          AWAIT_CR
                                ↓
                          AWAIT_LF
                                ↓
                          (back to TRANSMISSION)

    Anywhere ──EOT──→  IDLE
```

Public:
- `ingest(buffer)` — feed bytes from the serial port
- `reset()` — discard in-progress frame, return to IDLE
- `getStats()` — counters

Events: `'transmissionStart'`, `'transmissionEnd'`, `'message'`,
`'error'`.

The framer never throws — protocol errors emit NAK and clear state.

### `src/protocol/Access2Parser.js`

Parses complete ASTM messages emitted by the framer. Implements the
record formats specific to the Beckman Coulter Access 2.

Public:
- `parse(messageText)`
- `getStats()`

Events: `'sessionStart'`, `'sessionEnd'`, `'results'`,
`'parseError'`, `'filtered'`.

The parser is stateful — it remembers H/P/O context across calls
within one transmission session, then emits the accumulated R records
on `L`.

### `src/mapping/ParameterMapper.js`

Pure function over the `parameter_map` config block. No I/O, no DB
calls.

Public:
- `map(parsedResults)` → `MappedResult[]`

Result shape (subset):
```
{
  lab_uid, analyzer_uid, barcode_uid,
  parameter_code, loinc_id, unit, value, raw_value, flag,
  patient_name, age_year, age_month, age_type, gender,
  result_status, result_datetime, mapping_status
}
```

`mapping_status` is `'MAPPED'` or `'UNMAPPED'`.

### `src/db/RetentionSweeper.js`

Periodic DELETE-old-rows job. Built and started as part of
`_initialiseDbModules(pool)` once the DB connection is verified.

Public API:
```js
new RetentionSweeper({
  dbPool, days, intervalMinutes, tables
});

sweeper.start();    // first sweep immediately, then every intervalMinutes
sweeper.stop();     // cancel the timer
await sweeper.sweep();  // manual one-shot sweep, returns { table: deleted_count }
```

The list of cleanable tables is constrained by a hardcoded allow-list
inside the module (`ALLOWED_TABLES`). Adding a new table requires a
code change — this is intentional, see the inline comment for
rationale.

### `src/db/ResultWriter.js`

Persists mapped results to MySQL and (fire-and-forget) to the LIMS
REST API.

Public:
- `await write(mappedResults)` — bulk INSERT into `lis_results`
- `await logSessionEvent(eventType, labUid)` — INSERT into
  `lis_integration_log`

Internal:
- `_sendToLimsApi(results)` — fire-and-forget HTTP POST
- `_parseAstmDatetime(dt)` — converts `YYYYMMDDHHMMSS` → MySQL datetime
- `_nullIfEmpty(v)` — utility for NULL coercion

The writer never throws on its own errors — they are logged and the
batch is marked failed. (See improvement backlog item: "no retry queue
for LIMS push".)

### `src/panel/*`

Express server on port 3003 serving the panel UI and three route groups:
- `engineRoutes` — `/api/engine/status`, `/api/engine/start|stop|restart`
- `resultsRoutes` — `/api/results`, `/api/results/barcode/:id`,
  `/api/results/barcode/:id/send-to-lims`
- `logsRoutes` — `/api/logs/today`

The UI (`public/index.html`) is a single-file SPA. No bundler.

## Adding a new module

The standard pattern:

1. Create `src/<area>/<MyModule>.js`
2. At the top:
   ```js
   'use strict';
   const { EventEmitter } = require('events'); // if it emits events
   const logger = require('../logger').createLogger('MYMOD');
   ```
3. Constructor takes an options object with required validation
4. Public methods documented with JSDoc
5. Private methods prefixed `_`
6. Stats counters in `this.stats` if applicable
7. Exported as default: `module.exports = MyModule;`

Wire it into `IntegrationEngine._initialiseModules()` and add event
handlers there.

## Adding a new HTTP endpoint

Decide which route group it belongs to (`engine`, `results`, `logs`).
Add a handler in the appropriate `src/panel/routes/*.js`. Keep the
panel UI in sync — edit `src/panel/public/index.html`.

Conventions:
- Success: `res.json({ success: true, data: { … } })`
- Failure: `res.status(N).json({ success: false, error: 'message' })`
- Use `getPool(engine)` (which calls `engine.getDbPool()`) — never
  reach into `engine._dbPool` directly

## Adding a new ASTM record type

The Access 2 emits H/P/O/R/L plus Q (Query) and C (Comment), the
latter two of which we currently ignore. To handle a new record type:

1. Add a `case` in `Access2Parser._processRecords()`
2. Implement `_parseXxxRecord(record, callback)` following the pattern
   of existing parsers
3. Update the parsed-result shape if the record contributes new fields
4. Update `ParameterMapper.map()` to propagate the new fields
5. Update `ResultWriter.write()` SQL + params if persisting
6. Add a column to `lis_results` schema

## Adding a new analyser

The Beckman Access 2 implementation is one possible front-end to the
SpeciGo LIS pipeline. To add another vendor:

1. Create a new directory at the same level (e.g.
   `Beckman/AU480` or `Roche/Cobas`)
2. Reuse `SerialPortManager`, `ASTMFramer`, `ResultWriter`, the
   logger, and the panel — these are vendor-agnostic
3. Write a new `Cobas6000Parser.js` (or similar) that translates the
   vendor's protocol quirks
4. Write a new `analyser_config.json` with the vendor-specific
   parameter map

The pipeline shape stays the same; only the parser and config change.

## Debugging tips

- Set `log_level` to `"debug"` in `system.config.json` to see byte-level
  hex dumps from the framer
- Use `test/simulate_access2.js` to replay canned ASTM messages without
  needing the real analyser
- The Logs tab in the panel is a strict superset of `tail -f
  logs/combined-<today>.log` — you don't need a terminal
- For a hung port, check the SerialPort settle guard's `cleanupFailedPort`
  is firing — look for "Closing serial port" log lines

## Testing

There is no automated test suite yet (see IMPROVEMENTS.md). The
manual integration test:

```powershell
npm run simulate
```

…runs `test/simulate_access2.js`, which opens a virtual COM port and
emits canned ASTM messages. Useful when refactoring the framer or
parser.

When tests are added, they will go in `test/` and use Vitest or Jest.
The architecture is highly testable because every module accepts its
dependencies via constructor options.

## Building executables for production

Production deployments use a single self-contained executable per
OS, built with [`pkg`](https://github.com/vercel/pkg). The lab PC then
needs no Node.js install.

The build configuration lives in `package.json`:

```json
"bin": "index.js",
"pkg": {
  "scripts": ["index.js"],
  "assets": [
    "config/**/*",
    "node_modules/@serialport/**/*"
  ]
}
```

- `scripts` — JS files baked into the executable's snapshot
- `assets` — non-JS files that must remain accessible at runtime
  (notably the SerialPort native binding)

### One-time setup

```bash
npm install -g pkg
```

### Per-build steps

```bash
# Clean previous installs for a deterministic build
rm -rf node_modules package-lock.json

# Production deps only
npm install --production

# Rebuild native bindings against the runtime pkg will bundle
npm rebuild

# Build for each target you need
pkg . --targets node18-win-x64   --output specigo-lis-engine.exe
pkg . --targets node18-linux-x64 --output specigo-lis-engine-linux
pkg . --targets node18-macos-x64 --output specigo-lis-engine-macos
```

Output appears in the project root.

### When to add to `pkg.assets`

Any file your code reads at runtime via `fs.readFileSync()` or
`require()` of a non-JS path must be listed in `pkg.assets`. Common
additions:

- A new native binding under `node_modules/`
- The panel UI assets (`src/panel/public/**/*`)
- Migration SQL files
- Static lookup tables in JSON/CSV form

Forgetting an asset typically manifests as a runtime "ENOENT" or
"native binding not found" error on the deployed machine even though
`npm start` works locally.

### Icon and signing (Windows)

For branded distribution, see
[03 Installation §B.7–B.8](03-installation.md). The two-step build
script for a fully branded, signed Windows binary:

```powershell
pkg . --targets node18-win-x64 --output specigo-lis-engine.exe
rcedit  specigo-lis-engine.exe --set-icon icon.ico
signtool sign /f certificate.pfx /p "$env:CERT_PASSWORD" `
              /t http://timestamp.digicert.com /fd SHA256 `
              specigo-lis-engine.exe
```

### CI considerations (when CI is added)

The build matrix would be:

```yaml
strategy:
  matrix:
    target:
      - node18-win-x64
      - node18-linux-x64
      - node18-macos-x64
```

Native rebuilds must run on the same OS family as the target — pkg
cannot cross-compile native bindings. In practice that means a
GitHub Actions workflow with `runs-on` matching each target's OS,
or a self-hosted runner per platform.

## Pull request checklist

Before opening a PR:

- [ ] Code runs (`npm start` succeeds locally)
- [ ] No `_destroyed`, `_isReconnecting`, or other removed symbols
      reintroduced
- [ ] No private-field access across modules (use the public accessors)
- [ ] Logger label is correct and consistent
- [ ] Comments are in English
- [ ] Doc updated if behaviour changed (this folder + relevant chapter)
- [ ] No commit of secrets — `system.config.json` stays gitignored

---

**Next:** [07 API Reference](07-api-reference.md)
