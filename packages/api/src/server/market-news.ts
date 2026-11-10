import type { WatchlistItem } from "@darkfactory/db/schema";
import { DatabasePersistenceError } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  MARKET_NEWS_HOURS,
  MARKET_NEWS_MAX_FILINGS,
  MARKET_NEWS_MAX_HEADLINES,
  type MarketNewsFiling,
  type MarketNewsHeadline,
  type MarketNewsHours,
  type MarketNewsInclude,
  type MarketNewsTicker,
  type MarketNewsWatchlistOutput,
} from "../contracts/market-news.ts";
import {
  type HeadlineParseOptions,
  type HeadlineSubject,
  decodeFeedBytes,
  ibkrHeadlines,
  mergeHeadlines,
  parseReutersRss,
  parseSecAtom,
  parseSeekingAlphaRss,
  parseYahooRss,
  reutersSearchQuery,
  selectNewsSymbols,
  withinHours,
  yahooSymbol,
} from "../market-news.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import { fetchHistoryNews } from "./ibkr-history.ts";
import { MarketDataError } from "./market-data.ts";
import { requireOperator } from "./operator-access.ts";
import {
  ResearchLensError,
  type ResearchLensErrorCode,
  type ResearchLensOptions,
  type SecTicker,
  secTickers,
  secUserAgent,
} from "./research-lenses.ts";

// Watchlist news monitor for the operator's own watchlist. Headlines per ticker from IBKR
// (vertex-history /news, skipped when VERTEX_HISTORY_URL is not configured), Reuters (Google News
// RSS limited to reuters.com, searched by company name), Seeking Alpha per-symbol RSS and Yahoo
// Finance headline RSS, merged into one list (one copy per story, ibkr > reuters > seekingalpha >
// yahoo); SEC EDGAR 8-K Atom per ticker, read in parallel with the headlines. GET only, bounded
// time and size, redirects never followed, schema-validated, 5 min per-source cache (failures
// 60 s, or the feed's Retry-After). One failing source or ticker never fails the page: failures
// are recorded per ticker. Read-only research; no orders.

// Cold SEC EDGAR answers take over 10 s; same budget as the research lenses.
const NEWS_TIMEOUT_MS = 20_000;
const NEWS_MAX_BYTES = 2 * 1024 * 1024;
// Headline feeds are 50-150 KB; the smaller cap bounds parse work on Workers (cpu_ms 500).
const HEADLINE_MAX_BYTES = 512 * 1024;
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const FAILURE_CACHE_MAX_TTL_MS = 15 * 60 * 1000;
// Bounds the module cache: watchlists can name any symbol, and Yahoo answers unknown ones too.
export const NEWS_CACHE_MAX_ENTRIES = 500;
const NEWS_CONCURRENCY = 4;
// Cached headlines cover the widest window, so one cache entry serves every window.
const HEADLINE_SINCE_MS = Math.max(...MARKET_NEWS_HOURS) * 60 * 60 * 1000;
// vertex-history answers /news one request at a time, at least 3 s apart. A 5 s budget fits one
// queued request behind another, so each page load asks IBKR for at most 2 uncached symbols (the
// newest on the watchlist first); a busy, paced or timed-out answer stops IBKR for the rest of
// that load. Cached IBKR answers (5 min) cost nothing, so later loads fill in other symbols.
export const IBKR_NEWS_TIMEOUT_MS = 5000;
export const IBKR_NEWS_READS_PER_LOAD = 2;
const FEED_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/news-monitor";
const XML_CONTENT_TYPE = /^(?:text|application)\/(?:(?:rss|atom)\+)?xml\b/iu;

export type MarketNewsOptions = ResearchLensOptions &
  Readonly<{
    /** vertex-history service for IBKR headlines; null or absent skips that source. */
    marketHistory?: DeployStatusConfig | null;
  }>;

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

/** HTTP 429 from a feed, with the server's Retry-After wait when it sent one. */
export class FeedBusyError extends ResearchLensError {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super("UNAVAILABLE", message);
    this.name = "FeedBusyError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After in delta-seconds -> ms; an HTTP date or anything else -> null (default wait). */
const parseRetryAfter = (value: string | null): number | null =>
  value !== null && /^\d{1,6}$/u.test(value.trim())
    ? Number(value.trim()) * 1000
    : null;

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
    if (response.status === 429)
      throw new FeedBusyError(
        `${request.label} returned HTTP 429`,
        parseRetryAfter(response.headers.get("retry-after"))
      );
    if ([502, 503, 504].includes(response.status))
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

type CachedSource = Readonly<
  { until: number } & (
    | { ok: true; value: unknown }
    | { ok: false; error: unknown }
  )
>;
const sourceCache = new Map<string, CachedSource>();

export const clearMarketNewsCacheForTesting = (): void => {
  sourceCache.clear();
};

export const marketNewsCacheSizeForTesting = (): number => sourceCache.size;

/** Drops expired entries; when the cache is still full, drops the oldest entry. */
const makeRoom = (now: number): void => {
  if (sourceCache.size < NEWS_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of sourceCache)
    if (now >= entry.until) sourceCache.delete(key);
  const [oldest] = sourceCache.keys();
  if (sourceCache.size >= NEWS_CACHE_MAX_ENTRIES && oldest !== undefined)
    sourceCache.delete(oldest);
};

/**
 * A source not read on this load; never shown. `remember`: cache the skip like a failure (60 s),
 * so the next load spends its IBKR reads on other symbols (IBKR ran past its 5 s). Without it
 * (IBKR budget spent) nothing is cached and the next load may ask.
 */
export class SourceSkipped extends Error {
  readonly remember: boolean;
  constructor(remember = false) {
    super("source skipped for this load");
    this.name = "SourceSkipped";
    this.remember = remember;
  }
}

/** How long a failure is remembered: the upstream's own wait when it sent one, within 1-15 min. */
const failureTtlMs = (error: unknown): number => {
  let wait = 0;
  if (error instanceof FeedBusyError) wait = error.retryAfterMs ?? 0;
  if (error instanceof MarketDataError)
    wait = (error.retryAfterSeconds ?? 0) * 1000;
  return Math.min(
    Math.max(wait, FAILURE_CACHE_TTL_MS),
    FAILURE_CACHE_MAX_TTL_MS
  );
};

/**
 * Successful source reads are cached for 5 min. Failures are cached for 60 s (or the upstream's
 * Retry-After, up to 15 min), so a struggling feed is not asked again on every page load.
 */
export const cachedSource = async <T>(
  key: string,
  now: number,
  load: () => Promise<T>
): Promise<T> => {
  const hit = sourceCache.get(key);
  if (hit !== undefined && now < hit.until) {
    if (hit.ok) return hit.value as T;
    throw hit.error;
  }
  const remember = (entry: CachedSource): void => {
    // Re-insert so insertion order stays oldest-first for makeRoom.
    sourceCache.delete(key);
    makeRoom(now);
    sourceCache.set(key, entry);
  };
  let value: T;
  try {
    value = await load();
  } catch (error) {
    if (!(error instanceof SourceSkipped) || error.remember)
      remember({ error, ok: false, until: now + failureTtlMs(error) });
    throw error;
  }
  remember({ ok: true, until: now + NEWS_CACHE_TTL_MS, value });
  return value;
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "request failed";

type TickerFeeds = Readonly<{
  headlines: MarketNewsHeadline[];
  filings: MarketNewsFiling[];
  errors: string[];
}>;

type HeadlineFeed = Readonly<{
  /** Cache key prefix; the MarketNewsSource name. */
  key: string;
  /** Names the source in its error, e.g. "headlines: Reuters headlines returned HTTP 503". */
  label: string;
  load: () => Promise<MarketNewsHeadline[]>;
}>;

/** What one page load reads: `include` from the request, and the IBKR reads it may still make. */
export interface NewsLoad {
  include: MarketNewsInclude;
  ibkrReads: number;
}

export const newsLoad = (include: MarketNewsInclude = "all"): NewsLoad => ({
  ibkrReads: IBKR_NEWS_READS_PER_LOAD,
  include,
});

/** IBKR headlines within this load's budget; busy, paced or timed out ends IBKR for the load. */
const loadIbkrHeadlines = async (
  history: DeployStatusConfig,
  symbol: string,
  subject: HeadlineSubject,
  parse: HeadlineParseOptions,
  options: MarketNewsOptions,
  load: NewsLoad
): Promise<MarketNewsHeadline[]> => {
  if (load.ibkrReads <= 0) throw new SourceSkipped();
  load.ibkrReads -= 1;
  // The history client aborts its request only when our timeout fires, so an aborted signal
  // means IBKR ran past the budget (not a service failure).
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let signal: AbortSignal | null | undefined;
  const watched: typeof doFetch = (url, init) => {
    signal = init.signal;
    return doFetch(url, init);
  };
  try {
    const news = await fetchHistoryNews(history, symbol, 20, {
      ...options,
      fetch: watched,
      timeoutMs: Math.min(
        options.timeoutMs ?? IBKR_NEWS_TIMEOUT_MS,
        IBKR_NEWS_TIMEOUT_MS
      ),
    });
    return ibkrHeadlines(news, subject, parse);
  } catch (error) {
    if (
      error instanceof MarketDataError &&
      (error.code === "PACED" || error.code === "UNAVAILABLE")
    )
      load.ibkrReads = 0;
    // Slower than this page waits: hidden, and remembered for 60 s so the next load spends its
    // IBKR reads on other symbols instead of waiting on this one again.
    if (signal?.aborted === true) throw new SourceSkipped(true);
    throw error;
  }
};

/** Every headline and 8-K for one ticker (unfiltered); per-source failures land in `errors`. */
export const loadTickerFeeds = async (
  symbol: string,
  options: MarketNewsOptions = {},
  tickerList: () => Promise<Map<string, SecTicker>> = () => secTickers(options),
  load: NewsLoad = newsLoad()
): Promise<TickerFeeds> => {
  const now = (options.now ?? (() => new Date()))().getTime();
  // The SEC company title names the issuer for headline tagging and the Reuters search, and
  // locates its 8-K feed.
  const lookup = await tickerList().then(
    (tickers) => ({
      company: tickers.get(yahooSymbol(symbol)) ?? tickers.get(symbol),
      failure: null,
    }),
    (error: unknown) => ({ company: undefined, failure: { error } })
  );
  const subject = { name: lookup.company?.title ?? null, symbol };
  const parse = { since: new Date(now - HEADLINE_SINCE_MS) };
  const rssFeed = (
    key: string,
    label: string,
    url: string,
    read: typeof parseYahooRss
  ): HeadlineFeed => ({
    key,
    label,
    load: async () =>
      read(
        await fetchBoundedText(
          { headers: { "user-agent": FEED_USER_AGENT }, label, url },
          { ...options, maxBytes: HEADLINE_MAX_BYTES }
        ),
        subject,
        parse
      ),
  });
  const history = options.marketHistory ?? null;
  const reuters = new URLSearchParams({
    ceid: "US:en",
    gl: "US",
    hl: "en-US",
    q: reutersSearchQuery(subject),
  });
  const feeds: HeadlineFeed[] =
    load.include === "filings"
      ? []
      : [
          ...(history === null
            ? []
            : [
                {
                  key: "ibkr",
                  label: "IBKR news",
                  load: () =>
                    loadIbkrHeadlines(
                      history,
                      symbol,
                      subject,
                      parse,
                      options,
                      load
                    ),
                },
              ]),
          rssFeed(
            "reuters",
            "Reuters headlines",
            `https://news.google.com/rss/search?${reuters.toString()}`,
            parseReutersRss
          ),
          rssFeed(
            "seekingalpha",
            "Seeking Alpha headlines",
            `https://seekingalpha.com/api/sa/combined/${encodeURIComponent(symbol.toUpperCase())}.xml`,
            parseSeekingAlphaRss
          ),
          rssFeed(
            "yahoo",
            "Yahoo headlines",
            `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSymbol(symbol))}&region=US&lang=en-US`,
            parseYahooRss
          ),
        ];
  // Every source loads in parallel with the others and with the 8-K feed, each on its own: one
  // failing source never drops the others. Headline tags and the Reuters search use the SEC
  // company name, so headlines read while the SEC list failed are not cached: the next request
  // reads them again with the name.
  const headlineReads = Promise.all(
    feeds.map(({ key, label, load: read }) =>
      (lookup.failure === null
        ? cachedSource(`${key}:${symbol}`, now, read)
        : read()
      ).then(
        (list) => ({ error: null, headlines: list }),
        (error: unknown) => {
          if (error instanceof SourceSkipped)
            return { error: null, headlines: [] };
          const message = reason(error);
          return {
            error: message.startsWith(label) ? message : `${label}: ${message}`,
            headlines: [],
          };
        }
      )
    )
  );
  const filingsRead = (async (): Promise<MarketNewsFiling[]> => {
    if (lookup.failure !== null) throw lookup.failure.error;
    const hit = lookup.company;
    if (hit === undefined)
      throw new ResearchLensError(
        "NOT_FOUND",
        "no SEC filer matches this symbol"
      );
    return await cachedSource(`sec:${symbol}`, now, async () =>
      parseSecAtom(
        await fetchBoundedText(
          {
            headers: { "user-agent": secUserAgent() },
            label: "SEC 8-K feed",
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(hit.cik).padStart(10, "0")}&type=8-K&dateb=&owner=include&count=10&output=atom`,
          },
          options
        ),
        hit.title
      )
    );
  })().then(
    (filings) => ({ error: null, filings }),
    (error: unknown) => ({ error: `filings: ${reason(error)}`, filings: [] })
  );
  const [reads, filed] = await Promise.all([headlineReads, filingsRead]);
  const errors = reads.flatMap((read) =>
    read.error === null ? [] : [`headlines: ${read.error}`]
  );
  if (filed.error !== null) errors.push(filed.error);
  return {
    errors,
    filings: filed.filings,
    headlines: mergeHeadlines(reads.map((read) => read.headlines)),
  };
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

/** The monitor for a list of symbols, filtered to the last `hours`; "filings" skips headlines. */
export const buildMarketNews = async (
  symbols: readonly string[],
  hours: MarketNewsHours,
  options: MarketNewsOptions = {},
  include: MarketNewsInclude = "all"
): Promise<MarketNewsWatchlistOutput> => {
  const load = newsLoad(include);
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
      const feeds = await loadTickerFeeds(
        symbol,
        options,
        sharedTickerList,
        load
      );
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

// Operator only: sign-up is public, each request fans out to IBKR, Reuters, Seeking Alpha, Yahoo
// and SEC, and the SEC requests carry the operator's contact address.
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
      { marketHistory: context.marketHistory ?? null, ...marketNewsOptions },
      input.include
    );
  });

export const marketNewsRouter = { watchlist: watchlistNews };
