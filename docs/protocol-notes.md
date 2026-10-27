# DSP protocol notes (t.racks DSP 4x4 Mini)

Written from reading the reference projects' documentation and protocol
codec sources. Facts only; all code in this project is original.

Reference licences for the record: Maskov-Track-Dsp-4x4 is GPL-3.0
(its LICENSE file governs; its README's MIT mentions are stale).
GlassOnTin/opendsp-4x4 is AGPL-3.0. Neither is built, run, installed,
forked, vendored, or copied. This project's own code is written from
these notes.

Note: the reference copies available at implementation time contained no
protocol source for the non-Pro Mini (README + binaries only) and no
PROTOCOL.md. The wire facts below come from the opendsp-4x4 PROTOCOL.md
and codec sources, which target the Mini Pro (same VID/PID 0168:0821).
The unit on this bench identifies as a Mini, so every fact below is
re-checked against the live device where marked LIVE.

## Transport

USB HID, VID 0x0168 PID 0x0821. 64-byte interrupt reports, no report ID.
Host sends one 64-byte OUT report per command, zero-padded. Device replies
with one IN report per request.

Linux identity: /dev/hidrawN with ID_VENDOR_ID=0168. Needs a udev rule or
equivalent or access is EACCES.

## Request frame (host -> device)

```
10 02 | 00 addr N code data... | 10 03 | checksum
```

- `10 02` is DLE STX, `10 03` is DLE ETX.
- Payload is `[0x00, addr, N, code, ...data]` with `N = 1 + data.length`.
- `addr` is 0x01 on USB.
- `checksum = XOR of all payload bytes, then ^ 1`.
- DLE bytes inside the payload are sent raw, never escaped.
- Whole frame is padded with zeroes to 64 bytes.

Golden vectors (cross-checked between two independent spots in the
reference material, LIVE re-check pending):
- level poll: `10 02 00 01 01 40 10 03 41`
- mute Out1 on: `10 02 00 01 03 35 04 01 10 03 33`

## Reply frame (device -> host)

Payload between the markers is `[addr, 0x00, N, code, ...data]` with
`N = 1 + data.length`. Total frame length is N+8 bytes. Checksum covers
the payload bytes the same way (`XOR ^ 1`).

## Opcodes

| code | use | payload |
|------|-----|---------|
| 0x10 | status / wake query | none, 1-byte reply |
| 0x12 | finalize handshake | none, short ack |
| 0x13 | version string | none, ASCII e.g. "4x4MINIPRO V010" |
| 0x52 | longer version string | none |
| 0x14 | flag | none, 1-byte reply |
| 0x22 | flags / link table | none, 30-byte reply |
| 0x27 | read channel block | `[index 0..8]`, reply code 0x24, 50 bytes each |
| 0x29 | read preset name | `[index 0..29]`, 14 ASCII bytes reply |
| 0x2c | config block | none, 7-byte reply |
| 0x20 | recall preset | `[slot]` |
| 0x21 | store preset | `[slot]` |
| 0x26 | set name | 14 ASCII bytes |
| 0x2f | lock password | 4 ASCII bytes, default "1234" |
| 0x30 | compressor | `[chan, ratio, knee, attack16, release16, threshold16]` |
| 0x31 | crossover LPF | `[chan, freq16, slope]` |
| 0x32 | crossover HPF | `[chan, freq16, slope]` |
| 0x33 | PEQ band | `[chan, band, gain16, freq16, q8, type8, bypass8]` |
| 0x34 | level / gain | `[chan, val16]` |
| 0x35 | mute | `[chan, on]` |
| 0x36 | polarity | `[chan, invert]` |
| 0x38 | delay | `[chan, samples16]` |
| 0x39 | test signal | `[source, freqIndex]` |
| 0x3a | routing | `[outChan, inputMask]` |
| 0x3e | noise gate | `[chan, attack16, release16, hold16, threshold16]` |
| 0x40 | poll audio levels | none, 27 data bytes, 8 meters |

Startup handshake order: 0x10, 0x13, 0x2c, 0x22, 0x14,
0x29 x30, 0x27 x9, 0x12, then steady 0x40 polls.

## Channels

Inputs InA..InD are 0x00..0x03, outputs Out1..Out4 are 0x04..0x07.

## Value scales

- Level/gain (0x34): raw u16 0..400. 0 dB = 281, +12 dB = 400,
  about 10 units per dB. Raw 0 floors around -60 dB.
- PEQ gain (0x33): raw u16 0..240, 0 dB = 120, 0.1 dB per step.
  dB = (raw - 120) / 10.
- Frequency (PEQ and crossover): log index 0..300, 30 steps per octave,
  Hz = 19.7 * 2^(index / 30). Index 0 is 19.7 Hz, 300 is ~20.2 kHz.
  Check: index 31 gives 40.3 Hz. Quick crossovers: 80 Hz -> 80.6,
  100 Hz -> 99.2, 120 Hz -> 119.4.
- PEQ Q: single byte, provisional mapping Q * 10. LIVE check pending:
  sweep q8 against the device readback and record the real range/step.
- Threshold (compressor, gate): raw = (dB + 90) * 2.
- Delay (0x38): u16 samples at 48 kHz, ms = samples / 48,
  max 32640 = 680 ms.
- Routing (0x3a): bit mask InA=1 InB=2 InC=4 InD=8.
- Compressor ratio: index 0..15 mapping 1:1.0 .. 1:20, Limit.
- Crossover slope byte, 0 = bypass: 1 BW6, 2 BL6, 3 BW12, 4 BL12,
  5 LK12, 6 BW18, 7 BL18, 8 BW24, 9 BL24, 10 LK24.
- PEQ type byte: 0 peak, 1 low shelf, 2 high shelf, 3 low cut,
  4 high cut, 5 allpass1, 6 allpass2.
- Test signal (0x39): source 0 off, 1 pink, 2 white, 3 sine;
  sine index 0..30 is third-octave 20 Hz..20 kHz.

## Readback

- 0x40 reply: 27 data bytes, 8 channel meters at data offsets
  2, 5, 8, .. 23 (stride 3), order InA..InD Out1..Out4.
- 0x27 -> nine 0x24 pages of 50 bytes rebuild a 450-byte preset image:
  preset name at +2 (14 ASCII); input records (24 B) at 16/40/64/88
  holding name(10) gate attack/release/hold/threshold gain polarity;
  output records (74 B) at 112/186/260/334 holding name(8) routing
  HPF/LPF freq raw HPF/LPF slope 7 PEQ bands x 6 B
  ([gain16, freq16, q8, type8]) comp ratio/knee/attack/release/threshold
  gain polarity delay.
- Mute, per-band EQ bypass, and test-signal state have no readback.
  The application tracks what it sent.

## LIVE check log

(append dated results from the bench unit here)
