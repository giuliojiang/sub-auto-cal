const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function post(path, data) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data || {}) });
}

const pending = new Map();

function renderPending() {
  const b = $("btn-write");
  b.textContent = `Write (${pending.size})`;
  b.disabled = pending.size === 0;
  b.title = pending.size ? [...pending.values()].map((e) => e.label).join("\n") : "no staged edits";
}

function stage(key, label, path, body) {
  pending.set(key, { label, path, body });
  renderPending();
}

function clearPending() {
  pending.clear();
  renderPending();
}

$("btn-write").onclick = async () => {
  const items = [...pending.entries()];
  for (const [key, e] of items) {
    await post(e.path, e.body);
    pending.delete(key);
    renderPending();
    await new Promise((r) => setTimeout(r, 120));
  }
  await refreshState();
};
$("btn-discard").onclick = () => clearPending();
renderPending();

async function refreshStatus() {
  const s = await api("/api/status");
  $("status").textContent = s.connected ? "connected: " + s.link : "disconnected";
  $("status").classList.toggle("on", !!s.connected);
}

document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tabpage").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById("tab-" + b.dataset.tab).classList.add("active");
  };
});

function chan() {
  return $("ctl-chan").value;
}

async function refreshState() {
  let st;
  try {
    st = await api("/api/state");
  } catch (e) {
    $("channels").innerHTML = "<pre>refresh failed: " + e.message + "</pre>";
    if (window.mixerFailed) window.mixerFailed();
    if (window.peqFailed) window.peqFailed();
    return;
  }
  $("version").textContent = st.version || "";
  const rows = [];
  st.inputs.forEach((c, i) => rows.push(`In${"ABCD"[i]} ${c.name} gain=${c.gainDb.toFixed(1)}dB pol=${c.polarity ? "inv" : "norm"} gate=${c.gate.attackMs}/${c.gate.releaseMs}/${c.gate.holdMs}ms thr=${c.gate.thresholdDb.toFixed(1)}dB`));
  st.outputs.forEach((c, i) => {
    rows.push(`Out${i + 1} ${c.name} gain=${c.gainDb.toFixed(1)}dB pol=${c.polarity ? "inv" : "norm"} route=${c.routingMask} delay=${c.delayMs.toFixed(2)}ms hpf=${c.hpfHz ? c.hpfHz.toFixed(1) + "Hz" : "off"} lpf=${c.lpfHz ? c.lpfHz.toFixed(1) + "Hz" : "off"} comp=r${c.comp.ratioIndex}/k${c.comp.kneeDb}/${c.comp.attackMs}/${c.comp.releaseMs}ms thr=${c.comp.thresholdDb.toFixed(1)}dB`);
    c.bands.forEach((b, j) => {
      if (Math.abs(b.gainDb) > 0.01) rows.push(`  band${j}: ${b.freqHz.toFixed(1)}Hz Q=${b.q.toFixed(2)} ${b.gainDb.toFixed(1)}dB type=${b.type}`);
    });
  });
  $("channels").innerHTML = "<pre>" + rows.join("\n") + "</pre>";
  if (window.refreshMixer) window.refreshMixer(st);
  if (window.refreshPeq) window.refreshPeq(st);
  const h = await api("/api/history");
  $("history").textContent = h.map((e) => `${e.time} [${e.target}] ${e.what}`).join("\n") || "(no writes yet)";
}

$("btn-hw").onclick = async () => { await post("/api/connect", {}); await refreshStatus(); await refreshState(); };
$("btn-sim").onclick = async () => { await post("/api/connect", { simulator: true }); await refreshStatus(); await refreshState(); };
$("btn-dc").onclick = async () => { await post("/api/disconnect"); await refreshStatus(); };
$("btn-refresh").onclick = refreshState;
$("btn-snap").onclick = () => post("/api/snapshot");
$("btn-revert").onclick = async () => { await post("/api/revert"); clearPending(); await refreshState(); };
$("btn-meters").onclick = async () => {
  const m = await api("/api/meters");
  $("meters").textContent = m.meters.map((v) => v.toFixed(2)).join(" ");
  const cv = document.getElementById("meters-cv");
  const g = cv.getContext("2d");
  const names = ["InA", "InB", "InC", "InD", "Out1", "Out2", "Out3", "Out4"];
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#101215";
  g.fillRect(0, 0, cv.width, cv.height);
  g.font = "10px system-ui";
  m.meters.forEach((v, i) => {
    const x = 8 + i * ((cv.width - 16) / 8);
    const bw = (cv.width - 16) / 8 - 8;
    const h = Math.max(1, v * (cv.height - 28));
    g.fillStyle = v > 0.9 ? "#d9534f" : "#e8a33d";
    g.fillRect(x, cv.height - 14 - h, bw, h);
    g.fillStyle = "#9aa0aa";
    g.fillText(names[i], x, cv.height - 2);
  });
};
$("btn-gain").onclick = () => { const ch = chan(); stage(`gain:${ch}`, `gain ${ch} ${$("ctl-gain").value}dB`, "/api/gain", { chan: ch, db: Number($("ctl-gain").value) }); };
$("btn-delay").onclick = () => { const ch = chan(); stage(`delay:${ch}`, `delay ${ch} ${$("ctl-delay").value}ms`, "/api/delay", { chan: ch, ms: Number($("ctl-delay").value) }); };
$("btn-route").onclick = () => { const ch = chan(); stage(`routing:${ch}`, `routing ${ch} mask ${$("ctl-route").value}`, "/api/routing", { chan: ch, mask: Number($("ctl-route").value) }); };
$("btn-mute-on").onclick = () => { const ch = chan(); stage(`mute:${ch}`, `mute ${ch}`, "/api/mute", { chan: ch, on: true }); };
$("btn-mute-off").onclick = () => { const ch = chan(); stage(`mute:${ch}`, `unmute ${ch}`, "/api/mute", { chan: ch, on: false }); };
$("btn-pol-inv").onclick = () => { const ch = chan(); stage(`polarity:${ch}`, `invert ${ch}`, "/api/polarity", { chan: ch, invert: true }); };
$("btn-pol-norm").onclick = () => { const ch = chan(); stage(`polarity:${ch}`, `polarity normal ${ch}`, "/api/polarity", { chan: ch, invert: false }); };

$("btn-gate").onclick = () => {
  const ch = chan();
  stage(`gate:${ch}`, `gate ${ch}`, "/api/gate", {
    chan: ch, attackMs: Number($("gate-atk").value), releaseMs: Number($("gate-rel").value),
    holdMs: Number($("gate-hold").value), thresholdDb: Number($("gate-thr").value),
  });
};
$("btn-comp").onclick = () => {
  const ch = chan();
  stage(`comp:${ch}`, `compressor ${ch}`, "/api/compressor", {
    chan: ch, ratioIndex: Number($("comp-ratio").value), kneeDb: Number($("comp-knee").value),
    attackMs: Number($("comp-atk").value), releaseMs: Number($("comp-rel").value),
    thresholdDb: Number($("comp-thr").value),
  });
};
$("btn-recall").onclick = async () => { await post("/api/preset", { action: "recall", slot: Number($("preset-slot").value) }); clearPending(); await refreshState(); };
$("btn-store").onclick = async () => { await post("/api/preset", { action: "store", slot: Number($("preset-slot").value) }); clearPending(); await refreshState(); };

$("btn-sig").onclick = async () => {
  await post("/api/signal", { source: $("sig-src").value, freqHz: Number($("sig-freq").value) });
  await refreshState();
};
function fill(sel, items) {
  const cur = $(sel).value;
  $(sel).innerHTML = '<option value="">System default</option>' + items.map((d) => `<option>${d}</option>`).join("");
  if ([...$(sel).options].some((o) => o.value === cur)) $(sel).value = cur;
}
$("btn-devs").onclick = async () => {
  const d = await api("/api/audio/devices");
  fill("nz-play", d.playback);
  fill("nz-cap", d.capture);
  if (d.defaultCapture && !$("nz-cap").value) $("nz-cap").value = d.defaultCapture;
  $("audio-out").textContent = "PLAYBACK:\n" + d.playback.join("\n") + "\n\nCAPTURE:\n" + d.capture.join("\n");
};
function drawWave(peaks) {
  const cv = $("wave");
  const g = cv.getContext("2d");
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#101215";
  g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = "#555";
  g.beginPath();
  g.moveTo(0, cv.height / 2 + 0.5);
  g.lineTo(cv.width, cv.height / 2 + 0.5);
  g.stroke();
  g.fillStyle = "#e8a33d";
  const bw = cv.width / peaks.length;
  peaks.forEach((p, i) => {
    const h = Math.max(1, p * cv.height * 0.95);
    g.fillRect(i * bw, (cv.height - h) / 2, Math.max(1, bw - 0.5), h);
  });
}
$("btn-mic").onclick = async () => {
  const f = $("mic-file").files[0];
  if (!f) {
    $("mic-status").textContent = "pick a file first";
    return;
  }
  const content = await f.text();
  try {
    const r = await post("/api/miccal/load", { fileName: f.name, content, orientation: $("mic-orient").value, expectedSerial: $("mic-serial").value || undefined });
    $("mic-status").textContent = `loaded ${r.prov.fileName} SERNO ${r.prov.serial} ${r.prov.orientation} Sens ${r.prov.sensDb}dB` + (r.warnings.length ? " — " + r.warnings.join("; ") : "");
  } catch (e) {
    $("mic-status").textContent = "rejected: " + e.message;
  }
};
$("btn-noise").onclick = async () => {
  $("audio-out").textContent = "Playing and recording…";
  const r = await post("/api/audio/noise-check", {
    kind: $("nz-kind").value, seconds: Number($("nz-sec").value),
    playbackId: $("nz-play").value || undefined, captureId: $("nz-cap").value || undefined,
  });
  $("audio-out").textContent =
    `verdict: ${r.verdict}\npeak: ${r.peakDbfs.toFixed(1)} dBFS\nrms: ${r.rmsDbfs.toFixed(1)} dBFS\n` +
    `clipped: ${r.clipped}\nrate: ${r.sampleRate} Hz\nplayback: ${r.playbackId}\ncapture: ${r.captureId}\nrecording: ${r.recordingFile}`;
  const name = r.recordingFile.split("/").pop();
  const w = await api("/api/audio/waveform?file=" + encodeURIComponent(name));
  drawWave(w.peaks);
};

refreshStatus();
