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
  IMPROVE_DB,
  type Candidate,
  type ChannelBase,
  type Scored,
} from "./objective.ts";
import { applyCal, type MicCal, type CalProvenance } from "./miccal.ts";
import type { DspDevice } from "../dsp/device.ts";

export interface LoopConfig {
  fStart: number;
  fEnd: number;
  sweepSecs: number;
  maxIter: number;
  playbackId?: string;
  captureId?: string;
  getCal?: () => { cal: MicCal; prov: CalProvenance } | null;
  getDevice?: () => DspDevice | null;
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
  cal: CalProvenance | null;
}

export class LoopRunner {
  running = false;
  timeline: TimelineEntry[] = [];
  baseline: Scored | null = null;
  private stopAsked = false;
  config: LoopConfig;

  constructor(config: LoopConfig) {
    this.config = config;
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
      timeline: this.timeline.map((t, i) => ({ ...t, pareto: flags[i] ?? false })),
    };
  }

  stop(): void {
    this.stopAsked = true;
  }

  private types: number[][] = [];
  private bases: ChannelBase[] = [];

  private async pushCandidate(dev: DspDevice, c: Candidate): Promise<void> {
    for (let o = 0; o < 4; o++) {
      const ch = c.channels[o]!;
      const chan = 4 + o;
      await dev.setGain(chan, ch.gainDb);
      await dev.setDelay(chan, ch.delayMs);
      for (let b = 0; b < 7; b++) {
        const band = ch.bands[b]!;
        await dev.setPeq(chan, b, { freqHz: band.freqHz, q: band.q, gainDb: band.gainDb, type: this.types[o]![b] ?? 0, bypass: false });
      }
    }
  }

  private async measure(dev: DspDevice, c: Candidate | null): Promise<{ scored: Scored; prov: CalProvenance | null; response: TimelineEntry["response"] }> {
    if (c) await this.pushCandidate(dev, c);
    const { fStart, fEnd, sweepSecs, playbackId, captureId } = this.config;
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
    const scored = scoreResponse(grid, corrected, fStart, fEnd, base);
    return { scored, prov: calEntry?.prov ?? null, response: { freqs: [...grid], db: [...corrected] } };
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopAsked = false;
    try {
      const dev = this.config.getDevice?.() ?? null;
      if (!dev) throw new Error("connect the DSP or simulator first");
      await dev.takeSnapshot();
      const state = await dev.refresh();
      this.types = state.outputs.map((o) => o.bands.map((b) => b.type));
      const start = deviceStateToCandidate(state);
      this.bases = start.bases;
      const base = await this.measure(dev, null);
      this.baseline = { ...base.scored, loss: 0, cost: base.scored.flatness };
      this.timeline.push({ iter: 0, kind: "baseline", candidate: start.candidate, scored: this.baseline, pareto: true, cal: base.prov, response: base.response });
      let best: Candidate = cloneCandidate(start.candidate);
      let bestCost = this.baseline.cost;
      for (let iter = 1; (this.config.maxIter <= 0 || iter <= this.config.maxIter) && !this.stopAsked; iter++) {
        const large = iter % 4 === 0;
        const current = mutateCandidate(best, this.bases, this.config.fStart, this.config.fEnd, large);
        const m = await this.measure(dev, current);
        if (m.scored.cost < bestCost - IMPROVE_DB) {
          bestCost = m.scored.cost;
          best = cloneCandidate(current);
        }
        this.timeline.push({ iter, kind: large ? "mutation" : "tweak", candidate: cloneCandidate(current), scored: m.scored, pareto: false, cal: m.prov, response: m.response });
      }
    } finally {
      this.running = false;
    }
  }
}
