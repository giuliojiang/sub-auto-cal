import { rbjPeak, logGrid } from "./sweep.ts";

export const YAMAHA_FREQS = [
  15.6, 19.7, 24.8, 31.3, 39.4, 49.6, 62.5, 78.7, 99.2, 125, 157.5,
  198.4, 250, 315, 396.9, 500, 630, 793.7, 1000, 1260, 1590, 2000,
  2520, 3170, 4000, 5040, 6350, 8000, 10100, 12700, 16000,
];

export const YAMAHA_QS = [
  0.5, 0.63, 0.794, 1.0, 1.26, 1.587, 2.0, 2.52, 3.175, 4.0, 5.04,
  6.35, 8.0, 10.08,
];

export const YAMAHA_GAIN_MIN = -20;
export const YAMAHA_GAIN_MAX = 6;
export const YAMAHA_GAIN_STEP = 0.5;
export const FIT_FMIN = 20;
export const FIT_FMAX = 16000;
export const MAX_BANDS = 7;
export const MAX_LOW_BANDS = 4;
export const MAX_BOOST_DB = 3;
export const OUTPUT_N = 240;

export const STRATEGIES = [
  "greedy",
  "greedy-cuts",
  "greedy-minimal",
  "greedy-broad",
  "random-best",
  "greedy-refined",
] as const;

export type YamahaStrategy = (typeof STRATEGIES)[number];

export interface YamahaBand {
  frequencyHz: number;
  q: number;
  gainDb: number;
}

export interface YamahaCandidate {
  strategy: string;
  strategies: string[];
  bands: YamahaBand[];
  rms: number;
  maxAbs: number;
  maxBoost: number;
  grid: number[];
  predicted: number[];
}

export function gainGrid(): number[] {
  const out: number[] = [];
  for (let g = YAMAHA_GAIN_MIN; g <= YAMAHA_GAIN_MAX + 1e-9; g += YAMAHA_GAIN_STEP) {
    out.push(Math.round(g * 2) / 2);
  }
  return out;
}

export function yamahaTarget(f: number): number {
  if (f >= 1000) return -2 * Math.log2(f / 1000);
  if (f >= 80) return Math.log2(1000 / f);
  return Math.log2(1000 / 80) - 12 * Math.log2(80 / f);
}

export function targetShape(grid: Float32Array | number[]): Float32Array {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = yamahaTarget(grid[i] as number);
  return out;
}

export function fitMask(grid: Float32Array | number[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    if (f >= FIT_FMIN && f <= FIT_FMAX) idx.push(i);
  }
  return idx;
}

export function zeroMeanOverFit(grid: Float32Array | number[], db: Float32Array | number[]): Float32Array {
  const mask = fitMask(grid);
  let sum = 0;
  for (const i of mask) sum += db[i] as number;
  const mean = mask.length ? sum / mask.length : 0;
  const out = Float32Array.from(db as ArrayLike<number>);
  for (let i = 0; i < out.length; i++) out[i]! -= mean;
  return out;
}

export function anchorTarget(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
): { anchored: Float32Array; offset: number } {
  const shape = targetShape(grid);
  const mask = fitMask(grid);
  let sum = 0;
  for (const i of mask) sum += (measuredDb[i] as number) - (shape[i] as number);
  const offset = mask.length ? sum / mask.length : 0;
  const anchored = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) anchored[i] = (shape[i] as number) + offset;
  return { anchored, offset };
}

export function bandMagnitudeDb(band: YamahaBand, freqHz: number, sr = 48000): number {
  const [b0, b1, b2, a0, a1, a2] = rbjPeak(band.frequencyHz, band.q, band.gainDb, sr);
  const w = (2 * Math.PI * freqHz) / sr;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const nRe = b0 + b1 * cw + b2 * c2w;
  const nIm = -(b1 * sw + b2 * s2w);
  const dRe = a0 + a1 * cw + a2 * c2w;
  const dIm = -(a1 * sw + a2 * s2w);
  const mag = Math.sqrt((nRe * nRe + nIm * nIm) / Math.max(1e-24, dRe * dRe + dIm * dIm));
  return 20 * Math.log10(Math.max(1e-12, mag));
}

export function combinedCorrectionDb(bands: YamahaBand[], freqHz: number, sr = 48000): number {
  let s = 0;
  for (const b of bands) s += bandMagnitudeDb(b, freqHz, sr);
  return s;
}

export function correctionCurve(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): Float32Array {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    out[i] = combinedCorrectionDb(bands, grid[i] as number, sr);
  }
  return out;
}

export function predictCurve(
  measuredDb: Float32Array | number[],
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): Float32Array {
  const corr = correctionCurve(bands, grid, sr);
  const out = new Float32Array(measuredDb.length);
  for (let i = 0; i < out.length; i++) out[i] = (measuredDb[i] as number) + (corr[i] as number);
  return out;
}

export interface YamahaScore {
  rms: number;
  maxAbs: number;
  maxBoost: number;
}

export function scorePrediction(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  bands: YamahaBand[],
  sr = 48000,
): YamahaScore {
  const mask = fitMask(grid);
  const corr = correctionCurve(bands, grid, sr);
  let sq = 0;
  let maxAbs = 0;
  let maxBoost = -Infinity;
  for (const i of mask) {
    const pred = (measuredDb[i] as number) + (corr[i] as number);
    const r = pred - (anchored[i] as number);
    sq += r * r;
    const a = Math.abs(r);
    if (a > maxAbs) maxAbs = a;
    if ((corr[i] as number) > maxBoost) maxBoost = corr[i] as number;
  }
  const rms = mask.length ? Math.sqrt(sq / mask.length) : 0;
  if (maxBoost === -Infinity) maxBoost = 0;
  return { rms, maxAbs, maxBoost };
}

export function uncorrectedScore(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
): YamahaScore {
  return scorePrediction(grid, measuredDb, anchored, [], 48000);
}

export function isYamahaFreq(f: number): boolean {
  return YAMAHA_FREQS.some((v) => Math.abs(v - f) < 1e-9);
}

export function isYamahaQ(q: number): boolean {
  return YAMAHA_QS.some((v) => Math.abs(v - q) < 1e-9);
}

export function isGainStep(g: number): boolean {
  if (g < YAMAHA_GAIN_MIN - 1e-9 || g > YAMAHA_GAIN_MAX + 1e-9) return false;
  return Math.abs(g * 2 - Math.round(g * 2)) < 1e-9;
}

export function lowBandCount(bands: YamahaBand[]): number {
  return bands.filter((b) => b.frequencyHz <= 400).length;
}

export function validYamahaBands(bands: YamahaBand[]): boolean {
  if (bands.length > MAX_BANDS) return false;
  if (lowBandCount(bands) > MAX_LOW_BANDS) return false;
  for (const b of bands) {
    if (!isYamahaFreq(b.frequencyHz)) return false;
    if (!isYamahaQ(b.q)) return false;
    if (!isGainStep(b.gainDb)) return false;
  }
  return true;
}

export function maxCombinedBoost(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): number {
  const mask = fitMask(grid);
  let m = -Infinity;
  for (const i of mask) {
    const c = combinedCorrectionDb(bands, grid[i] as number, sr);
    if (c > m) m = c;
  }
  return m === -Infinity ? 0 : m;
}

export function fullyValidYamahaBands(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): boolean {
  if (!validYamahaBands(bands)) return false;
  return maxCombinedBoost(bands, grid, sr) <= MAX_BOOST_DB + 1e-6;
}

export function sortBands(bands: YamahaBand[]): YamahaBand[] {
  return [...bands].sort((a, b) => a.frequencyHz - b.frequencyHz);
}

export function bandKey(bands: YamahaBand[]): string {
  return sortBands(bands)
    .map((b) => `${b.frequencyHz}|${b.q}|${b.gainDb}`)
    .join(";");
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BandCache {
  gains: number[];
  vecs: Map<string, Float32Array>;
}

function buildBandCache(grid: Float32Array | number[], sr: number): BandCache {
  const gains = gainGrid();
  const vecs = new Map<string, Float32Array>();
  const n = grid.length;
  for (let fi = 0; fi < YAMAHA_FREQS.length; fi++) {
    for (let qi = 0; qi < YAMAHA_QS.length; qi++) {
      for (let gi = 0; gi < gains.length; gi++) {
        const band: YamahaBand = {
          frequencyHz: YAMAHA_FREQS[fi] as number,
          q: YAMAHA_QS[qi] as number,
          gainDb: gains[gi] as number,
        };
        const [b0, b1, b2, a0, a1, a2] = rbjPeak(band.frequencyHz, band.q, band.gainDb, sr);
        const v = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const w = ((2 * Math.PI * (grid[i] as number)) / sr);
          const cw = Math.cos(w);
          const c2w = Math.cos(2 * w);
          const sw = Math.sin(w);
          const s2w = Math.sin(2 * w);
          const nRe = b0 + b1 * cw + b2 * c2w;
          const nIm = -(b1 * sw + b2 * s2w);
          const dRe = a0 + a1 * cw + a2 * c2w;
          const dIm = -(a1 * sw + a2 * s2w);
          const mag = Math.sqrt((nRe * nRe + nIm * nIm) / Math.max(1e-24, dRe * dRe + dIm * dIm));
          v[i] = 20 * Math.log10(Math.max(1e-12, mag));
        }
        vecs.set(`${fi}:${qi}:${gi}`, v);
      }
    }
  }
  return { gains, vecs };
}

interface GreedyOpts {
  gainMin?: number;
  gainMax?: number;
  qMax?: number;
  rmsStop?: number;
  sr?: number;
}

function allowedCombos(opts: GreedyOpts, gains: number[]): { fi: number; qi: number; gi: number }[] {
  const gmin = opts.gainMin ?? YAMAHA_GAIN_MIN;
  const gmax = opts.gainMax ?? YAMAHA_GAIN_MAX;
  const qmax = opts.qMax ?? Infinity;
  const out: { fi: number; qi: number; gi: number }[] = [];
  for (let fi = 0; fi < YAMAHA_FREQS.length; fi++) {
    for (let qi = 0; qi < YAMAHA_QS.length; qi++) {
      if ((YAMAHA_QS[qi] as number) > qmax + 1e-12) continue;
      for (let gi = 0; gi < gains.length; gi++) {
        const g = gains[gi] as number;
        if (g < gmin - 1e-9 || g > gmax + 1e-9) continue;
        out.push({ fi, qi, gi });
      }
    }
  }
  return out;
}

export function greedyFit(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  opts: GreedyOpts = {},
): YamahaBand[] {
  const sr = opts.sr ?? 48000;
  const { gains, vecs } = buildBandCache(grid, sr);
  const combos = allowedCombos(opts, gains);
  const mask = fitMask(grid);
  const n = grid.length;
  const meas = Float32Array.from(measuredDb as ArrayLike<number>);
  const anch = Float32Array.from(anchored as ArrayLike<number>);
  const cur = new Float32Array(n);
  const bands: YamahaBand[] = [];
  const rmsOf = (base: Float32Array): number => {
    let sq = 0;
    for (const i of mask) {
      const r = (meas[i] as number) + (base[i] as number) - (anch[i] as number);
      sq += r * r;
    }
    return mask.length ? Math.sqrt(sq / mask.length) : 0;
  };
  const maxAbsOf = (base: Float32Array): number => {
    let m = 0;
    for (const i of mask) {
      const a = Math.abs((meas[i] as number) + (base[i] as number) - (anch[i] as number));
      if (a > m) m = a;
    }
    return m;
  };
  let curRms = rmsOf(cur);
  while (bands.length < MAX_BANDS) {
    if (opts.rmsStop !== undefined && curRms <= opts.rmsStop) break;
    if (maxAbsOf(cur) < 0.5) break;
    let bestRms = Infinity;
    let best: { fi: number; qi: number; gi: number } | null = null;
    for (const c of combos) {
      const f = YAMAHA_FREQS[c.fi] as number;
      const lows = bands.filter((b) => b.frequencyHz <= 400).length + (f <= 400 ? 1 : 0);
      if (lows > MAX_LOW_BANDS) continue;
      const v = vecs.get(`${c.fi}:${c.qi}:${c.gi}`) as Float32Array;
      let over = false;
      for (const i of mask) {
        if ((cur[i] as number) + (v[i] as number) > MAX_BOOST_DB + 1e-9) {
          over = true;
          break;
        }
      }
      if (over) continue;
      let sq = 0;
      for (const i of mask) {
        const r = (meas[i] as number) + (cur[i] as number) + (v[i] as number) - (anch[i] as number);
        sq += r * r;
      }
      const rms = mask.length ? Math.sqrt(sq / mask.length) : 0;
      if (rms < bestRms) {
        bestRms = rms;
        best = c;
      }
    }
    if (!best || !(bestRms < curRms - 0.05 + 1e-12)) break;
    const band: YamahaBand = {
      frequencyHz: YAMAHA_FREQS[best.fi] as number,
      q: YAMAHA_QS[best.qi] as number,
      gainDb: gains[best.gi] as number,
    };
    bands.push(band);
    const v = vecs.get(`${best.fi}:${best.qi}:${best.gi}`) as Float32Array;
    for (let i = 0; i < n; i++) cur[i]! += v[i] as number;
    curRms = bestRms;
  }
  return sortBands(bands);
}

export interface RandomOpts {
  seed?: number;
  samples?: number;
  sr?: number;
}

export function randomBestFit(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  opts: RandomOpts = {},
): YamahaBand[] {
  const sr = opts.sr ?? 48000;
  const seed = opts.seed ?? 1;
  const samples = opts.samples ?? 20000;
  const rng = mulberry32(seed);
  const gains = gainGrid();
  const n = grid.length;
  const mask = fitMask(grid);
  const meas = Float32Array.from(measuredDb as ArrayLike<number>);
  const anch = Float32Array.from(anchored as ArrayLike<number>);
  const base = uncorrectedScore(grid, measuredDb, anchored).rms;
  let bestRms = base;
  let best: YamahaBand[] = [];
  const tmp = new Float32Array(n);
  for (let s = 0; s < samples; s++) {
    const nb = 1 + Math.floor(rng() * MAX_BANDS);
    const bands: YamahaBand[] = [];
    for (let k = 0; k < nb; k++) {
      bands.push({
        frequencyHz: YAMAHA_FREQS[Math.floor(rng() * YAMAHA_FREQS.length)] as number,
        q: YAMAHA_QS[Math.floor(rng() * YAMAHA_QS.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      });
    }
    if (!validYamahaBands(bands)) continue;
    tmp.fill(0);
    for (const b of bands) {
      for (let i = 0; i < n; i++) tmp[i]! += bandMagnitudeDb(b, grid[i] as number, sr);
    }
    let over = false;
    for (const i of mask) {
      if ((tmp[i] as number) > MAX_BOOST_DB + 1e-9) {
        over = true;
        break;
      }
    }
    if (over) continue;
    let sq = 0;
    for (const i of mask) {
      const r = (meas[i] as number) + (tmp[i] as number) - (anch[i] as number);
      sq += r * r;
    }
    const rms = mask.length ? Math.sqrt(sq / mask.length) : 0;
    if (rms < bestRms) {
      bestRms = rms;
      best = sortBands(bands);
    }
  }
  return best;
}

export function refinedFit(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  start: YamahaBand[],
  opts: RandomOpts = {},
): YamahaBand[] {
  const sr = opts.sr ?? 48000;
  const seed = (opts.seed ?? 1) ^ 0x9e3779b9;
  const samples = opts.samples ?? 20000;
  const rng = mulberry32(seed);
  const gains = gainGrid();
  const n = grid.length;
  const mask = fitMask(grid);
  const meas = Float32Array.from(measuredDb as ArrayLike<number>);
  const anch = Float32Array.from(anchored as ArrayLike<number>);
  const scoreOf = (bands: YamahaBand[]): number => {
    const corr = correctionCurve(bands, grid, sr);
    let sq = 0;
    for (const i of mask) {
      const r = (meas[i] as number) + (corr[i] as number) - (anch[i] as number);
      sq += r * r;
    }
    return mask.length ? Math.sqrt(sq / mask.length) : 0;
  };
  const boostOk = (bands: YamahaBand[]): boolean => {
    const corr = correctionCurve(bands, grid, sr);
    for (const i of mask) if ((corr[i] as number) > MAX_BOOST_DB + 1e-9) return false;
    return true;
  };
  let cur = sortBands(start);
  let curScore = scoreOf(cur);
  for (let s = 0; s < samples; s++) {
    const op = Math.floor(rng() * 6);
    let next: YamahaBand[] = cur.map((b) => ({ ...b }));
    if (op === 0) {
      if (!next.length) continue;
      const b = next[Math.floor(rng() * next.length)] as YamahaBand;
      b.frequencyHz = YAMAHA_FREQS[Math.floor(rng() * YAMAHA_FREQS.length)] as number;
    } else if (op === 1) {
      if (!next.length) continue;
      const b = next[Math.floor(rng() * next.length)] as YamahaBand;
      b.q = YAMAHA_QS[Math.floor(rng() * YAMAHA_QS.length)] as number;
    } else if (op === 2) {
      if (!next.length) continue;
      const b = next[Math.floor(rng() * next.length)] as YamahaBand;
      b.gainDb = gains[Math.floor(rng() * gains.length)] as number;
    } else if (op === 3) {
      if (next.length >= MAX_BANDS) continue;
      next.push({
        frequencyHz: YAMAHA_FREQS[Math.floor(rng() * YAMAHA_FREQS.length)] as number,
        q: YAMAHA_QS[Math.floor(rng() * YAMAHA_QS.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      });
    } else if (op === 4) {
      if (!next.length) continue;
      next.splice(Math.floor(rng() * next.length), 1);
    } else {
      if (!next.length) continue;
      const idx = Math.floor(rng() * next.length);
      next[idx] = {
        frequencyHz: YAMAHA_FREQS[Math.floor(rng() * YAMAHA_FREQS.length)] as number,
        q: YAMAHA_QS[Math.floor(rng() * YAMAHA_QS.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      };
    }
    next = sortBands(next);
    if (!validYamahaBands(next)) continue;
    if (!boostOk(next)) continue;
    const sc = scoreOf(next);
    if (sc < curScore) {
      cur = next;
      curScore = sc;
    }
  }
  return cur;
}

export interface GenerateOpts {
  strategies?: string[];
  seed?: number;
  samples?: number;
  sr?: number;
}

export function generateCandidates(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  opts: GenerateOpts = {},
): YamahaCandidate[] {
  const wanted = opts.strategies ?? [...STRATEGIES];
  const seed = opts.seed ?? 1;
  const samples = opts.samples ?? 20000;
  const sr = opts.sr ?? 48000;
  const byStrategy = new Map<string, YamahaBand[]>();
  if (wanted.includes("greedy")) byStrategy.set("greedy", greedyFit(grid, measuredDb, anchored, { sr }));
  if (wanted.includes("greedy-cuts"))
    byStrategy.set("greedy-cuts", greedyFit(grid, measuredDb, anchored, { gainMax: 0, sr }));
  if (wanted.includes("greedy-minimal"))
    byStrategy.set("greedy-minimal", greedyFit(grid, measuredDb, anchored, { rmsStop: 1.0, sr }));
  if (wanted.includes("greedy-broad"))
    byStrategy.set("greedy-broad", greedyFit(grid, measuredDb, anchored, { qMax: 1.0, sr }));
  if (wanted.includes("random-best"))
    byStrategy.set("random-best", randomBestFit(grid, measuredDb, anchored, { seed, samples, sr }));
  if (wanted.includes("greedy-refined")) {
    const g = byStrategy.get("greedy") ?? greedyFit(grid, measuredDb, anchored, { sr });
    byStrategy.set("greedy-refined", refinedFit(grid, measuredDb, anchored, g, { seed, samples, sr }));
  }
  const grouped = new Map<string, { bands: YamahaBand[]; names: string[] }>();
  for (const [name, bands] of byStrategy) {
    const k = bandKey(bands);
    const e = grouped.get(k);
    if (e) e.names.push(name);
    else grouped.set(k, { bands: sortBands(bands), names: [name] });
  }
  const out: YamahaCandidate[] = [];
  for (const { bands, names } of grouped.values()) {
    const s = scorePrediction(grid, measuredDb, anchored, bands, sr);
    const pred = predictCurve(measuredDb, bands, grid, sr);
    out.push({
      strategy: names[0] as string,
      strategies: [...names],
      bands: sortBands(bands),
      rms: s.rms,
      maxAbs: s.maxAbs,
      maxBoost: s.maxBoost,
      grid: [...grid].map((v) => v as number),
      predicted: [...pred].map((v) => v as number),
    });
  }
  out.sort((a, b) => a.rms - b.rms);
  return out;
}

export function outputGrid(n = OUTPUT_N): Float32Array {
  return logGrid(20, 20000, n);
}

export type YamahaChannel = "left" | "right";

export function stereoStimulus(sweep: Float32Array, channel: YamahaChannel): { left: Float32Array; right: Float32Array } {
  const silence = new Float32Array(sweep.length);
  return channel === "right" ? { left: silence, right: sweep } : { left: sweep, right: silence };
}

export function throwOnSerialMismatch(warnings: string[]): void {
  if (warnings.some((w) => /serial mismatch/i.test(w))) {
    throw new Error(warnings.find((w) => /serial mismatch/i.test(w)) as string);
  }
}
