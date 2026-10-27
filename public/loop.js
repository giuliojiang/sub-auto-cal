let loopTimer = null;

function loopLogX(f, w) {
  return (Math.log(f / 20) / Math.log(20000 / 20)) * w;
}

function drawLoop(state) {
  const cv = document.getElementById("loop-graph");
  const g = cv.getContext("2d");
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#f4f4f2";
  g.fillRect(0, 0, W, H);
  if (!state.timeline.length) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of state.timeline)
    for (const v of t.response.db) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (!(hi > lo)) return;
  lo -= 2;
  hi += 2;
  const Y = (db) => ((hi - Math.max(lo, Math.min(hi, db))) / (hi - lo)) * H;
  g.font = "10px system-ui";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = loopLogX(f, W);
    g.strokeStyle = "#ddd";
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
    g.fillStyle = "#666";
    g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 2, H - 4);
  }
  const line = (t, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    t.response.freqs.forEach((f, i) => {
      const x = loopLogX(f, W);
      const y = Y(t.response.db[i]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    g.lineWidth = 1;
  };
  line(state.timeline[0], "#999", 1);
  const best = state.timeline[state.bestIter];
  if (best && state.bestIter !== 0) line(best, "#1c1c1c", 2);
  const last = state.timeline[state.timeline.length - 1];
  if (last && last !== best && last.iter !== 0) line(last, "#777", 1);
}

function renderLoop(state) {
  $("loop-status").textContent = state.running ? `running, iter ${state.timeline.length}` : state.timeline.length ? "done" : "idle";
  drawLoop(state);
  const rows = state.timeline.map((t) => {
    const f = t.candidate.bands.map((b) => `${b.freqHz.toFixed(0)}Hz/${b.q.toFixed(1)}/${b.gainDb.toFixed(1)}dB`).join(" ") || "—";
    return `<tr><td>${t.iter}</td><td>${t.kind}</td><td>${t.pareto ? "★" : ""}</td><td>${t.scored.flatness.toFixed(2)}</td><td>${t.scored.mean.toFixed(1)}</td><td>${t.scored.loss.toFixed(2)}</td><td>${t.scored.cost.toFixed(2)}</td><td>${f} g${t.candidate.gainDb.toFixed(1)}</td></tr>`;
  });
  $("loop-timeline").innerHTML = rows.length
    ? `<table><tr><th>iter</th><th>kind</th><th></th><th>F</th><th>mean</th><th>loss</th><th>J</th><th>filters</th></tr>${rows.join("")}</table>`
    : "";
  const best = state.timeline[state.bestIter];
  $("loop-best").innerHTML = best
    ? `<pre>best: iter ${best.iter} J=${best.scored.cost.toFixed(2)} (F=${best.scored.flatness.toFixed(2)} loss=${best.scored.loss.toFixed(2)})\n` +
      `filters: ${best.candidate.bands.map((b) => `${b.freqHz.toFixed(1)}Hz Q=${b.q.toFixed(2)} ${b.gainDb.toFixed(1)}dB`).join(", ") || "none"}  gain ${best.candidate.gainDb.toFixed(1)}dB\n` +
      `DSP deployment once speakers are wired.</pre>`
    : "";
}

async function pollLoop() {
  try {
    const s = await api("/api/loop/state");
    renderLoop(s);
    if (!s.running && loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
  } catch {}
}

$("btn-go").onclick = async () => {
  await post("/api/loop/start", {
    fStart: Number($("loop-fstart").value),
    fEnd: Number($("loop-fend").value),
    sweepSecs: Number($("loop-secs").value),
    maxIter: Number($("loop-max").value),
    playbackId: $("nz-play").value || undefined,
    captureId: $("nz-cap").value || undefined,
  });
  if (!loopTimer) loopTimer = setInterval(pollLoop, 2000);
  pollLoop();
};
$("btn-stop").onclick = async () => {
  await post("/api/loop/stop");
  pollLoop();
};
