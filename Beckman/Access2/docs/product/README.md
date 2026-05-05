# SpeciGo LIS Engine — Product Documentation

**Beckman Coulter Access 2 Integration Engine**

This directory contains the complete product documentation for the
SpeciGo LIS Integration Engine, the bridge service that connects a
Beckman Coulter Access 2 immunoassay analyser to the SpeciGo LIMS
platform.

---

## Audience map

| If you are… | Start with |
|---|---|
| **A new developer** joining the project | [01 Overview](01-overview.md) → [02 Architecture](02-architecture.md) → [06 Developer Guide](06-developer-guide.md) |
| **A site engineer** deploying at a lab | [03 Installation](03-installation.md) → [04 Configuration](04-configuration.md) |
| **A lab operator** using the control panel | [05 User Manual](05-user-manual.md) |
| **An integrator** building against the API | [07 API Reference](07-api-reference.md) |
| **A DBA / data analyst** querying results | [08 Database Schema](08-database-schema.md) |
| **An on-call engineer** debugging an outage | [10 Troubleshooting](10-troubleshooting.md) |

---

## Table of contents

1. [Overview](01-overview.md) — what this product does, who it serves, the
   problem it solves
2. [Architecture](02-architecture.md) — system components, data flow,
   module responsibilities
3. [Installation](03-installation.md) — server requirements, Node setup,
   Windows Service registration
4. [Configuration Reference](04-configuration.md) — every config field
   documented
5. [User Manual](05-user-manual.md) — control panel walkthrough for lab
   staff
6. [Developer Guide](06-developer-guide.md) — code conventions, module
   layout, contribution workflow
7. [API Reference](07-api-reference.md) — HTTP endpoints + JavaScript
   class APIs
8. [Database Schema](08-database-schema.md) — tables, columns, indexes,
   sample queries
9. [ASTM Protocol Reference](09-astm-protocol.md) — domain-specific
   protocol notes
10. [Troubleshooting](10-troubleshooting.md) — common failures and
    recovery steps
11. [Glossary](11-glossary.md) — terminology used throughout this
    documentation

---

## Quick links

- Source repository: `C:\Theranize\Projects\specigo-lis-engine\Beckman\Access2`
- Control panel (when running): <http://localhost:3003>
- Site: MMI Diagnostics, Raipur (`lab_uid 6887129073FDA`)
- Vendor reference: `docs/research/DXI ACCESS LIS Vendor Information C03112AC.pdf`
- Build guide (pkg-based executable): [`../specigo-lis-engine-build-guide.md`](../specigo-lis-engine-build-guide.md)
- Auto-start guide (Windows / Linux / macOS): [`../specigo-lis-engine-autostart-guide.md`](../specigo-lis-engine-autostart-guide.md)
- Code signing certificate notes: [`../pfx-certificate.md`](../pfx-certificate.md)

## Related documents

- [`PROJECT_GUIDE.md`](../../PROJECT_GUIDE.md) — Hindi/Hinglish developer
  walkthrough (informal style)
- [`IMPROVEMENTS.md`](../../IMPROVEMENTS.md) — open improvement backlog
- [`CODE_QUALITY_REVIEW.md`](../../CODE_QUALITY_REVIEW.md) — current code
  quality assessment
- [`BUGS.txt`](../../BUGS.txt) — historical bug list (partly superseded
  by IMPROVEMENTS.md)

---

## Documentation conventions

- File paths use forward slashes throughout, even when the runtime is
  Windows.
- Code samples use the language of the surrounding module (JavaScript
  for engine code, JSON for configs, SQL for database statements).
- "**The engine**" refers to the Node.js process running `index.js`.
- "**The panel**" refers to the control panel UI at port 3003.
- "**LIMS**" refers to the upstream Laboratory Information Management
  System that consumes our results via REST API.
- "**Access 2**" or "**the analyser**" refers to the Beckman Coulter
  Access 2 immunoassay instrument.
