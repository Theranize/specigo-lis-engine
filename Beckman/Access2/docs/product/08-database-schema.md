# 08 — Database Schema

The engine writes to two tables in the SpeciGo LIMS database. The
schema is shared with other parts of the SpeciGo ecosystem — only the
columns the engine reads or writes are documented here.

## Connection

The engine creates a mysql2 promise pool with these settings (not
user-configurable):

```
waitForConnections: true
queueLimit: 0
enableKeepAlive: true
keepAliveInitialDelay: 0
timezone: '+00:00'
```

`connectionLimit` defaults to 5 and is overridable via
`database.poolSize` in `system.config.json`.

## Table: `lis_results`

Primary table — every parameter measured on every sample lands here.

### Current schema

```sql
CREATE TABLE `lis_results` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lab_uid`        VARCHAR(32) NOT NULL,
  `analyzer_uid`   VARCHAR(32) NOT NULL,
  `barcode_uid`    VARCHAR(32) NOT NULL,
  `parameter_code` VARCHAR(32) NOT NULL,
  `value`          VARCHAR(50) DEFAULT NULL,
  `flag`           VARCHAR(20) DEFAULT NULL,
  `unit`           VARCHAR(20) DEFAULT NULL,
  `patient_uid`    VARCHAR(32) DEFAULT NULL,
  `patient_name`   VARCHAR(100) DEFAULT NULL,
  `age`            SMALLINT DEFAULT NULL,
  `age_type`       CHAR(1) DEFAULT NULL,
  `gender`         CHAR(1) DEFAULT NULL,
  `status`         TINYINT DEFAULT 0,
  `received_at`    DATETIME DEFAULT NULL,
  `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`, `lab_uid`),
  KEY `idx_lab_barcode`  (`lab_uid`, `barcode_uid`),
  KEY `idx_join_mapping` (`analyzer_uid`, `parameter_code`),
  KEY `idx_created_at`   (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Column reference

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT UNSIGNED auto-increment | Surrogate key |
| `lab_uid` | VARCHAR(32) | Multi-tenant identifier; from analyser config |
| `analyzer_uid` | VARCHAR(32) | Identifies the specific machine instance |
| `barcode_uid` | VARCHAR(32) | Sample tube barcode, from O record field 3 |
| `parameter_code` | VARCHAR(32) | Canonical parameter code, e.g. `TSH`. For UNMAPPED results, the raw assay code |
| `value` | VARCHAR(50) | Result value (numeric or text). VARCHAR because some assays return strings like `"Reactive"` |
| `flag` | VARCHAR(20) | Human-readable flag: `Normal`, `High`, `Critical High`, etc. NULL when no flag |
| `unit` | VARCHAR(20) | Configured unit; falls back to instrument-reported unit if config has none |
| `patient_uid` | VARCHAR(32) | **Currently never populated** — column reserved for future use |
| `patient_name` | VARCHAR(100) | "First Last" reconstructed from P record's `Last^First` field |
| `age` | SMALLINT | Years or months (see `age_type`); derived from DOB + current date |
| `age_type` | CHAR(1) | `Y` for years, `M` for months. NULL when DOB unavailable |
| `gender` | CHAR(1) | `M` or `F`. NULL for unknown |
| `status` | TINYINT | Currently always written as `0` (new). Reserved for LIMS sync status |
| `received_at` | DATETIME | From the R record's "Date/time test completed" field |
| `created_at` | DATETIME | Auto-set by MySQL when the row is inserted |

### Open improvements (planned columns)

The following columns are produced by `ParameterMapper` but **not yet**
written to the DB (BUG-002 in the improvement backlog):

| Column to add | Type | Source field | Purpose |
|---|---|---|---|
| `mapping_status` | VARCHAR(16) | mapper output | `'MAPPED'` or `'UNMAPPED'` |
| `result_status` | CHAR(1) | R record field 8 | `F` final, `P` preliminary, `C` correction, `X` cannot be done |
| `result_datetime` | DATETIME | R record field 12 | More precise than `received_at` |
| `loinc_id` | VARCHAR(32) | parameter_map | LOINC code for downstream interoperability |
| `raw_value` | VARCHAR(80) | parser | Pre-numeric-conversion text (e.g. `">250"`) |

When BUG-002 is fixed, the migration is:

```sql
ALTER TABLE lis_results
  ADD COLUMN mapping_status  VARCHAR(16) NULL AFTER status,
  ADD COLUMN result_status   CHAR(1)     NULL AFTER mapping_status,
  ADD COLUMN result_datetime DATETIME    NULL AFTER result_status,
  ADD COLUMN loinc_id        VARCHAR(32) NULL AFTER result_datetime,
  ADD COLUMN raw_value       VARCHAR(80) NULL AFTER loinc_id;

ALTER TABLE lis_results
  ADD UNIQUE KEY uk_unique_result (lab_uid, barcode_uid, parameter_code, result_datetime);

ALTER TABLE lis_results
  ADD KEY idx_mapping_status (mapping_status),
  ADD KEY idx_received_at    (received_at);
```

### Indexes

| Index | Columns | Used by |
|---|---|---|
| `PRIMARY` | `(id, lab_uid)` | Row identity. Composite is unusual — drop `lab_uid` from PK in a future migration |
| `idx_lab_barcode` | `(lab_uid, barcode_uid)` | Sample-detail lookups |
| `idx_join_mapping` | `(analyzer_uid, parameter_code)` | Mapping reconciliation queries |
| `idx_created_at` | `(created_at)` | Date range filters in the panel |

### Insert pattern

The writer issues one bulk INSERT per ASTM transmission:

```sql
INSERT INTO lis_results
  (lab_uid, analyzer_uid, barcode_uid, parameter_code, unit, value, flag,
   patient_name, age, age_type, gender, status, received_at)
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
  …
```

A typical Access 2 transmission has 1–8 R records (one per ordered
parameter). The bulk INSERT keeps DB roundtrips minimal.

## Table: `lis_integration_log`

Audit log for ASTM session boundaries.

### Schema

```sql
CREATE TABLE `lis_integration_log` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `lab_uid`      VARCHAR(32),
  `analyzer_uid` VARCHAR(32),
  `session_type` VARCHAR(16),     -- 'ENQ' | 'EOT' | (future: 'ERROR', 'CONNECT', 'DISCONNECT')
  `message_code` VARCHAR(16),
  `details`      TEXT,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Column reference

| Column | Notes |
|---|---|
| `lab_uid` | From analyser config |
| `analyzer_uid` | From analyser config |
| `session_type` | `'ENQ'` on transmission start, `'EOT'` on transmission end |
| `message_code` | Same as `session_type` (legacy) |
| `details` | Human description: `"ASTM transmission session started (ENQ received)"` |
| `created_at` | Auto-set |

The engine writes one row per ENQ and one per EOT, which lets you
audit transmission frequency and detect interrupted sessions.

## Table: `lab_analyzer_parameters`

**Read-only from the engine's perspective.** Used by the (now-removed)
old REST API for mapping CRUD. The current engine does not query or
modify this table — `ParameterMapper` reads its config from the JSON
file instead.

```sql
CREATE TABLE `lab_analyzer_parameters` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `lab_uid`             VARCHAR(32),
  `analyzer_code`       VARCHAR(32),       -- 'ACCESS2'
  `parameter_code`      VARCHAR(32),
  `online_test_no`      VARCHAR(32),
  `lims_parameter_uid`  VARCHAR(32),
  `lims_test_uid`       VARCHAR(32),
  `unit`                VARCHAR(20),
  `is_active`           TINYINT(1) DEFAULT 1
);
```

The schema is documented here for reference because the panel UI's
"Mapping editor" tab (planned) will write to it.

## Table: `lab_analyzers`

Also read-only from the engine. Stores analyser registration metadata.
The engine identifies itself via `analyzer_uid` from the JSON config
rather than looking up this table.

## Sample queries

### Today's results, latest first

```sql
SELECT id, barcode_uid, parameter_code, value, flag, unit, received_at
FROM lis_results
WHERE lab_uid = '6887129073FDA'
  AND DATE(created_at) = CURDATE()
ORDER BY created_at DESC
LIMIT 100;
```

### Find a specific sample

```sql
SELECT *
FROM lis_results
WHERE lab_uid     = '6887129073FDA'
  AND barcode_uid = 'ABC123'
ORDER BY parameter_code;
```

### Abnormal results in the last 24 hours

```sql
SELECT id, barcode_uid, parameter_code, value, flag, unit, received_at
FROM lis_results
WHERE lab_uid    = '6887129073FDA'
  AND created_at >= NOW() - INTERVAL 24 HOUR
  AND flag IS NOT NULL
  AND flag NOT IN ('Normal', '')
ORDER BY created_at DESC;
```

### Transmissions per hour today

```sql
SELECT HOUR(created_at) AS hr, COUNT(*) AS transmissions
FROM lis_integration_log
WHERE lab_uid      = '6887129073FDA'
  AND session_type = 'ENQ'
  AND DATE(created_at) = CURDATE()
GROUP BY HOUR(created_at)
ORDER BY hr;
```

### Parameter usage over the last week

```sql
SELECT parameter_code, COUNT(*) AS n_results
FROM lis_results
WHERE lab_uid    = '6887129073FDA'
  AND created_at >= NOW() - INTERVAL 7 DAY
GROUP BY parameter_code
ORDER BY n_results DESC;
```

### Distinct patients today

```sql
SELECT COUNT(DISTINCT barcode_uid) AS samples_today
FROM lis_results
WHERE lab_uid = '6887129073FDA'
  AND DATE(created_at) = CURDATE();
```

## Auto-retention (RetentionSweeper)

The engine deletes operational rows older than the configured retention
window. This keeps the live database lean — historical data should
live in archival storage (LIMS data warehouse, cold backups), not in
`lis_results`.

### How it works

A `RetentionSweeper` instance is built when the DB pool comes up. It:

1. Runs one cleanup pass immediately at engine startup.
2. Sets a `setInterval(..)` to repeat every `interval_minutes`.
3. For each table in the configured `tables` list, executes:
   ```sql
   DELETE FROM <table> WHERE created_at < (NOW() - INTERVAL ? DAY)
   ```
   parameterised with `data_retention.days`.
4. Logs the deleted row count per table to the `CLEANUP` module.

### Configuration

In `config/system.config.json`:

```json
"data_retention": {
  "days": 15,
  "interval_minutes": 60,
  "tables": ["lis_results", "lis_integration_log"]
}
```

| Field | Default | Notes |
|---|---|---|
| `days` | 15 | Set to 0 to disable cleanup entirely |
| `interval_minutes` | 60 | Minimum 1 minute |
| `tables` | both supported tables | Allow-listed in source code |

See [04 Configuration § `data_retention.*`](04-configuration.md) for
the complete reference.

### Safety guarantees

- Table names are validated against a **hardcoded allow-list** in
  `src/db/RetentionSweeper.js`. Names not in this list (typos, or
  malicious additions) are rejected with a warning and ignored.
- Every DELETE is parameterised — no SQL injection surface.
- If one table's DELETE fails (lock timeout, missing permission), the
  sweep continues with the next table; the failure is logged.
- The sweep timer uses `unref()` so it does not keep the Node process
  alive on shutdown.

### Verifying it ran

Open the panel's Logs tab, filter Module = `CLEANUP`. You should see
one INFO line per sweep:

```
[CLEANUP] [INFO] Retention sweep deleted rows  {"table":"lis_results","deleted":42,"olderThanDays":15}
[CLEANUP] [INFO] Retention sweep completed     {"durationMs":156,"deleted":{"lis_results":42,"lis_integration_log":12}}
```

If `deleted` shows 0 for every table, either the retention window is
generous (no rows are old enough yet) or the cleanup is disabled
(`days: 0`).

## Backup recommendations

The engine does not back up the database. Operations should:

- Take a daily `mysqldump` of `lis_results` and `lis_integration_log`
  **before** the retention window expires (otherwise data older than
  `data_retention.days` is permanently gone)
- Retain 30+ days of dumps minimum (medical-record retention varies
  by jurisdiction; check local rules)
- Test restore quarterly

The engine is a pure consumer of the DB — losing the engine PC does
**not** lose any data, provided the DB is hosted elsewhere.

---

**Next:** [09 ASTM Protocol Reference](09-astm-protocol.md)
