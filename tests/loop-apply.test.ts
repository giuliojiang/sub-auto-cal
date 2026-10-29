import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DspSimulator } from "../src/dsp/simulator.ts";
import { DspDevice } from "../src/dsp/device.ts";
import type { DspLink } from "../src/dsp/link.ts";
import type { Reply } from "../src/dsp/protocol.ts";
import { applyCandidate, candidateMismatches } from "../src/measure/loop.ts";
import { deviceStateToCandidate, cloneCandidate } from "../src/measure/objective.ts";

class FrozenLink implements DspLink {
  name = "frozen";
  private sim = new DspSimulator();
  async write(_frame: Uint8Array): Promise<void> {}
  async command(_frame: Uint8Array): Promise<void> {}
  async query(code: number, data = new Uint8Array(0), timeoutMs = 800): Promise<Reply> {
    return this.sim.query(code, data, timeoutMs);
  }
  close(): void {}
}

async function simDevice() {
  const dev = new DspDevice(new DspSimulator());
  await dev.connect();
  const st = await dev.refresh();
  const { candidate } = deviceStateToCandidate(st);
  const types = st.outputs.map((o) => o.bands.map((b) => b.type));
  return { dev, candidate, types };
}

describe("verify-before-sweep", () => {
  it("matching device state reports no mismatches", async () => {
    const { dev, candidate, types } = await simDevice();
    const st = await dev.refresh();
    assert.deepEqual(candidateMismatches(st, candidate, types), []);
  });

  it("names each drifted field", async () => {
    const { dev, candidate, types } = await simDevice();
    const st = await dev.refresh();
    const bad = cloneCandidate(candidate);
    bad.channels[0]!.gainDb = -6;
    bad.channels[1]!.delayMs = 1;
    bad.channels[0]!.bands[0]!.gainDb = -4;
    bad.channels[0]!.bands[1]!.freqHz = 1234;
    bad.channels[0]!.bands[2]!.q = 3;
    const got = candidateMismatches(st, bad, types);
    for (const want of ["Out1 gain", "Out2 delay", "Out1b0 gain", "Out1b1 freq", "Out1b2 q"]) {
      assert.ok(got.includes(want), `missing ${want} in ${got}`);
    }
  });

  it("applyCandidate lands settings before returning", async () => {
    const { dev, candidate, types } = await simDevice();
    const next = cloneCandidate(candidate);
    next.channels[2]!.gainDb = -5;
    next.channels[2]!.bands[3]!.gainDb = -7;
    await applyCandidate(dev, next, types, { settleMs: 20 });
    const st = await dev.refresh();
    assert.deepEqual(candidateMismatches(st, next, types), []);
  });

  it("applyCandidate fails loudly when writes do not stick", async () => {
    const dev = new DspDevice(new FrozenLink());
    await dev.connect();
    const st = await dev.refresh();
    const { candidate } = deviceStateToCandidate(st);
    const types = st.outputs.map((o) => o.bands.map((b) => b.type));
    const next = cloneCandidate(candidate);
    next.channels[0]!.gainDb = -6;
    await assert.rejects(applyCandidate(dev, next, types, { tries: 2, settleMs: 0 }), /did not take settings/);
  });
});
