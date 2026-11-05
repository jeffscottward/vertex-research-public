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
    id: "1",
    timestamp: 1000,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 20,
  },
];
const studiesA: ChartStudies = { volume: true, sma: [20], ema: [] };
const studiesB: ChartStudies = {
  volume: false,
  sma: [],
  ema: [20],
  extra: ["boll", "macd", "adx"],
};
const markersA: readonly ChartMarker[] = [
  { id: "m", timestamp: 1000, value: 10.5, text: "Long" },
];

const fakeRenderer = () => {
  const renderer = {
    replace: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    setStudies: vi.fn(),
    setMarkers: vi.fn(),
  };
  const factory: CandleRendererFactory = vi.fn(async () => renderer);
  return { renderer, factory };
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
    const canvas = container.querySelector<HTMLElement>(".vx-chart-canvas");
    expect(canvas?.style.getPropertyValue("--vx-chart-sub-panes")).toBe("0");
    await render(studiesB, []);
    expect(renderer.setStudies).toHaveBeenLastCalledWith(studiesB);
    // MACD and ADX need their own panes; Bollinger draws on the candles.
    expect(canvas?.style.getPropertyValue("--vx-chart-sub-panes")).toBe("2");
    expect(renderer.setMarkers).toHaveBeenLastCalledWith([]);
    return expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reports null to onRenderer when a failing update disposes the renderer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const failing = (method: "replace" | "setStudies" | "setMarkers") => {
      const renderer = {
        replace: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
        setStudies: vi.fn(),
        setMarkers: vi.fn(),
      };
      const factory: CandleRendererFactory = vi.fn(async () => renderer);
      return { renderer, factory, method };
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
      expect(container.textContent).toContain("Chart renderer unavailable");
      await act(async () => root.render(<span />));
    }
    // A mount that fails after the renderer exists also clears it.
    const broken = {
      replace: vi.fn(() => {
        throw new Error("bad bars");
      }),
      resize: vi.fn(),
      dispose: vi.fn(),
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
  });

  it("leaves renderers without the optional methods untouched when the props are omitted", async () => {
    const renderer = { replace: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
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

  return it("keeps effect cleanups valid when renderer methods return values, and uses host captions", async () => {
    // Regression: an implicit return of setStudies' value from an effect made React call a string as cleanup.
    const renderer = {
      replace: vi.fn(() => "r"),
      resize: vi.fn(),
      dispose: vi.fn(),
      setStudies: vi.fn(() => "20"),
      setMarkers: vi.fn(() => "m"),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const captions = {
      ready: "Display values are approximate.",
      loading: "Loading chart renderer.",
      error: "Chart renderer unavailable.",
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
});
