import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SAMPLE_RATE = 48000;

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: 127, out: e.message }));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

export async function listAudioDevices(): Promise<{ playback: string[]; capture: string[] }> {
  const playback: string[] = [];
  const capture: string[] = [];
  const ap = await run("aplay", ["-l"]);
  if (ap.code === 0) playback.push(...ap.out.split("\n").filter((l) => l.startsWith("card")));
  const ar = await run("arecord", ["-l"]);
  if (ar.code === 0) capture.push(...ar.out.split("\n").filter((l) => l.startsWith("card")));
  const sinks = await run("pactl", ["list", "short", "sinks"]);
  if (sinks.code === 0) playback.push(...sinks.out.split("\n").filter(Boolean).map((l) => "pulse:" + l.split("\t")[1]));
  const sources = await run("pactl", ["list", "short", "sources"]);
  if (sources.code === 0)
    capture.push(...sources.out.split("\n").filter((l) => !l.includes(".monitor")).map((l) => "pulse:" + l.split("\t")[1]));
  return { playback, capture };
}

export function genWhiteNoise(seconds: number, sr = SAMPLE_RATE, peakDbfs = -12): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const peak = Math.pow(10, peakDbfs / 20);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * peak;
  const fade = Math.min(n >> 3, Math.floor(sr * 0.05));
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i]! *= g;
    out[n - 1 - i]! *= g;
  }
  return out;
}

export function genPinkNoise(seconds: number, sr = SAMPLE_RATE, peakDbfs = -12): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = pink * 0.11;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i] as number));
  const target = Math.pow(10, peakDbfs / 20);
  const g = peak > 0 ? target / peak : 1;
  for (let i = 0; i < n; i++) out[i]! *= g;
  return out;
}

export function writeWav(path: string, samples: Float32Array, sr = SAMPLE_RATE): void {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  const channels = buf.readUInt16LE(22);
  const sr = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`only 16-bit wav supported, got ${bits}`);
  const dataOff = 44;
  const frames = Math.floor((buf.length - dataOff) / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataOff + (i * channels + c) * 2) / 32768;
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate: sr };
}

export interface LevelReport {
  peakDbfs: number;
  rmsDbfs: number;
  clipped: boolean;
  verdict: "too low" | "OK" | "too high";
}

export function waveform(samples: Float32Array, buckets = 400): number[] {
  const out = new Array(buckets).fill(0);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const end = Math.min(samples.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = Math.abs(samples[i] as number);
      if (v > peak) peak = v;
    }
    out[b] = Math.round(peak * 1000) / 1000;
  }
  return out;
}

export function analyzeLevel(samples: Float32Array): LevelReport {
  let peak = 0;
  let sumSq = 0;
  let clipped = false;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v >= 1) clipped = true;
    if (v > peak) peak = v;
    sumSq += (samples[i] as number) * (samples[i] as number);
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const peakDbfs = 20 * Math.log10(Math.max(1e-9, peak));
  const rmsDbfs = 20 * Math.log10(Math.max(1e-9, rms));
  let verdict: LevelReport["verdict"] = "OK";
  if (clipped || peakDbfs > -3) verdict = "too high";
  else if (rmsDbfs < -40) verdict = "too low";
  return { peakDbfs, rmsDbfs, clipped, verdict };
}

export async function playWav(path: string, playbackId?: string): Promise<void> {
  const extra = playbackId?.startsWith("pulse:") ? ["--device=" + playbackId.slice(6)] : [];
  const paplay = await run("paplay", [...extra, path]);
  if (paplay.code === 0) return;
  const ap = await run("aplay", ["-q", path]);
  if (ap.code !== 0) throw new Error(`no audio player worked (paplay, aplay): ${ap.out.slice(0, 200)}`);
}

export function alsaHwId(label: string): string | null {
  const m = /card (\d+).*device (\d+)/.exec(label);
  return m ? `plughw:${m[1]},${m[2]}` : null;
}

export function preferCaptureId(capture: string[]): string | undefined {
  return capture.find((d) => /dmic/i.test(d)) ?? capture.find((d) => /mic/i.test(d));
}

export async function defaultCaptureId(): Promise<string | undefined> {
  try {
    return preferCaptureId((await listAudioDevices()).capture);
  } catch {
    return undefined;
  }
}

export async function recordWav(path: string, seconds: number, sr = SAMPLE_RATE, captureId?: string): Promise<void> {
  const hw = captureId ? alsaHwId(captureId) : null;
  const args = ["-q", "-r", String(sr), "-c", "1", "-f", "S16_LE", "-t", "wav"];
  if (hw) args.push("-D", hw);
  args.push("-d", String(Math.ceil(seconds)), path);
  const ar = await run("arecord", args);
  if (ar.code !== 0) throw new Error(`arecord failed: ${ar.out.slice(0, 200)}`);
}

export interface NoiseCheckResult extends LevelReport {
  stimulusFile: string;
  recordingFile: string;
  sampleRate: number;
  seconds: number;
  playbackId: string;
  captureId: string;
}

export async function noiseCheck(
  seconds = 3,
  kind: "pink" | "white" = "pink",
  playbackId?: string,
  captureId?: string,
): Promise<NoiseCheckResult> {
  const dir = mkdtempSync(join(tmpdir(), "subcal-"));
  const stim = join(dir, "stim.wav");
  const rec = join(dir, "rec.wav");
  const gen = kind === "pink" ? genPinkNoise : genWhiteNoise;
  writeWav(stim, gen(seconds));
  const play = playWav(stim, playbackId).catch((e) => ({ code: 1, out: String(e) }));
  await new Promise((res) => setTimeout(res, 250));
  const cap = captureId ?? (await defaultCaptureId());
  await recordWav(rec, seconds + 1, SAMPLE_RATE, cap);
  await play;
  const { samples, sampleRate } = readWav(rec);
  const keepDir = join(process.cwd(), "recordings");
  mkdirSync(keepDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kept = join(keepDir, `noise-check-${stamp}.wav`);
  writeFileSync(kept, readFileSync(rec));
  return { ...analyzeLevel(samples), stimulusFile: stim, recordingFile: kept, sampleRate, seconds, playbackId: playbackId ?? "default", captureId: cap ?? "default" };
}

export async function defaultRate(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("pactl", ["list", "short", "sources"]);
    void stdout;
  } catch {}
  return SAMPLE_RATE;
}
