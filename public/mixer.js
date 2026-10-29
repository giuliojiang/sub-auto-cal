const MIX_INS = ["InA", "InB", "InC", "InD"];
const MIX_OUTS = ["Out1", "Out2", "Out3", "Out4"];
let mixerState = null;

function mixerGainCard(name, isInput) {
  const card = document.createElement("div");
  card.className = "mix-card";
  card.dataset.chan = name;
  card.innerHTML =
    `<div class="mix-head"><strong>${name}</strong><button data-mute title="mute / unmute">MUTE</button></div>` +
    `<div class="mix-ctl"><input data-slider type="range" min="-60" max="12" step="0.5" value="0">` +
    `<span><input data-num type="number" min="-60" max="12" step="0.5" value="0"> dB</span></div>`;
  const slider = card.querySelector("[data-slider]");
  const num = card.querySelector("[data-num]");
  const muteBtn = card.querySelector("[data-mute]");
  slider.addEventListener("input", () => { num.value = slider.value; });
  slider.addEventListener("change", () => { mixerSetGain(name, Number(slider.value)); });
  num.addEventListener("change", () => {
    const v = Math.max(-60, Math.min(12, Number(num.value)));
    num.value = String(v);
    slider.value = String(v);
    mixerSetGain(name, v);
  });
  muteBtn.onclick = () => {
    const idx = MIX_INS.indexOf(name) >= 0 ? MIX_INS.indexOf(name) : 4 + MIX_OUTS.indexOf(name);
    liveApply("/api/mute", { chan: name, on: !(mixerState && mixerState.muted[idx]) });
  };
  return card;
}

function mixerSetGain(name, db) {
  liveApply("/api/gain", { chan: name, db });
}

function mixerBuildGains() {
  const ins = document.getElementById("mixer-ins");
  const outs = document.getElementById("mixer-outs");
  ins.innerHTML = "";
  outs.innerHTML = "";
  MIX_INS.forEach((n) => ins.appendChild(mixerGainCard(n, true)));
  MIX_OUTS.forEach((n) => outs.appendChild(mixerGainCard(n, false)));
}

function mixerRenderCard(name, gainDb, muted) {
  const card = document.querySelector(`.mix-card[data-chan="${name}"]`);
  if (!card) return;
  card.querySelector("[data-slider]").value = String(gainDb);
  card.querySelector("[data-num]").value = gainDb.toFixed(1);
  const muteBtn = card.querySelector("[data-mute]");
  muteBtn.textContent = muted ? "MUTED" : "MUTE";
  muteBtn.classList.toggle("muted", muted);
}

function mixerRenderGains() {
  if (!mixerState) return;
  mixerState.inputs.forEach((c, i) => mixerRenderCard(MIX_INS[i], c.gainDb, mixerState.muted[i]));
  mixerState.outputs.forEach((c, i) => mixerRenderCard(MIX_OUTS[i], c.gainDb, mixerState.muted[4 + i]));
}

function mixerSetMask(outIdx, mask) {
  const name = MIX_OUTS[outIdx];
  mask &= 15;
  liveApply("/api/routing", { chan: name, mask });
}

function mixerRenderMatrix() {
  const t = document.getElementById("mixer-matrix");
  t.innerHTML = "";
  const head = document.createElement("tr");
  head.appendChild(document.createElement("th"));
  MIX_INS.forEach((n) => {
    const th = document.createElement("th");
    th.textContent = n;
    head.appendChild(th);
  });
  const allTh = document.createElement("th");
  allTh.textContent = "row";
  head.appendChild(allTh);
  t.appendChild(head);
  mixerState.outputs.forEach((o, r) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = MIX_OUTS[r];
    th.title = "click to toggle whole row";
    th.onclick = () => mixerSetMask(r, o.routingMask ? 0 : 15);
    tr.appendChild(th);
    MIX_INS.forEach((n, c) => {
      const td = document.createElement("td");
      const b = document.createElement("button");
      const on = (o.routingMask & (1 << c)) !== 0;
      b.textContent = on ? "●" : "○";
      b.className = on ? "cell on" : "cell";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.title = `${MIX_OUTS[r]} ← ${n}`;
      b.onclick = () => mixerSetMask(r, o.routingMask ^ (1 << c));
      td.appendChild(b);
      tr.appendChild(td);
    });
    const rowTd = document.createElement("td");
    rowTd.className = "rowmask";
    rowTd.textContent = String(o.routingMask);
    tr.appendChild(rowTd);
    t.appendChild(tr);
  });
}

window.refreshMixer = function (st) {
  mixerState = st;
  document.getElementById("mixer-offline").style.display = "none";
  document.getElementById("mixer").style.display = "";
  mixerRenderGains();
  mixerRenderMatrix();
};

window.mixerFailed = function () {
  if (mixerState) return;
  document.getElementById("mixer-offline").style.display = "";
  document.getElementById("mixer").style.display = "none";
};

window.addEventListener("DOMContentLoaded", () => {
  mixerBuildGains();
  document.getElementById("mixer").style.display = "none";
  $("mix-all").onclick = () => mixerState && mixerState.outputs.forEach((_, r) => mixerSetMask(r, 15));
  $("mix-none").onclick = () => mixerState && mixerState.outputs.forEach((_, r) => mixerSetMask(r, 0));
  $("mix-diag").onclick = () => mixerState && mixerState.outputs.forEach((_, r) => mixerSetMask(r, 1 << r));
});
