// What: TPO / market profile from 30-minute bars. Per session (calendar day in the exchange
// time zone) each 30-minute period gets a letter (A, B, C, ...) printed at every price level its
// high-low range covers. POC = level with the most TPOs; value area = 70% of TPOs grown out from
// the POC two levels at a time; initial balance = the first two periods' range; single prints =
// levels only one period touched.
// Used by: components/portal/order-flow-panel.tsx.
import type { MarketBar } from "@darkfactory/api";

import { pointOfControl } from "./footprint.ts";
import {
  autoPriceStep,
  decimalsOf,
  deriveTickSize,
  groupPrice,
  roundPrice,
} from "./price-grid.ts";

const TPO_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const VALUE_AREA_SHARE = 0.7;
/** Auto price step keeps every session at or under this many rows. */
const TPO_MAX_LEVELS = 60;

export type TpoPeriod = Readonly<{
  letter: string;
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
}>;

export type TpoLevel = Readonly<{
  price: number;
  /** Letters of the periods that traded at this level, in time order ("ABD"). */
  letters: string;
  count: number;
}>;

export type TpoSession = Readonly<{
  /** YYYY-MM-DD in the exchange time zone. */
  date: string;
  periods: readonly TpoPeriod[];
  /** Highest price first. */
  levels: readonly TpoLevel[];
  totalTpos: number;
  poc: number | null;
  valueAreaHigh: number | null;
  valueAreaLow: number | null;
  valueAreaTpos: number;
  /** Range of the first two periods (one when the session has only one so far). */
  initialBalance: Readonly<{
    high: number;
    low: number;
    periods: number;
  }> | null;
  singlePrints: readonly number[];
  high: number;
  low: number;
  open: number;
  close: number;
}>;

export type TpoProfile = Readonly<{
  priceStep: number;
  tickSize: number | null;
  timeZone: string;
  /** Oldest session first. */
  sessions: readonly TpoSession[];
}>;

export type TpoOptions = Readonly<{
  priceStep?: number | undefined;
  valueAreaShare?: number | undefined;
}>;

/**
 * Value area indices over ascending level counts: start at the POC and add the pair of levels
 * above or below with more TPOs (both pairs on a tie) until the share of all TPOs is reached.
 */
export const valueAreaRange = (
  counts: readonly number[],
  pocIndex: number,
  share = VALUE_AREA_SHARE
): Readonly<{ low: number; high: number; tpos: number }> => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const target = total * share;
  let low = pocIndex;
  let high = pocIndex;
  let tpos = counts[pocIndex] ?? 0;
  const at = (index: number) => counts[index] ?? 0;
  while (tpos < target && (low > 0 || high < counts.length - 1)) {
    const up = high < counts.length - 1 ? at(high + 1) + at(high + 2) : -1;
    const down = low > 0 ? at(low - 1) + at(low - 2) : -1;
    if (up >= down) {
      tpos += up;
      high = Math.min(high + 2, counts.length - 1);
    }
    if (down >= up) {
      tpos += down;
      low = Math.max(low - 2, 0);
    }
  }
  return { high, low, tpos };
};

const sessionDates = new Map<string, Intl.DateTimeFormat>();
const sessionDate = (t: number, timeZone: string): string => {
  let format = sessionDates.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
    sessionDates.set(timeZone, format);
  }
  return format.format(new Date(t * 1000));
};

const buildSession = (
  date: string,
  bars: readonly MarketBar[],
  step: number,
  share: number
): TpoSession => {
  const digits = decimalsOf(step);
  const periods = bars.map(
    (bar, index): TpoPeriod => ({
      close: bar.c,
      high: bar.h,
      letter: TPO_LETTERS[index % TPO_LETTERS.length] ?? "?",
      low: bar.l,
      open: bar.o,
      start: bar.t,
    })
  );
  // Level index = price / step, so map keys are integers rather than floats.
  const lettersAt = new Map<number, string>();
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const period of periods) {
    const from = Math.round(groupPrice(period.low, step) / step);
    const to = Math.round(groupPrice(period.high, step) / step);
    bottom = Math.min(bottom, from);
    top = Math.max(top, to);
    for (let index = from; index <= to; index += 1)
      lettersAt.set(index, (lettersAt.get(index) ?? "") + period.letter);
  }
  const ascending: TpoLevel[] = [];
  for (let index = bottom; index <= top; index += 1) {
    const letters = lettersAt.get(index) ?? "";
    ascending.push({
      count: letters.length,
      letters,
      price: roundPrice(index * step, digits),
    });
  }
  const counts = ascending.map((level) => level.count);
  const totalTpos = counts.reduce((sum, count) => sum + count, 0);
  const poc = pointOfControl(
    ascending.map((level) => ({ price: level.price, volume: level.count }))
  );
  const pocIndex = ascending.findIndex((level) => level.price === poc);
  const area = pocIndex < 0 ? null : valueAreaRange(counts, pocIndex, share);
  const ib = periods.slice(0, 2);
  return {
    close: periods.at(-1)?.close ?? 0,
    date,
    high: Math.max(...periods.map((period) => period.high)),
    initialBalance:
      ib.length === 0
        ? null
        : {
            high: Math.max(...ib.map((period) => period.high)),
            low: Math.min(...ib.map((period) => period.low)),
            periods: ib.length,
          },
    levels: [...ascending].reverse(),
    low: Math.min(...periods.map((period) => period.low)),
    open: periods[0]?.open ?? 0,
    periods,
    poc,
    singlePrints: ascending
      .filter((level) => level.count === 1)
      .map((level) => level.price)
      .reverse(),
    totalTpos,
    valueAreaHigh: area === null ? null : (ascending[area.high]?.price ?? null),
    valueAreaLow: area === null ? null : (ascending[area.low]?.price ?? null),
    valueAreaTpos: area?.tpos ?? 0,
  };
};

/** Profiles for every session in the bars (30-minute bars; other sizes are ignored). */
export const buildTpoProfile = (
  bars: readonly MarketBar[],
  timeZone: string,
  options: TpoOptions = {}
): TpoProfile | null => {
  const usable = bars
    .filter(
      (bar) =>
        Number.isFinite(bar.h) && Number.isFinite(bar.l) && bar.h >= bar.l
    )
    .sort((a, b) => a.t - b.t);
  if (usable.length === 0) return null;
  const groups = new Map<string, MarketBar[]>();
  for (const bar of usable) {
    const date = sessionDate(bar.t, timeZone);
    const group = groups.get(date) ?? [];
    group.push(bar);
    groups.set(date, group);
  }
  const tickSize = deriveTickSize(usable.flatMap((bar) => [bar.h, bar.l]));
  // One step for every session so their profiles compare row for row.
  const priceStep =
    options.priceStep !== undefined && options.priceStep > 0
      ? options.priceStep
      : Math.max(
          ...[...groups.values()].map((group) =>
            autoPriceStep(
              tickSize ?? 0.01,
              Math.min(...group.map((bar) => bar.l)),
              Math.max(...group.map((bar) => bar.h)),
              TPO_MAX_LEVELS
            )
          )
        );
  const share = options.valueAreaShare ?? VALUE_AREA_SHARE;
  return {
    priceStep,
    sessions: [...groups.entries()].map(([date, group]) =>
      buildSession(date, group, priceStep, share)
    ),
    tickSize,
    timeZone,
  };
};
