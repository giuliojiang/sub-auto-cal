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

async function refreshStatus() {
  const s = await api("/api/status");
  $("status").textContent = s.connected ? "connected: " + s.link : "disconnected";
}

function chan() {
  return $("ctl-chan").value;
}

async function refreshState() {
  const st = await api("/api/state");
  $("version").textContent = st.version || "";
  const rows = [];
  st.inputs.forEach((c, i) => rows.push(`In${"ABCD"[i]} ${c.name} gain=${c.gainDb.toFixed(1)}dB pol=${c.polarity ? "inv" : "norm"}`));
  st.outputs.forEach((c, i) => {
    rows.push(`Out${i + 1} ${c.name} gain=${c.gainDb.toFixed(1)}dB pol=${c.polarity ? "inv" : "norm"} route=${c.routingMask} delay=${c.delayMs.toFixed(2)}ms hpf=${c.hpfHz ? c.hpfHz.toFixed(1) + "Hz" : "off"} lpf=${c.lpfHz ? c.lpfHz.toFixed(1) + "Hz" : "off"}`);
    c.bands.forEach((b, j) => {
      if (Math.abs(b.gainDb) > 0.01) rows.push(`  band${j}: ${b.freqHz.toFixed(1)}Hz Q=${b.q.toFixed(2)} ${b.gainDb.toFixed(1)}dB type=${b.type}`);
    });
  });
  $("channels").innerHTML = "<pre>" + rows.join("\n") + "</pre>";
  const h = await api("/api/history");
  $("history").textContent = h.map((e) => `${e.time} [${e.target}] ${e.what}`).join("\n") || "(no writes yet)";
}

$("btn-hw").onclick = async () => { await post("/api/connect", {}); await refreshStatus(); await refreshState(); };
$("btn-sim").onclick = async () => { await post("/api/connect", { simulator: true }); await refreshStatus(); await refreshState(); };
$("btn-dc").onclick = async () => { await post("/api/disconnect"); await refreshStatus(); };
$("btn-refresh").onclick = refreshState;
$("btn-snap").onclick = () => post("/api/snapshot");
$("btn-revert").onclick = async () => { await post("/api/revert"); await refreshState(); };
$("btn-meters").onclick = async () => {
  const m = await api("/api/meters");
  $("meters").textContent = m.meters.map((v) => v.toFixed(2)).join(" ");
};
$("btn-gain").onclick = async () => { await post("/api/gain", { chan: chan(), db: Number($("ctl-gain").value) }); await refreshState(); };
$("btn-delay").onclick = async () => { await post("/api/delay", { chan: chan(), ms: Number($("ctl-delay").value) }); await refreshState(); };
$("btn-route").onclick = async () => { await post("/api/routing", { chan: chan(), mask: Number($("ctl-route").value) }); await refreshState(); };
$("btn-mute-on").onclick = async () => { await post("/api/mute", { chan: chan(), on: true }); await refreshState(); };
$("btn-mute-off").onclick = async () => { await post("/api/mute", { chan: chan(), on: false }); await refreshState(); };
$("btn-pol-inv").onclick = async () => { await post("/api/polarity", { chan: chan(), invert: true }); await refreshState(); };
$("btn-pol-norm").onclick = async () => { await post("/api/polarity", { chan: chan(), invert: false }); await refreshState(); };
$("btn-peq").onclick = async () => {
  await post("/api/peq", {
    chan: chan(), band: Number($("peq-band").value), freqHz: Number($("peq-freq").value),
    q: Number($("peq-q").value), gainDb: Number($("peq-gain").value), type: Number($("peq-type").value),
  });
  await refreshState();
};
$("btn-xo").onclick = async () => {
  await post("/api/crossover", {
    chan: chan(), highPass: $("xo-side").value === "hpf",
    freqHz: Number($("xo-freq").value), slope: Number($("xo-slope").value),
  });
  await refreshState();
};
$("btn-sig").onclick = async () => {
  await post("/api/signal", { source: $("sig-src").value, freqHz: Number($("sig-freq").value) });
  await refreshState();
};
$("btn-devs").onclick = async () => {
  const d = await api("/api/audio/devices");
  $("audio-out").textContent = "PLAYBACK:\n" + d.playback.join("\n") + "\n\nCAPTURE:\n" + d.capture.join("\n");
};
$("btn-noise").onclick = async () => {
  $("audio-out").textContent = "Playing and recording…";
  const r = await post("/api/audio/noise-check", { kind: $("nz-kind").value, seconds: Number($("nz-sec").value) });
  $("audio-out").textContent =
    `verdict: ${r.verdict}\npeak: ${r.peakDbfs.toFixed(1)} dBFS\nrms: ${r.rmsDbfs.toFixed(1)} dBFS\n` +
    `clipped: ${r.clipped}\nrate: ${r.sampleRate} Hz\nrecording: ${r.recordingFile}`;
};

refreshStatus();
