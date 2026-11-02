import type { WatchlistItem } from "@darkfactory/db/schema";
import { DatabasePersistenceError } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  MARKET_NEWS_MAX_FILINGS,
  MARKET_NEWS_MAX_HEADLINES,
  type MarketNewsFiling,
  type MarketNewsHeadline,
  type MarketNewsHours,
  type MarketNewsTicker,
  type MarketNewsWatchlistOutput,
} from "../contracts/market-news.ts";
import {
  decodeFeedBytes,
  parseSecAtom,
  parseYahooRss,
  selectNewsSymbols,
  withinHours,
  yahooSymbol,
} from "../market-news.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  ResearchLensError,
  type ResearchLensErrorCode,
  type ResearchLensOptions,
  SEC_USER_AGENT,
  type SecTicker,
  secTickers,
} from "./research-lenses.ts";

// Watchlist news monitor: Yahoo Finance headline RSS and SEC EDGAR 8-K Atom per ticker, for the
// operator's own watchlist. GET only, bounded time and size, redirects never followed,
// schema-validated, 5 min per-source cache. One failing source or ticker never fails the page:
// failures are recorded per ticker. Read-only research; no orders.

// Cold SEC EDGAR answers take over 10 s; same budget as the research lenses.
const NEWS_TIMEOUT_MS = 20_000;
const NEWS_MAX_BYTES = 2 * 1024 * 1024;
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
// Bounds the module cache: watchlists can name any symbol, and Yahoo answers unknown ones too.
export const NEWS_CACHE_MAX_ENTRIES = 500;
const NEWS_CONCURRENCY = 4;
const YAHOO_NEWS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/news-monitor";
const XML_CONTENT_TYPE = /^(?:text|application)\/(?:(?:rss|atom)\+)?xml\b/iu;

export type MarketNewsOptions = ResearchLensOptions;

type TextRequest = Readonly<{
  url: string;
  label: string;
  headers: Record<string, string>;
}>;

const readCappedBytes = async (
  response: Response,
  maxBytes: number,
  fail: () => Error
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw fail();
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw fail();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** One bounded GET of an XML feed returning decoded text. Same error codes as `fetchBoundedJson`. */
export const fetchBoundedText = async (
  request: TextRequest,
  options: MarketNewsOptions = {}
): Promise<string> => {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? NEWS_TIMEOUT_MS
  );
  const fail = (code: ResearchLensErrorCode, detail: string) =>
    new ResearchLensError(code, `${request.label} ${detail}`);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, text/xml",
          ...request.headers,
        },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw fail(
        "UNAVAILABLE",
        controller.signal.aborted ? "request timed out" : "request failed"
      );
    }
    if (response.status === 404) throw fail("NOT_FOUND", "returned HTTP 404");
    if ([429, 502, 503, 504].includes(response.status))
      throw fail("UNAVAILABLE", `returned HTTP ${response.status}`);
    if (response.status !== 200)
      throw fail("UPSTREAM_ERROR", `returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!XML_CONTENT_TYPE.test(contentType))
      throw fail("UPSTREAM_ERROR", "returned an unexpected content type");
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(
        response,
        options.maxBytes ?? NEWS_MAX_BYTES,
        () => fail("UPSTREAM_ERROR", "response exceeds the size cap")
      );
    } catch (error) {
      if (error instanceof ResearchLensError) throw error;
      throw controller.signal.aborted
        ? fail("UNAVAILABLE", "request timed out")
        : fail("UPSTREAM_ERROR", "response could not be read");
    }
    return decodeFeedBytes(bytes, contentType);
  } finally {
    clearTimeout(timer);
  }
};

type CachedSource = Readonly<{ at: number; value: unknown }>;
const sourceCache = new Map<string, CachedSource>();

export const clearMarketNewsCacheForTesting = (): void => {
  sourceCache.clear();
};

export const marketNewsCacheSizeForTesting = (): number => sourceCache.size;

/** Drops expired entries; when the cache is still full, drops the oldest entry. */
const makeRoom = (now: number): void => {
  if (sourceCache.size < NEWS_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of sourceCache)
    if (now - entry.at >= NEWS_CACHE_TTL_MS) sourceCache.delete(key);
  const [oldest] = sourceCache.keys();
  if (sourceCache.size >= NEWS_CACHE_MAX_ENTRIES && oldest !== undefined)
    sourceCache.delete(oldest);
};

/** Successful source reads are cached for 5 min; failures are retried on the next request. */
export const cachedSource = async <T>(
  key: string,
  now: number,
  load: () => Promise<T>
): Promise<T> => {
  const hit = sourceCache.get(key);
  if (hit !== undefined && now - hit.at < NEWS_CACHE_TTL_MS)
    return hit.value as T;
  const value = await load();
  // Re-insert so insertion order stays oldest-first for makeRoom.
  sourceCache.delete(key);
  makeRoom(now);
  sourceCache.set(key, { at: now, value });
  return value;
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "request failed";

type TickerFeeds = Readonly<{
  headlines: MarketNewsHeadline[];
  filings: MarketNewsFiling[];
  errors: string[];
}>;

/** Every headline and 8-K for one ticker (unfiltered); per-source failures land in `errors`. */
export const loadTickerFeeds = async (
  symbol: string,
  options: MarketNewsOptions = {},
  tickerList: () => Promise<Map<string, SecTicker>> = () => secTickers(options)
): Promise<TickerFeeds> => {
  const now = (options.now ?? (() => new Date()))().getTime();
  const errors: string[] = [];
  let headlines: MarketNewsHeadline[] = [];
  let filings: MarketNewsFiling[] = [];
  // The SEC company title names the issuer for headline tagging and locates its 8-K feed.
  const lookup = await tickerList().then(
    (tickers) => ({
      company: tickers.get(yahooSymbol(symbol)) ?? tickers.get(symbol),
      failure: null,
    }),
    (error: unknown) => ({ company: undefined, failure: { error } })
  );
  // Headline tags use the SEC company name, so headlines read while the SEC list failed are not
  // cached: the next request tags them again with the name.
  const loadHeadlines = async (): Promise<MarketNewsHeadline[]> =>
    parseYahooRss(
      await fetchBoundedText(
        {
          headers: { "user-agent": YAHOO_NEWS_USER_AGENT },
          label: "Yahoo headlines",
          url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSymbol(symbol))}&region=US&lang=en-US`,
        },
        options
      ),
      { name: lookup.company?.title ?? null, symbol }
    );
  try {
    headlines =
      lookup.failure === null
        ? await cachedSource(`yahoo:${symbol}`, now, loadHeadlines)
        : await loadHeadlines();
  } catch (error) {
    errors.push(`headlines: ${reason(error)}`);
  }
  try {
    filings = await cachedSource(`sec:${symbol}`, now, async () => {
      if (lookup.failure !== null) throw lookup.failure.error;
      const hit = lookup.company;
      if (hit === undefined)
        throw new ResearchLensError(
          "NOT_FOUND",
          "no SEC filer matches this symbol"
        );
      return parseSecAtom(
        await fetchBoundedText(
          {
            headers: { "user-agent": SEC_USER_AGENT },
            label: "SEC 8-K feed",
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(hit.cik).padStart(10, "0")}&type=8-K&dateb=&owner=include&count=10&output=atom`,
          },
          options
        ),
        hit.title
      );
    });
  } catch (error) {
    errors.push(`filings: ${reason(error)}`);
  }
  return { errors, filings, headlines };
};

/** Runs `work` over `inputs` with at most `limit` in flight; results keep input order. */
export const mapWithConcurrency = async <T, R>(
  inputs: readonly T[],
  limit: number,
  work: (input: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array<R>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      results[index] = await work(inputs[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, worker)
  );
  return results;
};

/** The monitor for a list of symbols, filtered to the last `hours`. */
export const buildMarketNews = async (
  symbols: readonly string[],
  hours: MarketNewsHours,
  options: MarketNewsOptions = {}
): Promise<MarketNewsWatchlistOutput> => {
  const receivedAt = (options.now ?? (() => new Date()))();
  // One SEC ticker-list read per request, shared by every ticker (and its failure too).
  let tickerList: Promise<Map<string, SecTicker>> | undefined;
  const sharedTickerList = () => {
    tickerList ??= secTickers(options);
    return tickerList;
  };
  const tickers = await mapWithConcurrency(
    symbols,
    NEWS_CONCURRENCY,
    async (symbol): Promise<MarketNewsTicker> => {
      const feeds = await loadTickerFeeds(symbol, options, sharedTickerList);
      return {
        errors: feeds.errors,
        filings: withinHours(
          feeds.filings,
          (filing) => filing.filedAt,
          hours,
          receivedAt,
          MARKET_NEWS_MAX_FILINGS
        ),
        headlines: withinHours(
          feeds.headlines,
          (headline) => headline.publishedAt,
          hours,
          receivedAt,
          MARKET_NEWS_MAX_HEADLINES
        ),
        symbol,
      };
    }
  );
  return { receivedAt, tickers };
};

const api = implement(appContract).$context<ApiContext>();

type MarketNewsErrorFactories = Readonly<
  Record<
    "UNAUTHORIZED" | "FORBIDDEN" | "STORAGE_ERROR",
    (options?: { message?: string }) => Error
  >
>;

let marketNewsOptions: MarketNewsOptions = {};
export const setMarketNewsOptionsForTesting = (
  options: MarketNewsOptions
): void => {
  marketNewsOptions = options;
};

// Operator only: sign-up is public, each request fans out to Yahoo and SEC, and the SEC
// requests carry the operator's contact address.
const watchlistNews = api.marketNews.watchlist
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as MarketNewsErrorFactories;
    const repository = context.repositories.watchlist;
    if (repository === undefined) throw failures.STORAGE_ERROR();
    let items: WatchlistItem[];
    try {
      items = await repository.listByUser(context.principal.userId);
    } catch (error) {
      if (error instanceof DatabasePersistenceError)
        throw failures.STORAGE_ERROR();
      throw error;
    }
    return buildMarketNews(
      selectNewsSymbols(items),
      input.hours,
      marketNewsOptions
    );
  });

export const marketNewsRouter = { watchlist: watchlistNews };
