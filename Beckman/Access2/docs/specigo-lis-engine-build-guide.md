# SpeciGo LIS Integration Engine

## EXE Build & Deployment Guide

------------------------------------------------------------------------

## 📌 Overview

This document describes the **standardized professional process** for
converting the **SpeciGo LIS Integration Engine (Node.js project)** into
standalone executable files for **Windows, Linux, and macOS** using the
**pkg** package.

This guide ensures: - Reproducible builds - Proper native module
handling - Clean deployment structure - Production-ready executable
distribution

------------------------------------------------------------------------

## ⚙️ Prerequisites

Before starting, ensure the following are installed:

-   Node.js (Recommended: **v18**)
-   npm
-   Internet connection (for dependency installation)

Verify installation:

``` bash
node -v
npm -v
```

------------------------------------------------------------------------

## 🧩 Step 1 --- Install `pkg` Globally

Install the executable builder:

``` bash
npm install -g pkg
```

Verify:

``` bash
pkg --version
```

------------------------------------------------------------------------

## 🧩 Step 2 --- Modify `package.json`

Update your `package.json`.

### Add `bin` Entry

``` json
"bin": "index.js"
```

### Add `pkg` Configuration

``` json
"pkg": {
  "scripts": [
    "index.js"
  ],
  "assets": [
    "config/**/*",
    "node_modules/@serialport/**/*"
  ]
}
```

#### Purpose

-   **scripts** → Entry files included in snapshot
-   **assets** → External files required at runtime
-   Required for native module loading (SerialPort)

------------------------------------------------------------------------

## 🧩 Step 3 --- Clean Existing Dependencies

Remove old dependency builds:

``` bash
rm -rf node_modules package-lock.json
```

(Windows PowerShell)

``` powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
```

------------------------------------------------------------------------

## 🧩 Step 4 --- Fresh Production Install

Install only production dependencies:

``` bash
npm install --production
```

Benefits: - Smaller executable size - Cleaner dependency tree -
Production optimization

------------------------------------------------------------------------

## 🧩 Step 5 --- Rebuild Native Modules

Fix native bindings (IMPORTANT for SerialPort):

``` bash
npm rebuild
```

This ensures compatibility with the pkg runtime.

------------------------------------------------------------------------

## 🧩 Step 6 --- Build Executables

### Windows Build

``` bash
pkg . --targets node18-win-x64 --output specigo-lis-engine.exe
```

### Linux Build

``` bash
pkg . --targets node18-linux-x64 --output specigo-lis-engine-linux
```

### macOS Build

``` bash
pkg . --targets node18-macos-x64 --output specigo-lis-engine-macos
```

## Include certificate.pfx in root dir of project before build
## File Name: certificate.pfx
## File Content:
```
Specigo LIS Engine.exe
Publisher: Craft Platforms Pvt Ltd

```


------------------------------------------------------------------------

## 🧩 Step 7 --- Deployment Folder Structure (IMPORTANT)

Create the following deployment layout:

    deployment/
    │
    ├── specigo-lis-engine.exe
    ├── config/
    │    └── analysers/
    │         └── au480_config.json

### Why Required?

`pkg` bundles application code but external configuration files must
remain outside.

------------------------------------------------------------------------

## 🧩 Step 8 --- Run Executable

### Default Run

``` bash
specigo-lis-engine.exe
```

### Run with Config File

``` bash
specigo-lis-engine.exe --config config/analysers/au480_config.json
```

------------------------------------------------------------------------

## 🧪 Testing Checklist

✅ Application starts successfully\
✅ Serial port opens correctly\
✅ Config file loads properly\
✅ Analyzer communication works\
✅ Logs generate without error

------------------------------------------------------------------------

## 🚨 Common Issues & Fixes

### 1. Native Build Not Found

**Reason:** SerialPort native bindings missing

**Fix**

``` bash
npm rebuild
```

------------------------------------------------------------------------

### 2. Device Guard Blocking EXE (Windows)

**Reason:** Organization security policy

**Solution** - Run as Administrator - Allow application in security
policy - Contact system administrator

------------------------------------------------------------------------

### 3. Config File Not Found

Ensure deployment structure is correct.

------------------------------------------------------------------------

## 🔐 Production Recommendations

-   Use **Node.js LTS version**
-   Avoid dev dependencies in production
-   Keep configuration external
-   Maintain versioned builds
-   Digitally sign EXE for enterprise deployment

------------------------------------------------------------------------

## 📦 Supported Targets

  Platform   Target
  ---------- ------------------
  Windows    node18-win-x64
  Linux      node18-linux-x64
  macOS      node18-macos-x64

------------------------------------------------------------------------

## 👨‍💻 Maintainer

**SpeciGo LIS Integration Engine**\
Transport Layer: Beckman Coulter AU480\
Organization: MMI Diagnostics

------------------------------------------------------------------------

## ✅ Conclusion

Following this guide ensures a **stable**, **portable**, and
**production-ready** executable build for the SpeciGo LIS Integration
Engine across multiple operating systems.

------------------------------------------------------------------------









`pkg` tool default mein executable ka icon change karne ka native support nahi deta hai. Jab aap apni node application ko `.exe` mein convert karte hain, toh Windows use default icon assign karta hai.

Iska icon badalne ke liye aapko **Resource Hacker** ya **rcedit** jaise tools ka istemal karna padega build hone ke baad.

Yahan do sabse asan tarike diye gaye hain:

### Method 1: Using `rcedit` (Recommended for Automation)
Agar aap chahte hain ki icon change karne ka process aapke build script ka hissa ban jaye, toh `rcedit` best hai.

1.  Pehle `rcedit` ko download karein ya npm se install karein:
    ```bash
    npm install -g rcedit
    ```
2.  Build generate hone ke baad ye command chalayein:
    ```bash
    rcedit "specigo-lis-engine.exe" --set-icon "your-icon.ico"
    ```

### Method 2: Using `resedit` (Alternative Node Package)
Aap `resedit` library ka use karke ek choti si JS script likh sakte hain jo build ke baad icon ko inject kar degi.

1.  Install karein: `npm install resedit`
2.  Ek `change-icon.js` file banayein jo aapke `.exe` file ke resources ko modify kare:

```javascript
const ResEdit = require('resedit');
const fs = require('fs');

const exeBuffer = fs.readFileSync('specigo-lis-engine.exe');
const res = ResEdit.Resource.from(exeBuffer);
const iconFile = ResEdit.Resource.IconGroupEntry.fromIconFile(fs.readFileSync('your-icon.ico'));

iconFile.replaceIn(res);
const newExeBuffer = res.generate();
fs.writeFileSync('specigo-lis-engine.exe', Buffer.from(newExeBuffer));
```

### Method 3: Resource Hacker (Manual Method)
Agar aapko coding ke bina sirf ek baar icon badalna hai:
1.  **Resource Hacker** download aur open karein.
2.  Apni `specigo-lis-engine.exe` file ko isme drag-and-drop karein.
3.  **Action** menu mein jayein aur **Add from a Resource file (*.res, *.ico, *.dll)...** select karein.
4.  Apna `.ico` file select karein aur file ko **Save** kar dein.

---

### Kuch Zaroori Baatein:
* **Icon Format:** Image file `.ico` format mein hi honi chahiye (PNG ya JPG kaam nahi karegi). Aap online converter se PNG ko ICO mein badal sakte hain.
* **Resolution:** Behtar result ke liye `.ico` file mein multiple sizes (16x16, 32x32, 48x48, 256x256) include karein taaki Windows har jagah use sahi se dikhaye.
* **Security:** Kyunki aap executable ko modify kar rahe hain, kuch antivirus ise "modified" ya "suspicious" mark kar sakte hain. Isliye professional use ke liye bad mein **Code Signing** (Certificate) zaroori hota hai.