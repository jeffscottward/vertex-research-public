import { z } from "zod";

import {
  type OptionQuote,
  type OptionsChainSnapshot,
  type OptionsChainSource,
  OptionsChainSourceError,
} from "./options-chain-source.ts";
import { readCappedText } from "./portfolio-monitor.ts";

// Yahoo Finance adapter for the options chain port (public GET, read-only). Yahoo's options
// endpoint needs a session cookie and a matching "crumb" token: the adapter gets both once,
// keeps them in memory, and renews them once when Yahoo answers HTTP 401. Neither value is
// returned, logged or put into an error message.

export type YahooFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type YahooOptionsSourceOptions = Readonly<{
  fetch?: YahooFetch;
  timeoutMs?: number;
}>;

const COOKIE_URL = "https://fc.yahoo.com/";
const CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const OPTIONS_URL = "https://query2.finance.yahoo.com/v7/finance/options/";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

const optionalNumber = z.number().finite().optional().catch(undefined);

const YahooContractSchema = z.object({
  contractSymbol: z.string().min(1).max(40),
  strike: z.number().finite().positive(),
  bid: optionalNumber,
  ask: optionalNumber,
  lastPrice: optionalNumber,
  change: optionalNumber,
  volume: optionalNumber,
  openInterest: optionalNumber,
  impliedVolatility: optionalNumber,
  inTheMoney: z.boolean().optional().catch(undefined),
  lastTradeDate: optionalNumber,
});

const YahooResultSchema = z.object({
  underlyingSymbol: z.string().optional().catch(undefined),
  expirationDates: z.array(z.number().int()).catch([]),
  quote: z
    .object({
      currency: z.string().max(8).optional().catch(undefined),
      regularMarketPrice: optionalNumber,
      regularMarketTime: optionalNumber,
      trailingAnnualDividendYield: optionalNumber,
    })
    .catch({}),
  options: z
    .array(
      z.object({
        expirationDate: z.number().int(),
        calls: z.array(z.unknown()).catch([]),
        puts: z.array(z.unknown()).catch([]),
      })
    )
    .catch([]),
});

const YahooBodySchema = z.object({
  optionChain: z.object({ result: z.array(z.unknown()) }),
});

const isoDay = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

const nonNegative = (value: number | undefined): number | null =>
  value !== undefined && value >= 0 ? value : null;

const wholeCount = (value: number | undefined): number | null =>
  value !== undefined && value >= 0 ? Math.trunc(value) : null;

const contractRows = (rows: readonly unknown[]): OptionQuote[] =>
  rows.flatMap((row) => {
    const parsed = YahooContractSchema.safeParse(row);
    if (!parsed.success) return [];
    const value = parsed.data;
    // Yahoo reports placeholder IVs near zero for contracts without a usable quote.
    const iv =
      value.impliedVolatility !== undefined &&
      value.impliedVolatility >= 0.001 &&
      value.impliedVolatility <= 10
        ? value.impliedVolatility
        : null;
    return [
      {
        ask: nonNegative(value.ask),
        bid: nonNegative(value.bid),
        change: value.change ?? null,
        contractSymbol: value.contractSymbol,
        inTheMoney: value.inTheMoney ?? false,
        iv,
        last: nonNegative(value.lastPrice),
        lastTradeAt:
          value.lastTradeDate === undefined
            ? null
            : new Date(value.lastTradeDate * 1000).toISOString(),
        openInterest: wholeCount(value.openInterest),
        strike: value.strike,
        volume: wholeCount(value.volume),
      },
    ];
  });

/** Parses one Yahoo v7 options document. Unusable contracts are left out. */
export const parseYahooOptions = (
  body: unknown,
  symbol: string
): OptionsChainSnapshot => {
  const document = YahooBodySchema.safeParse(body);
  if (!document.success)
    throw new OptionsChainSourceError(
      "UPSTREAM_ERROR",
      "Yahoo options returned an unexpected document"
    );
  const first = document.data.optionChain.result[0];
  if (first === undefined)
    throw new OptionsChainSourceError(
      "NOT_FOUND",
      `Yahoo has no options data for ${symbol}`
    );
  const result = YahooResultSchema.parse(first);
  const { quote } = result;
  const listed = result.options[0];
  const spot = quote.regularMarketPrice;
  const dividend = quote.trailingAnnualDividendYield;
  return {
    calls: contractRows(listed?.calls ?? []),
    currency: quote.currency ?? null,
    dividendYield: dividend !== undefined && dividend >= 0 ? dividend : null,
    expiries: [...new Set(result.expirationDates.map(isoDay))].sort(),
    expiry: listed === undefined ? null : isoDay(listed.expirationDate),
    puts: contractRows(listed?.puts ?? []),
    quoteTime:
      quote.regularMarketTime === undefined
        ? null
        : new Date(quote.regularMarketTime * 1000).toISOString(),
    spot: spot !== undefined && spot > 0 ? spot : null,
    symbol: result.underlyingSymbol ?? symbol,
  };
};

type Session = Readonly<{ cookie: string; crumb: string }>;

// "A3=d=...; Expires=..." -> "A3=d=..."; joins every cookie the response set.
const cookieHeader = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.replace(/;.*$/su, "").trim())
    .filter((pair) => pair.includes("="))
    .join("; ");

/** Yahoo options adapter. One session (cookie + crumb) per adapter instance. */
export const createYahooOptionsSource = (
  options: YahooOptionsSourceOptions = {}
): OptionsChainSource => {
  const doFetch: YahooFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let session: Promise<Session> | null = null;

  const get = async (
    url: string,
    headers: Record<string, string>
  ): Promise<Response> => {
    try {
      return await doFetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo options request failed or timed out"
      );
    }
  };

  const readText = async (response: Response): Promise<string> =>
    await readCappedText(
      response,
      MAX_BYTES,
      (message) =>
        new OptionsChainSourceError(
          "UPSTREAM_ERROR",
          `Yahoo options: ${message}`
        )
    );

  const openSession = async (): Promise<Session> => {
    // fc.yahoo.com answers 404 but sets the session cookie.
    const cookie = cookieHeader(await get(COOKIE_URL, {}));
    if (cookie === "")
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo did not start a session"
      );
    const response = await get(CRUMB_URL, { cookie });
    const crumb =
      response.status === 200 ? (await readText(response)).trim() : "";
    if (!/^[\w./-]{1,64}$/u.test(crumb))
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo did not issue a session token"
      );
    return { cookie, crumb };
  };

  const sessionFor = (renew: boolean): Promise<Session> => {
    if (renew || session === null) {
      const next = openSession();
      // A failed session start is not cached: the next request tries again.
      next.catch(() => {
        session = null;
      });
      session = next;
    }
    return session;
  };

  const request = async (url: string, renew: boolean): Promise<Response> => {
    const current = await sessionFor(renew);
    return await get(`${url}&crumb=${encodeURIComponent(current.crumb)}`, {
      accept: "application/json",
      cookie: current.cookie,
    });
  };

  const read = async (
    symbol: string,
    expiry?: string
  ): Promise<OptionsChainSnapshot> => {
    const date =
      expiry === undefined
        ? ""
        : `&date=${Date.parse(`${expiry}T00:00:00Z`) / 1000}`;
    const url = `${OPTIONS_URL}${encodeURIComponent(symbol)}?formatted=false${date}`;
    let response = await request(url, false);
    if (response.status === 401) response = await request(url, true);
    if (response.status === 404)
      throw new OptionsChainSourceError(
        "NOT_FOUND",
        `Yahoo has no options data for ${symbol}`
      );
    if (response.status === 429 || response.status >= 500)
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        `Yahoo options returned HTTP ${response.status}`
      );
    if (response.status !== 200)
      throw new OptionsChainSourceError(
        "UPSTREAM_ERROR",
        `Yahoo options returned HTTP ${response.status}`
      );
    let body: unknown;
    try {
      body = JSON.parse(await readText(response));
    } catch (error) {
      if (error instanceof OptionsChainSourceError) throw error;
      throw new OptionsChainSourceError(
        "UPSTREAM_ERROR",
        "Yahoo options returned invalid JSON"
      );
    }
    return parseYahooOptions(body, symbol);
  };

  return Object.freeze({ read });
};
