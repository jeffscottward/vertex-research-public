import { implement } from "@orpc/server";

import {
  CongressIndexError,
  distinctMembers,
  filingWindow,
  houseIndexUrl,
  type IndexFiling,
  indexXmlFromBytes,
  parseFilingIndex,
  selectPtrFilings,
  windowYears,
} from "../congress-trades.ts";
import { appContract } from "../contract.ts";
import type {
  CongressTradesFeedOutput,
  CongressTradeWindow,
} from "../contracts/congress-trades.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";

// Read-only House STOCK Act PTR filing feed. GET only to the public House Clerk index
// (<YEAR>FD.zip), bounded time and size, redirects never followed, ZIP and XML read by the pure
// module, rows schema-parsed, 15 min in-process cache per index year.

const CLERK_TIMEOUT_MS = 30_000;
const CLERK_ZIP_MAX_BYTES = 8 * 1024 * 1024;
const CLERK_XML_MAX_BYTES = 32 * 1024 * 1024;
const CLERK_CACHE_TTL_MS = 15 * 60 * 1000;
const CLERK_USER_AGENT =
  "vertex-research congress-trades (personal research; owner@example.com)";

export type CongressTradesErrorCode =
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR";

export class CongressTradesError extends Error {
  code: CongressTradesErrorCode;
  constructor(code: CongressTradesErrorCode, message: string) {
    super(message);
    this.name = "CongressTradesError";
    this.code = code;
  }
}

export type CongressTradesOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxXmlBytes?: number;
  now?: () => Date;
}>;

const readCappedBytes = async (
  response: Response,
  maxBytes: number,
  fail: (detail: string) => Error
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw fail("exceeds the size cap");
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw fail("exceeds the size cap");
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

/** One bounded GET of a year's index ZIP. HTTP 404 => NOT_FOUND; gateway errors and timeouts => UNAVAILABLE. */
export const fetchHouseIndex = async (
  year: number,
  options: CongressTradesOptions = {}
): Promise<Uint8Array> => {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CLERK_TIMEOUT_MS
  );
  const fail = (code: CongressTradesErrorCode, detail: string) =>
    new CongressTradesError(code, `House ${year} disclosure index ${detail}`);
  try {
    let response: Response;
    try {
      response = await doFetch(houseIndexUrl(year), {
        headers: {
          accept: "application/zip, application/octet-stream",
          "user-agent": CLERK_USER_AGENT,
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
    if ([502, 503, 504].includes(response.status))
      throw fail("UNAVAILABLE", `returned HTTP ${response.status}`);
    if (response.status !== 200)
      throw fail("UPSTREAM_ERROR", `returned HTTP ${response.status}`);
    try {
      return await readCappedBytes(
        response,
        options.maxBytes ?? CLERK_ZIP_MAX_BYTES,
        (detail) => fail("UPSTREAM_ERROR", detail)
      );
    } catch (error) {
      if (error instanceof CongressTradesError) throw error;
      throw controller.signal.aborted
        ? fail("UNAVAILABLE", "request timed out")
        : fail("UPSTREAM_ERROR", "response could not be read");
    }
  } finally {
    clearTimeout(timer);
  }
};

type CachedIndex = Readonly<{ at: Date; filings: IndexFiling[] }>;
const indexCache = new Map<number, CachedIndex>();

export const clearCongressTradesCacheForTesting = (): void => {
  indexCache.clear();
};

/** One year's parsed index, cached for 15 minutes. A missing index (HTTP 404) is null; an unreadable one throws CongressIndexError. */
const loadIndexYear = async (
  year: number,
  options: CongressTradesOptions,
  now: Date
): Promise<CachedIndex | null> => {
  const cached = indexCache.get(year);
  if (
    cached !== undefined &&
    now.getTime() - cached.at.getTime() < CLERK_CACHE_TTL_MS
  )
    return cached;
  let bytes: Uint8Array;
  try {
    bytes = await fetchHouseIndex(year, options);
  } catch (error) {
    if (error instanceof CongressTradesError && error.code === "NOT_FOUND")
      return null;
    throw error;
  }
  const filings = parseFilingIndex(
    await indexXmlFromBytes(bytes, options.maxXmlBytes ?? CLERK_XML_MAX_BYTES)
  );
  const entry = { at: now, filings };
  indexCache.set(year, entry);
  return entry;
};

/** PTR filings in the last `days` days from the House Clerk index, newest first. */
export const fetchCongressTradesFeed = async (
  days: CongressTradeWindow,
  options: CongressTradesOptions = {}
): Promise<CongressTradesFeedOutput> => {
  const now = (options.now ?? (() => new Date()))();
  const window = filingWindow(now, days);
  const years = windowYears(window);
  const loaded = await Promise.all(
    years.map((year) => loadIndexYear(year, options, now))
  );
  const indexes = loaded.filter((entry) => entry !== null);
  if (indexes.length === 0)
    throw new CongressTradesError(
      "NOT_FOUND",
      `No House disclosure index for ${years.join(" or ")}`
    );
  const filings = selectPtrFilings(
    indexes.flatMap((entry) => entry.filings),
    window
  );
  return {
    filings,
    members: distinctMembers(filings),
    receivedAt: new Date(
      Math.min(...indexes.map((entry) => entry.at.getTime()))
    ),
    source: `U.S. House Clerk financial disclosure index ${years.map((year) => `${year}FD.zip`).join(", ")} (STOCK Act periodic transaction reports)`,
  };
};

const api = implement(appContract).$context<ApiContext>();

type CongressTradesErrorFactories = Readonly<
  Record<CongressTradesErrorCode, (options?: { message?: string }) => Error>
>;

let congressTradesOptions: CongressTradesOptions = {};
export const setCongressTradesOptionsForTesting = (
  options: CongressTradesOptions
): void => {
  congressTradesOptions = options;
};

const feed = api.congressTrades.feed
  .use(requireOperator)
  .handler(async ({ input, errors }) => {
    try {
      return await fetchCongressTradesFeed(input.days, congressTradesOptions);
    } catch (error) {
      const failures = errors as CongressTradesErrorFactories;
      if (error instanceof CongressTradesError)
        throw failures[error.code]({ message: error.message });
      if (error instanceof CongressIndexError)
        throw failures.UPSTREAM_ERROR({
          message: `House disclosure index: ${error.message}`,
        });
      throw failures.UPSTREAM_ERROR({
        message: "Congress trades request failed",
      });
    }
  });

export const congressTradesRouter = { feed };
