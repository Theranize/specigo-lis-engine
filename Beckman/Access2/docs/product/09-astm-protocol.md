# 09 — ASTM Protocol Reference

This chapter documents the parts of the ASTM E1394 / LIS2-A2 protocol
that the engine implements, and the Access 2-specific quirks. It is a
working reference, not a complete protocol spec.

The authoritative source documents:
- ASTM E1394-97 (specimen identification standard)
- LIS2-A2 (Clinical Laboratory Information Standards)
- Beckman Coulter "DXI ACCESS LIS Vendor Information C03112AC"
  (located at `docs/research/`)

## Two-layer protocol

ASTM is split cleanly into two layers, and the engine reflects this in
its module structure:

| Layer | Engine module | Concerns |
|---|---|---|
| **Transmission layer** | `ASTMFramer` | ENQ, ACK, NAK, EOT, frame STX/ETX, checksum, retransmission |
| **Message layer** | `Access2Parser` | Records (H, P, O, R, L), fields, components |

The framer never looks inside frame text. The parser never sees the
raw bytes. They communicate via the `'message'` event, where the
payload is a single CR-delimited string of records.

## Transmission layer

### Special bytes

| Byte | Hex | Name | Direction | Meaning |
|---|---|---|---|---|
| ENQ | `0x05` | Enquiry | Analyser → Engine | "I want to start a transmission" |
| ACK | `0x06` | Acknowledge | Engine → Analyser | "I'm ready" / "frame received" |
| NAK | `0x15` | Negative Ack | Engine → Analyser | "frame rejected — retransmit" |
| STX | `0x02` | Start of Text | Analyser → Engine | Beginning of a frame |
| ETX | `0x03` | End of Text | Analyser → Engine | End of last frame in a message |
| ETB | `0x17` | End of Trans Block | Analyser → Engine | End of intermediate frame; another follows |
| EOT | `0x04` | End of Transmission | Analyser → Engine | All messages sent; session ends |
| CR | `0x0D` | Carriage Return | Both | Frame terminator + record separator |
| LF | `0x0A` | Line Feed | Both | Frame terminator |

### Transmission flow

```
Analyser                               Engine
   │                                     │
   ├──ENQ───────────────────────────────→│
   │                                     │
   │←─────────────────────────────────ACK│
   │                                     │
   ├──STX 1 H|...|<CR>P|...|<CR>...      │
   │   ETB CS1 CS2 CR LF────────────────→│
   │                                     │
   │←─────────────────────────────────ACK│   (frame 1 valid)
   │                                     │
   ├──STX 2 R|...|<CR>L|... ETX          │
   │   CS1 CS2 CR LF────────────────────→│
   │                                     │
   │←─────────────────────────────────ACK│   (frame 2 valid; ETX = last frame)
   │                                     │
   │   (engine emits 'message' event)    │
   │                                     │
   ├──EOT───────────────────────────────→│
   │                                     │
   ▼                                     ▼
```

### Frame structure

```
| STX | frame_no | text | ETX or ETB | CS1 | CS2 | CR | LF |
  1     1          ≤240    1            1     1     1    1
  byte  byte       bytes   byte         byte  byte  byte byte
```

- `frame_no` is the ASCII digit `'1'`–`'7'`. Wraps `1→2→…→7→0→1`.
- `text` contains one or more CR-separated ASTM records. ETB-terminated
  frames may split a record across frames, but the Access 2 doesn't do
  this in practice.
- `CS1 CS2` are two ASCII hex characters representing the checksum.

### Checksum

```
sum  = frame_no_byte
     + sum(text bytes)
     + ETB_or_ETX_byte
       (record-separator CR bytes inside text are included; the trailing
        CR LF after CS1 CS2 are NOT)

cs   = sum mod 256

CS1  = upper hex digit of cs (e.g. cs=0xA3 → '4')   wait, that's wrong
       upper nybble: cs >> 4  → '0'-'9' or 'A'-'F'
CS2  = lower nybble: cs & 0xF
```

Two ASCII hex chars, **uppercase**. Example: cs = 0xA3 → `"A3"` →
bytes `0x41 0x33`.

If the received checksum doesn't match the engine's computed value:
- Increment `framer.stats.checksumErrors`
- Send NAK
- Discard the in-progress message buffer
- Stay in the TRANSMISSION state — analyser will retransmit the frame

### State machine

The framer's state machine is implemented in
`ASTMFramer._processByte()`. States:

```
IDLE
  ↓ (ENQ received) → send ACK, emit 'transmissionStart'
TRANSMISSION
  ↓ (STX received)
IN_FRAME
  ↓ (first byte: frame number stored)
  ↓ (subsequent bytes accumulate into _frameBody)
  ↓ (ETX or ETB received)
CHECKSUM1
  ↓ (CS1 byte stored)
CHECKSUM2
  ↓ (CS2 byte stored)
AWAIT_CR
  ↓ (CR received)
AWAIT_LF
  ↓ (LF received) → checksum verified, ACK sent, message buffer appended
TRANSMISSION
  ↓
  (loop until ETX terminates a frame; emit 'message')
  (or until EOT received → IDLE, emit 'transmissionEnd')
```

Recovery paths:
- Unexpected byte in `IDLE` → discarded silently
- Unexpected byte in `TRANSMISSION` → discarded silently
- Frame body exceeds `maxFrameBytes` → NAK sent, error emitted, state
  reset to TRANSMISSION
- Missing CR before LF → warning logged, frame still processed (some
  implementations omit CR)
- Missing LF after CR → frame processed, unexpected byte reprocessed
  in the new state

## Message layer

A complete ASTM message is a sequence of CR-delimited records. Each
record begins with a single uppercase letter identifying its type.

### Records used by the Access 2

| Type | Letter | Emitted by Access 2? | Engine behaviour |
|---|---|---|---|
| Header | `H` | Always (1 per message) | Resets session state, captures sender |
| Patient | `P` | When patient demographics present | Captures name, DOB, sex |
| Order | `O` | Always (1 per sample) | Captures barcode, derives result category |
| Result | `R` | One per parameter | Parses into ParsedResult, accumulates |
| Comment | `C` | Sometimes | Currently ignored |
| Query | `Q` | Only in host-query mode | Currently ignored |
| Terminator | `L` | Always (1 per message) | Triggers `'results'` event with accumulated R records |

### Field structure

Records are pipe-delimited (`|`). Fields can have components separated
by `^`. Repeated components separated by `\` (currently unused by
Access 2).

Example R record:
```
R|1|^^^TSH^^|2.5|uIU/mL|0.27-4.20|N||F||...|20260504104530|ACCESSII
└┘ │ └────────┘  └─┘   └──────┘  └────────┘ │ │            │       │
 1 2     3        4       5         6        7 8    …        12      13
```

| Index | Name | Example | Notes |
|---|---|---|---|
| 0 | Record type | `R` | always `R` for results |
| 1 | Sequence number | `1` | per-record counter within a message |
| 2 | Universal Test ID | `^^^TSH^^` | components `[empty, empty, empty, assay_code, assay_name?, empty]` |
| 3 | Measurement value | `2.5` | numeric, or text like `"Reactive"`, or `">250"` |
| 4 | Units | `uIU/mL` | |
| 5 | Reference interval | `0.27-4.20` | |
| 6 | Abnormal flag | `N` | `N`/`H`/`L`/`HH`/`LL`/`A`/`<`/`>`/`I`/`R`/`NR`/`E` |
| 7 | Nature of abnormality | (empty) | usually empty |
| 8 | Result status | `F` | `F`/`P`/`C`/`X`/`I`/`S`/`M` |
| 9 | Date/time of change | (empty) | |
| 10 | Operator ID | (empty) | |
| 11 | Date/time test started | (empty) | |
| 12 | Date/time test completed | `20260504104530` | YYYYMMDDHHMMSS — what we use as `received_at` |
| 13 | Instrument ID | `ACCESSII` | falls back to H record sender |

### Universal Test ID component layout

The R record's field 2 is `^^^assay_code^^`. Component breakdown:

| Component index | Content | Used? |
|---|---|---|
| 0 | (empty) | no |
| 1 | (empty) | no |
| 2 | (empty) | no |
| 3 | Assay code (`TSH`, `FT4`, `PSA`) | **yes — primary lookup key** |
| 4 | Assay name (sometimes) | optional fallback for display |
| 5 | (empty) | no |

### P record specifics for Access 2

The Beckman Coulter Access 2 uses non-standard field offsets compared
to vanilla LIS2-A2. Confirmed empirically from device output:

```
P|1||LAB123||||Last^First||19940315|M
└┘ │ │  │  │ │ │  │       │  │       │
 0 1 2  3  4 5 6  7       8  9       10
```

| Index | Field | Notes |
|---|---|---|
| 1 | Sequence number | |
| 2 | Practice patient ID | empty on Access 2 |
| 3 | Lab patient ID | sometimes used |
| 7 | Patient name | `Last^First` — the engine reconstructs as `"First Last"` |
| 9 | Birthdate | `YYYYMMDD` |
| 10 | Sex | `M` / `F` / `U` (Unknown) / `I` (Indeterminate) |

The reconstruction logic in `Access2Parser._parsePatientRecord()` is:

```js
const lastName  = (nameParts[0] || '').trim();
const firstName = (nameParts[1] || '').trim();
const patientName = [firstName, lastName].filter(Boolean).join(' ') || lastName;
```

Note: BUG-011 — when both names are empty, `lastName` is also empty
string, so `patientName` becomes `''` instead of `null`. Fix on the
backlog.

### O record specifics

Field 3 is the **Specimen ID** — what we call `barcode_uid`. This is
the primary identifier for the sample tube.

The parser derives `resultCategory` from the barcode prefix:

| Prefix | Category | Filtered if `qc_results: false` etc. |
|---|---|---|
| `QC*` | `'QC'` | yes |
| `CAL*` | `'CALIBRATION'` | yes |
| anything else | `'PATIENT'` | no |

This is a heuristic — the formal way is to check field 26 ("Result
report type"), but the Access 2 doesn't always populate it.

## Multi-message transmissions

A single ENQ → EOT session can contain multiple logical messages, each
H...L. Example:

```
ENQ
STX 1 H|...|<CR>P|...|<CR>O|...|<CR>R|...|<CR>L|... ETX CS1 CS2 CR LF
ACK
STX 2 H|...|<CR>P|...|<CR>O|...|<CR>R|...|<CR>L|... ETX CS1 CS2 CR LF
ACK
EOT
```

Each H starts a new message; the framer emits a separate `'message'`
event for each. The parser resets its session context on every `H`.

## Multi-frame messages

A long message (e.g. one with many R records) can span multiple frames
joined by ETB. Example:

```
STX 1 H|...|<CR>P|...|<CR>O|...|<CR>R|... ETB CS1 CS2 CR LF
ACK
STX 2 R|...|<CR>R|...|<CR>L|... ETX CS1 CS2 CR LF
ACK
```

The framer accumulates frame text into `_messageBuffer` until ETX
arrives, then emits the concatenated whole.

## Engine's compliance posture

What the engine does:
- Validates checksum on every frame
- Sends NAK on bad checksum or oversized frame
- Honours frame numbers loosely (does not enforce strict 1→7 sequence)
- Tolerates missing CR/LF gracefully

What the engine does **not** do:
- Send Q records (no host queries — Access 2 is push-only here)
- Implement timeout for unresponsive analyser (relies on the analyser's
  own timeout)
- Expose a re-ENQ retry counter (analyser handles its own retry policy)

## ASTM message example

A complete sample transmission for one TSH result on barcode `ABC123`:

```
ENQ

STX
1
H|\^&|||ACCESSII^3.4.0|||||||P|1|20260504104530<CR>
P|1||PAT001||||Sharma^Rahul||19940315|M<CR>
O|1|ABC123||^^^TSH^^|R||20260504104500|||||||||||||||||||F<CR>
R|1|^^^TSH^^|2.50|uIU/mL|0.27-4.20|N||F||||20260504104530|ACCESSII<CR>
L|1|N<CR>
ETX
A3
CR
LF

ACK (from engine)

EOT
```

That entire sequence takes about 200–300 ms over 9600 baud serial.

---

**Next:** [10 Troubleshooting](10-troubleshooting.md)
