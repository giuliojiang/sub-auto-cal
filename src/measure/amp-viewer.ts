export interface AmpViewerCandidate {
  strategy: string;
  strategies: string[];
  bands: { frequencyHz: number; q: number; gainDb: number }[];
  rms: number;
  maxAbs: number;
  maxBoost: number;
  grid: number[];
  predicted: number[];
}

export interface AmpViewerData {
  run: {
    date: string;
    mode: string;
    micSerial: string;
    micFile: string;
    sweepSecs: number;
    channel?: string;
    outputs: number[];
    fitRange: [number, number];
    uncorrectedRms: number;
    strategies: string[];
    seed: number;
    samples: number;
    applied: boolean;
    verified: boolean;
    storePreset: number | null;
    dryRun: boolean;
  };
  target: { grid: number[]; db: number[] };
  measurement: { grid: number[]; db: number[] };
  candidates: AmpViewerCandidate[];
  snapshot: {
    presetName: string;
    outputs: {
      name: string;
      gainDb: number;
      routingMask: number;
      delayMs: number;
      hpfHz: number | null;
      hpfSlope: number;
      lpfHz: number | null;
      lpfSlope: number;
      bands: { freqHz: number; q: number; gainDb: number; type: number }[];
    }[];
  } | null;
  applied: { bands: { frequencyHz: number; q: number; gainDb: number }[]; readbackOk: boolean; mismatches: string[] } | null;
  verified: { grid: number[]; db: number[] } | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bandRows(bands: { frequencyHz: number; q: number; gainDb: number }[]): string {
  return bands
    .map((b) => `<tr><td>${b.frequencyHz}</td><td>${b.q}</td><td>${b.gainDb}</td></tr>`)
    .join("\n");
}

export function renderAmpViewer(data: AmpViewerData): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const rows = data.candidates
    .map(
      (c) =>
        `<tr><td>${esc(c.strategy)}</td><td>${c.bands.length}</td><td>${c.rms.toFixed(2)}</td><td>${c.maxAbs.toFixed(2)}</td><td>${c.maxBoost.toFixed(2)}</td><td>${esc(c.strategies.join(", "))}</td></tr>`,
    )
    .join("\n");
  const sections = data.candidates
    .map((c, i) => {
      return `<section><h2>${i + 1}. ${esc(c.strategy)} — RMS ${c.rms.toFixed(2)} dB, max ${c.maxAbs.toFixed(2)} dB, boost ${c.maxBoost.toFixed(2)} dB, ${c.bands.length} bands</h2><canvas id="amp-c${i}" width="900" height="320"></canvas><table><thead><tr><th>Freq Hz</th><th>Q</th><th>Gain dB</th></tr></thead><tbody>${bandRows(c.bands)}</tbody></table></section>`;
    })
    .join("\n");
  const snap = data.snapshot
    ? `<h2>Pre-run DSP snapshot</h2><table><thead><tr><th>Out</th><th>Name</th><th>Gain dB</th><th>Route</th><th>Delay ms</th><th>HPF</th><th>LPF</th><th>Bands</th></tr></thead><tbody>${data.snapshot.outputs
        .map(
          (o, i) =>
            `<tr><td>${i + 1}</td><td>${esc(o.name)}</td><td>${o.gainDb}</td><td>${o.routingMask}</td><td>${o.delayMs.toFixed(2)}</td><td>${o.hpfHz === null ? "off" : `${o.hpfHz.toFixed(1)}/${o.hpfSlope}`}</td><td>${o.lpfHz === null ? "off" : `${o.lpfHz.toFixed(1)}/${o.lpfSlope}`}</td><td>${esc(o.bands.map((b) => `${b.freqHz.toFixed(1)}/${b.q.toFixed(2)}/${b.gainDb.toFixed(1)}`).join(" "))}</td></tr>`,
        )
        .join("\n")}</tbody></table>`
    : `<p>No DSP snapshot recorded for this run.</p>`;
  const applied = data.applied
    ? `<h2>Applied settings</h2><p>Readback ${data.applied.readbackOk ? "verified on all four outputs" : `FAILED: ${esc(data.applied.mismatches.join(", "))}`}</p><table><thead><tr><th>Freq Hz</th><th>Q</th><th>Gain dB</th></tr></thead><tbody>${bandRows(data.applied.bands)}</tbody></table><p>Same band set written to Out1–Out4; unused slots left flat at 0 dB with pre-run types preserved.</p>`
    : `<p>Dry run — nothing was written to the DSP.</p>`;
  const modeLine = data.run.dryRun ? "dry-run, DSP untouched" : "applied to Out1–Out4";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Amp full-range candidates — ${esc(data.run.date)}</title>
<style>
body{font-family:sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #999;padding:4px 8px;text-align:right}
th{background:#eee}
canvas{border:1px solid #999;width:100%;max-width:900px}
section{margin-top:28px}
.badge{display:inline-block;border:1px solid #111;padding:2px 8px;margin-left:8px}
</style>
</head>
<body>
<h1>Amp full-range PEQ candidates <span class="badge">${esc(modeLine)}</span></h1>
<p>Date ${esc(data.run.date)} · mic ${esc(data.run.micSerial)} (${esc(data.run.micFile)}) · sweep ${data.run.sweepSecs}s${data.run.channel ? ` · ch ${esc(data.run.channel)}` : ""} · outputs ${esc(data.run.outputs.join(", "))} · fit ${data.run.fitRange[0]}–${data.run.fitRange[1]} Hz · uncorrected RMS ${data.run.uncorrectedRms.toFixed(2)} dB · seed ${data.run.seed} · samples ${data.run.samples}${data.run.storePreset !== null ? ` · preset slot ${data.run.storePreset}` : ""}</p>
<h2>Summary (sorted by predicted residual RMS)</h2>
<table><thead><tr><th>Strategy</th><th>Bands</th><th>RMS dB</th><th>Max abs dB</th><th>Max boost dB</th><th>Converged</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Overview — all predicted curves plus anchored target</h2>
<canvas id="amp-overview" width="900" height="340"></canvas>
${sections}
${snap}
${applied}
<script>
const DATA = ${payload};
function drawChart(id, series){
  const cv = document.getElementById(id);
  if(!cv) return;
  const ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height, padL = 52, padR = 12, padT = 12, padB = 28;
  let lo = Infinity, hi = -Infinity;
  for(const s of series) for(const v of s.y){ if(v < lo) lo = v; if(v > hi) hi = v; }
  if(!isFinite(lo)){ lo = -10; hi = 10; }
  const span = Math.max(1, hi - lo);
  lo -= span * 0.1; hi += span * 0.1;
  const yOf = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#ddd";
  ctx.fillStyle = "#333";
  ctx.font = "11px sans-serif";
  const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for(const f of freqTicks){
    const l = Math.log10(20), hh = Math.log10(20000);
    const x = padL + (Math.log10(f) - l) / (hh - l) * (w - padL - padR);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
    ctx.fillText(String(f), f >= 20000 ? x - 34 : x - 10, h - 10);
  }
  const step = span > 30 ? 10 : span > 12 ? 5 : 2;
  for(let v = Math.ceil(lo / step) * step; v <= hi; v += step){
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(0), 8, y + 4);
  }
  const colors = ["#888", "#c00", "#06c", "#090", "#c60", "#939", "#099", "#333"];
  series.forEach((s, si) => {
    ctx.strokeStyle = colors[si % colors.length];
    ctx.lineWidth = si === 0 ? 2 : 1.5;
    ctx.beginPath();
    for(let i = 0; i < s.x.length; i++){
      const l = Math.log10(20), hh = Math.log10(20000);
      const x = padL + (Math.log10(s.x[i]) - l) / (hh - l) * (w - padL - padR);
      const y = yOf(s.y[i]);
      if(i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  let ly = 16;
  ctx.font = "12px sans-serif";
  for(let si = 0; si < series.length; si++){
    ctx.fillStyle = colors[si % colors.length];
    ctx.fillRect(w - 200, ly - 10, 18, 3);
    ctx.fillStyle = "#111";
    ctx.fillText(series[si].name, w - 178, ly - 2);
    ly += 16;
  }
}
(function(){
  const t = { name: "anchored target", x: DATA.target.grid, y: DATA.target.db };
  const m = { name: "measured", x: DATA.measurement.grid, y: DATA.measurement.db };
  const over = [t].concat(DATA.candidates.map((c) => ({ name: c.strategy, x: c.grid, y: c.predicted })));
  if(DATA.verified) over.push({ name: "verified", x: DATA.verified.grid, y: DATA.verified.db });
  drawChart("amp-overview", over);
  DATA.candidates.forEach((c, i) => {
    const series = [m, t, { name: c.strategy + " predicted", x: c.grid, y: c.predicted }];
    if(DATA.verified) series.push({ name: "verified", x: DATA.verified.grid, y: DATA.verified.db });
    drawChart("amp-c" + i, series);
  });
})();
</script>
</body>
</html>
`;
}
