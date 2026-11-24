import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleRendererOptions, DisplayCandle } from "./types.ts";

const mocks = vi.hoisted(() => ({
  ActionType: { OnCrosshairChange: "onCrosshairChange" },
  CandleType: {
    Area: "area",
    CandleSolid: "candle_solid",
    CandleUpStroke: "candle_up_stroke",
    Ohlc: "ohlc",
  },
  dispose: vi.fn(),
  init: vi.fn(),
  LineType: { Dashed: "dashed", Solid: "solid" },
  registerIndicator: vi.fn(),
  registerOverlay: vi.fn(),
  version: vi.fn(() => "9.8.12"),
}));
vi.mock("klinecharts", () => mocks);

import {
  barSpacing,
  EXPECTED_MOVE_GROUP_ID,
  EXPECTED_MOVE_OVERLAY,
} from "./expected-move-overlay.ts";
import {
  createKLineRenderer,
  DRAWING_GROUP_ID,
  drawingFromOverlay,
  MARKER_GROUP_ID,
  overlayPoint,
  RECTANGLE_OVERLAY,
  rectangleFigures,
  STYLED_MARKER_OVERLAY,
  styledMarkerFigures,
  timestampAtIndex,
  VOLUME_PANE_ID,
  validDisplayCandles,
} from "./kline-adapter.ts";
import type { ExpectedMoveCone } from "./types.ts";
import { VERTEX_STUDY_IDS, type VertexStudyId } from "./vertex-studies.ts";

const bar: DisplayCandle = {
  close: 10.5,
  high: 11,
  id: "fixture-bar",
  low: 9,
  open: 10,
  timestamp: 1000,
  volume: 20,
};
const options = (signal: AbortSignal): CandleRendererOptions => ({
  palette: {
    accent: "#feda00",
    background: "#ffffff",
    falling: "#666666",
    foreground: "#222222",
    grid: "#ddddd6",
    rising: "#222222",
  },
  pricePrecision: 2,
  signal,
  volumePrecision: 0,
});
const stubBrowser = () => {
  vi.stubGlobal("window", {});
  return vi.stubGlobal("document", {});
};
const chart = () => ({
  applyNewData: vi.fn(),
  clearData: vi.fn(),
  getDom: vi.fn(() => null),
  resize: vi.fn(),
  setPriceVolumePrecision: vi.fn(),
  updateData: vi.fn(),
});
const studyChart = () => ({
  ...chart(),
  createIndicator: vi.fn(() => "pane"),
  createOverlay: vi.fn(() => []),
  getBarSpace: vi.fn(() => 8),
  getConvertPictureUrl: vi.fn(() => "data:image/png;base64,AA"),
  getOffsetRightDistance: vi.fn(() => 50),
  removeIndicator: vi.fn(),
  removeOverlay: vi.fn(),
  setOffsetRightDistance: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
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
          close: 10.5,
          high: 11,
          low: 9,
          open: 10,
          timestamp: 1000,
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
    renderer.setStudies!({ ema: [20], sma: [20, 50], volume: true });
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { calcParams: [], name: "VOL", shortName: "Volume" },
      false,
      { height: 96, id: VOLUME_PANE_ID }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { calcParams: [20, 50], name: "MA" },
      true,
      { id: "candle_pane" }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { calcParams: [20], name: "EMA" },
      true,
      { id: "candle_pane" }
    );
    renderer.setStudies!({ ema: [20], sma: [20, 50], volume: true });
    expect(instance.createIndicator).toHaveBeenCalledTimes(3);
    renderer.setStudies!({ ema: [20], sma: [], volume: false });
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      VOLUME_PANE_ID,
      "VOL"
    );
    expect(instance.removeIndicator).toHaveBeenCalledWith("candle_pane", "MA");
    expect(instance.removeIndicator).toHaveBeenCalledTimes(2);
    expect(instance.createIndicator).toHaveBeenCalledTimes(3);
    renderer.setStudies!({ ema: [], sma: [50], volume: false });
    expect(instance.removeIndicator).toHaveBeenCalledWith("candle_pane", "EMA");
    expect(instance.createIndicator).toHaveBeenLastCalledWith(
      { calcParams: [50], name: "MA" },
      true,
      { id: "candle_pane" }
    );
    expect(() =>
      renderer.setStudies!({ ema: [], sma: [0], volume: false })
    ).toThrow(RangeError);
    expect(() =>
      renderer.setStudies!({ ema: [], sma: [1.5], volume: false })
    ).toThrow(RangeError);
    expect(() =>
      renderer.setStudies!({
        ema: [],
        sma: [5, 10, 20, 50, 100],
        volume: false,
      })
    ).toThrow(RangeError);
    renderer.dispose();
    renderer.setStudies!({ ema: [], sma: [], volume: true });
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
      ema: [],
      extra: ["boll", "macd"],
      sma: [],
      volume: false,
    });
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "VX_BOLL", shortName: "BB" },
      true,
      { id: "candle_pane" }
    );
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "VX_MACD", shortName: "MACD" },
      false,
      { height: 96, id: "vx_macd_pane" }
    );
    renderer.setStudies!({
      ema: [],
      extra: ["boll", "macd"],
      sma: [],
      volume: false,
    });
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    renderer.setStudies!({ ema: [], sma: [], volume: false });
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "candle_pane",
      "VX_BOLL"
    );
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "vx_macd_pane",
      "VX_MACD"
    );
    renderer.setStudies!({
      ema: [],
      extra: ["vwap"],
      sma: [],
      volume: false,
    });
    expect(instance.createIndicator).toHaveBeenLastCalledWith(
      {
        name: "VX_VWAP",
        shortName: "VWAP",
        styles: {
          lines: [
            {
              color: "#feda00",
              dashedValue: [2, 2],
              size: 2,
              smooth: false,
              style: "solid",
            },
            {
              color: "#222222",
              dashedValue: [6, 4],
              size: 1,
              smooth: false,
              style: "dashed",
            },
            {
              color: "#222222",
              dashedValue: [6, 4],
              size: 1,
              smooth: false,
              style: "dashed",
            },
            {
              color: "#666666",
              dashedValue: [2, 3],
              size: 1,
              smooth: false,
              style: "dashed",
            },
            {
              color: "#666666",
              dashedValue: [2, 3],
              size: 1,
              smooth: false,
              style: "dashed",
            },
          ],
        },
      },
      true,
      { id: "candle_pane" }
    );
    renderer.setStudies!({ ema: [], sma: [], volume: false });
    expect(instance.removeIndicator).toHaveBeenLastCalledWith(
      "candle_pane",
      "VX_VWAP"
    );
    expect(() =>
      renderer.setStudies!({
        ema: [],
        extra: ["ichimoku" as VertexStudyId],
        sma: [],
        volume: false,
      })
    ).toThrow("Unknown Vertex study");
    return expect(instance.createIndicator).toHaveBeenCalledTimes(3);
  });
  it("adds RSI, KDJ, OBV and WR built-ins in their own panes and formats big numbers", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    const init = mocks.init.mock.calls[0]?.[1] as {
      customApi: { formatBigNumber: (value: number) => string };
    };
    expect(init.customApi.formatBigNumber(2_500_000)).toBe("2.5M");
    renderer.setStudies!({
      ema: [],
      panes: ["RSI", "WR"],
      sma: [],
      volume: false,
    });
    expect(instance.createIndicator).toHaveBeenCalledWith(
      { name: "RSI" },
      false,
      { height: 96, id: "vx_rsi_builtin_pane" }
    );
    renderer.setStudies!({ ema: [], panes: ["WR"], sma: [], volume: false });
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "vx_rsi_builtin_pane",
      "RSI"
    );
    expect(() =>
      renderer.setStudies!({
        ema: [],
        panes: ["CCI" as "RSI"],
        sma: [],
        volume: false,
      })
    ).toThrow("Unknown built-in study");
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
      { id: "m1", text: "Long", timestamp: 1000, value: 10.5 },
      { id: "m2", text: "Exit", timestamp: 2000, value: 11 },
    ]);
    expect(instance.removeOverlay).toHaveBeenCalledWith({
      groupId: MARKER_GROUP_ID,
    });
    expect(instance.createOverlay).toHaveBeenCalledWith([
      {
        extendData: "Long",
        groupId: MARKER_GROUP_ID,
        lock: true,
        name: "simpleAnnotation",
        points: [{ timestamp: 1000, value: 10.5 }],
      },
      {
        extendData: "Exit",
        groupId: MARKER_GROUP_ID,
        lock: true,
        name: "simpleAnnotation",
        points: [{ timestamp: 2000, value: 11 }],
      },
    ]);
    renderer.setMarkers!([
      { id: "m1", text: "Long", timestamp: 1000, value: 10.5 },
      { id: "m2", text: "Exit", timestamp: 2000, value: 11 },
    ]);
    expect(instance.createOverlay).toHaveBeenCalledTimes(1);
    renderer.setMarkers!([]);
    expect(instance.removeOverlay).toHaveBeenCalledTimes(2);
    expect(instance.createOverlay).toHaveBeenCalledTimes(1);
    expect(() =>
      renderer.setMarkers!([
        { id: "bad", text: "x", timestamp: Number.NaN, value: 1 },
      ])
    ).toThrow(TypeError);
    return expect(() =>
      renderer.setMarkers!([
        { id: "long", text: "x".repeat(41), timestamp: 1, value: 1 },
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
  it("renders styled arrow and diamond markers with palette colors and stack offsets", async () => {
    stubBrowser();
    const instance = studyChart();
    mocks.init.mockReturnValue(instance);
    const renderer = await createKLineRenderer(
      {} as HTMLElement,
      options(new AbortController().signal)
    );
    const template = (
      mocks.registerOverlay.mock.calls as unknown as unknown[][]
    )[1]?.[0] as {
      name: string;
      createPointFigures: (params: {
        coordinates: { x: number; y: number }[];
        overlay: { extendData: unknown };
      }) => unknown[];
    };
    expect(template.name).toBe(STYLED_MARKER_OVERLAY);
    expect(
      template.createPointFigures({
        coordinates: [],
        overlay: { extendData: null },
      })
    ).toEqual([]);
    expect(styledMarkerFigures([{ x: 10, y: 20 }], null)).toEqual([]);

    renderer.setMarkers!([
      {
        id: "si-buy",
        position: "below",
        shape: "arrow",
        stackOrder: 0,
        text: "SI",
        timestamp: 1000,
        tone: "bullish",
        value: 9,
      },
      {
        id: "abs-sell",
        position: "below",
        shape: "diamond",
        stackOrder: 1,
        text: "ABS",
        timestamp: 1000,
        tone: "bullish",
        value: 9,
      },
      {
        id: "si-sell",
        text: "SI",
        timestamp: 2000,
        tone: "bearish",
        value: 11,
      },
      {
        id: "neutral",
        text: "N",
        timestamp: 3000,
        tone: "neutral",
        value: 10,
      },
    ]);
    const created = (
      instance.createOverlay.mock.calls as unknown as unknown[][]
    ).at(-1)?.[0] as {
      name: string;
      extendData: unknown;
    }[];
    expect(created.map((item) => item.name)).toEqual([
      STYLED_MARKER_OVERLAY,
      STYLED_MARKER_OVERLAY,
      STYLED_MARKER_OVERLAY,
      STYLED_MARKER_OVERLAY,
    ]);
    const arrowFigs = template.createPointFigures({
      coordinates: [{ x: 10, y: 20 }],
      overlay: { extendData: created[0]?.extendData },
    });
    const diamondFigs = template.createPointFigures({
      coordinates: [{ x: 10, y: 20 }],
      overlay: { extendData: created[1]?.extendData },
    });
    const bearishFigs = template.createPointFigures({
      coordinates: [{ x: 10, y: 20 }],
      overlay: { extendData: created[2]?.extendData },
    });
    expect(arrowFigs).toHaveLength(2);
    expect(diamondFigs).toHaveLength(2);
    expect(bearishFigs).toHaveLength(2);
    const slot0LabelY = (arrowFigs[1] as { attrs: { y: number } }).attrs.y;
    const slot1TopY = (
      diamondFigs[0] as { attrs: { coordinates: { y: number }[] } }
    ).attrs.coordinates[0]!.y;
    // Slot 0 label (height ~17px) must not collide with slot 1 glyph anchor.
    expect(slot1TopY - slot0LabelY).toBeGreaterThanOrEqual(20);
    expect(() =>
      renderer.setMarkers!([
        {
          id: "bad-stack",
          stackOrder: 99,
          text: "SI",
          timestamp: 1000,
          tone: "bullish",
          value: 9,
        },
      ])
    ).toThrow(TypeError);
  });

  it("renders, updates, and clears expected move cones with right-offset lifecycle", async () => {
    stubBrowser();
    const fake = studyChart();
    mocks.init.mockReturnValue(fake);
    const controller = new AbortController();
    const mountEl = { clientWidth: 1000 };
    const renderer = await createKLineRenderer(
      mountEl as HTMLElement,
      options(controller.signal)
    );
    const day = 86_400_000;
    const t0 = Date.parse("2026-11-02T16:00:00.000Z");
    const t1 = t0 + day;
    const expiryMs = Date.parse("2026-11-12T21:00:00.000Z");
    const cone: ExpectedMoveCone = {
      basis: "atm_straddle_mid",
      dte: 9,
      expectedMove: 2.5,
      expectedMovePct: 0.25,
      expiry: "2026-11-12",
      expiryCloseMs: expiryMs,
      lowerBand: 8,
      spot: 10.5,
      straddleLower: 8.5,
      straddlePrice: 2,
      straddleUpper: 12.5,
      upperBand: 13,
    };
    renderer.replace([
      { ...bar, id: "b0", timestamp: t0 },
      { ...bar, id: "b1", timestamp: t1 },
    ]);
    renderer.setExpectedMove!(cone);
    expect(fake.setOffsetRightDistance).toHaveBeenLastCalledWith(
      expect.any(Number)
    );
    expect(fake.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: EXPECTED_MOVE_GROUP_ID,
        lock: true,
        name: EXPECTED_MOVE_OVERLAY,
      })
    );
    const templateCall = mocks.registerOverlay.mock.calls.find(
      (call) => (call[0] as { name?: string })?.name === EXPECTED_MOVE_OVERLAY
    );
    const template = templateCall?.[0] as {
      createPointFigures: (args: {
        bounding: { width: number; height: number };
        coordinates: { x: number; y: number }[];
        overlay: { extendData: unknown };
      }) => unknown[];
    };
    const overlayCalls = fake.createOverlay.mock.calls as unknown[][];
    const createdOverlay = overlayCalls.at(-1)?.[0] as {
      extendData: unknown;
    };
    expect(
      template.createPointFigures({
        bounding: { height: 300, width: 400 },
        coordinates: [
          { x: 200, y: 150 },
          { x: 300, y: 80 },
          { x: 300, y: 220 },
          { x: 300, y: 100 },
          { x: 300, y: 200 },
        ],
        overlay: { extendData: createdOverlay.extendData },
      })
    ).toHaveLength(12);

    // Identical cone value is a no-op (no redundant redraw/offset snap)
    fake.createOverlay.mockClear();
    renderer.setExpectedMove!({ ...cone });
    expect(fake.createOverlay).not.toHaveBeenCalled();

    // Adding a bar re-applies the cone
    fake.createOverlay.mockClear();
    renderer.replace([
      { ...bar, id: "b0", timestamp: t0 },
      { ...bar, id: "b1", timestamp: t1 },
      { ...bar, id: "b2", timestamp: t1 + day },
    ]);
    expect(fake.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ name: EXPECTED_MOVE_OVERLAY })
    );

    // Replacing bars with a different spacing (same count and last timestamp) re-applies the cone
    fake.createOverlay.mockClear();
    const hour = 3_600_000;
    const lastTs = t1 + day;
    renderer.replace([
      { ...bar, id: "h0", timestamp: lastTs - 2 * hour },
      { ...bar, id: "h1", timestamp: lastTs - hour },
      { ...bar, id: "h2", timestamp: lastTs },
    ]);
    expect(fake.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ name: EXPECTED_MOVE_OVERLAY })
    );
    // Zoomed-in barSpace scales offset above 260 px on wide containers and caps at 260 when width is 0
    fake.getBarSpace.mockReturnValue(14);
    fake.setOffsetRightDistance.mockClear();
    renderer.setExpectedMove!({ ...cone, dte: 10 });
    expect(fake.setOffsetRightDistance).toHaveBeenLastCalledWith(420);
    mountEl.clientWidth = 0;
    renderer.setExpectedMove!({ ...cone, dte: 11 });
    expect(fake.setOffsetRightDistance).toHaveBeenLastCalledWith(260);
    fake.getBarSpace.mockReturnValue(8);

    // Clearing bars clears the cone and restores right offset
    renderer.replace([]);
    expect(fake.removeOverlay).toHaveBeenCalledWith({
      groupId: EXPECTED_MOVE_GROUP_ID,
    });
    expect(fake.setOffsetRightDistance).toHaveBeenLastCalledWith(50);

    // Null clears and invalid cone throws TypeError; disposed is a no-op
    renderer.setExpectedMove!(null);
    expect(() => renderer.setExpectedMove!({ ...cone, spot: -1 })).toThrow(
      TypeError
    );
    renderer.dispose();
    renderer.setExpectedMove!(cone);
  });
});
