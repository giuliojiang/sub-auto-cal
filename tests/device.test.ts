import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DspSimulator } from "../src/dsp/simulator.ts";
import { DspDevice } from "../src/dsp/device.ts";

describe("live mute truth", () => {
  it("refresh reports mutes sent this session", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.setMute(4, true);
    let st = await dev.refresh();
    assert.equal(st.muted[4], true);
    assert.equal(st.muted[5], false);
    await dev.setMute(4, false);
    st = await dev.refresh();
    assert.equal(st.muted[4], false);
  });
  it("connect starts from all-unmuted", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.setMute(6, true);
    await dev.connect();
    const st = await dev.refresh();
    assert.deepEqual(st.muted, [false, false, false, false, false, false, false, false]);
  });
  it("revert restores mutes", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.takeSnapshot();
    await dev.setMute(5, true);
    await dev.setGain(5, -10);
    await dev.revert();
    const st = await dev.refresh();
    assert.equal(st.muted[5], false);
    assert.equal(st.outputs[1]!.gainDb, 0);
  });
  it("revert keeps a mute taken in the snapshot", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.setMute(7, true);
    await dev.takeSnapshot();
    await dev.setMute(7, false);
    await dev.revert();
    const st = await dev.refresh();
    assert.equal(st.muted[7], true);
  });
});

describe("live bypass truth", () => {
  it("refresh reports bypass sent this session", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.setPeq(4, 0, { freqHz: 100, q: 2, gainDb: -4.5, type: 0, bypass: true });
    let st = await dev.refresh();
    assert.equal(st.outputs[0]!.bands[0]!.bypass, true);
    await dev.setPeq(4, 0, { freqHz: 100, q: 2, gainDb: -4.5, type: 0, bypass: false });
    st = await dev.refresh();
    assert.equal(st.outputs[0]!.bands[0]!.bypass, false);
  });
  it("revert restores bypass", async () => {
    const dev = new DspDevice(new DspSimulator());
    await dev.connect();
    await dev.takeSnapshot();
    await dev.setPeq(4, 1, { freqHz: 200, q: 1, gainDb: -3, type: 0, bypass: true });
    await dev.revert();
    const st = await dev.refresh();
    assert.equal(st.outputs[0]!.bands[1]!.bypass ?? false, false);
  });
});
