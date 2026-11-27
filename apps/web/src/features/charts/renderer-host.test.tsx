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
import { MARKET_CHART_CAPTIONS } from "./market-chart.tsx";
import { CandleCanvas, ChartRendererBoundary } from "./renderer-host.tsx";
import type {
  CandleRendererFactory,
  ChartMarker,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  return document.body.replaceChildren();
});
const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 10; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});

const candles: readonly DisplayCandle[] = [
  {
    close: 10.5,
    high: 11,
    id: "1",
    low: 9,
    open: 10,
    timestamp: 1000,
    volume: 20,
  },
];
const studiesA: ChartStudies = { ema: [], sma: [20], volume: true };
const studiesB: ChartStudies = {
  ema: [20],
  extra: ["boll", "macd", "adx"],
  sma: [],
  volume: false,
};
const markersA: readonly ChartMarker[] = [
  { id: "m", text: "Long", timestamp: 1000, value: 10.5 },
];

const fakeRenderer = () => {
  const renderer = {
    dispose: vi.fn(),
    replace: vi.fn(),
    resize: vi.fn(),
    setMarkers: vi.fn(),
    setStudies: vi.fn(),
  };
  const factory: CandleRendererFactory = vi.fn(async () => renderer);
  return { factory, renderer };
};

describe("CandleCanvas optional studies and markers", () => {
  it("applies studies and markers after mount and again when they change", async () => {
    const { renderer, factory } = fakeRenderer();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = async (
      studies: ChartStudies,
      markers: readonly ChartMarker[]
    ) => {
      return await act(async () => {
        root.render(
          <CandleCanvas
            factory={factory}
            label="Bars"
            markers={markers}
            pricePrecision={2}
            studies={studies}
            values={candles}
            volumePrecision={0}
          />
        );
        return await flush();
      });
    };
    await render(studiesA, markersA);
    expect(renderer.replace).toHaveBeenCalledWith(candles);
    expect(renderer.setStudies).toHaveBeenLastCalledWith(studiesA);
    expect(renderer.setMarkers).toHaveBeenLastCalledWith(markersA);
    const canvas = container.querySelector<HTMLElement>("[data-chart-canvas]");
    expect(canvas?.style.getPropertyValue("--vx-chart-sub-panes")).toBe("0");
    await render(studiesB, []);
    expect(renderer.setStudies).toHaveBeenLastCalledWith(studiesB);
    // MACD and ADX need their own panes; Bollinger draws on the candles.
    expect(canvas?.style.getPropertyValue("--vx-chart-sub-panes")).toBe("2");
    expect(renderer.setMarkers).toHaveBeenLastCalledWith([]);
    return expect(factory).toHaveBeenCalledTimes(1);
  });

  it("counts study, built-in and script panes together", async () => {
    const { factory } = fakeRenderer();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <CandleCanvas
          extraPanes={1}
          factory={factory}
          label="Bars"
          markers={[]}
          pricePrecision={2}
          studies={{
            ema: [],
            extra: ["macd"],
            panes: ["RSI"],
            sma: [],
            volume: false,
          }}
          values={candles}
          volumePrecision={0}
        />
      );
      return await flush();
    });
    const canvas = container.querySelector<HTMLElement>("[data-chart-canvas]");
    expect(canvas?.style.getPropertyValue("--vx-chart-sub-panes")).toBe("3");
  });

  it("reports null to onRenderer when a failing update disposes the renderer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T14:05:30Z"));
    const failing = (method: "replace" | "setStudies" | "setMarkers") => {
      const renderer = {
        dispose: vi.fn(),
        replace: vi.fn(),
        resize: vi.fn(),
        setMarkers: vi.fn(),
        setStudies: vi.fn(),
      };
      const factory: CandleRendererFactory = vi.fn(async () => renderer);
      return { factory, method, renderer };
    };
    for (const method of ["replace", "setStudies", "setMarkers"] as const) {
      const { renderer, factory } = failing(method);
      const onRenderer = vi.fn();
      const render = async (
        values: readonly DisplayCandle[],
        studies: ChartStudies,
        markers: readonly ChartMarker[]
      ) =>
        await act(async () => {
          root.render(
            <CandleCanvas
              factory={factory}
              label="Bars"
              markers={markers}
              onRenderer={onRenderer}
              pricePrecision={2}
              studies={studies}
              values={values}
              volumePrecision={0}
            />
          );
          return await flush();
        });
      await render(candles, studiesA, markersA);
      expect(onRenderer).toHaveBeenLastCalledWith(renderer);
      renderer[method].mockImplementation(() => {
        throw new Error("renderer failed");
      });
      await render(
        method === "replace" ? [...candles] : candles,
        method === "setStudies" ? { ...studiesA } : studiesA,
        method === "setMarkers" ? [...markersA] : markersA
      );
      expect(onRenderer).toHaveBeenLastCalledWith(null);
      expect(renderer.dispose).toHaveBeenCalled();
      expect(container.querySelector("figcaption")?.textContent).toBe(
        "Chart renderer failed to draw: Error · 14:05 UTC · exact data is in the table; reload the page to retry"
      );
      await act(async () => root.render(<span />));
    }
    // A mount that fails after the renderer exists also clears it.
    const broken = {
      dispose: vi.fn(),
      replace: vi.fn(() => {
        throw new Error("bad bars");
      }),
      resize: vi.fn(),
    };
    const onRenderer = vi.fn();
    await act(async () => {
      root.render(
        <CandleCanvas
          factory={async () => broken}
          label="Bars"
          onRenderer={onRenderer}
          pricePrecision={2}
          values={candles}
          volumePrecision={0}
        />
      );
      return await flush();
    });
    expect(onRenderer).toHaveBeenCalledWith(null);
    expect(broken.dispose).toHaveBeenCalled();
    expect(container.querySelector("figcaption")?.textContent).toBe(
      "Chart renderer failed to load: Error · 14:05 UTC · exact data is in the table; reload the page to retry"
    );
  });

  it("names the error class, a thrown non-Error value and the host's next step in the caption", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T09:30:00Z"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = async (factory: CandleRendererFactory) =>
      await act(async () => {
        root.render(
          <CandleCanvas
            captions={MARKET_CHART_CAPTIONS}
            factory={factory}
            label="Bars"
            pricePrecision={2}
            values={candles}
            volumePrecision={0}
          />
        );
        return await flush();
      });
    await render(async () => {
      throw new TypeError("chunk failed");
    });
    expect(container.querySelector("figcaption")?.textContent).toBe(
      `Chart renderer failed to load: TypeError · 09:30 UTC · ${MARKET_CHART_CAPTIONS.error}`
    );
    // The E6 next step, pinned as text so a change of the caption shows up here.
    expect(MARKET_CHART_CAPTIONS.error).toBe("reload the page to retry");
    await render(async () => {
      throw Object.assign(new Error("chunk failed"), { name: "" });
    });
    expect(container.querySelector("figcaption")?.textContent).toBe(
      `Chart renderer failed to load: Error without a name · 09:30 UTC · ${MARKET_CHART_CAPTIONS.error}`
    );
    await render(async () => await Promise.reject("chunk failed"));
    expect(container.querySelector("figcaption")?.textContent).toBe(
      `Chart renderer failed to load: non-Error value (string) · 09:30 UTC · ${MARKET_CHART_CAPTIONS.error}`
    );
  });

  it("shows a failed resize as a draw failure with its time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T21:15:00Z"));
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly notify: () => void;
        constructor(notify: () => void) {
          this.notify = notify;
        }
        observe() {
          resized.push(this.notify);
        }
        disconnect() {
          return;
        }
      }
    );
    const renderer = { dispose: vi.fn(), replace: vi.fn(), resize: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <CandleCanvas
          factory={async () => renderer}
          label="Bars"
          pricePrecision={2}
          values={candles}
          volumePrecision={0}
        />
      );
      return await flush();
    });
    await act(async () => {
      for (const notify of resized) notify();
    });
    expect(container.textContent).toContain("approximate values");
    renderer.resize.mockImplementation(() => {
      throw new RangeError("zero width");
    });
    await act(async () => {
      for (const notify of resized) notify();
    });
    return expect(container.querySelector("figcaption")?.textContent).toBe(
      "Chart renderer failed to draw: RangeError · 21:15 UTC · exact data is in the table; reload the page to retry"
    );
  });

  it("leaves renderers without the optional methods untouched when the props are omitted", async () => {
    const renderer = { dispose: vi.fn(), replace: vi.fn(), resize: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <CandleCanvas
          factory={async () => renderer}
          label="Bars"
          pricePrecision={2}
          values={candles}
          volumePrecision={0}
        />
      );
      return await flush();
    });
    expect(renderer.replace).toHaveBeenCalledTimes(1);
    return expect(container.textContent).toContain("approximate values");
  });

  it("keeps effect cleanups valid when renderer methods return values, and uses host captions", async () => {
    const renderer = {
      dispose: vi.fn(),
      replace: vi.fn(() => "r"),
      resize: vi.fn(),
      setMarkers: vi.fn(() => "m"),
      setStudies: vi.fn(() => "20"),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const captions = {
      error: "reload the page to retry",
      loading: "Loading chart renderer.",
      ready: "Display values are approximate.",
    };
    const render = async (
      studies: ChartStudies,
      markers: readonly ChartMarker[],
      values: readonly DisplayCandle[]
    ) => {
      return await act(async () => {
        root.render(
          <ChartRendererBoundary>
            <CandleCanvas
              captions={captions}
              factory={async () => renderer}
              label="Bars"
              markers={markers}
              pricePrecision={2}
              studies={studies}
              values={values}
              volumePrecision={0}
            />
          </ChartRendererBoundary>
        );
        return await flush();
      });
    };
    await render(studiesA, markersA, candles);
    await render(
      studiesB,
      [],
      [...candles, { ...candles[0]!, id: "2", timestamp: 2000 }]
    );
    await render(studiesA, markersA, candles);
    expect(container.textContent).not.toContain("could not display");
    expect(container.textContent).toContain("Display values are approximate.");
    await act(async () => root.unmount());
    return expect(renderer.dispose).toHaveBeenCalled();
  });

  it("forwards a non-empty computed fontFamily on the chart palette", async () => {
    const captured: (string | undefined)[] = [];
    const renderer = { dispose: vi.fn(), replace: vi.fn(), resize: vi.fn() };
    const factory: CandleRendererFactory = async (_element, options) => {
      captured.push(options.palette.fontFamily);
      return renderer;
    };
    const container = document.createElement("div");
    container.style.fontFamily = '"Public Sans", sans-serif';
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <CandleCanvas
          factory={factory}
          label="Bars"
          pricePrecision={2}
          values={candles}
          volumePrecision={0}
        />
      );
      return await flush();
    });
    expect(captured).toEqual(['"Public Sans", sans-serif']);
  });
});

describe("ChartRendererBoundary", () => {
  it("replaces a child that throws while rendering with the table note", async () => {
    const Broken = (): never => {
      throw new Error("renderer exploded");
    };
    const caught = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container, { onCaughtError: caught });
    roots.push(root);
    await act(async () =>
      root.render(
        <ChartRendererBoundary>
          <Broken />
        </ChartRendererBoundary>
      )
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "could not display the selected data"
    );
    return expect(caught).toHaveBeenCalledOnce();
  });
});
