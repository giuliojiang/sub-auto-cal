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
measurement-driven hill-climb (≈75% small tweaks, 25% large
mutations), Pareto log, STOP button, timeline with measured
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
per iteration under recordings/.
