import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface FakeClassList {
  add: (c: string) => void;
  remove: (...cs: string[]) => void;
  toggle: (c: string, force?: boolean) => boolean;
  contains: (c: string) => boolean;
}

function makeClassList(): FakeClassList {
  const s = new Set<string>();
  return {
    add: (c: string) => { s.add(c); },
    remove: (...cs: string[]) => { cs.forEach((c) => s.delete(c)); },
    toggle: (c: string, force?: boolean) => {
      if (force === undefined) {
        if (s.has(c)) { s.delete(c); return false; }
        s.add(c);
        return true;
      }
      if (force) s.add(c); else s.delete(c);
      return force;
    },
    contains: (c: string) => s.has(c),
  };
}

interface FakeInput {
  value: string;
  checked: boolean;
  onclick: ((e?: unknown) => void) | null;
  onchange: ((e: { target: FakeInput }) => void) | null;
}

interface FakeRow {
  className: string;
  classList: FakeClassList;
  style: Record<string, string>;
  querySelector: (sel: string) => FakeInput | { textContent: string };
}

function makeRow(): { row: FakeRow; inputs: Record<string, FakeInput>; pill: { textContent: string } } {
  const inputs: Record<string, FakeInput> = {};
  for (const k of ["type", "freqHz", "q", "gainDb", "bypass", "set", "reset"]) {
    inputs[k] = { value: "", checked: false, onclick: null, onchange: null };
  }
  const pill = { textContent: "" };
  const row: FakeRow = {
    className: "peq-row",
    classList: makeClassList(),
    style: {},
    querySelector: (sel: string) => {
      if (sel === ".peq-pill") return pill;
      const m = sel.match(/data-[ak]="([^"]+)"/);
      if (m) return inputs[m[1] as string] as FakeInput;
      throw new Error("unexpected selector " + sel);
    },
  };
  return { row, inputs, pill };
}

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  addEventListener: () => void;
  getContext: () => unknown;
  [k: string]: unknown;
}

function makeCtx(): unknown {
  return new Proxy({}, { get: () => () => {}, set: () => true });
}

interface TabButton {
  dataset: { out: string };
  classList: FakeClassList;
  onclick: (() => void) | null;
}

interface StagedCall {
  key: string;
  path: string;
  body: Record<string, unknown>;
}

function loadPeq() {
  const src = readFileSync(join(root, "public", "peq.js"), "utf8");
  const tabs: TabButton[] = ["Out1", "Out2", "Out3", "Out4"].map((out) => ({
    dataset: { out },
    classList: makeClassList(),
    onclick: null,
  }));
  tabs[0]!.classList.add("active");
  const bandsEl = {
    children: [] as FakeRow[],
    appendChild: (r: FakeRow) => { bandsEl.children.push(r); },
    style: {} as Record<string, string>,
  };
  Object.defineProperty(bandsEl, "innerHTML", { set: () => { bandsEl.children.length = 0; } });
  const canvas: FakeCanvas = {
    width: 800,
    height: 260,
    style: {},
    addEventListener: () => {},
    getContext: () => makeCtx(),
  };
  const byId: Record<string, unknown> = {
    "peq-bands": bandsEl,
    "peq-graph": canvas,
    "peq-hpf": { value: "" },
    "peq-hpf-slope": { value: "0" },
    "peq-lpf": { value: "" },
    "peq-lpf-slope": { value: "0" },
    "peq-notice": { style: {} as Record<string, string>, textContent: "" },
    "btn-peq-xo": { onclick: null as ((() => void) | null) },
  };
  const handlers: Record<string, () => void> = {};
  const staged: StagedCall[] = [];
  const sandbox: Record<string, unknown> = {
    window: {
      addEventListener: (t: string, fn: () => void) => { handlers[t] = fn; },
    },
    document: {
      getElementById: (id: string) => {
        const el = byId[id];
        if (!el) throw new Error("unexpected id " + id);
        return el;
      },
      createElement: () => {
        const made = makeRow();
        return {
          className: made.row.className,
          classList: made.row.classList,
          style: made.row.style,
          querySelector: made.row.querySelector,
          set innerHTML(_v: string) {},
          appendChild: (_c: unknown) => {},
        };
      },
      querySelector: (sel: string) => {
        if (sel === "#peq-tabs button.active") return tabs.find((t) => t.classList.contains("active"));
        const m = sel.match(/data-out="([^"]+)"/);
        if (m) return tabs.find((t) => t.dataset.out === m[1]);
        throw new Error("unexpected selector " + sel);
      },
      querySelectorAll: (sel: string) => {
        if (sel === "#peq-tabs button") return tabs;
        throw new Error("unexpected selectorAll " + sel);
      },
    },
    stage: (key: string, _label: string, path: string, body: Record<string, unknown>) => {
      staged.push({ key, path, body });
    },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "peq.js" });
  handlers["DOMContentLoaded"]!();
  const win = sandbox["window"] as Record<string, (...a: never[]) => unknown>;
  return { win, tabs, bandsEl, staged };
}

function band() {
  return { freqHz: 1000, q: 1, gainDb: 0, type: 0 };
}

function output(name: string) {
  return {
    name, gainDb: 0, polarity: false, routingMask: 15, delayMs: 0,
    hpfHz: null, hpfSlope: 0, lpfHz: null, lpfSlope: 0,
    bands: Array.from({ length: 7 }, band),
    comp: { ratioIndex: 0, kneeDb: 0, attackMs: 0, releaseMs: 0, thresholdDb: 0 },
  };
}

function fixture() {
  return { inputs: [], outputs: ["Out1", "Out2", "Out3", "Out4"].map(output) };
}

function rowStates(bandsEl: { children: FakeRow[] }) {
  return bandsEl.children.map((r) => ({
    bypassed: r.classList.contains("bypassed"),
    pill: (r.querySelector(".peq-pill") as { textContent: string }).textContent,
    checked: (r.querySelector('[data-k="bypass"]') as FakeInput).checked,
  }));
}

function clickTab(tabs: TabButton[], out: string) {
  for (const t of tabs) t.classList.remove("active");
  const b = tabs.find((t) => t.dataset.out === out)!;
  b.classList.add("active");
  b.onclick!();
}

describe("peq bypass display", () => {
  it("tab switches never gray rows the device reports as active", () => {
    const { win, tabs, bandsEl } = loadPeq();
    (win["refreshPeq"] as (st: unknown) => void)(fixture());
    for (const out of ["Out2", "Out3", "Out4", "Out1", "Out2", "Out3"]) {
      clickTab(tabs, out);
      const states = rowStates(bandsEl);
      assert.equal(states.length, 7);
      for (const s of states) {
        assert.equal(s.bypassed, false);
        assert.equal(s.pill, "ACTIVE");
        assert.equal(s.checked, false);
      }
    }
  });

  it("checking bypass grays exactly that row and survives tab switches", () => {
    const { win, tabs, bandsEl, staged } = loadPeq();
    (win["refreshPeq"] as (st: unknown) => void)(fixture());
    clickTab(tabs, "Out3");
    const box = bandsEl.children[0]!.querySelector('[data-k="bypass"]') as FakeInput;
    box.checked = true;
    box.onchange!({ target: box });
    assert.equal(staged.at(-1)!.body["bypass"], true);
    let states = rowStates(bandsEl);
    assert.equal(states[0]!.bypassed, true);
    assert.equal(states[0]!.pill, "BYPASSED");
    for (const s of states.slice(1)) assert.equal(s.bypassed, false);
    clickTab(tabs, "Out1");
    clickTab(tabs, "Out3");
    states = rowStates(bandsEl);
    assert.equal(states[0]!.bypassed, true);
    assert.equal(states[0]!.pill, "BYPASSED");
    assert.equal(states[0]!.checked, true);
  });

  it("locally set bypass survives a device refresh the device cannot report", () => {
    const { win, tabs, bandsEl } = loadPeq();
    (win["refreshPeq"] as (st: unknown) => void)(fixture());
    clickTab(tabs, "Out2");
    const box = bandsEl.children[2]!.querySelector('[data-k="bypass"]') as FakeInput;
    box.checked = true;
    box.onchange!({ target: box });
    (win["refreshPeq"] as (st: unknown) => void)(fixture());
    clickTab(tabs, "Out2");
    const states = rowStates(bandsEl);
    assert.equal(states[2]!.bypassed, true);
    assert.equal(states[2]!.pill, "BYPASSED");
  });

  it("clearPeqBypass drops every tracked bypass", () => {
    const { win, tabs, bandsEl } = loadPeq();
    (win["refreshPeq"] as (st: unknown) => void)(fixture());
    const box = bandsEl.children[1]!.querySelector('[data-k="bypass"]') as FakeInput;
    box.checked = true;
    box.onchange!({ target: box });
    (win["clearPeqBypass"] as () => void)();
    for (const s of rowStates(bandsEl)) {
      assert.equal(s.bypassed, false);
      assert.equal(s.pill, "ACTIVE");
    }
    void tabs;
  });
});
