# SpeciGo LIS Integration Engine

## OS Auto‑Start / Auto‑Run Configuration Guide

------------------------------------------------------------------------

## 📌 Overview

This document explains how to configure the **SpeciGo LIS Integration
Engine executable** to **automatically start** when the operating
system:

-   Boots
-   Restarts
-   User logs in
-   System recovers after shutdown

Supported platforms:

-   ✅ Windows
-   ✅ Linux
-   ✅ macOS

This ensures uninterrupted analyzer--LIS communication.

------------------------------------------------------------------------

# 🪟 WINDOWS AUTO START CONFIGURATION

Windows provides multiple enterprise‑grade startup mechanisms.

------------------------------------------------------------------------

## Method 1 --- Registry Auto Start (Recommended)

### Step 1 --- Open Registry Editor

Press:

    Win + R → regedit

Navigate to:

    HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run

------------------------------------------------------------------------

### Step 2 --- Create Startup Entry

Create a **New → String Value**

Name:

    SpecigoLISEngine

Value:

    C:\deployment\specigo-lis-engine.exe --config C:\deployment\config\analysers\au480_config.json

------------------------------------------------------------------------

### Result

✔ Program runs automatically at Windows login.

------------------------------------------------------------------------

## Method 2 --- Task Scheduler (BEST PRACTICE ⭐)

Recommended for hospital/production systems.

### Open Task Scheduler

    taskschd.msc

### Create Task

1.  Create Task
2.  General
    -   Run whether user logged in or not
    -   Run with highest privileges
3.  Trigger
    -   At startup
4.  Action
    -   Start a program

Program:

    C:\deployment\specigo-lis-engine.exe

Arguments:

    --config C:\deployment\config\analysers\au480_config.json

✔ Starts even after reboot.

------------------------------------------------------------------------

## Method 3 --- Windows Service (Enterprise Mode)

Recommended for 24×7 analyzer connection.

Install NSSM:

https://nssm.cc

### Install Service

    nssm install SpecigoLISEngine

Set:

Application Path:

    C:\deployment\specigo-lis-engine.exe

Arguments:

    --config C:\deployment\config\analysers\au480_config.json

Start Service:

    nssm start SpecigoLISEngine

✔ Runs before login\
✔ Survives reboot\
✔ Server-grade stability

------------------------------------------------------------------------

# 🐧 LINUX AUTO START CONFIGURATION

Best approach: **systemd service**.

------------------------------------------------------------------------

## Step 1 --- Copy Binary

    sudo mkdir -p /opt/specigo
    sudo cp specigo-lis-engine-linux /opt/specigo/

Make executable:

    sudo chmod +x /opt/specigo/specigo-lis-engine-linux

------------------------------------------------------------------------

## Step 2 --- Create systemd Service

Create file:

    sudo nano /etc/systemd/system/specigo.service

Add:

    [Unit]
    Description=SpeciGo LIS Integration Engine
    After=network.target

    [Service]
    ExecStart=/opt/specigo/specigo-lis-engine-linux --config /opt/specigo/config/analysers/au480_config.json
    Restart=always
    User=root
    WorkingDirectory=/opt/specigo

    [Install]
    WantedBy=multi-user.target

------------------------------------------------------------------------

## Step 3 --- Enable Auto Start

Reload daemon:

    sudo systemctl daemon-reload

Enable service:

    sudo systemctl enable specigo

Start:

    sudo systemctl start specigo

Check status:

    sudo systemctl status specigo

✔ Auto start after reboot.

------------------------------------------------------------------------

# 🍎 macOS AUTO START CONFIGURATION

macOS uses **launchd agents**.

------------------------------------------------------------------------

## Step 1 --- Create Launch Agent

Create file:

    ~/Library/LaunchAgents/com.specigo.lis.plist

Add:

    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">

    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.specigo.lis</string>

        <key>ProgramArguments</key>
        <array>
            <string>/Users/Shared/specigo-lis-engine-macos</string>
            <string>--config</string>
            <string>/Users/Shared/config/analysers/au480_config.json</string>
        </array>

        <key>RunAtLoad</key>
        <true/>

        <key>KeepAlive</key>
        <true/>
    </dict>
    </plist>

------------------------------------------------------------------------

## Step 2 --- Load Service

    launchctl load ~/Library/LaunchAgents/com.specigo.lis.plist

Verify:

    launchctl list | grep specigo

✔ Auto start at login and reboot.

------------------------------------------------------------------------

# 🔐 Production Deployment Recommendations

-   Always run as background service
-   Use absolute paths only
-   Maintain log files
-   Enable auto restart on crash
-   Restrict permissions properly
-   Digitally sign binaries (Windows/macOS)

------------------------------------------------------------------------

# 🧪 Validation Checklist

✅ Program starts after reboot\
✅ Serial port reconnects automatically\
✅ Config loads successfully\
✅ No manual intervention required

------------------------------------------------------------------------

# 📊 Recommended Method Summary

  OS        Recommended Method
  --------- --------------------------
  Windows   Task Scheduler / Service
  Linux     systemd
  macOS     launchd

------------------------------------------------------------------------

## ✅ Conclusion

Following this guide ensures the **SpeciGo LIS Integration Engine** runs
automatically and reliably across all operating systems, guaranteeing
continuous analyzer communication.

------------------------------------------------------------------------
