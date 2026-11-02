import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logGrid, smoothOctave } from "../src/measure/sweep.ts";
import {
  YAMAHA_FREQS,
  YAMAHA_QS,
  yamahaTarget,
  anchorTarget,
  generateCandidates,
  validYamahaBands,
  maxCombinedBoost,
  uncorrectedScore,
  scorePrediction,
  predictCurve,
  throwOnSerialMismatch,
  zeroMeanOverFit,
  stereoStimulus,
  STRATEGIES,
} from "../src/measure/yamaha.ts";
import { parseMicCal } from "../src/measure/miccal.ts";
import { renderYamahaViewer } from "../src/measure/yamaha-viewer.ts";

function syntheticMeasured(grid: Float32Array): Float32Array {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    let v = -20;
    v += 7 * Math.exp(-Math.pow(Math.log2(f / 55), 2) / 0.08);
    v += 5 * Math.exp(-Math.pow(Math.log2(f / 180), 2) / 0.05);
    out[i] = v;
  }
  return out;
}

describe("yamaha target", () => {
  it("matches the specified check values", () => {
    assert.ok(Math.abs(yamahaTarget(1000) - 0) < 1e-9);
    assert.ok(Math.abs(yamahaTarget(100) - 3.32) < 0.05);
    assert.ok(Math.abs(yamahaTarget(20000) - -8.64) < 0.05);
    assert.ok(Math.abs(yamahaTarget(40) - -8.36) < 0.05);
    assert.ok(Math.abs(yamahaTarget(80) - 3.64) < 0.05);
    assert.ok(Math.abs(yamahaTarget(2000) - -2) < 0.05);
    assert.ok(Math.abs(yamahaTarget(10000) - -6.64) < 0.05);
  });
});

describe("yamaha grids", () => {
  it("has 31 frequencies and 14 Q values", () => {
    assert.equal(YAMAHA_FREQS.length, 31);
    assert.equal(YAMAHA_QS.length, 14);
    assert.ok(YAMAHA_FREQS.includes(1000));
    assert.ok(YAMAHA_FREQS.includes(16000));
    assert.ok(YAMAHA_QS.includes(1.0));
  });
});

describe("yamaha serial", () => {
  it("rejects a mismatched serial", () => {
    const text = `"Sens Factor =0dB, SERNO: 111"\n20 0\n30 0\n40 0\n50 0\n60 0\n70 0\n80 0\n90 0\n100 0\n20000 0\n`;
    const { warnings } = parseMicCal(text, "111.txt", "999");
    assert.equal(warnings.length, 1);
    assert.throws(() => throwOnSerialMismatch(warnings), /serial mismatch/i);
    assert.doesNotThrow(() => throwOnSerialMismatch([]));
  });
});

describe("yamaha candidates offline", () => {
  it("every strategy yields valid bands under the caps with lower RMS", () => {
    const grid = logGrid(20, 20000, 96);
    const meas = syntheticMeasured(grid);
    const { anchored } = anchorTarget(grid, meas);
    const base = uncorrectedScore(grid, meas, anchored).rms;
    assert.ok(base > 1);
    const cands = generateCandidates(grid, meas, anchored, {
      strategies: [...STRATEGIES],
      seed: 1,
      samples: 800,
    });
    assert.ok(cands.length >= 1 && cands.length <= STRATEGIES.length);
    for (const c of cands) {
      assert.ok(validYamahaBands(c.bands), JSON.stringify(c.bands));
      assert.ok(c.bands.length <= 7);
      assert.ok(c.bands.filter((b) => b.frequencyHz <= 400).length <= 4);
      for (const b of c.bands) {
        assert.ok(YAMAHA_FREQS.some((v) => Math.abs(v - b.frequencyHz) < 1e-9));
        assert.ok(YAMAHA_QS.some((v) => Math.abs(v - b.q) < 1e-9));
        assert.ok(b.gainDb >= -20 - 1e-9 && b.gainDb <= 6 + 1e-9);
        assert.ok(Math.abs(b.gainDb * 2 - Math.round(b.gainDb * 2)) < 1e-9);
      }
      assert.ok(maxCombinedBoost(c.bands, grid) <= 3 + 1e-6);
      assert.ok(c.rms < base, `${c.strategy} rms ${c.rms} vs base ${base}`);
      assert.ok(c.maxBoost <= 3 + 1e-6);
      const s = scorePrediction(grid, meas, anchored, c.bands);
      assert.ok(Math.abs(s.rms - c.rms) < 1e-6);
      const pred = predictCurve(meas, c.bands, grid);
      for (let i = 0; i < pred.length; i++) {
        assert.ok(Math.abs((pred[i] as number) - (c.predicted[i] as number)) < 0.05);
      }
      const sorted = [...c.bands].sort((a, b) => a.frequencyHz - b.frequencyHz);
      assert.deepEqual(c.bands, sorted);
    }
    for (let i = 1; i < cands.length; i++) {
      assert.ok((cands[i] as { rms: number }).rms >= (cands[i - 1] as { rms: number }).rms - 1e-9);
    }
  });
});

describe("stereo stimulus", () => {
  it("puts the sweep on the requested channel and silence on the other", () => {
    const sweep = Float32Array.from([0.1, -0.2, 0.3]);
    const ref = [...sweep];
    const l = stereoStimulus(sweep, "left");
    assert.deepEqual([...l.left], ref);
    assert.deepEqual([...l.right], [0, 0, 0]);
    const r = stereoStimulus(sweep, "right");
    assert.deepEqual([...r.left], [0, 0, 0]);
    assert.deepEqual([...r.right], ref);
  });
});

describe("low-level conditioning", () => {
  it("keeps response shape instead of flooring at -120dB", () => {
    const grid = logGrid(20, 20000, 480);
    const shaped = Float32Array.from(
      grid,
      (f) => -130 + (8 * Math.log2((f as number) / 1000)) / Math.log2(20) + 6 * Math.exp(-((Math.log2((f as number) / 340)) ** 2) / 0.02),
    );
    const out = smoothOctave(grid, zeroMeanOverFit(grid, shaped), 1 / 12);
    const at = (f: number): number => {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < grid.length; i++) {
        const d = Math.abs((grid[i] as number) - f);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return out[bi] as number;
    };
    assert.ok(at(340) - at(100) > 2, `bump lost: 340Hz ${at(340)} vs 100Hz ${at(100)}`);
    assert.ok(at(20000) - at(20) > 10, `slope lost: 20kHz ${at(20000)} vs 20Hz ${at(20)}`);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of out) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    assert.ok(hi - lo > 8, `flat output, span ${hi - lo}`);
  });
});

describe("yamaha viewer", () => {
  it("is self-contained and plots the stored curves", () => {
    const grid = logGrid(20, 20000, 48);
    const meas = syntheticMeasured(grid);
    const { anchored } = anchorTarget(grid, meas);
    const cands = generateCandidates(grid, meas, anchored, {
      strategies: ["greedy", "greedy-cuts"],
      seed: 1,
      samples: 300,
    });
    const gridArr = [...grid].map((v) => v as number);
    const data = {
      run: {
        date: "2026-11-02T00:00:00.000Z",
        micSerial: "7049176",
        micFile: "7049176.txt",
        sweepSecs: 10,
        fitRange: [20, 16000] as [number, number],
        uncorrectedRms: uncorrectedScore(grid, meas, anchored).rms,
        strategies: ["greedy", "greedy-cuts"],
        seed: 1,
        samples: 300,
      },
      target: { grid: gridArr, db: [...anchored].map((v) => v as number) },
      measurement: { grid: gridArr, db: [...meas].map((v) => v as number) },
      candidates: cands,
    };
    const html = renderYamahaViewer(data);
    assert.ok(!html.includes("http://") && !html.includes("https://"));
    assert.ok(!html.includes("fetch("));
    assert.ok(html.includes("<canvas"));
    for (const c of cands) {
      assert.ok(html.includes(c.strategy));
      for (const b of c.bands) assert.ok(html.includes(String(b.frequencyHz)));
    }
  });
});
