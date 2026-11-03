import {
  FIT_FMAX,
  FIT_FMIN,
  gridConfig,
  type GridConfig,
  type YamahaBand,
} from "./yamaha.ts";
import {
  FREQ_IDX_MAX,
  freqIndexToHz,
  hzToFreqIndex,
  peqGainDbToRaw,
  peqGainRawToDb,
  qToRaw,
  rawToQ,
} from "../dsp/protocol.ts";

export const AMP_Q_RAW_MIN = 4;
export const AMP_Q_RAW_MAX = 56;
export const AMP_GAIN_MIN_DB = -12;
export const AMP_GAIN_MAX_DB = 3;
export const AMP_GAIN_STEP_DB = 0.5;
export const AMP_MAX_BANDS = 7;
export const AMP_MAX_BOOST_DB = 3;
export const AMP_OUTPUT_CHANS = [4, 5, 6, 7];

export function ampFreqs(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= FREQ_IDX_MAX; i++) {
    const hz = freqIndexToHz(i);
    if (hz >= FIT_FMIN - 1e-9 && hz <= FIT_FMAX + 1e-9) out.push(hz);
  }
  return out;
}

export function ampQs(): number[] {
  const out: number[] = [];
  for (let r = AMP_Q_RAW_MIN; r <= AMP_Q_RAW_MAX; r++) out.push(rawToQ(r));
  return out;
}

export const AMP_GRID: GridConfig = {
  ...gridConfig(
    ampFreqs(),
    ampQs(),
    AMP_GAIN_MIN_DB,
    AMP_GAIN_MAX_DB,
    AMP_GAIN_STEP_DB,
    AMP_MAX_BANDS,
    AMP_MAX_BANDS,
    400,
    AMP_MAX_BOOST_DB,
  ),
  coarseFreqStep: 4,
  coarseQStep: 4,
  coarseGainStepDb: 1,
  refineFreqRadius: 6,
  refineQRadius: 6,
  refineGainRadiusDb: 1,
};

export function snapAmpBand(b: YamahaBand): YamahaBand {
  return {
    frequencyHz: freqIndexToHz(hzToFreqIndex(b.frequencyHz)),
    q: rawToQ(qToRaw(b.q)),
    gainDb: peqGainRawToDb(peqGainDbToRaw(b.gainDb)),
  };
}

export function isAmpGridBand(b: YamahaBand): boolean {
  const s = snapAmpBand(b);
  return (
    Math.abs(s.frequencyHz - b.frequencyHz) < 1e-9 &&
    Math.abs(s.q - b.q) < 1e-9 &&
    Math.abs(s.gainDb - b.gainDb) < 1e-9 &&
    b.gainDb >= AMP_GAIN_MIN_DB - 1e-9 &&
    b.gainDb <= AMP_GAIN_MAX_DB + 1e-9 &&
    b.q >= rawToQ(AMP_Q_RAW_MIN) - 1e-9 &&
    b.q <= rawToQ(AMP_Q_RAW_MAX) + 1e-9
  );
}
