# 03 — Installation & Deployment

This chapter covers two installation paths and three operating systems.
Pick the path that matches your situation.

| If you are… | Use |
|---|---|
| A developer iterating on code | [Path A — Source install](#path-a--source-install-development) |
| A site engineer deploying to a production lab | [Path B — Executable build](#path-b--executable-build-production) |

After installation, configure the engine to start automatically. Auto-
start setup differs per OS:

- [Windows auto-start](#windows-auto-start) — Task Scheduler, NSSM
  Service, or Registry
- [Linux auto-start](#linux-auto-start) — systemd
- [macOS auto-start](#macos-auto-start) — launchd

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Operating System | Windows 10/11/Server 2019+, Linux, or macOS | Cross-platform supported |
| Node.js (Path A only) | ≥ 18.0 LTS | Verify with `node --version` |
| npm (Path A only) | ≥ 9.0 | Bundled with Node |
| MySQL or MariaDB | 8.x / 10.4+ | Local or remote, reachable from the engine host |
| RS-232 cable | Straight-through DB-9 to DB-9 | Connecting Access 2 to the host |
| USB-Serial adapter | Any standard FTDI / Prolific | If the host has no native COM port |
| `pkg` (Path B only) | Latest | Installed globally via npm |

### Hardware checklist

Before starting, verify:

1. The host has a serial port (built-in or via USB adapter). On
   Windows, open **Device Manager → Ports (COM & LPT)** to find the
   COM number. On Linux, check `/dev/ttyUSB0` or `/dev/ttyS0`.
2. The Access 2's **LIS Settings** screen shows:
   - Local LIS Interface: **On**
   - Auto-Send to LIS: **Send All Results**
   - Host Query: **On** (acts as fallback)
   - LIS Send Mode: **By Sample Container**
   - Baud rate: **9600**, Data bits: **8**, Parity: **None**, Stop
     bits: **1**
3. The cable is firmly seated on both ends.

---

## Path A — Source install (development)

Use this when you're actively editing code, or for a quick spin-up on
a single machine.

### A.1 Install Node.js

Download the LTS installer from <https://nodejs.org>. Verify:

```powershell
node --version    # v18.x.x or later
npm --version     # 9.x.x or later
```

### A.2 Place the source

Copy the project folder to your preferred location. Common conventions:

- Windows: `C:\Theranize\Projects\specigo-lis-engine\Beckman\Access2`
- Linux/macOS: `/opt/specigo/Access2`

### A.3 Install dependencies

```powershell
cd <project-root>
npm install
```

About 60 MB of packages. The `serialport` package compiles a native
binding; on Windows the install fails without Visual Studio Build
Tools — install those first if needed (`npm install --global
windows-build-tools`, run as administrator).

### A.4 Create configs

See [04 Configuration](04-configuration.md). At minimum:

- `config/system.config.json` (gitignored — create manually)
- `config/analysers/access2_config.json` (committed — edit `port`,
  `lab_uid`, `analyzer_uid`, parameter UIDs)

### A.5 First run

```powershell
npm start
```

Open <http://localhost:3003> in a browser on the same machine. The
control panel should load immediately.

For autostart, jump to your platform's section:
[Windows](#windows-auto-start) /
[Linux](#linux-auto-start) /
[macOS](#macos-auto-start).

---

## Path B — Executable build (production)

Use this when deploying to a lab PC. The output is a single self-
contained binary that does not require Node.js to be installed on the
target machine.

The engine is packaged with [`pkg`](https://github.com/vercel/pkg)
which bundles the Node runtime, all source files, and required
node_modules into one executable per OS target.

### B.1 Install pkg

On the **build machine** (this can be the developer's laptop, not the
target lab PC):

```bash
npm install -g pkg
pkg --version    # any v5.x is fine
```

### B.2 Verify package.json has the build configuration

The project's `package.json` already includes:

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

- `scripts` — JavaScript files included in the executable's snapshot
- `assets` — non-JS files that must remain accessible at runtime;
  required for the SerialPort native binding

### B.3 Clean dependencies

Remove existing installs to ensure a deterministic build:

```powershell
# Windows PowerShell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json

# Linux/macOS
rm -rf node_modules package-lock.json
```

### B.4 Fresh production install

Install runtime dependencies only — skips dev dependencies and
shrinks the executable:

```bash
npm install --production
```

### B.5 Rebuild native modules

Critical for SerialPort:

```bash
npm rebuild
```

Without this, the executable may fail at runtime with "native binding
not found".

### B.6 Build for each target OS

Run once per platform you intend to deploy:

```bash
# Windows
pkg . --targets node18-win-x64   --output specigo-lis-engine.exe

# Linux
pkg . --targets node18-linux-x64 --output specigo-lis-engine-linux

# macOS
pkg . --targets node18-macos-x64 --output specigo-lis-engine-macos
```

The output is a single binary in the project root.

### B.7 (Optional, Windows) Customize the executable icon

`pkg` ships executables with the default Node icon. To brand the .exe:

#### Method 1 — `rcedit` (recommended, automatable)

```bash
npm install -g rcedit
rcedit "specigo-lis-engine.exe" --set-icon "icon.ico"
```

Add this to a build script so every build re-applies the icon.

#### Method 2 — `resedit` (Node-based)

```bash
npm install resedit
```

Create `change-icon.js`:

```js
const ResEdit = require('resedit');
const fs      = require('fs');

const exeBuffer = fs.readFileSync('specigo-lis-engine.exe');
const res       = ResEdit.Resource.from(exeBuffer);
const iconFile  = ResEdit.Resource.IconGroupEntry.fromIconFile(
  fs.readFileSync('icon.ico')
);
iconFile.replaceIn(res);
fs.writeFileSync('specigo-lis-engine.exe', Buffer.from(res.generate()));
```

#### Method 3 — Resource Hacker (manual, GUI)

1. Download Resource Hacker
2. Drag the .exe into the GUI
3. **Action → Add from a Resource file** → select your `.ico`
4. Save

> **Icon requirements:** `.ico` format (not PNG/JPG). Include multiple
> resolutions (16×16, 32×32, 48×48, 256×256) for sharp rendering at
> all UI sizes.

### B.8 (Optional) Sign the executable

For enterprise environments where Windows Defender or Group Policy
flag unsigned binaries:

1. Obtain a code-signing certificate (`.pfx` file). The project's
   `certificate.pfx` reference is for this purpose.
2. Sign with `signtool`:
   ```powershell
   signtool sign /f certificate.pfx /p <password> /t http://timestamp.digicert.com `
                /fd SHA256 specigo-lis-engine.exe
   ```
3. Verify:
   ```powershell
   signtool verify /pa specigo-lis-engine.exe
   ```

The signing certificate must come from a trusted CA (DigiCert,
Sectigo, etc.). Self-signed certificates trigger "Unknown Publisher"
warnings on most managed Windows networks.

### B.9 Deployment folder structure

`pkg` bundles the source code into the binary, but **configuration
files must remain external** so they can be edited per-site.

The standard layout on the target machine:

```
C:\deployment\                                 (Windows)
/opt/specigo/                                  (Linux)
/Users/Shared/specigo/                         (macOS)
│
├── specigo-lis-engine.exe          (or specigo-lis-engine-linux / -macos)
├── certificate.pfx                 (if signed)
├── config/
│   ├── system.config.json          (DB + LIMS credentials)
│   └── analysers/
│       └── access2_config.json     (analyser identity + parameter map)
└── logs/                           (auto-created on first run)
    ├── combined-YYYY-MM-DD.log
    └── error-YYYY-MM-DD.log
```

Copy the binary and `config/` directory to the target machine into the
above structure.

### B.10 First run on the target machine

```powershell
# Windows
cd C:\deployment
.\specigo-lis-engine.exe --config config\analysers\access2_config.json
```

```bash
# Linux
cd /opt/specigo
./specigo-lis-engine-linux --config config/analysers/access2_config.json

# macOS
cd /Users/Shared/specigo
./specigo-lis-engine-macos --config config/analysers/access2_config.json
```

You should see the startup banner. Open the panel at
<http://localhost:3003> to verify.

Once verified, configure auto-start for your OS — see the next
section.

---

## Windows auto-start

Three methods. Pick **one** based on the lab's operational requirements.

| Method | Best for | Survives logout? | Survives reboot? |
|---|---|---|---|
| Task Scheduler | Recommended for hospital labs | Yes | Yes |
| NSSM Service | 24×7 enterprise deployments | Yes (runs before login) | Yes |
| Registry Run | Light desktop installs | No | Yes (runs at user login) |

### Method 1 — Task Scheduler (recommended)

1. Run `taskschd.msc` (Task Scheduler).
2. **Action → Create Task…** (not "Create Basic Task" — full Create
   exposes the options we need).
3. **General** tab:
   - Name: `SpeciGo LIS Engine`
   - Select **Run whether user is logged on or not**
   - Check **Run with highest privileges**
4. **Triggers** tab → **New…**
   - Begin the task: **At startup**
5. **Actions** tab → **New…**
   - Action: **Start a program**
   - Program/script: `C:\deployment\specigo-lis-engine.exe`
   - Add arguments: `--config C:\deployment\config\analysers\access2_config.json`
   - Start in: `C:\deployment`
6. **Conditions** tab → uncheck "Start the task only if the computer
   is on AC power" if this is a desktop PC.
7. **Settings** tab → check "If the task fails, restart every 1
   minute, attempt 3 times".
8. **OK**, then enter the admin password when prompted.

Verify by running the task manually (right-click → **Run**), then
rebooting the PC and confirming the engine started.

### Method 2 — NSSM Windows Service

NSSM (Non-Sucking Service Manager) is the simplest way to run any
executable as a true Windows Service.

1. Download NSSM from <https://nssm.cc> and extract.
2. Open an **administrator** PowerShell:
   ```powershell
   nssm install "SpeciGo LIS Engine"
   ```
3. In the GUI that opens:
   - **Path:** `C:\deployment\specigo-lis-engine.exe`
   - **Startup directory:** `C:\deployment`
   - **Arguments:** `--config C:\deployment\config\analysers\access2_config.json`
   - **Details** tab → Display name: `SpeciGo LIS Engine`,
     Description: "SpeciGo LIS Integration Engine — Beckman Access 2"
   - **I/O** tab → Output (stdout): `C:\deployment\logs\service-stdout.log`,
     Error (stderr): `C:\deployment\logs\service-stderr.log`
   - **Exit actions** tab → Restart action: **Restart application**
4. Click **Install service**.
5. Start it:
   ```powershell
   nssm start "SpeciGo LIS Engine"
   Get-Service "SpeciGo LIS Engine"
   ```

The service now starts before any user logs in and survives reboot.

### Method 3 — Registry Run (light desktop)

Use only if Task Scheduler / NSSM is unavailable. Requires a user to
be logged in for the engine to run.

1. Press **Win+R** → `regedit`.
2. Navigate to:
   ```
   HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run
   ```
3. Right-click the right pane → **New → String Value**.
4. Name: `SpecigoLISEngine`
5. Value:
   ```
   C:\deployment\specigo-lis-engine.exe --config C:\deployment\config\analysers\access2_config.json
   ```
6. Reboot to verify.

---

## Linux auto-start

Use **systemd**. Standard on Ubuntu, Debian, RHEL, Fedora, and most
modern distros.

### Step 1 — Place the binary

```bash
sudo mkdir -p /opt/specigo
sudo cp specigo-lis-engine-linux /opt/specigo/
sudo chmod +x /opt/specigo/specigo-lis-engine-linux
sudo cp -r config /opt/specigo/
```

### Step 2 — Create the unit file

```bash
sudo nano /etc/systemd/system/specigo-lis.service
```

Paste:

```ini
[Unit]
Description=SpeciGo LIS Integration Engine
After=network.target mysql.service

[Service]
Type=simple
ExecStart=/opt/specigo/specigo-lis-engine-linux --config /opt/specigo/config/analysers/access2_config.json
Restart=always
RestartSec=5
User=specigo
WorkingDirectory=/opt/specigo
StandardOutput=append:/opt/specigo/logs/service-stdout.log
StandardError=append:/opt/specigo/logs/service-stderr.log

# Allow access to the serial device
SupplementaryGroups=dialout

[Install]
WantedBy=multi-user.target
```

> **User note:** Create a dedicated `specigo` user so the engine does
> not run as root:
> ```bash
> sudo useradd --system --no-create-home --shell /bin/false specigo
> sudo usermod -aG dialout specigo
> sudo chown -R specigo:specigo /opt/specigo
> ```

### Step 3 — Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable specigo-lis
sudo systemctl start specigo-lis
```

### Step 4 — Verify

```bash
sudo systemctl status specigo-lis
journalctl -u specigo-lis -f      # live log tail
```

The engine now starts at every boot and restarts automatically on
crash (with a 5 s back-off).

---

## macOS auto-start

Use **launchd**.

### Step 1 — Place the binary

```bash
sudo mkdir -p /Users/Shared/specigo
sudo cp specigo-lis-engine-macos /Users/Shared/specigo/
sudo chmod +x /Users/Shared/specigo/specigo-lis-engine-macos
sudo cp -r config /Users/Shared/specigo/
```

### Step 2 — Create the launch daemon

For system-wide auto-start (runs before any user logs in):

```bash
sudo nano /Library/LaunchDaemons/com.specigo.lis.plist
```

Paste:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.specigo.lis</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/Shared/specigo/specigo-lis-engine-macos</string>
        <string>--config</string>
        <string>/Users/Shared/specigo/config/analysers/access2_config.json</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/Shared/specigo</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/Shared/specigo/logs/service-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/Shared/specigo/logs/service-stderr.log</string>
</dict>
</plist>
```

> For per-user auto-start (runs only after that user logs in), put the
> file at `~/Library/LaunchAgents/com.specigo.lis.plist` instead and
> use `launchctl load` without `sudo`.

### Step 3 — Set permissions and load

```bash
sudo chown root:wheel /Library/LaunchDaemons/com.specigo.lis.plist
sudo chmod 644         /Library/LaunchDaemons/com.specigo.lis.plist
sudo launchctl load   /Library/LaunchDaemons/com.specigo.lis.plist
```

### Step 4 — Verify

```bash
sudo launchctl list | grep specigo
tail -f /Users/Shared/specigo/logs/service-stdout.log
```

---

## Validation checklist

After installation and auto-start configuration, verify all of the
following before declaring the lab live:

- [ ] Engine starts within 30 s of OS boot (no manual launch needed)
- [ ] Control panel reachable at <http://localhost:3003>
- [ ] Status pill shows "Running — Connected" once the analyser is on
- [ ] Database row in dashboard shows "Connected"
- [ ] Run a test sample on the analyser — result appears in the
      panel's Results tab within 5 s
- [ ] Result also appears in the upstream LIMS dashboard
- [ ] Reboot the host — engine restarts on its own, panel reachable
      again within 1 minute of reboot
- [ ] Pull the analyser cable and reconnect — engine logs disconnect,
      then reconnects automatically when cable returns
- [ ] Tail logs for one full shift — no recurring `[ERROR]` lines

---

## Updating to a new version

### Path A (source-based)

```powershell
# Stop the service first
Stop-Service "SpeciGo LIS Engine"        # Windows (NSSM)
sudo systemctl stop specigo-lis          # Linux
sudo launchctl unload …                  # macOS

# Pull / replace source
cd <project-root>
git pull
npm install

# Restart
Start-Service "SpeciGo LIS Engine"
```

Configuration is preserved because `system.config.json` and the
`logs/` directory are not touched.

### Path B (executable-based)

1. Build a new binary on the build machine (steps B.3–B.6).
2. (Optional) Re-apply the icon and re-sign.
3. Stop the service on the target machine.
4. Replace the binary in the deployment folder. **Do not** touch
   `config/` or `logs/`.
5. Start the service.

---

## Uninstalling

### Windows

```powershell
# If using NSSM
nssm stop   "SpeciGo LIS Engine"
nssm remove "SpeciGo LIS Engine" confirm

# If using Task Scheduler
Get-ScheduledTask "SpeciGo LIS Engine" | Unregister-ScheduledTask -Confirm:$false

# If using Registry
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v SpecigoLISEngine /f

# Then delete the deployment folder
Remove-Item -Recurse -Force C:\deployment
```

### Linux

```bash
sudo systemctl stop    specigo-lis
sudo systemctl disable specigo-lis
sudo rm /etc/systemd/system/specigo-lis.service
sudo systemctl daemon-reload
sudo rm -rf /opt/specigo
```

### macOS

```bash
sudo launchctl unload /Library/LaunchDaemons/com.specigo.lis.plist
sudo rm /Library/LaunchDaemons/com.specigo.lis.plist
sudo rm -rf /Users/Shared/specigo
```

---

## Common installation pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm install` fails on `serialport` | Missing build tools | Install Visual Studio Build Tools (Windows) or `build-essential` (Linux); rerun `npm install` |
| `pkg` fails with "native module" error | Native binding not rebuilt | Run `npm rebuild` between `npm install` and `pkg .` |
| .exe blocked by Windows Defender | Unsigned binary on managed network | Sign with a trusted code-signing cert (B.8) or whitelist via Group Policy |
| .exe runs from explorer but not as Service | Wrong working directory | In NSSM/Task Scheduler, set the **Start in / Working directory** to the deployment folder so relative `config/` and `logs/` paths resolve |
| "Access denied" on COM port | Another process holds it (Termite, PuTTY, old Node) | Close other tools; restart the Service |
| Linux service can't open `/dev/ttyUSB0` | User not in `dialout` group | `sudo usermod -aG dialout specigo` and reboot |
| macOS service fails silently | plist permissions wrong | `sudo chown root:wheel` and `sudo chmod 644` on the plist |
| Logs missing after Service install | Service running as a different user | Ensure that user has write access to the `logs/` directory |
| LIMS push always fails post-deploy | Wrong API URL or expired key | Edit `config/system.config.json`; restart |
| Engine launches but Panel UI returns 404 | `pkg` build did not include `src/panel/public/` | Add `src/panel/public/**/*` to the `pkg.assets` array in package.json and rebuild |

---

## Production hardening recommendations

- Run the engine as a dedicated service user with minimal privileges
  (Linux: `specigo`; Windows: a managed service account)
- Use absolute paths in all auto-start configurations — never rely on
  the PATH env or working directory inheritance
- Keep `config/system.config.json` outside source control and back it
  up separately
- Sign Windows and macOS binaries to avoid AV/Gatekeeper friction
- Set log retention with `retention_days` in `system.config.json` —
  default 14 days; lab sites with high transmission volume may want 7
- Configure the OS to reboot automatically on kernel panic (Linux)
  / BSOD (Windows) so the auto-start chain can recover
- Monitor the host with a separate uptime check that hits
  `http://localhost:3003/api/engine/status` every 5 min and alerts on
  failures

---

## Recommended method by OS

| OS | Recommended | Alternative | Avoid |
|---|---|---|---|
| Windows Server / clinical PC | NSSM Service | Task Scheduler | Registry Run |
| Windows desktop / single user | Task Scheduler | Registry Run | — |
| Linux | systemd | — | Cron `@reboot` |
| macOS | launchd (LaunchDaemon) | LaunchAgent (per-user) | — |

---

**Next:** [04 Configuration Reference](04-configuration.md)
