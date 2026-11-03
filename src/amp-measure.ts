import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  listAudioDevices,
  preferPlaybackId,
  preferCaptureId,
  analyzeLevel,
  recordWav,
  playStereoWav,
  writeWavStereo,
  readWav,
} from "./audio.ts";
import {
  genESS,
  inverseESS,
  deconvolveToFR,
  logGrid,
  interpLog,
  smoothOctave,
} from "./measure/sweep.ts";
import { parseMicCal, applyCal } from "./measure/miccal.ts";
import {
  STRATEGIES,
  generateCandidates,
  anchorTarget,
  uncorrectedScore,
  outputGrid,
  throwOnSerialMismatch,
  zeroMeanOverFit,
  stereoStimulus,
  type YamahaBand,
} from "./measure/yamaha.ts";
import { AMP_GRID, AMP_OUTPUT_CHANS, snapAmpBand } from "./measure/amp.ts";
import { renderAmpViewer } from "./measure/amp-viewer.ts";
import { DspDevice } from "./dsp/device.ts";
import { HidLink } from "./dsp/link.ts";
import { CMD, parsePresetImage, peqGainDbToRaw, peqGainRawToDb, hzToFreqIndex, freqIndexToHz, qToRaw, rawToQ } from "./dsp/protocol.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function stamp(): string {
  const d = new Date();
  const p = (v: number, l = 2) => String(v).padStart(l, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniqueDir(base: string): string {
  if (!existsSync(base)) return base;
  let k = 1;
  while (existsSync(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}

const micCalPath = arg("--mic-cal");
const synthetic = has("--synthetic");
if (!micCalPath) {
  console.error("missing --mic-cal <umik-cal-file>");
  process.exit(1);
}

const sweepSecs = Math.max(2, Math.min(30, Number(arg("--sweep-secs") ?? "10") || 10));
const seed = Number(arg("--seed") ?? "1") || 1;
const samples = Math.max(100, Math.min(200000, Number(arg("--samples") ?? "20000") || 20000));
const channelArg = (arg("--channel") ?? "left").toLowerCase();
if (channelArg !== "left" && channelArg !== "right") {
  console.error("channel must be left or right");
  process.exit(1);
}
const channel = channelArg as "left" | "right";
const stratArg = arg("--strategies");
const wanted = stratArg ? stratArg.split(",").map((s) => s.trim()).filter(Boolean) : ["greedy-refined"];
for (const s of wanted) {
  if (!(STRATEGIES as readonly string[]).includes(s)) {
    console.error(`unknown strategy ${s}; use ${STRATEGIES.join(",")}`);
    process.exit(1);
  }
}

const apply = has("--apply");
const verify = has("--no-verify") ? false : has("--verify") ? true : apply;
const storeSlotRaw = arg("--store-preset");
let storeSlot: number | null = null;
if (storeSlotRaw !== undefined) {
  storeSlot = Number(storeSlotRaw);
  if (!Number.isInteger(storeSlot) || storeSlot < 0 || storeSlot > 29) {
    console.error("--store-preset must be a slot 0-29");
    process.exit(1);
  }
}
if (!apply && storeSlot !== null) {
  console.error("--store-preset needs --apply");
  process.exit(1);
}
if (!apply && has("--verify")) {
  console.log("note: --verify without --apply re-measures the untouched state");
}

const outBase = arg("--out") ?? join("amp", stamp());
const outDir = uniqueDir(outBase);

const micText = readFileSync(micCalPath, "utf8");
const micSerialArg = arg("--mic-serial");
const { cal, warnings } = parseMicCal(micText, micCalPath.split("/").pop() ?? "cal.txt", micSerialArg);
throwOnSerialMismatch(warnings);

const devs = await listAudioDevices();
let playbackId = arg("--playback") ?? preferPlaybackId(devs.playback);
let captureId = arg("--capture") ?? preferCaptureId(devs.capture);
if (!synthetic && !captureId) throw new Error("no capture device found; connect the UMIK-1");
if (!synthetic && captureId && !/umik|u18db/i.test(captureId)) {
  const umik = preferCaptureId(devs.capture);
  if (umik) captureId = umik;
  else throw new Error(`capture device is not a UMIK-1: ${captureId}`);
}

console.log(`playback ${playbackId ?? "(default)"} capture ${captureId ?? "(missing)"}`);

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "candidates"), { recursive: true });

async function readOnlySnapshot(): Promise<ReturnType<typeof parsePresetImage> | null> {
  const link = HidLink.open();
  try {
    await link.query(CMD.status);
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await link.query(CMD.readChannel, Uint8Array.of(i));
      pages.push(r.data.slice(1));
    }
    const img = new Uint8Array(450);
    pages.forEach((p, i) => img.set(p.slice(0, 50), i * 50));
    return parsePresetImage(img);
  } finally {
    link.close();
  }
}

function snapshotSummary(st: ReturnType<typeof parsePresetImage>): string {
  return st.outputs
    .map(
      (o, i) =>
        `Out${i + 1} name=${JSON.stringify(o.name)} gain=${o.gainDb}dB route=${o.routingMask} delay=${o.delayMs.toFixed(2)}ms ` +
        `hpf=${o.hpfHz?.toFixed(1) ?? "off"}/${o.hpfSlope} lpf=${o.lpfHz?.toFixed(1) ?? "off"}/${o.lpfSlope} ` +
        `bands=${o.bands.map((b) => `${b.freqHz.toFixed(1)}Hz/${b.q.toFixed(2)}/${b.gainDb.toFixed(1)}dB/t${b.type}`).join(" ")}`,
    )
    .join("\n");
}

const grid = outputGrid(240);

async function sweepOnce(dir: string, tag: string): Promise<{ db: Float32Array; recFile: string }> {
  const pre = join(dir, `${tag}-pre.wav`);
  await recordWav(pre, 2, 48000, captureId);
  const { samples: preS } = readWav(pre);
  const lvl = analyzeLevel(preS);
  console.log(`noise check ${tag}: peak ${lvl.peakDbfs.toFixed(1)} dBFS rms ${lvl.rmsDbfs.toFixed(1)} dBFS verdict ${lvl.verdict}`);
  if (lvl.verdict === "too high") console.log("warning: input level high; continuing without gating");
  const sweep = genESS(20, 20000, sweepSecs);
  const stimFile = join(dir, `${tag}-sweep.wav`);
  const stim = stereoStimulus(sweep, channel);
  writeWavStereo(stimFile, stim.left, stim.right);
  const recFile = join(dir, `${tag}-rec.wav`);
  const recP = recordWav(recFile, sweepSecs + 2.0, 48000, captureId);
  await new Promise((r) => setTimeout(r, 250));
  await playStereoWav(stimFile, playbackId);
  await recP;
  const { samples: rec } = readWav(recFile);
  const inv = inverseESS(sweep, 20, 20000, sweepSecs);
  const fr = deconvolveToFR(rec, sweep, inv);
  const fine = logGrid(20, 20000, 480);
  const interpFine = interpLog(fr, fine);
  const smoothedFine = smoothOctave(fine, zeroMeanOverFit(fine, interpFine), 1 / 12);
  const calFine = applyCal(fine, smoothedFine, cal);
  const db = interpLog({ freqs: fine, db: calFine }, grid);
  return { db, recFile };
}

let measuredDb: Float32Array;
let snapshotJson: ReturnType<typeof parsePresetImage> | null = null;
let applied: { bands: YamahaBand[]; readbackOk: boolean; mismatches: string[] } | null = null;
let verified: { grid: number[]; db: number[] } | null = null;
let dev: DspDevice | null = null;

if (synthetic) {
  const shape = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i] as number;
    let v = -20;
    v += 7 * Math.exp(-Math.pow(Math.log2(f / 55), 2) / 0.08);
    v += 5 * Math.exp(-Math.pow(Math.log2(f / 180), 2) / 0.05);
    v += 3 * Math.sin(2 * Math.PI * Math.log2(f / 20) * 1.5) * Math.exp(-f / 8000);
    shape[i] = v;
  }
  measuredDb = applyCal(grid, shape, cal);
} else if (!apply) {
  try {
    snapshotJson = await readOnlySnapshot();
    if (snapshotJson) console.log("dsp snapshot (read-only, nothing written):\n" + snapshotSummary(snapshotJson));
  } catch (e) {
    console.log(`dsp not reachable for snapshot note (${String(e)}); continuing with measurement only`);
  }
  const { db, recFile } = await sweepOnce(outDir, "base");
  measuredDb = db;
  console.log(`dry-run: measured through existing PEQs, wrote nothing to the DSP (baseline ${recFile})`);
} else {
  const link = HidLink.open();
  dev = new DspDevice(link);
  await dev.connect();
  await dev.takeSnapshot();
  const st0 = dev.current as NonNullable<DspDevice["current"]>;
  snapshotJson = JSON.parse(JSON.stringify({ presetName: "", inputs: st0.inputs, outputs: st0.outputs }));
  const snapNow = snapshotJson;
  if (!snapNow) throw new Error("snapshot failed");
  console.log("dsp snapshot before touching anything:\n" + snapshotSummary(snapNow));
  writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(snapshotJson, null, 2));
  for (const chan of AMP_OUTPUT_CHANS) {
    const o = snapshotJson!.outputs[chan - 4]!;
    for (let b = 0; b < 7; b++) {
      const sb = o.bands[b]!;
      await dev.setPeq(chan, b, { freqHz: sb.freqHz, q: sb.q, gainDb: 0, type: sb.type, bypass: false });
    }
  }
  console.log("flattened all four outputs for the baseline sweep");
  const { db } = await sweepOnce(outDir, "base");
  measuredDb = db;
}

const { anchored } = anchorTarget(grid, measuredDb);
const base = uncorrectedScore(grid, measuredDb, anchored);
const t0 = Date.now();
const candidates = generateCandidates(grid, measuredDb, anchored, {
  strategies: wanted,
  seed,
  samples,
  sr: 48000,
  grid: AMP_GRID,
});
console.log(`fit took ${((Date.now() - t0) / 1000).toFixed(1)}s on the DSP grid`);

const targetDb: number[] = [...anchored].map((v) => v as number);
const measArr: number[] = [...measuredDb].map((v) => v as number);
const gridArr: number[] = [...grid].map((v) => v as number);

if (dev && apply) {
  const chosen = candidates[0];
  if (!chosen) throw new Error("no candidate produced; aborting before any write");
  const bands = chosen.bands.map(snapAmpBand);
  const types = snapshotJson!.outputs.map((o) => o.bands.map((b) => b.type));
  const mismatches: string[] = [];
  let ok = false;
  for (let a = 0; a < 3 && !ok; a++) {
    for (const chan of AMP_OUTPUT_CHANS) {
      for (let b = 0; b < 7; b++) {
        const want: YamahaBand =
          b < bands.length
            ? (bands[b] as YamahaBand)
            : { frequencyHz: 1000, q: 1, gainDb: 0 };
        await dev.setPeq(chan, b, {
          freqHz: want.frequencyHz,
          q: want.q,
          gainDb: want.gainDb,
          type: types[chan - 4]![b] ?? 0,
          bypass: false,
        });
      }
    }
    const st = await dev.refresh();
    for (const chan of AMP_OUTPUT_CHANS) {
      const o = chan - 4;
      for (let b = 0; b < 7; b++) {
        const rb = st.outputs[o]!.bands[b]!;
        const want: YamahaBand =
          b < bands.length ? (bands[b] as YamahaBand) : { frequencyHz: 1000, q: 1, gainDb: 0 };
        if (Math.abs(rb.freqHz - freqIndexToHz(hzToFreqIndex(want.frequencyHz))) > 1e-6)
          mismatches.push(`Out${o + 1}b${b} freq`);
        if (Math.abs(rb.q - rawToQ(qToRaw(want.q))) > 1e-9) mismatches.push(`Out${o + 1}b${b} q`);
        if (Math.abs(rb.gainDb - peqGainRawToDb(peqGainDbToRaw(want.gainDb))) > 1e-9)
          mismatches.push(`Out${o + 1}b${b} gain`);
        if (rb.type !== (types[o]![b] ?? 0)) mismatches.push(`Out${o + 1}b${b} type`);
      }
    }
    if (!mismatches.length) ok = true;
    else if (a < 2) mismatches.length = 0;
  }
  if (!ok) {
    console.error(`dsp did not take settings: ${mismatches.slice(0, 4).join("; ")}${mismatches.length > 4 ? ` (+${mismatches.length - 4} more)` : ""}`);
    await dev.revert();
    throw new Error(`apply failed readback; reverted to snapshot`);
  }
  applied = { bands, readbackOk: true, mismatches: [] };
  console.log("applied candidate to all four outputs, readback verified");
  if (verify) {
    const v = await sweepOnce(outDir, "verify");
    verified = { grid: gridArr, db: [...v.db].map((x) => x as number) };
    console.log("verify sweep recorded with the new PEQs live");
  }
  if (storeSlot !== null) {
    await dev.storePreset(storeSlot);
    console.log(`stored preset slot ${storeSlot}`);
  }
}

const json = {
  run: {
    date: new Date().toISOString(),
    mode: "amp-full-range",
    micSerial: cal.serial,
    micFile: micCalPath.split("/").pop() ?? micCalPath,
    sweepSecs,
    channel,
    outputs: [1, 2, 3, 4],
    fitRange: [20, 16000] as [number, number],
    uncorrectedRms: base.rms,
    strategies: wanted,
    seed,
    samples,
    applied: apply,
    verified: verify && applied !== null,
    storePreset: storeSlot,
    dryRun: !apply,
  },
  target: { grid: gridArr, db: targetDb },
  measurement: { grid: gridArr, db: measArr },
  candidates: candidates.map((c) => ({
    strategy: c.strategy,
    strategies: c.strategies,
    bands: c.bands,
    rms: c.rms,
    maxAbs: c.maxAbs,
    maxBoost: c.maxBoost,
    grid: c.grid,
    predicted: c.predicted,
  })),
  snapshot: snapshotJson,
  applied,
  verified,
};
writeFileSync(join(outDir, "candidates.json"), JSON.stringify(json, null, 2));
writeFileSync(join(outDir, "measured.json"), JSON.stringify({ grid: gridArr, db: measArr, target: targetDb }, null, 2));

for (const c of candidates) {
  const dir = join(outDir, "candidates", c.strategy);
  mkdirSync(dir, { recursive: true });
  const lines = c.bands.map((b) => `${b.frequencyHz} Hz / Q ${b.q} / ${b.gainDb} dB`);
  writeFileSync(join(dir, "filters.txt"), (lines.length ? lines.join("\n") : "(no bands)") + "\n");
  const frd = c.grid.map((f, i) => `${f.toFixed(2)} ${(c.predicted[i] as number).toFixed(2)} 0`).join("\n") + "\n";
  writeFileSync(join(dir, "predicted.frd"), frd);
}

try {
  const html = renderAmpViewer(json);
  writeFileSync(join(outDir, "report.html"), html);
} catch (e) {
  console.error(`report render failed: ${String(e)}`);
}

console.log(`strategy  bands  rms-dB  maxabs-dB  maxboost-dB`);
for (const c of candidates) {
  console.log(
    `${c.strategy}  ${c.bands.length}  ${c.rms.toFixed(2)}  ${c.maxAbs.toFixed(2)}  ${c.maxBoost.toFixed(2)}`,
  );
}
for (const c of candidates) {
  console.log(`--- ${c.strategy} (${c.strategies.join(",")}) ---`);
  if (!c.bands.length) console.log("(no bands)");
  for (const b of c.bands) console.log(`${b.frequencyHz} Hz / Q ${b.q} / ${b.gainDb} dB`);
}
console.log(`wrote ${outDir}`);
console.log("defaults pending owner word: dry-run unless --apply; verify on with --apply unless --no-verify; preset only with --store-preset; fit 20Hz-16kHz");

try {
  dev?.close();
} catch {}
