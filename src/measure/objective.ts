export const LAMBDA = 1;
export const IMPROVE_DB = 0.1;

export interface Scored {
  mean: number;
  flatness: number;
  loss: number;
  cost: number;
}

export function scoreResponse(grid: Float32Array, db: Float32Array, fStart: number, fEnd: number, baseMean: number): Scored {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    if (f >= fStart && f <= fEnd) {
      sum += db[i] as number;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  let sq = 0;
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    if (f >= fStart && f <= fEnd) {
      const d = (db[i] as number) - mean;
      sq += d * d;
    }
  }
  const flatness = n ? Math.sqrt(sq / n) : 0;
  const loss = baseMean - mean;
  return { mean, flatness, loss, cost: flatness + LAMBDA * loss };
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

export interface Candidate {
  bands: { freqHz: number; q: number; gainDb: number }[];
  gainDb: number;
}

export function validCandidate(c: Candidate, fLo: number, fHi: number): boolean {
  if (c.bands.length > 2) return false;
  if (c.gainDb > 0 || c.gainDb < -3) return false;
  for (const b of c.bands) {
    if (b.gainDb > 0 || b.gainDb < -12) return false;
    if (b.freqHz < fLo || b.freqHz > fHi) return false;
    if (b.q < 0.4 || b.q > 128) return false;
  }
  for (let i = 0; i < c.bands.length; i++)
    for (let j = i + 1; j < c.bands.length; j++)
      if (Math.abs(Math.log2(c.bands[i]!.freqHz / c.bands[j]!.freqHz)) < 1 / 6) return false;
  return true;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export function initialCandidate(peaks: Peak[], fLo: number, fHi: number): Candidate {
  const bands = peaks.slice(0, 2).map((p) => ({
    freqHz: Math.max(fLo, Math.min(fHi, p.freqHz)),
    q: Math.max(0.5, Math.min(10, p.q)),
    gainDb: Math.max(-12, -p.heightDb),
  }));
  return { bands, gainDb: 0 };
}

export function mutateCandidate(c: Candidate, fLo: number, fHi: number, large: boolean): Candidate {
  for (let tries = 0; tries < 50; tries++) {
    const next: Candidate = { bands: c.bands.map((b) => ({ ...b })), gainDb: c.gainDb };
    const step = (span: number) => (large ? rnd(-span, span) : rnd(-span / 4, span / 4));
    if (large) {
      for (const b of next.bands) {
        b.freqHz *= Math.pow(2, rnd(-0.7, 0.7));
        b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, rnd(-1, 1))));
        b.gainDb += rnd(-6, 6);
      }
      next.gainDb += rnd(-1.5, 1.5);
    } else {
      const roll = Math.random();
      if (roll < 0.55 && next.bands.length) {
        const b = next.bands[Math.floor(Math.random() * next.bands.length)]!;
        const k = Math.random();
        if (k < 0.4) b.freqHz *= Math.pow(2, step(0.15));
        else if (k < 0.7) b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, step(0.5))));
        else b.gainDb += step(3);
      } else if (roll < 0.75) {
        next.gainDb += step(1);
      } else if (next.bands.length) {
        const b = next.bands[Math.floor(Math.random() * next.bands.length)]!;
        b.freqHz *= Math.pow(2, step(0.1));
        b.q = Math.max(0.4, Math.min(20, b.q * Math.pow(2, step(0.3))));
        b.gainDb += step(2);
      }
    }
    for (const b of next.bands) {
      b.freqHz = Math.max(fLo, Math.min(fHi, b.freqHz));
      b.gainDb = Math.max(-12, Math.min(0, b.gainDb));
    }
    next.gainDb = Math.max(-3, Math.min(0, next.gainDb));
    if (validCandidate(next, fLo, fHi)) return next;
  }
  return { bands: c.bands.map((b) => ({ ...b })), gainDb: c.gainDb };
}
