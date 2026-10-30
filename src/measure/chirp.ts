import { genESS, linearConvolve, MEASURE_RATE } from "./sweep.ts";

export const CHIRP_F1 = 500;
export const CHIRP_F2 = 3000;
export const CHIRP_SECS = 0.1;
export const CHIRP_GAP_SECS = 0.1;
export const DETECT_MARGIN_RATIO = 1.25;
export const DETECT_MARGIN_DB = 20;

export function genChirp(): Float32Array {
  return genESS(CHIRP_F1, CHIRP_F2, CHIRP_SECS);
}

export interface ChirpAnchor {
  lag: number;
  frac: number;
  anchor: number;
  peak: number;
  marginRatio: number;
  marginDb: number;
  secondDelay: number;
}

export function detectChirp(rec: Float32Array, template: Float32Array, sr = MEASURE_RATE): ChirpAnchor {
  const rev = Float32Array.from(template);
  rev.reverse();
  const y = linearConvolve(rec, rev);
  const m = template.length - 1;
  const winEnd = Math.min(y.length, Math.floor(2 * sr) + template.length);
  let bi = 0;
  let best = -Infinity;
  for (let i = 0; i < winEnd; i++) {
    const v = y[i] as number;
    if (v > best) {
      best = v;
      bi = i;
    }
  }
  if (!(best > 0)) throw new Error("chirp not detected: no positive correlation peak in first 2 s");
  let second = 0;
  let secondDelay = 0;
  for (let i = 0; i < winEnd; i++) {
    if (Math.abs(i - bi) <= 240) continue;
    const v = Math.abs(y[i] as number);
    if (v > second) {
      second = v;
      secondDelay = i - bi;
    }
  }
  const marginRatio = best / Math.max(1e-18, second);
  const pn = Math.min(rec.length, Math.floor(0.05 * sr));
  let pre = 0;
  for (let i = 0; i < pn; i++) pre += (rec[i] as number) * (rec[i] as number);
  const rms = Math.sqrt(pre / Math.max(1, pn));
  const marginDb = 20 * Math.log10(best / Math.max(1e-12, rms));
  if (marginRatio < DETECT_MARGIN_RATIO) throw new Error(`chirp not detected: peak ratio ${marginRatio.toFixed(2)} below ${DETECT_MARGIN_RATIO} (peak ${marginDb.toFixed(1)} dB above pre-roll)`);
  if (marginDb < DETECT_MARGIN_DB) throw new Error(`chirp not detected: peak ${marginDb.toFixed(1)} dB above pre-roll, need ${DETECT_MARGIN_DB} (ratio ${marginRatio.toFixed(2)})`);
  const y0 = y[Math.max(0, bi - 1)] as number;
  const y1 = best;
  const y2 = y[Math.min(y.length - 1, bi + 1)] as number;
  const denom = y0 - 2 * y1 + y2;
  const frac = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const lag = bi - m;
  return { lag, frac, anchor: lag + frac, peak: best, marginRatio, marginDb, secondDelay };
}
