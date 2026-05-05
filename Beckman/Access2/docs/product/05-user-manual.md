# 05 — User Manual

## Audience

This chapter is for **lab operators** — the people who use the engine
day-to-day at the bench. It assumes the engine is already installed
and running. If you need to install or configure it, see chapters 03
and 04.

## Opening the control panel

On the lab PC, open a web browser and go to:

```
http://localhost:3003
```

This is the SpeciGo LIS control panel. It is local to this PC only —
you cannot reach it from another machine.

## Layout

```
┌────────────────────────────────────────────────────────────────┐
│ ▣ SpeciGo LIS              Dashboard          [● Connected]    │
├──────────────┬─────────────────────────────────────────────────┤
│              │                                                 │
│  Workspace   │   ENGINE STATUS         QUICK ACTIONS           │
│              │   ─────────────         ──────────────          │
│  ▣ Dashboard │   Engine state          [ View today's ]        │
│  ▤ Results   │   Serial port           [ Browse all   ]        │
│  ⌘ Logs      │   Database              ──────────────          │
│              │   Analyser model                                │
│              │   Site                                          │
│              │   Lab UID                                       │
│              │   Started at                                    │
│              │                                                 │
│              │                                                 │
│  v1.0.0      │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

- **Sidebar (left)** — Navigation between three sections
- **Topbar** — Page title (left) + live engine status pill (right)
- **Content (centre)** — Whatever section you have open

The status pill in the top-right updates every 5 seconds. Possible
states:

| Pill | Colour | Meaning |
|---|---|---|
| Running — Connected | Green | Engine is up and the analyser cable is healthy |
| Running — Connecting | Amber | Engine is up, waiting for the analyser to come online |
| Running — No Serial | Amber | Engine is up but the cable is not connected |
| Stopped | Red | Engine is not running |
| Offline | Red | Cannot reach the panel API (engine has crashed) |

## Dashboard

The Dashboard shows a live snapshot of engine health. There are two
cards.

### Engine Status (left)

Each row updates every 5 seconds. Colour pills indicate state.

| Row | What it tells you |
|---|---|
| Engine state | Whether the Node service is running |
| Serial port | Which COM port is in use (e.g. `COM4`) |
| Baud rate | Communication speed (`9600 bps` for Access 2) |
| Serial connection | Cable status — Connected / Reconnecting / Disconnected |
| Database | MySQL connection status |
| Analyser model | "Access 2" |
| Site | Lab name |
| Lab UID | Multi-tenant identifier |
| Started at | When the engine last started |

If "Serial connection" stays in "Reconnecting" or "Disconnected" for
more than a minute, see [Troubleshooting](10-troubleshooting.md).

### Quick Actions (right)

| Button | Effect |
|---|---|
| View today's results | Opens the Results tab with today's date pre-selected |
| Browse all results | Opens the Results tab with no date filter, showing the full dataset |

## Results

This is where you search, view, and act on the results stored in the
local database.

### Filter bar

| Field | Behaviour |
|---|---|
| Date | Filters by the date a result was received. When you click "Results" in the sidebar, today's date is pre-filled automatically. Clear the field to see all dates |
| Barcode | Partial match on the sample barcode. Useful for "find that one tube" |
| Parameter | Exact match on the parameter code (e.g. `TSH`, `FT4`). Auto-uppercased as you type |
| Flag | Filter by abnormal-flag. `Normal`, `High`, `Critical High`, `Low`, `Critical Low`, `Abnormal` |
| Per page | Number of rows to load per request: 25 / 50 / 100 |
| Search | Apply the filters and reload |
| Clear | Reset every filter and reload the full dataset |

### Results table

Each row is one parameter measured on one sample.

| Column | Notes |
|---|---|
| `#` | Internal database row ID |
| Barcode | Click to open the Sample Detail modal for that tube |
| Parameter | The assay code (TSH, PSA, etc.) |
| Value | Numeric or text result |
| Unit | Configured unit (preferred over instrument-reported when both differ) |
| Flag | Colour-coded: green = normal, red = high, blue = low, amber = abnormal |
| Patient | Patient name as transmitted by the analyser |
| Age | Years (`yr`) or months (`mo`) |
| Gender | Male / Female |
| Received | Timestamp from the instrument's R record |

### Pagination

Below the table:
- "Showing 1–50 of 1,247" — current slice + total
- Page chips (numbered) — click to jump
- Prev / Next chevrons

### Sample Detail modal

Click any **barcode** in the table. A modal opens showing:

- **Patient panel** — Name, Age, Gender (read from the most recent
  result for that barcode)
- **Parameters table** — every test run on this sample
- **Send to LIMS** button — top-right of the modal

#### Send to LIMS — manual push

This button replays the LIMS push for the entire sample. Use it when:
- The automatic push failed (network blip, LIMS down)
- A row was edited in the database and you want LIMS to see the
  current values
- You're manually replaying after fixing a mapping error

**Two-step confirmation:**
1. First click → button turns amber and shows "Click again to confirm"
2. Second click within 3 seconds → request is sent
3. If you don't click again in 3 seconds, it resets to the default
   state (no accidental sends)

You'll see one of two toast notifications at the bottom-right:
- Green: `Sent N results to LIMS.`
- Red: A specific error message (e.g. timeout, 4xx response)

Errors are logged on the engine — check the Logs tab if you see one.

## Logs

A live tail of today's combined log file (`logs/combined-<today>.log`).

### Filter bar

| Field | Behaviour |
|---|---|
| Level | Filter by `Error` / `Warn` / `Info` / `Debug`. Empty = all levels |
| Module | Filter by source module: Engine / Serial / Framer / Parser / Mapper / Writer / Panel / Index |
| Search | Substring match on the full log line |
| Lines | Maximum lines to load per refresh: 200 / 500 / 1000 / 2000 |
| Auto-refresh | Checkbox — when enabled, the viewer updates every 3 seconds |
| Refresh | Manual refresh |

### Log viewer

Dark terminal-style panel showing one line per log entry. Lines are
colour-coded:

| Colour | Level |
|---|---|
| Red | Error |
| Amber | Warn |
| Blue | Info |
| Grey | Debug |

The viewer auto-scrolls to the latest line **only if** you are already
within 60 px of the bottom. If you scroll up to read history, it will
not yank you back down on the next refresh.

### When to use the Logs tab

- After a "Send to LIMS" failure, to see the upstream HTTP error
- During analyser commissioning, to confirm ENQ → frame → ACK flow
- To investigate a missed result ("did the engine even see this
  sample?")
- When the panel shows "Disconnected", to see why

## Daily workflow

A typical lab day looks like this from the engine's perspective:

1. **Morning**: Operator powers on the analyser. Engine (already
   running as a Service) detects the cable, status flips to
   "Connected".
2. **Throughout shift**: Each completed test on the analyser triggers
   an ASTM transmission. Within 2–5 seconds, the result is in the local
   DB and the cloud LIMS. Operator never has to look at the panel.
3. **End of shift**: Analyser is powered off. Engine logs a
   disconnect, supervisor enters retry mode. No alarms — the engine
   simply waits.
4. **Next morning**: Power on, auto-reconnect, business as usual.

The panel is mostly used **only** when something looks wrong. Day-to-day
operation is silent.

## What to escalate

Open a support ticket / call IT if:

- The status pill is red ("Stopped" or "Offline") and stays red
- Sample results are present in the analyser but never appear in the
  Results tab even after several minutes
- The "Send to LIMS" button consistently fails with the same error
  message
- You see repeated `[ERROR]` lines in the Logs tab
- A specific parameter is showing `UNMAPPED` in the database (will
  surface as a missing entry in LIMS) — this is a configuration issue,
  not a bug

Have ready: the timestamp of the failure, the sample barcode (if
applicable), and the last 20–30 log lines.

---

**Next:** [06 Developer Guide](06-developer-guide.md)
