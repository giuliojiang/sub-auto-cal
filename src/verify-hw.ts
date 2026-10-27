import { HidLink } from "./dsp/link.ts";
import { DspDevice } from "./dsp/device.ts";

const dev = new DspDevice(HidLink.open(process.argv[2]));
try {
  const st0 = await dev.connect();
  console.log("connected:", dev.linkName, "version:", JSON.stringify(st0.version));
  await dev.takeSnapshot();
  await dev.setGain(7, -6);
  await dev.setPeq(7, 0, { freqHz: 100, q: 1.4, gainDb: -3, type: 0 });
  await dev.setPeq(7, 1, { freqHz: 1000, q: 7.1, gainDb: -12, type: 0 });
  await dev.setDelay(7, 1.46);
  await dev.setCrossover(7, true, 80, 10);
  await dev.setRouting(7, 5);
  const st = await dev.refresh();
  const o = st.outputs[3]!;
  console.log("gain:", o.gainDb, "delay:", o.delayMs.toFixed(3), "route:", o.routingMask);
  console.log("hpf:", o.hpfHz?.toFixed(2), o.hpfSlope);
  o.bands.slice(0, 2).forEach((b, i) => console.log(`band${i}:`, b.freqHz.toFixed(2), "q=", b.q.toFixed(2), "gain=", b.gainDb));
  await dev.revert();
  const back = await dev.refresh();
  const r = back.outputs[3]!;
  console.log("reverted gain:", r.gainDb, "route:", r.routingMask, "band0 gain:", r.bands[0]!.gainDb);
} finally {
  dev.close();
}
