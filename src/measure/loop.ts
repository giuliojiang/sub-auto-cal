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
}

export class LoopRunner {
  running = false;
  timeline: TimelineEntry[] = [];
  baseline: Scored | null = null;
  appliedBest: number | null = null;
  error: string | null = null;
  private stopAsked = false;
  config: LoopConfig;
  private settleMs: number;

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
    try {
      const dev = this.config.getDevice?.() ?? null;
      if (!dev) throw new Error("connect the DSP or simulator first");
      await dev.takeSnapshot();
      const state = await dev.refresh();
      this.types = state.outputs.map((o) => o.bands.map((b) => b.type));
      const start = deviceStateToCandidate(state);
      this.bases = start.bases;
      const base = await this.measure(dev, null);
      this.baseline = makeBaseline(base.scored);
      this.timeline.push({ iter: 0, kind: "baseline", candidate: start.candidate, scored: this.baseline, pareto: true, cal: base.prov, response: base.response });
      let best: Candidate = cloneCandidate(start.candidate);
      let bestCost = this.baseline.cost;
      let bestIterNum = 0;
      let bestPeaks = peaksOf(base.response, base.scored.mean, this.config.fStart, this.config.fEnd);
      for (let iter = 1; (this.config.maxIter <= 0 || iter <= this.config.maxIter) && !this.stopAsked; iter++) {
        const large = isLargeMutation(iter);
        const current = mutateCandidate(best, this.bases, this.config.fStart, this.config.fEnd, large, bestPeaks);
        const m = await this.measure(dev, current);
        if (m.scored.cost < bestCost - IMPROVE_DB) {
          bestCost = m.scored.cost;
          best = cloneCandidate(current);
          bestIterNum = iter;
          bestPeaks = peaksOf(m.response, m.scored.mean, this.config.fStart, this.config.fEnd);
        }
        this.timeline.push({ iter, kind: large ? "mutation" : "tweak", candidate: cloneCandidate(current), scored: m.scored, pareto: false, cal: m.prov, response: m.response });
      }
      await applyCandidate(dev, best, this.types, { settleMs: this.settleMs });
      this.appliedBest = bestIterNum;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
  }
}
