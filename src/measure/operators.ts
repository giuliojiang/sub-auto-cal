import { cloneCandidate, mutateCandidate, DELAY_RANGE_MS, BANDS_PER_CHANNEL, CHANNELS, type Candidate, type ChannelBase, type Peak } from "./objective.ts";

export const OP_NAMES = ["peak", "delaygrid", "align", "gain", "single", "xover", "random"] as const;
export type OpName = (typeof OP_NAMES)[number];

export interface OpStats {
  tried: number;
  improved: number;
}

export function opWeight(s: OpStats): number {
  return (s.improved + 1) / (s.tried + 2);
}

export interface OpCtx {
  best: Candidate;
  bases: ChannelBase[];
  peaks: Peak[];
  frontier: Candidate[];
  arrivals: number[];
  fLo: number;
  fHi: number;
}

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = (n: number): number => Math.floor(Math.random() * n);
const CM_MS = 1 / 34.3;

function clampChannel(next: Candidate, bases: ChannelBase[], o: number): void {
  const ch = next.channels[o]!;
  const base = bases[o]!;
  ch.gainDb = Math.max(base.gainDb - 3, Math.min(Math.min(base.gainDb, 0), ch.gainDb));
  ch.delayMs = Math.max(base.delayMs, Math.min(base.delayMs + DELAY_RANGE_MS, ch.delayMs));
  for (const b of ch.bands) {
    b.freqHz = Math.max(20, Math.min(20000, b.freqHz));
    b.gainDb = Math.max(-12, Math.min(0, b.gainDb));
    b.q = Math.max(0.4, Math.min(128, b.q));
  }
}

function opPeak(ctx: OpCtx, n: number): Candidate[] {
  if (!ctx.peaks.length) return [];
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const c = cloneCandidate(ctx.best);
    const o = pick(CHANNELS);
    const ch = c.channels[o]!;
    for (let j = 0, nb = 1 + pick(2); j < nb; j++) {
      const b = ch.bands[pick(BANDS_PER_CHANNEL)]!;
      if (Math.random() < 0.25) {
        b.gainDb = 0;
      } else {
        const pk = ctx.peaks[pick(ctx.peaks.length)]!;
        b.freqHz = Math.max(ctx.fLo, Math.min(ctx.fHi, pk.freqHz * Math.pow(2, rnd(-1 / 12, 1 / 12))));
        b.q = Math.max(0.4, Math.min(20, pk.q * Math.pow(2, rnd(-0.5, 0.5))));
        b.gainDb = -Math.min(12, pk.heightDb * rnd(0.5, 1));
      }
    }
    clampChannel(c, ctx.bases, o);
    out.push(c);
  }
  return out;
}

function opDelayGrid(ctx: OpCtx, n: number): Candidate[] {
  const out: Candidate[] = [];
  const steps = [0, 10, 20, 30, 40, 50];
  const combos: number[][] = [];
  for (const a of steps)
    for (const b of steps)
      for (const c of steps)
        for (const d of steps) combos.push([a, b, c, d]);
  for (let k = combos.length - 1; k > 0; k--) {
    const j = pick(k + 1);
    const t = combos[k]!;
    combos[k] = combos[j]!;
    combos[j] = t;
  }
  for (const offs of combos.slice(0, Math.max(Math.min(n, combos.length), 1))) {
    const cand = cloneCandidate(ctx.best);
    for (let o = 0; o < CHANNELS; o++) {
      cand.channels[o]!.delayMs = ctx.bases[o]!.delayMs + (offs[o] as number) * CM_MS;
      clampChannel(cand, ctx.bases, o);
    }
    out.push(cand);
  }
  return out;
}

function opAlign(ctx: OpCtx, n: number): Candidate[] {
  if (ctx.arrivals.length !== CHANNELS) return [];
  const mx = Math.max(...ctx.arrivals);
  const deltas = ctx.arrivals.map((a) => ((mx - a) / 48000) * 1000);
  const over = Math.max(...deltas);
  const fit = over > DELAY_RANGE_MS ? deltas.map((d) => (d / over) * DELAY_RANGE_MS) : deltas;
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const c = cloneCandidate(ctx.best);
    for (let o = 0; o < CHANNELS; o++) {
      c.channels[o]!.delayMs = ctx.bases[o]!.delayMs + (fit[o] as number) + (k ? rnd(-2, 2) * CM_MS : 0);
      clampChannel(c, ctx.bases, o);
    }
    out.push(c);
  }
  return out;
}

function opGain(ctx: OpCtx, n: number): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const c = cloneCandidate(ctx.best);
    const a = pick(CHANNELS);
    let b = pick(CHANNELS);
    if (b === a) b = (b + 1) % CHANNELS;
    const x = rnd(0.25, 1.5) * (Math.random() < 0.5 ? 1 : -1);
    c.channels[a]!.gainDb += x;
    c.channels[b]!.gainDb -= x;
    clampChannel(c, ctx.bases, a);
    clampChannel(c, ctx.bases, b);
    out.push(c);
  }
  return out;
}

function opSingle(ctx: OpCtx, n: number): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const c = cloneCandidate(ctx.best);
    const o = pick(CHANNELS);
    const b = c.channels[o]!.bands[pick(BANDS_PER_CHANNEL)]!;
    if (Math.random() < 0.2) {
      b.gainDb = 0;
    } else {
      b.freqHz = ctx.fLo * Math.pow(ctx.fHi / ctx.fLo, Math.random());
      b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, rnd(-1, 1))));
      b.gainDb = rnd(-12, 0);
    }
    clampChannel(c, ctx.bases, o);
    out.push(c);
  }
  return out;
}

function opXover(ctx: OpCtx, n: number): Candidate[] {
  if (ctx.frontier.length < 2) return [];
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    const c = cloneCandidate(ctx.best);
    const a = ctx.frontier[pick(ctx.frontier.length)]!;
    const b = ctx.frontier[pick(ctx.frontier.length)]!;
    if (Math.random() < 0.5) {
      for (let o = 0; o < CHANNELS; o++) {
        const src = Math.random() < 0.5 ? a : b;
        c.channels[o] = { bands: src.channels[o]!.bands.map((x) => ({ ...x })), gainDb: src.channels[o]!.gainDb, delayMs: src.channels[o]!.delayMs };
      }
    } else {
      for (let o = 0; o < CHANNELS; o++) {
        c.channels[o]!.delayMs = a.channels[o]!.delayMs;
        c.channels[o]!.bands = b.channels[o]!.bands.map((x) => ({ ...x }));
        c.channels[o]!.gainDb = b.channels[o]!.gainDb;
      }
    }
    for (let o = 0; o < CHANNELS; o++) clampChannel(c, ctx.bases, o);
    out.push(c);
  }
  return out;
}

function opRandom(ctx: OpCtx, n: number): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) out.push(mutateCandidate(ctx.best, ctx.bases, ctx.fLo, ctx.fHi, true, ctx.peaks));
  return out;
}

export const OPERATORS: Record<OpName, (ctx: OpCtx, n: number) => Candidate[]> = {
  peak: opPeak,
  delaygrid: opDelayGrid,
  align: opAlign,
  gain: opGain,
  single: opSingle,
  xover: opXover,
  random: opRandom,
};
