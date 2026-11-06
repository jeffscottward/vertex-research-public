import type { ScriptPlot, ScriptSignal } from "@darkfactory/scripting";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CandleRendererOptions,
  ChartPalette,
  DisplayCandle,
  ScriptLayer,
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
  SCRIPT_LAYERS_MAX,
  SCRIPT_SIGNAL_GROUP_ID,
  SCRIPT_SIGNAL_OVERLAY,
  scriptCalc,
  scriptFigures,
  scriptIndicatorName,
  scriptPaneId,
  scriptRows,
  scriptSignalFigures,
  signalMark,
  validScriptLayers,
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
const plot = (
  kind: ScriptPlot["kind"],
  values: (number | null)[],
  color = "#2962ff"
): ScriptPlot => ({ color, id: `plot_${kind}`, kind, title: kind, values });
const signal = (extra: Partial<ScriptSignal> = {}): ScriptSignal => ({
  kind: "long",
  location: "belowbar",
  text: "Buy",
  timestamp: 2000,
  value: 9,
  ...extra,
});
const overlayLayer: ScriptLayer = {
  id: "l1",
  overlay: true,
  plots: [plot("line", [1, null, 3]), plot("histogram", [0.5, -0.5, 1])],
  signals: [signal()],
  title: "Avg",
};
const paneLayer: ScriptLayer = {
  id: "l2",
  overlay: false,
  plots: [plot("circles", [5, 6, 7]), plot("hline", [70, 70, 70], "bad")],
  signals: [],
  title: "Osc",
};

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
    styles: () => Record<string, unknown>;
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

describe("script layers in the KLine adapter", () => {
  it("registers nothing until a layer is shown, then slot templates and a signal overlay once", async () => {
    const { renderer } = await mount();
    renderer.setScriptPlots?.([]);
    expect(mocks.registerIndicator).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: scriptIndicatorName(0) })
    );
    renderer.setScriptPlots?.([overlayLayer]);
    renderer.setScriptPlots?.([overlayLayer, paneLayer]);
    const names = mocks.registerIndicator.mock.calls
      .map(([template]) => (template as { name: string }).name)
      .filter((name) => name.startsWith("VX_SCRIPT"));
    expect(names).toEqual(
      Array.from({ length: SCRIPT_LAYERS_MAX }, (_, slot) =>
        scriptIndicatorName(slot)
      )
    );
    const template = mocks.registerIndicator.mock.calls.find(
      ([entry]) => (entry as { name: string }).name === "VX_SCRIPT_0"
    )?.[0] as CreatedIndicator;
    expect(template.calc([{}, {}])).toEqual([{}, {}]);
    const overlays = mocks.registerOverlay.mock.calls.filter(
      ([entry]) => (entry as { name: string }).name === SCRIPT_SIGNAL_OVERLAY
    );
    expect(overlays).toHaveLength(1);
    const signalOverlay = overlays[0]?.[0] as {
      createPointFigures: (params: {
        coordinates: { x: number; y: number }[];
        overlay: { extendData: unknown };
      }) => unknown[];
    };
    return expect(
      signalOverlay.createPointFigures({
        coordinates: [{ x: 10, y: 20 }],
        overlay: { extendData: signalMark(signal(), palette) },
      })
    ).toHaveLength(2);
  });
  it("creates overlay layers on the candle pane and others in their own pane", async () => {
    const { instance, renderer } = await mount();
    renderer.setScriptPlots?.([overlayLayer, paneLayer]);
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    const calls = instance.createIndicator.mock.calls as unknown as [
      CreatedIndicator,
      boolean,
      unknown,
    ][];
    const [first, firstStack, firstPane] = calls[0] ?? [];
    expect(first?.name).toBe("VX_SCRIPT_0");
    expect(first?.shortName).toBe("Avg");
    expect(first?.precision).toBe(2);
    expect(firstStack).toBe(true);
    expect(firstPane).toEqual({ id: "candle_pane" });
    expect(calls[1]?.[1]).toBe(false);
    expect(calls[1]?.[2]).toEqual({ height: 96, id: scriptPaneId(1) });
    // Values follow the bars by time; na and unknown bars are gaps.
    expect(
      first?.calc([
        { timestamp: 1000 },
        { timestamp: 2000 },
        { timestamp: 3000 },
        { timestamp: 4000 },
        {},
      ])
    ).toEqual([{ p0: 1, p1: 0.5 }, { p1: -0.5 }, { p0: 3, p1: 1 }, {}, {}]);
    expect(first?.figures.map((figure) => [figure.key, figure.type])).toEqual([
      ["p0", "line"],
      ["p1", "bar"],
    ]);
    expect(first?.figures[1]?.baseValue).toBe(0);
    expect(first?.figures[0]?.styles()).toEqual({
      color: "#2962ff",
      style: "solid",
    });
    const second = calls[1]?.[0];
    expect(second?.figures.map((figure) => figure.type)).toEqual([
      "circle",
      "line",
    ]);
    // An invalid colour falls back to the palette accent; hline is dashed.
    expect(second?.figures[1]?.styles()).toEqual({
      color: "#feda00",
      dashedValue: [4, 4],
      style: "dashed",
    });
    expect(instance.createOverlay).toHaveBeenCalledWith([
      {
        extendData: signalMark(signal(), palette),
        groupId: SCRIPT_SIGNAL_GROUP_ID,
        lock: true,
        name: SCRIPT_SIGNAL_OVERLAY,
        points: [{ timestamp: 2000, value: 9 }],
      },
    ]);
    return expect(instance.removeIndicator).not.toHaveBeenCalled();
  });
  it("updates in place, moves slots between panes and removes everything", async () => {
    const { instance, renderer } = await mount();
    renderer.setScriptPlots?.([overlayLayer, paneLayer]);
    const overlaysDrawn = instance.createOverlay.mock.calls.length;
    renderer.setScriptPlots?.([{ ...overlayLayer, title: "Avg 2" }, paneLayer]);
    expect(instance.createIndicator).toHaveBeenCalledTimes(2);
    expect(instance.overrideIndicator).toHaveBeenCalledTimes(2);
    expect(instance.overrideIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ name: "VX_SCRIPT_0", shortName: "Avg 2" }),
      "candle_pane"
    );
    // Unchanged signals are not drawn again.
    expect(instance.createOverlay).toHaveBeenCalledTimes(overlaysDrawn);
    renderer.setScriptPlots?.([paneLayer]);
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      "candle_pane",
      "VX_SCRIPT_0"
    );
    expect(instance.removeIndicator).toHaveBeenCalledWith(
      scriptPaneId(1),
      "VX_SCRIPT_1"
    );
    expect(instance.createIndicator).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "VX_SCRIPT_0" }),
      false,
      { height: 96, id: scriptPaneId(0) }
    );
    expect(instance.removeOverlay).toHaveBeenCalledWith({
      groupId: SCRIPT_SIGNAL_GROUP_ID,
    });
    renderer.setScriptPlots?.([]);
    expect(instance.removeIndicator).toHaveBeenLastCalledWith(
      scriptPaneId(0),
      "VX_SCRIPT_0"
    );
    const removed = instance.removeIndicator.mock.calls.length;
    renderer.setScriptPlots?.([]);
    return expect(instance.removeIndicator).toHaveBeenCalledTimes(removed);
  });
  it("rejects invalid layers and ignores calls after dispose", async () => {
    const { controller, instance, renderer } = await mount();
    expect(() =>
      renderer.setScriptPlots?.([{ ...overlayLayer, id: "" }])
    ).toThrow("Invalid script layers");
    controller.abort();
    renderer.setScriptPlots?.([overlayLayer]);
    return expect(instance.createIndicator).not.toHaveBeenCalled();
  });
});

describe("script layer helpers", () => {
  it("validates layers, plots and signals", () => {
    expect(validScriptLayers([overlayLayer, paneLayer])).toBe(true);
    const invalid: unknown[] = [
      null,
      { ...overlayLayer, id: "x".repeat(161) },
      { ...overlayLayer, title: "t".repeat(81) },
      { ...overlayLayer, overlay: "yes" },
      { ...overlayLayer, plots: null },
      { ...overlayLayer, plots: [null] },
      {
        ...overlayLayer,
        plots: Array.from({ length: 17 }, () => plot("line", [])),
      },
      { ...overlayLayer, plots: [{ ...plot("line", []), kind: "area" }] },
      { ...overlayLayer, plots: [{ ...plot("line", []), id: 4 }] },
      { ...overlayLayer, plots: [plot("line", [Number.NaN])] },
      { ...overlayLayer, plots: [{ ...plot("line", []), values: "1,2" }] },
      { ...overlayLayer, plots: [plot("line", new Array(5001).fill(1))] },
      { ...overlayLayer, signals: null },
      { ...overlayLayer, signals: [null] },
      { ...overlayLayer, signals: [signal({ timestamp: 1.5 })] },
      {
        ...overlayLayer,
        signals: [signal({ value: Number.POSITIVE_INFINITY })],
      },
      { ...overlayLayer, signals: [signal({ text: "t".repeat(41) })] },
      { ...overlayLayer, signals: [{ ...signal(), kind: "flip" }] },
      { ...overlayLayer, signals: [{ ...signal(), location: "inbar" }] },
      {
        ...overlayLayer,
        signals: Array.from({ length: 501 }, () => signal()),
      },
    ];
    for (const layer of invalid)
      expect(validScriptLayers([layer as ScriptLayer])).toBe(false);
    expect(validScriptLayers([overlayLayer, overlayLayer])).toBe(false);
    expect(
      validScriptLayers(
        Array.from({ length: 9 }, (_, index) => ({
          ...overlayLayer,
          id: `l${index}`,
        }))
      )
    ).toBe(false);
    return expect(validScriptLayers("layers" as unknown as ScriptLayer[])).toBe(
      false
    );
  });
  it("names untitled plots, styles histograms and circles", () => {
    const figures = scriptFigures(
      [{ ...plot("histogram", []), title: "" }, plot("circles", [], "#00ff00")],
      "#feda00"
    );
    expect(figures[0]?.title).toBe("Plot 1: ");
    expect(figures[0]?.styles()).toEqual({
      borderColor: "#2962ff",
      color: "#2962ff",
      style: "fill",
    });
    return expect(figures[1]?.styles()).toEqual({
      borderColor: "#00ff00",
      color: "#00ff00",
      style: "fill",
    });
  });
  it("never throws from calc", () => {
    const calc = scriptCalc(scriptRows([plot("line", [1])], [1000]));
    expect(calc([{ timestamp: 1000 }])).toEqual([{ p0: 1 }]);
    return expect(
      calc(null as unknown as readonly { timestamp?: number }[])
    ).toEqual([]);
  });
  it("marks signals with an arrow and text, coloured by kind", () => {
    expect(signalMark(signal(), palette)).toEqual({
      background: "#ffffff",
      color: "#111111",
      foreground: "#222222",
      location: "belowbar",
      text: "\u25B2 Buy",
    });
    expect(
      signalMark(
        signal({ kind: "short", location: "abovebar", text: "" }),
        palette
      )
    ).toMatchObject({ color: "#666666", text: "\u25BC Short" });
    expect(
      signalMark(signal({ kind: "exit", text: "" }), palette)
    ).toMatchObject({
      color: "#feda00",
      text: "\u25B2 Exit",
    });
    return expect(
      signalMark(signal({ kind: "shape", text: "" }), palette).text
    ).toBe("\u25B2 Signal");
  });
  it("draws signal figures above or below the price and rejects bad data", () => {
    const below = scriptSignalFigures(
      [{ x: 10, y: 50 }],
      signalMark(signal(), palette)
    );
    expect(below[0]?.attrs).toEqual({
      coordinates: [
        { x: 10, y: 54 },
        { x: 6, y: 60 },
        { x: 14, y: 60 },
      ],
    });
    expect(below[1]?.attrs).toMatchObject({ baseline: "top", y: 62 });
    const above = scriptSignalFigures(
      [{ x: 10, y: 50 }],
      signalMark(signal({ location: "abovebar" }), palette)
    );
    expect(above[1]?.attrs).toMatchObject({ baseline: "bottom", y: 38 });
    expect(scriptSignalFigures([], signalMark(signal(), palette))).toEqual([]);
    for (const data of [
      null,
      "text",
      { ...signalMark(signal(), palette), location: "inbar" },
      { ...signalMark(signal(), palette), text: 1 },
      { ...signalMark(signal(), palette), color: 1 },
      { ...signalMark(signal(), palette), foreground: 1 },
      { ...signalMark(signal(), palette), background: 1 },
    ])
      expect(scriptSignalFigures([{ x: 1, y: 1 }], data)).toEqual([]);
    return;
  });
});
