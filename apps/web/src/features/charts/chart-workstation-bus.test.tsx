// @vitest-environment jsdom
import type { RunResult } from "@darkfactory/scripting";
import { act } from "react";
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
import {
  currentChartContext,
  PENDING_SCRIPT_KEY,
  sendChartCommand,
} from "./chart-bus.ts";
import { ChartWorkstation } from "./chart-workstation.tsx";
import type { ScriptRunner } from "./script-runner.ts";
import type {
  CandleRenderer,
  CandleRendererFactory,
  DisplayCandle,
  ScriptLayer,
} from "./types.ts";
import type { Drawing } from "./workstation.ts";

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

const candles: readonly DisplayCandle[] = [
  {
    close: 11,
    high: 12,
    id: "a",
    low: 9,
    open: 10,
    timestamp: 1000,
    volume: 5,
  },
  {
    close: 12,
    high: 13,
    id: "b",
    low: 10,
    open: 11,
    timestamp: 2000,
    volume: 7,
  },
];
const level = (id: string): Drawing => ({
  id,
  points: [{ timestamp: 1000, value: 10 }],
  text: "",
  tool: "level",
});
const memoryStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};
const fakeRenderer = () => ({
  dispose: vi.fn(),
  replace: vi.fn(),
  resize: vi.fn(),
  setDrawings: vi.fn(),
  setScriptPlots: vi.fn<(layers: readonly ScriptLayer[]) => void>(),
});
const result = (overlay: boolean): RunResult => ({
  inputs: [],
  kind: "indicator",
  ok: true,
  overlay,
  plots: [
    {
      color: "#2962ff",
      id: "plot_0",
      kind: "line",
      title: "x",
      values: [1, 2],
    },
  ],
  shortTitle: "QS",
  signals: [],
  title: "Quant script",
  warnings: [],
});
const fakeRunner = (overlay = false) => {
  const run = vi.fn(async () => result(overlay));
  return { dispose: vi.fn(), run } satisfies ScriptRunner;
};
const flush = () =>
  act(async () => {
    for (let step = 0; step < 3; step += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

const mount = async (
  options: Readonly<{
    renderer?: Partial<CandleRenderer> &
      Pick<CandleRenderer, "replace" | "resize" | "dispose">;
    storage?: ReturnType<typeof memoryStore> | null;
    scriptStorage?: ReturnType<typeof memoryStore>;
    runner?: ScriptRunner;
    // true: no injected target, so the workstation uses the window (the default).
    useWindow?: boolean;
  }> = {}
) => {
  const renderer = options.renderer ?? fakeRenderer();
  const factory: CandleRendererFactory = async () => renderer;
  const target: EventTarget = options.useWindow ? window : new EventTarget();
  const storage =
    options.storage === undefined ? memoryStore() : options.storage;
  const scriptStorage = options.scriptStorage ?? memoryStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <ChartWorkstation
        candles={candles}
        captions={{ error: "error", loading: "loading", ready: "ready" }}
        {...(options.useWindow ? {} : { commandTarget: target })}
        factory={factory}
        label="SPY 1 day bars"
        markers={[]}
        pricePrecision={2}
        scriptRunner={options.runner ?? fakeRunner()}
        scriptStorage={scriptStorage}
        storage={storage}
        studies={{ ema: [], sma: [], volume: false }}
        symbol="SPY"
      />
    )
  );
  await flush();
  return { host, renderer, root, scriptStorage, storage, target };
};

describe("chart workstation and the chart command bus", () => {
  it("shows Quant drawings sent for this symbol, marks them and clears them", async () => {
    const storage = memoryStore({
      "vx.charts.drawings.SPY": JSON.stringify([level("mine")]),
    });
    const { host, renderer, target } = await mount({ storage });
    expect(host.querySelector("[data-clear-quant]")).toBeNull();
    await act(async () => {
      sendChartCommand(
        {
          drawings: [level("a")],
          replace: false,
          symbol: "QQQ",
          type: "drawings",
        },
        storage,
        target
      );
    });
    expect(host.querySelector("[data-drawing-id='quant-a']")).toBeNull();
    await act(async () => {
      sendChartCommand(
        {
          drawings: [level("a")],
          replace: false,
          symbol: "spy",
          type: "drawings",
        },
        storage,
        target
      );
    });
    expect(renderer.setDrawings).toHaveBeenLastCalledWith(
      [level("mine"), level("quant-a")],
      expect.any(Function)
    );
    const quant = host.querySelector("[data-drawing-id='quant-a']");
    expect(quant?.querySelector("[data-quant-badge]")?.textContent).toBe(
      "Quant"
    );
    expect(quant?.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Remove Quant Horizontal level 10.00"
    );
    expect(
      host.querySelector("[data-drawing-id='mine'] [data-quant-badge]")
    ).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>("[data-clear-quant]")?.click()
    );
    expect(storage.data.get("vx.charts.drawings.SPY")).toBe(
      JSON.stringify([level("mine")])
    );
    expect(host.querySelector("[data-drawing-id='quant-a']")).toBeNull();
    expect(host.querySelector("[data-clear-quant]")).toBeNull();
    return expect(host.textContent).toContain("Removed Quant's drawings.");
  });
  it("listens and clears on the window by default", async () => {
    const storage = memoryStore({
      "vx.charts.drawings.SPY": JSON.stringify([level("mine")]),
    });
    const { host } = await mount({ storage, useWindow: true });
    await act(async () => {
      sendChartCommand(
        {
          drawings: [level("a")],
          replace: true,
          symbol: "SPY",
          type: "drawings",
        },
        storage,
        window
      );
    });
    expect(host.querySelector("[data-drawing-id='quant-a']")).not.toBeNull();
    const heard = vi.fn();
    window.addEventListener("vx:chart-command", heard);
    await act(async () =>
      host.querySelector<HTMLButtonElement>("[data-clear-quant]")?.click()
    );
    window.removeEventListener("vx:chart-command", heard);
    expect(heard).toHaveBeenCalledTimes(1);
    return expect(host.querySelector("[data-drawing-id='quant-a']")).toBeNull();
  });
  it("shows and clears Quant drawings for this visit when storage refuses them", async () => {
    const storage = memoryStore({
      "vx.charts.drawings.SPY": JSON.stringify([level("mine")]),
    });
    const { host, target } = await mount({ storage });
    storage.setItem = () => {
      throw new Error("quota");
    };
    await act(async () => {
      expect(
        sendChartCommand(
          {
            drawings: [level("a")],
            replace: false,
            symbol: "SPY",
            type: "drawings",
          },
          storage,
          target
        )
      ).toBe(false);
    });
    // Not stored, but applied from the command itself.
    expect(storage.data.get("vx.charts.drawings.SPY")).toBe(
      JSON.stringify([level("mine")])
    );
    expect(host.querySelector("[data-drawing-id='quant-a']")).not.toBeNull();
    expect(host.querySelector("[data-drawing-id='mine']")).not.toBeNull();
    const clear = host.querySelector<HTMLButtonElement>("[data-clear-quant]");
    if (clear === null) throw new Error("clear button missing");
    await act(async () => clear.click());
    expect(host.querySelector("[data-drawing-id='quant-a']")).toBeNull();
    expect(host.querySelector("[data-drawing-id='mine']")).not.toBeNull();
    return expect(host.textContent).toContain("for this visit only");
  });
  it("opens the script panel with a script sent by the assistant and applies it", async () => {
    const runner = fakeRunner(false);
    const { host, renderer, scriptStorage, target } = await mount({ runner });
    const toggle = host.querySelector("[data-script-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      sendChartCommand(
        { source: "plot(close)", title: "From Quant", type: "script" },
        scriptStorage,
        target
      );
    });
    await flush();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(scriptStorage.data.has(PENDING_SCRIPT_KEY)).toBe(false);
    expect(runner.run).toHaveBeenCalledWith(
      "plot(close)",
      expect.any(Array),
      {},
      "editor"
    );
    expect(renderer.setScriptPlots).toHaveBeenLastCalledWith([
      expect.objectContaining({ overlay: false, title: "QS" }),
    ]);
    expect(host.querySelector("[data-object-tree]")?.textContent).toContain(
      "Script: QS"
    );
    // A pane layer grows the chart by one pane.
    return expect(
      host
        .querySelector<HTMLElement>(".vx-chart-canvas")
        ?.style.getPropertyValue("--vx-chart-sub-panes")
    ).toBe("1");
  });
  it("uses the command's own script when storage refused the pending copy", async () => {
    const runner = fakeRunner(true);
    const { target } = await mount({ runner });
    await act(async () => {
      target.dispatchEvent(
        new CustomEvent("vx:chart-command", {
          detail: { source: "plot(open)", title: "Q", type: "script" },
        })
      );
    });
    await flush();
    expect(runner.run).toHaveBeenCalledWith(
      "plot(open)",
      expect.any(Array),
      {},
      "editor"
    );
    await act(async () => {
      target.dispatchEvent(
        new CustomEvent("vx:chart-command", {
          detail: { source: "", title: "Q", type: "script" },
        })
      );
      target.dispatchEvent(
        new CustomEvent("vx:chart-command", {
          detail: { symbol: 4, type: "clear_quant" },
        })
      );
      // Nothing stored for this symbol yet: no drawings.
      target.dispatchEvent(
        new CustomEvent("vx:chart-command", {
          detail: { symbol: "SPY", type: "clear_quant" },
        })
      );
    });
    await flush();
    return expect(runner.run).toHaveBeenCalledTimes(1);
  });
  it("runs a pending script on mount", async () => {
    const scriptStorage = memoryStore({
      [PENDING_SCRIPT_KEY]: JSON.stringify({
        source: "plot(high)",
        title: "P",
      }),
    });
    const runner = fakeRunner(true);
    const { host } = await mount({ runner, scriptStorage });
    expect(runner.run).toHaveBeenCalledWith(
      "plot(high)",
      expect.any(Array),
      {},
      "editor"
    );
    expect(scriptStorage.data.has(PENDING_SCRIPT_KEY)).toBe(false);
    return expect(
      host.querySelector("[data-script-toggle]")?.getAttribute("aria-expanded")
    ).toBe("true");
  });
  it("reports script output the renderer cannot draw", async () => {
    const renderer = {
      ...fakeRenderer(),
      setScriptPlots: vi.fn((layers: readonly ScriptLayer[]) => {
        if (layers.length > 0) throw new TypeError("Invalid script layers");
      }),
    };
    const scriptStorage = memoryStore({
      [PENDING_SCRIPT_KEY]: JSON.stringify({
        source: "plot(high)",
        title: "P",
      }),
    });
    const { host } = await mount({ renderer, scriptStorage });
    return expect(host.textContent).toContain(
      "Script output could not be drawn on the chart."
    );
  });
  it("drops only the layer that cannot be drawn and names it", async () => {
    const good = result(true);
    const broken: RunResult = {
      ...result(true),
      plots: [
        {
          color: "#2962ff",
          id: "plot_0",
          kind: "line",
          title: "x",
          values: [Number.NaN, 1],
        },
      ],
      shortTitle: "Broken",
    } as RunResult;
    let calls = 0;
    const runner: ScriptRunner = {
      dispose: vi.fn(),
      run: vi.fn(async () => {
        calls += 1;
        // The second script plots a NaN, which the chart cannot draw.
        return calls === 1 ? good : broken;
      }),
    };
    const { host, renderer, target } = await mount({ runner });
    for (const title of ["one", "two"]) {
      await act(async () => {
        target.dispatchEvent(
          new CustomEvent("vx:chart-command", {
            detail: { source: `plot(${title})`, title, type: "script" },
          })
        );
      });
      await flush();
    }
    expect(renderer.setScriptPlots).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: "QS" }),
    ]);
    expect(host.textContent).toContain(
      "Script output could not be drawn on the chart: Broken."
    );
    return expect(
      host.querySelector("[data-object-tree]")?.textContent
    ).not.toContain("Broken");
  });
  it("publishes the chart context and clears it on unmount", async () => {
    const { root } = await mount();
    expect(currentChartContext()).toEqual({
      bars: 2,
      firstTimestamp: 1000,
      label: "SPY 1 day bars",
      lastClose: 12,
      lastTimestamp: 2000,
      symbol: "SPY",
    });
    await act(async () => root.unmount());
    roots.splice(0);
    return expect(currentChartContext()).toBeNull();
  });
});
