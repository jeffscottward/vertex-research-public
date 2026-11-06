// @vitest-environment jsdom
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
import { ChartWorkstation } from "./chart-workstation.tsx";
import type {
  CandleRenderer,
  CandleRendererFactory,
  DisplayCandle,
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
const level: Drawing = {
  id: "d1",
  points: [{ timestamp: 1000, value: 10 }],
  text: "",
  tool: "level",
};
const captions = { error: "error", loading: "loading", ready: "ready" };

const fakeRenderer = () => {
  let crosshair: ((timestamp: number | null) => void) | undefined;
  let changed: ((drawing: Drawing) => void) | undefined;
  const renderer = {
    dispose: vi.fn(),
    onCrosshair: vi.fn((listener: (timestamp: number | null) => void) => {
      crosshair = listener;
    }),
    replace: vi.fn(),
    resize: vi.fn(),
    setChartType: vi.fn(),
    setDrawings: vi.fn(),
    snapshot: vi.fn(() => "data:image/png;base64,AA"),
    startDrawing: vi.fn(
      (_tool: string, _text: string, onChange: (drawing: Drawing) => void) => {
        changed = onChange;
      }
    ),
  };
  return {
    complete: (drawing: Drawing) => changed?.(drawing),
    hover: (timestamp: number | null) => crosshair?.(timestamp),
    renderer,
  };
};

const mount = async (
  renderer: Partial<CandleRenderer> &
    Pick<CandleRenderer, "replace" | "resize" | "dispose">,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  symbol = "SPY",
  clock: (() => Date) | null = () => new Date("2026-11-04T00:00:00.000Z")
) => {
  const factory: CandleRendererFactory = async () => renderer;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (nextSymbol: string) =>
    act(async () =>
      root.render(
        <ChartWorkstation
          candles={candles}
          captions={captions}
          factory={factory}
          label="SPY 1 day bars"
          markers={[{ id: "m", text: "Long", timestamp: 1000, value: 10 }]}
          {...(clock ? { now: clock } : {})}
          pricePrecision={2}
          storage={storage}
          studies={{ ema: [9], extra: ["macd"], sma: [20], volume: true }}
          symbol={nextSymbol}
        />
      )
    );
  await render(symbol);
  await act(async () => {
    await Promise.resolve();
  });
  return { host, render };
};

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("chart workstation", () => {
  it("shows the data window, object tree and restores saved drawings", async () => {
    const fake = fakeRenderer();
    const storage = memoryStorage({
      "vx.charts.drawings.SPY": JSON.stringify([level]),
    });
    const { host } = await mount(fake.renderer, storage);
    expect(fake.renderer.setChartType).toHaveBeenCalledWith("candles");
    expect(fake.renderer.setDrawings).toHaveBeenLastCalledWith(
      [level],
      expect.any(Function)
    );
    // A pressed state changes colour only; a font-weight change would shift layout.
    const toggles = [...host.querySelectorAll("button[data-drawing-tool]")];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.className).not.toMatch(/font-(semibold|bold|medium)/);
    }
    const window = host.querySelector("[data-data-window]");
    expect(window?.textContent).toContain("12.00");
    expect(window?.textContent).toContain("+1.00 (+9.09%)");
    await act(async () => fake.hover(1000));
    expect(window?.textContent).toContain("1970-01-01T00:00:01.000Z");
    await act(async () => fake.hover(null));
    expect(window?.textContent).toContain("1970-01-01T00:00:02.000Z");
    const tree = host.querySelector("[data-object-tree]")?.textContent ?? "";
    for (const entry of [
      "Candles",
      "Volume",
      "SMA 20",
      "EMA 9",
      "MACD",
      "Trade markers (1)",
      "Horizontal level 10.00",
    ])
      expect(tree).toContain(entry);
    const remove = host.querySelector<HTMLButtonElement>(
      "[data-drawing-id='d1'] button"
    );
    await act(async () => remove?.click());
    expect(storage.data.get("vx.charts.drawings.SPY")).toBe("[]");
    return expect(host.querySelector("[data-drawing-id]")).toBeNull();
  });
  it("resets the data window on pointer leave, a symbol change and an unknown time", async () => {
    const fake = fakeRenderer();
    const { host, render } = await mount(fake.renderer, memoryStorage());
    const dataWindow = host.querySelector("[data-data-window]");
    const latest = "1970-01-01T00:00:02.000Z";
    const first = "1970-01-01T00:00:01.000Z";
    await act(async () => fake.hover(1000));
    expect(dataWindow?.textContent).toContain(first);
    // KLineCharts sends no crosshair event when the pointer leaves the chart.
    // React builds onPointerLeave from pointerout with a target outside the element.
    const canvasHost = host.querySelector("figure")?.parentElement;
    const leave = async (pointerType: string) =>
      await act(async () => {
        const event = new MouseEvent("pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        });
        Object.defineProperty(event, "pointerType", { value: pointerType });
        canvasHost?.dispatchEvent(event);
      });
    // A lifted touch keeps the tapped bar, as KLineCharts keeps its crosshair there.
    await leave("touch");
    expect(host.querySelector("[data-data-window]")?.textContent).toContain(
      first
    );
    await leave("mouse");
    expect(host.querySelector("[data-data-window]")?.textContent).toContain(
      latest
    );
    // A hovered time that is not in the series falls back to the latest bar.
    await act(async () => fake.hover(5000));
    expect(host.querySelector("[data-data-window]")?.textContent).toContain(
      latest
    );
    // A hover from the previous symbol does not carry over.
    await act(async () => fake.hover(1000));
    await render("QQQ");
    expect(host.querySelector("[data-data-window]")?.textContent).toContain(
      latest
    );
  });
  it("switches chart type to Heikin Ashi and draws tools", async () => {
    const fake = fakeRenderer();
    const storage = memoryStorage();
    const { host } = await mount(fake.renderer, storage);
    const select = host.querySelector<HTMLSelectElement>("[data-chart-type]");
    await act(async () => {
      if (select === null) return;
      select.value = "heikin-ashi";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fake.renderer.setChartType).toHaveBeenLastCalledWith("heikin-ashi");
    expect(fake.renderer.replace).toHaveBeenLastCalledWith([
      expect.objectContaining({ close: 10.5, id: "a", open: 10.5 }),
      expect.objectContaining({ close: 11.5, id: "b", open: 10.5 }),
    ]);
    await act(async () => {
      if (select === null) return;
      select.value = "renko";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select?.value).toBe("heikin-ashi");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-drawing-tool='text']")
        ?.click()
    );
    expect(fake.renderer.startDrawing).toHaveBeenLastCalledWith(
      "text",
      "Note",
      expect.any(Function)
    );
    expect(host.textContent).toContain("place the text note");
    const input = host.querySelector<HTMLInputElement>("input[maxlength='80']");
    await act(async () => {
      if (input === null) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "Breakout");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-drawing-tool='text']")
        ?.click()
    );
    expect(fake.renderer.startDrawing).toHaveBeenLastCalledWith(
      "text",
      "Breakout",
      expect.any(Function)
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-drawing-tool='trend']")
        ?.click()
    );
    expect(fake.renderer.startDrawing).toHaveBeenLastCalledWith(
      "trend",
      "",
      expect.any(Function)
    );
    await act(async () => fake.complete(level));
    expect(
      JSON.parse(storage.data.get("vx.charts.drawings.SPY") ?? "[]")
    ).toEqual([level]);
    return expect(host.querySelector("[data-drawing-id='d1']")).not.toBeNull();
  });
  it("exports a PNG screenshot and reports missing snapshots", async () => {
    const fake = fakeRenderer();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { host } = await mount(fake.renderer, null, "SPY", null);
    const button = host.querySelector<HTMLButtonElement>(
      "[data-chart-screenshot]"
    );
    await act(async () => button?.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Screenshot saved as PNG.");
    fake.renderer.snapshot.mockReturnValue("");
    await act(async () => button?.click());
    expect(host.textContent).toContain("Screenshot is not available yet.");
    return click.mockRestore();
  });
  it("reloads drawings per symbol and survives storage failures", async () => {
    const fake = fakeRenderer();
    const storage = {
      getItem: (key: string) =>
        key.endsWith("QQQ") ? JSON.stringify([level]) : null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const { host, render } = await mount(fake.renderer, storage);
    expect(host.querySelector("[data-drawing-id]")).toBeNull();
    await render("QQQ");
    expect(host.querySelector("[data-drawing-id='d1']")).not.toBeNull();
    await render("QQQ");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-drawing-id='d1'] button")
        ?.click()
    );
    return expect(host.textContent).toContain("could not be saved");
  });
  it("works with a minimal renderer and the default browser storage", async () => {
    const renderer = { dispose: vi.fn(), replace: vi.fn(), resize: vi.fn() };
    const factory: CandleRendererFactory = async () => renderer;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () =>
      root.render(
        <ChartWorkstation
          candles={[]}
          captions={captions}
          factory={factory}
          label="Empty"
          markers={[]}
          pricePrecision={2}
          studies={{ ema: [], sma: [], volume: false }}
          symbol="SPY"
        />
      )
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-drawing-tool='trend']")
        ?.click()
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>("[data-chart-screenshot]")?.click()
    );
    expect(host.textContent).toContain("Screenshot is not available yet.");
    const getter = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    await act(async () =>
      root.render(
        <ChartWorkstation
          candles={[]}
          captions={captions}
          factory={factory}
          label="Empty"
          markers={[]}
          pricePrecision={2}
          studies={{ ema: [], sma: [], volume: false }}
          symbol="IWM"
        />
      )
    );
    getter.mockRestore();
    return expect(
      host.querySelector("[data-data-window] dl")?.textContent
    ).toBe("");
  });
});
