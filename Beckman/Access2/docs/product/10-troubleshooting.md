# 10 — Troubleshooting

This chapter is structured by **symptom**. Find the row that matches
what you're seeing, follow the diagnosis steps, then apply the fix.

## How to read this guide

1. Identify the symptom in the panel UI or logs
2. Look up the symptom below
3. Run the diagnostic commands in order
4. Apply the matching fix
5. Verify by checking the panel status pill turns green and a fresh
   transmission succeeds

When in doubt, the **Logs tab** is your first stop. Set Level filter to
`Error` and Module filter to whichever is relevant (Serial, Database,
etc.).

## Quick reference

| Symptom | Likely culprit | Section |
|---|---|---|
| Panel shows "Stopped" | Engine crashed | §1 |
| Panel shows "Offline" | Service not running | §2 |
| Serial: "Disconnected" forever | Cable / port / driver | §3 |
| Database: "Disconnected" forever | DB unreachable / wrong creds | §4 |
| ENQ logged but no message emitted | Checksum mismatch or wrong baud | §5 |
| Result reaches DB but not LIMS | LIMS down / wrong API URL | §6 |
| Sample not in DB at all | Filter, parser error, or wrong assay code | §7 |
| `Access denied` on COM port | Stale handle from previous run | §8 |
| Panel UI loads but data missing | Stale browser cache | §9 |
| Service won't start | Config error / install issue | §10 |

---

## §1 — Panel shows "Stopped"

### Symptom
Status pill is red, says "Stopped". Logs tab returns "No log file for
today yet" or shows abrupt termination.

### Diagnosis

1. Open the Logs tab. Filter Level = `Error`. Look for an error in the
   last few minutes before the engine stopped.
2. If logs are silent, check Windows Event Viewer:
   - Start → Event Viewer → Windows Logs → Application
   - Look for entries from `Node.js` or `node-windows` or
     `SpeciGo LIS Access 2`

### Common causes
- Uncaught exception in result-processing pipeline
- Out-of-memory (rare — would require thousands of pending results)
- Service was stopped manually (check Service Control Manager)

### Fix
```powershell
Start-Service "SpeciGo LIS Access 2"
```

If it stops again immediately, follow §10.

---

## §2 — Panel shows "Offline"

### Symptom
Status pill says "Offline". Page loads but every API call fails. Other
tabs show "Failed to load…".

### Diagnosis

1. Check the Service:
   ```powershell
   Get-Service "SpeciGo LIS Access 2"
   ```
   If state is `Stopped`, see §1.
2. Check the panel port:
   ```powershell
   Test-NetConnection 127.0.0.1 -Port 3003
   ```
   If `TcpTestSucceeded: False`, the panel server didn't bind.
3. Check the engine logs for `[PANEL]` lines.

### Fix
- If service is stopped: start it (see §1)
- If service is running but port not listening: check
  `system.config.json` and any port conflict
  ```powershell
  netstat -ano | findstr :3003
  ```

---

## §3 — Serial: "Disconnected" forever

### Symptom
Engine state is "Running" but Serial connection stays "Disconnected"
or "Reconnecting" indefinitely. Logs show repeated:

```
[SERIAL] [WARN] Serial port unavailable, retrying in 60s
```

### Diagnosis

1. Verify the cable physically:
   - Is the cable seated firmly on both ends?
   - Is the analyser powered on and on its main screen (not in a
     menu)?
2. Identify the COM port:
   - Open Device Manager → Ports (COM & LPT)
   - Confirm a COM device is listed; note the number
3. Confirm config matches:
   - Open `config/analysers/access2_config.json`
   - Check `connection.port` matches the COM number from step 2
4. Check the analyser's LIS Settings screen:
   - Local LIS Interface: **On**
   - Auto-Send to LIS: **Send All Results**
   - Baud rate: **9600**
5. Test the port from outside the engine:
   - Use `mode COM4` in PowerShell (admin) — should not error
   - Or use a serial terminal like Termite at 9600 8N1 — you should
     see ASTM bytes when the analyser sends a result

### Common causes
- Wrong COM number in config
- Driver not installed (USB-Serial adapter)
- Cable damaged or unplugged
- Another process (Termite, PuTTY) holding the port

### Fix

For wrong COM in config:
```powershell
# Edit config to match Device Manager
# Then restart the service
Restart-Service "SpeciGo LIS Access 2"
```

For another process holding the port:
```powershell
# Find what's holding it (use Process Explorer with "Find handle" search
# for "COM4")
# Close that process
Restart-Service "SpeciGo LIS Access 2"
```

For driver issues — reinstall the USB-Serial driver and reboot.

---

## §4 — Database: "Disconnected" forever

### Symptom
Database row in the dashboard stays "Connecting" or "Disconnected".
Logs show:

```
[ENGINE] [WARN] Database unavailable, retrying in 60s
[ENGINE] [INFO] Attempting Database connection...
[ENGINE] [WARN] Database unavailable, retrying in 60s ...
```

### Diagnosis

1. Check the error message in the warn line — usually says one of:
   - `ECONNREFUSED` — DB host unreachable
   - `Access denied for user` — wrong credentials
   - `Unknown database` — wrong DB name
2. Test the connection manually:
   ```powershell
   mysql -h <host> -P <port> -u <user> -p<password> <dbname>
   ```
3. If MySQL is local:
   ```powershell
   Get-Service MySQL80   # or MariaDB depending on installation
   ```

### Fix

| Cause | Fix |
|---|---|
| Wrong creds | Edit `config/system.config.json`, restart service |
| MySQL not running | `Start-Service MySQL80` |
| Firewall blocking | Allow port 3306 in Windows Firewall (or DB host firewall) |
| Wrong DB name | Verify with `SHOW DATABASES;` after manual mysql login |
| Wrong host | Ping the host; verify DNS / hosts file |

After fix:
```powershell
Restart-Service "SpeciGo LIS Access 2"
```

---

## §5 — ENQ logged but no message emitted

### Symptom
Logs show ENQ → ACK → STX → … but no `'Complete ASTM message
assembled'` line. Or repeated NAK lines.

```
[FRAMER] [ERROR] ASTM checksum mismatch - sending NAK
```

### Diagnosis

This is a transmission-layer integrity problem. Possible causes:
- Cable noise / RS-232 interference
- Wrong baud rate (data corrupted in transit)
- Wrong parity / stop bits
- Analyser firmware bug emitting wrong checksums

Look at debug-level log lines from `[FRAMER]`:

```
[FRAMER] [DEBUG] Frame dispatch: receivedCs A3, expectedCs A4
```

If `receivedCs` and `expectedCs` differ by 1–2 bits, suspect serial
corruption (cable, baud).

### Fix

| Cause | Fix |
|---|---|
| Cable interference | Replace cable; route away from power lines / motors |
| Wrong baud | Verify analyser LIS Settings = 9600; verify config matches |
| Wrong data bits / parity / stop bits | Verify all = 8 / none / 1 |
| Persistent corruption on a known-good cable | Try a USB-Serial adapter as alternative path |
| Suspected analyser firmware bug | Capture 10 transmissions with `log_level: "debug"`, share with Beckman |

Temporary diagnostic: set `protocol.checksumEnabled: false` in
`access2_config.json` (do **not** leave this in production). The
framer will accept frames regardless of checksum, letting you see if
the problem is downstream (good frames, bad checksum) or upstream (bad
frames).

---

## §6 — Result reaches DB but not LIMS

### Symptom
- Panel Results tab shows the row
- LIMS dashboard does not show it
- Logs show:
  ```
  [WRITER] [INFO] lis_results bulk insert complete
  [WRITER] [ERROR] LIMS API push failed: connect ECONNREFUSED 1.2.3.4:443
  ```
  (or similar HTTP error)

### Diagnosis

1. Identify the failure mode from the warn/error line:
   - `ECONNREFUSED` / `ETIMEDOUT` — LIMS unreachable
   - `non-2xx, statusCode: 401` — auth issue
   - `non-2xx, statusCode: 4xx` — bad request body
2. Test the LIMS endpoint directly:
   ```powershell
   curl -X POST "<base_url>/lis/store-analyzer-result" `
        -H "Content-Type: application/json" `
        -d '{"lab_uid":"...","analyzer_uid":"...","api_key":"...","data":[]}'
   ```

### Fix

| Cause | Fix |
|---|---|
| LIMS down | Wait for LIMS team to recover; results stay in local DB |
| Wrong API URL | Edit `lims_api.base_url`; restart service |
| Expired / wrong API key | Get new key from LIMS team; update `lims_api.api_key` |
| Body shape mismatch | Coordinate with LIMS team — recent schema change? |

To replay missed results once LIMS is back:
1. Open the Sample Detail modal in the panel for each affected barcode
2. Click "Send to LIMS"
3. Verify success toast

This is manual today; an automatic retry queue is on the improvement
backlog (BUG-004).

---

## §7 — Sample not in DB at all

### Symptom
- Operator ran a sample on the analyser
- Result appears on the analyser printout
- Result does **not** appear in the engine's Results tab even after
  several minutes

### Diagnosis

1. Logs tab → filter Module = `Framer`. Was an ENQ logged at the
   expected time? Look for:
   ```
   [FRAMER] [INFO] ENQ received - transmission started
   ```
2. If yes, did a message emit?
   ```
   [FRAMER] [INFO] Complete ASTM message assembled
   ```
3. If yes, did the parser see it?
   ```
   [ACCESS2] [INFO] Results parsed from ASTM message {"count":1, ...}
   ```
4. If yes, did the writer insert it?
   ```
   [WRITER] [INFO] lis_results bulk insert complete
   ```

Wherever the chain breaks tells you the layer:

| Last good log | Next layer | Common cause |
|---|---|---|
| (no ENQ at all) | Transport | Cable / Auto-Send disabled |
| ENQ but no "Complete ASTM message" | Framer | Checksum mismatch (§5) |
| Message but no "Results parsed" | Parser | Filtered by `message_filters`, or parse error |
| Results parsed but no INSERT | Writer | DB error |
| INSERT logged but row missing | Filter / wrong lab_uid | Check the WHERE clause in the panel — wrong date filter? |

### Fix

| Cause | Fix |
|---|---|
| Auto-Send off | Set Access 2 → LIS Settings → Auto-Send to LIS = "Send All Results" |
| QC sample being filtered | If the barcode starts with `QC` or `CAL`, the engine filters it. Set `message_filters.qc_results: true` if needed |
| Parser error | Check `[ACCESS2] [ERROR]` lines for the error message |
| Wrong assay code mapping | Check Logs for `Assay code not found in parameter_map`; add the assay to the parameter_map config |

---

## §8 — `Access denied` on COM port

### Symptom
After a Restart or Service stop+start, logs show:

```
[SERIAL] [ERROR] port.open() callback error: Access denied
```

### Diagnosis

A previous instance hasn't fully released the COM handle. Windows is
slow to release; the engine has a 1.5 s grace period in
`SerialPortManager._closePort()`, but occasionally that's not enough.

### Fix

Wait 30 seconds and the supervisor will retry — usually succeeds on
attempt 2 or 3.

If it's still failing after 5 minutes:
1. Check for stray `node.exe` processes:
   ```powershell
   Get-Process node | Format-Table Id, ProcessName, Path
   ```
2. Kill any rogue Node process (verify it's not the Service):
   ```powershell
   Stop-Process -Id <pid> -Force
   ```
3. Or reboot the PC if you can't isolate the holder.

To prevent future occurrences: don't run `npm start` manually while
the Service is running — that creates two processes both trying to
hold the same COM port.

---

## §9 — Panel UI loads but data missing

### Symptom
Panel loads, but Results table is empty even when DB has rows. Or some
features missing (no Logs tab, etc.).

### Diagnosis

Browser cache is serving an old `index.html`.

### Fix

Hard reload:
- Chrome / Edge: Ctrl + F5
- Or open Dev Tools → Network → Disable Cache → reload

If the issue persists:
- Check the engine logs for any `[PANEL] [ERROR]` lines
- Verify `src/panel/public/index.html` exists and is recent (after
  any code update)

---

## §10 — Service won't start

### Symptom
- `Start-Service "SpeciGo LIS Access 2"` returns immediately but
  service stays Stopped
- Or service runs for a few seconds, then stops

### Diagnosis

1. Open Event Viewer → Windows Logs → Application
2. Look for entries from your service
3. Try running the engine directly to see the error:
   ```powershell
   cd C:\Theranize\Projects\specigo-lis-engine\Beckman\Access2
   node index.js
   ```
4. Watch the console — any error here is the same one the service is
   hitting

### Common causes & fixes

| Error message | Cause | Fix |
|---|---|---|
| `Config file not found` | Wrong cwd / missing file | Confirm the working directory; ensure `config/analysers/access2_config.json` exists |
| `Failed to parse config file` | Invalid JSON | Validate with a JSON linter |
| `Config file missing required field` | Required field absent | Add missing field per [04 Configuration](04-configuration.md) |
| `Database credentials missing` | No DB info anywhere | Set creds in `system.config.json` or env vars |
| `Cannot find module` | `npm install` not run after pull | `npm install` |
| `Cannot find module 'serialport'` after install | Native binding failed | Reinstall with admin: `npm rebuild serialport` |

After fixing:
```powershell
Start-Service "SpeciGo LIS Access 2"
```

---

## Reading log files directly

If the panel is unreachable, you can read logs from the filesystem:

```powershell
# Today's full log
Get-Content -Tail 100 .\logs\combined-2026-05-04.log

# Errors only
Get-Content -Tail 50 .\logs\error-2026-05-04.log

# Live tail (Ctrl+C to stop)
Get-Content -Wait -Tail 20 .\logs\combined-2026-05-04.log
```

## When all else fails

Capture the following before escalating:

1. Exact symptom (which pill is what colour, which tab fails how)
2. Last 100 lines of `logs/combined-<today>.log`
3. Last 50 lines of `logs/error-<today>.log`
4. Output of `Get-Service "SpeciGo LIS Access 2"`
5. Output of `Test-NetConnection 127.0.0.1 -Port 3003`
6. Output of `Test-NetConnection <db-host> -Port 3306`
7. Whether the analyser is currently powered on and connected
8. Recent changes (new sample, new analyser config, OS update?)

Email this bundle to the SpeciGo engineering team.

---

**Next:** [11 Glossary](11-glossary.md)
