import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleRendererOptions, DisplayCandle } from "./types.ts";

const mocks = vi.hoisted(() => ({
  CandleType: { CandleUpStroke: "candle_up_stroke" },
  version: vi.fn(() => "9.8.12"),
  init: vi.fn(),
  dispose: vi.fn(),
  registerIndicator: vi.fn(),
}));
vi.mock("klinecharts", () => mocks);
import {
  MARKER_GROUP_ID,
  VOLUME_PANE_ID,
  createKLineRenderer,
  validDisplayCandles,
} from "./kline-adapter.ts";
import { VERTEX_STUDY_IDS, type VertexStudyId } from "./vertex-studies.ts";

const bar: DisplayCandle = {
  id: "fixture-bar",
  timestamp: 1000,
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 20,
};
const options = (signal: AbortSignal): CandleRendererOptions => ({
  signal,
  palette: {
    foreground: "#222222",
    background: "#ffffff",
    grid: "#ddddd6",
    rising: "#222222",
    falling: "#666666",
    accent: "#feda00",
  },
  pricePrecision: 2,
  volumePrecision: 0,
});
const stubBrowser = () => {
  vi.stubGlobal("window", {});
  return vi.stubGlobal("document", {});
};
const chart = () => ({
  getDom: vi.fn(() => null),
  setPriceVolumePrecision: vi.fn(),
  applyNewData: vi.fn(),
  updateData: vi.fn(),
  clearData: vi.fn(),
  resize: vi.fn(),
});
const studyChart = () => ({
  ...chart(),
  createIndicator: vi.fn(() => "pane"),
  removeIndicator: vi.fn(),
  createOverlay: vi.fn(() => []),
  removeOverlay: vi.fn(),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  return mocks.version.mockReturnValue("9.8.12");
});

describe("pinned KLine browser adapter (authored, not executed)", () => {
  it("does not initialize on the server or after cancelled mount", async () => {
    vi.stubGlobal("window", undefined);
    const controller = new AbortController();
    await expect(
      createKLineRenderer({} as HTMLElement, options(controller.signal))
    ).rejects.toThrow("browser");
    stubBrowser();
    controller.abort();
    await expect(
      createKLineRenderer({} as HTMLElement, options(controller.signal))
    ).rejects.toThrow("cancelled");
    return expect(mocks.init).not.toHaveBeenCalled();
  });
  it("pins the runtime version instead of silently accepting an incompatible upgrade", async () => {
    stubBrowser();
    mocks.version.mockReturnValue("10.0.0");
    await expect(
      createKLineRenderer(
        {} as HTMLElement,
        options(new AbortController().signal)
      )
    ).rejects.toThrow("version");
    return expect(mocks.init).not.toHaveBeenCalled();
  });
  it("replaces snapshots, updates only a same-time tail/new last bar, resizes and disposes exactly once", async () => {
    stubBrowser();
    const instance = chart();
    mocks.init.mockReturnValue(instance);
    const controller = new AbortController();
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(controller.signal)
    );
    renderer.replace([bar]);
    expect(instance.applyNewData).toHaveBeenCalledWith(
      [
        {
          timestamp: 1000,
          open: 10,
          high: 11,
          low: 9,
          close: 10.5,
          volume: 20,
        },
      ],
      false
    );
    renderer.replace([bar]);
    expect(instance.applyNewData).toHaveBeenCalledTimes(1);
    renderer.replace([{ ...bar, close: 10.75 }]);
    expect(instance.updateData).toHaveBeenCalledTimes(1);
    renderer.replace([
      { ...bar, close: 10.75 },
      { ...bar, id: "next", timestamp: 2000 },
    ]);
    expect(instance.updateData).toHaveBeenCalledTimes(2);
    renderer.replace([{ ...bar, id: "evicted-window", timestamp: 3000 }]);
    expect(instance.applyNewData).toHaveBeenCalledTimes(2);
    renderer.replace([{ ...bar, id: "another-window", timestamp: 4000 }]);
    expect(instance.applyNewData).toHaveBeenCalledTimes(3);
    renderer.resize();
    expect(instance.resize).toHaveBeenCalledTimes(1);
    controller.abort();
    renderer.dispose();
    renderer.replace([bar]);
    return expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it("rejects NaN, oversized prices and nonincreasing coordinates", () => {
    expect(validDisplayCandles([{ ...bar, high: Number.NaN }])).toBe(false);
    expect(validDisplayCandles([{ ...bar, high: 1_000_000_000_001 }])).toBe(
      false
    );
    expect(validDisplayCandles([bar, bar])).toBe(false);
    return expect(validDisplayCandles([bar])).toBe(true);
  });
  it("toggles built-in VOL, MA and EMA studies without recreating unchanged ones", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const controller = new AbortController();
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(controller.signal)
    );
    renderer.setStudies!({ volume: true, sma: [20, 50], ema: [20] });
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "VOL", shortName: "Volume", calcParams: [] },
      false,
      { id: VOLUME_PANE_ID, height: 96 }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "MA", calcParams: [20, 50] },
      true,
      { id: "candle_pane" }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "EMA", calcParams: [20] },
      true,
      { id: "candle_pane" }
    );
    renderer.setStudies!({ volume: true, sma: [20, 50], ema: [20] });
    expect(instance.createIndicator).toHaveBeenCalledTimes(3);
    renderer.setStudies!({ volume: false, sma: [], ema: [20] });
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      VOLUME_PANE_ID,
      "VOL"
    );
    expect(instance.removeIndicator).toHaveBeenCalledWith("candle_pane", "MA");
    expect(instance.removeIndicator).toHaveBeenCalledTimes(2);
    expect(instance.createIndicator).toHaveBeenCalledTimes(3);
    renderer.setStudies!({ volume: false, sma: [50], ema: [] });
    expect(instance.removeIndicator).toHaveBeenCalledWith("candle_pane", "EMA");
    expect(instance.createIndicator).toHaveBeenLastCalledWith(
      { name: "MA", calcParams: [50] },
      true,
      { id: "candle_pane" }
    );
    expect(() =>
      renderer.setStudies!({ volume: false, sma: [0], ema: [] })
    ).toThrow(RangeError);
    expect(() =>
      renderer.setStudies!({ volume: false, sma: [1.5], ema: [] })
    ).toThrow(RangeError);
    expect(() =>
      renderer.setStudies!({
        volume: false,
        sma: [5, 10, 20, 50, 100],
        ema: [],
      })
    ).toThrow(RangeError);
    renderer.dispose();
    renderer.setStudies!({ volume: true, sma: [], ema: [] });
    return expect(instance.createIndicator).toHaveBeenCalledTimes(4);
  });
  it("registers Vertex studies and toggles them on the candle pane or their own pane", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    const names = mocks.registerIndicator.mock.calls.map(
      ([template]) => (template as { name: string }).name
    );
    expect(names).toEqual(
      VERTEX_STUDY_IDS.map((id) => `VX_${id.toUpperCase()}`)
    );
    expect(mocks.registerIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ name: "VX_BOLL", precision: 2 })
    );
    renderer.setStudies!({
      volume: false,
      sma: [],
      ema: [],
      extra: ["boll", "macd"],
    });
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "VX_BOLL", shortName: "BB" },
      true,
      { id: "candle_pane" }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "VX_MACD", shortName: "MACD" },
      false,
      { id: "vx_macd_pane", height: 96 }
    );
    renderer.setStudies!({
      volume: false,
      sma: [],
      ema: [],
      extra: ["boll", "macd"],
    });
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    renderer.setStudies!({ volume: false, sma: [], ema: [] });
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "candle_pane",
      "VX_BOLL"
    );
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "vx_macd_pane",
      "VX_MACD"
    );
    expect(() =>
      renderer.setStudies!({
        volume: false,
        sma: [],
        ema: [],
        extra: ["ichimoku" as VertexStudyId],
      })
    ).toThrow("Unknown Vertex study");
    return expect(instance.createIndicator).toHaveBeenCalledTimes(2);
  });
  return it("draws markers as locked simpleAnnotation overlays in one group and clears them", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    renderer.setMarkers!([
      { id: "m1", timestamp: 1000, value: 10.5, text: "Long" },
      { id: "m2", timestamp: 2000, value: 11, text: "Exit" },
    ]);
    expect(instance.removeOverlay).toHaveBeenCalledWith({
      groupId: MARKER_GROUP_ID,
    });
    expect(instance.createOverlay).toHaveBeenCalledWith([
      {
        name: "simpleAnnotation",
        groupId: MARKER_GROUP_ID,
        lock: true,
        points: [{ timestamp: 1000, value: 10.5 }],
        extendData: "Long",
      },
      {
        name: "simpleAnnotation",
        groupId: MARKER_GROUP_ID,
        lock: true,
        points: [{ timestamp: 2000, value: 11 }],
        extendData: "Exit",
      },
    ]);
    renderer.setMarkers!([
      { id: "m1", timestamp: 1000, value: 10.5, text: "Long" },
      { id: "m2", timestamp: 2000, value: 11, text: "Exit" },
    ]);
    expect(instance.createOverlay).toHaveBeenCalledTimes(1);
    renderer.setMarkers!([]);
    expect(instance.removeOverlay).toHaveBeenCalledTimes(2);
    expect(instance.createOverlay).toHaveBeenCalledTimes(1);
    expect(() =>
      renderer.setMarkers!([
        { id: "bad", timestamp: Number.NaN, value: 1, text: "x" },
      ])
    ).toThrow(TypeError);
    return expect(() =>
      renderer.setMarkers!([
        { id: "long", timestamp: 1, value: 1, text: "x".repeat(41) },
      ])
    ).toThrow(TypeError);
  });
});
