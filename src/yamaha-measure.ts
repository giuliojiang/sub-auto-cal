import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  listAudioDevices,
  preferPlaybackId,
  defaultPlaybackId,
  preferCaptureId,
  defaultCaptureId,
  analyzeLevel,
  recordWav,
  playStereoWav,
  writeWavStereo,
  writeWav,
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
} from "./measure/yamaha.ts";
import { renderYamahaViewer } from "./measure/yamaha-viewer.ts";

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
const wanted = stratArg ? stratArg.split(",").map((s) => s.trim()).filter(Boolean) : [...STRATEGIES];
for (const s of wanted) {
  if (!(STRATEGIES as readonly string[]).includes(s)) {
    console.error(`unknown strategy ${s}; use ${STRATEGIES.join(",")}`);
    process.exit(1);
  }
}

const outBase = arg("--out") ?? join("yamaha", stamp());
const outDir = uniqueDir(outBase);

const micText = readFileSync(micCalPath, "utf8");
const micSerialArg = arg("--mic-serial");
const { cal, warnings } = parseMicCal(micText, micCalPath.split("/").pop() ?? "cal.txt", micSerialArg);
throwOnSerialMismatch(warnings);

const devs = await listAudioDevices();
let playbackId = arg("--playback") ?? preferPlaybackId(devs.playback) ?? (await defaultPlaybackId());
let captureId = arg("--capture") ?? preferCaptureId(devs.capture) ?? (await defaultCaptureId());
if (!synthetic && !captureId) throw new Error("no capture device found; connect the UMIK-1");
if (!synthetic && captureId && !/umik|u18db/i.test(captureId)) {
  const umik = preferCaptureId(devs.capture);
  if (umik) captureId = umik;
  else throw new Error(`capture device is not a UMIK-1: ${captureId}`);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "candidates"), { recursive: true });

const grid = outputGrid(240);
let measuredDb: Float32Array;
let recKept = "";

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
} else {
  const pre = join(outDir, "pre.wav");
  await recordWav(pre, 2, 48000, captureId);
  const { samples: preS } = readWav(pre);
  const lvl = analyzeLevel(preS);
  console.log(`noise check: peak ${lvl.peakDbfs.toFixed(1)} dBFS rms ${lvl.rmsDbfs.toFixed(1)} dBFS verdict ${lvl.verdict}`);
  if (lvl.verdict === "too high") console.log("warning: input level high; continuing without gating");
  const sweep = genESS(20, 20000, sweepSecs);
  const stimFile = join(outDir, "sweep.wav");
  const stim = stereoStimulus(sweep, channel);
  writeWavStereo(stimFile, stim.left, stim.right);
  const recFile = join(outDir, "rec.wav");
  const tailSecs = sweepSecs + 2.0;
  const recP = recordWav(recFile, tailSecs, 48000, captureId);
  await new Promise((r) => setTimeout(r, 250));
  await playStereoWav(stimFile, playbackId);
  await recP;
  const { samples } = readWav(recFile);
  const inv = inverseESS(sweep, 20, 20000, sweepSecs);
  const fr = deconvolveToFR(samples, sweep, inv);
  const fine = logGrid(20, 20000, 480);
  const interpFine = interpLog(fr, fine);
  const smoothedFine = smoothOctave(fine, zeroMeanOverFit(fine, interpFine), 1 / 12);
  const calFine = applyCal(fine, smoothedFine, cal);
  measuredDb = interpLog({ freqs: fine, db: calFine }, grid);
  recKept = recFile;
  const wavCopy = join(outDir, "rec-kept.wav");
  try {
    copyFileSync(recFile, wavCopy);
    recKept = wavCopy;
  } catch {}
}

const { anchored } = anchorTarget(grid, measuredDb);
const base = uncorrectedScore(grid, measuredDb, anchored);
const candidates = generateCandidates(grid, measuredDb, anchored, {
  strategies: wanted,
  seed,
  samples,
  sr: 48000,
});

const targetDb: number[] = [...anchored].map((v) => v as number);
const measArr: number[] = [...measuredDb].map((v) => v as number);
const gridArr: number[] = [...grid].map((v) => v as number);

const json = {
  run: {
    date: new Date().toISOString(),
    micSerial: cal.serial,
    micFile: micCalPath.split("/").pop() ?? micCalPath,
    sweepSecs,
    channel,
    fitRange: [20, 16000] as [number, number],
    uncorrectedRms: base.rms,
    strategies: wanted,
    seed,
    samples,
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

const html = renderYamahaViewer({
  run: json.run,
  target: json.target,
  measurement: json.measurement,
  candidates: json.candidates,
});
writeFileSync(join(outDir, "viewer.html"), html);

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
if (recKept) console.log(`recording ${recKept}`);
