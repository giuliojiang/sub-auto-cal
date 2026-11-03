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

export interface GridConfig {
  freqs: number[];
  qs: number[];
  gainMin: number;
  gainMax: number;
  gainStep: number;
  maxBands: number;
  maxLowBands: number;
  lowCutHz: number;
  maxBoostDb: number;
  coarseFreqStep?: number;
  coarseQStep?: number;
  coarseGainStepDb?: number;
  refineFreqRadius?: number;
  refineQRadius?: number;
  refineGainRadiusDb?: number;
}

export function gridConfig(
  freqs: number[],
  qs: number[],
  gainMin: number,
  gainMax: number,
  gainStep: number,
  maxBands: number,
  maxLowBands: number,
  lowCutHz: number,
  maxBoostDb: number,
): GridConfig {
  return { freqs, qs, gainMin, gainMax, gainStep, maxBands, maxLowBands, lowCutHz, maxBoostDb };
}
export const FIT_FMIN = 20;
export const FIT_FMAX = 16000;
export const MAX_BANDS = 7;
export const MAX_LOW_BANDS = 4;
export const MAX_BOOST_DB = 3;
export const OUTPUT_N = 240;

export const YAMAHA_GRID: GridConfig = gridConfig(
  [...YAMAHA_FREQS],
  [...YAMAHA_QS],
  YAMAHA_GAIN_MIN,
  YAMAHA_GAIN_MAX,
  YAMAHA_GAIN_STEP,
  MAX_BANDS,
  MAX_LOW_BANDS,
  400,
  MAX_BOOST_DB,
);

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

export function gainGrid(
  min = YAMAHA_GAIN_MIN,
  max = YAMAHA_GAIN_MAX,
  step = YAMAHA_GAIN_STEP,
): number[] {
  const out: number[] = [];
  for (let g = min; g <= max + 1e-9; g += step) {
    out.push(Math.round(g / step) * step);
  }
  return out;
}

export function gridGains(cfg: GridConfig): number[] {
  return gainGrid(cfg.gainMin, cfg.gainMax, cfg.gainStep);
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

export function isGridFreq(cfg: GridConfig, f: number): boolean {
  return cfg.freqs.some((v) => Math.abs(v - f) < 1e-9);
}

export function isGridQ(cfg: GridConfig, q: number): boolean {
  return cfg.qs.some((v) => Math.abs(v - q) < 1e-9);
}

export function isGridGain(cfg: GridConfig, g: number): boolean {
  if (g < cfg.gainMin - 1e-9 || g > cfg.gainMax + 1e-9) return false;
  return Math.abs(g / cfg.gainStep - Math.round(g / cfg.gainStep)) < 1e-9;
}

export function isYamahaFreq(f: number): boolean {
  return isGridFreq(YAMAHA_GRID, f);
}

export function isYamahaQ(q: number): boolean {
  return isGridQ(YAMAHA_GRID, q);
}

export function isGainStep(g: number): boolean {
  return isGridGain(YAMAHA_GRID, g);
}

export function lowBandCount(bands: YamahaBand[], cfg: GridConfig = YAMAHA_GRID): number {
  return bands.filter((b) => b.frequencyHz <= cfg.lowCutHz).length;
}

export function validBands(bands: YamahaBand[], cfg: GridConfig = YAMAHA_GRID): boolean {
  if (bands.length > cfg.maxBands) return false;
  if (lowBandCount(bands, cfg) > cfg.maxLowBands) return false;
  for (const b of bands) {
    if (!isGridFreq(cfg, b.frequencyHz)) return false;
    if (!isGridQ(cfg, b.q)) return false;
    if (!isGridGain(cfg, b.gainDb)) return false;
  }
  return true;
}

export function validYamahaBands(bands: YamahaBand[]): boolean {
  return validBands(bands, YAMAHA_GRID);
}

export function maxBoostFor(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  cfg: GridConfig = YAMAHA_GRID,
  sr = 48000,
): number {
  void cfg;
  const mask = fitMask(grid);
  let m = -Infinity;
  for (const i of mask) {
    const c = combinedCorrectionDb(bands, grid[i] as number, sr);
    if (c > m) m = c;
  }
  return m === -Infinity ? 0 : m;
}

export function maxCombinedBoost(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): number {
  return maxBoostFor(bands, grid, YAMAHA_GRID, sr);
}

export function fullyValidBands(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  cfg: GridConfig = YAMAHA_GRID,
  sr = 48000,
): boolean {
  if (!validBands(bands, cfg)) return false;
  return maxBoostFor(bands, grid, cfg, sr) <= cfg.maxBoostDb + 1e-6;
}

export function fullyValidYamahaBands(
  bands: YamahaBand[],
  grid: Float32Array | number[],
  sr = 48000,
): boolean {
  return fullyValidBands(bands, grid, YAMAHA_GRID, sr);
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
  cfg: GridConfig;
  grid: Float32Array | number[];
  sr: number;
  gains: number[];
  vecs: Map<string, Float32Array>;
}

function bandVector(
  cfg: GridConfig,
  grid: Float32Array | number[],
  sr: number,
  gains: number[],
  fi: number,
  qi: number,
  gi: number,
): Float32Array {
  const band: YamahaBand = {
    frequencyHz: cfg.freqs[fi] as number,
    q: cfg.qs[qi] as number,
    gainDb: gains[gi] as number,
  };
  const [b0, b1, b2, a0, a1, a2] = rbjPeak(band.frequencyHz, band.q, band.gainDb, sr);
  const n = grid.length;
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
  return v;
}

function buildBandCache(grid: Float32Array | number[], sr: number, cfg: GridConfig): BandCache {
  return { cfg, grid, sr, gains: gridGains(cfg), vecs: new Map<string, Float32Array>() };
}

function cacheVec(cache: BandCache, fi: number, qi: number, gi: number): Float32Array {
  const key = `${fi}:${qi}:${gi}`;
  let v = cache.vecs.get(key);
  if (!v) {
    v = bandVector(cache.cfg, cache.grid, cache.sr, cache.gains, fi, qi, gi);
    cache.vecs.set(key, v);
  }
  return v;
}

interface GreedyOpts {
  gainMin?: number;
  gainMax?: number;
  qMax?: number;
  rmsStop?: number;
  sr?: number;
  grid?: GridConfig;
}

export interface Combo {
  fi: number;
  qi: number;
  gi: number;
}

function allowedCombos(
  opts: GreedyOpts,
  cfg: GridConfig,
  gains: number[],
  fiStep = 1,
  qiStep = 1,
  giStep = 1,
): Combo[] {
  const gmin = opts.gainMin ?? cfg.gainMin;
  const gmax = opts.gainMax ?? cfg.gainMax;
  const qmax = opts.qMax ?? Infinity;
  const out: Combo[] = [];
  for (let fi = 0; fi < cfg.freqs.length; fi += fiStep) {
    for (let qi = 0; qi < cfg.qs.length; qi += qiStep) {
      if ((cfg.qs[qi] as number) > qmax + 1e-12) continue;
      for (let gi = 0; gi < gains.length; gi += giStep) {
        const g = gains[gi] as number;
        if (g < gmin - 1e-9 || g > gmax + 1e-9) continue;
        out.push({ fi, qi, gi });
      }
    }
  }
  return out;
}

function refineCombos(cfg: GridConfig, gains: number[], center: Combo, opts: GreedyOpts): Combo[] {
  const gmin = opts.gainMin ?? cfg.gainMin;
  const gmax = opts.gainMax ?? cfg.gainMax;
  const qmax = opts.qMax ?? Infinity;
  const fr = cfg.refineFreqRadius ?? 6;
  const qr = cfg.refineQRadius ?? 6;
  const gr = Math.round((cfg.refineGainRadiusDb ?? 1) / cfg.gainStep);
  const out: Combo[] = [];
  const fi0 = Math.max(0, center.fi - fr);
  const fi1 = Math.min(cfg.freqs.length - 1, center.fi + fr);
  const qi0 = Math.max(0, center.qi - qr);
  const qi1 = Math.min(cfg.qs.length - 1, center.qi + qr);
  const gi0 = Math.max(0, center.gi - gr);
  const gi1 = Math.min(gains.length - 1, center.gi + gr);
  for (let fi = fi0; fi <= fi1; fi++) {
    for (let qi = qi0; qi <= qi1; qi++) {
      if ((cfg.qs[qi] as number) > qmax + 1e-12) continue;
      for (let gi = gi0; gi <= gi1; gi++) {
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
  const cfg = opts.grid ?? YAMAHA_GRID;
  const cache = buildBandCache(grid, sr, cfg);
  const gains = cache.gains;
  const coarse = cfg.coarseFreqStep !== undefined;
  const combos = coarse
    ? allowedCombos(
        opts,
        cfg,
        gains,
        cfg.coarseFreqStep ?? 1,
        cfg.coarseQStep ?? 1,
        Math.max(1, Math.round((cfg.coarseGainStepDb ?? cfg.gainStep) / cfg.gainStep)),
      )
    : allowedCombos(opts, cfg, gains);
  const mask = fitMask(grid);
  const n = grid.length;
  const meas = Float32Array.from(measuredDb as ArrayLike<number>);
  const anch = Float32Array.from(anchored as ArrayLike<number>);
  const cur = new Float32Array(n);
  const bands: YamahaBand[] = [];
  const searchCombos = (list: Combo[]): { best: Combo | null; bestRms: number } => {
    let bestRms = Infinity;
    let best: Combo | null = null;
    for (const c of list) {
      const f = cfg.freqs[c.fi] as number;
      const lows = bands.filter((b) => b.frequencyHz <= cfg.lowCutHz).length + (f <= cfg.lowCutHz ? 1 : 0);
      if (lows > cfg.maxLowBands) continue;
      const v = cacheVec(cache, c.fi, c.qi, c.gi);
      let over = false;
      for (const i of mask) {
        if ((cur[i] as number) + (v[i] as number) > cfg.maxBoostDb + 1e-9) {
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
    return { best, bestRms };
  };
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
  while (bands.length < cfg.maxBands) {
    if (opts.rmsStop !== undefined && curRms <= opts.rmsStop) break;
    if (maxAbsOf(cur) < 0.5) break;
    let { best, bestRms } = searchCombos(combos);
    if (coarse && best) {
      const refined = searchCombos(refineCombos(cfg, gains, best, opts));
      best = refined.best;
      bestRms = refined.bestRms;
    }
    if (!best || !(bestRms < curRms - 0.05 + 1e-12)) break;
    const band: YamahaBand = {
      frequencyHz: cfg.freqs[best.fi] as number,
      q: cfg.qs[best.qi] as number,
      gainDb: gains[best.gi] as number,
    };
    bands.push(band);
    const v = cacheVec(cache, best.fi, best.qi, best.gi);
    for (let i = 0; i < n; i++) cur[i]! += v[i] as number;
    curRms = bestRms;
  }
  return sortBands(bands);
}

export interface RandomOpts {
  seed?: number;
  samples?: number;
  sr?: number;
  grid?: GridConfig;
}

export function randomBestFit(
  grid: Float32Array | number[],
  measuredDb: Float32Array | number[],
  anchored: Float32Array | number[],
  opts: RandomOpts = {},
): YamahaBand[] {
  const sr = opts.sr ?? 48000;
  const cfg = opts.grid ?? YAMAHA_GRID;
  const seed = opts.seed ?? 1;
  const samples = opts.samples ?? 20000;
  const rng = mulberry32(seed);
  const gains = gridGains(cfg);
  const n = grid.length;
  const mask = fitMask(grid);
  const meas = Float32Array.from(measuredDb as ArrayLike<number>);
  const anch = Float32Array.from(anchored as ArrayLike<number>);
  const base = uncorrectedScore(grid, measuredDb, anchored).rms;
  let bestRms = base;
  let best: YamahaBand[] = [];
  const tmp = new Float32Array(n);
  for (let s = 0; s < samples; s++) {
    const nb = 1 + Math.floor(rng() * cfg.maxBands);
    const bands: YamahaBand[] = [];
    for (let k = 0; k < nb; k++) {
      bands.push({
        frequencyHz: cfg.freqs[Math.floor(rng() * cfg.freqs.length)] as number,
        q: cfg.qs[Math.floor(rng() * cfg.qs.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      });
    }
    if (!validBands(bands, cfg)) continue;
    tmp.fill(0);
    for (const b of bands) {
      for (let i = 0; i < n; i++) tmp[i]! += bandMagnitudeDb(b, grid[i] as number, sr);
    }
    let over = false;
    for (const i of mask) {
      if ((tmp[i] as number) > cfg.maxBoostDb + 1e-9) {
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
  const cfg = opts.grid ?? YAMAHA_GRID;
  const seed = (opts.seed ?? 1) ^ 0x9e3779b9;
  const samples = opts.samples ?? 20000;
  const rng = mulberry32(seed);
  const gains = gridGains(cfg);
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
    for (const i of mask) if ((corr[i] as number) > cfg.maxBoostDb + 1e-9) return false;
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
      b.frequencyHz = cfg.freqs[Math.floor(rng() * cfg.freqs.length)] as number;
    } else if (op === 1) {
      if (!next.length) continue;
      const b = next[Math.floor(rng() * next.length)] as YamahaBand;
      b.q = cfg.qs[Math.floor(rng() * cfg.qs.length)] as number;
    } else if (op === 2) {
      if (!next.length) continue;
      const b = next[Math.floor(rng() * next.length)] as YamahaBand;
      b.gainDb = gains[Math.floor(rng() * gains.length)] as number;
    } else if (op === 3) {
      if (next.length >= cfg.maxBands) continue;
      next.push({
        frequencyHz: cfg.freqs[Math.floor(rng() * cfg.freqs.length)] as number,
        q: cfg.qs[Math.floor(rng() * cfg.qs.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      });
    } else if (op === 4) {
      if (!next.length) continue;
      next.splice(Math.floor(rng() * next.length), 1);
    } else {
      if (!next.length) continue;
      const idx = Math.floor(rng() * next.length);
      next[idx] = {
        frequencyHz: cfg.freqs[Math.floor(rng() * cfg.freqs.length)] as number,
        q: cfg.qs[Math.floor(rng() * cfg.qs.length)] as number,
        gainDb: gains[Math.floor(rng() * gains.length)] as number,
      };
    }
    next = sortBands(next);
    if (!validBands(next, cfg)) continue;
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
  grid?: GridConfig;
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
  const gcfg = opts.grid;
  const byStrategy = new Map<string, YamahaBand[]>();
  if (wanted.includes("greedy")) byStrategy.set("greedy", greedyFit(grid, measuredDb, anchored, { sr, grid: gcfg }));
  if (wanted.includes("greedy-cuts"))
    byStrategy.set("greedy-cuts", greedyFit(grid, measuredDb, anchored, { gainMax: 0, sr, grid: gcfg }));
  if (wanted.includes("greedy-minimal"))
    byStrategy.set("greedy-minimal", greedyFit(grid, measuredDb, anchored, { rmsStop: 1.0, sr, grid: gcfg }));
  if (wanted.includes("greedy-broad"))
    byStrategy.set("greedy-broad", greedyFit(grid, measuredDb, anchored, { qMax: 1.0, sr, grid: gcfg }));
  if (wanted.includes("random-best"))
    byStrategy.set("random-best", randomBestFit(grid, measuredDb, anchored, { seed, samples, sr, grid: gcfg }));
  if (wanted.includes("greedy-refined")) {
    const g = byStrategy.get("greedy") ?? greedyFit(grid, measuredDb, anchored, { sr, grid: gcfg });
    byStrategy.set("greedy-refined", refinedFit(grid, measuredDb, anchored, g, { seed, samples, sr, grid: gcfg }));
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
