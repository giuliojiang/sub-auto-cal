const PEQ_FS = 48000;
const PEQ_FMIN = 20;
const PEQ_FMAX = 20000;
const PEQ_TOP = 15;
const PEQ_BOT = -24;
const PEQ_POINTS = 240;
const PEQ_OUTS = ["Out1", "Out2", "Out3", "Out4"];
let peqState = null;
let peqDrag = null;
const peqBypass = new Set();
const peqKey = (o, b) => o + ":" + b;

function rbjCoeffs(kind, f0, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * Math.max(1, f0)) / PEQ_FS;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  if (kind === "peak") {
    const al = sw / (2 * Math.max(0.05, q));
    return [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  }
  if (kind === "lshelf" || kind === "hshelf") {
    const S = Math.min(5, Math.max(0.2, q));
    const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const sqA = 2 * Math.sqrt(A) * al;
    if (kind === "lshelf")
      return [A * (A + 1 - (A - 1) * cw + sqA), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - sqA), A + 1 - (A - 1) * cw + sqA, -2 * (A - 1 + (A + 1) * cw), A + 1 - (A - 1) * cw - sqA];
    return [A * (A + 1 + (A - 1) * cw + sqA), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - sqA), A + 1 + (A - 1) * cw + sqA, 2 * (A - 1 - (A + 1) * cw), A + 1 + (A - 1) * cw - sqA];
  }
  const al = sw / Math.SQRT2;
  if (kind === "hp") return [1, -2 * cw, 1, 1 + al, -2 * cw, 1 - al];
  return [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al];
}

function biquadDb(cf, f) {
  const w = (2 * Math.PI * f) / PEQ_FS;
  const c1 = Math.cos(w);
  const c2 = Math.cos(2 * w);
  const s1 = Math.sin(w);
  const s2 = Math.sin(2 * w);
  const [b0, b1, b2, a0, a1, a2] = cf;
  const num = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
  const den = (a0 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
  return 10 * Math.log10(Math.max(1e-12, num / Math.max(1e-12, den)));
}

function butterDb(lp, f, fc, order) {
  const t = Math.tan((Math.PI * f) / PEQ_FS) / Math.tan((Math.PI * Math.max(1, fc)) / PEQ_FS);
  const p = Math.pow(t, 2 * order);
  const m2 = lp ? 1 / (1 + p) : p / (1 + p);
  return 10 * Math.log10(Math.max(1e-9, m2));
}

function xoDb(lp, f, fc, slope) {
  if (!slope || !fc) return 0;
  const o = { 1: 1, 2: 1, 3: 2, 4: 2, 6: 3, 7: 3, 8: 4, 9: 4 }[slope];
  if (o) return butterDb(lp, f, fc, o);
  if (slope === 5) return 2 * butterDb(lp, f, fc, 1);
  if (slope === 10) return 2 * butterDb(lp, f, fc, 2);
  return 0;
}

function bandDb(band, f) {
  const t = band.type;
  if (t === 0) return biquadDb(rbjCoeffs("peak", band.freqHz, band.q, band.gainDb), f);
  if (t === 1) return biquadDb(rbjCoeffs("lshelf", band.freqHz, band.q, band.gainDb), f);
  if (t === 2) return biquadDb(rbjCoeffs("hshelf", band.freqHz, band.q, band.gainDb), f);
  if (t === 3) return biquadDb(rbjCoeffs("hp", band.freqHz, 0.707, 0), f);
  if (t === 4) return biquadDb(rbjCoeffs("lp", band.freqHz, 0.707, 0), f);
  return 0;
}

function outTotal(oi, out, f) {
  let s = xoDb(false, f, out.hpfHz, out.hpfSlope) + xoDb(true, f, out.lpfHz, out.lpfSlope);
  out.bands.forEach((b, i) => {
    if (!peqIsBypassed(oi, i)) s += bandDb(b, f);
  });
  return s;
}

function peqEl(oi, name) {
  return document.getElementById(name + "-" + oi);
}

function peqIsBypassed(o, b) {
  return peqBypass.has(peqKey(o, b));
}

const peqX = (f, w) => (Math.log(f / PEQ_FMIN) / Math.log(PEQ_FMAX / PEQ_FMIN)) * w;
const peqF = (x, w) => PEQ_FMIN * Math.pow(PEQ_FMAX / PEQ_FMIN, x / w);
const peqY = (db, h) => ((PEQ_TOP - Math.max(PEQ_BOT, Math.min(PEQ_TOP, db))) / (PEQ_TOP - PEQ_BOT)) * h;
const peqDb = (y, h) => PEQ_TOP - (y / h) * (PEQ_TOP - PEQ_BOT);

function drawPeq(oi) {
  const cv = peqEl(oi, "peq-graph");
  if (!cv || !peqState) return;
  const g = cv.getContext("2d");
  const W = cv.width;
  const H = cv.height;
  const out = peqState.outputs[oi];
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#101215";
  g.fillRect(0, 0, W, H);
  g.font = "10px system-ui";
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = peqX(f, W);
    g.strokeStyle = "#2c313a";
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
    g.fillStyle = "#9aa0aa";
    g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 2, H - 4);
  }
  for (const db of [12, 6, 0, -6, -12, -18]) {
    const y = peqY(db, H);
    g.strokeStyle = db === 0 ? "#555" : "#23272e";
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(W, y + 0.5);
    g.stroke();
    g.fillStyle = "#9aa0aa";
    g.fillText((db > 0 ? "+" : "") + db, 4, y - 2);
  }
  const grid = [];
  for (let i = 0; i < PEQ_POINTS; i++) grid.push(peqF(((i + 0.5) / PEQ_POINTS) * W, W));
  g.lineWidth = 1;
  for (let bi = 0; bi < out.bands.length; bi++) {
    const b = out.bands[bi];
    if (peqIsBypassed(oi, bi)) continue;
    g.strokeStyle = "#5c6672";
    g.beginPath();
    grid.forEach((f, i) => {
      const x = ((i + 0.5) / PEQ_POINTS) * W;
      const y = peqY(bandDb(b, f), H);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
  }
  g.strokeStyle = "#e8a33d";
  g.lineWidth = 2;
  g.beginPath();
  grid.forEach((f, i) => {
    const x = ((i + 0.5) / PEQ_POINTS) * W;
    const y = peqY(outTotal(oi, out, f), H);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.stroke();
  g.lineWidth = 1;
  for (const [fc, lp] of [[out.hpfHz, false], [out.lpfHz, true]]) {
    if (!fc) continue;
    const x = peqX(Math.max(PEQ_FMIN, Math.min(PEQ_FMAX, fc)), W);
    g.fillStyle = "#9aa0aa";
    g.beginPath();
    if (lp) {
      g.moveTo(x, 8);
      g.lineTo(x - 5, 0);
      g.lineTo(x + 5, 0);
    } else {
      g.moveTo(x, 0);
      g.lineTo(x - 5, 8);
      g.lineTo(x + 5, 8);
    }
    g.fill();
  }
  out.bands.forEach((b, i) => {
    const x = peqX(Math.max(PEQ_FMIN, Math.min(PEQ_FMAX, b.freqHz)), W);
    const y = peqY(b.gainDb, H);
    g.beginPath();
    g.arc(x, y, peqDrag && peqDrag.oi === oi && peqDrag.i === i ? 8 : 6, 0, 2 * Math.PI);
    g.fillStyle = peqIsBypassed(oi, i) ? "#101215" : "#e8a33d";
    g.fill();
    g.strokeStyle = peqIsBypassed(oi, i) ? "#5c6672" : "#e8a33d";
    g.stroke();
    g.fillStyle = peqIsBypassed(oi, i) ? "#5c6672" : "#14161a";
    g.fillText(String(i + 1), x - 3, y + 3);
  });
}

const PEQ_TYPES = ["Peak", "Low shelf", "High shelf", "Low cut", "High cut", "Allpass 1", "Allpass 2"];

function buildBandRows(oi) {
  const host = peqEl(oi, "peq-bands");
  host.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const row = document.createElement("div");
    row.className = "peq-row";
    row.innerHTML =
      `<strong>${i + 1}</strong>` +
      `<label>Type <select data-k="type">${PEQ_TYPES.map((t, v) => `<option value="${v}">${t}</option>`).join("")}</select></label>` +
      `<label>Freq Hz <input data-k="freqHz" type="number" step="any"></label>` +
      `<label>Q <input data-k="q" type="number" step="any"></label>` +
      `<label>Gain dB <input data-k="gainDb" type="number" step="any"></label>` +
      `<label>Bypass <input data-k="bypass" type="checkbox"></label>` +
      `<span class="peq-pill">ACTIVE</span>` +
      `<button data-a="set">Set</button><button data-a="reset">Reset</button>`;
    row.querySelector('[data-a="set"]').onclick = () => peqPostBand(oi, i, false);
    row.querySelector('[data-a="reset"]').onclick = () => peqPostBand(oi, i, true);
    row.querySelector('[data-k="bypass"]').onchange = (e) => {
      const on = e.target.checked;
      if (on) peqBypass.add(peqKey(oi, i));
      else peqBypass.delete(peqKey(oi, i));
      syncPill(oi, i);
      drawPeq(oi);
      peqStage(oi, i, peqReadRow(oi, i));
    };
    host.appendChild(row);
  }
}

function peqRowInputs(oi, i) {
  const row = peqEl(oi, "peq-bands").children[i];
  const q = (k) => row.querySelector(`[data-k="${k}"]`);
  return { row, type: q("type"), freqHz: q("freqHz"), q: q("q"), gainDb: q("gainDb"), bypass: q("bypass"), pill: row.querySelector(".peq-pill") };
}

function syncPill(oi, i) {
  const r = peqRowInputs(oi, i);
  const off = peqIsBypassed(oi, i);
  r.row.classList.toggle("bypassed", off);
  r.pill.textContent = off ? "BYPASSED" : "ACTIVE";
}

function peqReadRow(oi, i) {
  const r = peqRowInputs(oi, i);
  return {
    type: Number(r.type.value),
    freqHz: Number(r.freqHz.value),
    q: Number(r.q.value),
    gainDb: Number(r.gainDb.value),
    bypass: r.bypass.checked,
  };
}

function peqStage(oi, i, p) {
  const chan = PEQ_OUTS[oi];
  stage(`peq:${chan}:band${i + 1}`, `peq ${chan} band ${i + 1}`, "/api/peq", { chan, band: i, ...p });
}

function peqPostBand(oi, i, reset) {
  const out = peqState.outputs[oi];
  const p = reset
    ? { freqHz: out.bands[i].freqHz, q: 1.4, gainDb: 0, type: 0, bypass: false }
    : peqReadRow(oi, i);
  Object.assign(out.bands[i], { type: p.type, freqHz: p.freqHz, q: p.q, gainDb: p.gainDb });
  if (p.bypass) peqBypass.add(peqKey(oi, i));
  else peqBypass.delete(peqKey(oi, i));
  fillOut(oi);
  drawPeq(oi);
  peqStage(oi, i, peqReadRow(oi, i));
}

function fillOut(oi) {
  const out = peqState.outputs[oi];
  peqEl(oi, "peq-hpf").value = out.hpfHz ? out.hpfHz.toFixed(1) : "";
  peqEl(oi, "peq-hpf-slope").value = String(out.hpfSlope);
  peqEl(oi, "peq-lpf").value = out.lpfHz ? out.lpfHz.toFixed(1) : "";
  peqEl(oi, "peq-lpf-slope").value = String(out.lpfSlope);
  out.bands.forEach((b, i) => {
    const r = peqRowInputs(oi, i);
    r.type.value = String(b.type);
    r.freqHz.value = b.freqHz.toFixed(1);
    r.q.value = b.q.toFixed(2);
    r.gainDb.value = b.gainDb.toFixed(1);
    r.bypass.checked = peqIsBypassed(oi, i);
    syncPill(oi, i);
  });
}

function fillPeq() {
  for (let oi = 0; oi < 4; oi++) fillOut(oi);
}

function drawAllPeq() {
  for (let oi = 0; oi < 4; oi++) drawPeq(oi);
}

window.refreshPeq = function (st) {
  peqState = st;
  document.getElementById("peq-notice").style.display = "none";
  document.getElementById("peq-all").style.display = "";
  fillPeq();
  drawAllPeq();
};

window.clearPeqBypass = function () {
  peqBypass.clear();
  if (peqState) {
    fillPeq();
    drawAllPeq();
  }
};

window.peqFailed = function () {
  const n = document.getElementById("peq-notice");
  n.style.display = "";
  n.textContent = peqState
    ? "Couldn't reach the device — showing last known values."
    : "No device state — connect the DSP or simulator, then press Refresh.";
  if (!peqState) document.getElementById("peq-all").style.display = "none";
};

const PEQ_SLOPES = [["0", "Bypass"], ["1", "BW 6"], ["2", "Bessel 6"], ["3", "BW 12"], ["4", "Bessel 12"], ["5", "LR 12"], ["6", "BW 18"], ["7", "Bessel 18"], ["8", "BW 24"], ["9", "Bessel 24"], ["10", "LR 24"]];

function peqNear(oi, x, y) {
  const cv = peqEl(oi, "peq-graph");
  const r = cv.getBoundingClientRect();
  const px = x - r.left;
  const py = y - r.top;
  const sx = cv.width / r.width;
  const sy = cv.height / r.height;
  let best = -1;
  let bestD = 14;
  peqState.outputs[oi].bands.forEach((b, i) => {
    const dx = (peqX(Math.max(PEQ_FMIN, Math.min(PEQ_FMAX, b.freqHz)), cv.width) - px * sx) / sx;
    const dy = (peqY(b.gainDb, cv.height) - py * sy) / sy;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function syncRow(oi, i) {
  const b = peqState.outputs[oi].bands[i];
  const r = peqRowInputs(oi, i);
  r.freqHz.value = b.freqHz.toFixed(1);
  r.q.value = b.q.toFixed(2);
  r.gainDb.value = b.gainDb.toFixed(1);
}

function stageBand(oi, i) {
  peqStage(oi, i, peqReadRow(oi, i));
}

window.addEventListener("DOMContentLoaded", () => {
  for (let oi = 0; oi < 4; oi++) {
    for (const kind of ["peq-hpf-slope", "peq-lpf-slope"]) {
      const sel = peqEl(oi, kind);
      PEQ_SLOPES.forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        sel.appendChild(o);
      });
    }
    buildBandRows(oi);
    peqEl(oi, "btn-peq-xo").onclick = () => {
      const chan = PEQ_OUTS[oi];
      const hf = Number(peqEl(oi, "peq-hpf").value || 0);
      const lf = Number(peqEl(oi, "peq-lpf").value || 0);
      stage(`xo:${chan}:hpf`, `hpf ${chan}`, "/api/crossover", { chan, highPass: true, freqHz: hf || 20, slope: hf ? Number(peqEl(oi, "peq-hpf-slope").value) : 0 });
      stage(`xo:${chan}:lpf`, `lpf ${chan}`, "/api/crossover", { chan, highPass: false, freqHz: lf || 20000, slope: lf ? Number(peqEl(oi, "peq-lpf-slope").value) : 0 });
    };
    const cv = peqEl(oi, "peq-graph");
    cv.addEventListener("mousedown", (e) => {
      if (!peqState) return;
      peqDrag = { oi, i: peqNear(oi, e.clientX, e.clientY) };
      drawPeq(oi);
    });
    cv.addEventListener("wheel", (e) => {
      if (!peqState) return;
      const i = peqNear(oi, e.clientX, e.clientY);
      if (i < 0) return;
      e.preventDefault();
      const b = peqState.outputs[oi].bands[i];
      b.q = Math.max(0.4, Math.min(128, b.q * Math.pow(1.1, -e.deltaY / 50)));
      drawPeq(oi);
      clearTimeout(cv._qt);
      cv._qt = setTimeout(() => {
        syncRow(oi, i);
        stageBand(oi, i);
      }, 400);
    }, { passive: false });
  }
  window.addEventListener("mousemove", (e) => {
    if (!peqDrag || !peqState) return;
    const { oi, i } = peqDrag;
    const cv = peqEl(oi, "peq-graph");
    const r = cv.getBoundingClientRect();
    const f = peqF(((e.clientX - r.left) / r.width) * cv.width, cv.width);
    const db = peqDb(((e.clientY - r.top) / r.height) * cv.height, cv.height);
    const b = peqState.outputs[oi].bands[i];
    b.freqHz = Math.max(20, Math.min(20000, f));
    b.gainDb = Math.max(-12, Math.min(12, db));
    drawPeq(oi);
  });
  window.addEventListener("mouseup", () => {
    if (!peqDrag) return;
    const { oi, i } = peqDrag;
    peqDrag = null;
    syncRow(oi, i);
    stageBand(oi, i);
    drawPeq(oi);
  });
});
