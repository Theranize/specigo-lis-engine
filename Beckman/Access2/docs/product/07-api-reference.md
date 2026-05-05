# 07 — API Reference

This chapter documents every interface the engine exposes:

- HTTP API served by the control panel (port 3003)
- JavaScript class APIs of every module

## HTTP API

Base URL: `http://localhost:3003`

All endpoints accept and return `application/json`. Successful
responses follow the shape:

```json
{ "success": true, "data": { … } }
```

Error responses:

```json
{ "success": false, "error": "human-readable message" }
```

### Engine routes

#### `GET /api/engine/status`

Returns a complete engine status snapshot.

Response `data`:
```json
{
  "running": true,
  "startedAt": "2026-05-04T10:00:00.000Z",
  "analyser": "Access 2",
  "site": "MMI Diagnostics, Raipur",
  "labUid": "6887129073FDA",
  "analyzerUid": "6887129073FDA",
  "connected": true,
  "port": "COM4",
  "baudRate": 9600,
  "isReconnecting": false,
  "serialRetrying": false,
  "lastByteAt": "2026-05-04T10:45:30.123Z",
  "dbReady": true,
  "dbRetrying": false,
  "stats": {
    "resultsReceived": 124,
    "resultsWritten": 124,
    "resultsSkipped": 0,
    "resultsFailed": 0,
    "transmissions": 32,
    "sessionsStarted": 32,
    "sessionsEnded": 32,
    "parseErrors": 0,
    "lastResultAt": "2026-05-04T10:45:30.123Z",
    "serial": { "bytesReceived": 9876, "lastByteAt": "...", "totalConnections": 1 },
    "framer": { "framesReceived": 64, "framesAcked": 64, "framesNaked": 0, "messagesEmitted": 32, "checksumErrors": 0 },
    "parser": { "messagesReceived": 32, "resultsEmitted": 124, "messagesFiltered": 0, "parseErrors": 0 },
    "mapper": { "lookups": 124, "mapped": 124, "unmappedParameter": 0, "errors": 0 }
  }
}
```

#### `POST /api/engine/start`

Starts the engine if it is currently stopped. No request body.

Response `data`:
```json
{ "message": "Engine started successfully." }
```

If the engine was already running:
```json
{ "message": "Engine is already running." }
```

#### `POST /api/engine/stop`

Stops the engine if running. No request body.

Response `data`:
```json
{ "message": "Engine stopped successfully." }
```

#### `POST /api/engine/restart`

Stops and restarts the engine. Re-reads all config files from disk.
No request body.

Response `data`:
```json
{ "message": "Engine restarted successfully." }
```

> Note: Currently the panel UI hides Start / Stop / Restart buttons.
> The endpoints exist for programmatic use.

### Results routes

#### `GET /api/results`

Returns paginated, filtered results from `lis_results`.

Query parameters (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `date` | YYYY-MM-DD | none | Filter by `DATE(created_at)` |
| `barcode` | string | none | Partial match (LIKE %x%) on `barcode_uid` |
| `parameter` | string | none | Exact match on `parameter_code`, uppercased |
| `flag` | string | none | Exact match on `flag` (e.g. `H`, `LL`) |
| `limit` | int | 50 | Page size, 1–500 |
| `page` | int | 1 | Page number, 1-based |

Response `data`:
```json
{
  "results": [
    {
      "id": 1542,
      "barcode_uid": "ABC123",
      "parameter_code": "TSH",
      "value": "2.5",
      "flag": "Normal",
      "unit": "uIU/mL",
      "patient_name": "Rahul Sharma",
      "age": 32,
      "age_type": "Y",
      "gender": "M",
      "status": 0,
      "received_at": "2026-05-04T10:45:30.000Z",
      "created_at": "2026-05-04T10:45:35.000Z"
    },
    …
  ],
  "total": 1247,
  "page": 1,
  "limit": 50,
  "pages": 25
}
```

#### `GET /api/results/barcode/:id`

Returns every parameter result for a specific sample barcode. Used by
the Sample Detail modal.

Path parameter: `:id` is the sample barcode (`barcode_uid`).

Response `data`:
```json
{
  "results": [ … same row shape as above … ],
  "count": 8
}
```

#### `POST /api/results/barcode/:id/send-to-lims`

Manually pushes every result for the given barcode to the configured
LIMS REST API. No request body.

Response `data` (success):
```json
{
  "message": "Sent 8 results to LIMS.",
  "rows": 8,
  "barcode_uid": "ABC123",
  "statusCode": 200
}
```

Response `data` (error 400 — LIMS not configured):
```json
{
  "success": false,
  "error": "LIMS API is not configured. Set lims_api.base_url in config/system.config.json."
}
```

Response `data` (error 502 — LIMS responded non-2xx):
```json
{
  "success": false,
  "error": "LIMS API responded with HTTP 503: <truncated response>"
}
```

### Logs routes

#### `GET /api/logs/today`

Returns the last N lines of today's combined log file
(`logs/combined-YYYY-MM-DD.log`).

Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 500 | Lines to return, 1–2000 |
| `level` | string | none | Filter by `ERROR` / `WARN` / `INFO` / `DEBUG` |
| `module` | string | none | Filter by module label, e.g. `ENGINE`, `SERIAL` |
| `search` | string | none | Case-insensitive substring filter |

Response `data`:
```json
{
  "date": "2026-05-04",
  "file": "combined-2026-05-04.log",
  "lines": [ "[2026-05-04 10:00:00.000] [ENGINE ] [INFO] …", … ],
  "totalMatched": 1247,
  "totalReturned": 500,
  "fileSize": 124567,
  "truncated": false
}
```

If today's log file has not been written to yet, `lines` is empty and
a friendly `message` field explains why.

For files larger than 20 MB, the engine reads only the trailing
20 MB slice and sets `truncated: true`. The first (potentially partial)
line of that slice is dropped.

## JavaScript class APIs

### `IntegrationEngine`

Exported by `src/engine/IntegrationEngine.js`.

```js
const IntegrationEngine = require('./src/engine/IntegrationEngine');

const engine = new IntegrationEngine('config/analysers/access2_config.json');
await engine.start();
…
await engine.stop();
```

Public methods:

| Method | Returns | Notes |
|---|---|---|
| `await start()` | void | Idempotent — second call logs a warning |
| `await stop()` | void | Idempotent — second call logs a warning |
| `getStatus()` | object | See HTTP `/api/engine/status` shape |
| `getDbPool()` | mysql2 pool | Throws when DB not yet ready |
| `getLimsApiConfig()` | `{base_url, api_key}` or `null` | |

### `SerialPortManager`

Exported by `src/transport/SerialPortManager.js`. Extends
`EventEmitter`.

Constructor:
```js
new SerialPortManager({
  port: 'COM4', baudRate: 9600, dataBits: 8,
  stopBits: 1, parity: 'none',
  rtscts: false, xon: false, xoff: false,
  analyzerUid: '...', labUid: '...'
})
```

Public methods:

| Method | Returns | Notes |
|---|---|---|
| `await connect()` | void | Resolves when port is open |
| `await disconnect()` | void | Includes 1.5 s OS handle release grace |
| `await write(buffer)` | void | Rejects if port is closed |
| `getStatus()` | object | `{ port, baudRate, isOpen, stats }` |

Events:

| Event | Payload | When |
|---|---|---|
| `connected` | none | After successful `connect()` |
| `disconnected` | reason: string | After port closes — caller decides whether to reconnect |
| `data` | Buffer | Raw bytes received |
| `error` | Error | Any port error |

### `ASTMFramer`

Exported by `src/protocol/ASTMFramer.js`. Extends `EventEmitter`.

Constructor:
```js
new ASTMFramer({
  writeFn: async (buffer) => { … },   // sends ACK/NAK
  checksumEnabled: true,
  maxFrameBytes: 240,
  analyzerUid: '...', labUid: '...'
})
```

Public methods:

| Method | Notes |
|---|---|
| `ingest(buffer)` | Feed raw bytes from the serial port |
| `reset()` | Discard any in-progress frame, return to IDLE |
| `getStats()` | Counter snapshot |

Events:

| Event | Payload |
|---|---|
| `transmissionStart` | (none) — fires on ENQ |
| `transmissionEnd` | (none) — fires on EOT |
| `message` | string — complete CR-delimited ASTM message |
| `error` | Error — checksum mismatch, oversized frame, etc. |

### `Access2Parser`

Exported by `src/protocol/Access2Parser.js`. Extends `EventEmitter`.

Constructor:
```js
new Access2Parser({
  messageFilters: { patient_results: true, qc_results: false, calibration_results: false },
  analyzerUid: '...', labUid: '...'
})
```

Public methods:

| Method | Notes |
|---|---|
| `parse(messageText)` | Parse one complete ASTM message |
| `getStats()` | Counter snapshot |

Events:

| Event | Payload |
|---|---|
| `sessionStart` | (none) — fires on H record |
| `sessionEnd` | (none) — fires on L record |
| `results` | `ParsedResult[]` — emitted at L record |
| `parseError` | (Error, rawMessage: string) |
| `filtered` | reason: string |

`ParsedResult` shape — see source comments at the top of
`Access2Parser.js`.

### `ParameterMapper`

Exported by `src/mapping/ParameterMapper.js`. Pure synchronous.

Constructor:
```js
new ParameterMapper({
  dbPool: pool,
  analyzerCode: 'ACCESS2',
  analyzerUid: '...', labUid: '...',
  parameter_map: { TSH: { code, lims_name, loinc_id, unit, lims_parameter_uid, lims_test_uid }, … }
})
```

Public methods:

| Method | Returns |
|---|---|
| `map(parsedResults)` | `MappedResult[]` |
| `getStats()` | Counter snapshot |

`MappedResult` shape — see source comments at the top of
`ParameterMapper.js`.

### `ResultWriter`

Exported by `src/db/ResultWriter.js`.

Constructor:
```js
new ResultWriter({
  dbPool: pool,
  analyzerUid: '...', analyzerCode: 'ACCESS2', labUid: '...',
  limsApi: { base_url, api_key }     // null disables LIMS push
})
```

Public methods:

| Method | Returns | Notes |
|---|---|---|
| `await write(mappedResults)` | void | Bulk INSERT + fire-and-forget LIMS push |
| `await logSessionEvent(eventType, labUid)` | void | Insert ENQ/EOT row into `lis_integration_log` |

### `ConnectionSupervisor`

Exported by `src/engine/ConnectionSupervisor.js`.

Constructor:
```js
new ConnectionSupervisor({
  name: 'Serial port',
  connectFn: () => /* throws on failure */ ,
  initialDelayMs: 5000,
  maxDelayMs: 60000,
  logger
})
```

Public methods:

| Method | Returns | Notes |
|---|---|---|
| `run()` | Promise<void> | Resolves on success; safe to call repeatedly |
| `notifyDisconnected()` | void | Re-enter the loop after a runtime disconnect |
| `stop()` | void | Cancel any in-flight retry |
| `isConnected()` | boolean | `true` once `connectFn()` succeeded |
| `isRetrying()` | boolean | `true` while waiting between attempts |

### `ConfigLoader`

Exported by `src/engine/ConfigLoader.js`. Static API only.

| Method | Returns |
|---|---|
| `ConfigLoader.load(analyserConfigPath)` | `{ analyserConfig, systemConfig }` |

Throws on:
- File missing
- JSON parse error
- Required field absent (`lab_uid`, `analyzer_uid`, `connection`, etc.)

### `logger`

Exported by `src/logger.js`.

| Function | Returns |
|---|---|
| `createLogger(label)` | Winston Logger |
| `getLogsDir()` | absolute path string |

### `PanelServer`

Exported by `src/panel/PanelServer.js`.

```js
const panel = new PanelServer({ engine, port: 3003 });
await panel.start();
…
await panel.stop();
```

Constructor takes `{ engine, port? }`. Default port is read from
`PANEL_PORT` env or 3003.

---

**Next:** [08 Database Schema](08-database-schema.md)
