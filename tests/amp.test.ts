import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logGrid } from "../src/measure/sweep.ts";
import {
  anchorTarget,
  generateCandidates,
  uncorrectedScore,
  yamahaTarget,
  throwOnSerialMismatch,
  validBands,
  maxBoostFor,
} from "../src/measure/yamaha.ts";
import { AMP_GRID, ampFreqs, ampQs, isAmpGridBand, AMP_MAX_BOOST_DB } from "../src/measure/amp.ts";
import { renderAmpViewer } from "../src/measure/amp-viewer.ts";
import { parseMicCal } from "../src/measure/miccal.ts";
import { hzToFreqIndex, freqIndexToHz, qToRaw, rawToQ } from "../src/dsp/protocol.ts";

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

describe("amp grids", () => {
  it("uses DSP index and semitone grids inside the fit range", () => {
    const freqs = ampFreqs();
    assert.ok(freqs.length > 200 && freqs.length < 320);
    for (const f of freqs) {
      assert.ok(f >= 20 - 1e-9 && f <= 16000 + 1e-9);
      assert.ok(Math.abs(freqIndexToHz(hzToFreqIndex(f)) - f) < 1e-9);
    }
    const qs = ampQs();
    assert.ok(qs.length >= 50 && qs.length <= 56);
    for (const q of qs) {
      assert.ok(q >= 0.5 - 1e-9 && q <= 10.08 + 1e-3);
      assert.ok(Math.abs(rawToQ(qToRaw(q)) - q) < 1e-9);
    }
    assert.equal(AMP_GRID.gainMin, -12);
    assert.equal(AMP_GRID.gainMax, 3);
    assert.equal(AMP_GRID.gainStep, 0.5);
    assert.equal(AMP_GRID.maxBands, 7);
    assert.equal(AMP_GRID.maxBoostDb, 3);
  });
});

describe("amp target", () => {
  it("shares the yamaha curve check values", () => {
    assert.ok(Math.abs(yamahaTarget(1000) - 0) < 1e-9);
    assert.ok(Math.abs(yamahaTarget(100) - 3.32) < 0.05);
    assert.ok(Math.abs(yamahaTarget(20000) - -8.64) < 0.05);
    assert.ok(Math.abs(yamahaTarget(40) - -8.36) < 0.05);
  });
});

describe("amp serial", () => {
  it("rejects a mismatched serial", () => {
    const text = `"Sens Factor =0dB, SERNO: 111"\n20 0\n30 0\n40 0\n50 0\n60 0\n70 0\n80 0\n90 0\n100 0\n20000 0\n`;
    const { warnings } = parseMicCal(text, "111.txt", "999");
    assert.equal(warnings.length, 1);
    assert.throws(() => throwOnSerialMismatch(warnings), /serial mismatch/i);
  });
});

describe("amp greedy-refined offline", () => {
  it("yields valid on-grid bands with lower RMS", () => {
    const grid = logGrid(20, 20000, 96);
    const meas = syntheticMeasured(grid);
    const { anchored } = anchorTarget(grid, meas);
    const base = uncorrectedScore(grid, meas, anchored).rms;
    assert.ok(base > 1);
    const cands = generateCandidates(grid, meas, anchored, {
      strategies: ["greedy-refined"],
      seed: 1,
      samples: 800,
      grid: AMP_GRID,
    });
    assert.equal(cands.length, 1);
    const c = cands[0]!;
    assert.ok(validBands(c.bands, AMP_GRID), JSON.stringify(c.bands));
    assert.ok(c.bands.length <= 7);
    for (const b of c.bands) assert.ok(isAmpGridBand(b), JSON.stringify(b));
    assert.ok(maxBoostFor(c.bands, grid, AMP_GRID) <= AMP_MAX_BOOST_DB + 1e-6);
    assert.ok(c.rms < base);
  });
});

describe("amp viewer", () => {
  it("is self-contained and plots the stored curves", () => {
    const grid = logGrid(20, 20000, 48);
    const meas = syntheticMeasured(grid);
    const { anchored } = anchorTarget(grid, meas);
    const cands = generateCandidates(grid, meas, anchored, {
      strategies: ["greedy-refined"],
      seed: 1,
      samples: 300,
      grid: AMP_GRID,
    });
    const gridArr = [...grid].map((v) => v as number);
    const html = renderAmpViewer({
      run: {
        date: "2026-11-03T00:00:00.000Z",
        mode: "amp-full-range",
        micSerial: "7049176",
        micFile: "7049176.txt",
        sweepSecs: 10,
        channel: "left",
        outputs: [1, 2, 3, 4],
        fitRange: [20, 16000],
        uncorrectedRms: uncorrectedScore(grid, meas, anchored).rms,
        strategies: ["greedy-refined"],
        seed: 1,
        samples: 300,
        applied: false,
        verified: false,
        storePreset: null,
        dryRun: true,
      },
      target: { grid: gridArr, db: [...anchored].map((v) => v as number) },
      measurement: { grid: gridArr, db: [...meas].map((v) => v as number) },
      candidates: cands,
      snapshot: null,
      applied: null,
      verified: null,
    });
    assert.ok(!html.includes("http://") && !html.includes("https://"));
    assert.ok(!html.includes("fetch("));
    assert.ok(html.includes("<canvas"));
    for (const c of cands) {
      assert.ok(html.includes(c.strategy));
      for (const b of c.bands) assert.ok(html.includes(String(b.frequencyHz)));
    }
  });
});
