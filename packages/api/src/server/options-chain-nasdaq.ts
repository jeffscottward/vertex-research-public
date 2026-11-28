import { z } from "zod";

import {
  type OptionsOpenInterestRow,
  type OptionsOpenInterestSnapshot,
  type OptionsOpenInterestSource,
  OptionsChainSourceError,
  OptionsChainSourceOff,
} from "./options-chain-source.ts";
import { readCappedText } from "./portfolio-monitor.ts";

// Nasdaq public options-chain open-interest adapter (OptionsOpenInterestSource). Read-only
// GET, no credentials, cookies or crumbs. Called only by optionsChain.chain when Yahoo Finance
// lacks a positive open interest (>= 1) for at least one contract of the shown expiry.
// Error messages are fixed safe texts: no URL, upstream bCodeMessage or raw body is exposed.

export type NasdaqFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type NasdaqOptionsOpenInterestOptions = Readonly<{
  fetch?: NasdaqFetch;
  timeoutMs?: number;
  now?: () => Date;
  cooldownMs?: number;
  maxFailuresBeforeCooldown?: number;
  maxAssetClassCache?: number;
}>;

type AssetClass = "stocks" | "etf";

const BASE_URL = "https://api.nasdaq.com/api/quote/";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const COOLDOWN_MS = 300_000;
const MAX_FAILURES_BEFORE_COOLDOWN = 3;
const MAX_ASSET_CLASS_CACHE = 500;
const LIMIT = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STRIKE_NUMBER = /^\d+(?:\.\d+)?$/;
const WHOLE_DIGITS = /^\d+$/;
const DRILL_DOWN_EXPIRY = /([0-9]{6})[cp][0-9]{8}$/i;

const nullableText = z.string().nullable().default(null).catch(null);

const NasdaqRowSchema = z.object({
  c_Openinterest: nullableText,
  drillDownURL: nullableText,
  expirygroup: nullableText,
  p_Openinterest: nullableText,
  strike: nullableText,
});

const NasdaqBodySchema = z.object({
  data: z
    .object({
      table: z
        .object({
          rows: z.array(z.unknown()).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  status: z.object({
    rCode: z.number().int(),
  }),
});

const parseStrike = (raw: string | null): number | null => {
  if (raw === null) return null;
  const cleaned = raw.trim().replaceAll(",", "");
  if (!STRIKE_NUMBER.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const parseOpenInterest = (raw: string | null): number | null => {
  if (raw === null) return null;
  const cleaned = raw.trim().replaceAll(",", "");
  if (!WHOLE_DIGITS.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
};
const drillDownMatchesExpiry = (
  url: string | null,
  expectedToken: string
): boolean => {
  if (url === null) return true;
  const match = DRILL_DOWN_EXPIRY.exec(url);
  return match === null || match[1] === expectedToken;
};

const extractRows = (
  rawRows: readonly unknown[],
  expectedToken: string
): OptionsOpenInterestRow[] => {
  const rows: OptionsOpenInterestRow[] = [];
  for (const raw of rawRows) {
    const parsed = NasdaqRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (item.expirygroup !== null && item.expirygroup.trim() !== "") continue;
    if (!drillDownMatchesExpiry(item.drillDownURL, expectedToken)) continue;
    const strike = parseStrike(item.strike);
    if (strike === null) continue;
    const callOi = parseOpenInterest(item.c_Openinterest);
    if (callOi !== null)
      rows.push({ openInterest: callOi, right: "call", strike });
    const putOi = parseOpenInterest(item.p_Openinterest);
    if (putOi !== null)
      rows.push({ openInterest: putOi, right: "put", strike });
  }
  return rows;
};

/** Parses one Nasdaq option-chain document into positive open interest rows for `expiry`. */
export const parseNasdaqOpenInterest = (
  body: unknown,
  expiry: string
): OptionsOpenInterestSnapshot => {
  if (!ISO_DATE.test(expiry))
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Invalid expiry date for Nasdaq open interest"
    );
  const parsed = NasdaqBodySchema.safeParse(body);
  if (!parsed.success)
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Nasdaq options returned an unexpected document"
    );
  const { data, status } = parsed.data;
  if (status.rCode === 404)
    throw new OptionsChainSourceError(
      "NOT_FOUND",
      "Nasdaq has no options data for this symbol"
    );
  if (status.rCode >= 500)
    throw new OptionsChainSourceError(
      "UNAVAILABLE",
      "Nasdaq options returned upstream server error"
    );
  if (status.rCode !== 200)
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Nasdaq options returned an unexpected status"
    );
  const rawRows = data?.table?.rows;
  if (rawRows === null || rawRows === undefined) return { expiry, rows: [] };
  const expectedToken = `${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}`;
  return { expiry, rows: extractRows(rawRows, expectedToken) };
};

const defaultFetch: NasdaqFetch = (input, init) =>
  globalThis.fetch(input, init);
const systemClock = (): Date => new Date();

const requestUrl = (
  symbol: string,
  assetClass: AssetClass,
  expiry: string
): string =>
  `${BASE_URL}${encodeURIComponent(symbol)}/option-chain?assetclass=${assetClass}&limit=${LIMIT}&fromdate=${expiry}&todate=${expiry}&excode=oprac&callput=callput&money=all&type=all`;

const readDocument = async (
  doFetch: NasdaqFetch,
  url: string,
  signal: AbortSignal
): Promise<z.infer<typeof NasdaqBodySchema>> => {
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://www.nasdaq.com",
        referer: "https://www.nasdaq.com/",
        "user-agent": USER_AGENT,
      },
      redirect: "error",
      signal,
    });
  } catch {
    throw new OptionsChainSourceError(
      "UNAVAILABLE",
      "Nasdaq options could not be reached"
    );
  }
  if (response.status === 404)
    throw new OptionsChainSourceError(
      "NOT_FOUND",
      "Nasdaq has no options data for this symbol"
    );
  if (
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  )
    throw new OptionsChainSourceError(
      "UNAVAILABLE",
      `Nasdaq options returned HTTP ${response.status}`
    );
  if (!response.ok)
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      `Nasdaq options returned HTTP ${response.status}`
    );
  const text = await readCappedText(
    response,
    MAX_BYTES,
    (message) =>
      new OptionsChainSourceError(
        "UPSTREAM_ERROR",
        `Nasdaq options: ${message}`
      )
  );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Nasdaq options returned invalid JSON"
    );
  }
  const parsed = NasdaqBodySchema.safeParse(body);
  if (!parsed.success)
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Nasdaq options returned an unexpected document"
    );
  return parsed.data;
};

/**
 * Nasdaq public open-interest adapter. Resolves stock vs ETF asset class with a bounded
 * per-process cache and pauses briefly after repeated UNAVAILABLE failures.
 */
export const createNasdaqOptionsOpenInterestSource = (
  options: NasdaqOptionsOpenInterestOptions = {}
): OptionsOpenInterestSource => {
  const doFetch = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const now = options.now ?? systemClock;
  const cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
  const maxFailures =
    options.maxFailuresBeforeCooldown ?? MAX_FAILURES_BEFORE_COOLDOWN;
  const maxCache = options.maxAssetClassCache ?? MAX_ASSET_CLASS_CACHE;

  const assetClasses = new Map<string, AssetClass>();
  let consecutiveUnavailable = 0;
  let pausedUntilMs = 0;

  const rememberAssetClass = (symbol: string, assetClass: AssetClass): void => {
    assetClasses.delete(symbol);
    assetClasses.set(symbol, assetClass);
    for (const oldest of assetClasses.keys()) {
      if (assetClasses.size <= maxCache) break;
      assetClasses.delete(oldest);
    }
  };

  const resetFailures = (): void => {
    consecutiveUnavailable = 0;
    pausedUntilMs = 0;
  };

  const noteFailure = (error: unknown): never => {
    if (
      error instanceof OptionsChainSourceError &&
      error.code === "UNAVAILABLE"
    ) {
      consecutiveUnavailable += 1;
      if (consecutiveUnavailable >= maxFailures)
        pausedUntilMs = now().getTime() + cooldownMs;
    } else if (
      error instanceof OptionsChainSourceError &&
      error.code === "NOT_FOUND"
    ) {
      resetFailures();
    }
    throw error;
  };

  const readWithFallback = async (
    symbol: string,
    expiry: string
  ): Promise<OptionsOpenInterestSnapshot> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const cached = assetClasses.get(symbol);
    const order: readonly AssetClass[] =
      cached === "etf" ? ["etf", "stocks"] : ["stocks", "etf"];
    for (const assetClass of order) {
      const doc = await readDocument(
        doFetch,
        requestUrl(symbol, assetClass, expiry),
        signal
      );
      if (doc.status.rCode === 400) {
        if (cached === assetClass) assetClasses.delete(symbol);
        continue;
      }
      const snapshot = parseNasdaqOpenInterest(doc, expiry);
      if (doc.data !== null && doc.data !== undefined)
        rememberAssetClass(symbol, assetClass);
      resetFailures();
      return snapshot;
    }
    resetFailures();
    throw new OptionsChainSourceError(
      "NOT_FOUND",
      `Nasdaq has no options data for ${symbol}`
    );
  };

  return {
    read: async (symbol, expiry) => {
      const normalized = symbol.trim().toUpperCase().replaceAll("-", ".");
      if (normalized === "" || !ISO_DATE.test(expiry))
        throw new OptionsChainSourceError(
          "UPSTREAM_ERROR",
          "Invalid symbol or expiry for Nasdaq open interest"
        );
      if (now().getTime() < pausedUntilMs)
        throw new OptionsChainSourceOff(
          "Nasdaq temporarily paused after repeated upstream failures"
        );
      try {
        return await readWithFallback(normalized, expiry);
      } catch (error) {
        return noteFailure(error);
      }
    },
  };
};
