// What: Rate-aware loader of daily closes for basket valuations. No new infrastructure: a small
// in-memory cache in the web process plus one history request at a time.
// Why: the IBKR history service (infra/quant-vps/history) allows about 6 requests per 120 s, at
// least 10 s apart, and waits at most 20 s; a 21-member basket with a cold cache cannot be loaded
// in one view. Each view now loads what fits in a time budget, reuses recent results and defers
// the rest, so repeated views fill the basket in instead of failing every symbol at once.
// Spacing (10 s) and the burst limit (6 per 120 s) stay with the history service: it waits up to
// 20 s itself, answers 429 at once when the wait would be longer, and then serves its own stale
// copy (at most 24 h old) if it has one. A 429 here is stored as a failure for retryMs, so views
// in a row do not repeat it. This loader only keeps requests from piling up on the service lock.
// Only plain data is shared between requests (the workerd runtime forbids sharing promises or
// I/O objects across requests), so waiting for another request's fetch is a short polling sleep.
// Used by: packages/api/src/server/baskets.ts.

import type { DailyClose } from "../basket-index.ts";

export type SymbolCloses = Readonly<{
  symbol: string;
  closes: DailyClose[] | null;
  // When the history service fetched these bars from the source (null when unknown).
  fetchedAt: Date | null;
  reason: string | null;
}>;

export type BasketHistoryLimits = Readonly<{
  // A successful result is reused this long.
  freshMs: number;
  // A failed result is reused this long before the symbol is requested again.
  retryMs: number;
  // The last successful result stays usable this long when a refresh fails or is deferred.
  keepMs: number;
  // No new history request starts after this much time in one valuation.
  budgetMs: number;
  // Wait step while another request's history fetch is in flight.
  pollMs: number;
  // A claim older than this is treated as abandoned: a cancelled request may never run its
  // finally block, so its claim blocks new requests for at most this long, then expires.
  claimMs: number;
  // Cache size cap; the least recently stored symbols are dropped first.
  maxEntries: number;
}>;

export const BASKET_HISTORY_LIMITS: BasketHistoryLimits = {
  freshMs: 10 * 60_000,
  retryMs: 60_000,
  // The history service serves a stale copy for at most 24 h as well.
  keepMs: 24 * 60 * 60_000,
  budgetMs: 15_000,
  pollMs: 500,
  // Above the 30 s history request timeout.
  claimMs: 45_000,
  maxEntries: 1000,
};

export type BasketHistoryLoader = Readonly<{
  // One history request for one symbol. Reports failures in `reason`; never throws.
  fetchCloses: (symbol: string) => Promise<SymbolCloses>;
  // Milliseconds; only differences are used.
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  limits?: Partial<BasketHistoryLimits>;
}>;

export const BASKET_HISTORY_DEFERRED_REASON =
  "History request deferred for IBKR pacing; reload in a minute";

type Entry = Readonly<{
  result: SymbolCloses;
  checkedAt: number;
  good: SymbolCloses | null;
  goodAt: number;
}>;

const cache = new Map<string, Entry>();
// The one history request in flight in this process, if any.
let claim: { readonly at: number } | null = null;

export const resetBasketHistoryCache = (): void => {
  cache.clear();
  claim = null;
};

const lastGood = (
  entry: Entry | undefined,
  now: number,
  limits: BasketHistoryLimits
): SymbolCloses | null => {
  if (entry === undefined || entry.good === null) return null;
  return now - entry.goodAt < limits.keepMs ? entry.good : null;
};

// A result that may be used without a new request, or null when the symbol needs one.
const reusable = (
  entry: Entry | undefined,
  now: number,
  limits: BasketHistoryLimits
): SymbolCloses | null => {
  if (entry === undefined) return null;
  const failed = entry.result.closes === null;
  if (now - entry.checkedAt >= (failed ? limits.retryMs : limits.freshMs)) {
    return null;
  }
  return failed ? (lastGood(entry, now, limits) ?? entry.result) : entry.result;
};

const store = (
  key: string,
  result: SymbolCloses,
  now: number,
  limits: BasketHistoryLimits
): Entry => {
  const previous = cache.get(key);
  const entry: Entry =
    result.closes === null
      ? {
          result,
          checkedAt: now,
          good: previous?.good ?? null,
          goodAt: previous?.goodAt ?? 0,
        }
      : { result, checkedAt: now, good: result, goodAt: now };
  // Re-insert so Map order is the store order; the oldest entries are dropped first.
  cache.delete(key);
  cache.set(key, entry);
  for (const oldest of cache.keys()) {
    if (cache.size <= limits.maxEntries) break;
    cache.delete(oldest);
  }
  return entry;
};

// One symbol: reuse, defer past the budget, wait for another request's fetch, or fetch it.
const loadSymbol = async (
  key: string,
  symbol: string,
  started: number,
  loader: BasketHistoryLoader,
  limits: BasketHistoryLimits
): Promise<SymbolCloses> => {
  for (;;) {
    const now = loader.clock();
    const entry = cache.get(key);
    const ready = reusable(entry, now, limits);
    if (ready !== null) return ready;
    if (now - started >= limits.budgetMs) {
      return (
        lastGood(entry, now, limits) ?? {
          symbol,
          closes: null,
          fetchedAt: null,
          reason: BASKET_HISTORY_DEFERRED_REASON,
        }
      );
    }
    if (claim === null || now - claim.at >= limits.claimMs) break;
    await loader.sleep(limits.pollMs);
  }
  const mine = { at: loader.clock() };
  claim = mine;
  let result: SymbolCloses;
  try {
    result = await loader.fetchCloses(symbol);
  } finally {
    if (claim === mine) claim = null;
  }
  const stored = store(key, result, loader.clock(), limits);
  // A failed refresh falls back to the last good closes, as the history service does.
  return result.closes === null
    ? (lastGood(stored, stored.checkedAt, limits) ?? result)
    : result;
};

/**
 * Loads closes for each symbol (in the given order of the result). Symbols never loaded before go
 * first so a cold basket gains coverage on every view. scope separates history endpoints.
 */
export const loadBasketCloses = async (
  scope: string,
  symbols: readonly string[],
  loader: BasketHistoryLoader
): Promise<SymbolCloses[]> => {
  const limits = { ...BASKET_HISTORY_LIMITS, ...loader.limits };
  const started = loader.clock();
  const keyOf = (symbol: string) => `${scope}\u0000${symbol}`;
  const unique = [...new Set(symbols)];
  const loadedBefore = (symbol: string) =>
    (cache.get(keyOf(symbol))?.good ?? null) !== null;
  const queue = [
    ...unique.filter((symbol) => !loadedBefore(symbol)),
    ...unique.filter(loadedBefore),
  ];
  const loaded = new Map<string, SymbolCloses>();
  for (const symbol of queue) {
    loaded.set(
      symbol,
      await loadSymbol(keyOf(symbol), symbol, started, loader, limits)
    );
  }
  return symbols.map((symbol) => loaded.get(symbol) as SymbolCloses);
};
