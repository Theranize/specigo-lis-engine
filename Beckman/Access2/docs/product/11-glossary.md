# 11 — Glossary

Terms used throughout this documentation, in alphabetical order.

## ACK
Acknowledge byte (`0x06`). Sent by the engine to the analyser to
confirm a frame was received with a valid checksum, or that an ENQ was
seen and a transmission can begin. The opposite of NAK.

## Analyser / Analyzer
The Beckman Coulter Access 2 immunoassay instrument. Spelled
"analyser" (British English) in user-facing copy and "analyzer" in
code field names (because the SpeciGo LIMS schema uses American
English).

## ASTM E1394
The American Society for Testing and Materials standard for clinical
laboratory data interchange. The transport-and-message protocol the
Access 2 uses to transmit results. See [09 ASTM Protocol
Reference](09-astm-protocol.md).

## Assay
A specific laboratory test (e.g. TSH, PSA, HIV antibody). The Access 2
runs about 33 different assays in this configuration.

## Assay code
The short identifier the analyser emits in the R record's Universal
Test ID field — e.g. `"TSH"`, `"FT4"`. Used as the lookup key in the
parameter map.

## Auto-Send mode
The Access 2's setting that pushes every completed result over LIS
without waiting for a host query. Configured on the analyser as
"Auto-Send to LIS: Send All Results". The engine assumes this mode.

## Backoff
Exponential delay between retry attempts. The engine's
`ConnectionSupervisor` uses 5 s → 10 s → 20 s → 40 s → 60 s (capped).

## Barcode (sample barcode, `barcode_uid`)
The unique identifier physically on the sample tube, scanned by the
Access 2 at sample loading. Travels through the engine in the O
record's Specimen ID field. Stored in `lis_results.barcode_uid`.

## Baud rate
Serial line signalling speed in bits per second. The Access 2 uses
9600 baud — i.e. 1200 bytes/second after start/stop bits.

## Channel
Synonym for COM port in some Windows contexts.

## Checksum (CS1, CS2)
Two ASCII hex characters at the end of an ASTM frame. Computed as
`SUM(frame_no + body + terminator) mod 256`. The framer recomputes and
NAKs frames where the received and computed checksums differ.

## COM port
Windows naming for a serial port: `COM1`, `COM4`, etc. The engine
references one in its `connection.port` config field.

## ConfigLoader
The static helper class that reads and validates both JSON config
files at startup. See [06 Developer Guide](06-developer-guide.md).

## ConnectionSupervisor
The reusable retry-with-backoff loop. Two instances run in the engine:
one for the serial port, one for the database.

## ENQ
Enquiry byte (`0x05`). Sent by the analyser to begin a transmission
session. The engine responds with ACK to enter the TRANSMISSION state.

## Engine
The Node.js process running `index.js`. Manages the full pipeline
from serial bytes to LIMS push.

## EOT
End of Transmission byte (`0x04`). Sent by the analyser to signal
"all messages sent; session over". The framer returns to IDLE state.

## ETB
End of Transmission Block (`0x17`). Frame terminator indicating "this
is an intermediate frame; another follows for this message". Differs
from ETX.

## ETX
End of Text (`0x03`). Frame terminator indicating "this is the last
frame of this message". The framer emits the assembled message on ETX.

## Flag (abnormal flag)
The R record's field 6 — `N` (Normal), `H` (High), `L` (Low), `HH`
(Critical High), `LL` (Critical Low), `A` (Abnormal), `<` (Below
detection), `>` (Above range), and others. Stored in `lis_results.flag`
as a human-readable string ("Normal", "High", etc.) after translation
in `Access2Parser._parseFlagMeaning()`.

## Frame
One ASTM transmission unit: `STX | frame_no | text | ETX/ETB | CS1 |
CS2 | CR | LF`. Maximum 240 body bytes per spec. A logical message can
span multiple frames.

## Framer
`ASTMFramer` — the byte-level state machine that reassembles frames
into messages.

## H record
The first ASTM record in any message. Carries metadata: sender ID,
processing ID, version, timestamp. The engine captures the sender for
later use.

## L record
The last ASTM record in any message. Marks the end. The parser emits
its accumulated results when L arrives.

## LIMS
Laboratory Information Management System. The upstream cloud system
that consumes the engine's results via REST API. Different from "LIS"
(Laboratory Information System) which is what this engine itself **is**.

## LIS
Laboratory Information System. In this project's naming, the engine
is the LIS bridge — it translates between the analyser's protocol and
the LIMS's API.

## LIS2-A2
The CLSI revision of ASTM E1394. Functionally equivalent for our
purposes; the Access 2 documentation references both.

## LOINC
Logical Observation Identifiers Names and Codes. A universal
vocabulary for laboratory tests. Each parameter in the engine's
`parameter_map` carries its LOINC code so downstream systems
(insurance, EHR, research) can semantically map results across
analysers and labs.

## Mapped result
A `MappedResult` object — produced by `ParameterMapper.map()` and
consumed by `ResultWriter.write()`. Contains both the analyser's data
(value, unit, flag) and the LIMS-side identifiers (parameter UID,
test UID, LOINC).

## Mapping status
`'MAPPED'` if the assay code was found in the parameter map,
`'UNMAPPED'` otherwise. Stored in `lis_results.mapping_status` once
BUG-002 is fixed.

## Message
One ASTM "logical message" — H ... L records. May span multiple
frames. Multiple messages may exist within a single ENQ–EOT session.

## NAK
Negative Acknowledge byte (`0x15`). Sent by the engine to signal
"frame rejected; please retransmit". Triggers when the checksum
doesn't validate or the frame body exceeded `maxFrameBytes`.

## Node.js
The runtime the engine is written in. Version ≥ 18 required.

## O record
Order record. The third ASTM record in a typical message. Carries
the sample's barcode (Specimen ID, field 3) and other order metadata.

## P record
Patient record. The second ASTM record. Carries patient name, DOB,
sex.

## ParsedResult
A JavaScript object produced by `Access2Parser`. Camel-cased fields:
`assayCode`, `numericValue`, `sampleId`, `patientName`, etc. Consumed
by `ParameterMapper.map()` which emits `MappedResult` objects.

## Pool (connection pool)
A pool of mysql2 connections kept open for reuse, avoiding the
overhead of opening a new connection per query. Configured by
`database.poolSize` (default 5).

## R record
Result record. The fourth ASTM record. One per parameter measured —
i.e. a single sample with 5 panels generates 5 R records. The most
data-rich record type.

## Reconnect
The act of re-opening a previously-closed serial port. Owned entirely
by `ConnectionSupervisor.notifyDisconnected()` since the
`SerialPortManager` no longer schedules its own reconnects.

## Result status
The R record's field 8 — `F` (Final), `P` (Preliminary), `C`
(Correction), `X` (Cannot be done), and others. Will be persisted in
`lis_results.result_status` once BUG-002 is fixed.

## RS-232
The physical serial communication standard the Access 2 uses. 9-pin
or 25-pin connector, asynchronous, ±12 V signalling.

## Sample
A single specimen tube — uniquely identified by its barcode.
Different from a parameter; one sample typically yields multiple
parameters.

## Settle guard
A defensive pattern in `SerialPortManager._openPort()` that ensures
the open promise resolves or rejects exactly once even when multiple
events (`error`, `close`, `open`) fire for the same underlying
condition.

## STX
Start of Text byte (`0x02`). Frame opener.

## Supervisor
Short for `ConnectionSupervisor`. The engine has two — `_serialSupervisor`
and `_dbSupervisor`.

## TRANSMISSION (state)
The framer state between ENQ and EOT, where individual frames are
expected.

## Transmission session
The complete ENQ → EOT sequence. May contain multiple logical messages.

## Tube
Synonym for sample.

## Universal Test ID
The R record's field 2 — `^^^assay_code^^`. Components separated by
`^`. Component index 3 holds the assay code, which is the engine's
mapping key.

## Winston
The logging library. The engine's shared logger factory
(`src/logger.js`) wraps it and provides the project-wide format.

---

**End of documentation.** See [README](README.md) for the table of
contents.
