import {
  PICK_LIST_SCREEN_MAX_MEMBERS,
  type PickListScreenMemberOutput,
  type PickListScreenStatus,
} from "./contracts/pick-lists.ts";
import {
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
  v: number;
}>;

export type GateResult = Readonly<{ ok: boolean | null; detail: string }>;

const PICK_LIST_SCREEN_PARAMS = {
  fastEma: 20,
  slowEma: 50,
  vwapWindow: 20,
  atrWindow: 14,
  atrMultiple: 2,
  extensionMinBars: 20,
} as const;

const fixed = (value: number): string => value.toFixed(2);

const notEnough = (count: number, needed: number): GateResult => ({
  ok: null,
  detail: `Not enough history (${count} bars, needs ${needed})`,
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
    ok: close > fast && fast > slow,
    detail: `Close ${fixed(close)} vs EMA20 ${fixed(fast)}, EMA50 ${fixed(slow)}`,
  };
};

/** Volume-weighted average typical price of the last `window` bars; null without volume. */
export const vwap = (
  bars: readonly ScreenBar[],
  window: number
): number | null => {
  let weighted = 0;
  let volume = 0;
  for (const bar of bars.slice(-window)) {
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
    return { ok: null, detail: `No volume in the last ${vwapWindow} bars` };
  const close = (bars.at(-1) as ScreenBar).c;
  return {
    ok: close >= average,
    detail: `Close ${fixed(close)} vs 20-day VWAP ${fixed(average)}`,
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
    ok: close <= ceiling,
    detail: `Close ${fixed(close)} vs ceiling ${fixed(ceiling)} (EMA20 ${fixed(fast)} + 2×ATR14 ${fixed(atr)})`,
  };
};

export type ScreenGates = Readonly<{
  emaTrend: GateResult;
  aboveVwap20: GateResult;
  notOverextended: GateResult;
}>;

export const screenGates = (bars: readonly ScreenBar[]): ScreenGates => ({
  emaTrend: emaTrendGate(bars),
  aboveVwap20: aboveVwapGate(bars),
  notOverextended: notOverextendedGate(bars),
});

export const screenStatus = (
  gates: ScreenGates | null
): PickListScreenStatus => {
  if (gates === null) return "unknown";
  const results = [gates.emaTrend, gates.aboveVwap20, gates.notOverextended];
  if (results.some((gate) => gate.ok === null)) return "unknown";
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

export const closesOf = (bars: readonly ScreenBar[]): ClosePoint[] =>
  bars.map((bar) => ({ date: bar.date, close: bar.c }));

const MISSING_GATE: GateResult = { ok: null, detail: "No daily bars" };

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
  return {
    symbol: input.symbol,
    status: screenStatus(gates),
    last: last === null ? null : last.c,
    lastDate: last === null ? null : last.date,
    gates: gates ?? {
      emaTrend: MISSING_GATE,
      aboveVwap20: MISSING_GATE,
      notOverextended: MISSING_GATE,
    },
    quadrant: latestDailyQuadrant(
      bars === null ? null : closesOf(bars),
      input.benchmark
    ),
    sector: input.sector,
    sectorEtf: sectorEtfFor(input.sector),
    sectorQuadrant: latestDailyQuadrant(input.sectorCloses, input.benchmark),
    reason: gates === null ? (input.reason ?? "No daily bars") : null,
  };
};

const NOT_SCREENED_GATE: GateResult = { ok: null, detail: "Not screened" };

/** A member past the per-run screen limit: no bars were read for it. */
export const notScreenedMember = (
  symbol: string,
  sector: string | null
): PickListScreenMemberOutput => ({
  symbol,
  status: "unknown",
  last: null,
  lastDate: null,
  gates: {
    emaTrend: NOT_SCREENED_GATE,
    aboveVwap20: NOT_SCREENED_GATE,
    notOverextended: NOT_SCREENED_GATE,
  },
  quadrant: null,
  sector,
  sectorEtf: sectorEtfFor(sector),
  sectorQuadrant: null,
  reason: `Not screened: first ${PICK_LIST_SCREEN_MAX_MEMBERS} members per run`,
});
