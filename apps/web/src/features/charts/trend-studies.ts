import {
  alphaTrend,
  chandelierExit,
  slingshot,
  supertrend,
  ultimateMa,
} from "@darkfactory/shared/indicators";
import type { VertexStudy } from "./vertex-studies.ts";

// The five Trend Trio studies (SuperTrend, Ultimate MA, AlphaTrend, Chandelier
// Exit, Slingshot), drawn over the candles. Values come from
// @darkfactory/shared/indicators, the TypeScript twin of
// services/research/indicators/trend.py. Display only.

export const TREND_STUDY_IDS = [
  "supertrend",
  "ultma",
  "alphatrend",
  "chandelier",
  "slingshot",
] as const;
export type TrendStudyId = (typeof TREND_STUDY_IDS)[number];

type Bars = Parameters<VertexStudy["calc"]>[0];
type Row = Record<string, number>;

// One row per bar; NaN (undefined) values are left out, so the chart leaves a gap.
const rows = (
  length: number,
  lines: Readonly<Record<string, ArrayLike<number>>>
): Row[] =>
  Array.from({ length }, (_, index) => {
    const row: Row = {};
    for (const [key, values] of Object.entries(lines)) {
      const value = Number(values[index]);
      if (Number.isFinite(value)) row[key] = value;
    }
    return row;
  });

// The value where the direction equals `side`, else NaN (one colour per side).
const where = (
  values: Float64Array,
  direction: Float64Array,
  side: number
): Float64Array =>
  values.map((value, index) =>
    direction[index] === side ? value : Number.NaN
  );

// A missing parameter is NaN, which every kernel rejects (empty study).
const param = (params: readonly number[], index: number): number =>
  params[index] ?? Number.NaN;

const columns = (bars: Bars) => ({
  close: bars.map((bar) => bar.close),
  high: bars.map((bar) => bar.high),
  low: bars.map((bar) => bar.low),
});

// MFI needs a volume on every bar; otherwise AlphaTrend falls back to RSI.
const volumes = (bars: Bars): number[] | null => {
  const values = bars.map((bar) => Number(bar.volume));
  return values.every(Number.isFinite) ? values : null;
};

const line = (key: string, title: string) =>
  ({ key, title, type: "line" }) as const;

export const TREND_STUDIES: Readonly<Record<TrendStudyId, VertexStudy>> = {
  alphatrend: {
    calc: (bars, params) => {
      const { close, high, low } = columns(bars);
      const volume = volumes(bars);
      const { line: at } = alphaTrend(
        high,
        low,
        close,
        volume,
        param(params, 0),
        param(params, 1),
        volume === null ? "rsi" : "mfi"
      );
      const at2 = at.map((_, index) => Number(at[index - 2]));
      return rows(bars.length, { at, at2 });
    },
    calcParams: [14, 1],
    figures: [line("at", "AT: "), line("at2", "AT[2]: ")],
    id: "alphatrend",
    label: "AlphaTrend 14, 1 (MFI)",
    name: "VX_ALPHATREND",
    placement: "candle",
    shortName: "AT",
  },
  chandelier: {
    calc: (bars, params) => {
      const { close, high, low } = columns(bars);
      const ce = chandelierExit(
        high,
        low,
        close,
        param(params, 0),
        param(params, 1)
      );
      return rows(bars.length, {
        long: where(ce.longStop, ce.direction, 1),
        short: where(ce.shortStop, ce.direction, -1),
      });
    },
    calcParams: [22, 3],
    figures: [line("long", "Long stop: "), line("short", "Short stop: ")],
    id: "chandelier",
    label: "Chandelier Exit 22, 3",
    name: "VX_CHANDELIER",
    placement: "candle",
    shortName: "CE",
  },
  slingshot: {
    calc: (bars, params) => {
      const result = slingshot(
        bars.map((bar) => bar.close),
        param(params, 0),
        param(params, 1)
      );
      return rows(bars.length, { fast: result.fast, slow: result.slow });
    },
    calcParams: [38, 62],
    figures: [line("fast", "EMA 38: "), line("slow", "EMA 62: ")],
    id: "slingshot",
    label: "Slingshot EMA 38, 62",
    name: "VX_SLINGSHOT",
    placement: "candle",
    shortName: "Sling",
  },
  supertrend: {
    calc: (bars, params) => {
      const { close, high, low } = columns(bars);
      const st = supertrend(
        high,
        low,
        close,
        param(params, 0),
        param(params, 1)
      );
      return rows(bars.length, {
        down: where(st.line, st.direction, -1),
        up: where(st.line, st.direction, 1),
      });
    },
    calcParams: [10, 3],
    figures: [line("up", "Up: "), line("down", "Down: ")],
    id: "supertrend",
    label: "SuperTrend 10, 3",
    name: "VX_SUPERTREND",
    placement: "candle",
    shortName: "SuperTrend",
  },
  ultma: {
    calc: (bars, params) => {
      const uma = ultimateMa(
        bars.map((bar) => bar.close),
        null,
        "sma",
        param(params, 0),
        param(params, 1)
      );
      return rows(bars.length, {
        falling: where(uma.value, uma.direction, -1),
        rising: where(uma.value, uma.direction, 1),
      });
    },
    calcParams: [20, 2],
    figures: [line("rising", "Rising: "), line("falling", "Falling: ")],
    id: "ultma",
    label: "Ultimate MA SMA 20",
    name: "VX_ULTMA",
    placement: "candle",
    shortName: "UMA",
  },
};
