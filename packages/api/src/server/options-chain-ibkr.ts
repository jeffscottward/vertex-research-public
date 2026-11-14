// IBKR adapter of the options chain (OptionsQuoteSource): live bid and ask of the strikes nearest
// the money, the live underlying price and the expiry list, from the vertex-history endpoint
// GET /option-chain (schema vertex-history-option-chain-v1, service 1.4.0). Same transport as the
// bars client (fetchHistoryDocument: bearer, GET, timeout, 2 MiB cap, no redirects). The body is
// parsed with Zod and only live values leave this file. IBKR is asked only while the US regular
// session is open: outside it a snapshot wave waits about 11 s and returns nothing live.
// Messages are fixed texts: no URL, no token and nothing from the upstream body.
// Read-only market data; nothing here touches orders, arming or the live engine.

import { z } from "zod";

import {
  isNyseHoliday,
  parseDay,
  weekday,
} from "../options-engine/calendar.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import {
  type FetchMarketBarsOptions,
  fetchHistoryDocument,
  MarketDataError,
  type MarketDataErrorCode,
} from "./market-data.ts";
import {
  historyDate,
  historyInstrument,
  sessionOpen,
  sessionRunning,
} from "./merged-bars.ts";
import {
  OptionsChainSourceError,
  type OptionsChainSourceErrorCode,
  OptionsChainSourceOff,
  type OptionsQuoteSource,
} from "./options-chain-source.ts";

// The service answers one /option-chain request within 14 s.
const TIMEOUT_MS = 15_000;
// The service quotes at most 12 strikes (a call and a put each) nearest the underlying price.
const STRIKES = 12;
const STALE_WARNING = "IBKR sent an old copy, not live quotes";

const finite = z.number().finite();
// IBKR's YYYYMMDD, as the YYYY-MM-DD the API package uses. Refuses days that do not exist.
const ibkrDate = z
  .string()
  .regex(/^\d{8}$/u)
  .transform(
    (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
  )
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
    );
  });
// What IB reported for the request: live, frozen, delayed, delayed-frozen or null.
const dataType = z.string().max(32).nullable();

// Only the fields this adapter uses; the service sends more (request, tradingClass, last, ...).
const OptionChainUpstreamSchema = z
  .object({
    cache: z.object({ stale: z.boolean() }),
    count: z.number().int().nonnegative(),
    // A sanity bound only: the merge cuts the list to the chain contract's limit.
    expirations: z.array(ibkrDate).max(2000),
    expiry: ibkrDate,
    fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
    quotes: z
      .array(
        z.object({
          ask: finite.nullable(),
          bid: finite.nullable(),
          dataType,
          error: z.string().max(64).nullable(),
          right: z.enum(["C", "P"]),
          strike: finite.positive(),
        })
      )
      .max(64),
    schema: z.literal("vertex-history-option-chain-v1"),
    underlying: z.object({ dataType, price: finite.nullable() }),
  })
  .refine((document) => document.count === document.quotes.length, {
    message: "count mismatch",
  });

type Failure = readonly [OptionsChainSourceErrorCode | "off", string];

// MarketDataError code -> the chain's error code (or "off") and a fixed message.
const FAILURES: Readonly<Record<MarketDataErrorCode, Failure>> = {
  BAD_REQUEST: ["UPSTREAM_ERROR", "IBKR option quotes request was refused"],
  ENTITLEMENT: ["UNAVAILABLE", "IBKR market data permissions are missing"],
  NOT_CONFIGURED: ["off", "IBKR history service is not configured"],
  NOT_FOUND: ["NOT_FOUND", "IBKR lists no options for this symbol and expiry"],
  PACED: ["UNAVAILABLE", "IBKR option quotes are busy; retry later"],
  UNAVAILABLE: [
    "UNAVAILABLE",
    "IBKR option quotes request failed or timed out",
  ],
  UPSTREAM_ERROR: ["UPSTREAM_ERROR", "IBKR option quotes request failed"],
};
// HTTP statuses with their own meaning here. 403: the service's option quotes switch is off.
// 404: unknown symbol or expiry, or a service before 1.4.0. The status is read from the response
// itself: the transport's error message can repeat upstream body text, so it is never parsed.
const HTTP_FAILURES: ReadonlyMap<number | null, Failure> = new Map([
  [403, ["off", "IBKR option quotes are switched off on the history service"]],
  [404, FAILURES.NOT_FOUND],
]);

const failure = (error: unknown, status: number | null): Error => {
  const [code, message] =
    error instanceof MarketDataError
      ? (HTTP_FAILURES.get(status) ?? FAILURES[error.code])
      : FAILURES.UNAVAILABLE;
  return code === "off"
    ? new OptionsChainSourceOff(message)
    : new OptionsChainSourceError(code, message);
};

/** True while the US regular session (09:30 to 16:00 New York, NYSE trading days) is open. */
const usRegularSessionOpen = (now: Date): boolean => {
  const open = sessionOpen(now);
  // 09:30 New York falls on the same calendar day in UTC.
  const day = historyDate(open.getTime() / 1000);
  const dayNumber = parseDay(day);
  return (
    now.getTime() >= open.getTime() &&
    sessionRunning(day, now) &&
    weekday(dayNumber) < 5 &&
    !isNyseHoliday(dayNumber)
  );
};

/**
 * IBKR live option quotes. `config` is the vertex-history endpoint (ApiContext.marketHistory);
 * `options.now` is the request clock. Not asked (OptionsChainSourceOff, no request sent) when the
 * endpoint is not configured, for symbols that are not plain US stock tickers and outside the US
 * regular session.
 */
export const createIbkrOptionsQuoteSource = (
  config: DeployStatusConfig | null,
  options: FetchMarketBarsOptions & Readonly<{ now: () => Date }>
): OptionsQuoteSource => ({
  read: async (symbol, expiry) => {
    if (config === null)
      throw new OptionsChainSourceOff(FAILURES.NOT_CONFIGURED[1]);
    if (historyInstrument(symbol)?.secType !== "STK")
      throw new OptionsChainSourceOff(
        "IBKR option quotes cover plain US stock tickers only"
      );
    if (!usRegularSessionOpen(options.now()))
      throw new OptionsChainSourceOff(
        "IBKR is asked only during the US regular session (09:30 to 16:00 New York)"
      );
    const params = new URLSearchParams({
      strikes: String(STRIKES),
      symbol: symbol.toUpperCase(),
    });
    if (expiry !== undefined) params.set("expiry", expiry.replaceAll("-", ""));
    const doFetch =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    let status: number | null = null;
    const raw = await fetchHistoryDocument(
      config,
      (base) =>
        `${base.replace(/\/+$/u, "")}/option-chain?${params.toString()}`,
      TIMEOUT_MS,
      {
        ...options,
        fetch: async (url, init) => {
          const response = await doFetch(url, init);
          status = response.status;
          return response;
        },
      }
    ).catch((error: unknown) => {
      throw failure(error, status);
    });
    const parsed = OptionChainUpstreamSchema.safeParse(raw);
    if (!parsed.success)
      throw new OptionsChainSourceError(
        "UPSTREAM_ERROR",
        "IBKR option quotes failed schema validation"
      );
    const document = parsed.data;
    // A stale copy (the service's answer when IB fails) holds old prices: nothing in it is live.
    const stale = document.cache.stale;
    const { price } = document.underlying;
    return {
      asOf: document.fetchedAt,
      expiries: [...new Set(document.expirations)].sort(),
      expiry: document.expiry,
      quotes: stale
        ? []
        : document.quotes.flatMap((quote) =>
            quote.dataType === "live" &&
            quote.error === null &&
            quote.bid !== null &&
            quote.ask !== null &&
            quote.bid >= 0 &&
            quote.ask > 0 &&
            quote.ask >= quote.bid
              ? [
                  {
                    ask: quote.ask,
                    bid: quote.bid,
                    right: quote.right === "C" ? "call" : "put",
                    strike: quote.strike,
                  } as const,
                ]
              : []
          ),
      spot:
        !stale &&
        document.underlying.dataType === "live" &&
        price !== null &&
        price > 0
          ? price
          : null,
      warning: stale ? STALE_WARNING : null,
    };
  },
});
