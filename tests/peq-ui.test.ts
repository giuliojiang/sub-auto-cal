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
  onclick: ((() => void) | null);
  onchange: (((e: { target: FakeInput }) => void) | null);
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

function makeContainer() {
  const children: FakeRow[] = [];
  const c = {
    children,
    appendChild: (r: FakeRow) => { children.push(r); },
    style: {} as Record<string, string>,
  };
  return {
    ...c,
    set innerHTML(_v: string) { children.length = 0; },
  };
}

function makeCtx(): unknown {
  return new Proxy({}, { get: () => () => {}, set: () => true });
}

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  listeners: string[];
  addEventListener: (t: string) => void;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  getContext: () => unknown;
}

function makeCanvas(): FakeCanvas {
  const listeners: string[] = [];
  return {
    width: 800,
    height: 260,
    style: {},
    listeners,
    addEventListener: (t: string) => { listeners.push(t); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 260 }),
    getContext: () => makeCtx(),
  };
}

interface StagedCall {
  key: string;
  path: string;
  body: Record<string, unknown>;
}

function loadPeq() {
  const src = readFileSync(join(root, "public", "peq.js"), "utf8");
  const bands = [makeContainer(), makeContainer(), makeContainer(), makeContainer()];
  const graphs = [makeCanvas(), makeCanvas(), makeCanvas(), makeCanvas()];
  const byId: Record<string, unknown> = {
    "peq-all": { style: { display: "none" } as Record<string, string> },
    "peq-notice": { style: { display: "" } as Record<string, string>, textContent: "" },
  };
  for (let oi = 0; oi < 4; oi++) {
    byId[`peq-bands-${oi}`] = bands[oi];
    byId[`peq-graph-${oi}`] = graphs[oi];
    byId[`peq-hpf-${oi}`] = { value: "" };
    byId[`peq-hpf-slope-${oi}`] = { value: "0", appendChild: (_o: unknown) => {} };
    byId[`peq-lpf-${oi}`] = { value: "" };
    byId[`peq-lpf-slope-${oi}`] = { value: "0", appendChild: (_o: unknown) => {} };
    byId[`btn-peq-xo-${oi}`] = { onclick: null as ((() => void) | null) };
  }
  const handlers: Record<string, (...a: never[]) => void> = {};
  const staged: StagedCall[] = [];
  const sandbox: Record<string, unknown> = {
    window: {
      addEventListener: (t: string, fn: (...a: never[]) => void) => { handlers[t] = fn; },
    },
    document: {
      getElementById: (id: string) => {
        const el = byId[id];
        if (!el) throw new Error("unexpected id " + id);
        return el;
      },
      createElement: (tag: string): unknown => {
        if (tag === "option") return { value: "", textContent: "" };
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
  const windowHandlers = Object.keys(handlers);
  return { win, bands, graphs, staged, windowHandlers };
}

function band(freqHz = 1000, q = 1, gainDb = 0, type = 0) {
  return { freqHz, q, gainDb, type };
}

function output(name: string, bands: ReturnType<typeof band>[]) {
  return {
    name, gainDb: 0, polarity: false, routingMask: 15, delayMs: 0,
    hpfHz: null, hpfSlope: 0, lpfHz: null, lpfSlope: 0,
    bands,
    comp: { ratioIndex: 0, kneeDb: 0, attackMs: 0, releaseMs: 500, thresholdDb: 20 },
  };
}

function fixture() {
  const seven = () => Array.from({ length: 7 }, () => band());
  return {
    inputs: [],
    outputs: [
      output("Out1", seven()),
      output("Out2", [band(100, 1, 3.5, 1), ...Array.from({ length: 6 }, () => band())]),
      output("Out3", seven()),
      output("Out4", [...Array.from({ length: 6 }, () => band()), band(5000, 2, -2.5, 0)]),
    ],
  };
}

function rowStates(children: FakeRow[]) {
  return children.map((r) => ({
    bypassed: r.classList.contains("bypassed"),
    pill: (r.querySelector(".peq-pill") as { textContent: string }).textContent,
    checked: (r.querySelector('[data-k="bypass"]') as FakeInput).checked,
  }));
}

function refresh(win: Record<string, (...a: never[]) => unknown>, st: unknown) {
  (win["refreshPeq"] as (s: unknown) => void)(st);
}

describe("peq all-outputs display", () => {
  it("renders all four outputs with their own values and nothing grayed", () => {
    const { win, bands } = loadPeq();
    refresh(win, fixture());
    for (const [oi, rows] of bands.map((b) => b.children).entries()) {
      assert.equal(rows.length, 7);
      for (const s of rowStates(rows)) {
        assert.equal(s.bypassed, false);
        assert.equal(s.pill, "ACTIVE");
        assert.equal(s.checked, false);
      }
      void oi;
    }
    const out2band0 = bands[1]!.children[0]!;
    assert.equal((out2band0.querySelector('[data-k="gainDb"]') as FakeInput).value, "3.5");
    assert.equal((out2band0.querySelector('[data-k="freqHz"]') as FakeInput).value, "100.0");
    assert.equal((out2band0.querySelector('[data-k="type"]') as FakeInput).value, "1");
    const out4band6 = bands[3]!.children[6]!;
    assert.equal((out4band6.querySelector('[data-k="gainDb"]') as FakeInput).value, "-2.5");
    assert.equal((out4band6.querySelector('[data-k="freqHz"]') as FakeInput).value, "5000.0");
    const out1band0 = bands[0]!.children[0]!;
    assert.equal((out1band0.querySelector('[data-k="gainDb"]') as FakeInput).value, "0.0");
  });

  it("repeated refreshes never gray rows the device reports as active", () => {
    const { win, bands } = loadPeq();
    refresh(win, fixture());
    refresh(win, fixture());
    refresh(win, fixture());
    for (const rows of bands.map((b) => b.children)) {
      for (const s of rowStates(rows)) {
        assert.equal(s.bypassed, false);
        assert.equal(s.pill, "ACTIVE");
      }
    }
  });

  it("checking bypass grays exactly that row", () => {
    const { win, bands, staged } = loadPeq();
    refresh(win, fixture());
    const box = bands[2]!.children[1]!.querySelector('[data-k="bypass"]') as FakeInput;
    box.checked = true;
    box.onchange!({ target: box });
    assert.equal(staged.at(-1)!.body["bypass"], true);
    assert.equal(staged.at(-1)!.body["chan"], "Out3");
    assert.equal(staged.at(-1)!.body["band"], 1);
    bands.forEach((b, oi) => {
      rowStates(b.children).forEach((s, i) => {
        const want = oi === 2 && i === 1;
        assert.equal(s.bypassed, want);
        assert.equal(s.pill, want ? "BYPASSED" : "ACTIVE");
      });
    });
  });

  it("locally set bypass survives a device refresh the device cannot report", () => {
    const { win, bands } = loadPeq();
    refresh(win, fixture());
    const box = bands[0]!.children[0]!.querySelector('[data-k="bypass"]') as FakeInput;
    box.checked = true;
    box.onchange!({ target: box });
    refresh(win, fixture());
    const states = rowStates(bands[0]!.children);
    assert.equal(states[0]!.bypassed, true);
    assert.equal(states[0]!.pill, "BYPASSED");
    assert.equal(states[0]!.checked, true);
  });

  it("graphs are view-only with no edit listeners", () => {
    const { win, graphs, windowHandlers } = loadPeq();
    refresh(win, fixture());
    for (const g of graphs) assert.deepEqual(g.listeners, []);
    assert.deepEqual(windowHandlers, ["DOMContentLoaded"]);
  });

  it("clearPeqBypass drops every tracked bypass", () => {
    const { win, bands } = loadPeq();
    refresh(win, fixture());
    for (const oi of [0, 3]) {
      const box = bands[oi]!.children[oi + 1]!.querySelector('[data-k="bypass"]') as FakeInput;
      box.checked = true;
      box.onchange!({ target: box });
    }
    (win["clearPeqBypass"] as () => void)();
    for (const rows of bands.map((b) => b.children)) {
      for (const s of rowStates(rows)) {
        assert.equal(s.bypassed, false);
        assert.equal(s.pill, "ACTIVE");
      }
    }
  });
});
