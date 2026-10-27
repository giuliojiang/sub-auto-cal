import { createRequire } from "node:module";
import { parseReply, type Reply } from "./protocol.ts";

const require = createRequire(import.meta.url);

export interface DspLink {
  name: string;
  write(frame: Uint8Array): Promise<void>;
  query(code: number, data?: Uint8Array, timeoutMs?: number): Promise<Reply>;
  close(): void;
}

export function findUsbPath(): string | null {
  try {
    const hid = require("node-hid") as {
      devices(): { vendorId: number; productId: number; path?: string }[];
    };
    const dev = hid.devices().find((d) => d.vendorId === 0x0168 && d.productId === 0x0821);
    return dev?.path ?? null;
  } catch {
    return null;
  }
}

export class HidLink implements DspLink {
  name: string;
  private dev: {
    write(values: number[]): number;
    readTimeout(ms: number): number[];
    close(): void;
  };

  private constructor(dev: HidLink["dev"], name: string) {
    this.dev = dev;
    this.name = name;
  }

  static open(path?: string): HidLink {
    const hid = require("node-hid") as {
      HID: new (path: string) => HidLink["dev"];
      devices(): { vendorId: number; productId: number; path?: string }[];
    };
    const p = path ?? hid.devices().find((d) => d.vendorId === 0x0168 && d.productId === 0x0821)?.path;
    if (!p) throw new Error("dsp not found: no USB device 0168:0821 present");
    try {
      return new HidLink(new hid.HID(p), `usb:${p}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot open ${p} (${msg}); missing permission, add a udev rule for 0168:0821`);
    }
  }

  async write(frame: Uint8Array): Promise<void> {
    this.dev.write([...frame]);
  }

  async query(code: number, data = new Uint8Array(0), timeoutMs = 800): Promise<Reply> {
    const { buildRequest } = await import("./protocol.ts");
    await this.write(buildRequest(code, data));
    const raw = this.dev.readTimeout(timeoutMs);
    if (raw.length === 0) throw new Error(`no reply to 0x${code.toString(16)} within ${timeoutMs}ms`);
    return parseReply(Uint8Array.from(raw));
  }

  close(): void {
    this.dev.close();
  }
}
