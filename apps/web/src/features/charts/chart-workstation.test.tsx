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
import { ChartWorkstation, takeScreenshot } from "./chart-workstation.tsx";
import type {
  CandleRenderer,
  CandleRendererFactory,
  DisplayCandle,
  ExpectedMoveCone,
  SeriesPane,
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
  // The workstation hands its storage to the chart bus, whose port includes removeItem.
  const store =
    storage === null
      ? null
      : {
          getItem: (name: string) => storage.getItem(name),
          removeItem: () => undefined,
          setItem: (name: string, value: string) =>
            storage.setItem(name, value),
        };
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
          storage={store}
          studies={{
            ema: [9],
            extra: ["macd"],
            panes: ["RSI"],
            sma: [20],
            volume: true,
          }}
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
    expect(host.querySelector("[data-no-volume]")).toBeNull();
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
      "RSI",
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
    expect(host.textContent).toContain(
      "Screenshot not saved: the renderer returned an empty image · try again when bars are drawn"
    );
    return click.mockRestore();
  });
  it("names why no screenshot can be taken before a renderer exists", () => {
    expect(takeScreenshot(null)).toEqual({
      message:
        "Screenshot not saved: the chart is not drawn (see the caption under the chart) · try again when bars are drawn",
      saved: false,
    });
    expect(takeScreenshot({})).toEqual({
      message: "Screenshot not saved: this chart renderer has no image export",
      saved: false,
    });
    return expect(takeScreenshot({ snapshot: () => "data:x" })).toEqual({
      saved: true,
      url: "data:x",
    });
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
    const button = (selector: string) => {
      const found = host.querySelector<HTMLButtonElement>(selector);
      if (found === null) throw new Error(`${selector} missing`);
      return found;
    };
    // A renderer without startDrawing: the tool does nothing and gives no instructions.
    await act(async () => button("[data-drawing-tool='trend']").click());
    expect(host.textContent).not.toContain("Click on the chart");
    await act(async () => button("[data-chart-screenshot]").click());
    expect(host.textContent).toContain(
      "Screenshot not saved: this chart renderer has no image export"
    );
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
    expect(host.querySelector("[data-data-window] dl")?.textContent).toBe("");
    return expect(
      host.querySelector("[data-object-tree]")?.textContent
    ).toContain("Candles");
  });
  it("shows No volume and keeps the volume pane and volume studies off for bars without volume", async () => {
    const renderer = {
      dispose: vi.fn(),
      replace: vi.fn(),
      resize: vi.fn(),
      setStudies: vi.fn(),
    };
    const factory: CandleRendererFactory = async () => renderer;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const forex = candles.map(({ volume: _, ...bar }) => bar);
    await act(async () =>
      root.render(
        <ChartWorkstation
          candles={forex}
          captions={captions}
          factory={factory}
          label="EUR.USD 1 day bars"
          markers={[]}
          pricePrecision={5}
          storage={null}
          studies={{
            ema: [],
            extra: ["vwap", "rvol", "alphatrend", "macd"],
            panes: ["OBV", "RSI"],
            sma: [],
            volume: true,
          }}
          symbol="EUR.USD"
        />
      )
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderer.setStudies).toHaveBeenLastCalledWith({
      ema: [],
      extra: ["alphatrend", "macd"],
      panes: ["RSI"],
      sma: [],
      volume: false,
    });
    expect(host.querySelector("[data-data-window] dl")?.textContent).toContain(
      "VolumeNo volume"
    );
    expect(host.querySelector("[data-no-volume]")?.textContent).toContain(
      "No volume for this instrument"
    );
    const tree = host.querySelector("[data-object-tree]")?.textContent ?? "";
    expect(tree).toContain("AlphaTrend 14, 1 (RSI)");
    expect(tree).not.toContain("VWAP");
    expect(tree).not.toContain("OBV");
    return expect(tree).not.toMatch(/Volume/);
  });
});

describe("chart workstation series pane", () => {
  const pane: SeriesPane = {
    points: [{ timestamp: 1000, value: 5 }],
    precision: 0,
    title: "OI change",
  };
  const seriesRenderer = (
    setSeriesPane = vi.fn(),
    setExpectedMove = vi.fn()
  ) => ({
    dispose: vi.fn(),
    replace: vi.fn(),
    resize: vi.fn(),
    setExpectedMove,
    setSeriesPane,
  });
  // Each factory call takes the next renderer; the last one is used again.
  const mountSeries = async (
    renderers: readonly ReturnType<typeof seriesRenderer>[]
  ) => {
    let built = 0;
    const factory: CandleRendererFactory = async () => {
      const next = renderers[Math.min(built, renderers.length - 1)];
      built += 1;
      if (next === undefined) throw new Error("no renderer");
      return next;
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const render = async (props: {
      expectedMove?: ExpectedMoveCone | null;
      seriesPane?: SeriesPane | null;
    }) => {
      await act(async () =>
        root.render(
          <ChartWorkstation
            candles={candles}
            captions={captions}
            factory={factory}
            label="ES 1 day bars"
            markers={[]}
            pricePrecision={2}
            storage={null}
            studies={{ ema: [], sma: [], volume: false }}
            symbol="ES"
            {...props}
          />
        )
      );
      await act(async () => {
        await Promise.resolve();
      });
    };
    const subPanes = () =>
      host
        .querySelector<HTMLElement>("[data-chart-canvas]")
        ?.style.getPropertyValue("--vx-chart-sub-panes");
    return { host, render, subPanes };
  };

  it("applies the pane, clears it on null and counts it in the chart height", async () => {
    const renderer = seriesRenderer();
    const { render, subPanes } = await mountSeries([renderer]);
    await render({ seriesPane: pane });
    expect(renderer.setSeriesPane).toHaveBeenLastCalledWith(pane);
    expect(subPanes()).toBe("1");
    await render({ seriesPane: null });
    expect(renderer.setSeriesPane).toHaveBeenLastCalledWith(null);
    expect(subPanes()).toBe("0");
    // A caller without the prop clears the pane too and adds no height.
    await render({ seriesPane: pane });
    renderer.setSeriesPane.mockClear();
    await render({});
    expect(renderer.setSeriesPane).toHaveBeenLastCalledWith(null);
    expect(subPanes()).toBe("0");
  });
  it("applies the pane again after a renderer rebuild", async () => {
    const first = seriesRenderer();
    const second = seriesRenderer();
    const { render } = await mountSeries([first, second]);
    await render({ seriesPane: pane });
    expect(first.setSeriesPane).toHaveBeenLastCalledWith(pane);
    expect(second.setSeriesPane).not.toHaveBeenCalled();
    // A theme change on the root element makes the host build a new renderer.
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    document.documentElement.removeAttribute("data-theme");
    expect(first.dispose).toHaveBeenCalled();
    expect(second.setSeriesPane).toHaveBeenLastCalledWith(pane);
  });
  it("shows a status text when the renderer cannot draw the pane", async () => {
    const renderer = seriesRenderer(
      vi.fn((next: SeriesPane | null) => {
        if (next !== null) throw new TypeError("Invalid series pane");
      })
    );
    const { host, render } = await mountSeries([renderer]);
    await render({});
    expect(host.textContent).not.toContain("A data pane could not be drawn");
    await render({ seriesPane: pane });
    expect(host.textContent).toContain(
      "A data pane could not be drawn on the chart."
    );
  });

  it("applies expected move cone, lists it in the object tree, and handles renderer errors", async () => {
    const cone: ExpectedMoveCone = {
      basis: "atm_straddle_mid",
      dte: 10,
      expectedMove: 12,
      expectedMovePct: 0.02,
      expiry: "2026-11-20",
      expiryCloseMs: Date.parse("2026-11-20T21:00:00.000Z"),
      lowerBand: 588,
      spot: 600,
      straddleLower: 590,
      straddlePrice: 10,
      straddleUpper: 610,
      upperBand: 612,
    };
    const failing = seriesRenderer(
      vi.fn(),
      vi.fn((next: ExpectedMoveCone | null) => {
        if (next !== null) throw new TypeError("Bad cone");
      })
    );
    const ok = seriesRenderer();
    const { host, render } = await mountSeries([ok]);
    await render({ expectedMove: cone });
    expect(ok.setExpectedMove).toHaveBeenLastCalledWith(cone);
    const inspectorBtn = Array.from(host.querySelectorAll("button")).find(
      (btn) =>
        btn.textContent?.includes("Object tree") ||
        btn.textContent?.includes("Inspector")
    );
    if (inspectorBtn) {
      await act(async () => inspectorBtn.click());
    }
    expect(host.textContent).toContain("Expected move (2026-11-20)");

    const { host: errHost, render: renderErr } = await mountSeries([failing]);
    await renderErr({ expectedMove: cone });
    expect(errHost.textContent).toContain(
      "Expected move cone could not be drawn on the chart."
    );
  });
});
