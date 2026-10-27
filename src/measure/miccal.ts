export interface MicCal {
  sensDb: number;
  serial: string;
  freqs: Float32Array;
  corrDb: Float32Array;
}

export interface CalProvenance {
  fileName: string;
  serial: string;
  orientation: string;
  sensDb: number;
}

export interface ParsedCal {
  cal: MicCal;
  warnings: string[];
}

export function parseMicCal(text: string, fileName: string, expectedSerial?: string): ParsedCal {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  let sensDb: number | null = null;
  let serial = "";
  const freqs: number[] = [];
  const corr: number[] = [];
  let headerSeen = false;
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^"|"$/g, "").trim();
    if (!line) continue;
    if (!headerSeen && /sens\s*factor/i.test(line)) {
      headerSeen = true;
      const sm = /sens\s*factor\s*=\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(line);
      if (!sm) throw new Error(`${fileName}: malformed sensitivity header`);
      sensDb = Number(sm[1]);
      const nm = /SERNO:\s*(\S+)/i.exec(line);
      if (nm) serial = nm[1].replace(/,$/, "");
      continue;
    }
    const parts = line.split(/[\s,;\t]+/).filter(Boolean);
    if (parts.length < 2) throw new Error(`${fileName}: malformed data line "${rawLine.trim()}"`);
    const f = Number(parts[0]);
    const c = Number(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(c) || f <= 0) throw new Error(`${fileName}: malformed data line "${rawLine.trim()}"`);
    freqs.push(f);
    corr.push(c);
  }
  if (sensDb === null) throw new Error(`${fileName}: missing sensitivity header`);
  if (!serial) throw new Error(`${fileName}: missing microphone serial in header`);
  if (freqs.length < 5) throw new Error(`${fileName}: truncated file, only ${freqs.length} data rows`);
  for (let i = 1; i < freqs.length; i++) {
    if (!(freqs[i]! > freqs[i - 1]!)) throw new Error(`${fileName}: frequencies not increasing at row ${i + 1}`);
  }
  if (freqs[0]! > 30 || freqs[freqs.length - 1]! < 18000) {
    throw new Error(`${fileName}: calibration must cover roughly 20Hz-20kHz, covers ${freqs[0]}-${freqs[freqs.length - 1]}Hz`);
  }
  if (expectedSerial && serial !== expectedSerial) {
    warnings.push(`serial mismatch: file is ${serial}, expected ${expectedSerial}`);
  }
  return { cal: { sensDb, serial, freqs: Float32Array.from(freqs), corrDb: Float32Array.from(corr) }, warnings };
}

export function calCorrection(cal: MicCal, freqHz: number): number {
  const { freqs, corrDb } = cal;
  const n = freqs.length;
  if (freqHz <= freqs[0]!) return corrDb[0]!;
  if (freqHz >= freqs[n - 1]!) return corrDb[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (freqs[mid]! <= freqHz) lo = mid;
    else hi = mid;
  }
  const f0 = freqs[lo]!;
  const f1 = freqs[hi]!;
  const t = Math.log(freqHz / f0) / Math.log(f1 / f0);
  return (corrDb[lo] as number) * (1 - t) + (corrDb[hi] as number) * t;
}

export function applyCal(grid: Float32Array, db: Float32Array, cal: MicCal | null): Float32Array {
  if (!cal) return db;
  const out = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = (db[i] as number) - calCorrection(cal, grid[i] as number);
  return out;
}

export function dbfsToSpl(dbfs: number, sensDb: number): number {
  return dbfs - sensDb + 94;
}
