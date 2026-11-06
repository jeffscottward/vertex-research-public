// What: Shared UI lab fixture primitives: a seeded random source, fixed clock, fake account and tickers.
// Every value is deterministic and obviously fake. Never put real account data here.
// Used by: apps/web/src/lab/fixtures/*, apps/web/src/lab/entries/*.

/** Fixed "now" for every fixture, so captures do not change between runs. */
export const LAB_NOW_ISO = "2026-10-30T20:00:00.000Z";
export const LAB_NOW = new Date(LAB_NOW_ISO);

/** The fictional account every money fixture uses. */
export const LAB_ACCOUNT = Object.freeze({
  cash: 61_250,
  currency: "USD",
  id: "DU0000000",
  name: "Demo Capital",
  netLiquidation: 250_000,
});

/** Core 7 ETF twins plus large caps. */
export const LAB_TICKERS = Object.freeze([
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
  "AAPL",
  "NVDA",
  "MSFT",
  "TSLA",
  "AMZN",
] as const);

/** Base close per ticker; unknown symbols get a price derived from their name. */
const BASE_PRICES: Readonly<Record<string, number>> = Object.freeze({
  AAPL: 231.5,
  AMZN: 189.6,
  DIA: 427.9,
  GLD: 248.3,
  IWM: 224.6,
  MSFT: 418.7,
  NVDA: 138.2,
  QQQ: 503.2,
  SLV: 29.4,
  SPY: 581.4,
  TSLA: 252.9,
  USO: 74.8,
});

const MODULUS = 2_147_483_647;

/** Polynomial hash of a seed string into [1, 2^31 - 2]. */
export const hashSeed = (seed: string): number => {
  let hash = 7;
  for (let index = 0; index < seed.length; index += 1)
    hash = (hash * 31 + seed.charCodeAt(index)) % MODULUS;
  return (hash % (MODULUS - 1)) + 1;
};

/** Park-Miller generator: the same seed always gives the same sequence in (0, 1). */
export const createSeededRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state = (state * 48_271) % MODULUS;
    return state / MODULUS;
  };
};

export const roundTo = (value: number, digits = 2): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export const labBasePrice = (symbol: string): number =>
  BASE_PRICES[symbol] ?? roundTo(20 + (hashSeed(symbol) % 480), 2);

/** ISO date (YYYY-MM-DD) `days` before LAB_NOW. */
export const labDaysAgo = (days: number): string =>
  new Date(LAB_NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** ISO timestamp `minutes` before LAB_NOW. */
export const labMinutesAgo = (minutes: number): string =>
  new Date(LAB_NOW.getTime() - minutes * 60_000).toISOString();

/** Write calls in the lab: the screen shows its normal error state, nothing leaves the browser. */
export const labReadOnly = (): Promise<never> =>
  Promise.reject(new Error("UI lab: dummy data only, changes are not saved"));
