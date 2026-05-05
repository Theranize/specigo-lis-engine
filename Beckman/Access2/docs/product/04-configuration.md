# 04 — Configuration Reference

The engine reads two JSON files at startup. Both must exist and parse
cleanly or the engine will refuse to start.

| File | Purpose | Tracked in git? |
|---|---|---|
| `config/system.config.json` | DB credentials, LIMS API, log settings | **No** (contains secrets) |
| `config/analysers/access2_config.json` | Analyser identity, parameter map | Yes |

Environment variables can override most fields in `system.config.json`
— useful for production hardening.

## `config/system.config.json`

This is the system-wide configuration file. It contains operational
settings that vary between environments (dev / staging / production)
and **must contain real credentials**, so it is `.gitignore`d and must
be created manually on every host.

### Full schema

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "lis_engine",
    "password": "<password>",
    "database": "lis_db",
    "poolSize": 5
  },
  "lims_api": {
    "base_url": "https://lims.example.com",
    "api_key": "<api-key>"
  },
  "logger": {
    "log_level": "info",
    "retention_days": 14
  }
}
```

### Field reference

#### `database.*`

| Field | Type | Default (env fallback) | Description |
|---|---|---|---|
| `host` | string | `DB_HOST` | MySQL hostname or IP |
| `port` | integer | `DB_PORT` (3306) | TCP port |
| `user` | string | `DB_USER` | DB username |
| `password` | string | `DB_PASSWORD` | DB password |
| `database` | string | `DB_NAME` | Schema name (e.g. `lis_db`) |
| `poolSize` | integer | `DB_POOL_SIZE` (5) | Max concurrent connections |

If any of `host`, `user`, `password`, or `database` is missing **and**
no env var supplies it, the engine throws on startup with:
```
Database credentials missing. Set in config/system.config.json or
environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).
```

The pool is configured with `enableKeepAlive: true` and
`timezone: '+00:00'`. These are not user-tunable.

#### `lims_api.*`

| Field | Type | Required? | Description |
|---|---|---|---|
| `base_url` | string | Yes (for LIMS push) | Root URL of the LIMS REST API. The engine appends `/lis/store-analyzer-result` |
| `api_key` | string | Yes (for LIMS push) | Sent in the request body as `api_key` |

If `lims_api` is missing or has no `base_url`, the engine still works:
results land in the local DB, but no LIMS push is attempted.
`getLimsApiConfig()` returns `null` in that case, and the panel's
"Send to LIMS" button returns an HTTP 400 with a clear error message.

#### `logger.*`

| Field | Type | Default | Description |
|---|---|---|---|
| `log_level` | string | `'debug'` | Winston level: `error` / `warn` / `info` / `debug` |
| `retention_days` | integer | 14 | Days the daily-rotated log files are kept on disk |

Use `info` in production, `debug` during commissioning. The
`log_level` value is read once at startup and copied into
`process.env.LOG_LEVEL` so all Winston instances see it.

### Environment variables

Useful to keep secrets out of the JSON file in production:

| Variable | Overrides |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_SIZE` | `database.*` |
| `LOG_LEVEL` | `logger.log_level` |
| `CONFIG_FILE` | Default analyser config path |
| `PANEL_PORT` | Panel HTTP port (default 3003) |

Env vars are only consulted if the corresponding JSON field is missing.
JSON values take precedence.

The recommended production pattern is:

```json
{
  "database": { "host": "", "user": "", "password": "", "database": "" },
  "lims_api": { "base_url": "", "api_key": "" },
  "logger":   { "log_level": "info", "retention_days": 14 }
}
```

…with a `.env` (also gitignored) supplying the secrets:

```
DB_HOST=db.internal
DB_USER=lis_engine
DB_PASSWORD=…
DB_NAME=lis_db
```

## `config/analysers/access2_config.json`

Analyser-specific configuration. Each Beckman Access 2 instance has its
own file (rename the file if running multiple analysers from one PC,
which is not the recommended pattern — run one Service per analyser).

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `lab_uid` | string | Multi-tenant lab identifier; identifies the LIMS tenant |
| `analyzer_uid` | string | Unique identifier for this specific analyser; used as a foreign key in `lis_results` |
| `manufacturer` | string | Static metadata: `"Beckman Coulter"` |
| `model` | string | Static metadata: `"Access 2"` |
| `model_family` | string | Static metadata: `"Access Series"` |
| `category` | string | Static metadata: `"Immunoassay Analyser"` |
| `site` | string | Human-readable site name (shown in the panel) |
| `serial_number` | string | Physical serial of the analyser; for audit |
| `connection` | object | Serial port settings (see below) |
| `protocol` | object | ASTM byte values (see below) |
| `lis_settings` | object | Reflective copy of the analyser's LIS Settings screen; **read-only**, only logged for traceability |
| `message_filters` | object | Which categories of results to process |
| `parameter_map` | object | Assay code → LIMS UID lookup (see below) |

### `connection`

```json
"connection": {
  "type": "serial",
  "port": "COM4",
  "baudRate": 9600,
  "dataBits": 8,
  "stopBits": 1,
  "parity": "none",
  "flowControl": "none",
  "rtscts": false,
  "xon": false,
  "xoff": false
}
```

| Field | Type | Required? | Description |
|---|---|---|---|
| `port` | string | Yes | OS device path (e.g. `"COM4"` on Windows) |
| `baudRate` | integer | Yes | 9600 for Access 2 |
| `dataBits` | integer | Yes | 8 |
| `stopBits` | integer | Yes | 1 |
| `parity` | string | Yes | `"none"` |
| `rtscts`, `xon`, `xoff` | boolean | Optional | Hardware/software flow control. All `false` for Access 2 |

The engine no longer reads an `autoOpen` field — it is always set to
`false` internally because the listener-attach order requires it.

### `protocol`

```json
"protocol": {
  "standard": "ASTM E1394 / LIS2-A2",
  "enqByte": "0x05",
  "eotByte": "0x04",
  "stxByte": "0x02",
  "etxByte": "0x03",
  "etbByte": "0x17",
  "ackByte": "0x06",
  "nakByte": "0x15",
  "checksumEnabled": true,
  "fieldDelimiter": "|",
  "componentDelimiter": "^",
  "repeatDelimiter": "\\",
  "escapeCharacter": "&",
  "maxFrameBytes": 240
}
```

Only `checksumEnabled` and `maxFrameBytes` are read by the framer. The
byte values are documented for traceability — the framer hard-codes
them per the ASTM spec.

| Field | Type | Effect |
|---|---|---|
| `checksumEnabled` | boolean | When `false`, the framer accepts frames without verifying CS1+CS2. Use only for diagnostics |
| `maxFrameBytes` | integer | Frame body length cap. Default 240 per ASTM spec. NAK is sent on frames exceeding this |

### `message_filters`

```json
"message_filters": {
  "patient_results": true,
  "qc_results": false,
  "calibration_results": false
}
```

Controls which result categories are processed. Currently:
- Patient samples → mapped + written to DB + pushed to LIMS
- QC and calibration samples → identified via barcode prefix
  (`QC*`, `CAL*`), then logged and dropped

Set `qc_results` or `calibration_results` to `true` to enable those
categories without code changes.

### `parameter_map`

The most important block. Each entry maps an ASTM assay code (the
short code emitted in the R record's Universal Test ID field) to:

- The canonical parameter code stored in `lis_results.parameter_code`
- The full human-readable name
- The LOINC ID (for downstream interoperability)
- The expected unit
- The LIMS parameter UID (must be filled before go-live)
- The LIMS test UID

Example entry:

```json
"TSH": {
  "code": "TSH",
  "lims_name": "Thyroid Stimulating Hormone",
  "loinc_id": "11580-8",
  "unit": "uIU/mL",
  "lims_parameter_uid": "[SET_AT_GO_LIVE]",
  "lims_test_uid": "[SET_AT_GO_LIVE]"
}
```

If the analyser sends an assay code not in this map, the result is
written with `mapping_status = 'UNMAPPED'` and visible in the panel
for an administrator to map.

| Key | Type | Required? | Description |
|---|---|---|---|
| `code` | string | Yes | Canonical parameter code (usually same as the map key) |
| `lims_name` | string | Yes | Display name |
| `loinc_id` | string | Recommended | LOINC code; preserves semantic mapping for downstream systems |
| `unit` | string | Recommended | Overrides the analyser's unit string in the DB |
| `lims_parameter_uid` | string | Required for go-live | Sent verbatim to LIMS |
| `lims_test_uid` | string | Required for go-live | Sent verbatim to LIMS |

The shipped config has 33 immunoassays pre-populated with `code`,
`lims_name`, `loinc_id`, and `unit`. The two LIMS UIDs are
`[SET_AT_GO_LIVE]` placeholders — they must be replaced.

## Hot reload

There is **no** hot reload. Configuration is read once at startup. To
apply config changes:

```powershell
Restart-Service "SpeciGo LIS Access 2"
```

This is intentional — silent runtime config changes are a common
source of "it worked yesterday" outages.

## Validation rules summary

The engine validates these at startup and refuses to run if violated:

- `lab_uid`, `analyzer_uid`, `connection`, `protocol`, `parameter_map`
  are all present
- `connection.port`, `baudRate`, `dataBits`, `stopBits`, `parity` are
  all defined
- `system.config.json` is parseable JSON if present (a missing file is
  tolerated; only env vars are then used)
- `database.host`, `user`, `password`, `database` are all non-empty
  (combined from JSON + env)

The engine does **not** currently validate:

- `parameter_map` UIDs aren't `[SET_AT_GO_LIVE]` placeholders
- COM port actually exists on the system
- DB schema matches what the writer expects
- LIMS API URL is reachable

These validations are on the improvement backlog.

---

**Next:** [05 User Manual](05-user-manual.md)
