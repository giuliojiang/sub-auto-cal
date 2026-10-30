# Optimization loop — basic version (laptop path)

Runs without speakers on the DSP: the EQ under test is applied to the
stimulus itself (RBJ peaking pre-filter at 48 kHz), played through the
laptop speakers and measured with the laptop mic. Measurement,
scoring, and search are all real; only the actuator differs from the
final rig (DSP PEQ writes replace stimulus pre-filtering once outputs
are wired, with 1/30-octave snapping at that point).

What this implements from the brief: ESS sweep with fades, inverse
filter with numerical normalization, linear (zero-padded FFT)
deconvolution, IR windowing, FFT to FR, 1/12-octave power smoothing as
the score input, J = 2·F + S_loss where F is the RMS
deviation from a shaped target (flat from lowcut to end, falling
12 dB per octave from lowcut down to start, so weak low end reads
as on-target instead of forcing cuts elsewhere), greedy
measurement-driven hill-climb (alternating small tweaks and
peak-guided large mutations, which place cuts at the residual
peaks of the current best response), Pareto log, STOP button, timeline with measured
F / mean / loss / J.

Starting state is the DSP's live state: GO snapshots the device,
reads all four outputs, and uses their current 7 PEQ bands, gains,
and delays as iteration 0. The optimizer tweaks all 28 bands
(freq, Q, gain each), each channel gain within −3 dB below its
starting value (never above 0 dB), and each channel delay up to
+1.46 ms above its starting value. Band types are kept as loaded,
never changed. Writes go to the connected unit (DSP or simulator);
a run refuses to start with nothing connected. Per-band bypass
cannot be read back, so every pushed band is written un-bypassed.

Simplifications vs the full product: no mic calibration file in
this path (results uncalibrated unless one is loaded), no drift
correction (same-machine playback/capture, onset found by peak
search), no direction memory beyond revert-to-best, recordings kept
per iteration under recordings/. When the run ends the
best-scoring candidate is written back to the DSP automatically;
any row can still be applied manually afterwards.

## Large Mutation Strategy V2

Designed 2026-10-30, after real-rig sweeps showed blind large
mutations barely ever paying off: a random change to the candidate
has a very small chance of beating the previous best, and each
attempt costs a full real sweep. V2 changes the cost structure
instead of the mutation distribution: mutations are generated and
screened for free on a model built from real measurements, and
only the most promising few are ever measured. The existing
peak-guided large mutations (cuts at the residual peaks of the
current best) survive inside V2 as one informed operator; what V2
replaces is the blind random jump.

### Why blind large mutations fail

- Dimensionality: the loop tweaks 28 bands (freq, Q, gain each)
  plus 4 channel gains and 4 delays. A random jump in that many
  dimensions almost never lands in the improving cone.
- Coherent summation: the combined response is the coherent sum of
  four subs in different room positions, so the landscape is
  comb-filter multimodal with narrow good regions. One output's
  delay shift flips whole bands between constructive and
  destructive.
- Cuts only: per-channel SPL can only go down. Combined SPL only
  goes up through better phase alignment, so a random mutation
  that improves flatness almost always costs SPL, and on a scalar
  score it fails to beat the best. "Beat the best" is a knife-edge
  criterion for a two-objective (flatness vs SPL) problem.

### Precondition: time-aligned per-output measurements

The model needs each output's transfer function on a common time
grid, which means delay-calibrated measurements in the REW sense:
a timing reference anchors t=0 for every sweep. This is required
because playback and capture are separate USB devices with
independent clocks and OS scheduling, so the delay between sweep
start and capture start jitters from sweep to sweep. 1 ms of
unknown offset is 36° at 100 Hz and 72° at 200 Hz — it destroys
exactly the inter-output phase relationships the optimizer acts
on. The basic version's peak-search onset alignment works on the
same-machine laptop path; it does not transfer to the real rig.

The reference must be a fixed source across all measurements, not
the output under test: a reference played through the output under
test would subtract out the inter-output delay differences being
modelled. Sub 1 is the reference for every measurement, including
its own (its relative delay then defines the grid origin, which is
fine — only relative delays matter).

This rig can use a sub as the reference source: the subs are dual
6.5" drivers per cabinet with significantly usable high-frequency
output, and there is no low-pass anywhere in the signal path. The
reference chirp sits above the measurement band (e.g. 500 Hz–
3 kHz) so its room tail does not contaminate the sub-band IR, and
is detected by matched filtering with sub-sample peak
interpolation. A constant anchor error cancels across
measurements; only detection jitter matters. Captures are kept
short to bound clock drift between the separate USB devices.

### Routing: two inputs, frozen within a capture

The chirp and the sweep must reach different destinations in the
same capture, so two input channels are structurally required:

- Input 1 (left), the main signal: drives one output at a time.
  For output i's measurement, the DSP mixer matrix is updated so
  input 1 feeds only output i. This is a matrix change between
  measurements, not within a capture.
- Input 2 (right), the chirp signal: wired to sub 1 only, fixed
  for the whole session.

DSP configuration is frozen between chirp and sweep inside each
capture, and all processing is frozen across the whole per-output
set: the four IRs are measured at a known flat baseline state,
and candidate PEQ/delay/gain are applied mathematically in the
model during screening, not in the DSP. A fixed processing
difference between the chirp and sweep paths cancels out; a
varying one does not.

Practical invariants for the measurement set: microphone position
fixed across all per-output measurements and verification sweeps;
sweep level matched to the operating level (sub response is
level-dependent through port compression and amp limits).

### The surrogate model

With time-aligned per-output IRs, the combined response for any
candidate is the coherent sum of the four complex spectra, with
each output's candidate PEQ (biquad magnitude/phase), delay
(linear phase) and gain (scalar) applied in the frequency domain.
All existing bounds (cuts only, gain and delay limits) apply to
every generated candidate. The model proposes; the real sweep
still arbitrates every committed step, so the measured-not-
predicted rule stands — the surrogate only changes which
candidates get measured.

### The V2 loop

1. Generate a large number of random variations on the surrogate
   (brute force; simulation is free).
2. Take the most promising few as large mutations.
3. Measure each with a real sweep.
4. Keep only the ones that actually measure good; discard the
   rest. The measured best is never replaced by a simulated one.

Supporting tactics, in order of value:

- Judge big jumps against the Pareto frontier, not the scalar
  best: a mutation trading flatness for SPL extends the frontier
  even when it fails on J.
- Basin-hop: a big jump followed by a short local refinement is
  judged as a basin, not as a landing point.
- Keep large mutations low-dimensional: big in magnitude, small
  in scope — one output, or one parameter family (all delays, all
  gains) at a time.
- Informed jumps: PEQ centres onto the largest remaining measured
  peaks; coarse delay grids (0/10/20/30/40/50 cm per output is
  6^4 combinations, trivial on the surrogate) to find alignment
  regimes random search never hits; time-alignment seeds from
  measured IR arrival peaks; gain rebalancing between outputs at
  roughly constant total.
- Randomize frequency and Q in log space, delay in cm, gain in
  dB; uniform-linear frequency biases toward the top of the band.
- Crossover from the frontier: delays from one frontier solution,
  PEQs from another, per-output blocks.
- Adaptive operator selection: track improvement per real sweep
  per operator and down-weight the ones that never pay.

This automates the workflow people currently do by hand with
multi-sub-optimizer style tools (measure in one app, export,
optimize, export filters, import back into the DSP, re-measure),
with no manual step anywhere in the loop.
