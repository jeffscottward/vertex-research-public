// Evidence readers of the research screen (docs/vertex-rebuild/designs/research-screen/design.md,
// "Price reader" and "Swinglytics context"): the Yahoo chart answer of a report (quote and daily
// bars), its IBKR daily bars from the history service, and the Swinglytics start page.
// Research only: no order path. A reader returns a result and never throws; its error texts are
// fixed and hold no URL.

import type { ResearchScreenErrorCode } from "../contracts/research-screen.ts";
import type { CatalogAssetType, CatalogEntry } from "../research-screen.ts";
import {
  parseResearchScreenChart,
  type ResearchScreenBar,
  type ResearchScreenQuote,
  researchScreenChartUrl,
} from "../research-screen-quote.ts";
import { nyseSession } from "../strategy-dsl-compile.ts";
import {
  parseSwinglyticsHtml,
  SWINGLYTICS_URL,
  SwinglyticsParseError,
  type SwinglyticsSnapshot,
} from "../swinglytics.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import {
  DAILY_HISTORY_DURATION,
  historyDate,
  historyFetchedAt,
  historyInstrument,
  loadMergedBars,
} from "./merged-bars.ts";
import { readCappedText } from "./portfolio-monitor.ts";

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/research-screen";
const YAHOO_MAX_BYTES = 4 * 1024 * 1024;
const SWINGLYTICS_USER_AGENT =
  "Vertex Research/1.0 (low-frequency public context)";
const SWINGLYTICS_MAX_BYTES = 1_000_000;
const SWINGLYTICS_ERROR_MAX_LENGTH = 240;
/** One attempt of the Yahoo chart request and of the Swinglytics read. */
const READ_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const HTML_CONTENT_TYPE = /^text\/html(?:\s*;|$)/iu;
/** Transport options of the IBKR bars request (design, "Constants"). */
const IBKR_BARS_TRANSPORT = Object.freeze({
  maxPacedWaitMs: 70_000,
  pacedRetries: 1,
  timeoutMs: 20_000,
  unavailableRetries: 0,
});
/** The asset types IBKR bars are read for. */
const IBKR_SERVES: Record<CatalogAssetType, boolean> = {
  equity: true,
  etf: true,
  future: true,
  index: false,
};

export type ResearchScreenOptions = Readonly<{
  /** Yahoo chart, Swinglytics and IBKR history fetch. */
  fetch?: DeployStatusFetch;
  now?: () => Date;
}>;

let options: ResearchScreenOptions = {};

/** Replaces the fetch and clock seams of the research screen. */
export const setResearchScreenOptionsForTesting = (
  next: ResearchScreenOptions
): void => {
  options = next;
};

/** The clock of the research screen (the test seam's clock in tests). */
export const researchScreenNow = (): Date =>
  options.now === undefined ? new Date() : options.now();

export type ReadChartErrorCode = Extract<
  ResearchScreenErrorCode,
  "provider-http" | "provider-timeout" | "rate-limited"
>;

export type ReadChartResult =
  | Readonly<{
      ok: true;
      quote: ResearchScreenQuote | null;
      bars: ResearchScreenBar[];
    }>
  | Readonly<{
      ok: false;
      errorCode: ReadChartErrorCode;
      errorMessage: string;
    }>;

export type ReadIbkrBarsResult =
  | Readonly<{ ok: true; bars: ResearchScreenBar[] }>
  | Readonly<{
      ok: false;
      reason: "failed" | "not-configured" | "not-served";
      message: string;
    }>;

export type ReadSwinglyticsResult =
  | Readonly<{
      ok: true;
      generatedAt: Date;
      retrievedAt: Date;
      snapshot: SwinglyticsSnapshot;
    }>
  | Readonly<{ ok: false; error: string }>;

type BoundedRequest = Readonly<{
  url: string;
  /** Starts every error text. */
  label: string;
  headers: Record<string, string>;
  redirect: "error" | "manual";
  maxBytes: number;
  /** The content type a 2xx answer must have; null accepts any. */
  contentType: RegExp | null;
}>;

type BoundedFailure = Readonly<{
  ok: false;
  errorCode: ReadChartErrorCode;
  errorMessage: string;
}>;

type BoundedRead<T> = Readonly<{ ok: true; value: T }> | BoundedFailure;

/** A 2xx answer that is refused: its size, its encoding or its content. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/**
 * One bounded GET (one attempt, READ_TIMEOUT_MS for the request and the body, the body read as a
 * stream up to maxBytes, valid UTF-8) and `parse` of its text. HTTP 429 => rate-limited; another
 * status that is not 2xx, a refused answer and a parse refusal => provider-http; a timeout and
 * every other failure => provider-timeout.
 */
const boundedRead = async <T>(
  request: BoundedRequest,
  parse: (text: string) => T
): Promise<BoundedRead<T>> => {
  const doFetch: DeployStatusFetch =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const fail = (
    errorCode: ReadChartErrorCode,
    detail: string
  ): BoundedFailure => ({
    errorCode,
    errorMessage: `${request.label} ${detail}`,
    ok: false,
  });
  try {
    const response = await doFetch(request.url, {
      headers: request.headers,
      method: "GET",
      redirect: request.redirect,
      signal: controller.signal,
    });
    if (response.status === 429)
      return fail("rate-limited", "returned HTTP 429");
    if (!response.ok)
      return fail("provider-http", `returned HTTP ${response.status}`);
    if (
      request.contentType !== null &&
      !request.contentType.test(response.headers.get("content-type") ?? "")
    )
      return fail("provider-http", "returned an unexpected content type");
    const text = await readCappedText(
      response,
      request.maxBytes,
      (message) =>
        new Refusal(
          `${request.label} ${message.charAt(0).toLowerCase()}${message.slice(1)}`
        )
    );
    return { ok: true, value: parse(text) };
  } catch (error) {
    // The two refusal classes carry fixed texts; anything else is the transport.
    if (error instanceof Refusal || error instanceof SwinglyticsParseError)
      return {
        errorCode: "provider-http",
        errorMessage: error.message,
        ok: false,
      };
    return fail(
      "provider-timeout",
      controller.signal.aborted ? "request timed out" : "request failed"
    );
  } finally {
    clearTimeout(timer);
  }
};

const chartJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Refusal("Yahoo chart response is not valid JSON");
  }
};

/** The Yahoo chart answer of one report: its quote and 1 year of daily bars. One request. */
export const readChart = async (
  providerSymbol: string
): Promise<ReadChartResult> => {
  const read = await boundedRead(
    {
      contentType: null,
      headers: {
        accept: "application/json",
        "user-agent": YAHOO_USER_AGENT,
      },
      label: "Yahoo chart",
      maxBytes: YAHOO_MAX_BYTES,
      redirect: "manual",
      url: researchScreenChartUrl(providerSymbol),
    },
    (text) => parseResearchScreenChart(chartJson(text))
  );
  return read.ok
    ? { bars: read.value.bars, ok: true, quote: read.value.quote }
    : read;
};

const notServed = (message: string): ReadIbkrBarsResult => ({
  message,
  ok: false,
  reason: "not-served",
});

/**
 * The completed IBKR daily bars of one report (1 year of TRADES bars from the history service).
 * not-served: IBKR has no form of the report here; not-configured: no history service; failed: the
 * read failed or held no completed bar. The caller screens these with the Yahoo bars of the chart.
 */
export const readIbkrBars = async (
  entry: CatalogEntry,
  config: DeployStatusConfig | null | undefined
): Promise<ReadIbkrBarsResult> => {
  if (entry.currency !== "USD")
    return notServed("IBKR bars are read for USD instruments only");
  if (!IBKR_SERVES[entry.assetType])
    return notServed("IBKR bars are read for stocks, ETFs and futures only");
  const instrument = historyInstrument(entry.providerSymbol);
  if (instrument === null) return notServed("No IBKR contract for this symbol");
  if (config === null || config === undefined)
    return {
      message: "IBKR history not configured",
      ok: false,
      reason: "not-configured",
    };
  const merged = await loadMergedBars<ResearchScreenBar>({
    config,
    fromIbkr: (bar, history) => {
      const date = historyDate(bar.t);
      // A bar is forming while the NYSE session of its date has not closed (13:00 New York on an
      // early close) when the service fetched it; a date without a session is never forming.
      const session = nyseSession(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
      const running =
        session !== null &&
        historyFetchedAt(history).getTime() < session.close.getTime();
      return running || bar.c <= 0
        ? null
        : { c: bar.c, date, h: bar.h, l: bar.l, o: bar.o };
    },
    ibkrOnly: true,
    keyOf: (bar) => bar.date,
    offline: true,
    options: {
      ...IBKR_BARS_TRANSPORT,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      now: researchScreenNow,
    },
    request: {
      ...instrument,
      barSize: "1 day",
      duration: DAILY_HISTORY_DURATION["1y"],
      whatToShow: "TRADES",
    },
    site: "research-screen",
    // IBKR only: the Yahoo bars come from the chart answer, so this read is never asked.
    yahoo: async () => [],
  });
  // loadMergedBars gives a reason exactly when it has no IBKR bar.
  if (merged.ibkrError !== null)
    return { message: merged.ibkrError, ok: false, reason: "failed" };
  return {
    bars: merged.bars.map(({ c, date, h, l, o }) => ({ c, date, h, l, o })),
    ok: true,
  };
};

/**
 * The Swinglytics start page as a snapshot (display-only third-party context). Every failure is a
 * one-line text of at most 240 characters.
 */
export const readSwinglytics = async (): Promise<ReadSwinglyticsResult> => {
  const read = await boundedRead(
    {
      contentType: HTML_CONTENT_TYPE,
      headers: { accept: "text/html", "user-agent": SWINGLYTICS_USER_AGENT },
      label: "Swinglytics",
      maxBytes: SWINGLYTICS_MAX_BYTES,
      redirect: "error",
      url: SWINGLYTICS_URL,
    },
    parseSwinglyticsHtml
  );
  return read.ok
    ? {
        generatedAt: read.value.generatedAt,
        ok: true,
        retrievedAt: researchScreenNow(),
        snapshot: read.value.snapshot,
      }
    : {
        error: read.errorMessage
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, SWINGLYTICS_ERROR_MAX_LENGTH),
        ok: false,
      };
};
