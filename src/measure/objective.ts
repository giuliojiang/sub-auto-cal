export const FLATNESS_WEIGHT = 2;
export const SPL_WEIGHT = 1;
export const IMPROVE_DB = 0.05;

export interface Scored {
  mean: number;
  flatness: number;
  loss: number;
  cost: number;
}

export function targetCurve(f: number, fLowcut: number): number {
  if (f >= fLowcut) return 0;
  return -12 * Math.log2(fLowcut / Math.max(1e-9, f));
}

export function scoreResponse(grid: Float32Array, db: Float32Array, fStart: number, fLowcut: number, fEnd: number, baseMean: number): Scored {
  let sum = 0;
  let sumT = 0;
  let n = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    if (f >= fStart && f <= fEnd) {
      sum += db[i] as number;
      sumT += targetCurve(f, fLowcut);
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const meanErr = n ? (sum - sumT) / n : 0;
  let sq = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    if (f >= fStart && f <= fEnd) {
      const d = (db[i] as number) - targetCurve(f, fLowcut) - meanErr;
      sq += d * d;
    }
  }
  const flatness = n ? Math.sqrt(sq / n) : 0;
  const loss = baseMean - mean;
  return { mean, flatness, loss, cost: FLATNESS_WEIGHT * flatness + SPL_WEIGHT * loss };
}

export function markPareto(costs: { flatness: number; mean: number }[]): boolean[] {
  return costs.map((c, i) =>
    !costs.some((o, j) => j !== i && o.flatness <= c.flatness && o.mean >= c.mean && (o.flatness < c.flatness || o.mean > c.mean)),
  );
}

export interface Peak {
  freqHz: number;
  heightDb: number;
  q: number;
}

export function findPeaks(grid: Float32Array, db: Float32Array, fStart: number, fEnd: number, mean: number): Peak[] {
  const peaks: Peak[] = [];
  for (let i = 1; i < db.length - 1; i++) {
    const f = grid[i] as number;
    if (f < fStart || f > fEnd) continue;
    const v = db[i] as number;
    if (v > (db[i - 1] as number) && v >= (db[i + 1] as number) && v > mean + 1) {
      let lo = i;
      while (lo > 0 && (db[lo] as number) > v - 3 && (grid[lo] as number) >= fStart) lo--;
      let hi = i;
      while (hi < db.length - 1 && (db[hi] as number) > v - 3 && (grid[hi] as number) <= fEnd) hi++;
      const widthOct = Math.log2((grid[hi] as number) / Math.max(1e-9, grid[lo] as number));
      peaks.push({ freqHz: f, heightDb: v - mean, q: Math.max(0.5, Math.min(10, 1.2 / Math.max(0.1, widthOct))) });
    }
  }
  peaks.sort((a, b) => b.heightDb - a.heightDb);
  const picked: Peak[] = [];
  for (const p of peaks) {
    if (picked.every((q) => Math.abs(Math.log2(p.freqHz / q.freqHz)) >= 1 / 6)) picked.push(p);
    if (picked.length >= 2) break;
  }
  return picked;
}

export const DELAY_RANGE_MS = 1.46;
export const BANDS_PER_CHANNEL = 7;
export const CHANNELS = 4;

export interface OptBand {
  freqHz: number;
  q: number;
  gainDb: number;
}

export interface OptChannel {
  bands: OptBand[];
  gainDb: number;
  delayMs: number;
}

export interface Candidate {
  channels: OptChannel[];
}

export interface ChannelBase {
  gainDb: number;
  delayMs: number;
}

export interface DeviceSnapshot {
  outputs: { bands: { freqHz: number; q: number; gainDb: number }[]; gainDb: number; delayMs: number }[];
}

export function deviceStateToCandidate(s: DeviceSnapshot): { candidate: Candidate; bases: ChannelBase[] } {
  const channels = s.outputs.slice(0, CHANNELS).map((o) => ({
    bands: o.bands.slice(0, BANDS_PER_CHANNEL).map((b) => ({ freqHz: b.freqHz, q: b.q, gainDb: b.gainDb })),
    gainDb: o.gainDb,
    delayMs: o.delayMs,
  }));
  const bases = channels.map((c) => ({ gainDb: c.gainDb, delayMs: c.delayMs }));
  return { candidate: { channels }, bases };
}

export function cloneCandidate(c: Candidate): Candidate {
  return { channels: c.channels.map((ch) => ({ bands: ch.bands.map((b) => ({ ...b })), gainDb: ch.gainDb, delayMs: ch.delayMs })) };
}

export function validCandidate(c: Candidate, bases: ChannelBase[], _fLo: number, _fHi: number): boolean {
  void _fLo;
  void _fHi;
  if (c.channels.length !== CHANNELS || bases.length !== CHANNELS) return false;
  for (let o = 0; o < CHANNELS; o++) {
    const ch = c.channels[o]!;
    const base = bases[o]!;
    if (ch.bands.length !== BANDS_PER_CHANNEL) return false;
    if (ch.gainDb > Math.min(base.gainDb, 0) + 1e-9 || ch.gainDb < base.gainDb - 3 - 1e-9) return false;
    if (ch.delayMs < base.delayMs - 1e-9 || ch.delayMs > base.delayMs + DELAY_RANGE_MS + 1e-9) return false;
    for (const b of ch.bands) {
      if (b.gainDb > 0 || b.gainDb < -12) return false;
      if (!(b.freqHz >= 20 && b.freqHz <= 20000)) return false;
      if (b.q < 0.4 || b.q > 128) return false;
    }
    const audible = ch.bands.filter((b) => b.gainDb < -0.5);
    for (let i = 0; i < audible.length; i++)
      for (let j = i + 1; j < audible.length; j++)
        if (Math.abs(Math.log2(audible[i]!.freqHz / audible[j]!.freqHz)) < 1 / 6) return false;
  }
  return true;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = (n: number) => Math.floor(Math.random() * n);

export function mutateCandidate(c: Candidate, bases: ChannelBase[], fLo: number, fHi: number, large: boolean): Candidate {
  for (let tries = 0; tries < 50; tries++) {
    const next = cloneCandidate(c);
    const step = (span: number) => (large ? rnd(-span, span) : rnd(-span / 4, span / 4));
    const clampChannel = (o: number) => {
      const ch = next.channels[o]!;
      const base = bases[o]!;
      ch.gainDb = Math.max(base.gainDb - 3, Math.min(Math.min(base.gainDb, 0), ch.gainDb));
      ch.delayMs = Math.max(base.delayMs, Math.min(base.delayMs + DELAY_RANGE_MS, ch.delayMs));
      for (const b of ch.bands) {
        b.freqHz = Math.max(20, Math.min(20000, b.freqHz));
        b.gainDb = Math.max(-12, Math.min(0, b.gainDb));
        b.q = Math.max(0.4, Math.min(128, b.q));
      }
    };
    if (large) {
      const count = 1 + pick(2);
      const done = new Set<number>();
      while (done.size < count) {
        const o = pick(CHANNELS);
        if (done.has(o)) continue;
        done.add(o);
        const ch = next.channels[o]!;
        const nBands = 2 + pick(3);
        for (let k = 0; k < nBands; k++) {
          const b = ch.bands[pick(BANDS_PER_CHANNEL)]!;
          if (Math.random() < 0.25) {
            b.gainDb = 0;
          } else {
            b.freqHz = fLo * Math.pow(fHi / fLo, Math.random());
            b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, rnd(-1, 1))));
            b.gainDb = rnd(-12, 0);
          }
        }
        ch.gainDb += rnd(-1.5, 1.5);
        ch.delayMs += rnd(0, DELAY_RANGE_MS);
        clampChannel(o);
      }
    } else {
      const o = pick(CHANNELS);
      const ch = next.channels[o]!;
      const roll = Math.random();
      if (roll < 0.55) {
        const b = ch.bands[pick(BANDS_PER_CHANNEL)]!;
        const k = Math.random();
        if (k < 0.4) b.freqHz = Math.max(fLo, Math.min(fHi, b.freqHz * Math.pow(2, step(0.15))));
        else if (k < 0.7) b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, step(0.5))));
        else b.gainDb += step(3);
      } else if (roll < 0.75) {
        ch.gainDb += step(1);
      } else {
        ch.delayMs += step(0.5);
      }
      clampChannel(o);
    }
    if (validCandidate(next, bases, fLo, fHi)) return next;
  }
  return cloneCandidate(c);
}
