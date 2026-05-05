# 01 — Overview

## What this product is

The **SpeciGo LIS Integration Engine** is a Node.js service that runs
on a host PC physically connected by RS-232 cable to a **Beckman
Coulter Access 2** immunoassay analyser. The engine listens for results
the analyser emits, parses them, persists them to the SpeciGo LIMS
MySQL database, and forwards a copy to the LIMS REST API.

It runs unattended in the lab — typically as a Windows Service, Linux
systemd unit, or macOS launchd daemon — and exposes a local web-based
control panel for lab staff to monitor health and inspect results.

For production deployments, the engine is packaged as a self-contained
executable using `pkg`, so the lab PC does not need Node.js installed.
See [03 Installation](03-installation.md) for the build and deployment
flow.

## Why it exists

The Beckman Access 2 transmits patient results in the **ASTM E1394 /
LIS2-A2** protocol over a serial port. The SpeciGo LIMS, by contrast,
expects results to arrive over a REST API in JSON format. There is no
direct integration between the two — a bridge is required.

Without this engine:
- A lab technician would have to read each result off the analyser
  screen and enter it into the LIMS by hand
- Sample turn-around time would be measured in minutes, not seconds
- Transcription errors would be inevitable
- LOINC mapping for downstream interoperability would be lost

With this engine:
- Results flow from analyser to LIMS automatically within ~2–5 seconds
- Every result is logged with its raw ASTM message for audit
- Operators see live status on the panel
- Failed pushes can be replayed manually

## Where it fits

```
                  ┌─────────────────────────────────────────────┐
                  │                Lab floor                    │
                  │                                             │
                  │   ┌──────────────────────┐                  │
                  │   │ Beckman Access 2     │                  │
                  │   │ Immunoassay Analyzer │                  │
                  │   └──────────┬───────────┘                  │
                  │              │ RS-232 (COM4, 9600 baud)     │
                  │              │                              │
                  │   ┌──────────▼───────────┐                  │
                  │   │  Windows PC          │                  │
                  │   │  ┌────────────────┐  │                  │
                  │   │  │ SpeciGo LIS    │  │                  │
                  │   │  │ Engine (Node)  │  │                  │
                  │   │  └─┬────────────┬─┘  │                  │
                  │   │    │            │    │                  │
                  │   │    ▼            ▼    │                  │
                  │   │ MySQL DB     Panel   │                  │
                  │   │ (local)     :3003    │                  │
                  │   └──────────┬───────────┘                  │
                  └──────────────┼──────────────────────────────┘
                                 │ HTTPS
                                 ▼
                  ┌──────────────────────────┐
                  │     SpeciGo LIMS         │
                  │  (Cloud REST endpoint)   │
                  └──────────────────────────┘
```

## What it does, in one paragraph

The engine opens the analyser's serial port, runs an ASTM state machine
that reassembles framed bytes into complete laboratory messages, parses
each message into structured results, maps each assay code (e.g.
`"TSH"`) to the corresponding LIMS parameter UID using a configuration
file, and writes the result to the local MySQL database. Each successful
write is followed by a fire-and-forget HTTP POST to the LIMS REST API
so the result is also visible in the cloud LIMS dashboard. A separate
local web server (port 3003) serves a control panel UI that polls
engine status every five seconds and lets operators search the local
database, inspect individual samples, and replay LIMS pushes manually.

## Key facts

| Property | Value |
|---|---|
| Site | MMI Diagnostics, Raipur, Chhattisgarh |
| Lab UID | `6887129073FDA` |
| Analyser model | Beckman Coulter Access 2 |
| Serial number | `S714560` |
| Protocol | ASTM E1394 / LIS2-A2 |
| Connection | RS-232, COM4, 9600 baud, 8N1 |
| Supported assays | 33 immunoassays (TSH, FT4, PSA, HIV, Vitamin D, etc.) |
| Runtime | Node.js ≥18 (or self-contained `pkg` build) |
| Supported host OSes | Windows 10/11/Server 2019+, Linux (systemd), macOS |
| Database | MySQL 8 / MariaDB 10+ |
| Control panel | <http://localhost:3003> |
| Log retention | 14 days (configurable) |
| Distribution format | Source tree, or single-file executable per OS |

## What the engine does **not** do

- It does not query the analyser. The Access 2 is configured in
  "Send All Results" auto-push mode; the engine is a passive listener.
- It does not handle calibration or QC data in this phase. The
  `message_filters` config has these flags set to `false`. They can be
  enabled later without code changes.
- It does not enforce LIMS authentication. The REST API key is
  configured server-side in `config/system.config.json`.
- It does not validate result values against reference ranges. That is
  the LIMS's responsibility.
- It does not replicate or back up the database. That is operations'
  responsibility.

## Lifecycle of a single result

1. Lab tech places a barcoded sample tube in the analyser. Order is
   already in the LIMS.
2. Analyser runs the assay (~30 minutes on average).
3. Result is queued internally on the analyser.
4. Analyser sends `ENQ` (0x05) byte over serial. Engine acknowledges
   with `ACK` (0x06).
5. Analyser sends one or more frames containing the H/P/O/R/L records
   that make up an ASTM message. Engine validates checksum, ACKs each
   valid frame.
6. Engine assembles the complete message text, parses records, builds
   one or more `ParsedResult` objects.
7. Mapper translates each assay code to LIMS parameter UID, producing
   `MappedResult` objects.
8. Writer issues a single bulk `INSERT INTO lis_results …`.
9. Writer fire-and-forgets `POST <lims_api>/lis/store-analyzer-result`
   with the same data.
10. Analyser sends `EOT` (0x04) — transmission complete. Engine logs the
    session boundary.

Result reaches the cloud LIMS within seconds of test completion.

---

**Next:** [02 Architecture](02-architecture.md) — see how the engine is
structured internally.
