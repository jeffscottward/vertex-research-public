// What: the read-only Vertex API calls the shell makes from the main process: the signed-in user's
// watchlist, a daily quote per symbol (marketData.bars, the same request the watchlist page makes,
// so the server's bars cache is shared) and recent signal alert fires. Every call is an oRPC GET
// (all three procedures are GET routes), sent through the window session so it carries the
// user's cookie. Research only; nothing here can place or change an order. This is the HTTP
// adapter behind the DesktopApi port (the only @orpc/client import); electron-ports.ts supplies
// the session fetch.
// Used by: tray-watchlist.ts, alert-notifier.ts (through the DesktopApi port) and app.ts.
import type { MarketBarsInput } from "@darkfactory/api";
import type { ApiClient } from "@darkfactory/api/client";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

export type WatchlistEntry = Readonly<{
  symbol: string;
  buyZoneLow: string | null;
  buyZoneHigh: string | null;
}>;

export type DailyQuote = Readonly<{
  last: number;
  previousClose: number | null;
}>;

export type AlertFire = Readonly<{ id: string; firedAt: Date }>;

export interface DesktopApi {
  readonly alertFires: (since: Date) => Promise<readonly AlertFire[]>;
  /** Last daily close and the one before it; null when the service has no bars. */
  readonly dailyQuote: (symbol: string) => Promise<DailyQuote | null>;
  readonly watchlist: () => Promise<readonly WatchlistEntry[]>;
}

export type DesktopApiFailure = "signed-out" | "unavailable";

export class DesktopApiError extends Error {
  readonly failure: DesktopApiFailure;
  constructor(failure: DesktopApiFailure) {
    super(failure === "signed-out" ? "Not signed in" : "Vertex is unavailable");
    this.name = "DesktopApiError";
    this.failure = failure;
  }
}

const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    const signedOut =
      error instanceof ORPCError &&
      (error.code === "UNAUTHORIZED" || error.status === 401);
    throw new DesktopApiError(signedOut ? "signed-out" : "unavailable");
  }
};

/** One year of regular-hours daily trade bars for a US stock (BF-B is sent as BF.B). */
export const dailyBarsInput = (symbol: string): MarketBarsInput => ({
  barSize: "1 day",
  currency: "USD",
  duration: "1 Y",
  exchange: "SMART",
  secType: "STK",
  symbol: symbol.replaceAll("-", "."),
  useRTH: true,
  whatToShow: "TRADES",
});

export const createDesktopApi = (
  options: Readonly<{
    siteOrigin: string;
    fetch: (request: Request) => Promise<Response>;
  }>
): DesktopApi => {
  const client: ApiClient = createORPCClient(
    new RPCLink({
      fetch: (request) => options.fetch(request),
      method: () => "GET",
      url: new URL("/api/orpc", options.siteOrigin),
    })
  );
  return {
    alertFires: (since) =>
      guarded(async () =>
        (await client.priceAlerts.signals.events({ since })).events.map(
          (event) => ({ firedAt: event.firedAt, id: event.id })
        )
      ),
    dailyQuote: (symbol) =>
      guarded(async () => {
        const { bars } = await client.marketData.bars(dailyBarsInput(symbol));
        const last = bars.at(-1);
        if (last === undefined) return null;
        return { last: last.c, previousClose: bars.at(-2)?.c ?? null };
      }),
    watchlist: () =>
      guarded(async () =>
        (await client.watchlist.list({})).items.map((item) => ({
          buyZoneHigh: item.buyZoneHigh,
          buyZoneLow: item.buyZoneLow,
          symbol: item.symbol,
        }))
      ),
  };
};
