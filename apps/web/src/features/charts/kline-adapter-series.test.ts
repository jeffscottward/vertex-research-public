import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CandleRendererOptions,
  ChartPalette,
  DisplayCandle,
  SeriesPane,
} from "./types.ts";

const mocks = vi.hoisted(() => ({
  ActionType: { OnCrosshairChange: "onCrosshairChange" },
  CandleType: { CandleUpStroke: "candle_up_stroke" },
  dispose: vi.fn(),
  init: vi.fn(),
  registerIndicator: vi.fn(),
  registerOverlay: vi.fn(),
  version: vi.fn(() => "9.8.12"),
}));
vi.mock("klinecharts", () => mocks);

import {
  createKLineRenderer,
  SERIES_INDICATOR_NAME,
  SERIES_PANE_ID,
  scriptIndicatorName,
  seriesFigures,
  validSeriesPane,
} from "./kline-adapter.ts";

const palette: ChartPalette = {
  accent: "#feda00",
  background: "#ffffff",
  falling: "#666666",
  foreground: "#222222",
  grid: "#ddddd6",
  rising: "#111111",
};
const options = (signal: AbortSignal): CandleRendererOptions => ({
  palette,
  pricePrecision: 2,
  signal,
  volumePrecision: 0,
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
const chart = () => ({
  applyNewData: vi.fn(),
  clearData: vi.fn(),
  createIndicator: vi.fn(() => "pane"),
  createOverlay: vi.fn(() => []),
  getDom: vi.fn(() => null),
  overrideIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
  setPriceVolumePrecision: vi.fn(),
  updateData: vi.fn(),
});
const pane: SeriesPane = {
  points: [
    { timestamp: 1000, value: 5 },
    { timestamp: 3000, value: -5 },
  ],
  precision: 0,
  title: "OI change",
};

type StylesData = Readonly<{
  current: Readonly<{ indicatorData?: Readonly<Record<string, number>> }>;
}>;
type CreatedIndicator = Readonly<{
  name: string;
  shortName: string;
  precision: number;
  calc: (dataList: readonly { timestamp?: number }[]) => unknown[];
  figures: readonly Readonly<{
    key: string;
    type: string;
    title: string;
    baseValue?: number;
    styles: (data: StylesData) => Record<string, unknown>;
  }>[];
}>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const instance = chart();
  mocks.init.mockReturnValue(instance);
  const controller = new AbortController();
  const renderer = await createKLineRenderer(
    {} as HTMLElement,
    options(controller.signal)
  );
  renderer.replace([candle(1000, 10), candle(2000, 11), candle(3000, 12)]);
  return { controller, instance, renderer };
};
const seriesTemplates = () =>
  mocks.registerIndicator.mock.calls
    .map(([template]) => template as CreatedIndicator)
    .filter((template) => template.name === SERIES_INDICATOR_NAME);
const points = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: index,
    value: index,
  }));

describe("validSeriesPane", () => {
  it("accepts a valid pane, an empty pane and the largest pane", () => {
    expect(validSeriesPane(pane)).toBe(true);
    expect(validSeriesPane({ ...pane, points: [] })).toBe(true);
    expect(
      validSeriesPane({
        points: points(4096),
        precision: 8,
        title: "x".repeat(40),
      })
    ).toBe(true);
  });
  it.each<readonly [string, unknown]>([
    ["an empty title", { ...pane, title: "" }],
    ["a 41-character title", { ...pane, title: "x".repeat(41) }],
    ["a title that is not text", { ...pane, title: 5 }],
    ["precision 9", { ...pane, precision: 9 }],
    ["precision 1.5", { ...pane, precision: 1.5 }],
    ["precision -1", { ...pane, precision: -1 }],
    ["a precision that is not a number", { ...pane, precision: "0" }],
    ["4,097 points", { ...pane, points: points(4097) }],
    ["points that are not a list", { ...pane, points: "none" }],
    [
      "a non-finite value",
      { ...pane, points: [{ timestamp: 1000, value: Number.NaN }] },
    ],
    [
      "a value that is not a number",
      { ...pane, points: [{ timestamp: 1000, value: "5" }] },
    ],
    [
      "a timestamp that is not a number",
      { ...pane, points: [{ timestamp: "1000", value: 5 }] },
    ],
    [
      "a timestamp that is not an integer",
      { ...pane, points: [{ timestamp: 1000.5, value: 5 }] },
    ],
    [
      "a timestamp outside the date range",
      { ...pane, points: [{ timestamp: 8_640_000_000_000_001, value: 5 }] },
    ],
    [
      "timestamps that do not increase",
      {
        ...pane,
        points: [
          { timestamp: 2000, value: 1 },
          { timestamp: 2000, value: 2 },
        ],
      },
    ],
    ["a point that is not an object", { ...pane, points: [5] }],
    ["a null point", { ...pane, points: [null] }],
    ["a pane that is not an object", "pane"],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(validSeriesPane(value)).toBe(false);
  });
});

describe("series pane in the KLine adapter", () => {
  it("registers the template once and creates the indicator in the reserved pane", async () => {
    const { instance, renderer } = await mount();
    expect(seriesTemplates()).toHaveLength(0);
    renderer.setSeriesPane?.(pane);
    renderer.setSeriesPane?.(pane);
    const templates = seriesTemplates();
    expect(templates).toHaveLength(1);
    // The placeholder calc of the template gives one empty row per bar.
    expect(templates[0]?.calc([{ timestamp: 1 }, { timestamp: 2 }])).toEqual([
      {},
      {},
    ]);
    // The script slot templates are not touched.
    expect(mocks.registerIndicator).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: scriptIndicatorName(0) })
    );
    expect(instance.createIndicator).toHaveBeenCalledTimes(1);
    expect(instance.createIndicator).toHaveBeenCalledWith(
      expect.objectContaining({
        name: SERIES_INDICATOR_NAME,
        precision: 0,
        shortName: "OI change",
      }),
      false,
      { height: 96, id: "vx_series_pane" }
    );
    expect(SERIES_PANE_ID).toBe("vx_series_pane");
    expect(SERIES_INDICATOR_NAME).toBe("VX_SERIES");
  });
  it("overrides the indicator in place for a second pane", async () => {
    const { instance, renderer } = await mount();
    renderer.setSeriesPane?.(pane);
    renderer.setSeriesPane?.({ ...pane, precision: 2, title: "Other" });
    expect(instance.createIndicator).toHaveBeenCalledTimes(1);
    expect(instance.overrideIndicator).toHaveBeenCalledTimes(1);
    expect(instance.overrideIndicator).toHaveBeenCalledWith(
      expect.objectContaining({
        name: SERIES_INDICATOR_NAME,
        precision: 2,
        shortName: "Other",
      }),
      SERIES_PANE_ID
    );
  });
  it("removes the indicator on null, and only when one is shown", async () => {
    const { instance, renderer } = await mount();
    renderer.setSeriesPane?.(null);
    expect(instance.removeIndicator).not.toHaveBeenCalled();
    expect(instance.createIndicator).not.toHaveBeenCalled();
    expect(seriesTemplates()).toHaveLength(0);
    renderer.setSeriesPane?.(pane);
    renderer.setSeriesPane?.(null);
    renderer.setSeriesPane?.(null);
    expect(instance.removeIndicator).toHaveBeenCalledTimes(1);
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      SERIES_PANE_ID,
      SERIES_INDICATOR_NAME
    );
    // A pane after a removal is created again; the template is not registered again.
    renderer.setSeriesPane?.(pane);
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    expect(seriesTemplates()).toHaveLength(1);
  });
  it("gives the value at a candle with a point and no value at a candle without one", async () => {
    const { instance, renderer } = await mount();
    renderer.setSeriesPane?.(pane);
    const created = instance.createIndicator.mock.calls.at(0)?.at(0) as
      | CreatedIndicator
      | undefined;
    expect(
      created?.calc([
        { timestamp: 1000 },
        { timestamp: 2000 },
        { timestamp: 3000 },
        {},
      ])
    ).toEqual([{ value: 5 }, {}, { value: -5 }, {}]);
  });
  it("draws one bar from zero in the rising color for 5 and 0 and the falling color for -5", async () => {
    const { instance, renderer } = await mount();
    renderer.setSeriesPane?.(pane);
    const created = instance.createIndicator.mock.calls.at(0)?.at(0) as
      | CreatedIndicator
      | undefined;
    expect(created?.figures).toHaveLength(1);
    const figure = created?.figures[0];
    expect(figure).toMatchObject({
      baseValue: 0,
      key: "value",
      title: "",
      type: "bar",
    });
    const color = (indicatorData?: Record<string, number>) =>
      figure?.styles({
        current: indicatorData === undefined ? {} : { indicatorData },
      });
    const rising = {
      borderColor: palette.rising,
      color: palette.rising,
      style: "fill",
    };
    expect(color({ value: 5 })).toEqual(rising);
    expect(color({ value: 0 })).toEqual(rising);
    expect(color({ value: -5 })).toEqual({
      borderColor: palette.falling,
      color: palette.falling,
      style: "fill",
    });
    // A bar without a row or without a value draws nothing; the callback still answers.
    expect(color({})).toEqual(rising);
    expect(color()).toEqual(rising);
    expect(seriesFigures(palette)).toHaveLength(1);
  });
  it("does nothing after dispose", async () => {
    const { instance, renderer } = await mount();
    renderer.setSeriesPane?.(pane);
    renderer.dispose();
    vi.clearAllMocks();
    renderer.setSeriesPane?.({ ...pane, title: "Later" });
    renderer.setSeriesPane?.(null);
    expect(instance.createIndicator).not.toHaveBeenCalled();
    expect(instance.overrideIndicator).not.toHaveBeenCalled();
    expect(instance.removeIndicator).not.toHaveBeenCalled();
    expect(mocks.registerIndicator).not.toHaveBeenCalled();
  });
  it("throws a type error for an invalid pane and draws nothing", async () => {
    const { instance, renderer } = await mount();
    expect(() => renderer.setSeriesPane?.({ ...pane, title: "" })).toThrow(
      new TypeError("Invalid series pane")
    );
    expect(() =>
      renderer.setSeriesPane?.({
        ...pane,
        points: [
          { timestamp: 2000, value: 1 },
          { timestamp: 1000, value: 2 },
        ],
      })
    ).toThrow(TypeError);
    expect(instance.createIndicator).not.toHaveBeenCalled();
    expect(seriesTemplates()).toHaveLength(0);
  });
});
