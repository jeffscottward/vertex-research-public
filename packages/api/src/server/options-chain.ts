import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { expiryCloseMs } from "../options-chain-greeks.ts";
import {
  hasChain,
  liveQuotes,
  mergeOptionsChain,
  mergeOptionsExpiries,
  OPTIONS_CHAIN_PRIORITY,
  type OptionsChainReads,
  type OptionsSourceRead,
} from "../options-chain-merge.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import { quantDataClientFor } from "./options-analytics.ts";
import { createIbkrOptionsQuoteSource } from "./options-chain-ibkr.ts";
import { createQuantDataOptionsSource } from "./options-chain-quantdata.ts";
import {
  type OptionsAnalyticsSource,
  type OptionsChainSnapshot,
  type OptionsChainSource,
  OptionsChainSourceError,
  type OptionsChainSourceErrorCode,
  OptionsChainSourceOff,
  type OptionsQuoteSource,
} from "./options-chain-source.ts";
import { createYahooOptionsSource } from "./options-chain-yahoo.ts";

// Read-only options chain (optionsChain.expiries, optionsChain.chain). One request reads three
// sources in parallel and merges them (options-chain-merge.ts), Quant Data first: Quant Data
// analytics (context.quantData), IBKR live quotes (context.marketHistory) and the Yahoo
// snapshot (always). The reads of one symbol and expiry are cached for 60 s. One source failing
// is not an error while another has a chain: Quant Data alone can serve it (without bid and
// ask). Operator-only. Nothing here can place, change or cancel orders.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

type Failed = Readonly<{
  status: "failed";
  message: string;
  // The typed adapter code; null for an unexpected error.
  code: OptionsChainSourceErrorCode | null;
}>;
type Outcome<Data> =
  | Extract<OptionsSourceRead<Data>, { status: "ok" }>
  | Readonly<{ status: "off"; message: string }>
  | Failed;

type ChainRead = Readonly<{
  reads: OptionsChainReads;
  // The expiry to show; null when no source has a chain for the request.
  expiry: string | null;
}>;
type CacheEntry = Readonly<{ at: number; value: Promise<ChainRead> }>;

type Injected = Readonly<{
  ibkr?: OptionsQuoteSource;
  quantData?: OptionsAnalyticsSource;
  yahoo?: OptionsChainSource;
  now?: () => Date;
}>;

let injected: Injected = {};
// One Yahoo adapter per process: it holds the Yahoo session.
let yahooSource: OptionsChainSource | null = null;
const systemClock = (): Date => new Date();
let clock = systemClock;
const cache = new Map<string, CacheEntry>();

/** Test seam: replaces any of the three sources and the clock, and clears the cache. */
export const setOptionsChainForTesting = (options: Injected = {}): void => {
  injected = options;
  yahooSource = null;
  clock = options.now ?? systemClock;
  cache.clear();
};

const outcome = async <Data>(
  label: string,
  read: () => Promise<Data>
): Promise<Outcome<Data>> => {
  try {
    return { data: await read(), status: "ok" };
  } catch (error) {
    if (error instanceof OptionsChainSourceOff)
      return { message: error.message, status: "off" };
    // Adapter messages are safe to show; anything else gets a fixed text.
    return error instanceof OptionsChainSourceError
      ? { code: error.code, message: error.message, status: "failed" }
      : { code: null, message: `${label} request failed`, status: "failed" };
  }
};

const sourcesFor = (context: ApiContext) => {
  const quantData = context.quantData ?? null;
  yahooSource ??= injected.yahoo ?? createYahooOptionsSource();
  return {
    ibkr:
      injected.ibkr ??
      createIbkrOptionsQuoteSource(context.marketHistory ?? null, {
        now: clock,
      }),
    quantData:
      injected.quantData ??
      (quantData === null
        ? null
        : createQuantDataOptionsSource(quantDataClientFor(quantData), clock)),
    yahoo: yahooSource,
  };
};

// The expiry of a Yahoo snapshot to show. After the close Yahoo can still list today's expiry
// first: then the next open one, when one is listed.
const yahooShownExpiry = (
  shown: OptionsChainSnapshot | null,
  now: Date
): string | null => {
  const expiry = shown?.expiry ?? null;
  if (
    shown === null ||
    expiry === null ||
    expiryCloseMs(expiry) > now.getTime()
  )
    return expiry;
  return (
    shown.expiries.find((date) => expiryCloseMs(date) > now.getTime()) ?? expiry
  );
};

// No source has a chain and a Yahoo read did not answer: Yahoo's code wins, then IBKR's.
const quoteFailure = (
  yahoo: Outcome<unknown>,
  ibkr: Outcome<unknown>
): Error => {
  const failed = [yahoo, ibkr].find(
    (item): item is Failed & { code: OptionsChainSourceErrorCode } =>
      item.status === "failed" && item.code !== null
  );
  return failed === undefined
    ? new Error("no options source answered")
    : new OptionsChainSourceError(failed.code, failed.message);
};

const QUANT_DATA_NOT_CONFIGURED = {
  message: "Quant Data is not configured",
  status: "off",
} as const;

// The Quant Data read as it is cached: only the rows of the expiry being shown. The answer
// holds the contracts of every expiry, and the merge reads one.
const forExpiry = (
  quantdata: OptionsChainReads["quantdata"],
  expiry: string | null
): OptionsChainReads["quantdata"] =>
  quantdata.status === "ok"
    ? {
        ...quantdata,
        data: {
          ...quantdata.data,
          rows: quantdata.data.rows.filter((row) => row.expiry === expiry),
        },
      }
    : quantdata;

const load = async (
  context: ApiContext,
  symbol: string,
  inputExpiry: string | undefined,
  now: Date
): Promise<ChainRead> => {
  const sources = sourcesFor(context);
  const quantDataSource = sources.quantData;
  const [quantdata, ibkr, firstYahoo] = await Promise.all([
    quantDataSource === null
      ? QUANT_DATA_NOT_CONFIGURED
      : outcome("Quant Data", () => quantDataSource.read(symbol)),
    outcome("IBKR", () => sources.ibkr.read(symbol, inputExpiry)),
    outcome("Yahoo Finance", () => sources.yahoo.read(symbol, inputExpiry)),
  ]);
  const shown = firstYahoo.status === "ok" ? firstYahoo.data : null;
  // Expiries to try, in order, each with "an empty Yahoo snapshot counts as a chain".
  // A requested expiry: that one alone, served even when it lists no contracts.
  // No requested expiry, two passes: first the nearest expiry of each source in the order of
  // OPTIONS_CHAIN_PRIORITY.expiries, each only when a source has at least one contract of it
  // (so the expiry of one source without a chain never hides the chain another has); then, as
  // the last resort, Yahoo's expiry without rows, so the page still gets the expiry list.
  // IBKR is never read a second time: its quotes of another expiry than the one shown are
  // not used.
  const yahooExpiry = yahooShownExpiry(shown, now);
  const sourceExpiry = {
    ibkr: liveQuotes(ibkr)?.expiry,
    // Quant Data lists the expiries that have a row: the first that has not closed.
    quantdata:
      quantdata.status === "ok"
        ? quantdata.data.expiries.find(
            (date) => expiryCloseMs(date) > now.getTime()
          )
        : undefined,
    yahoo: yahooExpiry,
  };
  const attempts: readonly (readonly [string, boolean])[] =
    inputExpiry === undefined
      ? [
          ...[
            ...new Set(
              OPTIONS_CHAIN_PRIORITY.expiries.map(
                (source) => sourceExpiry[source]
              )
            ),
          ].flatMap((date) => (date ? [[date, false] as const] : [])),
          ...(yahooExpiry === null ? [] : [[yahooExpiry, true] as const]),
        ]
      : [[inputExpiry, true]];
  // One Yahoo read per expiry, also when both passes try it.
  const yahooReads = new Map<string, Outcome<OptionsChainSnapshot>>();
  for (const [target, allowEmpty] of attempts) {
    const yahoo =
      yahooReads.get(target) ??
      // The first Yahoo snapshot is for another expiry than this one: read this one.
      (inputExpiry === undefined &&
      shown !== null &&
      shown.expiry !== target &&
      shown.expiries.includes(target)
        ? await outcome("Yahoo Finance", () =>
            sources.yahoo.read(symbol, target)
          )
        : firstYahoo);
    yahooReads.set(target, yahoo);
    if (hasChain({ ibkr, quantdata, symbol, yahoo }, target, allowEmpty))
      return {
        expiry: target,
        reads: {
          ibkr,
          quantdata: forExpiry(quantdata, target),
          symbol,
          yahoo,
        },
      };
  }
  // No chain. A Yahoo read that did not answer (the first one or a follow-up) is a failure of
  // this call: it is thrown, so it reaches the caller typed and is not cached.
  const unanswered = [firstYahoo, ...yahooReads.values()].find(
    (read) => read.status !== "ok"
  );
  if (unanswered !== undefined) throw quoteFailure(unanswered, ibkr);
  // Every Yahoo read answered: the first one is served (the quote fields; NOT_FOUND for the chain).
  return {
    expiry: null,
    reads: {
      ibkr,
      quantdata: forExpiry(quantdata, null),
      symbol,
      yahoo: firstYahoo,
    },
  };
};

const readChain = (
  context: ApiContext,
  symbol: string,
  expiry: string | undefined,
  now: Date
): Promise<ChainRead> => {
  // The configured sources are part of the key: an answer built without a source is never
  // served to a request that has it.
  const key = [
    symbol,
    expiry ?? "nearest",
    context.marketHistory?.url ?? "",
    context.quantData?.baseUrl ?? "",
  ].join("|");
  const hit = cache.get(key);
  if (hit !== undefined && now.getTime() - hit.at < CACHE_TTL_MS)
    return hit.value;
  const value = load(context, symbol, expiry, now);
  cache.delete(key);
  cache.set(key, { at: now.getTime(), value });
  // Failures are not cached. A newer entry under the same key stays.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(oldest);
  }
  return value;
};

const api = implement(appContract).$context<ApiContext>();

type ChainErrors = Readonly<
  Record<
    OptionsChainSourceError["code"],
    (options: { message: string }) => Error
  >
>;

const mapFailure = (error: unknown, errors: ChainErrors): Error =>
  error instanceof OptionsChainSourceError
    ? errors[error.code]({ message: error.message })
    : errors.UNAVAILABLE({ message: "Options data source unavailable" });

const expiries = api.optionsChain.expiries
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const now = clock();
    try {
      const read = await readChain(context, input.symbol, undefined, now);
      return mergeOptionsExpiries(read.reads, read.expiry, now);
    } catch (error) {
      throw mapFailure(error, errors);
    }
  });

const chain = api.optionsChain.chain
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const now = clock();
    let read: ChainRead;
    try {
      read = await readChain(context, input.symbol, input.expiry, now);
    } catch (error) {
      throw mapFailure(error, errors);
    }
    if (read.expiry === null)
      throw errors.NOT_FOUND({
        message:
          input.expiry === undefined
            ? `No listed options for ${input.symbol}`
            : `No ${input.symbol} options expire on ${input.expiry}`,
      });
    return mergeOptionsChain(read.reads, read.expiry, now);
  });

export const optionsChainRouter = { expiries, chain };
