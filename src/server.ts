import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DspDevice } from "./dsp/device.ts";
import { HidLink, findUsbPath } from "./dsp/link.ts";
import { DspSimulator } from "./dsp/simulator.ts";
import { listAudioDevices, noiseCheck, playWav, recordWav, writeWav, genPinkNoise, genWhiteNoise, readWav, analyzeLevel, waveform, preferCaptureId, defaultCaptureId } from "./audio.ts";
import { LoopRunner } from "./measure/loop.ts";
import { parseMicCal, type MicCal, type CalProvenance } from "./measure/miccal.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pubDir = join(root, "public");

let device: DspDevice | null = null;
let loop: LoopRunner | null = null;
let micCal: { cal: MicCal; prov: CalProvenance } | null = null;

const CHAN_NAMES: Record<string, number> = {
  ina: 0, inb: 1, inc: 2, ind: 3,
  out1: 4, out2: 5, out3: 6, out4: 7,
};

function parseChan(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 8) return v;
  if (typeof v === "string") {
    const n = CHAN_NAMES[v.toLowerCase()];
    if (n !== undefined) return n;
  }
  throw new Error(`bad channel ${JSON.stringify(v)}; use InA-InD, Out1-Out4, or 0-7`);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (d) => (text += d));
    req.on("end", () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function needDevice(): DspDevice {
  if (!device) throw new Error("not connected; POST /api/connect first");
  return device;
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, body: any) => Promise<void>> = {
  "GET /api/status": async (_req, res) => {
    json(res, 200, { connected: device !== null, link: device?.linkName ?? null, usbPath: findUsbPath() });
  },
  "POST /api/connect": async (_req, res, body) => {
    device?.close();
    device = null;
    try {
      const link = body?.simulator ? new DspSimulator() : HidLink.open(body?.path);
      const dev = new DspDevice(link);
      const state = await dev.connect();
      device = dev;
      json(res, 200, { link: link.name, state });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  },
  "POST /api/disconnect": async (_req, res) => {
    device?.close();
    device = null;
    json(res, 200, { ok: true });
  },
  "GET /api/state": async (_req, res) => {
    try {
      json(res, 200, await needDevice().refresh());
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "GET /api/meters": async (_req, res) => {
    try {
      json(res, 200, { meters: await needDevice().meters() });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "POST /api/gain": async (_req, res, body) => {
    try {
      await needDevice().setGain(parseChan(body?.chan), Number(body?.db));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/peq": async (_req, res, body) => {
    try {
      const band = Number(body?.band);
      if (!Number.isInteger(band) || band < 0 || band > 6) throw new Error("band must be 0-6");
      await needDevice().setPeq(parseChan(body?.chan), band, {
        freqHz: Number(body?.freqHz),
        q: Number(body?.q),
        gainDb: Number(body?.gainDb),
        type: Number(body?.type ?? 0),
        bypass: Boolean(body?.bypass),
      });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/gate": async (_req, res, body) => {
    try {
      await needDevice().setGate(parseChan(body?.chan), {
        attackMs: Number(body?.attackMs ?? 0),
        releaseMs: Number(body?.releaseMs ?? 0),
        holdMs: Number(body?.holdMs ?? 0),
        thresholdDb: Number(body?.thresholdDb ?? -90),
      });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/compressor": async (_req, res, body) => {
    try {
      const ratio = Number(body?.ratioIndex ?? 0);
      if (!Number.isInteger(ratio) || ratio < 0 || ratio > 15) throw new Error("ratioIndex must be 0-15");
      await needDevice().setCompressor(parseChan(body?.chan), {
        ratioIndex: ratio,
        kneeDb: Number(body?.kneeDb ?? 0),
        attackMs: Number(body?.attackMs ?? 0),
        releaseMs: Number(body?.releaseMs ?? 0),
        thresholdDb: Number(body?.thresholdDb ?? -90),
      });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/preset": async (_req, res, body) => {
    try {
      const slot = Number(body?.slot);
      if (body?.action === "store") await needDevice().storePreset(slot);
      else await needDevice().recallPreset(slot);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/crossover": async (_req, res, body) => {
    try {
      await needDevice().setCrossover(parseChan(body?.chan), body?.highPass !== false, Number(body?.freqHz), Number(body?.slope));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/delay": async (_req, res, body) => {
    try {
      await needDevice().setDelay(parseChan(body?.chan), Number(body?.ms));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/routing": async (_req, res, body) => {
    try {
      await needDevice().setRouting(parseChan(body?.chan), Number(body?.mask));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/mute": async (_req, res, body) => {
    try {
      await needDevice().setMute(parseChan(body?.chan), Boolean(body?.on));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/polarity": async (_req, res, body) => {
    try {
      await needDevice().setPolarity(parseChan(body?.chan), Boolean(body?.invert));
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/signal": async (_req, res, body) => {
    const sources: Record<string, number> = { off: 0, pink: 1, white: 2, sine: 3 };
    const src = typeof body?.source === "string" ? sources[body.source] : Number(body?.source);
    try {
      if (src === undefined || !Number.isInteger(src) || src < 0 || src > 3) throw new Error("source must be off|pink|white|sine or 0-3");
      await needDevice().signal(src, body?.freqHz !== undefined ? Number(body.freqHz) : undefined);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/snapshot": async (_req, res) => {
    try {
      await needDevice().takeSnapshot();
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "POST /api/revert": async (_req, res) => {
    try {
      json(res, 200, (await needDevice().revert()) ?? { error: "no snapshot taken" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "GET /api/history": async (_req, res) => {
    json(res, 200, device?.history ?? []);
  },
  "POST /api/loop/start": async (_req, res, body) => {
    try {
      if (loop?.running) throw new Error("loop already running; STOP it first");
      if (!device) throw new Error("connect the DSP or simulator first");
      const fStart = Number(body?.fStart ?? 100);
      const fEnd = Number(body?.fEnd ?? 8000);
      if (!(fStart >= 20 && fEnd <= 20000 && fStart < fEnd)) throw new Error("need 20 <= fStart < fEnd <= 20000");
      loop = new LoopRunner({
        fStart,
        fEnd,
        sweepSecs: Math.max(2, Math.min(20, Number(body?.sweepSecs ?? 4))),
        maxIter: Math.max(0, Math.min(200, Number(body?.maxIter ?? 6))),
        playbackId: body?.playbackId,
        captureId: body?.captureId ?? (await defaultCaptureId()),
        getCal: () => micCal,
        getDevice: () => device,
      });
      void loop.run();
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/loop/stop": async (_req, res) => {
    loop?.stop();
    json(res, 200, { ok: true });
  },
  "GET /api/loop/state": async (_req, res) => {
    json(res, 200, loop ? loop.snapshot() : { running: false, timeline: [] });
  },
  "POST /api/miccal/load": async (_req, res, body) => {
    try {
      const fileName = String(body?.fileName ?? "upload.txt");
      const content = String(body?.content ?? "");
      if (!content) throw new Error("empty calibration file");
      const orientation = body?.orientation === "90" ? "90°" : body?.orientation === "0" ? "0°" : "unknown";
      const { cal, warnings } = parseMicCal(content, fileName, body?.expectedSerial ? String(body.expectedSerial) : undefined);
      const prov: CalProvenance = { fileName, serial: cal.serial, orientation, sensDb: cal.sensDb };
      micCal = { cal, prov };
      json(res, 200, { prov, warnings });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "GET /api/miccal/status": async (_req, res) => {
    json(res, 200, micCal ? { loaded: true, prov: micCal.prov } : { loaded: false });
  },
  "GET /api/audio/devices": async (_req, res) => {
    const devs = await listAudioDevices();
    json(res, 200, { ...devs, defaultCapture: preferCaptureId(devs.capture) ?? null });
  },
  "GET /api/audio/waveform": async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const file = basename(url.searchParams.get("file") ?? "");
      if (!file.endsWith(".wav")) throw new Error("unknown recording");
      const path = join(process.cwd(), "recordings", file);
      if (!existsSync(path)) throw new Error("unknown recording");
      const { samples, sampleRate } = readWav(path);
      json(res, 200, { peaks: waveform(samples), sampleRate, seconds: samples.length / sampleRate });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  },
  "POST /api/audio/noise-check": async (_req, res, body) => {
    try {
      const seconds = Math.max(1, Math.min(10, Number(body?.seconds ?? 3)));
      const kind = body?.kind === "white" ? "white" : "pink";
      json(res, 200, await noiseCheck(seconds, kind, body?.playbackId, body?.captureId));
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "POST /api/audio/play": async (_req, res, body) => {
    try {
      const seconds = Math.max(1, Math.min(30, Number(body?.seconds ?? 3)));
      const gen = body?.kind === "white" ? genWhiteNoise : genPinkNoise;
      const path = join(mkdtempSync(join(tmpdir(), "subcal-")), "play.wav");
      writeWav(path, gen(seconds));
      await playWav(path, body?.playbackId);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
  "POST /api/audio/record": async (_req, res, body) => {
    try {
      const seconds = Math.max(1, Math.min(30, Number(body?.seconds ?? 3)));
      const path = join(mkdtempSync(join(tmpdir(), "subcal-")), "rec.wav");
      await recordWav(path, seconds, 48000, body?.captureId ?? (await defaultCaptureId()));
      const { samples, sampleRate } = readWav(path);
      json(res, 200, { ...analyzeLevel(samples), sampleRate, seconds, file: path });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  },
};

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

export function startServer(port = 8080): void {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (route) {
      try {
        await route(req, res, req.method === "POST" ? await readBody(req) : {});
      } catch {
        json(res, 400, { error: "bad request" });
      }
      return;
    }
    const file = join(pubDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!file.startsWith(pubDir) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, "127.0.0.1", () => console.log(`sub-auto-cal on http://127.0.0.1:${port}`));
}
