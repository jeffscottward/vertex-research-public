import {
  PICK_LIST_SCREEN_MAX_MEMBERS,
  type PickListScreenMemberOutput,
  type PickListScreenStatus,
} from "./contracts/pick-lists.ts";
import {
  SECTOR_ROTATION_BENCHMARK,
  SECTOR_ROTATION_SECTORS,
  type SectorRotationQuadrant,
} from "./contracts/sector-rotation.ts";
import {
  type ClosePoint,
  computeRotationPoints,
  ema,
  SECTOR_ROTATION_PARAMS,
} from "./sector-rotation.ts";

// Pick-list screen math (pure; no network, no orders). Gates on daily bars, oldest first:
//
//   emaTrend         close > EMA20 and EMA20 > EMA50           (needs 50 bars)
//   aboveVwap20      close ≥ VWAP20 = Σ(typical × volume) ÷ Σ volume over the last 20 bars,
//                    typical = (high + low + close) ÷ 3         (needs 20 bars; null when their
//                                                                total volume is 0)
//   notOverextended  close ≤ EMA20 + 2 × ATR14                  (needs 20 bars)
//
// EMAs use alpha = 2 ÷ (span + 1), seeded with the first close (the sector rotation `ema`).
// ATR14 is Wilder's: true range TR = max(high − low, |high − prevClose|, |low − prevClose|); the
// first ATR is the mean of the first 14 true ranges, then ATR = (13 × ATR + TR) ÷ 14.
// A gate is null when the history is too short. Status: unknown when bars are missing or any gate
// is null, pass when every gate holds, else fail. Research only: a passing screen is not an order.
// Closes are unadjusted (the same bars as the gates), also for the rotation quadrants.

export type ScreenBar = Readonly<{
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  // Shares; may be fractional. Null when the source sent no volume (never written as 0).
  v: number | null;
}>;

export type GateResult = Readonly<{ ok: boolean | null; detail: string }>;

const PICK_LIST_SCREEN_PARAMS = {
  atrMultiple: 2,
  atrWindow: 14,
  extensionMinBars: 20,
  fastEma: 20,
  slowEma: 50,
  vwapWindow: 20,
} as const;

const fixed = (value: number): string => value.toFixed(2);

const notEnough = (count: number, needed: number): GateResult => ({
  detail: `Not enough history (${count} bars, needs ${needed})`,
  ok: null,
});

const lastOf = (values: readonly number[]): number => values.at(-1) as number;

/** Close above a rising-order EMA stack: close > EMA20 > EMA50. */
export const emaTrendGate = (bars: readonly ScreenBar[]): GateResult => {
  const { fastEma, slowEma } = PICK_LIST_SCREEN_PARAMS;
  if (bars.length < slowEma) return notEnough(bars.length, slowEma);
  const closes = bars.map((bar) => bar.c);
  const close = lastOf(closes);
  const fast = lastOf(ema(closes, fastEma));
  const slow = lastOf(ema(closes, slowEma));
  return {
    detail: `Close ${fixed(close)} vs EMA20 ${fixed(fast)}, EMA50 ${fixed(slow)}`,
    ok: close > fast && fast > slow,
  };
};

/**
 * Volume-weighted average typical price of the last `window` bars; null when a bar in the window has no
 * volume or the window's total volume is 0.
 */
export const vwap = (
  bars: readonly ScreenBar[],
  window: number
): number | null => {
  let weighted = 0;
  let volume = 0;
  for (const bar of bars.slice(-window)) {
    if (bar.v === null) return null;
    weighted += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    volume += bar.v;
  }
  return volume > 0 ? weighted / volume : null;
};

/** Close at or above the 20-day VWAP. */
export const aboveVwapGate = (bars: readonly ScreenBar[]): GateResult => {
  const { vwapWindow } = PICK_LIST_SCREEN_PARAMS;
  if (bars.length < vwapWindow) return notEnough(bars.length, vwapWindow);
  const average = vwap(bars, vwapWindow);
  if (average === null)
    return {
      detail: `Volume missing or 0 in the last ${vwapWindow} bars`,
      ok: null,
    };
  const close = (bars.at(-1) as ScreenBar).c;
  return {
    detail: `Close ${fixed(close)} vs 20-day VWAP ${fixed(average)}`,
    ok: close >= average,
  };
};

/** Wilder's average true range of the whole series; null with fewer than window + 1 bars. */
export const wilderAtr = (
  bars: readonly ScreenBar[],
  window: number
): number | null => {
  if (bars.length < window + 1) return null;
  const ranges = bars.slice(1).map((bar, index) => {
    const previous = (bars[index] as ScreenBar).c;
    return Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - previous),
      Math.abs(bar.l - previous)
    );
  });
  let atr = ranges.slice(0, window).reduce((sum, range) => sum + range, 0);
  atr /= window;
  for (const range of ranges.slice(window))
    atr = (atr * (window - 1) + range) / window;
  return atr;
};

/** Close at or below EMA20 + 2 × ATR14 (not stretched far above its short trend). */
export const notOverextendedGate = (bars: readonly ScreenBar[]): GateResult => {
  const { atrMultiple, atrWindow, extensionMinBars, fastEma } =
    PICK_LIST_SCREEN_PARAMS;
  if (bars.length < extensionMinBars)
    return notEnough(bars.length, extensionMinBars);
  const closes = bars.map((bar) => bar.c);
  const close = lastOf(closes);
  const fast = lastOf(ema(closes, fastEma));
  // extensionMinBars exceeds atrWindow, so the ATR exists.
  const atr = wilderAtr(bars, atrWindow) as number;
  const ceiling = fast + atrMultiple * atr;
  return {
    detail: `Close ${fixed(close)} vs ceiling ${fixed(ceiling)} (EMA20 ${fixed(fast)} + 2×ATR14 ${fixed(atr)})`,
    ok: close <= ceiling,
  };
};

export type ScreenGates = Readonly<{
  emaTrend: GateResult;
  aboveVwap20: GateResult;
  notOverextended: GateResult;
}>;

export const screenGates = (bars: readonly ScreenBar[]): ScreenGates => ({
  aboveVwap20: aboveVwapGate(bars),
  emaTrend: emaTrendGate(bars),
  notOverextended: notOverextendedGate(bars),
});

export const screenStatus = (
  gates: ScreenGates | null
): PickListScreenStatus => {
  if (gates === null) return "no_data";
  const results = [gates.emaTrend, gates.aboveVwap20, gates.notOverextended];
  if (results.some((gate) => gate.ok === null)) return "not_evaluated";
  return results.every((gate) => gate.ok === true) ? "pass" : "fail";
};

const SECTOR_ALIASES: Readonly<
  Record<(typeof SECTOR_ROTATION_SECTORS)[number]["symbol"], readonly string[]>
> = {
  XLB: ["materials", "basic materials"],
  XLC: [
    "communication services",
    "communications",
    "communication",
    "telecommunications",
  ],
  XLE: ["energy"],
  XLF: ["financials", "financial services", "financial", "finance"],
  XLI: ["industrials", "industrial"],
  XLK: ["information technology", "technology", "tech"],
  XLP: ["consumer staples", "consumer defensive"],
  XLRE: ["real estate"],
  XLU: ["utilities"],
  XLV: ["health care", "healthcare"],
  XLY: ["consumer discretionary", "consumer cyclical"],
};

const SECTOR_ETFS: ReadonlyMap<string, string> = new Map(
  SECTOR_ROTATION_SECTORS.flatMap((sector) =>
    SECTOR_ALIASES[sector.symbol].map((alias) => [alias, sector.symbol])
  )
);

/** The SPDR sector ETF for a GICS sector name or a common alias (case-insensitive). */
export const sectorEtfFor = (sector: string | null): string | null => {
  if (sector === null) return null;
  const key = sector
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/ & /gu, " and ");
  return SECTOR_ETFS.get(key) ?? null;
};

/** Latest daily rotation quadrant of `closes` against the benchmark; null when too short. */
export const latestDailyQuadrant = (
  closes: readonly ClosePoint[] | null,
  benchmark: readonly ClosePoint[] | null
): SectorRotationQuadrant | null => {
  if (closes === null || benchmark === null) return null;
  return (
    computeRotationPoints(closes, benchmark, SECTOR_ROTATION_PARAMS.daily).at(
      -1
    )?.quadrant ?? null
  );
};

/** Why latestDailyQuadrant returned null. `noCloses` names the cause of missing subject closes. */
const quadrantGapReason = (
  closes: readonly ClosePoint[] | null,
  benchmark: readonly ClosePoint[] | null,
  noCloses: string
): string => {
  if (closes === null) return noCloses;
  if (benchmark === null)
    return `Benchmark ${SECTOR_ROTATION_BENCHMARK} bars not loaded`;
  return `Too few daily bars shared with ${SECTOR_ROTATION_BENCHMARK}`;
};

const noSectorClosesReason = (
  sector: string | null,
  etf: string | null
): string => {
  if (sector === null) return "No sector in import";
  if (etf === null) return "No sector ETF mapped";
  return `${etf} bars not loaded`;
};

export const closesOf = (bars: readonly ScreenBar[]): ClosePoint[] =>
  bars.map((bar) => ({ close: bar.c, date: bar.date }));

const MISSING_GATE: GateResult = { detail: "No daily bars", ok: null };

export type ScreenMemberInput = Readonly<{
  symbol: string;
  sector: string | null;
  /** Null when the bars could not be loaded (see `reason`). */
  bars: readonly ScreenBar[] | null;
  reason: string | null;
  benchmark: readonly ClosePoint[] | null;
  /** Closes of the member's sector ETF; null when unknown or not loaded. */
  sectorCloses: readonly ClosePoint[] | null;
}>;

/** One screened member. Bars must be sorted oldest first. */
export const screenMember = (
  input: ScreenMemberInput
): PickListScreenMemberOutput => {
  const { bars } = input;
  const gates = bars === null || bars.length === 0 ? null : screenGates(bars);
  const last = bars?.at(-1) ?? null;
  const closes = bars === null ? null : closesOf(bars);
  const quadrant = latestDailyQuadrant(closes, input.benchmark);
  const sectorEtf = sectorEtfFor(input.sector);
  const sectorQuadrant = latestDailyQuadrant(
    input.sectorCloses,
    input.benchmark
  );
  return {
    gates: gates ?? {
      aboveVwap20: MISSING_GATE,
      emaTrend: MISSING_GATE,
      notOverextended: MISSING_GATE,
    },
    last: last === null ? null : last.c,
    lastDate: last === null ? null : last.date,
    quadrant,
    quadrantReason:
      quadrant === null
        ? quadrantGapReason(closes, input.benchmark, "No daily bars")
        : null,
    reason: gates === null ? (input.reason ?? "No daily bars") : null,
    sector: input.sector,
    sectorEtf,
    sectorQuadrant,
    sectorQuadrantReason:
      sectorQuadrant === null
        ? quadrantGapReason(
            input.sectorCloses,
            input.benchmark,
            noSectorClosesReason(input.sector, sectorEtf)
          )
        : null,
    status: screenStatus(gates),
    symbol: input.symbol,
  };
};

const NOT_SCREENED_GATE: GateResult = { detail: "Not screened", ok: null };

/** A member past the per-run screen limit: no bars were read for it. */
export const notScreenedMember = (
  symbol: string,
  sector: string | null
): PickListScreenMemberOutput => ({
  gates: {
    aboveVwap20: NOT_SCREENED_GATE,
    emaTrend: NOT_SCREENED_GATE,
    notOverextended: NOT_SCREENED_GATE,
  },
  last: null,
  lastDate: null,
  quadrant: null,
  quadrantReason: "Not screened",
  reason: `Not screened: first ${PICK_LIST_SCREEN_MAX_MEMBERS} members per run`,
  sector,
  sectorEtf: sectorEtfFor(sector),
  sectorQuadrant: null,
  sectorQuadrantReason: "Not screened",
  status: "not_screened",
  symbol,
});
