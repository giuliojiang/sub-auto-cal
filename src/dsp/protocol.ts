export const DLE = 0x10;
export const STX = 0x02;
export const ETX = 0x03;
export const USB_ADDR = 0x01;
export const REPORT_SIZE = 64;

export const CMD = {
  status: 0x10,
  initDone: 0x12,
  version: 0x13,
  flag: 0x14,
  recallPreset: 0x20,
  storePreset: 0x21,
  flagsBlock: 0x22,
  channelReply: 0x24,
  setName: 0x26,
  readChannel: 0x27,
  readPresetName: 0x29,
  config: 0x2c,
  password: 0x2f,
  compressor: 0x30,
  crossoverLpf: 0x31,
  crossoverHpf: 0x32,
  peqBand: 0x33,
  level: 0x34,
  mute: 0x35,
  polarity: 0x36,
  delay: 0x38,
  testSignal: 0x39,
  routing: 0x3a,
  gate: 0x3e,
  meterPoll: 0x40,
  versionLong: 0x52,
} as const;

export const CH = {
  inA: 0x00,
  inB: 0x01,
  inC: 0x02,
  inD: 0x03,
  out1: 0x04,
  out2: 0x05,
  out3: 0x06,
  out4: 0x07,
} as const;

export const SLOPE = {
  bypass: 0x00,
  bw6: 0x01,
  bl6: 0x02,
  bw12: 0x03,
  bl12: 0x04,
  lk12: 0x05,
  bw18: 0x06,
  bl18: 0x07,
  bw24: 0x08,
  bl24: 0x09,
  lk24: 0x0a,
} as const;

export const PEQ_TYPE = {
  peak: 0,
  lowShelf: 1,
  highShelf: 2,
  lowCut: 3,
  highCut: 4,
  allpass1: 5,
  allpass2: 6,
} as const;

export const SIGNAL = { off: 0, pink: 1, white: 2, sine: 3 } as const;

export const SINE_FREQS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
  6300, 8000, 10000, 12500, 16000, 20000,
] as const;

export function checksum(payload: ArrayLike<number>): number {
  let x = 0;
  for (let i = 0; i < payload.length; i++) x ^= payload[i] as number;
  return (x ^ 1) & 0xff;
}

export function buildRequest(code: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const payload = [0x00, USB_ADDR, 1 + data.length, code & 0xff, ...data];
  const out = new Uint8Array(REPORT_SIZE);
  out.set([DLE, STX, ...payload, DLE, ETX, checksum(payload)], 0);
  return out;
}

export interface Reply {
  code: number;
  data: Uint8Array;
  checksumOk: boolean;
}

export function parseReply(report: Uint8Array): Reply {
  if (report[0] !== DLE || report[1] !== STX) throw new Error("bad frame header");
  const n = report[4] as number;
  const payload = report.slice(2, 2 + n + 3);
  const ok =
    report[2 + n + 3] === DLE &&
    report[3 + n + 3] === ETX &&
    report[4 + n + 3] === checksum(payload);
  return { code: payload[3] as number, data: payload.slice(4, 3 + n), checksumOk: ok };
}

export function frameHex(frame: Uint8Array): string {
  const len = (frame[4] as number) + 8;
  return [...frame.slice(0, len)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

export const GAIN_ZERO_RAW = 281;
export const GAIN_PER_DB = 10;
export const GAIN_MAX_RAW = 400;

export function gainDbToRaw(db: number): number {
  return Math.max(0, Math.min(GAIN_MAX_RAW, Math.round(GAIN_ZERO_RAW + db * GAIN_PER_DB)));
}

export function gainRawToDb(raw: number): number {
  return (raw - GAIN_ZERO_RAW) / GAIN_PER_DB;
}

export function peqGainDbToRaw(db: number): number {
  return Math.max(0, Math.min(240, Math.round(120 + db * 10)));
}

export function peqGainRawToDb(raw: number): number {
  return (raw - 120) / 10;
}

export const FREQ_REF_HZ = 19.7;
export const FREQ_STEPS_PER_OCT = 30;
export const FREQ_IDX_MAX = 300;

export function hzToFreqIndex(hz: number): number {
  return Math.max(0, Math.min(FREQ_IDX_MAX, Math.round(FREQ_STEPS_PER_OCT * Math.log2(hz / FREQ_REF_HZ))));
}

export function freqIndexToHz(idx: number): number {
  return FREQ_REF_HZ * Math.pow(2, idx / FREQ_STEPS_PER_OCT);
}

export function qToRaw(q: number): number {
  return Math.max(0, Math.min(255, Math.round(q * 10)));
}

export function rawToQ(raw: number): number {
  return raw / 10;
}

export function thresholdDbToRaw(db: number): number {
  return Math.round((db + 90) * 2);
}

export function thresholdRawToDb(raw: number): number {
  return raw / 2 - 90;
}

export const DELAY_MAX_SAMPLES = 32640;

export function msToDelaySamples(ms: number): number {
  return Math.max(0, Math.min(DELAY_MAX_SAMPLES, Math.round(ms * 48)));
}

export function delaySamplesToMs(s: number): number {
  return s / 48;
}

function u16le(v: number): [number, number] {
  return [v & 0xff, (v >> 8) & 0xff];
}

export function muteFrame(chan: number, on: boolean): Uint8Array {
  return buildRequest(CMD.mute, Uint8Array.of(chan & 0xff, on ? 1 : 0));
}

export function polarityFrame(chan: number, invert: boolean): Uint8Array {
  return buildRequest(CMD.polarity, Uint8Array.of(chan & 0xff, invert ? 1 : 0));
}

export function levelFrame(chan: number, db: number): Uint8Array {
  return buildRequest(CMD.level, Uint8Array.of(chan & 0xff, ...u16le(gainDbToRaw(db))));
}

export interface PeqParams {
  freqHz: number;
  q: number;
  gainDb: number;
  type: number;
  bypass?: boolean;
}

export function peqFrame(chan: number, band: number, p: PeqParams): Uint8Array {
  return buildRequest(
    CMD.peqBand,
    Uint8Array.of(
      chan & 0xff,
      band & 0xff,
      ...u16le(peqGainDbToRaw(p.gainDb)),
      ...u16le(hzToFreqIndex(p.freqHz)),
      qToRaw(p.q) & 0xff,
      p.type & 0xff,
      p.bypass ? 1 : 0,
    ),
  );
}

export function crossoverFrame(highPass: boolean, chan: number, freqHz: number, slope: number): Uint8Array {
  return buildRequest(
    highPass ? CMD.crossoverHpf : CMD.crossoverLpf,
    Uint8Array.of(chan & 0xff, ...u16le(hzToFreqIndex(freqHz)), slope & 0xff),
  );
}

export function delayFrame(chan: number, ms: number): Uint8Array {
  return buildRequest(CMD.delay, Uint8Array.of(chan & 0xff, ...u16le(msToDelaySamples(ms))));
}

export function routingFrame(outChan: number, inputMask: number): Uint8Array {
  return buildRequest(CMD.routing, Uint8Array.of(outChan & 0xff, inputMask & 0xff));
}

export function signalFrame(source: number, freqHz?: number): Uint8Array {
  let idx = 0;
  if (freqHz !== undefined) {
    let best = 0;
    for (let i = 0; i < SINE_FREQS.length; i++) {
      if (Math.abs(Math.log((SINE_FREQS[i] as number) / freqHz)) < Math.abs(Math.log((SINE_FREQS[best] as number) / freqHz))) best = i;
    }
    idx = best;
  }
  return buildRequest(CMD.testSignal, Uint8Array.of(source & 0xff, idx & 0xff));
}

export function pollFrame(): Uint8Array {
  return buildRequest(CMD.meterPoll);
}

export function statusFrame(): Uint8Array {
  return buildRequest(CMD.status);
}

export function versionFrame(): Uint8Array {
  return buildRequest(CMD.version);
}

export function readChannelFrame(index: number): Uint8Array {
  return buildRequest(CMD.readChannel, Uint8Array.of(index & 0xff));
}

export function recallPresetFrame(slot: number): Uint8Array {
  return buildRequest(CMD.recallPreset, Uint8Array.of(slot & 0xff));
}

export function storePresetFrame(slot: number): Uint8Array {
  return buildRequest(CMD.storePreset, Uint8Array.of(slot & 0xff));
}

export interface ChannelState {
  name: string;
  gainDb: number;
  polarity: boolean;
  routingMask: number;
  delayMs: number;
  hpfHz: number | null;
  hpfSlope: number;
  lpfHz: number | null;
  lpfSlope: number;
  bands: { freqHz: number; q: number; gainDb: number; type: number }[];
}

export interface DeviceState {
  version: string;
  inputs: { name: string; gainDb: number; polarity: boolean }[];
  outputs: ChannelState[];
  meters: number[];
}

function decodeStr(b: Uint8Array, off: number, len: number): string {
  let end = off + len;
  for (let i = off; i < off + len; i++) {
    if (b[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(b.slice(off, end)).trim();
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}

export function parsePresetImage(img: Uint8Array): { presetName: string; inputs: DeviceState["inputs"]; outputs: ChannelState[] } {
  const inputs = [16, 40, 64, 88].map((base) => ({
    name: decodeStr(img, base, 10),
    gainDb: gainRawToDb(u16(img, base + 18)),
    polarity: img[base + 20] !== 0,
  }));
  const outputs = [112, 186, 260, 334].map((base) => {
    const hpfRaw = u16(img, base + 10);
    const lpfRaw = u16(img, base + 12);
    const hpfSlope = img[base + 14] as number;
    const lpfSlope = img[base + 15] as number;
    return {
      name: decodeStr(img, base, 8),
      gainDb: gainRawToDb(u16(img, base + 66)),
      polarity: img[base + 68] !== 0,
      routingMask: img[base + 8] as number,
      delayMs: delaySamplesToMs(u16(img, base + 70)),
      hpfHz: hpfSlope === 0 ? null : freqIndexToHz(hpfRaw),
      hpfSlope,
      lpfHz: lpfSlope === 0 ? null : freqIndexToHz(lpfRaw),
      lpfSlope,
      bands: Array.from({ length: 7 }, (_, j) => {
        const o = base + 16 + j * 6;
        return {
          gainDb: peqGainRawToDb(u16(img, o)),
          freqHz: freqIndexToHz(u16(img, o + 2)),
          q: rawToQ(img[o + 4] as number),
          type: img[o + 5] as number,
        };
      }),
    };
  });
  return { presetName: decodeStr(img, 2, 14), inputs, outputs };
}

export function levelsFromReply(r: Reply): number[] | null {
  if (r.code !== CMD.meterPoll || r.data.length < 24) return null;
  return Array.from({ length: 8 }, (_, i) => (r.data[2 + 3 * i] as number) / 72);
}
