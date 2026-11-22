import {
  adx,
  atr,
  bollinger,
  type Line,
  lwma,
  macd,
  parabolicSar,
  rvolAtTime,
  smma,
  stochastic,
  vwapBands,
} from "./indicator-math.ts";
import { TREND_STUDIES } from "./trend-studies.ts";

// Vertex-computed chart studies registered as KLineCharts 9.8.12 custom
// indicators. The math comes from indicator-math.ts, which mirrors the Python
// research library, so chart overlays and research use the same formulas.
// Display only: the values are never trading inputs.

export const VERTEX_STUDY_IDS = [
  "boll",
  "vwap",
  "sar",
  "smma",
  "lwma",
  "atr",
  "macd",
  "stoch",
  "adx",
  "rvol",
  "supertrend",
  "ultma",
  "alphatrend",
  "chandelier",
  "slingshot",
] as const;
export type VertexStudyId = (typeof VERTEX_STUDY_IDS)[number];

// KLineCharts bars always carry timestamp; volume may be missing (NaN: empty study).
type Bar = Readonly<{
  high: number;
  low: number;
  close: number;
  timestamp?: number;
  volume?: number;
}>;
type Row = Record<string, number>;
type Figure = Readonly<{
  key: string;
  title: string;
  type: "line" | "bar" | "circle";
  baseValue?: number;
}>;
export type StudyPalette = Readonly<{
  accent: string;
  falling: string;
  foreground: string;
  warning?: string;
}>;
export type StudyLineStyle = Readonly<{
  color: string;
  dashedValue: readonly [number, number];
  size: number;
  style: "solid" | "dashed";
}>;
export type VertexStudy = Readonly<{
  id: VertexStudyId;
  name: string;
  shortName: string;
  label: string;
  // "candle": drawn over the price candles; "pane": its own pane below.
  placement: "candle" | "pane";
  calcParams: readonly number[];
  figures: readonly Figure[];
  // Optional per-figure line styling resolved from the active light/dark palette.
  lineStyles?: (palette: StudyPalette) => readonly StudyLineStyle[];
  minValue?: number;
  maxValue?: number;
  // Fixed display decimals for 0..100 oscillators; price studies use the chart's.
  precision?: number;
  // Parameters come from calcParams, the same values the chart tooltip shows.
  calc: (bars: readonly Bar[], params: readonly number[]) => Row[];
}>;

const closes = (bars: readonly Bar[]) => bars.map((bar) => bar.close);
const ohlc = (bars: readonly Bar[]) => ({
  close: closes(bars),
  high: bars.map((bar) => bar.high),
  low: bars.map((bar) => bar.low),
});

// One row per bar. Undefined values are left out, so the chart leaves a gap.
export const zipRows = (
  length: number,
  lines: Readonly<Record<string, Line>>
): Row[] =>
  Array.from({ length }, (_, index) => {
    const row: Row = {};
    for (const [key, line] of Object.entries(lines)) {
      const value = line[index];
      if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
    }
    return row;
  });

// A missing parameter is NaN, which every kernel rejects (empty study).
const param = (params: readonly number[], index: number): number =>
  params[index] ?? Number.NaN;

const line = (key: string, title: string): Figure => ({
  key,
  title,
  type: "line",
});

export const VERTEX_STUDIES: Readonly<Record<VertexStudyId, VertexStudy>> = {
  ...TREND_STUDIES,
  adx: {
    calc: (bars, params) =>
      zipRows(bars.length, adx(ohlc(bars), param(params, 0))),
    calcParams: [14],
    figures: [
      line("adx", "ADX: "),
      line("plusDi", "+DI: "),
      line("minusDi", "-DI: "),
    ],
    id: "adx",
    label: "ADX 14",
    maxValue: 100,
    minValue: 0,
    name: "VX_ADX",
    placement: "pane",
    precision: 2,
    shortName: "ADX",
  },
  atr: {
    calc: (bars, params) =>
      zipRows(bars.length, { atr: atr(ohlc(bars), param(params, 0)) }),
    calcParams: [14],
    figures: [line("atr", "ATR14: ")],
    id: "atr",
    label: "ATR 14",
    name: "VX_ATR",
    placement: "pane",
    shortName: "ATR",
  },
  boll: {
    calc: (bars, params) =>
      zipRows(
        bars.length,
        bollinger(closes(bars), param(params, 0), param(params, 1))
      ),
    calcParams: [20, 2],
    figures: [
      line("upper", "Upper: "),
      line("middle", "Mid: "),
      line("lower", "Lower: "),
    ],
    id: "boll",
    label: "Bollinger 20, 2",
    name: "VX_BOLL",
    placement: "candle",
    shortName: "BB",
  },
  lwma: {
    calc: (bars, params) =>
      zipRows(bars.length, { lwma: lwma(closes(bars), param(params, 0)) }),
    calcParams: [20],
    figures: [line("lwma", "LWMA20: ")],
    id: "lwma",
    label: "LWMA 20",
    name: "VX_LWMA",
    placement: "candle",
    shortName: "LWMA",
  },
  macd: {
    calc: (bars, params) =>
      zipRows(
        bars.length,
        macd(closes(bars), param(params, 0), param(params, 1), param(params, 2))
      ),
    calcParams: [12, 26, 9],
    figures: [
      line("macd", "MACD: "),
      line("signal", "Signal: "),
      { baseValue: 0, key: "histogram", title: "Hist: ", type: "bar" },
    ],
    id: "macd",
    label: "MACD 12, 26, 9",
    name: "VX_MACD",
    placement: "pane",
    shortName: "MACD",
  },
  rvol: {
    calc: (bars, params) =>
      zipRows(bars.length, {
        rvol: rvolAtTime(
          bars.map((bar) => ({
            timestamp: bar.timestamp ?? Number.NaN,
            volume: bar.volume ?? Number.NaN,
          })),
          param(params, 0)
        ),
      }),
    calcParams: [20],
    figures: [line("rvol", "RVOL: ")],
    id: "rvol",
    label: "RVOL at time 20",
    minValue: 0,
    name: "VX_RVOL",
    placement: "pane",
    precision: 2,
    shortName: "RVOL",
  },
  sar: {
    calc: (bars, params) =>
      zipRows(bars.length, {
        sar: parabolicSar(ohlc(bars), param(params, 0), param(params, 1)),
      }),
    calcParams: [0.02, 0.2],
    figures: [{ key: "sar", title: "SAR: ", type: "circle" }],
    id: "sar",
    label: "Parabolic SAR",
    name: "VX_SAR",
    placement: "candle",
    shortName: "SAR",
  },
  smma: {
    calc: (bars, params) =>
      zipRows(bars.length, { smma: smma(closes(bars), param(params, 0)) }),
    calcParams: [20],
    figures: [line("smma", "SMMA20: ")],
    id: "smma",
    label: "SMMA 20",
    name: "VX_SMMA",
    placement: "candle",
    shortName: "SMMA",
  },
  stoch: {
    calc: (bars, params) =>
      zipRows(
        bars.length,
        stochastic(
          ohlc(bars),
          param(params, 0),
          param(params, 1),
          param(params, 2)
        )
      ),
    calcParams: [14, 3, 3],
    figures: [line("k", "%K: "), line("d", "%D: ")],
    id: "stoch",
    label: "Stochastic 14, 3, 3",
    maxValue: 100,
    minValue: 0,
    name: "VX_STOCH",
    placement: "pane",
    precision: 2,
    shortName: "Stoch",
  },
  vwap: {
    calc: (bars, params) =>
      zipRows(
        bars.length,
        vwapBands(
          bars.map((bar) => ({
            close: bar.close,
            high: bar.high,
            low: bar.low,
            timestamp: bar.timestamp ?? Number.NaN,
            volume: bar.volume ?? Number.NaN,
          })),
          param(params, 0),
          param(params, 1)
        )
      ),
    calcParams: [1, 2],
    figures: [
      line("vwap", "VWAP: "),
      line("upper1", "+1σ: "),
      line("lower1", "-1σ: "),
      line("upper2", "+2σ: "),
      line("lower2", "-2σ: "),
    ],
    id: "vwap",
    label: "VWAP 1σ, 2σ",
    lineStyles: (palette) => {
      const center = palette.warning ?? palette.accent;
      const inner: StudyLineStyle = {
        color: palette.foreground,
        dashedValue: [6, 4],
        size: 1,
        style: "dashed",
      };
      const outer: StudyLineStyle = {
        color: palette.falling,
        dashedValue: [2, 3],
        size: 1,
        style: "dashed",
      };
      return [
        { color: center, dashedValue: [2, 2], size: 2, style: "solid" },
        inner,
        inner,
        outer,
        outer,
      ];
    },
    name: "VX_VWAP",
    placement: "candle",
    shortName: "VWAP",
  },
};

export const isVertexStudyId = (value: unknown): value is VertexStudyId =>
  VERTEX_STUDY_IDS.some((id) => id === value);

export const studyPaneId = (id: VertexStudyId): string => `vx_${id}_pane`;

// Studies that need their own pane below the candles; the host grows the chart by one pane each.
export const paneStudyCount = (ids: readonly VertexStudyId[]): number =>
  ids.filter((id) => VERTEX_STUDIES[id].placement === "pane").length;

// Minimal structural view of KLineCharts registerIndicator input.
export type IndicatorTemplateLike = Readonly<{
  name: string;
  shortName: string;
  calcParams: number[];
  precision: number;
  shouldOhlc: boolean;
  figures: Figure[];
  minValue: number | null;
  maxValue: number | null;
  calc: (dataList: readonly Bar[]) => Row[];
}>;

// The calc never throws into the renderer: bad input yields an empty study.
export const indicatorTemplate = (
  study: VertexStudy,
  precision: number
): IndicatorTemplateLike => ({
  calc: (dataList) => {
    try {
      return study.calc(dataList, study.calcParams);
    } catch {
      return dataList.map(() => ({}));
    }
  },
  calcParams: [...study.calcParams],
  figures: study.figures.map((figure) => ({ ...figure })),
  maxValue: study.maxValue ?? null,
  minValue: study.minValue ?? null,
  name: study.name,
  precision: study.precision ?? precision,
  shortName: study.shortName,
  shouldOhlc: false,
});
