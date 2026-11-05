import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleRendererOptions, DisplayCandle } from "./types.ts";

const mocks = vi.hoisted(() => ({
  CandleType: {
    CandleUpStroke: "candle_up_stroke",
    CandleSolid: "candle_solid",
    Ohlc: "ohlc",
    Area: "area",
  },
  ActionType: { OnCrosshairChange: "onCrosshairChange" },
  registerOverlay: vi.fn(),
  version: vi.fn(() => "9.8.12"),
  init: vi.fn(),
  dispose: vi.fn(),
  registerIndicator: vi.fn(),
}));
vi.mock("klinecharts", () => mocks);
import {
  DRAWING_GROUP_ID,
  MARKER_GROUP_ID,
  RECTANGLE_OVERLAY,
  drawingFromOverlay,
  rectangleFigures,
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
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  getConvertPictureUrl: vi.fn(() => "data:image/png;base64,AA"),
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
  it("draws markers as locked simpleAnnotation overlays in one group and clears them", async () => {
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
  it("registers a rectangle overlay whose figure is a closed polygon", async () => {
    stubBrowser();
    mocks.init.mockReturnValue(studyChart());
    await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    const template = (
      mocks.registerOverlay.mock.calls as unknown as unknown[][]
    )[0]?.[0] as {
      name: string;
      createPointFigures: (params: {
        coordinates: { x: number; y: number }[];
      }) => unknown[];
    };
    expect(template.name).toBe(RECTANGLE_OVERLAY);
    expect(
      template.createPointFigures({ coordinates: [{ x: 0, y: 0 }] })
    ).toEqual([]);
    expect(
      template.createPointFigures({
        coordinates: [
          { x: 0, y: 0 },
          { x: 4, y: 3 },
        ],
      })
    ).toEqual(
      rectangleFigures([
        { x: 0, y: 0 },
        { x: 4, y: 3 },
      ])
    );
    return expect(
      rectangleFigures([
        { x: 0, y: 0 },
        { x: 4, y: 3 },
      ])[0]?.attrs.coordinates
    ).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ]);
  });
  it("maps overlays back to drawings and rejects unknown ones", () => {
    expect(
      drawingFromOverlay({
        extendData: undefined,
        id: "o1",
        name: "horizontalStraightLine",
        points: [{ timestamp: 1000, value: 10 }],
      })
    ).toEqual({
      id: "o1",
      points: [{ timestamp: 1000, value: 10 }],
      text: "",
      tool: "level",
    });
    expect(
      drawingFromOverlay({
        extendData: "note",
        id: "o2",
        name: "simpleAnnotation",
        points: [{ timestamp: 1000, value: 10 }],
      })?.text
    ).toBe("note");
    return expect(
      drawingFromOverlay({
        extendData: null,
        id: "o3",
        name: "brush",
        points: [],
      })
    ).toBeUndefined();
  });
  it("sets chart types, drawings, crosshair listener and snapshots", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    renderer.setChartType!("ohlc");
    expect(instance.setStyles).toHaveBeenCalledWith({
      candle: { type: "ohlc" },
    });
    const onChange = vi.fn();
    const drawing = {
      id: "d1",
      points: [
        { timestamp: 1000, value: 10 },
        { timestamp: 2000, value: 11 },
      ],
      text: "",
      tool: "trend" as const,
    };
    renderer.setDrawings!([drawing], onChange);
    expect(instance.removeOverlay).toHaveBeenCalledWith({
      groupId: DRAWING_GROUP_ID,
    });
    const created = (
      instance.createOverlay.mock.calls as unknown as unknown[][]
    )[0]?.[0] as {
      name: string;
      onDrawEnd: (event: unknown) => boolean;
      onPressedMoveEnd: (event: unknown) => boolean;
    }[];
    expect(created[0]?.name).toBe("segment");
    expect(
      created[0]?.onPressedMoveEnd({
        overlay: {
          extendData: "",
          id: "d1",
          name: "segment",
          points: drawing.points,
        },
      })
    ).toBe(false);
    expect(onChange).toHaveBeenCalledWith(drawing);
    created[0]?.onDrawEnd({
      overlay: { extendData: "", id: "x", name: "brush", points: [] },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    renderer.setDrawings!([], onChange);
    expect(instance.createOverlay).toHaveBeenCalledTimes(1);
    expect(() =>
      renderer.setDrawings!([{ ...drawing, id: "" }], onChange)
    ).toThrow("Invalid");
    renderer.startDrawing!("text", "hello", onChange);
    expect(instance.createOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({
        extendData: "hello",
        groupId: DRAWING_GROUP_ID,
        name: "simpleAnnotation",
      })
    );
    const listener = vi.fn();
    renderer.onCrosshair!(listener);
    const callback = (
      instance.subscribeAction.mock.calls as unknown as unknown[][]
    )[0]?.[1] as (data?: unknown) => void;
    callback({ kLineData: { timestamp: 2000 } });
    callback(undefined);
    expect(listener.mock.calls).toEqual([[2000], [null]]);
    expect(renderer.snapshot!()).toBe("data:image/png;base64,AA");
    expect(instance.getConvertPictureUrl).toHaveBeenCalledWith(
      true,
      "png",
      "#ffffff"
    );
    renderer.dispose();
    renderer.setChartType!("area");
    renderer.setDrawings!([drawing], onChange);
    renderer.startDrawing!("trend", "", onChange);
    renderer.onCrosshair!(listener);
    expect(renderer.snapshot!()).toBe("");
    expect(instance.setStyles).toHaveBeenCalledTimes(1);
    return expect(instance.subscribeAction).toHaveBeenCalledTimes(1);
  });
});
