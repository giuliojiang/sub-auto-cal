import {
  CMD,
  buildRequest,
  checksum,
  parseReply,
  DLE,
  STX,
  ETX,
  type Reply,
} from "./protocol.ts";
import type { DspLink } from "./link.ts";

function ascii(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(new TextEncoder().encode(s).slice(0, len), 0);
  return out;
}

interface SimChannel {
  name: string;
  gainRaw: number;
  polarity: boolean;
  routing: number;
  delay: number;
  hpf: number;
  hpfSlope: number;
  lpf: number;
  lpfSlope: number;
  bands: { gain: number; freq: number; q: number; type: number }[];
  gate: [number, number, number, number];
  comp: [number, number, number, number, number];
}

function makeOut(name: string, id: number): SimChannel {
  return {
    name,
    gainRaw: 280,
    polarity: false,
    routing: 0x0f,
    delay: 0,
    hpf: 0,
    hpfSlope: 0,
    lpf: 0,
    lpfSlope: 0,
    bands: Array.from({ length: 7 }, (_, j) => ({ gain: 120, freq: 60 + j * 10, q: 14, type: 0 })),
    gate: [0, 0, 0, 0],
    comp: [0, 0, 49, 499, 220],
    id,
  } as SimChannel;
}

export class DspSimulator implements DspLink {
  name = "simulator";
  version = "4x4MINI V010 SIM";
  muted: boolean[] = new Array(8).fill(false);
  signal = { source: 0, freq: 0 };
  private outs: SimChannel[] = [makeOut("Out1", 4), makeOut("Out2", 5), makeOut("Out3", 6), makeOut("Out4", 7)];
  private ins = ["InA", "InB", "InC", "InD"].map((name) => ({ name, gainRaw: 280, polarity: false, gate: [49, 499, 99, 0] }));
  private lastWrite: Uint8Array | null = null;

  async write(frame: Uint8Array): Promise<void> {
    this.lastWrite = frame;
    this.apply(frame);
  }

  async command(frame: Uint8Array): Promise<void> {
    await this.write(frame);
  }

  async query(code: number, data = new Uint8Array(0), _timeoutMs = 800): Promise<Reply> {
    await this.write(buildRequest(code, data));
    const report = this.replyFor(code, data);
    return parseReply(report);
  }

  close(): void {}

  private apply(frame: Uint8Array): void {
    const n = frame[4] as number;
    const code = frame[5] as number;
    const data = frame.slice(6, 6 + n - 1);
    const out = (c: number): SimChannel => {
      const ch = this.outs.find((o) => (o as unknown as { id: number }).id === c);
      if (!ch) throw new Error(`sim: unknown channel ${c}`);
      return ch;
    };
    if (code === CMD.level) {
      const c = data[0] as number;
      const raw = (data[1] as number) | ((data[2] as number) << 8);
      if (c < 4) this.ins[c]!.gainRaw = raw;
      else out(c).gainRaw = raw;
    } else if (code === CMD.mute) {
      this.muted[data[0] as number] = data[1] === 1;
    } else if (code === CMD.polarity) {
      const c = data[0] as number;
      if (c < 4) this.ins[c]!.polarity = data[1] === 1;
      else out(c).polarity = data[1] === 1;
    } else if (code === CMD.peqBand) {
      const b = out(data[0] as number).bands[data[1] as number];
      if (!b) throw new Error("sim: bad band");
      b.gain = (data[2] as number) | ((data[3] as number) << 8);
      b.freq = (data[4] as number) | ((data[5] as number) << 8);
      b.q = data[6] as number;
      b.type = data[7] as number;
    } else if (code === CMD.crossoverHpf) {
      const o = out(data[0] as number);
      o.hpf = (data[1] as number) | ((data[2] as number) << 8);
      o.hpfSlope = data[3] as number;
    } else if (code === CMD.crossoverLpf) {
      const o = out(data[0] as number);
      o.lpf = (data[1] as number) | ((data[2] as number) << 8);
      o.lpfSlope = data[3] as number;
    } else if (code === CMD.delay) {
      out(data[0] as number).delay = (data[1] as number) | ((data[2] as number) << 8);
    } else if (code === CMD.routing) {
      out(data[0] as number).routing = data[1] as number;
    } else if (code === CMD.gate) {
      const g = this.ins[data[0] as number]?.gate;
      if (g) {
        g[0] = (data[1] as number) | ((data[2] as number) << 8);
        g[1] = (data[3] as number) | ((data[4] as number) << 8);
        g[2] = (data[5] as number) | ((data[6] as number) << 8);
        g[3] = (data[7] as number) | ((data[8] as number) << 8);
      }
    } else if (code === CMD.compressor) {
      const c = out(data[0] as number).comp;
      c[0] = data[1] as number;
      c[1] = data[2] as number;
      c[2] = (data[3] as number) | ((data[4] as number) << 8);
      c[3] = (data[5] as number) | ((data[6] as number) << 8);
      c[4] = (data[7] as number) | ((data[8] as number) << 8);
    } else if (code === CMD.testSignal) {
      this.signal = { source: data[0] as number, freq: data[1] as number };
    }
  }

  private replyFor(code: number, data: Uint8Array): Uint8Array {
    const payloadOf = (replyCode: number, payload: number[]): Uint8Array => {
      const body = [0x01, 0x00, 1 + payload.length, replyCode, ...payload];
      const out = new Uint8Array(64);
      out.set([DLE, STX, ...body, DLE, ETX, checksum(body)], 0);
      return out;
    };
    if (code === CMD.version) return payloadOf(CMD.version, [...new TextEncoder().encode(this.version)]);
    if (code === CMD.status) return payloadOf(CMD.status, [0x1f]);
    if (code === CMD.flag) return payloadOf(CMD.flag, [0x00]);
    if (code === CMD.config) return payloadOf(CMD.config, [1, 0, 0, 0, 0, 0, 0]);
    if (code === CMD.meterPoll) {
      const bytes: number[] = [];
      for (let i = 0; i < 8; i++) bytes.push(0, 0, this.muted[i] ? 0 : 5);
      return payloadOf(CMD.meterPoll, [1, 0, ...bytes]);
    }
    if (code === CMD.readPresetName) return payloadOf(CMD.readPresetName, [...ascii("Preset", 14)]);
    if (code === CMD.readChannel) {
      const idx = data[0] as number;
      return payloadOf(CMD.channelReply, [idx, ...this.page(idx)]);
    }
    return payloadOf(code, [0x01]);
  }

  private image(): Uint8Array {
    const img = new Uint8Array(450);
    const setStr = (o: number, s: string, len: number) => img.set(ascii(s, len), o);
    const set16 = (o: number, v: number) => {
      img[o] = v & 0xff;
      img[o + 1] = (v >> 8) & 0xff;
    };
    setStr(2, "SimPreset", 14);
    const inBase = [16, 40, 64, 88];
    this.ins.forEach((inp, i) => {
      const b = inBase[i] as number;
      setStr(b, inp.name, 10);
      set16(b + 10, inp.gate[0]);
      set16(b + 12, inp.gate[1]);
      set16(b + 14, inp.gate[2]);
      set16(b + 16, inp.gate[3]);
      set16(b + 18, inp.gainRaw);
      img[b + 20] = inp.polarity ? 1 : 0;
    });
    const outBase = [112, 186, 260, 334];
    this.outs.forEach((o, i) => {
      const b = outBase[i] as number;
      setStr(b, o.name, 8);
      img[b + 8] = o.routing;
      set16(b + 10, o.hpf);
      set16(b + 12, o.lpf);
      img[b + 14] = o.hpfSlope;
      img[b + 15] = o.lpfSlope;
      o.bands.forEach((band, j) => {
        const at = b + 16 + j * 6;
        set16(at, band.gain);
        set16(at + 2, band.freq);
        img[at + 4] = band.q;
        img[at + 5] = band.type;
      });
      img[b + 58] = o.comp[0];
      img[b + 59] = o.comp[1];
      set16(b + 60, o.comp[2]);
      set16(b + 62, o.comp[3]);
      set16(b + 64, o.comp[4]);
      set16(b + 66, o.gainRaw);
      img[b + 68] = o.polarity ? 1 : 0;
      set16(b + 70, o.delay);
    });
    return img;
  }

  private page(idx: number): number[] {
    return [...this.image().slice(idx * 50, idx * 50 + 50)];
  }
}
