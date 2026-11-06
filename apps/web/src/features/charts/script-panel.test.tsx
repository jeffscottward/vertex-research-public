// @vitest-environment jsdom
import {
  type RunResult,
  runScript,
  SCRIPT_TEMPLATES,
  type ScriptBar,
} from "@darkfactory/scripting";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ScriptPanel, type ScriptPanelProps } from "./script-panel.tsx";
import { SCRIPT_RUN_SUPERSEDED, type ScriptRunner } from "./script-runner.ts";
import { handleScriptMessage, type ScriptInputs } from "./script-sandbox.ts";
import { activeScriptsKey, SCRIPTS_STORAGE_KEY } from "./scripts-storage.ts";
import type { DisplayCandle, ScriptLayer } from "./types.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  return document.body.replaceChildren();
});

const candle = (timestamp: number, close: number): DisplayCandle => ({
  close,
  high: close + 1,
  id: `bar-${timestamp}`,
  low: close - 1,
  open: close,
  timestamp,
  volume: 10,
});
const candles = [1, 2, 3, 4, 5].map((close, index) =>
  candle((index + 1) * 1000, close)
);

const okResult = (
  bars: readonly ScriptBar[],
  extra: Partial<Extract<RunResult, { ok: true }>> = {}
): RunResult => ({
  inputs: [
    { defval: 3, id: "length", kind: "int", max: 50, min: 1, title: "Length" },
    { defval: true, id: "show", kind: "bool", title: "Show" },
    { defval: "close", id: "src", kind: "source", title: "Source" },
    { defval: "a", id: "label", kind: "string", title: "" },
    { defval: 1.5, id: "mult", kind: "float", title: "Multiplier" },
  ],
  kind: "indicator",
  ok: true,
  overlay: true,
  plots: [
    {
      color: "#2962ff",
      id: "plot_0",
      kind: "line",
      title: "Line",
      values: bars.map((bar) => bar.close),
    },
  ],
  shortTitle: "",
  signals: [],
  title: "Fake",
  warnings: [],
  ...extra,
});
type Call = Readonly<{
  source: string;
  bars: readonly ScriptBar[];
  inputs: ScriptInputs;
}>;
const fakeRunner = (
  respond: (call: Call) => RunResult = ({ bars }) => okResult(bars)
) => {
  const calls: Call[] = [];
  const runner: ScriptRunner = {
    dispose: vi.fn(),
    run: vi.fn(async (source, bars, inputs) => {
      calls.push({ bars, inputs, source });
      return respond({ bars, inputs, source });
    }),
  };
  return { calls, runner };
};
const memoryStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

const flush = () =>
  act(async () => {
    for (let step = 0; step < 3; step += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

type HarnessProps = Omit<ScriptPanelProps, "open" | "onOpenChange"> &
  Readonly<{ initiallyOpen?: boolean }>;
const Harness = ({ initiallyOpen = true, ...props }: HarnessProps) => {
  const [open, setOpen] = useState(initiallyOpen);
  return <ScriptPanel {...props} onOpenChange={setOpen} open={open} />;
};

const mount = async (
  props: Partial<HarnessProps> & Readonly<{ runner?: ScriptRunner }> = {}
) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onLayers = vi.fn<(layers: readonly ScriptLayer[]) => void>();
  const storage = memoryStore();
  const base: HarnessProps = {
    candles,
    now: () => 1_700_000_000_000,
    onLayers,
    rerunDelayMs: 0,
    storage,
    symbol: "SPY",
    ...props,
  };
  const render = (next: Partial<HarnessProps> = {}) =>
    act(async () => root.render(<Harness {...base} {...next} />));
  await render();
  await flush();
  return { host, onLayers, render, storage: props.storage ?? storage };
};

const editor = (host: HTMLElement) => {
  const element = host.querySelector<HTMLTextAreaElement>(
    "[data-script-editor]"
  );
  if (element === null) throw new Error("editor missing");
  return element;
};
const setValue = (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  type = "input"
) => {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  element.dispatchEvent(new Event(type, { bubbles: true }));
};
const key = (element: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
};
const button = (host: HTMLElement, selector: string) => {
  const element = host.querySelector<HTMLButtonElement>(selector);
  if (element === null) throw new Error(`${selector} missing`);
  return element;
};
const status = (host: HTMLElement) =>
  host.querySelector("[data-script-status]")?.textContent ?? "";

describe("script panel", () => {
  it("is a labelled disclosure that starts collapsed when asked", async () => {
    const { host } = await mount({ initiallyOpen: false });
    const toggle = button(host, "[data-script-toggle]");
    const region = host.querySelector<HTMLElement>(
      `#${CSS.escape(toggle.getAttribute("aria-controls") ?? "")}`
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region?.hidden).toBe(true);
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(region?.hidden).toBe(false);
    expect(editor(host).getAttribute("aria-label")).toBe("Script source");
    expect(editor(host).className).toContain("font-mono");
    const gutter = host.querySelector<HTMLElement>("[data-script-gutter]");
    expect(gutter?.textContent).toBe("12345");
    // The line numbers follow the editor's scroll position.
    await act(async () => {
      editor(host).scrollTop = 40;
      editor(host).dispatchEvent(new Event("scroll"));
    });
    return expect(
      gutter?.querySelector<HTMLElement>("div")?.style.transform
    ).toBe("translateY(-40px)");
  });
  it("runs the editor script, applies it and builds input controls", async () => {
    const fake = fakeRunner();
    const { host, onLayers } = await mount({ runner: fake.runner });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(fake.calls[0]?.bars).toHaveLength(5);
    expect(fake.calls[0]?.inputs).toEqual({});
    expect(onLayers).toHaveBeenLastCalledWith([
      expect.objectContaining({ overlay: true, title: "Fake" }),
    ]);
    expect(status(host)).toContain(
      '"Fake" is on the chart: 1 plot, 0 signals.'
    );
    expect(host.querySelector("[data-applied-script]")?.textContent).toContain(
      "1 plots, 0 signals"
    );
    expect(button(host, "[data-script-run]").textContent).toBe(
      "Run (update chart)"
    );
    expect(host.querySelector("[data-script-inputs]")?.textContent).toContain(
      "Length"
    );
    // Controls are re-created when their value changes: look them up each time.
    const field = <T extends Element>(selector: string, index = 0): T => {
      const found = host.querySelectorAll<T>(
        `[data-script-inputs] ${selector}`
      )[index];
      if (found === undefined) throw new Error(`${selector} missing`);
      return found;
    };
    const commit = (element: HTMLInputElement, value: string) =>
      act(async () => {
        setValue(element, value);
        key(element, { key: "Enter" });
      });
    // Changing an input re-runs the applied script with it.
    expect(field<HTMLInputElement>("input[type=number]").max).toBe("50");
    await commit(field("input[type=number]"), "7");
    await flush();
    expect(fake.calls.at(-1)?.inputs).toEqual({ length: 7 });
    const runs = fake.calls.length;
    // Out of range, fractional or empty values are not applied; other keys do nothing.
    for (const value of ["0", "51", "2.5", ""])
      await commit(field("input[type=number]"), value);
    await act(async () => key(field("input[type=number]"), { key: "a" }));
    await flush();
    expect(fake.calls).toHaveLength(runs);
    await act(async () =>
      field<HTMLInputElement>("input[type=checkbox]").click()
    );
    await flush();
    expect(fake.calls.at(-1)?.inputs).toEqual({ length: 7, show: false });
    const source = field<HTMLSelectElement>("select");
    expect([...source.options].map((option) => option.value)).toContain("hl2");
    await act(async () => setValue(source, "hl2", "change"));
    await flush();
    expect(fake.calls.at(-1)?.inputs).toMatchObject({ src: "hl2" });
    const text = field<HTMLInputElement>("input[type=text]");
    await act(async () => {
      setValue(text, "b");
      text.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(fake.calls.at(-1)?.inputs).toMatchObject({ label: "b" });
    const mult = field<HTMLInputElement>("input[type=number]", 1);
    await act(async () => {
      setValue(mult, "2.5");
      mult.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(fake.calls.at(-1)?.inputs).toMatchObject({ mult: 2.5 });
    // Once the editor no longer matches the applied script, inputs stop updating it.
    await act(async () => setValue(editor(host), "changed"));
    await commit(field("input[type=number]"), "9");
    await flush();
    expect(fake.calls.at(-1)?.inputs).toMatchObject({ length: 7 });
    const [applied] = [...host.querySelectorAll("[data-applied-script]")];
    await act(async () =>
      applied
        ?.querySelector<HTMLButtonElement>("[aria-label^='Remove']")
        ?.click()
    );
    const calls = fake.calls.length;
    await commit(field("input[type=number]"), "11");
    await flush();
    return expect(fake.calls).toHaveLength(calls);
  });
  it("lists errors and moves the caret to the line", async () => {
    const fake = fakeRunner(() => ({
      errors: [
        { column: 3, line: 2, message: "Unknown name 'clse'" },
        { column: 1, line: 9, message: "Later" },
      ],
      ok: false,
    }));
    const { host, onLayers } = await mount({ runner: fake.runner });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(status(host)).toContain("did not run: 2 errors.");
    const errors = [
      ...host.querySelectorAll<HTMLButtonElement>(
        "[data-script-errors] button"
      ),
    ];
    expect(errors.map((entry) => entry.textContent)).toEqual([
      "2:3 Unknown name 'clse'",
      "9:1 Later",
    ]);
    await act(async () => errors[0]?.click());
    const area = editor(host);
    expect(document.activeElement).toBe(area);
    const firstLine = area.value.split("\n")[0] ?? "";
    expect(area.selectionStart).toBe(firstLine.length + 1 + 2);
    expect(onLayers).not.toHaveBeenCalledWith([expect.anything()]);
    return expect(host.querySelector("[data-applied-script]")).toBeNull();
  });
  it("inserts four spaces on Tab, leaves on Escape then Tab, runs on Ctrl+Enter", async () => {
    const fake = fakeRunner();
    const { host } = await mount({ runner: fake.runner });
    const area = editor(host);
    setValue(area, "ab");
    await flush();
    area.setSelectionRange(1, 1);
    const tab = await act(async () => key(area, { key: "Tab" }));
    expect(tab.defaultPrevented).toBe(true);
    expect(editor(host).value).toBe("a    b");
    expect(editor(host).selectionStart).toBe(5);
    await act(async () => key(area, { key: "Escape" }));
    const leave = await act(async () => key(area, { key: "Tab" }));
    expect(leave.defaultPrevented).toBe(false);
    const shifted = await act(async () =>
      key(area, { key: "Tab", shiftKey: true })
    );
    expect(shifted.defaultPrevented).toBe(false);
    expect(editor(host).value).toBe("a    b");
    await act(async () => key(area, { ctrlKey: true, key: "Enter" }));
    await flush();
    expect(fake.calls[0]?.source).toBe("a    b");
    await act(async () => key(area, { key: "Enter", metaKey: true }));
    await flush();
    return expect(fake.calls).toHaveLength(2);
  });
  it("saves, lists, opens and deletes user scripts", async () => {
    const fake = fakeRunner();
    const { host, storage } = await mount({ runner: fake.runner });
    expect(host.querySelector("[data-script-saved]")?.textContent).toContain(
      "No saved scripts yet."
    );
    expect(button(host, "[data-script-delete]").disabled).toBe(true);
    const title = host.querySelector<HTMLInputElement>("[data-script-title]");
    if (title === null) throw new Error("no title");
    await act(async () => setValue(title, "My average"));
    await act(async () => button(host, "[data-script-save]").click());
    expect(status(host)).toBe('Saved "My average".');
    const stored = JSON.parse(storage.getItem(SCRIPTS_STORAGE_KEY) ?? "[]");
    expect(stored).toEqual([
      expect.objectContaining({
        title: "My average",
        updatedAt: 1_700_000_000_000,
      }),
    ]);
    expect(button(host, "[data-script-delete]").disabled).toBe(false);
    // Saving again updates the same script.
    await act(async () => setValue(editor(host), "plot(open)"));
    await act(async () => button(host, "[data-script-save]").click());
    expect(JSON.parse(storage.getItem(SCRIPTS_STORAGE_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ id: stored[0].id, source: "plot(open)" }),
    ]);
    await act(async () => button(host, "[data-script-new]").click());
    expect(editor(host).value).toContain("indicator(");
    expect(title.value).toBe("");
    expect(document.activeElement).toBe(editor(host));
    const open = button(host, "[aria-label='Open My average']");
    await act(async () => open.click());
    expect(editor(host).value).toBe("plot(open)");
    expect(status(host)).toBe('Opened "My average".');
    await act(async () => button(host, "[data-script-delete]").click());
    expect(status(host)).toContain('Deleted "My average"');
    expect(storage.getItem(SCRIPTS_STORAGE_KEY)).toBe("[]");
    // Empty sources are not saved.
    await act(async () => setValue(editor(host), "  "));
    await act(async () => button(host, "[data-script-save]").click());
    return expect(status(host)).toBe("There is no script to save.");
  });
  it("says when the browser refuses to store a script", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const { host } = await mount({ storage });
    await act(async () => button(host, "[data-script-save]").click());
    return expect(status(host)).toContain("this browser refused to store it");
  });
  it("loads library templates grouped by category", async () => {
    const fake = fakeRunner();
    const { host, storage } = await mount({ runner: fake.runner });
    const select = host.querySelector<HTMLSelectElement>(
      "[data-script-template]"
    );
    if (select === null) throw new Error("no picker");
    const groups = [...select.querySelectorAll("optgroup")].map(
      (group) => group.label
    );
    expect(groups[0]).toBe("Trend");
    expect(groups).toContain("Strategy signals");
    const template = SCRIPT_TEMPLATES.find(
      (entry) => entry.category === "momentum"
    );
    if (template === undefined) throw new Error("no template");
    await act(async () => setValue(select, template.id, "change"));
    expect(host.querySelector("[data-script-library]")?.textContent).toContain(
      template.description
    );
    await act(async () => button(host, "[data-script-use-template]").click());
    expect(editor(host).value).toBe(template.source);
    expect(status(host)).toContain(template.title);
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    // A template on the chart is restored by reference after a reload.
    return expect(
      JSON.parse(storage.getItem(activeScriptsKey("SPY")) ?? "[]")
    ).toEqual([{ inputs: {}, ref: `template:${template.id}` }]);
  });
  it("edits and removes applied scripts and re-runs them on new bars", async () => {
    const fake = fakeRunner();
    const { host, onLayers, render } = await mount({ runner: fake.runner });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    await act(async () => button(host, "[data-script-new]").click());
    await act(async () => setValue(editor(host), "second"));
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(onLayers.mock.lastCall?.[0]).toHaveLength(2);
    expect(host.querySelector("[data-script-toggle]")?.textContent).toBe(
      "Scripts (2 on chart)"
    );
    // New bars: every applied script runs again; layers follow once all are done.
    const calls = fake.calls.length;
    const more = [...candles, candle(6000, 6)];
    await render({ candles: more });
    await flush();
    expect(fake.calls.slice(calls).map((call) => call.bars.length)).toEqual([
      6, 6,
    ]);
    expect(onLayers.mock.lastCall?.[0][0]?.plots[0]?.values).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const [first] = [...host.querySelectorAll("[data-applied-script]")];
    await act(async () =>
      first?.querySelector<HTMLButtonElement>("[aria-label^='Edit']")?.click()
    );
    expect(editor(host).value).toBe(fake.calls[0]?.source);
    expect(host.querySelector("[data-script-inputs]")).not.toBeNull();
    // Run on an edited chart script replaces it in place; the other stays.
    await act(async () => setValue(editor(host), "first, edited"));
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(
      [...host.querySelectorAll("[data-applied-script]")].map((entry) =>
        entry.getAttribute("data-applied-script")
      )
    ).toEqual([first?.getAttribute("data-applied-script"), expect.any(String)]);
    await act(async () =>
      first?.querySelector<HTMLButtonElement>("[aria-label^='Remove']")?.click()
    );
    expect(status(host)).toContain("from the chart");
    expect(onLayers.mock.lastCall?.[0]).toHaveLength(1);
    expect(button(host, "[data-script-run]").textContent).toBe("Run");
    const [second] = [...host.querySelectorAll("[data-applied-script]")];
    await act(async () =>
      second
        ?.querySelector<HTMLButtonElement>("[aria-label^='Remove']")
        ?.click()
    );
    expect(onLayers).toHaveBeenLastCalledWith([]);
    return expect(
      host.querySelector("[data-script-applied]")?.textContent
    ).toContain("No scripts on the chart.");
  });
  it("shows a failed re-run on the chart list and draws nothing for it", async () => {
    let mode: "ok" | "error" | "silent" = "ok";
    const fake = fakeRunner(({ bars }) =>
      mode === "ok"
        ? okResult(bars)
        : {
            errors:
              mode === "error"
                ? [{ column: 1, line: 1, message: "Too few bars" }]
                : [],
            ok: false,
          }
    );
    const { host, onLayers, render } = await mount({ runner: fake.runner });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    mode = "error";
    await render({ candles: candles.slice(0, 2) });
    await flush();
    const entry = () => host.querySelector("[data-applied-script]");
    expect(entry()?.textContent).toContain("Error: Too few bars");
    expect(onLayers).toHaveBeenLastCalledWith([]);
    // Editing a script whose last run failed offers no input controls yet.
    await act(async () =>
      entry()?.querySelector<HTMLButtonElement>("[aria-label^='Edit']")?.click()
    );
    expect(host.querySelector("[data-script-inputs]")).toBeNull();
    mode = "silent";
    await render({ candles: candles.slice(0, 3) });
    await flush();
    return expect(entry()?.textContent).toContain("Error: did not run");
  });
  it("refuses a ninth script", async () => {
    const fake = fakeRunner();
    const { host } = await mount({ runner: fake.runner });
    for (let index = 0; index < 9; index += 1) {
      await act(async () => button(host, "[data-script-new]").click());
      await act(async () => button(host, "[data-script-run]").click());
      await flush();
    }
    expect(host.querySelectorAll("[data-applied-script]")).toHaveLength(8);
    return expect(status(host)).toContain("At most 8 scripts");
  });
  it("runs a script sent by the assistant, once per request", async () => {
    const fake = fakeRunner(({ bars }) => okResult(bars, { title: "Quant" }));
    const { host, onLayers, render } = await mount({ runner: fake.runner });
    await render({
      request: { nonce: 1, source: "quant source", title: "From Quant" },
    });
    await flush();
    expect(editor(host).value).toBe("quant source");
    expect(fake.calls.map((call) => call.source)).toEqual(["quant source"]);
    expect(onLayers).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: "Quant" }),
    ]);
    await render({
      candles,
      request: { nonce: 1, source: "quant source", title: "From Quant" },
    });
    await flush();
    return expect(fake.calls).toHaveLength(1);
  });
  it("restores scripts that were on the chart for this symbol", async () => {
    const storage = memoryStore({
      [SCRIPTS_STORAGE_KEY]: JSON.stringify([
        { id: "a", source: "saved source", title: "Saved", updatedAt: 1 },
      ]),
      [activeScriptsKey("SPY")]: JSON.stringify([
        { inputs: { length: 4 }, ref: "saved:a" },
        { inputs: {}, ref: "saved:gone" },
        { inputs: {}, ref: `template:${SCRIPT_TEMPLATES[0]?.id}` },
      ]),
    });
    const fake = fakeRunner();
    const { host, onLayers } = await mount({ runner: fake.runner, storage });
    expect(fake.calls).toEqual([
      expect.objectContaining({
        inputs: { length: 4 },
        source: "saved source",
      }),
      expect.objectContaining({ source: SCRIPT_TEMPLATES[0]?.source }),
    ]);
    expect(onLayers.mock.lastCall?.[0]).toHaveLength(2);
    expect(host.querySelector("[data-saved-script='a']")).not.toBeNull();
    const active = () =>
      JSON.parse(storage.getItem(activeScriptsKey("SPY")) ?? "[]").map(
        (entry: { ref: string }) => entry.ref
      );
    // Deleting the saved script keeps it on the chart, no longer restorable.
    const [entry] = [...host.querySelectorAll("[data-applied-script]")];
    await act(async () =>
      entry?.querySelector<HTMLButtonElement>("[aria-label^='Edit']")?.click()
    );
    const title = host.querySelector<HTMLInputElement>("[data-script-title]");
    if (title === null) throw new Error("no title");
    await act(async () => setValue(title, " "));
    await act(async () => button(host, "[data-script-delete]").click());
    expect(status(host)).toBe('Deleted "Untitled script" from My scripts.');
    expect(active()).toEqual([`template:${SCRIPT_TEMPLATES[0]?.id}`]);
    // Saving the editor while it edits an applied script makes it restorable again.
    await act(async () => button(host, "[data-script-save]").click());
    expect(active()).toHaveLength(2);
    return expect(active()[0]).toMatch(/^saved:s/);
  });
  it("creates its own worker runner lazily and stops it on unmount", async () => {
    vi.stubGlobal("Worker", undefined);
    const { host } = await mount({});
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(status(host)).toContain("did not run: 1 error.");
    expect(host.querySelector("[data-script-errors]")?.textContent).toContain(
      "Web Worker"
    );
    return vi.unstubAllGlobals();
  });
  it("draws a real engine script end to end (integration)", async () => {
    // The real interpreter, called the way the worker calls it.
    const runner: ScriptRunner = {
      dispose: vi.fn(),
      run: async (source, bars, inputs) =>
        handleScriptMessage({ bars, id: 1, inputs, source }, runScript)
          ?.result ?? { errors: [], ok: false },
    };
    const { host, onLayers, render } = await mount({ runner });
    await render({
      request: {
        nonce: 1,
        source: 'indicator("t", overlay=true)\nplot(ta.sma(close, 3))',
        title: "t",
      },
    });
    await flush();
    expect(status(host)).toContain("is on the chart: 1 plot");
    const layer = onLayers.mock.lastCall?.[0][0];
    expect(layer?.overlay).toBe(true);
    expect(layer?.title).toBe("t");
    return expect(layer?.plots[0]?.values).toEqual([null, null, 2, 3, 4]);
  });
  it("uses window.localStorage by default and survives a blocked one", async () => {
    window.localStorage.setItem(
      SCRIPTS_STORAGE_KEY,
      JSON.stringify([{ id: "a", source: "s", title: "Stored", updatedAt: 1 }])
    );
    const fake = fakeRunner();
    const show = async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      await act(async () =>
        root.render(
          <ScriptPanel
            candles={candles}
            onLayers={vi.fn()}
            onOpenChange={vi.fn()}
            open
            runner={fake.runner}
            symbol="SPY"
          />
        )
      );
      return host;
    };
    expect(
      (await show()).querySelector("[data-saved-script='a']")
    ).not.toBeNull();
    window.localStorage.clear();
    const blocked = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    const host = await show();
    blocked.mockRestore();
    return expect(
      host.querySelector("[data-script-saved]")?.textContent
    ).toContain("No saved scripts yet.");
  });
  it("updates the same chart script when Run is pressed again", async () => {
    const fake = fakeRunner();
    const { host, onLayers } = await mount({ runner: fake.runner });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(fake.calls).toHaveLength(2);
    expect(host.querySelectorAll("[data-applied-script]")).toHaveLength(1);
    return expect(onLayers.mock.lastCall?.[0]).toHaveLength(1);
  });
  it("drops results that arrive for old bars, an edited editor or after unmount", async () => {
    const pending: ((result: RunResult) => void)[] = [];
    const calls: Call[] = [];
    const runner: ScriptRunner = {
      dispose: vi.fn(),
      run: vi.fn(
        (source, bars, inputs) =>
          new Promise<RunResult>((resolve) => {
            calls.push({ bars, inputs, source });
            pending.push(resolve);
          })
      ),
    };
    const { host, onLayers, render } = await mount({ runner });
    const answer = async (index: number) => {
      const call = calls[index];
      if (call === undefined) throw new Error(`no run ${index}`);
      await act(async () => pending[index]?.(okResult(call.bars)));
      await flush();
    };
    await act(async () => button(host, "[data-script-run]").click());
    expect(button(host, "[data-script-run]").disabled).toBe(true);
    await act(async () => setValue(editor(host), "edited meanwhile"));
    await answer(0);
    // Applied, but the editor now holds other code: it is not linked to that script.
    expect(host.querySelectorAll("[data-applied-script]")).toHaveLength(1);
    expect(button(host, "[data-script-run]").textContent).toBe("Run");
    const six = [...candles, candle(6000, 6)];
    const seven = [...six, candle(7000, 7)];
    await render({ candles: six });
    await flush();
    expect(host.querySelector("[data-applied-script]")?.textContent).toContain(
      "Running…"
    );
    await render({ candles: seven });
    await flush();
    expect(calls.map((call) => call.bars.length)).toEqual([5, 6, 7]);
    await answer(1);
    expect(onLayers.mock.lastCall?.[0][0]?.plots[0]?.values).toHaveLength(5);
    await answer(2);
    expect(onLayers.mock.lastCall?.[0][0]?.plots[0]?.values).toHaveLength(7);
    // Unmount with a run and a re-run still pending: their answers change nothing.
    await act(async () => button(host, "[data-script-run]").click());
    await render({ candles });
    await flush();
    expect(calls).toHaveLength(5);
    const drawn = onLayers.mock.calls.length;
    const root = roots.pop();
    await act(async () => root?.unmount());
    await answer(3);
    await answer(4);
    return expect(onLayers).toHaveBeenCalledTimes(drawn);
  });
  it("loads each symbol's own scripts and never stores one symbol's under another", async () => {
    const storage = memoryStore({
      [SCRIPTS_STORAGE_KEY]: JSON.stringify([
        { id: "q", source: "qqq source", title: "QQQ script", updatedAt: 1 },
      ]),
      [activeScriptsKey("QQQ")]: JSON.stringify([
        { inputs: {}, ref: "saved:q" },
      ]),
    });
    const fake = fakeRunner();
    const { host, onLayers, render } = await mount({
      runner: fake.runner,
      storage,
    });
    await act(async () => button(host, "[data-script-use-template]").click());
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    const spy = JSON.parse(storage.getItem(activeScriptsKey("SPY")) ?? "[]");
    expect(spy).toHaveLength(1);
    expect(onLayers.mock.lastCall?.[0]).toHaveLength(1);
    const runs = fake.calls.length;
    await render({ symbol: "QQQ" });
    // The SPY layer leaves the chart at once.
    expect(onLayers).toHaveBeenCalledWith([]);
    await flush();
    expect(fake.calls.slice(runs).map((call) => call.source)).toEqual([
      "qqq source",
    ]);
    expect(
      [...host.querySelectorAll("[data-applied-script]")].map(
        (entry) => entry.textContent
      )
    ).toEqual([expect.stringContaining("QQQ script")]);
    expect(
      JSON.parse(storage.getItem(activeScriptsKey("QQQ")) ?? "[]")
    ).toEqual([{ inputs: {}, ref: "saved:q" }]);
    expect(
      JSON.parse(storage.getItem(activeScriptsKey("SPY")) ?? "[]")
    ).toEqual(spy);
    expect(button(host, "[data-script-run]").textContent).toBe("Run");
    await render({ symbol: "SPY" });
    await flush();
    return expect(
      host.querySelector("[data-applied-script]")?.textContent
    ).toContain(SCRIPT_TEMPLATES[0]?.title ?? "?");
  });
  it("does not bring back a script removed or a symbol left while its run was going", async () => {
    const pending: ((result: RunResult) => void)[] = [];
    const calls: Call[] = [];
    const runner: ScriptRunner = {
      dispose: vi.fn(),
      run: vi.fn(
        (source, bars, inputs) =>
          new Promise<RunResult>((resolve) => {
            calls.push({ bars, inputs, source });
            pending.push(resolve);
          })
      ),
    };
    const { host, onLayers, render } = await mount({ runner });
    const answer = async (index: number) => {
      await act(async () =>
        pending[index]?.(okResult(calls[index]?.bars ?? []))
      );
      await flush();
    };
    await act(async () => button(host, "[data-script-run]").click());
    await answer(0);
    expect(host.querySelectorAll("[data-applied-script]")).toHaveLength(1);
    // Run again (update), then remove it before the answer arrives.
    await act(async () => button(host, "[data-script-run]").click());
    const [entry] = [...host.querySelectorAll("[data-applied-script]")];
    await act(async () =>
      entry?.querySelector<HTMLButtonElement>("[aria-label^='Remove']")?.click()
    );
    await answer(1);
    expect(host.querySelector("[data-applied-script]")).toBeNull();
    expect(status(host)).toContain("not applied");
    expect(onLayers).toHaveBeenLastCalledWith([]);
    // A new script whose symbol changed before it finished is not applied either.
    await act(async () => button(host, "[data-script-run]").click());
    await render({ symbol: "QQQ" });
    await answer(2);
    expect(host.querySelector("[data-applied-script]")).toBeNull();
    // A superseded run is dropped silently.
    const superseded = fakeRunner(() => SCRIPT_RUN_SUPERSEDED);
    await render({ runner: superseded.runner, symbol: "QQQ" });
    await act(async () => button(host, "[data-script-run]").click());
    await flush();
    expect(host.querySelector("[data-applied-script]")).toBeNull();
    return expect(status(host)).toContain("Running");
  });
});
