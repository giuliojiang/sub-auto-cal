import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest,
  checksum,
  parseReply,
  frameHex,
  gainDbToRaw,
  gainRawToDb,
  peqGainDbToRaw,
  hzToFreqIndex,
  freqIndexToHz,
  qToRaw,
  msToDelaySamples,
  thresholdDbToRaw,
  muteFrame,
  levelFrame,
  peqFrame,
  crossoverFrame,
  delayFrame,
  routingFrame,
  signalFrame,
  pollFrame,
  parsePresetImage,
  CMD,
} from "../src/dsp/protocol.ts";
import { DspSimulator } from "../src/dsp/simulator.ts";
import { DspDevice } from "../src/dsp/device.ts";

describe("framing", () => {
  it("poll frame matches the golden vector from the notes", () => {
    assert.equal(frameHex(pollFrame()), "10 02 00 01 01 40 10 03 41");
  });
  it("mute Out1 on matches the golden vector from the notes", () => {
    assert.equal(frameHex(muteFrame(4, true)), "10 02 00 01 03 35 04 01 10 03 33");
  });
  it("checksum is xor then ^1", () => {
    assert.equal(checksum([0x00, 0x01, 0x01, 0x40]), 0x41);
    assert.equal(checksum([0x00, 0x01, 0x03, 0x35, 0x04, 0x01]), 0x33);
  });
  it("frames are 64 bytes, zero padded", () => {
    const f = buildRequest(0x40);
    assert.equal(f.length, 64);
    assert.equal(f[9], 0);
    assert.equal(f[63], 0);
  });
  it("reply round-trips through parseReply", () => {
    const r = parseReply(buildRequest(CMD.meterPoll));
    assert.equal(r.checksumOk, true);
  });
});

describe("scales", () => {
  it("gain: 0dB=281, +12dB=400, ~10/dB", () => {
    assert.equal(gainDbToRaw(0), 281);
    assert.equal(gainDbToRaw(12), 400);
    assert.equal(gainDbToRaw(-6), 221);
    assert.equal(gainRawToDb(281), 0);
  });
  it("peq gain: 0.1dB steps, 0dB=120", () => {
    assert.equal(peqGainDbToRaw(0), 120);
    assert.equal(peqGainDbToRaw(-12), 0);
    assert.equal(peqGainDbToRaw(12), 240);
  });
  it("frequency index: 30/oct from 19.7Hz", () => {
    assert.equal(hzToFreqIndex(40.3), 31);
    assert.ok(Math.abs(freqIndexToHz(hzToFreqIndex(80)) - 80.6) < 0.1);
    assert.ok(Math.abs(freqIndexToHz(hzToFreqIndex(100)) - 99.2) < 0.2);
    assert.ok(Math.abs(freqIndexToHz(hzToFreqIndex(120)) - 119.4) < 0.2);
    assert.equal(hzToFreqIndex(10), 0);
    assert.equal(hzToFreqIndex(25000), 300);
  });
  it("delay maxes at 32640 samples (680ms)", () => {
    assert.equal(msToDelaySamples(680), 32640);
    assert.equal(msToDelaySamples(9999), 32640);
  });
  it("threshold raw=(dB+90)*2", () => {
    assert.equal(thresholdDbToRaw(-10), 160);
  });
  it("q maps and clamps", () => {
    assert.equal(qToRaw(1.4), 14);
  });
});

describe("command layouts", () => {
  it("level frame carries [chan, raw16le]", () => {
    const f = levelFrame(4, -6);
    assert.deepEqual([...f.slice(5, 9)], [0x34, 4, 221, 0]);
  });
  it("peq frame carries [chan, band, gain16, freq16, q, type, bypass]", () => {
    const f = peqFrame(4, 2, { freqHz: 100, q: 1.4, gainDb: -3, type: 0 });
    assert.equal(f[5], 0x33);
    assert.equal(f[6], 4);
    assert.equal(f[7], 2);
    assert.equal((f[8] as number) | ((f[9] as number) << 8), 90);
    assert.equal((f[10] as number) | ((f[11] as number) << 8), hzToFreqIndex(100));
    assert.equal(f[12], 14);
    assert.equal(f[13], 0);
    assert.equal(f[14], 0);
  });
  it("crossover, delay, routing, signal frames", () => {
    assert.equal(crossoverFrame(true, 4, 80, 10)[5], 0x32);
    assert.equal(crossoverFrame(false, 4, 80, 10)[5], 0x31);
    assert.equal(delayFrame(4, 2)[5], 0x38);
    assert.deepEqual([...routingFrame(4, 3).slice(5, 8)], [0x3a, 4, 3]);
    assert.deepEqual([...signalFrame(1).slice(5, 8)], [0x39, 1, 0]);
  });
});

describe("simulator round-trip", () => {
  it("write then read back gain, peq, crossover, delay, routing", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.setGain(4, -6);
    await dev.setPeq(4, 0, { freqHz: 100, q: 2, gainDb: -4.5, type: 0 });
    await dev.setCrossover(4, true, 80, 10);
    await dev.setDelay(4, 1.46);
    await dev.setRouting(4, 5);
    const st = await dev.refresh();
    assert.equal(st.outputs[0]!.gainDb, -6);
    const b = st.outputs[0]!.bands[0]!;
    assert.equal(b.gainDb, -4.5);
    assert.equal(b.freqHz, freqIndexToHz(hzToFreqIndex(100)));
    assert.ok(Math.abs(b.freqHz - 99.2) < 0.2);
    assert.equal(b.q, 2);
    assert.ok(Math.abs((st.outputs[0]!.hpfHz as number) - 80.6) < 0.05);
    assert.equal(st.outputs[0]!.delayMs, msToDelaySamples(1.46) / 48);
    assert.equal(st.outputs[0]!.routingMask, 5);
  });
  it("snapshot and revert restore state", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.takeSnapshot();
    await dev.setGain(5, -10);
    await dev.revert();
    const st = await dev.refresh();
    assert.equal(st.outputs[1]!.gainDb, 0);
  });
  it("preset image parser reads the simulator image", async () => {
    const sim = new DspSimulator();
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) pages.push((await sim.query(CMD.readChannel, Uint8Array.of(i))).data.slice(1));
    const img = new Uint8Array(450);
    pages.forEach((p, i) => img.set(p.slice(0, 50), i * 50));
    const parsed = parsePresetImage(img);
    assert.equal(parsed.inputs.length, 4);
    assert.equal(parsed.outputs.length, 4);
    assert.equal(parsed.outputs[0]!.bands.length, 7);
  });
});
