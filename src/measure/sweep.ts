import { fft, ifft, nextPow2 } from "./fft.ts";

export const MEASURE_RATE = 48000;

export function genESS(f1: number, f2: number, seconds: number, sr = MEASURE_RATE): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const k = (2 * Math.PI * f1 * seconds) / Math.log(f2 / f1);
  const L = Math.log(f2 / f1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(k * (Math.exp((t / seconds) * L) - 1)) * 0.25;
  }
  const fadeIn = Math.min(n >> 2, Math.floor(sr * 0.1));
  const fadeOut = Math.min(n >> 3, Math.floor(sr * 0.02));
  for (let i = 0; i < fadeIn; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    out[i]! *= g;
  }
  for (let i = 0; i < fadeOut; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut);
    out[n - 1 - i]! *= g;
  }
  return out;
}

export function inverseESS(sweep: Float32Array, f1: number, f2: number, seconds: number): Float32Array {
  const n = sweep.length;
  const out = new Float32Array(n);
  const L = Math.log(f2 / f1);
  for (let i = 0; i < n; i++) {
    const t = i / MEASURE_RATE;
    out[i] = (sweep[n - 1 - i] as number) * Math.exp((-t / seconds) * L);
  }
  const conv = linearConvolve(sweep, out);
  let peak = 0;
  for (let i = 0; i < conv.length; i++) peak = Math.max(peak, Math.abs(conv[i] as number));
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! /= peak;
  return out;
}

export function linearConvolve(a: Float32Array, b: Float32Array): Float32Array {
  const n = nextPow2(a.length + b.length - 1);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = (ar[i] as number) * (br[i] as number) - (ai[i] as number) * (bi[i] as number);
    const im = (ar[i] as number) * (bi[i] as number) + (ai[i] as number) * (br[i] as number);
    ar[i] = r;
    ai[i] = im;
  }
  ifft(ar, ai);
  return Float32Array.from(ar.slice(0, a.length + b.length - 1));
}

export interface FilterBand {
  freqHz: number;
  q: number;
  gainDb: number;
}

export function rbjPeak(f0: number, q: number, gainDb: number, sr = MEASURE_RATE): number[] {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * Math.max(0.05, q));
  return [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
}

export function applyBiquads(samples: Float32Array, bands: FilterBand[], gainDb: number): Float32Array {
  const out = Float32Array.from(samples);
  const g = Math.pow(10, gainDb / 20);
  for (let i = 0; i < out.length; i++) out[i]! *= g;
  for (const b of bands) {
    const [b0, b1, b2, a0, a1, a2] = rbjPeak(b.freqHz, b.q, b.gainDb);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i] as number;
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
  }
  return out;
}

export interface FR {
  freqs: Float32Array;
  db: Float32Array;
}

export function deconvolveToFR(rec: Float32Array, sweep: Float32Array, inv: Float32Array, sr = MEASURE_RATE): FR {
  const conv = linearConvolve(rec, inv);
  const expected = sweep.length - 1;
  let onset = expected;
  let best = -1;
  const span = Math.min(sr, conv.length - expected - 1);
  for (let i = Math.max(0, expected - sr); i < expected + span; i++) {
    const v = Math.abs(conv[i] as number);
    if (v > best) {
      best = v;
      onset = i;
    }
  }
  const pre = Math.floor(sr * 0.002);
  const start = Math.max(0, onset - pre);
  const ir = conv.slice(start);
  for (let i = 0; i < pre && i < ir.length; i++) {
    ir[i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / Math.max(1, pre));
  }
  const fo = Math.max(64, Math.floor(ir.length / 10));
  for (let i = 0; i < fo; i++) {
    ir[ir.length - 1 - i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  }
  const n = nextPow2(ir.length * 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(ir);
  fft(re, im);
  const half = n / 2;
  const freqs = new Float32Array(half);
  const db = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    freqs[i] = (i * sr) / n;
    const m = Math.hypot(re[i] as number, im[i] as number) / ir.length;
    db[i] = 20 * Math.log10(Math.max(1e-12, m));
  }
  return { freqs, db };
}

export function logGrid(fmin: number, fmax: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fmin * Math.pow(fmax / fmin, i / (n - 1));
  return out;
}

export function interpLog(fr: FR, grid: Float32Array): Float32Array {
  const out = new Float32Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    while (j < fr.freqs.length - 2 && (fr.freqs[j + 1] as number) < f) j++;
    const f0 = fr.freqs[j] as number;
    const f1 = fr.freqs[j + 1] as number;
    const t = f1 > f0 ? Math.max(0, Math.min(1, (Math.log(f) - Math.log(Math.max(1e-9, f0))) / Math.log(f1 / Math.max(1e-9, f0)))) : 0;
    out[i] = ((fr.db[j] as number) * (1 - t) + (fr.db[j + 1] as number) * t);
  }
  return out;
}

export function smoothOctave(grid: Float32Array, db: Float32Array, widthOct: number): Float32Array {
  const out = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) {
    const f0 = grid[i] as number;
    const lo = f0 * Math.pow(2, -widthOct / 2);
    const hi = f0 * Math.pow(2, widthOct / 2);
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < db.length; j++) {
      const f = grid[j] as number;
      if (f >= lo && f <= hi) {
        sum += Math.pow(10, (db[j] as number) / 10);
        cnt++;
      }
    }
    out[i] = 10 * Math.log10(Math.max(1e-12, sum / Math.max(1, cnt)));
  }
  return out;
}

export function alignOnset(rec: Float32Array, sweep: Float32Array, sr = MEASURE_RATE): number {
  const dec = 16;
  const rl = Math.floor(rec.length / dec);
  const sl = Math.floor(sweep.length / dec);
  let bestLag = 0;
  let bestVal = -Infinity;
  const maxLag = Math.min(rl - sl, sr * 2);
  for (let lag = 0; lag < maxLag; lag += dec) {
    let s = 0;
    for (let i = 0; i < sl; i += 4) s += (rec[(lag + i) * dec] as number) * (sweep[i * dec] as number);
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }
  return bestLag * dec;
}
