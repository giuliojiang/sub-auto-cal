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
the score input, J = F + S_loss with λ = 1, up to 2 peaking cuts
(−12…0 dB, ≥1/6 octave apart), channel gain −3…0 dB, greedy
measurement-driven hill-climb (≈75% small tweaks, 25% large
mutations), Pareto log, STOP button, timeline with measured
F / mean / loss / J.

Simplifications vs the full product (to be lifted with real outputs):
single channel only, no delay control (meaningless single-channel),
no mic calibration file (results uncalibrated), no drift correction
(same-machine playback/capture, onset found by peak search),
no direction memory beyond revert-to-best, recordings kept per
iteration under recordings/.
