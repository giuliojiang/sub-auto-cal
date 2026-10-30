import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playWav, recordWav, writeWav, readWav } from "../audio.ts";
import {
  genESS,
  inverseESS,
  deconvolveToFR,
  logGrid,
  interpLog,
  smoothOctave,
  MEASURE_RATE,
} from "./sweep.ts";
import {
  scoreResponse,
  markPareto,
  mutateCandidate,
  validCandidate,
  deviceStateToCandidate,
  cloneCandidate,
  findPeaks,
  IMPROVE_DB,
  FLATNESS_WEIGHT,
  type Candidate,
  type ChannelBase,
  type Peak,
  type Scored,
} from "./objective.ts";
import { measureOutputSet, predictCombined, ScreenPredictor, scorePrediction, snapCandidate, arrivalSamples, type SurrogateModel } from "./surrogate.ts";
import { OPERATORS, OP_NAMES, opWeight, type OpName, type OpStats, type OpCtx } from "./operators.ts";
import { applyCal, type MicCal, type CalProvenance } from "./miccal.ts";
import type { DspDevice } from "../dsp/device.ts";
import {
  gainDbToRaw,
  gainRawToDb,
  msToDelaySamples,
  delaySamplesToMs,
  hzToFreqIndex,
  freqIndexToHz,
  qToRaw,
  rawToQ,
  type DeviceState,
} from "../dsp/protocol.ts";

export interface LoopConfig {
  fStart: number;
  fLowcut: number;
  fEnd: number;
  sweepSecs: number;
  maxIter: number;
  playbackId?: string;
  captureId?: string;
  settleMs?: number;
  getCal?: () => { cal: MicCal; prov: CalProvenance } | null;
  getDevice?: () => DspDevice | null;
  v2?: boolean;
  warmupSecs?: number;
  screenBudget?: number;
  topK?: number;
  rescreenEvery?: number;
  consistDb?: number;
}

export interface ApplyOpts {
  tries?: number;
  settleMs?: number;
  isStopped?: () => boolean;
}

export async function pushCandidate(dev: DspDevice, c: Candidate, types: number[][]): Promise<void> {
  for (let o = 0; o < 4; o++) {
    const ch = c.channels[o]!;
    const chan = 4 + o;
    await dev.setGain(chan, ch.gainDb);
    await dev.setDelay(chan, ch.delayMs);
    for (let b = 0; b < 7; b++) {
      const band = ch.bands[b]!;
      await dev.setPeq(chan, b, { freqHz: band.freqHz, q: band.q, gainDb: band.gainDb, type: types[o]![b] ?? 0, bypass: false });
    }
  }
}

// The hardware stores snapped raw values, so expectations are snapped with the
// same forward/back scales the readback uses; anything else is a missed write.
export function candidateMismatches(st: DeviceState, c: Candidate, types: number[][]): string[] {
  const out: string[] = [];
  for (let o = 0; o < 4; o++) {
    const ch = c.channels[o]!;
    const rd = st.outputs[o]!;
    if (Math.abs(rd.gainDb - gainRawToDb(gainDbToRaw(ch.gainDb))) > 1e-9) out.push(`Out${o + 1} gain`);
    if (Math.abs(rd.delayMs - delaySamplesToMs(msToDelaySamples(ch.delayMs))) > 1e-9) out.push(`Out${o + 1} delay`);
    ch.bands.forEach((b, bi) => {
      const rb = rd.bands[bi]!;
      if (Math.abs(rb.gainDb - gainRawToDb(gainDbToRaw(b.gainDb))) > 1e-9) out.push(`Out${o + 1}b${bi} gain`);
      if (Math.abs(rb.freqHz - freqIndexToHz(hzToFreqIndex(b.freqHz))) > 1e-6) out.push(`Out${o + 1}b${bi} freq`);
      if (Math.abs(rb.q - rawToQ(qToRaw(b.q))) > 1e-9) out.push(`Out${o + 1}b${bi} q`);
      if (rb.type !== (types[o]![bi] ?? 0)) out.push(`Out${o + 1}b${bi} type`);
    });
  }
  return out;
}

export function makeBaseline(scored: Scored): Scored {
  return { ...scored, loss: 0, cost: FLATNESS_WEIGHT * scored.flatness };
}

export function peaksOf(response: { freqs: number[]; db: number[] }, mean: number, fStart: number, fEnd: number): Peak[] {
  return findPeaks(Float32Array.from(response.freqs), Float32Array.from(response.db), fStart, fEnd, mean, 6);
}

export function isLargeMutation(iter: number): boolean {
  return iter % 2 === 0;
}

export async function applyCandidate(dev: DspDevice, c: Candidate, types: number[][], opts: ApplyOpts = {}): Promise<void> {
  return dev.exclusive(async () => {
    const tries = Math.max(1, opts.tries ?? 3);
    let last: string[] = [];
    for (let a = 0; a < tries; a++) {
      await pushCandidate(dev, c, types);
      last = candidateMismatches(await dev.refresh(), c, types);
      if (!last.length) break;
      if (opts.isStopped?.()) throw new Error("stopped while verifying dsp settings");
    }
    if (last.length) {
      const shown = last.slice(0, 4).join("; ");
      throw new Error(`dsp did not take settings: ${shown}${last.length > 4 ? ` (+${last.length - 4} more)` : ""}`);
    }
    await new Promise((res) => setTimeout(res, Math.max(0, opts.settleMs ?? 400)));
  });
}

export interface TimelineEntry {
  iter: number;
  kind: string;
  candidate: Candidate;
  scored: Scored;
  pareto: boolean;
  cal: CalProvenance | null;
  response: { freqs: number[]; db: number[] };
  op?: string;
  predJ?: number;
  predF?: number;
}

export interface LoopSnapshot {
  running: boolean;
  config: Omit<LoopConfig, "getCal">;
  baseline: Scored | null;
  timeline: TimelineEntry[];
  bestIter: number;
  appliedBest: number | null;
  cal: CalProvenance | null;
  error: string | null;
  phase: string;
  screenedTotal: number;
  opStats: { name: string; tried: number; improved: number; weight: number }[];
  consistency: { predF: number; measF: number } | null;
}

export class LoopRunner {
  running = false;
  timeline: TimelineEntry[] = [];
  baseline: Scored | null = null;
  appliedBest: number | null = null;
  error: string | null = null;
  phase = "idle";
  screenedTotal = 0;
  consistency: { predF: number; measF: number } | null = null;
  private stopAsked = false;
  config: LoopConfig;
  private settleMs: number;
  private opStats: Record<OpName, OpStats> = { peak: { tried: 0, improved: 0 }, delaygrid: { tried: 0, improved: 0 }, align: { tried: 0, improved: 0 }, gain: { tried: 0, improved: 0 }, single: { tried: 0, improved: 0 }, xover: { tried: 0, improved: 0 }, random: { tried: 0, improved: 0 } };
  private snapshotRoutes: number[] = [];
  private consecDiv = 0;

  constructor(config: LoopConfig) {
    this.config = config;
    this.settleMs = Math.max(0, config.settleMs ?? 400);
  }

  private applyOpts(): ApplyOpts {
    return { settleMs: this.settleMs, isStopped: () => this.stopAsked };
  }

  snapshot(): LoopSnapshot {
    const costs = this.timeline.map((t) => ({ flatness: t.scored.flatness, mean: t.scored.mean }));
    const flags = markPareto(costs);
    let bestIter = 0;
    let bestCost = Infinity;
    this.timeline.forEach((t, i) => {
      if (t.scored.cost < bestCost - IMPROVE_DB) {
        bestCost = t.scored.cost;
        bestIter = i;
      }
    });
    const { getCal, ...cfg } = this.config;
    void getCal;
    return {
      running: this.running,
      config: cfg,
      baseline: this.baseline,
      bestIter,
      cal: this.timeline.length ? (this.timeline[this.timeline.length - 1]!.cal ?? null) : null,
      appliedBest: this.appliedBest,
      error: this.error,
      phase: this.phase,
      screenedTotal: this.screenedTotal,
      opStats: OP_NAMES.map((name) => ({ name, ...this.opStats[name], weight: opWeight(this.opStats[name]) })),
      consistency: this.consistency,
      timeline: this.timeline.map((t, i) => ({ ...t, pareto: flags[i] ?? false })),
    };
  }

  stop(): void {
    this.stopAsked = true;
  }

  async applyIter(iter: number): Promise<void> {
    const dev = this.config.getDevice?.() ?? null;
    if (!dev) throw new Error("connect the DSP or simulator first");
    const entry = this.timeline.find((t) => t.iter === iter);
    if (!entry) throw new Error(`unknown iteration ${iter}`);
    await applyCandidate(dev, cloneCandidate(entry.candidate), this.types, this.applyOpts());
  }

  private types: number[][] = [];
  private bases: ChannelBase[] = [];

  private async measure(dev: DspDevice, c: Candidate | null): Promise<{ scored: Scored; prov: CalProvenance | null; response: TimelineEntry["response"] }> {
    if (c) await applyCandidate(dev, c, this.types, this.applyOpts());
    if (this.snapshotRoutes.length) {
      const st = await dev.refresh();
      if (st.outputs.some((o, i) => o.routingMask !== this.snapshotRoutes[i])) throw new Error("refusing to measure: DSP routing is not the snapshot matrix (leftover measurement matrix?)");
    }
    const { fStart, fLowcut, fEnd, sweepSecs, playbackId, captureId } = this.config;
    const sweep = genESS(fStart / 2, Math.min(20000, fEnd * 2), sweepSecs);
    const dir = mkdtempSync(join(tmpdir(), "subloop-"));
    const stimFile = join(dir, "stim.wav");
    const recFile = join(dir, "rec.wav");
    writeWav(stimFile, sweep);
    const tail = 1.5;
    const play = playWav(stimFile, playbackId).catch(() => ({ code: 1, out: "" }));
    await new Promise((res) => setTimeout(res, 250));
    await recordWav(recFile, sweepSecs + tail + 0.5, MEASURE_RATE, captureId);
    await play;
    const { samples } = readWav(recFile);
    const inv = inverseESS(sweep, fStart / 2, Math.min(20000, fEnd * 2), sweepSecs);
    const fr = deconvolveToFR(samples, sweep, inv);
    const grid = logGrid(20, 20000, 480);
    const interp = interpLog(fr, grid);
    const smoothed = smoothOctave(grid, interp, 1 / 12);
    const calEntry = this.config.getCal?.() ?? null;
    const corrected = applyCal(grid, smoothed, calEntry?.cal ?? null);
    const keepDir = join(process.cwd(), "recordings");
    mkdirSync(keepDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(keepDir, `loop-iter-${this.timeline.length}-${stamp}.wav`), readFileSync(recFile));
    const base = this.baseline?.mean ?? 0;
    const scored = scoreResponse(grid, corrected, fStart, fLowcut, fEnd, base);
    return { scored, prov: calEntry?.prov ?? null, response: { freqs: [...grid], db: [...corrected] } };
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopAsked = false;
    this.error = null;
    this.appliedBest = null;
    this.phase = "baseline";
    this.screenedTotal = 0;
    this.consistency = null;
    this.consecDiv = 0;
    try {
      const dev = this.config.getDevice?.() ?? null;
      if (!dev) throw new Error("connect the DSP or simulator first");
      await dev.takeSnapshot();
      const state = await dev.refresh();
      this.types = state.outputs.map((o) => o.bands.map((b) => b.type));
      this.snapshotRoutes = state.outputs.map((o) => o.routingMask);
      const start = deviceStateToCandidate(state);
      this.bases = start.bases;
      if (this.config.v2) await this.runV2(dev, start.candidate);
      else await this.runV1(dev, start.candidate);
      this.phase = "done";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
  }

  private async record(dev: DspDevice, current: Candidate, kind: string, st: { best: Candidate; bestCost: number; bestIterNum: number; bestPeaks: Peak[] }, op?: string, pred?: { j: number; f: number }): Promise<boolean> {
    const iter = this.timeline.length;
    const m = await this.measure(dev, current);
    const improved = m.scored.cost < st.bestCost - IMPROVE_DB;
    if (improved) {
      st.bestCost = m.scored.cost;
      st.best = cloneCandidate(current);
      st.bestIterNum = iter;
      st.bestPeaks = peaksOf(m.response, m.scored.mean, this.config.fStart, this.config.fEnd);
    }
    this.timeline.push({ iter, kind, candidate: cloneCandidate(current), scored: m.scored, pareto: false, cal: m.prov, response: m.response, op, predJ: pred?.j, predF: pred?.f });
    return improved;
  }

  private async runV1(dev: DspDevice, start: Candidate): Promise<void> {
    const base = await this.measure(dev, null);
    this.baseline = makeBaseline(base.scored);
    this.timeline.push({ iter: 0, kind: "baseline", candidate: cloneCandidate(start), scored: this.baseline, pareto: true, cal: base.prov, response: base.response });
    const st = { best: cloneCandidate(start), bestCost: this.baseline.cost, bestIterNum: 0, bestPeaks: peaksOf(base.response, base.scored.mean, this.config.fStart, this.config.fEnd) };
    for (let iter = 1; (this.config.maxIter <= 0 || iter <= this.config.maxIter) && !this.stopAsked; iter++) {
      const large = isLargeMutation(iter);
      await this.record(dev, mutateCandidate(st.best, this.bases, this.config.fStart, this.config.fEnd, large, st.bestPeaks), large ? "mutation" : "tweak", st);
    }
    await applyCandidate(dev, st.best, this.types, { settleMs: this.settleMs });
    this.appliedBest = st.bestIterNum;
  }

  private async warmup(dev: DspDevice): Promise<void> {
    void dev;
    const secs = Math.max(0, this.config.warmupSecs ?? 120);
    if (!secs) return;
    this.phase = "warmup";
    const { fStart, fEnd, sweepSecs, playbackId } = this.config;
    const sweep = genESS(fStart / 2, Math.min(20000, fEnd * 2), sweepSecs);
    const dir = mkdtempSync(join(tmpdir(), "subwarm-"));
    const stimFile = join(dir, "stim.wav");
    writeWav(stimFile, sweep);
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000 && !this.stopAsked) {
      await playWav(stimFile, playbackId).catch(() => undefined);
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  private paretoNew(flatness: number, mean: number): boolean {
    return !this.timeline.some((t) => t.scored.flatness <= flatness && t.scored.mean >= mean && (t.scored.flatness < flatness || t.scored.mean > mean));
  }

  private screenRound(model: SurrogateModel, st: { best: Candidate; bestPeaks: Peak[] }): { cand: Candidate; op: OpName; predJ: number; predF: number }[] {
    const budget = Math.max(100, this.config.screenBudget ?? 4000);
    const costs = this.timeline.map((t) => ({ flatness: t.scored.flatness, mean: t.scored.mean }));
    const flags = markPareto(costs);
    const ctx: OpCtx = {
      best: st.best,
      bases: this.bases,
      peaks: st.bestPeaks,
      frontier: this.timeline.filter((_, i) => flags[i]).map((t) => t.candidate),
      arrivals: arrivalSamples(model),
      fLo: this.config.fStart,
      fHi: this.config.fEnd,
    };
    const weights = OP_NAMES.map((n) => opWeight(this.opStats[n]));
    const total = weights.reduce((a, b) => a + b, 0);
    const predictor = new ScreenPredictor(model, st.best);
    const baseMean = this.baseline?.mean ?? 0;
    const scored: { cand: Candidate; op: OpName; predJ: number; predF: number; predMean: number }[] = [];
    OP_NAMES.forEach((name, i) => {
      const n = Math.max(20, Math.round((budget * (weights[i] as number)) / total));
      for (const c of OPERATORS[name](ctx, n)) {
        const snapped = snapCandidate(c);
        if (!validCandidate(snapped, this.bases, this.config.fStart, this.config.fEnd)) continue;
        const p = predictor.predict(snapped);
        const s = scorePrediction(model.grid, p.re, p.im, this.config.fStart, this.config.fLowcut, this.config.fEnd, baseMean);
        scored.push({ cand: snapped, op: name, predJ: s.cost, predF: s.flatness, predMean: s.mean });
      }
    });
    this.screenedTotal += scored.length;
    const pf = markPareto(scored.map((s) => ({ flatness: s.predF, mean: s.predMean })));
    const pool = scored.filter((_, i) => pf[i]).sort((a, b) => a.predF - b.predF);
    while (pool.length < Math.max(1, this.config.topK ?? 3) && pool.length < scored.length) {
      const rest = scored.filter((s) => !pool.includes(s)).sort((a, b) => a.predJ - b.predJ);
      if (!rest.length) break;
      pool.push(rest[0]!);
    }
    const k = Math.min(pool.length, Math.max(1, this.config.topK ?? 3));
    const picks: { cand: Candidate; op: OpName; predJ: number; predF: number }[] = [];
    for (let i = 0; i < k; i++) {
      const s = pool[Math.round((i * (pool.length - 1)) / Math.max(1, k - 1))]!;
      picks.push({ cand: s.cand, op: s.op, predJ: s.predJ, predF: s.predF });
    }
    return picks;
  }

  private async runV2(dev: DspDevice, start: Candidate): Promise<void> {
    await this.warmup(dev);
    if (this.stopAsked) return;
    this.phase = "baseline";
    const snapState = await dev.refresh();
    const base = await this.measure(dev, null);
    this.baseline = makeBaseline(base.scored);
    this.timeline.push({ iter: 0, kind: "baseline", candidate: cloneCandidate(start), scored: this.baseline, pareto: true, cal: base.prov, response: base.response });
    const st = { best: cloneCandidate(start), bestCost: this.baseline.cost, bestIterNum: 0, bestPeaks: peaksOf(base.response, base.scored.mean, this.config.fStart, this.config.fEnd) };
    const snapCand = deviceStateToCandidate(snapState).candidate;
    const maxIter = this.config.maxIter;
    const rescreenEvery = Math.max(1, this.config.rescreenEvery ?? 8);
    let model: SurrogateModel | null = null;
    let sinceSet = rescreenEvery;
    for (let measured = 0; (maxIter <= 0 || measured < maxIter) && !this.stopAsked;) {
      if (!model || sinceSet >= rescreenEvery || this.consecDiv >= 2) {
        this.phase = "perset";
        model = await measureOutputSet(dev, {
          fStart: this.config.fStart,
          fEnd: this.config.fEnd,
          sweepSecs: this.config.sweepSecs,
          playbackId: this.config.playbackId,
          captureId: this.config.captureId,
          snapshot: snapState,
          getCal: this.config.getCal,
          isStopped: () => this.stopAsked,
          tag: `v2-${this.timeline.length}`,
        });
        sinceSet = 0;
        this.consecDiv = 0;
        const p = predictCombined(model, snapCand);
        const ps = scorePrediction(model.grid, p.re, p.im, this.config.fStart, this.config.fLowcut, this.config.fEnd, this.baseline.mean);
        this.consistency = { predF: ps.flatness, measF: this.baseline.flatness };
        const lim = this.config.consistDb ?? 2;
        if (Math.abs(ps.flatness - this.baseline.flatness) > lim) throw new Error(`surrogate failed consistency: predicted F ${ps.flatness.toFixed(2)} vs measured ${this.baseline.flatness.toFixed(2)} (limit ${lim} dB)`);
      }
      this.phase = "screen";
      const picks = this.screenRound(model, st);
      this.phase = "verify";
      for (const pk of picks) {
        if (!((maxIter <= 0 || measured < maxIter) && !this.stopAsked)) break;
        const stats = this.opStats[pk.op];
        stats.tried++;
        const improved = await this.record(dev, pk.cand, `v2:${pk.op}`, st, pk.op, { j: pk.predJ, f: pk.predF });
        measured++;
        sinceSet++;
        const row = this.timeline[this.timeline.length - 1]!;
        if (Math.abs(pk.predF - row.scored.flatness) > 1) this.consecDiv++;
        else this.consecDiv = 0;
        const paretoExt = this.paretoNew(row.scored.flatness, row.scored.mean);
        if (improved || paretoExt) stats.improved++;
        if (improved || (paretoExt && row.scored.cost < st.bestCost + 2)) {
          for (let b = 0; b < 3 && (maxIter <= 0 || measured < maxIter) && !this.stopAsked; b++) {
            const landing = this.timeline[this.timeline.length - 1]!.candidate;
            const tw = mutateCandidate(landing, this.bases, this.config.fStart, this.config.fEnd, false);
            stats.tried++;
            if (await this.record(dev, tw, "basin", st, pk.op)) stats.improved++;
            measured++;
            sinceSet++;
          }
        }
      }
      if ((maxIter <= 0 || measured < maxIter) && !this.stopAsked) {
        await this.record(dev, mutateCandidate(st.best, this.bases, this.config.fStart, this.config.fEnd, false, st.bestPeaks), "tweak", st);
        measured++;
        sinceSet++;
      }
    }
    await applyCandidate(dev, st.best, this.types, { settleMs: this.settleMs });
    this.appliedBest = st.bestIterNum;
  }
}
