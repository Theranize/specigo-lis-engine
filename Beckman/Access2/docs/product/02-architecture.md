# 02 — Architecture

## Module map

The engine is structured as a vertical pipeline. Each module owns one
concern and emits events for the next stage.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          IntegrationEngine                          │
│                  (orchestrator, public API, lifecycle)              │
└─────┬──────────────┬───────────────────────────────────────────┬────┘
      │              │                                           │
      ▼              ▼                                           ▼
┌─────────┐  ┌──────────────────┐                       ┌──────────────┐
│ Config  │  │  Connection      │                       │  Panel       │
│ Loader  │  │  Supervisor (×2) │                       │  Server      │
└─────────┘  └──────────────────┘                       └──────────────┘
                  serial, db                              port 3003

  Pipeline (event-driven):

  SerialPortManager → ASTMFramer → Access2Parser → ParameterMapper → ResultWriter
       (bytes)        (frames)      (records)        (mapped)         (DB + LIMS)
```

## Layered responsibilities

| Layer | Module | What it knows | What it does |
|---|---|---|---|
| Transport | `SerialPortManager` | RS-232, COM port, baud | Open/close serial port; emit raw byte buffers |
| Protocol | `ASTMFramer` | ASTM bytes (ENQ/STX/ETX) | Run state machine; verify checksums; reassemble frames into messages |
| Protocol | `Access2Parser` | ASTM record format (H/P/O/R/L) | Parse messages into structured `ParsedResult` objects |
| Mapping | `ParameterMapper` | Assay code → LIMS UID | Translate analyser codes to LIMS identifiers |
| Persistence | `ResultWriter` | MySQL + LIMS REST schema | Bulk INSERT to local DB; HTTP POST to LIMS |
| Orchestration | `IntegrationEngine` | All of the above | Wire modules together, manage lifecycle, expose status |
| Bootstrap | `ConfigLoader` | JSON config files | Read and validate configuration |
| Lifecycle | `ConnectionSupervisor` | Retry policy | Reusable retry-with-backoff loop for serial + DB |
| Logging | `logger` | Winston transports | Single source of truth for log format and retention |
| Control | `PanelServer` + routes | HTTP, panel UI | Serve UI, expose status / results / logs / send-to-LIMS endpoints |

## File layout

```
Access2/
├── index.js                              # Entry point — boots engine + panel
├── package.json
├── config/
│   ├── system.config.json                # DB creds + LIMS API + log settings
│   └── analysers/
│       └── access2_config.json           # Analyser identity + parameter map
├── src/
│   ├── logger.js                         # Shared Winston factory
│   ├── engine/
│   │   ├── IntegrationEngine.js          # Orchestrator
│   │   ├── ConfigLoader.js               # Config read + validate
│   │   └── ConnectionSupervisor.js       # Retry loop helper
│   ├── transport/
│   │   └── SerialPortManager.js          # RS-232 transport
│   ├── protocol/
│   │   ├── ASTMFramer.js                 # State machine
│   │   └── Access2Parser.js              # Record parser
│   ├── mapping/
│   │   └── ParameterMapper.js            # Code → UID lookup
│   ├── db/
│   │   └── ResultWriter.js               # MySQL writer + LIMS pusher
│   └── panel/
│       ├── PanelServer.js                # Express server (port 3003)
│       ├── public/
│       │   └── index.html                # Single-page panel UI
│       └── routes/
│           ├── engineRoutes.js           # /api/engine/*
│           ├── resultsRoutes.js          # /api/results/*
│           └── logsRoutes.js             # /api/logs/*
├── test/
│   └── simulate_access2.js               # Manual integration test
└── logs/
    ├── combined-YYYY-MM-DD.log
    └── error-YYYY-MM-DD.log
```

## Event graph

The engine wires modules together with EventEmitter calls. The complete
graph:

```
SerialPortManager
   ├─ 'data'         ─→ ASTMFramer.ingest()
   ├─ 'connected'    ─→ ASTMFramer.reset()
   ├─ 'disconnected' ─→ ASTMFramer.reset() + serialSupervisor.notifyDisconnected()
   └─ 'error'        ─→ logger

ASTMFramer
   ├─ 'transmissionStart' ─→ ResultWriter.logSessionEvent('ENQ')
   ├─ 'transmissionEnd'   ─→ ResultWriter.logSessionEvent('EOT')
   ├─ 'message'           ─→ Access2Parser.parse()
   └─ 'error'             ─→ logger

Access2Parser
   ├─ 'sessionStart'  ─→ stats counter
   ├─ 'sessionEnd'    ─→ stats counter
   ├─ 'results'       ─→ ParameterMapper.map() → ResultWriter.write()
   ├─ 'parseError'    ─→ logger
   └─ 'filtered'      ─→ logger

ResultWriter
   └─ (no events; logs internally)
```

## Lifecycle

### Startup

1. Operator starts the service (`npm start` or via Windows Services
   manager).
2. `index.js` ensures `logs/` exists, loads `.env`, reads
   `system.config.json` to get the log level.
3. `IntegrationEngine` and `PanelServer` are constructed.
4. `engine.start()` is called:
   a. `ConfigLoader.load()` reads + validates both config files.
   b. `_initialiseModules()` constructs SerialPortManager, ASTMFramer,
      Access2Parser and wires events.
   c. `_buildSupervisors()` creates `_serialSupervisor` and
      `_dbSupervisor` (instances of `ConnectionSupervisor`).
   d. Both supervisors are kicked off — they run in the background.
   e. `engine.start()` returns immediately. Engine is "running" even
      before any connection is established.
5. `PanelServer.start()` launches the Express HTTP server on port 3003.
6. The user can open <http://localhost:3003> immediately.
7. In the background:
   - Serial supervisor calls `serialManager.connect()`. If it fails,
     waits 5 s, retries with exponential backoff up to 60 s.
   - DB supervisor calls `_createDbPool()`. Same retry policy.
   - When DB connects, `_initialiseDbModules()` constructs
     ParameterMapper and ResultWriter on top of the pool.

### Steady state

Engine sits idle until the analyser sends ENQ. When it does, the entire
pipeline runs synchronously inside the framer's `_processByte` loop
until the message is emitted. Result writes happen asynchronously via
the mysql2 promise pool.

### Shutdown

1. Operator sends SIGTERM (Windows Service stop) or SIGINT (Ctrl-C).
2. `_registerShutdownHandlers()` (registered during `start()`) catches
   the signal and calls `engine.stop()`.
3. `stop()`:
   a. Sets `_running = false` first so any retry sleep returning sees
      the new flag and exits.
   b. Stops both supervisors.
   c. Calls `serialManager.disconnect()` — closes port + 1.5 s grace
      period for the OS to release the COM handle.
   d. Resets the framer state.
   e. Closes the MySQL pool.
4. Process exits with code 0.

### Runtime disconnect

If the cable is pulled mid-session:
1. `port.on('close')` fires on the SerialPort instance.
2. `SerialPortManager` emits `'disconnected'`.
3. `IntegrationEngine`'s listener calls
   `_serialSupervisor.notifyDisconnected()`.
4. The supervisor re-enters its retry loop.
5. When the cable is plugged back in, the next connect attempt succeeds.
6. `'connected'` event fires; framer resets; service is back online.

## Process model

A single Node process runs everything. There is no worker pool, no
clustering, no IPC. This is appropriate because:

- One analyser produces at most a few results per minute.
- The pipeline is I/O-bound, not CPU-bound.
- Single-process simplifies state management (no shared state across
  processes).

If a second analyser is ever installed at the same site, the
recommendation is to run a **second OS-level service instance** with
its own config file — not to add multi-analyser support to one
process. The service abstraction differs per OS:

- Windows: a second NSSM Service or Task Scheduler entry
- Linux: a second systemd unit (`specigo-lis-2.service`)
- macOS: a second launchd plist with a distinct `Label`

Each instance binds the panel server to a different port (override
via `PANEL_PORT` env or `system.config.json`).

## Concurrency model

- The Node event loop drives everything.
- Serial bytes arrive on the libuv stream → `'data'` event → framer
  processes byte-by-byte synchronously.
- DB writes are async via mysql2 promises.
- LIMS HTTP push is async and fire-and-forget.
- Two background `while (running)` loops (the supervisors) sleep on
  `setTimeout` between attempts.

There are no race conditions between message processing and shutdown
because:
- `_running = false` is set first in `stop()`
- Supervisors check `_running` after each retry sleep
- Serial port disconnect is awaited
- The framer is reset after disconnect

## Error model

| Error class | Where | Handling |
|---|---|---|
| Config missing/malformed | startup | Throw → process exits with code 1 |
| Serial port unavailable | runtime | Logged warn → supervisor retries forever |
| DB unreachable | runtime | Logged warn → supervisor retries forever |
| ASTM checksum mismatch | runtime | NAK sent → analyser retransmits |
| Frame too long | runtime | NAK sent → frame discarded |
| Parse error | runtime | Logged → individual result skipped, others continue |
| DB INSERT failure | runtime | Logged → batch lost (no retry queue yet) |
| LIMS HTTP failure | runtime | Logged → fire-and-forget; manual retry via panel |
| Uncaught exception | global | Logged → engine attempts graceful stop → exit 1 |
| Unhandled rejection | global | Logged → process continues (does not exit) |

## Network layout

| Port | Bound to | Purpose | Visibility |
|---|---|---|---|
| 3306 | MySQL host | Database | Internal (config) |
| 3003 | `127.0.0.1` | Panel HTTP | Same machine only |
| Outbound | LIMS host | Result push (HTTP) | Internet / VPN |

The panel does **not** bind to `0.0.0.0`. Other machines on the lab
network cannot reach it.

---

**Next:** [03 Installation](03-installation.md)
