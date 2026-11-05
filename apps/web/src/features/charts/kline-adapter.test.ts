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
  barSpacing,
  drawingFromOverlay,
  overlayPoint,
  timestampAtIndex,
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
    expect(
      drawingFromOverlay({
        extendData: null,
        id: "o3",
        name: "brush",
        points: [],
      })
    ).toBeUndefined();
    // Past the last bar KLineCharts gives only a dataIndex: extend the bar spacing.
    expect(
      drawingFromOverlay(
        {
          extendData: "",
          id: "o4",
          name: "segment",
          points: [
            { dataIndex: 1, value: 10 },
            { dataIndex: 4, value: 12 },
          ],
        },
        [1000, 2000, 3000]
      )?.points
    ).toEqual([
      { timestamp: 2000, value: 10 },
      { timestamp: 5000, value: 12 },
    ]);
    return expect(
      drawingFromOverlay({
        extendData: "",
        id: "o5",
        name: "horizontalStraightLine",
        points: [{ dataIndex: 3, value: 10 }],
      })
    ).toBeUndefined();
  });
  it("places saved points after the last bar by data index and keeps them there", async () => {
    expect(overlayPoint({ timestamp: 2000, value: 1 }, [1000, 2000])).toEqual({
      timestamp: 2000,
      value: 1,
    });
    expect(overlayPoint({ timestamp: 5000, value: 1 }, [1000, 2000])).toEqual({
      dataIndex: 4,
      value: 1,
    });
    expect(overlayPoint({ timestamp: 5000, value: 1 }, [])).toEqual({
      timestamp: 5000,
      value: 1,
    });
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    const bars = [1000, 2000, 3000].map((timestamp, index) => ({
      ...bar,
      id: `b${index}`,
      timestamp,
    }));
    renderer.replace(bars);
    const onChange = vi.fn();
    const future = {
      id: "f1",
      points: [
        { timestamp: 2000, value: 10 },
        { timestamp: 6000, value: 12 },
      ],
      text: "",
      tool: "trend" as const,
    };
    renderer.setDrawings!([future], onChange);
    type Created = {
      points: unknown[];
      onPressedMoveEnd: (event: unknown) => boolean;
    }[];
    const createdAt = (call: number) =>
      (instance.createOverlay.mock.calls as unknown as unknown[][])[
        call
      ]?.[0] as Created;
    expect(createdAt(0)[0]?.points).toEqual([
      { timestamp: 2000, value: 10 },
      { dataIndex: 5, value: 12 },
    ]);
    // A new last bar moves the data index so the point keeps its time.
    renderer.replace([...bars, { ...bar, id: "b3", timestamp: 4000 }]);
    expect(createdAt(1)[0]?.points).toEqual([
      { timestamp: 2000, value: 10 },
      { dataIndex: 5, value: 12 },
    ]);
    // A same-time tail update does not place the drawings again.
    renderer.replace([
      ...bars,
      { ...bar, close: 10.6, high: 11, id: "b3", timestamp: 4000 },
    ]);
    expect(instance.createOverlay).toHaveBeenCalledTimes(2);
    // Older history prepended with the same last bar shifts every data index.
    renderer.replace([
      { ...bar, id: "b-1", timestamp: 0 },
      ...bars,
      { ...bar, id: "b3", timestamp: 4000 },
    ]);
    expect(createdAt(2)[0]?.points).toEqual([
      { timestamp: 2000, value: 10 },
      { dataIndex: 6, value: 12 },
    ]);
    // A shorter series ending earlier places points between the two last bars again.
    renderer.replace(bars.slice(0, 2));
    expect(createdAt(3)[0]?.points).toEqual([
      { timestamp: 2000, value: 10 },
      { dataIndex: 5, value: 12 },
    ]);
    // A saved drawing dragged into an unstorable state goes back to its stored place.
    createdAt(1)[0]?.onPressedMoveEnd({
      overlay: { extendData: "", id: "f1", name: "segment", points: [] },
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(instance.createOverlay).toHaveBeenCalledTimes(5);
    expect(instance.removeOverlay).not.toHaveBeenCalledWith({ id: "f1" });
  });
  it("estimates bar spacing from the median recent gap, not a weekend gap", () => {
    const day = 86_400_000;
    // Monday to Friday, then the next Monday: the last gap is three days.
    const week = [0, 1, 2, 3, 4, 7].map((offset) => offset * day);
    expect(barSpacing(week)).toBe(day);
    expect(timestampAtIndex(week, 6)).toBe(8 * day);
    expect(overlayPoint({ timestamp: 9 * day, value: 1 }, week)).toEqual({
      dataIndex: 7,
      value: 1,
    });
    // Only the last 20 gaps count: older hourly bars do not change daily spacing.
    const mixed = [
      ...Array.from({ length: 30 }, (_, index) => index * 3_600_000),
      ...Array.from({ length: 21 }, (_, index) => (index + 2) * day),
    ];
    expect(barSpacing(mixed)).toBe(day);
    expect(barSpacing([1000])).toBe(day);
    expect(barSpacing([])).toBe(day);
    expect(barSpacing([1000, 3000, 4000])).toBe(1000);
  });
  it("maps a data index to a bar time, extending past the last bar", () => {
    expect(timestampAtIndex([1000, 2000], 1)).toBe(2000);
    expect(timestampAtIndex([1000, 2000], 3)).toBe(4000);
    expect(timestampAtIndex([1000], 2)).toBe(1000 + 2 * 86_400_000);
    expect(timestampAtIndex([], 0)).toBeUndefined();
    expect(timestampAtIndex([1000], -1)).toBeUndefined();
    expect(timestampAtIndex([1000], 1.5)).toBeUndefined();
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
    // A drawing that cannot be stored is removed, not left on the chart unsaved.
    expect(instance.removeOverlay).toHaveBeenCalledWith({ id: "x" });
    renderer.replace([
      { ...bar, id: "b1", timestamp: 1000 },
      { ...bar, id: "b2", timestamp: 2000 },
    ]);
    created[0]?.onPressedMoveEnd({
      overlay: {
        extendData: "",
        id: "d1",
        name: "segment",
        points: [
          { timestamp: 1000, value: 10 },
          { dataIndex: 3, value: 11 },
        ],
      },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...drawing,
      points: [
        { timestamp: 1000, value: 10 },
        { timestamp: 4000, value: 11 },
      ],
    });
    // The first bars place the saved drawings again (their points may follow the last bar).
    expect(instance.createOverlay).toHaveBeenCalledTimes(2);
    renderer.setDrawings!([], onChange);
    expect(instance.createOverlay).toHaveBeenCalledTimes(2);
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
