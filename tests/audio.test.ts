import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  genWhiteNoise,
  genPinkNoise,
  writeWav,
  readWav,
  analyzeLevel,
  waveform,
  alsaHwId,
  preferCaptureId,
} from "../src/audio.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("audio synth and analysis", () => {
  it("wav round-trips samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-"));
    const src = genWhiteNoise(0.5);
    const path = join(dir, "a.wav");
    writeWav(path, src);
    const { samples, sampleRate } = readWav(path);
    assert.equal(sampleRate, 48000);
    assert.equal(samples.length, src.length);
    let maxErr = 0;
    for (let i = 0; i < samples.length; i++) maxErr = Math.max(maxErr, Math.abs((samples[i] as number) - (src[i] as number)));
    assert.ok(maxErr < 1 / 32768 + 1e-9);
  });
  it("noise peaks near -12dBFS", () => {
    for (const gen of [genWhiteNoise, genPinkNoise]) {
      const r = analyzeLevel(gen(1));
      assert.ok(r.peakDbfs <= -11.9 && r.peakDbfs >= -12.5, `peak ${r.peakDbfs}`);
      assert.equal(r.clipped, false);
      assert.equal(r.verdict, "OK");
    }
  });
  it("waveform buckets track peaks, silence is flat", () => {
    const sine = new Float32Array(4800);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * i) / 48) * 0.8;
    const peaks = waveform(sine, 48);
    assert.equal(peaks.length, 48);
    assert.ok(Math.max(...peaks) > 0.79);
    assert.ok(Math.min(...peaks) > 0.79);
    assert.deepEqual(waveform(new Float32Array(100), 8), [0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("capture preference picks DMIC over generic inputs", () => {
    const devs = [
      "card 0: sofhdadsp [sof-hda-dsp], device 0: HDA Analog (*) []",
      "card 0: sofhdadsp [sof-hda-dsp], device 6: DMIC (*) []",
    ];
    assert.equal(alsaHwId(devs[1]), "plughw:0,6");
    assert.equal(alsaHwId("pulse:foo"), null);
    assert.equal(preferCaptureId(devs), devs[1]);
    assert.equal(preferCaptureId([devs[0]]), undefined);
  });
  it("silence is too low, full scale is too high", () => {
    assert.equal(analyzeLevel(new Float32Array(48000)).verdict, "too low");
    const hot = new Float32Array(48000).fill(0.99);
    assert.equal(analyzeLevel(hot).verdict, "too high");
    const clip = new Float32Array(48000).fill(1);
    const r = analyzeLevel(clip);
    assert.equal(r.clipped, true);
    assert.equal(r.verdict, "too high");
  });
});
