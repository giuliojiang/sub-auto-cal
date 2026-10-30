import { createRequire } from "node:module";
import { parseReply, type Reply } from "./protocol.ts";

const require = createRequire(import.meta.url);

export interface DspLink {
  name: string;
  write(frame: Uint8Array): Promise<void>;
  command(frame: Uint8Array): Promise<void>;
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
  private path: string;
  private dev: {
    write(values: number[]): number;
    readTimeout(ms: number): number[];
    close(): void;
  };

  private constructor(dev: HidLink["dev"], path: string) {
    this.dev = dev;
    this.path = path;
    this.name = `usb:${path}`;
  }

  static open(path?: string): HidLink {
    const p = path ?? HidLink.findPath();
    if (!p) throw new Error("dsp not found: no USB device 0168:0821 present");
    return new HidLink(HidLink.openHandle(p), p);
  }

  private static findPath(): string | null {
    const hid = require("node-hid") as {
      devices(): { vendorId: number; productId: number; path?: string }[];
    };
    return hid.devices().find((d) => d.vendorId === 0x0168 && d.productId === 0x0821)?.path ?? null;
  }

  private static openHandle(p: string): HidLink["dev"] {
    const hid = require("node-hid") as {
      HID: new (path: string) => HidLink["dev"];
    };
    try {
      return new hid.HID(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot open ${p} (${msg}); missing permission, add a udev rule for 0168:0821`);
    }
  }

  private reopen(): void {
    try {
      this.dev.close();
    } catch {}
    this.path = HidLink.findPath() ?? this.path;
    this.name = `usb:${this.path}`;
    this.dev = HidLink.openHandle(this.path);
  }

  private lastOk = 0;
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async wake(): Promise<void> {
    const { buildRequest, parseReply } = await import("./protocol.ts");
    const frame = buildRequest(0x10);
    this.dev.write([0x00, ...frame]);
    const raw = this.dev.readTimeout(800);
    if (raw.length === 0) throw new Error("timeout");
    parseReply(Uint8Array.from(raw));
    this.lastOk = Date.now();
  }

  async write(frame: Uint8Array): Promise<void> {
    this.dev.write([0x00, ...frame]);
  }

  async command(frame: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      if (Date.now() - this.lastOk > 10000) {
        try {
          await this.wake();
        } catch {
          this.reopen();
        }
      }
      this.dev.write([0x00, ...frame]);
      let ack: number[] = [];
      try {
        ack = this.dev.readTimeout(500);
      } catch {}
      if (ack.length === 0) {
        this.reopen();
        this.dev.write([0x00, ...frame]);
        try {
          this.dev.readTimeout(500);
        } catch {}
      } else {
        this.lastOk = Date.now();
      }
    });
  }

  private attempt(code: number, frame: Uint8Array, timeoutMs: number): Reply {
    this.dev.write([0x00, ...frame]);
    let raw = this.dev.readTimeout(timeoutMs);
    if (raw.length === 0) throw new Error("timeout");
    let reply = parseReply(Uint8Array.from(raw));
    if (reply.code === 0x01 && code !== 0x01) {
      const raw2 = this.dev.readTimeout(timeoutMs);
      if (raw2.length === 0) throw new Error("timeout");
      reply = parseReply(Uint8Array.from(raw2));
    }
    return reply;
  }

  async query(code: number, data = new Uint8Array(0), timeoutMs = 800): Promise<Reply> {
    return this.enqueue(async () => {
      const { buildRequest } = await import("./protocol.ts");
      if (Date.now() - this.lastOk > 10000 && code !== 0x10) {
        try {
          await this.wake();
        } catch {
          this.reopen();
        }
      }
      const frame = buildRequest(code, data);
      try {
        const r = this.attempt(code, frame, timeoutMs);
        this.lastOk = Date.now();
        return r;
      } catch {
        await new Promise((res) => setTimeout(res, 400));
        try {
          const r = this.attempt(code, frame, timeoutMs);
          this.lastOk = Date.now();
          return r;
        } catch {
          this.reopen();
          const r = this.attempt(code, frame, timeoutMs);
          this.lastOk = Date.now();
          return r;
        }
      }
    });
  }

  close(): void {
    this.dev.close();
  }
}
