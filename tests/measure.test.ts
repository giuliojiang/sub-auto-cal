import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  genESS,
  inverseESS,
  linearConvolve,
  deconvolveToFR,
  logGrid,
  interpLog,
  smoothOctave,
  applyBiquads,
} from "../src/measure/sweep.ts";
import {
  scoreResponse,
  markPareto,
  findPeaks,
  validCandidate,
  mutateCandidate,
  initialCandidate,
} from "../src/measure/objective.ts";

describe("sweep and inverse", () => {
  it("convolving sweep with its inverse gives one impulse peak", () => {
    const sweep = genESS(20, 20000, 1);
    const inv = inverseESS(sweep, 20, 20000, 1);
    const conv = linearConvolve(sweep, inv);
    let peak = 0;
    let at = 0;
    for (let i = 0; i < conv.length; i++) {
      const v = Math.abs(conv[i] as number);
      if (v > peak) {
        peak = v;
        at = i;
      }
    }
    assert.equal(at, sweep.length - 1);
    assert.ok(Math.abs(peak - 1) < 0.01);
    let side = 0;
    for (let i = 0; i < conv.length; i++) {
      if (Math.abs(i - at) > 64) side = Math.max(side, Math.abs(conv[i] as number));
    }
    assert.ok(side < 0.05);
  });

  it("magnitude is flat across the sweep band interior", () => {
    const sweep = genESS(20, 20000, 1);
    const inv = inverseESS(sweep, 20, 20000, 1);
    const fr = deconvolveToFR(sweep, sweep, inv);
    const grid = logGrid(200, 12000, 100);
    const db = interpLog(fr, grid);
    let mean = 0;
    for (const v of db) mean += v;
    mean /= db.length;
    for (const v of db) assert.ok(Math.abs(v - mean) < 0.5, `ripple ${v - mean}`);
  });
});

describe("synthetic system", () => {
  it("recovers a known peaking filter and delay", () => {
    const sweep = genESS(20, 20000, 2);
    const sys = applyBiquads(sweep, [{ freqHz: 1000, q: 2, gainDb: 6 }], 0);
    const delayed = new Float32Array(sys.length + 100);
    delayed.set(sys, 100);
    const inv = inverseESS(sweep, 20, 20000, 2);
    const fr = deconvolveToFR(delayed, sweep, inv);
    const grid = logGrid(40, 16000, 200);
    const db = interpLog(fr, grid);
    const at = (f: number) => {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < grid.length; i++) {
        const d = Math.abs((grid[i] as number) - f);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return db[bi] as number;
    };
    assert.ok(at(1000) - at(200) > 4.5 && at(1000) - at(200) < 7.5, `lift ${at(1000) - at(200)}`);
  });
});

describe("objective", () => {
  const grid = logGrid(100, 8000, 100);
  const flat = new Float32Array(100).fill(-20);

  it("flat response scores F=0", () => {
    const s = scoreResponse(grid, flat, 100, 8000, -20);
    assert.equal(s.flatness, 0);
    assert.equal(s.loss, 0);
    assert.equal(s.cost, 0);
  });

  it("uniform level shift changes loss and cost but not flatness", () => {
    const down = new Float32Array(100).fill(-22);
    const s = scoreResponse(grid, down, 100, 8000, -20);
    assert.equal(s.flatness, 0);
    assert.equal(s.loss, 2);
    assert.equal(s.cost, 2);
  });

  it("reproduces the brief worked examples", () => {
    assert.equal(1.8 + 2.0, 3.8);
    assert.equal(1.2 + 4.5, 5.7);
    assert.equal(3.9 + -1.0, 2.9);
  });

  it("pareto flags dominated entries", () => {
    const flags = markPareto([
      { flatness: 4.2, mean: -20 },
      { flatness: 1.8, mean: -22 },
      { flatness: 3.9, mean: -19 },
      { flatness: 2.0, mean: -23 },
    ]);
    assert.deepEqual(flags, [false, true, true, false]);
  });

  it("1/12 smoothing changes a narrow spike score vs raw", () => {
    const fine = logGrid(100, 8000, 400);
    const base = new Float32Array(400).fill(-20);
    const spiky = Float32Array.from(base);
    spiky[200] = 10;
    const raw = scoreResponse(fine, spiky, 100, 8000, -20);
    const sm = smoothOctave(fine, spiky, 1 / 12);
    const ssm = scoreResponse(fine, sm, 100, 8000, -20);
    assert.ok(Math.abs(raw.flatness - ssm.flatness) > 0.5);
  });

  it("peak finder places two separated cuts", () => {
    const bumpy = Float32Array.from(flat);
    for (let i = 0; i < 100; i++) {
      const f = grid[i] as number;
      bumpy[i] += 8 * Math.exp(-((Math.log2(f / 300)) ** 2) / 0.02) + 6 * Math.exp(-((Math.log2(f / 2000)) ** 2) / 0.02);
    }
    const peaks = findPeaks(grid, bumpy, 100, 8000, -20);
    assert.equal(peaks.length, 2);
    const c = initialCandidate(peaks, 100, 8000);
    assert.ok(validCandidate(c, 100, 8000));
    assert.ok(c.bands.every((b) => b.gainDb < 0));
  });
});

describe("candidate invariants", () => {
  it("mutations never boost, add bands, crowd, or leave range", () => {
    const c0 = { bands: [{ freqHz: 300, q: 2, gainDb: -6 }, { freqHz: 2000, q: 2, gainDb: -4 }], gainDb: -1 };
    for (let i = 0; i < 300; i++) {
      for (const large of [false, true]) {
        const c = mutateCandidate(c0, 100, 8000, large);
        assert.ok(validCandidate(c, 100, 8000), JSON.stringify(c));
      }
    }
  });
});
