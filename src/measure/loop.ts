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
  applyBiquads,
  MEASURE_RATE,
} from "./sweep.ts";
import {
  scoreResponse,
  markPareto,
  findPeaks,
  initialCandidate,
  mutateCandidate,
  IMPROVE_DB,
  type Candidate,
  type Scored,
} from "./objective.ts";
import { applyCal, type MicCal, type CalProvenance } from "./miccal.ts";

export interface LoopConfig {
  fStart: number;
  fEnd: number;
  sweepSecs: number;
  maxIter: number;
  playbackId?: string;
  captureId?: string;
  getCal?: () => { cal: MicCal; prov: CalProvenance } | null;
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

  private async measure(c: Candidate): Promise<{ scored: Scored; prov: CalProvenance | null; response: TimelineEntry["response"] }> {
    const { fStart, fEnd, sweepSecs, playbackId, captureId } = this.config;
    const sweep = genESS(fStart / 2, Math.min(20000, fEnd * 2), sweepSecs);
    const stim = applyBiquads(sweep, c.bands, c.gainDb);
    const dir = mkdtempSync(join(tmpdir(), "subloop-"));
    const stimFile = join(dir, "stim.wav");
    const recFile = join(dir, "rec.wav");
    writeWav(stimFile, stim);
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
      const base = await this.measure({ bands: [], gainDb: 0 });
      this.baseline = { ...base.scored, loss: 0, cost: base.scored.flatness };
      this.timeline.push({ iter: 0, kind: "baseline", candidate: { bands: [], gainDb: 0 }, scored: this.baseline, pareto: true, cal: base.prov, response: base.response });
      const grid = Float32Array.from(base.response.freqs);
      const db = Float32Array.from(base.response.db);
      const first = initialCandidate(findPeaks(grid, db, this.config.fStart, this.config.fEnd, this.baseline.mean), this.config.fStart, this.config.fEnd);
      let best: Candidate = { bands: [], gainDb: 0 };
      let bestCost = this.baseline.cost;
      for (let iter = 1; (this.config.maxIter <= 0 || iter <= this.config.maxIter) && !this.stopAsked; iter++) {
        const large = iter % 4 === 0;
        const current = iter === 1 ? first : mutateCandidate(best, this.config.fStart, this.config.fEnd, large);
        const m = await this.measure(current);
        if (m.scored.cost < bestCost - IMPROVE_DB) {
          bestCost = m.scored.cost;
          best = JSON.parse(JSON.stringify(current));
        }
        this.timeline.push({ iter, kind: large ? "mutation" : iter === 1 ? "initial" : "tweak", candidate: JSON.parse(JSON.stringify(current)), scored: m.scored, pareto: false, cal: m.prov, response: m.response });
      }
    } finally {
      this.running = false;
    }
  }
}
