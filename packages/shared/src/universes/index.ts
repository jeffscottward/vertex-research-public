// Named backtest universes. "Core 7 futures" is the default selection in every backtest,
// sweep and Autopilot form (owner decision 2026-11-03). The futures are research signals only:
// any live expression uses options on the ETF twin, within the master trading rules.

/** Symbols that stored bar series may use. `=` admits Yahoo continuous futures such as `ES=F`. */
export const BAR_SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,20}$/u;

export type Core7Market = Readonly<{
  /** Exchange root of the future, for example `ES`. */
  root: string;
  /** Yahoo continuous front-month future, for example `ES=F`. */
  future: string;
  /** Options-tradable ETF that tracks the same market. */
  etf: string;
  market: string;
}>;

export const CORE7_MARKETS = [
  { etf: "SPY", future: "ES=F", market: "S&P 500", root: "ES" },
  { etf: "QQQ", future: "NQ=F", market: "Nasdaq-100", root: "NQ" },
  { etf: "DIA", future: "YM=F", market: "Dow 30", root: "YM" },
  { etf: "IWM", future: "RTY=F", market: "Russell 2000", root: "RTY" },
  { etf: "GLD", future: "GC=F", market: "Gold", root: "GC" },
  { etf: "SLV", future: "SI=F", market: "Silver", root: "SI" },
  { etf: "USO", future: "CL=F", market: "WTI crude oil", root: "CL" },
] as const satisfies readonly Core7Market[];

export const BACKTEST_UNIVERSE_IDS = [
  "core7-futures",
  "core7-etf-twins",
] as const;
export type BacktestUniverseId = (typeof BACKTEST_UNIVERSE_IDS)[number];

export const DEFAULT_BACKTEST_UNIVERSE_ID: BacktestUniverseId = "core7-futures";

export type BacktestUniverseMember = Readonly<{
  symbol: string;
  market: string;
  /** The same market in the other Core 7 universe (future ↔ ETF). */
  twin: string;
}>;

export type BacktestUniverse = Readonly<{
  id: BacktestUniverseId;
  label: string;
  description: string;
  members: readonly BacktestUniverseMember[];
}>;

const UNIVERSES_BY_ID: Readonly<Record<BacktestUniverseId, BacktestUniverse>> =
  {
    "core7-futures": {
      description:
        "Yahoo continuous front-month futures (not back-adjusted). Research signals only; a live trade uses options on the ETF twin.",
      id: "core7-futures",
      label: "Core 7 futures",
      members: CORE7_MARKETS.map((entry) => ({
        market: entry.market,
        symbol: entry.future,
        twin: entry.etf,
      })),
    },
    "core7-etf-twins": {
      description:
        "Options-tradable ETFs that track the Core 7 futures markets (split-adjusted daily bars).",
      id: "core7-etf-twins",
      label: "Core 7 ETF twins",
      members: CORE7_MARKETS.map((entry) => ({
        market: entry.market,
        symbol: entry.etf,
        twin: entry.future,
      })),
    },
  };

export const BACKTEST_UNIVERSES: readonly BacktestUniverse[] =
  BACKTEST_UNIVERSE_IDS.map((id) => UNIVERSES_BY_ID[id]);

export const isBacktestUniverseId = (
  value: unknown
): value is BacktestUniverseId =>
  typeof value === "string" &&
  (BACKTEST_UNIVERSE_IDS as readonly string[]).includes(value);

export const backtestUniverse = (id: BacktestUniverseId): BacktestUniverse =>
  UNIVERSES_BY_ID[id];

/**
 * Stored series whose symbol belongs to the universe, in member order (ES, NQ, YM, RTY, GC,
 * SI, CL). Several timeframes of one symbol keep their input order.
 */
export const universeSeries = <Series extends Readonly<{ symbol: string }>>(
  series: readonly Series[],
  id: BacktestUniverseId
): Series[] =>
  backtestUniverse(id).members.flatMap((member) =>
    series.filter((entry) => entry.symbol === member.symbol)
  );

/** ETF twin of a Core 7 future (`ES=F` → `SPY`); null for any other symbol. */
export const etfTwinOfFuture = (symbol: string): string | null =>
  CORE7_MARKETS.find((entry) => entry.future === symbol)?.etf ?? null;

/** A Yahoo continuous futures symbol (`ES=F`, `ZB=F`): research signals only, never paper or live. */
export const isFuturesSymbol = (symbol: string): boolean =>
  symbol.endsWith("=F");
