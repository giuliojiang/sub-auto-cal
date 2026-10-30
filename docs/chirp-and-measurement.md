# Chirp generation, detection, and individual measurements

Spec for the optimization loop's measurement side. Status: **spec, not yet
implemented in this working copy** — chirp code exists locally on the
author's machine but does not work yet, so it was not pushed; this
document is the target that code should converge to. (The design it
builds on is in `docs/loop-notes.md`, section "Large Mutation Strategy
V2".) This document turns that design's precondition — time-aligned
per-output measurements — into exact, implementable rules: what signal
is generated, how it is detected, what DSP state each measurement mode
requires, and how the optimizer loop uses the results.

Read first: `docs/loop-notes.md` (V2 loop, surrogate, bounds) and
`docs/protocol-notes.md` (transport, value scales, readback limits).
All sample rates are 48 kHz (`MEASURE_RATE`, `SAMPLE_RATE`). All DSP
writes go through `DspDevice` (`src/dsp/device.ts`); channel numbers are
`CH.inA..inD = 0..3`, `CH.out1..out4 = 4..7`; routing mask bits are
`InA=1, InB=2, InC=4, InD=8` (`src/dsp/protocol.ts`).

## 0. The one idea

Playback and capture are separate USB devices with independent clocks and
OS scheduling, so the delay between sweep start and capture start jitters
from sweep to sweep. 1 ms of unknown offset is 36° at 100 Hz and 72° at
200 Hz — it destroys exactly the inter-output phase relationships the
optimizer acts on. The fix is a timing reference inside every capture:
a short chirp, played through a fixed reference source, whose detected
onset anchors t=0 for that capture. Everything else in this document
follows from that sentence.

Three properties make the anchor work, and each is a hard rule below:

- The anchor is **per capture**, not per session. A session-wide offset
  does not exist; every capture re-anchors itself.
- A **constant** anchor error cancels across measurements (it shifts
  every IR by the same amount, which is a common time origin, not a
  relative delay). Only **detection jitter** — anchor error that varies
  capture to capture — matters. This is why sub-sample interpolation is
  required, not optional.
- The reference source is **fixed** (sub 1) for every measurement,
  including sub 1's own. A reference played through the output under
  test would subtract out the inter-output delay differences being
  modelled. (For sub 1's own measurement the chirp and the sweep both
  come from sub 1 — that is still valid, because the anchor comes from
  the chirp's own correlation peak at a known time offset before the
  sweep, not from the sweep itself. What is forbidden is using the
  sweep under test as its own time reference.)

## 1. Wiring assumption — verify it before anything else

The stereo playback stream is split by the DSP's input routing:

- Playback **left → DSP InA** (the "main" input).
- Playback **right → DSP InB** (the "chirp" input).

If the cabling differs, the routing masks in section 5 swap, but the
structure is identical. Verify with the existing meters path
(`DspDevice.meters()`, 0x40 poll, order InA..InD, Out1..Out4): play a
left-only signal and confirm only the InA meter moves; play a
right-only signal and confirm only the InB meter moves. Do this once
per physical setup, not once per measurement — and re-do it if any
cable moves. A swapped L/R here silently mirrors every measurement in
the set, and no later check can catch it, because the error is
identical in all four captures.

Input gains, polarity, and gates for InA/InB stay at their snapshot
values for the whole session and are never touched by the measurement
modes. They are common to every capture (sweep always through InA,
chirp always through InB), so they cancel from every comparison the
optimizer makes. What they must not be is too low: run the existing
noise/volume check (`noiseCheck` in `src/audio.ts`) before a
measurement set, and refuse to start a set on a "too low" verdict.

## 2. The playback buffer (stereo)

Each chirp-anchored capture plays **one** stereo buffer, built as:

```
time:    |<-- chirp -->|<-- gap -->|<-------------- sweep ------------->|
left:    |   silence   |  silence  |  ESS sweep (genESS, as today)      |
right:   |   chirp     |  silence  |  silence                          |
```

- **Chirp**: exponential sine sweep, **500 Hz → 3 kHz, 100 ms**,
  generated with the same code path as `genESS` (same fade code, so
  the detection template in section 3 is bit-identical to what is
  played). Peak amplitude 0.25, same as `genESS`. The band sits above
  the scored band (defaults: fStart 20 Hz, fEnd 300 Hz) and mostly
  above the played sweep's top (fEnd × 2 = 600 Hz). The rig can use a
  sub as the chirp source: the subs are dual 6.5" drivers per cabinet
  with significantly usable HF output and no low-pass anywhere in the
  signal path. Time separation (chirp first, sweep later) is the real
  isolation mechanism; the frequency separation is belt-and-braces so
  the chirp's room tail does not sit in the scored band.
- **Gap**: **100 ms** of silence between chirp end and sweep start.
  Purpose: keep the chirp's direct sound and early reflections out of
  the sweep IR's onset region. The chirp's later room tail still
  overlaps the sweep recording, but as signal uncorrelated with the
  sweep it contributes a small noise floor to the deconvolution, not
  a bias — that is acceptable and is not a reason to lengthen the gap.
- **Sweep**: exactly today's `genESS(fStart / 2, min(20000, fEnd * 2),
  sweepSecs)` — same band, same length, same fades, same 0.25 peak.
  Nothing about the sweep changes; only the buffer around it does.
- **Total buffer**: `T_chirp + T_gap + T_sweep` (0.1 + 0.1 + sweepSecs
  seconds). Recording length is buffer length + 2.0 s (the existing
  1.5 s tail + 0.5 s margin), rounded up to whole seconds for
  `arecord -d`.

### Capture-first ordering (this is the footgun)

The legacy combined loop starts playback, waits 250 ms, then starts
recording — that works there because the sweep is seconds long and the
IR onset is found by peak search. **It does not work for chirp
captures**: the chirp sits at the start of the buffer, so with
playback-first staggering the chirp has already played before the
recording starts, and there is nothing to detect.

Chirp captures therefore use **capture-first ordering**:

1. Start the mono recording (`arecord -c 1`, as today).
2. Wait ~100 ms for the recorder to arm.
3. Start stereo playback.
4. Record for buffer + 2.0 s, then stop.

With this ordering the chirp onset lands a small, positive time into
the recording (arm wait + DSP latency + acoustic delay, typically well
under 1 s). The absolute offset does not matter — detection finds it —
but the ordering is what guarantees the chirp is in the recording at
all.

### Stereo write path (new code required)

Today's `writeWav` writes **mono** and `recordWav` records mono. For
chirp captures the **write** path must become stereo (interleaved
L/R, 16-bit, 48 kHz); the **record** path stays mono (the UMIK-1 is
mono; it records the acoustic sum of chirp and sweep, which is
exactly what detection and deconvolution need).

One more constraint on playback: prefer a direct ALSA device
(`aplay -D plughw:…`) at 48 kHz over a PulseAudio sink for chirp
captures. A PulseAudio sink running at another rate resamples the
buffer, so the played chirp no longer matches the detection template
exactly: the correlation peak broadens and sub-sample accuracy
degrades. The detection-margin check in section 3 catches a bad case
after the fact, but the default path should not create it. (Today's
`playWav` tries `paplay` first; the chirp playback path must not
inherit that order blindly.)

## 3. Chirp detection (matched filter)

Input: the mono recording `r[n]`, and the chirp template `c[n]` — the
exact samples written to the right channel, including fades.

1. **Correlate, FFT-based.** Compute `y = linearConvolve(r,
   reverse(c))` using the existing FFT code (`src/measure/sweep.ts`).
   Do not write a naive O(N·M) loop: a 100 ms template at 48 kHz is
   4800 taps against a ~6 s recording. Index mapping: the chirp
   onset sample `s` satisfies `s = argmax(y) − (len(c) − 1)`.
   (Convolution with the time-reversed template peaks at
   `s + len(c) − 1`; subtract to recover the onset.)
2. **Sub-sample refine.** Parabolic interpolation on the three
   correlation samples around the peak gives a fractional offset
   δ; the anchor is `A = s + δ` in recording samples. This step is
   mandatory: one whole sample at 48 kHz is 20.8 µs, which is 0.75°
   at 100 Hz and 1.5° at 200 Hz — small, but interpolation costs
   nothing and detection jitter is the only error that does not
   cancel (section 0).
3. **Search window.** With capture-first ordering, the chirp onset
   must fall in the first 2 s of the recording. Search only that
   window. A peak outside it is a false lock (room reflection, noise)
   and must fail, not be trusted.
4. **Validate, then trust.** Report and check, per capture:
   - peak-to-second-peak ratio, excluding ±240 samples (±5 ms)
     around the peak;
   - peak level against the RMS of the first 50 ms of the recording
     (pre-playback noise floor).
   Starting points, to tune from data: ratio ≥ 2, peak ≥ 20 dB above
   the pre-roll RMS. Tuned 2026-10-30 on the real rig: ratio ≥ 1.25,
   because the room has an 8.6 ms early reflection at 0.73× the direct
   chirp, so a clean direct lock measures ~1.37. Mixed direct/echo
   locking across a set is guarded instead by the echo-pattern
   consistency check (second-peak delay within ±48 samples on all
   four takes). If either check fails, **throw and fail the
   measurement loudly**. Never fall back to peak-search onset for a
   per-output measurement: a silently unanchored IR in the surrogate
   set is worse than a failed set, because it corrupts the coherent
   sum while looking like data.
5. **Do not reuse the existing onset helpers for this.** `alignOnset`
   in `sweep.ts` is a decimated (÷16) cross-correlation — far too
   coarse for an anchor. `deconvolveToFR`'s peak search (±1 s around
   the expected IR peak) is the legacy magnitude-only path; it is
   correct for what it does (section 5, Mode B) and wrong for
   anchoring, because it aligns on the sweep's own energy.

### Chirp-only diagnostic mode (Mode C)

Before the first real measurement set on a new setup, run a
chirp-only capture (section 5, Mode C) and print: anchor position,
correlation peak, both validation margins, and the implied acoustic
latency (anchor minus playback start, in ms). If detection is
struggling, this mode isolates it from everything else: no sweep, no
surrogate, no optimizer — just "can the mic hear sub 1's chirp
through InB, and can the detector find it." Debug here, not inside a
measurement set.

## 4. From anchor to complex IR

1. **Sweep onset.** `S = A + (T_chirp + T_gap) · sr`, in recording
   samples. This is exact, not estimated: chirp and sweep share one
   playback buffer and one clock, so their spacing in the recording
   is the spacing in the buffer, regardless of when playback started
   or what the USB clocks did.
2. **Deconvolve exactly as today, but with a computed onset.**
   Convolve the full recording with `inverseESS(sweep)` (same
   function, same normalization). In `deconvolveToFR` the IR peak is
   expected at `sweep.length − 1` for a recording that starts at the
   sweep onset; here the recording starts earlier, so the IR peak is
   at `onset_conv = round(S) + (sweep.length − 1)`. Window the IR
   identically to today: 2 ms raised-cosine pre-roll before the peak,
   10%-of-length raised-cosine fade at the tail. **The windowing and
   the FFT length must be identical across all four per-output
   measurements** — truncate all four IRs to the same length (the
   shortest) before the FFT, so all four spectra share one frequency
   grid. Different grids cannot be coherently summed.
3. **Keep the complex spectrum.** Today's `deconvolveToFR` returns
   only dB magnitude (`FR { freqs, db }`). The surrogate needs
   **complex** H_i(f): magnitude and phase on the shared grid. Add a
   function (e.g. `deconvolveToComplexIR`) that returns the complex
   FFT output, not just its magnitude. The magnitude path
   (`deconvolveToFR` → `interpLog` → `smoothOctave` → `scoreResponse`)
   stays exactly as it is for Mode B scoring; the surrogate sums
   complex spectra first (section 6) and only then takes magnitude.
4. **Mic calibration is magnitude-only.** `applyCal` (in
   `src/measure/miccal.ts`) corrects dB magnitude from the UMIK-1
   per-serial calibration file. Apply it to |H_i(f)| in dB; leave the
   phase exactly as measured. Calibration files carry no phase, and
   inventing one would corrupt the relative delays the surrogate
   exists to model.

### Error budget (why this is good enough, and where it stops)

- Detection jitter after interpolation: a fraction of a sample,
  i.e. well under 1° at 200 Hz. Negligible next to the 36°/72° problem
  being solved.
- Clock drift between the separate USB devices: a stretch error,
  not an offset — it grows with time from the anchor, roughly
  `ppm × t`. At tens of ppm over a ~4 s sweep this is of order
  100–250 µs of progressive skew across the IR tail, i.e. up to
  ~10–18° at 200 Hz at the far tail. Mitigations, in order: keep
  captures short (the default 4 s sweep, not longer); weight the IR
  by the existing tail fade, which down-weights the far tail where
  the skew is worst; and let the real verification sweep arbitrate
  every committed candidate (section 7) — residual drift error can
  mis-rank a screening candidate, but it cannot silently commit a
  bad one. A closing chirp after the sweep (two anchors → measured
  stretch → resample correction) is a valid later refinement; it is
  not part of v1.
- Room tail of the chirp overlapping the sweep: uncorrelated noise
  in the deconvolution (section 2), not a bias. No action needed.

## 5. DSP state per mode — the tables

All modes share: one `dev.exclusive()` block around the whole
measurement (writes + settle + play + record), so UI writes cannot
interleave; a 400 ms settle after the last DSP write before playing
(the existing `applyCandidate` default); verification of what was
written by `dev.refresh()` readback (routing, gain, delay, PEQ all
read back through the 0x27 pages; mute and per-band bypass do **not**
read back — the app tracks what it sent, so never use mute or
assumed-bypass state as a measurement condition).

**Silence by routing mask, never by mute.** Non-measured outputs get
mask 0 (verified by readback). Mute has no readback, so a muted
output you cannot verify is a measurement you cannot trust.

### Mode A — single-output measurement (per-output IR, for the surrogate)

For output i = 1..4, in order:

| Step | DSP writes (all via `DspDevice`, verified by `refresh()`) |
|------|----------------------------------------------------------|
| 1. Baseline | Every output, every band: PEQ **gain 0 dB**, freq/Q/type **as loaded**, bypass **false** — except cut/allpass bands (types 3/4/5/6), which cannot be flattened by gain and must be written **bypass true** instead. (A peak/shelf band at 0 dB is exactly unity for any freq/Q, so the baseline is acoustically flat regardless of the loaded freq/Q. A cut/allpass band at 0 dB is not flat at all — this is the one baseline subtlety that bites.) |
| 2. Baseline, cont. | Every output: channel gain = **snapshot gain** (the GO bases), channel delay = **snapshot delay**. Crossovers, compressors, gates, polarity, and all input params: **untouched** (they are part of the measured H_i and constant across the set, so they cancel from every comparison). |
| 3. Routing matrix | Out_i: mask **1** (InA only). If i ≠ 1, Out_1: mask **2** (InB only). If i = 1, Out_1: mask **3** (InA \| InB — chirp and sweep summed, time-separated in the buffer). Every other output: mask **0**. Verify all four masks by `refresh()` before proceeding — the existing `candidateMismatches` pattern verifies gains/delays/PEQs but **not** routing, so the matrix needs its own refresh check. |
| 4. Settle | 400 ms. |
| 5. Capture | Stereo buffer (section 2), capture-first ordering, mono recording, length buffer + 2.0 s. |
| 6. Process | Detect chirp (section 3, loud failure on bad margin) → sweep onset (section 4) → complex IR on the shared grid → magnitude mic-cal. |
| 7. Record | Store H_i(f) complex + anchor metadata (A, S, correlation peak, both validation margins) + the **verified** DSP state from `refresh()` + the recording WAV under `recordings/` (same convention as the legacy loop). |

After all four outputs: **restore the snapshot state with
`dev.revert()` and verify by `refresh()`** — revert restores routing,
gains, delays, PEQs, mutes, polarity, gates, and compressors from the
GO snapshot. Do not skip this because "the next step rewrites the
DSP anyway": the next step might be a Mode B verification sweep, and
a Mode B sweep run under the leftover measurement matrix measures one
sub plus a chirp instead of the combined response.

### Mode B — full combined measurement (verification, and the legacy loop)

This is today's `measure()` in `src/measure/loop.ts`, unchanged:

| Item | Value |
|------|-------|
| DSP state | Candidate pushed by `pushCandidate`: all 4 outputs, gains, delays, all 7 PEQ bands **un-bypassed**, types **preserved** (never changed). Verified by `candidateMismatches` (snapped scales), up to 3 tries, inside `dev.exclusive()`. |
| Routing | **Snapshot routing** (the normal listening matrix), restored by the Mode A cleanup before any Mode B sweep. Never the measurement matrix. |
| Signal | Mono ESS sweep, today's `genESS` call; playback-first + 250 ms stagger is fine here. |
| Onset | Today's peak search in `deconvolveToFR` (±1 s around `sweep.length − 1`). Correct for magnitude scoring: each sweep is self-consistent, and no cross-sweep phase comparison happens. |
| Output | Magnitude FR → `interpLog` (480-point log grid) → `smoothOctave` 1/12 → `scoreResponse` → J = 2·F + S_loss (`FLATNESS_WEIGHT = 2`, `SPL_WEIGHT = 1`, `IMPROVE_DB = 0.05`). |

Mode B needs no chirp. Adding one would not improve a magnitude
score, and the chirp would only add a second signal to explain.
The one thing Mode B must never do is run under Mode A's matrix —
that is the footgun section 5's cleanup step exists to prevent.

### Mode C — chirp-only diagnostic

DSP state: Mode A matrix for any i (i = 1 is the natural choice:
Out_1 mask 3, others 0; baseline PEQs as in Mode A step 1, or
snapshot PEQs — either is fine, since nothing is being modelled,
but record which). Signal: chirp-only buffer (right channel chirp,
left silence, or the full section-2 buffer — the detector does not
care, the sweep just is not scored). Output: anchor, correlation
peak, both validation margins, implied acoustic latency. No IR, no
score, no DSP state change that outlives the check (revert after).

## 6. The surrogate: predicting a candidate from H_1..H_4

For a candidate C (which `validCandidate` has already checked:
channel gain in [base − 3 dB, min(base, 0 dB)], channel delay in
[base, base + 1.46 ms], every band gain in [−12, 0] dB):

```
predicted_combined(f) = Σ_i  H_i(f)
                              × PEQ_i(f)          # candidate PEQ cascade, absolute
                              × 10^((gain_i − base_gain_i)/20)
                              × exp(−j·2π·f·(delay_i − base_delay_i))
```

- **H_i(f)** is the Mode A complex spectrum at the flat baseline.
  Because the baseline PEQs are unity, the candidate PEQ cascade
  applies **absolutely** — no division by a snapshot PEQ response,
  which is exactly why the baseline is flat rather than "as loaded".
  (Dividing by a snapshot cascade with deep cuts would amplify
  measurement noise at the cut frequencies.)
- **PEQ_i(f)** is the candidate's 7-band cascade evaluated in the
  frequency domain from the RBJ coefficients (`rbjPeak` in
  `src/measure/sweep.ts` returns [b0, b1, b2, a0, a1, a2]; evaluate
  (b0 + b1·z⁻¹ + b2·z⁻²)/(a0 + a1·z⁻¹ + a2·z⁻²) at z = e^{j2πf/sr}
  per bin, cascaded across bands). Use **snapped** values throughout
  — freq, Q, gain, delay, and channel gain each round-tripped through
  their `protocol.ts` forward/back scales (`hzToFreqIndex` /
  `freqIndexToHz`, `qToRaw` / `rawToQ`, `peqGainDbToRaw` /
  `peqGainRawToDb`, `msToDelaySamples` / `delaySamplesToMs`) — so the
  model predicts what the hardware will actually do, not what the
  candidate ideally asks for. `candidateMismatches` already encodes
  this snapping for verification; the surrogate must use the same
  snapped values for prediction.
- **Gain and delay enter as deltas from the snapshot bases**, because
  H_i was measured at snapshot gains/delays. A candidate equal to the
  snapshot (gains/delays at base, PEQs flat) must predict exactly the
  flat-baseline combined response — and, with snapshot PEQs applied
  instead of flat ones, it must predict the measured combined
  baseline. **Check that**: predict the snapshot candidate on the
  surrogate and compare against the Mode B baseline measurement
  (the GO iteration-0 sweep). A large mismatch means the
  measurement set is bad (routing, mic moved, chirp mis-detected) —
  fail loudly, do not screen candidates on a broken model.
- **Scoring is shared, not duplicated.** Take
  |predicted_combined(f)| in dB, then run the identical path as
  Mode B: `interpLog` to the 480-point log grid, `smoothOctave`
  1/12, `scoreResponse` with the same fStart/fLowcut/fEnd and the
  same baseline mean (the measured combined baseline's mean, so
  predicted J is comparable to measured J). Any second scoring
  implementation will drift from the first; there must be one.
- **Coherent sum, not magnitude sum.** Sum complex spectra, then
  take magnitude. Summing magnitudes would model four subs that can
  never cancel — the opposite of the room being optimized. This is
  the entire reason the anchor exists.

## 7. The optimizer iteration, with individual measurements

Session flow (extends the V2 loop in `loop-notes.md`; the legacy
combined loop in `loop.ts` is the fallback, not the target):

1. **GO**: `takeSnapshot()`, read state, record types (never
   changed) and bases (snapshot gains/delays). Measure the combined
   baseline with Mode B (this is today's iteration 0).
2. **Measurement set**: 4 × Mode A, back to back, mic untouched,
   sweep level matched to operating level (sub response is
   level-dependent through port compression and amp limits). Then
   `revert()` + verify.
3. **Consistency check**: predict the snapshot candidate on the
   surrogate; compare to the Mode B baseline. Fail loudly on large
   mismatch (section 6).
4. **Screen on the surrogate** (free): generate candidates with the
   existing operators (`mutateCandidate`) plus the V2 operators
   (Pareto-frontier judgement, basin-hopping, low-dimensional big
   jumps, informed jumps — PEQ centres onto measured peaks, coarse
   delay grids, time-alignment seeds from IR arrival peaks, gain
   rebalancing at roughly constant total, log-space freq/Q,
   crossover from frontier solutions, adaptive operator weighting).
   Every generated candidate must pass `validCandidate` before it is
   scored — the bounds are not a post-filter.
5. **Measure the most promising few with Mode B** (real sweeps, one
   per candidate, candidate pushed by `pushCandidate` exactly as
   today). Keep only ones that actually measure good; the measured
   best is never replaced by a simulated one. Judge big jumps
   against the Pareto frontier, not just scalar J — a mutation
   trading flatness for SPL extends the frontier even when it fails
   on J.
6. **Commit or discard**, then either refine locally (short
   measurement-driven hill-climb on the real rig, as today) or
   return to screening. The surrogate only changes which candidates
   get measured; the measured-not-predicted rule stands.
7. **Re-measure the set when**: the mic moves; the sweep level
   changes; any non-candidate DSP parameter changes (crossover,
   polarity, input gain); or predicted-vs-measured scores diverge
   systematically (starting point, tune from data: predicted flatness
   off by more than ~1 dB on two consecutive verifications). Do not
   re-measure on a timer — re-measure on a cause. A stale set looks
   exactly like a good set until it mis-ranks candidates.

### What never happens

- Never mix anchored (Mode A) and peak-search (Mode B) IRs in one
  surrogate set. Different time origins, meaningless sum.
- Never change DSP state inside a capture. Matrix changes happen
  between captures; the config is frozen from chirp through sweep.
- Never push candidate PEQs to the DSP during screening. Screening
  is arithmetic on H_i; the DSP only moves for real measurements.
- Never use the sub under test as its own reference — and never
  confuse that rule with the i = 1 case, where sub 1 plays both
  signals but the anchor still comes from the chirp alone
  (section 0).
- Never let a Mode B sweep run under a Mode A matrix. The cleanup
  `revert()` after every measurement set is not optional.
- Never silently degrade: chirp detection failure, surrogate/baseline
  mismatch, or a failed DSP verify all throw. A quiet wrong answer
  costs more than a loud failed run, because the optimizer will
  happily climb a broken model.

## 8. Implementation checklist (for the coding agent)

New functions:

- `genChirp()` — ESS 500 Hz → 3 kHz, 100 ms, same fade code as
  `genESS`, peak 0.25. Template and played signal must be the same
  samples; generate once, use for both.
- `writeWavStereo()` — interleaved L/R 16-bit 48 kHz WAV. (Keep
  `writeWav` mono for the legacy path; do not change its behavior.)
- `playStereoWav()` — prefers direct ALSA at 48 kHz (section 2);
  falls back only with a warning the template match may degrade.
- `detectChirp(rec, chirp)` — FFT-based matched filter via
  `linearConvolve`, index mapping `s = argmax − (len − 1)`, parabolic
  interpolation, 2 s search window, both validation margins,
  throws on failure. Returns the anchor A.
- `deconvolveToComplexIR(rec, sweep, inv, onsetSamples)` — today's
  `deconvolveToFR` geometry with a caller-supplied onset and a
  complex-spectrum return. Share the windowing code with
  `deconvolveToFR`; do not fork it.
- `measureSingleOutput(dev, i, config)` — Mode A end to end:
  baseline writes, matrix write + refresh verify, settle, stereo
  capture (capture-first), detection, complex IR, recording +
  metadata. Runs inside `dev.exclusive()`.
- `measureOutputSet(dev, config)` — 4 × Mode A + `revert()` +
  verify, returning H_1..H_4 on the shared grid.
- `predictCombined(H, candidate, bases)` — section 6 math with
  snapped values, returning complex combined response; scoring
  reuses `interpLog` / `smoothOctave` / `scoreResponse` unchanged.
- `verifyRouting(dev, masks)` — refresh-based matrix check, the
  routing analogue of `candidateMismatches`.

Changed, not added:

- Nothing in the legacy `LoopRunner.measure()` path changes, except
  that it must refuse to run while a measurement matrix is active
  (assert snapshot routing by `refresh()` before the first sweep —
  cheap insurance against the section 5 footgun).
- `LoopRunner` gains the section 7 session flow alongside (not
  instead of) the current loop, so the combined-only loop keeps
  working while the chirp path matures.

Open tuning values (starting points in this doc, to be calibrated
from data, not treated as measured facts): detection margins
(ratio ≥ 1.25 tuned 2026-10-30, peak ≥ 20 dB above pre-roll RMS), re-measurement
divergence threshold (~1 dB flatness on two consecutive
verifications), chirp length/band/gap (100 ms, 500 Hz–3 kHz,
100 ms). If data says otherwise, change the doc, not just the code.
