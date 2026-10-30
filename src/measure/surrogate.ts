import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playStereoWav, recordWav, writeWavStereo, readWav, noiseCheck } from "../audio.ts";
import { genESS, inverseESS, deconvolveToComplexIR, interpLog, smoothOctave, logGrid, MEASURE_RATE } from "./sweep.ts";
import { genChirp, detectChirp, CHIRP_GAP_SECS } from "./chirp.ts";
import { cloneCandidate, deviceStateToCandidate, scoreResponse, type Candidate, type ChannelBase, type Scored } from "./objective.ts";
import { applyCal, type MicCal, type CalProvenance } from "./miccal.ts";
import type { DspDevice, DeviceState } from "../dsp/device.ts";
import {
  hzToFreqIndex,
  freqIndexToHz,
  qToRaw,
  rawToQ,
  peqGainDbToRaw,
  peqGainRawToDb,
  msToDelaySamples,
  delaySamplesToMs,
  gainDbToRaw,
  gainRawToDb,
} from "../dsp/protocol.ts";
import { candidateMismatches } from "./loop.ts";

export const GRID_STRIDE = 8;

export function rbjCoeffs(type: number, f0: number, q: number, gainDb: number, sr = MEASURE_RATE): number[] {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const al = sw / (2 * Math.max(0.05, q));
  if (type === 1) {
    const sq = sw * Math.sqrt(Math.max(0.01, A)) * 0.5;
    return [A * (A + 1 + (A - 1) * cw + 2 * sq), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - 2 * sq), A + 1 - (A - 1) * cw + 2 * sq, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - 2 * sq];
  }
  if (type === 2) {
    const sq = sw * Math.sqrt(Math.max(0.01, A)) * 0.5;
    return [A * (A + 1 - (A - 1) * cw + 2 * sq), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - 2 * sq), A + 1 + (A - 1) * cw - 2 * sq, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw + 2 * sq];
  }
  if (type === 3) return [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al];
  if (type === 4) return [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al];
  if (type === 5 || type === 6) return [1 - al, -2 * cw, 1 + al, 1 + al, -2 * cw, 1 - al];
  return [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
}

export function evalBiquad(cf: number[], f: number, sr = MEASURE_RATE): [number, number] {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const [b0, b1, b2, a0, a1, a2] = cf as [number, number, number, number, number, number];
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const d = dr * dr + di * di;
  return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d];
}

export function bandResp(type: number, f0: number, q: number, gainDb: number, grid: Float32Array, outRe: Float32Array, outIm: Float32Array): void {
  const cf = rbjCoeffs(type, f0, q, gainDb);
  for (let i = 0; i < grid.length; i++) {
    const [r, im] = evalBiquad(cf, grid[i] as number);
    outRe[i] = r;
    outIm[i] = im;
  }
}

export interface PerOut {
  re: Float32Array;
  im: Float32Array;
  irPeak: number;
  anchor: number;
  corrPeak: number;
  marginRatio: number;
  marginDb: number;
  secondDelay: number;
}

export interface SurrogateModel {
  grid: Float32Array;
  outs: PerOut[];
  bases: ChannelBase[];
  types: number[][];
}

export function snapCandidate(c: Candidate): Candidate {
  const n = cloneCandidate(c);
  for (const ch of n.channels) {
    ch.gainDb = gainRawToDb(gainDbToRaw(ch.gainDb));
    ch.delayMs = delaySamplesToMs(msToDelaySamples(ch.delayMs));
    for (const b of ch.bands) {
      b.freqHz = freqIndexToHz(hzToFreqIndex(b.freqHz));
      b.q = rawToQ(qToRaw(b.q));
      b.gainDb = peqGainRawToDb(peqGainDbToRaw(b.gainDb));
    }
  }
  return n;
}

function cascadeInto(grid: Float32Array, bands: { freqHz: number; q: number; gainDb: number }[], types: number[], re: Float32Array, im: Float32Array): void {
  const br = new Float32Array(grid.length);
  const bi = new Float32Array(grid.length);
  re.fill(1);
  im.fill(0);
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b]!;
    bandResp(types[b] ?? 0, band.freqHz, band.q, band.gainDb, grid, br, bi);
    for (let i = 0; i < grid.length; i++) {
      const h = re[i] as number;
      const k = im[i] as number;
      const a = br[i] as number;
      const c = bi[i] as number;
      re[i] = h * a - k * c;
      im[i] = h * c + k * a;
    }
  }
}

export function predictCombined(m: SurrogateModel, c: Candidate): { re: Float32Array; im: Float32Array } {
  const n = m.grid.length;
  const s = snapCandidate(c);
  const sr = new Float32Array(n);
  const si = new Float32Array(n);
  const cr = new Float32Array(n);
  const ci = new Float32Array(n);
  for (let p = 0; p < 4; p++) {
    const mo = m.outs[p]!;
    const ch = s.channels[p]!;
    const base = m.bases[p]!;
    cascadeInto(m.grid, ch.bands, m.types[p]!, cr, ci);
    const g = Math.pow(10, (ch.gainDb - base.gainDb) / 20);
    const dt = (ch.delayMs - base.delayMs) / 1000;
    for (let i = 0; i < n; i++) {
      const ph = (-2 * Math.PI * (m.grid[i] as number) * dt);
      const cp = Math.cos(ph) * g;
      const sp = Math.sin(ph) * g;
      const h = (mo.re[i] as number) * (cr[i] as number) - (mo.im[i] as number) * (ci[i] as number);
      const k = (mo.re[i] as number) * (ci[i] as number) + (mo.im[i] as number) * (cr[i] as number);
      sr[i] = (sr[i] as number) + h * cp - k * sp;
      si[i] = (si[i] as number) + h * sp + k * cp;
    }
  }
  return { re: sr, im: si };
}

export function scorePrediction(grid: Float32Array, re: Float32Array, im: Float32Array, fStart: number, fLowcut: number, fEnd: number, baseMean: number): Scored {
  const freqs = grid;
  const db = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) db[i] = 20 * Math.log10(Math.max(1e-12, Math.hypot(re[i] as number, im[i] as number)));
  const log = logGrid(20, 20000, 480);
  return scoreResponse(log, smoothOctave(log, interpLog({ freqs, db }, log), 1 / 12), fStart, fLowcut, fEnd, baseMean);
}

export class ScreenPredictor {
  private m: SurrogateModel;
  private parent: Candidate;
  private cascades: { re: Float32Array; im: Float32Array }[];
  private delayCache = new Map<number, { c: Float32Array; s: Float32Array }>();

  constructor(m: SurrogateModel, parent: Candidate) {
    this.m = m;
    this.parent = snapCandidate(parent);
    this.cascades = [];
    const cr = new Float32Array(m.grid.length);
    const ci = new Float32Array(m.grid.length);
    for (let p = 0; p < 4; p++) {
      const mo = m.outs[p]!;
      cascadeInto(m.grid, this.parent.channels[p]!.bands, m.types[p]!, cr, ci);
      const pr = new Float32Array(m.grid.length);
      const pi = new Float32Array(m.grid.length);
      for (let i = 0; i < m.grid.length; i++) {
        pr[i] = (mo.re[i] as number) * (cr[i] as number) - (mo.im[i] as number) * (ci[i] as number);
        pi[i] = (mo.re[i] as number) * (ci[i] as number) + (mo.im[i] as number) * (cr[i] as number);
      }
      this.cascades.push({ re: pr, im: pi });
    }
  }

  private delayRamp(samples: number): { c: Float32Array; s: Float32Array } {
    let r = this.delayCache.get(samples);
    if (!r) {
      const c = new Float32Array(this.m.grid.length);
      const s = new Float32Array(this.m.grid.length);
      const dt = samples / MEASURE_RATE;
      for (let i = 0; i < this.m.grid.length; i++) {
        const ph = -2 * Math.PI * (this.m.grid[i] as number) * dt;
        c[i] = Math.cos(ph);
        s[i] = Math.sin(ph);
      }
      r = { c, s };
      this.delayCache.set(samples, r);
    }
    return r;
  }

  predict(c: Candidate): { re: Float32Array; im: Float32Array } {
    const n = this.m.grid.length;
    const s = snapCandidate(c);
    const out = { re: new Float32Array(n), im: new Float32Array(n) };
    const br = new Float32Array(n);
    const bi = new Float32Array(n);
    const or = new Float32Array(n);
    const oi = new Float32Array(n);
    for (let p = 0; p < 4; p++) {
      const pc = this.cascades[p]!;
      const ch = s.channels[p]!;
      const rh = this.parent.channels[p]!;
      or.set(pc.re);
      oi.set(pc.im);
      for (let b = 0; b < ch.bands.length; b++) {
        const cb = ch.bands[b]!;
        const rb = rh.bands[b]!;
        if (cb.freqHz === rb.freqHz && cb.q === rb.q && cb.gainDb === rb.gainDb) continue;
        bandResp(this.m.types[p]![b] ?? 0, cb.freqHz, cb.q, cb.gainDb, this.m.grid, br, bi);
        for (let i = 0; i < n; i++) {
          const h = or[i] as number;
          const k = oi[i] as number;
          const a = br[i] as number;
          const bb = bi[i] as number;
          or[i] = h * a - k * bb;
          oi[i] = h * bb + k * a;
        }
        bandResp(this.m.types[p]![b] ?? 0, rb.freqHz, rb.q, rb.gainDb, this.m.grid, br, bi);
        for (let i = 0; i < n; i++) {
          const a = br[i] as number;
          const bb = bi[i] as number;
          const dn = a * a + bb * bb;
          const h = or[i] as number;
          const k = oi[i] as number;
          or[i] = (h * a + k * bb) / dn;
          oi[i] = (k * a - h * bb) / dn;
        }
      }
      const base = this.m.bases[p]!;
      const g = Math.pow(10, (ch.gainDb - base.gainDb) / 20);
      const ramp = this.delayRamp(Math.round((ch.delayMs - base.delayMs) * MEASURE_RATE / 1000));
      for (let i = 0; i < n; i++) {
        const cp = (ramp.c[i] as number) * g;
        const sp = (ramp.s[i] as number) * g;
        const h = or[i] as number;
        const k = oi[i] as number;
        out.re[i] = (out.re[i] as number) + h * cp - k * sp;
        out.im[i] = (out.im[i] as number) + h * sp + k * cp;
      }
    }
    return out;
  }
}

export function arrivalSamples(m: SurrogateModel): number[] {
  return m.outs.map((o) => o.irPeak);
}

export function outputLevels(m: SurrogateModel, fStart: number, fEnd: number): number[] {
  return m.outs.map((o) => {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < m.grid.length; i++) {
      const f = m.grid[i] as number;
      if (f >= fStart && f <= fEnd) {
        sum += 20 * Math.log10(Math.max(1e-12, Math.hypot(o.re[i] as number, o.im[i] as number)));
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  });
}

export function verifyRouting(st: DeviceState, masks: number[]): string[] {
  const out: string[] = [];
  for (let o = 0; o < 4; o++) {
    if (st.outputs[o]!.routingMask !== masks[o]) out.push(`Out${o + 1} routing mask ${st.outputs[o]!.routingMask}, want ${masks[o]}`);
  }
  return out;
}

export interface OutputSetConfig {
  fStart: number;
  fEnd: number;
  sweepSecs: number;
  playbackId?: string;
  captureId?: string;
  snapshot: DeviceState;
  getCal?: () => { cal: MicCal; prov: CalProvenance } | null;
  isStopped: () => boolean;
  tag: string;
}

interface Prepared {
  sweep: Float32Array;
  inv: Float32Array;
  chirp: Float32Array;
  stimFile: string;
  recSecs: number;
  sweepAt: number;
  dir: string;
}

function baselineCandidate(snapshot: DeviceState): { candidate: Candidate; bases: ChannelBase[]; types: number[][] } {
  const types = snapshot.outputs.map((o) => o.bands.map((b) => b.type));
  const channels = snapshot.outputs.slice(0, 4).map((o, p) => ({
    bands: o.bands.slice(0, 7).map((b, bi) => ({
      freqHz: b.freqHz,
      q: b.q,
      gainDb: (types[p]![bi] ?? 0) >= 3 ? b.gainDb : 0,
    })),
    gainDb: o.gainDb,
    delayMs: o.delayMs,
  }));
  const bases = channels.map((c) => ({ gainDb: c.gainDb, delayMs: c.delayMs }));
  return { candidate: { channels }, bases, types };
}

async function measureSingleOutput(dev: DspDevice, i: number, o: OutputSetConfig, prep: Prepared): Promise<PerOut & { freqs: Float32Array; irLen: number; dspState: DeviceState }> {
  const sr = MEASURE_RATE;
  const { candidate: flat, types } = baselineCandidate(o.snapshot);
  const masks = [0, 1, 2, 3].map((p) => (p === i ? (i === 0 ? 3 : 1) : p === 0 ? 2 : 0));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const keepDir = join(process.cwd(), "recordings");
  const recPath = join(keepDir, `loop-perout-${i}-${o.tag}-${stamp}.wav`);
  const metaPath = join(keepDir, `loop-perout-${i}-${o.tag}-${stamp}.json`);
  const { samples, dspState } = await dev.exclusive(async () => {
    for (let p = 0; p < 4; p++) {
      const ch = 4 + p;
      const fch = flat.channels[p]!;
      await dev.setGain(ch, fch.gainDb);
      await dev.setDelay(ch, fch.delayMs);
      for (let b = 0; b < 7; b++) {
        const band = fch.bands[b]!;
        const t = types[p]![b] ?? 0;
        await dev.setPeq(ch, b, { freqHz: band.freqHz, q: band.q, gainDb: band.gainDb, type: t, bypass: t >= 3 });
      }
      await dev.setRouting(ch, masks[p]!);
    }
    await new Promise((res) => setTimeout(res, 400));
    const st = await dev.refresh();
    const bad = [...candidateMismatches(st, flat, types), ...verifyRouting(st, masks)];
    if (bad.length) throw new Error(`measurement baseline did not take: ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? ` (+${bad.length - 4} more)` : ""}`);
    const recFile = join(prep.dir, `rec${i}.wav`);
    const rec = recordWav(recFile, prep.recSecs, sr, o.captureId);
    await new Promise((res) => setTimeout(res, 100));
    await playStereoWav(prep.stimFile, o.playbackId);
    await rec;
    return { samples: readWav(recFile).samples, dspState: st };
  });
  const hit = detectChirp(samples, prep.chirp, sr);
  const onset = hit.anchor + prep.sweepAt;
  const cmplx = deconvolveToComplexIR(samples, prep.sweep, prep.inv, onset, sr);
  const calEntry = o.getCal?.() ?? null;
  if (calEntry) {
    const mag = new Float32Array(cmplx.freqs.length);
    for (let k = 0; k < mag.length; k++) mag[k] = 20 * Math.log10(Math.max(1e-12, Math.hypot(cmplx.re[k] as number, cmplx.im[k] as number)));
    const fixed = applyCal(cmplx.freqs, mag, calEntry.cal);
    for (let k = 0; k < mag.length; k++) {
      const g = Math.pow(10, ((fixed[k] as number) - (mag[k] as number)) / 20);
      cmplx.re[k] = (cmplx.re[k] as number) * g;
      cmplx.im[k] = (cmplx.im[k] as number) * g;
    }
  }
  mkdirSync(keepDir, { recursive: true });
  writeFileSync(recPath, readFileSync(join(prep.dir, `rec${i}.wav`)));
  writeFileSync(metaPath, JSON.stringify({ anchor: hit.anchor, sweepOnset: onset, corrPeak: hit.peak, marginRatio: hit.marginRatio, marginDb: hit.marginDb, secondDelay: hit.secondDelay, irLen: cmplx.irLen, peakOffset: cmplx.peakOffset, dspState }));
  return { re: cmplx.re, im: cmplx.im, freqs: cmplx.freqs, irLen: cmplx.irLen, irPeak: cmplx.peakOffset, anchor: hit.anchor, corrPeak: hit.peak, marginRatio: hit.marginRatio, marginDb: hit.marginDb, secondDelay: hit.secondDelay, dspState };
}

export async function measureOutputSet(dev: DspDevice, o: OutputSetConfig): Promise<SurrogateModel> {
  const sr = MEASURE_RATE;
  const check = await noiseCheck(3, "pink", o.playbackId, o.captureId);
  if (check.verdict === "too low") throw new Error(`level too low for a measurement set (rms ${check.rmsDbfs.toFixed(1)} dBFS)`);
  const f1 = o.fStart / 2;
  const f2 = Math.min(20000, o.fEnd * 2);
  const sweep = genESS(f1, f2, o.sweepSecs);
  const inv = inverseESS(sweep, f1, f2, o.sweepSecs);
  const chirp = genChirp();
  const gapN = Math.floor(CHIRP_GAP_SECS * sr);
  const sweepAt = chirp.length + gapN;
  const totalN = sweepAt + sweep.length;
  const left = new Float32Array(totalN);
  const right = new Float32Array(totalN);
  left.set(sweep, sweepAt);
  right.set(chirp, 0);
  const dir = mkdtempSync(join(tmpdir(), "subperout-"));
  const stimFile = join(dir, "stim.wav");
  writeWavStereo(stimFile, left, right, sr);
  const prep: Prepared = { sweep, inv, chirp, stimFile, recSecs: Math.ceil(totalN / sr + 2.0), sweepAt, dir };
  const takes: (PerOut & { freqs: Float32Array; irLen: number; dspState: DeviceState })[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      if (o.isStopped()) throw new Error("stopped");
      takes.push(await measureSingleOutput(dev, i, o, prep));
    }
  } finally {
    await dev.revert();
    const st = await dev.refresh();
    const snap = deviceStateToCandidate(o.snapshot);
    const types = o.snapshot.outputs.map((x) => x.bands.map((b) => b.type));
    const bad = [...candidateMismatches(st, snap.candidate, types), ...verifyRouting(st, o.snapshot.outputs.map((x) => x.routingMask))];
    if (bad.length) throw new Error(`measurement cleanup failed to restore snapshot: ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? ` (+${bad.length - 4} more)` : ""}`);
  }
  const lens = takes.map((t) => t.freqs.length);
  if (!lens.every((l) => l === lens[0])) throw new Error(`per-output grids differ (${lens.join(",")}); cannot sum coherently`);
  const delays = takes.map((t) => t.secondDelay);
  if (Math.max(...delays) - Math.min(...delays) > 48) throw new Error(`chirp echo pattern differs across takes (${delays.join(",")} samples); anchors inconsistent`);
  const grid = takes[0]!.freqs.filter((_, k) => k % GRID_STRIDE === 0);
  const outs: PerOut[] = takes.map((t) => ({
    re: t.re.filter((_, k) => k % GRID_STRIDE === 0),
    im: t.im.filter((_, k) => k % GRID_STRIDE === 0),
    irPeak: t.irPeak,
    anchor: t.anchor,
    corrPeak: t.corrPeak,
    marginRatio: t.marginRatio,
    marginDb: t.marginDb,
    secondDelay: t.secondDelay,
  }));
  const { bases, types } = baselineCandidate(o.snapshot);
  return { grid, outs, bases, types };
}

export interface ChirpCheckResult {
  anchor: number;
  peak: number;
  marginRatio: number;
  marginDb: number;
  latencyMs: number;
  peqs: string;
}

export async function chirpCheck(dev: DspDevice, o: OutputSetConfig): Promise<ChirpCheckResult> {
  const sr = MEASURE_RATE;
  const f1 = o.fStart / 2;
  const f2 = Math.min(20000, o.fEnd * 2);
  const sweep = genESS(f1, f2, o.sweepSecs);
  const chirp = genChirp();
  const gapN = Math.floor(CHIRP_GAP_SECS * sr);
  const totalN = chirp.length + gapN + sweep.length;
  const left = new Float32Array(totalN);
  const right = new Float32Array(totalN);
  left.set(sweep, chirp.length + gapN);
  right.set(chirp, 0);
  const dir = mkdtempSync(join(tmpdir(), "subchirp-"));
  const stimFile = join(dir, "stim.wav");
  writeWavStereo(stimFile, left, right, sr);
  const masks = [3, 0, 0, 0];
  try {
    const samples = await dev.exclusive(async () => {
      for (let p = 0; p < 4; p++) await dev.setRouting(4 + p, masks[p]!);
      await new Promise((res) => setTimeout(res, 400));
      const bad = verifyRouting(await dev.refresh(), masks);
      if (bad.length) throw new Error(`chirp check matrix did not take: ${bad.join("; ")}`);
      const recFile = join(dir, "rec.wav");
      const rec = recordWav(recFile, Math.ceil(totalN / sr + 2.0), sr, o.captureId);
      await new Promise((res) => setTimeout(res, 100));
      await playStereoWav(stimFile, o.playbackId);
      await rec;
      return readWav(recFile).samples;
    });
    const keepDir = join(process.cwd(), "recordings");
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(keepDir, `chirpcheck-${o.tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`), readFileSync(join(dir, "rec.wav")));
    const hit = detectChirp(samples, chirp, sr);
    return { anchor: hit.anchor, peak: hit.peak, marginRatio: hit.marginRatio, marginDb: hit.marginDb, latencyMs: ((hit.anchor - Math.floor(0.1 * sr)) / sr) * 1000, peqs: "snapshot" };
  } finally {
    await dev.revert();
    const bad = verifyRouting(await dev.refresh(), o.snapshot.outputs.map((x) => x.routingMask));
    if (bad.length) throw new Error(`chirp check cleanup failed to restore routing: ${bad.join("; ")}`);
  }
}
