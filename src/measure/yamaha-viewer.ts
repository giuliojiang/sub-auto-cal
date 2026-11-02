export interface ViewerCandidate {
  strategy: string;
  strategies: string[];
  bands: { frequencyHz: number; q: number; gainDb: number }[];
  rms: number;
  maxAbs: number;
  maxBoost: number;
  grid: number[];
  predicted: number[];
}

export interface ViewerData {
  run: {
    date: string;
    micSerial: string;
    micFile: string;
    sweepSecs: number;
    fitRange: [number, number];
    uncorrectedRms: number;
    strategies: string[];
    seed: number;
    samples: number;
  };
  target: { grid: number[]; db: number[] };
  measurement: { grid: number[]; db: number[] };
  candidates: ViewerCandidate[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderYamahaViewer(data: ViewerData): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const rows = data.candidates
    .map(
      (c) =>
        `<tr><td>${esc(c.strategy)}</td><td>${c.bands.length}</td><td>${c.rms.toFixed(2)}</td><td>${c.maxAbs.toFixed(2)}</td><td>${c.maxBoost.toFixed(2)}</td><td>${esc(c.strategies.join(", "))}</td></tr>`,
    )
    .join("\n");
  const sections = data.candidates
    .map((c, i) => {
      const frows = c.bands
        .map((b) => `<tr><td>${b.frequencyHz}</td><td>${b.q}</td><td>${b.gainDb}</td></tr>`)
        .join("\n");
      return `<section><h2>${i + 1}. ${esc(c.strategy)} — RMS ${c.rms.toFixed(2)} dB, max ${c.maxAbs.toFixed(2)} dB, boost ${c.maxBoost.toFixed(2)} dB, ${c.bands.length} bands</h2><canvas id="yam-c${i}" width="900" height="320"></canvas><table><thead><tr><th>Freq Hz</th><th>Q</th><th>Gain dB</th></tr></thead><tbody>${frows}</tbody></table></section>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Yamaha manual PEQ candidates — ${esc(data.run.date)}</title>
<style>
body{font-family:sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #999;padding:4px 8px;text-align:right}
th{background:#eee}
canvas{border:1px solid #999;width:100%;max-width:900px}
section{margin-top:28px}
</style>
</head>
<body>
<h1>Yamaha manual-PEQ candidates</h1>
<p>Date ${esc(data.run.date)} · mic ${esc(data.run.micSerial)} (${esc(data.run.micFile)}) · sweep ${data.run.sweepSecs}s · fit ${data.run.fitRange[0]}–${data.run.fitRange[1]} Hz · uncorrected RMS ${data.run.uncorrectedRms.toFixed(2)} dB · seed ${data.run.seed} · samples ${data.run.samples}</p>
<h2>Summary (sorted by predicted residual RMS)</h2>
<table><thead><tr><th>Strategy</th><th>Bands</th><th>RMS dB</th><th>Max abs dB</th><th>Max boost dB</th><th>Converged</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Overview — all predicted curves plus anchored target</h2>
<canvas id="yam-overview" width="900" height="340"></canvas>
${sections}
<script>
const DATA = ${payload};
function xOf(f, w, pad){ const lo = Math.log10(20), hi = Math.log10(20000); return pad + (Math.log10(f) - lo) / (hi - lo) * (w - 2 * pad); }
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
  drawChart("yam-overview", over);
  DATA.candidates.forEach((c, i) => {
    drawChart("yam-c" + i, [m, t, { name: c.strategy + " predicted", x: c.grid, y: c.predicted }]);
  });
})();
</script>
</body>
</html>
`;
}
