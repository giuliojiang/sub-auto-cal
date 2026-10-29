let loopTimer = null;
let hoverIter = null;
let lastLoopState = null;

function loopLogX(f, w) {
  return (Math.log(f / 20) / Math.log(20000 / 20)) * w;
}

function drawLoop(state) {
  const cv = document.getElementById("loop-graph");
  const g = cv.getContext("2d");
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#101215";
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
    g.strokeStyle = "#2c313a";
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
    g.fillStyle = "#9aa0aa";
    g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 2, H - 4);
  }
  const span = hi - lo;
  const dstep = span > 60 ? 20 : span > 30 ? 10 : span > 12 ? 5 : span > 6 ? 2 : 1;
  for (let v = Math.ceil(lo / dstep) * dstep; v <= hi; v += dstep) {
    const y = Y(v);
    g.strokeStyle = "#23272e";
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(W, y + 0.5, H);
    g.stroke();
    g.fillStyle = "#9aa0aa";
    g.fillText((v > 0 ? "+" : "") + v, 4, y - 2);
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
  line(state.timeline[0], "#555", 1);
  const best = state.timeline[state.bestIter];
  if (best && state.bestIter !== 0) line(best, "#e8a33d", 2);
  const last = state.timeline[state.timeline.length - 1];
  if (last && last !== best && last.iter !== 0) line(last, "#9aa0aa", 1);
  if (hoverIter !== null) {
    const hov = state.timeline.find((t) => t.iter === hoverIter);
    if (hov) line(hov, "#ffffff", 2.5);
  }
}

function diffVsPrev(curr, prev) {
  if (!prev) return "start";
  const dj = curr.scored.cost - prev.scored.cost;
  const sign = dj < 0 ? "−" : "+";
  const parts = [`ΔJ ${sign}${Math.abs(dj).toFixed(2)}`];
  curr.candidate.channels.forEach((ch, o) => {
    const p = prev.candidate.channels[o];
    ch.bands.forEach((b, bi) => {
      const q = p.bands[bi];
      if (b.freqHz === q.freqHz && b.q === q.q && b.gainDb === q.gainDb) return;
      if (Math.abs(b.gainDb) < 0.05 && Math.abs(q.gainDb) < 0.05) return;
      parts.push(`O${o + 1}b${bi} ${q.freqHz.toFixed(0)}→${b.freqHz.toFixed(0)}Hz Q${q.q.toFixed(1)}→${b.q.toFixed(1)} ${q.gainDb.toFixed(1)}→${b.gainDb.toFixed(1)}dB`);
    });
    if (ch.gainDb !== p.gainDb) parts.push(`O${o + 1}g ${p.gainDb.toFixed(1)}→${ch.gainDb.toFixed(1)}dB`);
    if (ch.delayMs !== p.delayMs) parts.push(`O${o + 1}d ${p.delayMs.toFixed(2)}→${ch.delayMs.toFixed(2)}ms`);
  });
  if (parts.length === 1) parts.push("—");
  return parts.join(" · ");
}

function renderLoop(state) {
  lastLoopState = state;
  $("loop-status").textContent = state.error ? `stopped: ${state.error}` : state.running ? `running, iter ${state.timeline.length} — STOP to apply a row` : state.timeline.length ? "done" : "idle";
  drawLoop(state);
  const chanShort = (ch, o) => {
    const f = ch.bands.filter((b) => b.gainDb < -0.05).map((b) => `${b.freqHz.toFixed(0)}/${b.q.toFixed(1)}/${b.gainDb.toFixed(1)}`).join(" ") || "—";
    return `O${o + 1}[${f}]g${ch.gainDb.toFixed(1)}d${ch.delayMs.toFixed(2)}`;
  };
  const rows = state.timeline.map((t, i) => {
    const f = t.candidate.channels.map(chanShort).join(" ");
    const delta = diffVsPrev(t, i ? state.timeline[i - 1] : null);
    return `<tr data-iter="${t.iter}"${t.iter === hoverIter ? ' class="lit"' : ""}><td>${t.iter}</td><td>${t.kind}</td><td>${t.pareto ? "★" : ""}</td><td>${t.scored.flatness.toFixed(2)}</td><td>${t.scored.mean.toFixed(1)}</td><td>${t.scored.loss.toFixed(2)}</td><td>${t.scored.cost.toFixed(2)}</td><td>${delta}</td><td>${f}</td><td><button data-apply="${t.iter}"${state.running ? ' disabled title="STOP the loop first"' : ""}>Apply</button></td></tr>`;
  });
  $("loop-timeline").innerHTML = rows.length
    ? `<table><tr><th>iter</th><th>kind</th><th></th><th title="Flatness error in dB: RMS deviation of the measured shape from the target (flat lowcut to end, minus 12 dB per octave below lowcut). Lower is flatter; overall level changes do not affect it.">F</th><th title="Mean SPL in dB across the goal range, start to end.">mean</th><th title="Level lost versus the baseline measurement in dB: baseline mean minus candidate mean. Negative means the candidate got louder.">loss</th><th title="Score the optimizer minimizes: J equals F plus loss. One dB of flatness trades one-for-one with one dB of level.">J</th><th title="Incremental change versus the previous row: score delta, then each changed filter, gain, or delay. Row 0 is the starting point before any changes are applied.">Δ vs prev</th><th>filters</th><th></th></tr>${rows.join("")}</table>`
    : "";
  const basis = state.cal ? `calibrated: ${state.cal.fileName} SERNO ${state.cal.serial} ${state.cal.orientation} (Sens ${state.cal.sensDb}dB)` : "uncalibrated dBFS — no mic file loaded";
  const best = state.timeline[state.bestIter];
  $("loop-best").innerHTML = best
    ? `<pre>best: iter ${best.iter} J=${best.scored.cost.toFixed(2)} (F=${best.scored.flatness.toFixed(2)} loss=${best.scored.loss.toFixed(2)})\n` +
      best.candidate.channels.map((ch, o) => `Out${o + 1}: ${ch.bands.map((b) => `${b.freqHz.toFixed(1)}Hz Q=${b.q.toFixed(2)} ${b.gainDb.toFixed(1)}dB`).join(", ")}  gain ${ch.gainDb.toFixed(1)}dB  delay ${ch.delayMs.toFixed(2)}ms`).join("\n") + `\n` +
      `${basis}\nRuns against the connected DSP; STOP then Apply a row, or apply / revert from the DSP tab snapshot.</pre>`
    : "";
}

$("loop-timeline").addEventListener("mouseover", (e) => {
  const tr = e.target.closest("tr[data-iter]");
  if (!tr) return;
  const iter = Number(tr.dataset.iter);
  if (iter !== hoverIter) {
    hoverIter = iter;
    document.querySelectorAll("#loop-timeline tr.lit").forEach((r) => r.classList.remove("lit"));
    tr.classList.add("lit");
    if (lastLoopState) drawLoop(lastLoopState);
  }
});
$("loop-timeline").addEventListener("mouseleave", () => {
  hoverIter = null;
  document.querySelectorAll("#loop-timeline tr.lit").forEach((r) => r.classList.remove("lit"));
  if (lastLoopState) drawLoop(lastLoopState);
});
$("loop-timeline").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-apply]");
  if (!btn) return;
  const iter = Number(btn.dataset.apply);
  btn.disabled = true;
  try {
    await post("/api/loop/apply", { iter });
    $("loop-status").textContent = `applied iter ${iter}`;
    if (window.refreshState) await window.refreshState();
  } catch (err) {
    $("loop-status").textContent = `apply failed: ${err.message}`;
  }
  btn.disabled = false;
});

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
    fLowcut: Number($("loop-flowcut").value),
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
