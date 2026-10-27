import {
  CMD,
  crossoverFrame,
  delayFrame,
  levelsFromReply,
  muteFrame,
  parsePresetImage,
  peqFrame,
  polarityFrame,
  levelFrame,
  routingFrame,
  signalFrame,
  type DeviceState,
  type PeqParams,
} from "./protocol.ts";
import type { DspLink } from "./link.ts";

export type { DeviceState, PeqParams };

export interface SentRecord {
  time: string;
  target: string;
  what: string;
}

export class DspDevice {
  private sent: SentRecord[] = [];
  private state: DeviceState | null = null;
  private snapshot: DeviceState | null = null;
  private link: DspLink;

  constructor(link: DspLink) {
    this.link = link;
  }

  get linkName(): string {
    return this.link.name;
  }

  get current(): DeviceState | null {
    return this.state;
  }

  get history(): SentRecord[] {
    return this.sent;
  }

  private log(what: string): void {
    this.sent.push({ time: new Date().toISOString(), target: this.link.name, what });
  }

  async connect(): Promise<DeviceState> {
    await this.link.query(CMD.status);
    let version = "";
    try {
      const v = await this.link.query(CMD.version);
      version = new TextDecoder().decode(v.data).replace(/\0/g, "").trim();
    } catch {
      version = "unknown";
    }
    try {
      await this.link.query(CMD.config);
    } catch {}
    try {
      await this.link.query(CMD.flagsBlock);
    } catch {}
    try {
      await this.link.query(CMD.flag);
    } catch {}
    try {
      await this.link.query(CMD.readPresetName, Uint8Array.of(0));
    } catch {}
    await this.refresh();
    try {
      await this.link.query(CMD.initDone);
    } catch {}
    if (this.state) this.state.version = version;
    await this.signal(0);
    return this.state as DeviceState;
  }

  async refresh(): Promise<DeviceState> {
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await this.link.query(CMD.readChannel, Uint8Array.of(i));
      pages.push(r.data.slice(1));
    }
    const img = new Uint8Array(450);
    pages.forEach((p, i) => img.set(p.slice(0, 50), i * 50));
    const parsed = parsePresetImage(img);
    const version = this.state?.version ?? "";
    const meters = await this.meters().catch(() => [0, 0, 0, 0, 0, 0, 0, 0]);
    this.state = { ...parsed, version, meters };
    return this.state;
  }

  async meters(): Promise<number[]> {
    const r = await this.link.query(CMD.meterPoll);
    return levelsFromReply(r) ?? [0, 0, 0, 0, 0, 0, 0, 0];
  }

  async setGain(chan: number, db: number): Promise<void> {
    await this.link.write(levelFrame(chan, db));
    this.log(`gain ch=${chan} db=${db}`);
  }

  async setPeq(chan: number, band: number, p: PeqParams): Promise<void> {
    await this.link.write(peqFrame(chan, band, p));
    this.log(`peq ch=${chan} band=${band} ${p.freqHz}Hz q=${p.q} ${p.gainDb}dB type=${p.type}`);
  }

  async setCrossover(chan: number, highPass: boolean, freqHz: number, slope: number): Promise<void> {
    await this.link.write(crossoverFrame(highPass, chan, freqHz, slope));
    this.log(`xover ch=${chan} ${highPass ? "hpf" : "lpf"} ${freqHz}Hz slope=${slope}`);
  }

  async setDelay(chan: number, ms: number): Promise<void> {
    await this.link.write(delayFrame(chan, ms));
    this.log(`delay ch=${chan} ms=${ms}`);
  }

  async setRouting(outChan: number, inputMask: number): Promise<void> {
    await this.link.write(routingFrame(outChan, inputMask));
    this.log(`routing ch=${outChan} mask=${inputMask}`);
  }

  async setMute(chan: number, on: boolean): Promise<void> {
    await this.link.write(muteFrame(chan, on));
    this.log(`mute ch=${chan} on=${on}`);
  }

  async setPolarity(chan: number, invert: boolean): Promise<void> {
    await this.link.write(polarityFrame(chan, invert));
    this.log(`polarity ch=${chan} invert=${invert}`);
  }

  async signal(source: number, freqHz?: number): Promise<void> {
    await this.link.write(signalFrame(source, freqHz));
    this.log(`signal source=${source}${freqHz ? ` hz=${freqHz}` : ""}`);
  }

  async takeSnapshot(): Promise<void> {
    this.snapshot = await this.refresh();
  }

  async revert(): Promise<DeviceState | null> {
    const s = this.snapshot;
    if (!s) return null;
    for (let i = 0; i < 4; i++) {
      await this.setGain(i, s.inputs[i]!.gainDb);
      if (s.inputs[i]!.polarity) await this.setPolarity(i, true);
    }
    for (let o = 0; o < 4; o++) {
      const ch = 4 + o;
      const out = s.outputs[o]!;
      await this.setGain(ch, out.gainDb);
      await this.setPolarity(ch, out.polarity);
      await this.setRouting(ch, out.routingMask);
      await this.setDelay(ch, out.delayMs);
      for (let b = 0; b < 7; b++) {
        const band = out.bands[b]!;
        await this.setPeq(ch, b, { freqHz: band.freqHz, q: band.q, gainDb: band.gainDb, type: band.type });
      }
    }
    return this.refresh();
  }

  close(): void {
    this.link.close();
  }
}
