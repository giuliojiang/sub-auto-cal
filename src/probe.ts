import { HidLink } from "./dsp/link.ts";
import { CMD, parsePresetImage } from "./dsp/protocol.ts";

const link = HidLink.open(process.argv[2]);
console.log("opened", link.name);
try {
  const status = await link.query(CMD.status);
  console.log("status reply:", Buffer.from(status.data).toString("hex"), "cksumOk:", status.checksumOk);
  const ver = await link.query(CMD.version);
  console.log("version:", JSON.stringify(new TextDecoder().decode(ver.data)), "cksumOk:", ver.checksumOk);
  try {
    const cfg = await link.query(CMD.config);
    console.log("config:", Buffer.from(cfg.data).toString("hex"));
  } catch (e) {
    console.log("config failed:", String(e));
  }
  const pages: Uint8Array[] = [];
  for (let i = 0; i < 9; i++) {
    const r = await link.query(CMD.readChannel, Uint8Array.of(i));
    console.log(`page ${i}: code=0x${r.code.toString(16)} len=${r.data.length} cksumOk=${r.checksumOk}`);
    pages.push(r.data.slice(1));
  }
  const img = new Uint8Array(450);
  pages.forEach((p, i) => img.set(p.slice(0, 50), i * 50));
  const st = parsePresetImage(img);
  console.log("preset:", JSON.stringify(st.presetName));
  st.outputs.forEach((o, i) => {
    console.log(
      `Out${i + 1} name=${JSON.stringify(o.name)} gain=${o.gainDb}dB route=${o.routingMask} delay=${o.delayMs.toFixed(2)}ms ` +
        `hpf=${o.hpfHz?.toFixed(1) ?? "off"}/${o.hpfSlope} lpf=${o.lpfHz?.toFixed(1) ?? "off"}/${o.lpfSlope} ` +
        `bands=${o.bands.map((b) => `${b.freqHz.toFixed(1)}Hz/${b.q.toFixed(2)}/${b.gainDb.toFixed(1)}dB/t${b.type}`).join(" ")}`,
    );
  });
  const meters = await link.query(CMD.meterPoll);
  console.log("meters raw:", Buffer.from(meters.data).toString("hex"));
} finally {
  link.close();
}
