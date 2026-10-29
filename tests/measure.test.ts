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
  deviceStateToCandidate,
  targetCurve,
} from "../src/measure/objective.ts";
import {
  parseMicCal,
  calCorrection,
  applyCal,
  dbfsToSpl,
} from "../src/measure/miccal.ts";

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
    const s = scoreResponse(grid, flat, 100, 100, 8000, -20);
    assert.equal(s.flatness, 0);
    assert.equal(s.loss, 0);
    assert.equal(s.cost, 0);
  });

  it("uniform level shift changes loss and cost but not flatness", () => {
    const down = new Float32Array(100).fill(-22);
    const s = scoreResponse(grid, down, 100, 100, 8000, -20);
    assert.equal(s.flatness, 0);
    assert.equal(s.loss, 2);
    assert.equal(s.cost, 2);
  });

  it("target is flat above lowcut and falls 12dB per octave below", () => {
    assert.equal(targetCurve(400, 400), 0);
    assert.equal(targetCurve(8000, 400), 0);
    assert.equal(targetCurve(200, 400), -12);
    assert.equal(targetCurve(100, 400), -24);
    assert.equal(targetCurve(50, 400), -36);
  });

  it("response following the shaped target scores F=0", () => {
    const g = logGrid(100, 8000, 200);
    const shaped = Float32Array.from(g, (f) => -20 + targetCurve(f as number, 400));
    const s = scoreResponse(g, shaped, 100, 400, 8000, -20);
    assert.ok(s.flatness < 1e-5, `F=${s.flatness}`);
    assert.ok(Math.abs(s.cost - s.loss) < 1e-5);
  });

  it("flat response scores shape error against a declining target", () => {
    const s = scoreResponse(grid, flat, 100, 400, 8000, -20);
    assert.ok(s.flatness > 1, `F=${s.flatness}`);
  });

  it("uniform shift under a shaped target changes loss but not flatness", () => {
    const g = logGrid(100, 8000, 100);
    const base = Float32Array.from(g, (f) => -20 + targetCurve(f as number, 400));
    const down = Float32Array.from(base, (v) => v - 2);
    const s0 = scoreResponse(g, base, 100, 400, 8000, -20);
    const s1 = scoreResponse(g, down, 100, 400, 8000, -20);
    assert.ok(Math.abs(s1.flatness - s0.flatness) < 1e-5);
    assert.ok(Math.abs(s1.loss - s0.loss - 2) < 1e-5);
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
    const raw = scoreResponse(fine, spiky, 100, 150, 8000, -20);
    const sm = smoothOctave(fine, spiky, 1 / 12);
    const ssm = scoreResponse(fine, sm, 100, 150, 8000, -20);
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
    assert.ok(Math.abs(Math.log2(peaks[0]!.freqHz / peaks[1]!.freqHz)) >= 1 / 6);
  });
});

describe("umik calibration file", () => {
  const good = `"Sens Factor =-7.062dB, SERNO: 7001870"\n10.054\t-6.5726\n20.0\t-2.0\n50.0\t-1.0\n100.0\t0.0\n1000.0\t1.0\n10000.0\t2.0\n20000.0\t3.0\n`;
  it("parses header, rows, and tabs", () => {
    const { cal, warnings } = parseMicCal(good, "7001870.txt");
    assert.equal(cal.sensDb, -7.062);
    assert.equal(cal.serial, "7001870");
    assert.equal(warnings.length, 0);
    assert.equal(cal.freqs.length, 7);
    const three = parseMicCal(`"Sens Factor =0dB, SERNO: 1"\n20 1.0 0.5\n` + Array.from({ length: 10 }, (_, i) => `${100 * (i + 1)} 1.0 0.0`).join("\n") + `\n20000 0.0 0.0\n`, "3col.txt");
    assert.equal(three.cal.freqs.length, 12);
  });
  it("warns on serial mismatch instead of failing", () => {
    const { warnings } = parseMicCal(good, "7001870.txt", "7009999");
    assert.equal(warnings.length, 1);
  });
  it("rejects malformed, non-monotonic, and truncated files", () => {
    assert.throws(() => parseMicCal("10\t1.0\n20\t2.0\n", "x.txt"), /sensitivity header/);
    assert.throws(() => parseMicCal(`"Sens Factor =0dB, SERNO: 1"\n20\t1.0\n10\t2.0\n30\t3.0\n40\t4.0\n50\t5.0\n60\t6.0\n70\t7.0\n80\t8.0\n90\t9.0\n100\t10.0\n20000\t0.0\n`, "x.txt"), /not increasing/);
    assert.throws(() => parseMicCal(`"Sens Factor =0dB, SERNO: 1"\n100\t1.0\n200\t2.0\n`, "x.txt"), /truncated/);
    assert.throws(() => parseMicCal(`"Sens Factor =0dB, SERNO: 1"\n100\t1.0\n200\t2.0\n300\t3.0\n400\t4.0\n500\t5.0\n600\t6.0\n700\t7.0\n800\t8.0\n900\t9.0\n1000\t1.0\n1100\t1.0\n`, "x.txt"), /roughly 20Hz/);
  });
  it("interpolates on log axis, clamps ends, subtracts correction", () => {
    const { cal } = parseMicCal(good, "7001870.txt");
    assert.equal(calCorrection(cal, 100), 0);
    assert.ok(Math.abs(calCorrection(cal, 5) - -6.5726) < 1e-4);
    assert.ok(Math.abs(calCorrection(cal, 30000) - 3.0) < 1e-6);
    const gm = Math.sqrt(100 * 1000);
    assert.ok(Math.abs(calCorrection(cal, gm) - 0.5) < 0.01);
    const out = applyCal(new Float32Array([100, 1000]), new Float32Array([0, 0]), cal);
    assert.deepEqual([...out], [0, -1]);
    assert.deepEqual([...applyCal(new Float32Array([100]), new Float32Array([5]), null)], [5]);
  });
  it("derives SPL from the sensitivity factor", () => {
    assert.ok(Math.abs(dbfsToSpl(-7.062, -7.062) - 94) < 1e-9);
  });
});

describe("resume invariants", () => {
  const loaded = {
    outputs: [0, 1, 2, 3].map(() => ({
      bands: Array.from({ length: 7 }, (_, i) => ({ freqHz: 100 * Math.pow(2, i), q: 1, gainDb: i < 2 ? -3 : 0 })),
      gainDb: -1,
      delayMs: 2,
    })),
  };

  it("device state maps to a valid starting candidate", () => {
    const { candidate, bases } = deviceStateToCandidate(loaded);
    assert.equal(candidate.channels.length, 4);
    assert.equal(candidate.channels[0]!.bands.length, 7);
    assert.ok(validCandidate(candidate, bases, 100, 8000));
    assert.equal(bases[0]!.gainDb, -1);
    assert.equal(bases[0]!.delayMs, 2);
  });

  it("mutations never boost, crowd audible cuts, or leave device ranges", () => {
    const { candidate, bases } = deviceStateToCandidate(loaded);
    for (let i = 0; i < 300; i++) {
      for (const large of [false, true]) {
        const c = mutateCandidate(candidate, bases, 100, 8000, large);
        assert.ok(validCandidate(c, bases, 100, 8000), JSON.stringify(c));
        for (let o = 0; o < 4; o++) {
          const ch = c.channels[o]!;
          assert.ok(ch.gainDb <= 0 && ch.gainDb >= -4, `gain ${ch.gainDb}`);
          assert.ok(ch.delayMs >= 2 && ch.delayMs <= 3.47, `delay ${ch.delayMs}`);
          assert.equal(ch.bands.length, 7);
          for (const b of ch.bands) assert.ok(b.gainDb <= 0, `band ${b.gainDb}`);
        }
      }
    }
  });

  it("mutations leave the input candidate untouched, so best is never corrupted", () => {
    const { candidate, bases } = deviceStateToCandidate(loaded);
    const before = JSON.stringify(candidate);
    for (let i = 0; i < 50; i++) {
      for (const large of [false, true]) mutateCandidate(candidate, bases, 100, 8000, large);
    }
    assert.equal(JSON.stringify(candidate), before);
  });

  it("rejects boosts, stacked audible cuts, and out-of-range moves", () => {
    const { candidate, bases } = deviceStateToCandidate(loaded);
    const copy = () => JSON.parse(JSON.stringify(candidate));
    const boosted = copy();
    boosted.channels[0]!.bands[0]!.gainDb = 1;
    assert.equal(validCandidate(boosted, bases, 100, 8000), false);
    const stacked = copy();
    stacked.channels[1]!.bands[0]!.gainDb = -6;
    stacked.channels[1]!.bands[1]!.gainDb = -6;
    stacked.channels[1]!.bands[1]!.freqHz = stacked.channels[1]!.bands[0]!.freqHz;
    assert.equal(validCandidate(stacked, bases, 100, 8000), false);
    const loud = copy();
    loud.channels[2]!.gainDb = 0.5;
    assert.equal(validCandidate(loud, bases, 100, 8000), false);
    const late = copy();
    late.channels[3]!.delayMs = 10;
    assert.equal(validCandidate(late, bases, 100, 8000), false);
    const short = copy();
    short.channels.pop();
    assert.equal(validCandidate(short, bases, 100, 8000), false);
  });
});
