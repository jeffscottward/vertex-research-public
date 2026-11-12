import { z } from "zod";

import type { GoLiveQuote } from "../contracts/golive-drafts.ts";

// Live IBKR option quotes for the go-live drafts (GO-LIVE 4 step 1, owner 2026-11-12).
// READ-ONLY: the reader asks the loopback bridge POST /quotes (market-watch-bot, card
// vertex-bridge-quotes) for bid and ask of the two legs of a vertical. The bridge reports the
// market data type IBKR sent back; a spread quote is labelled ibkr_live only when BOTH legs were
// reported "live" with a bid and an ask. Anything else (delayed, frozen, missing tick, no answer)
// is no quote: the draft then keeps its stored delayed quote and stays not approvable.

export type GoLiveQuoteLeg = Readonly<{
  expiry: string; // YYYYMMDD
  right: "C" | "P";
  strike: number;
  symbol: string;
}>;

export type GoLiveSpreadLegs = Readonly<{
  long: GoLiveQuoteLeg;
  short: GoLiveQuoteLeg;
}>;

/** The live quote of one vertical, or null when there is none now. Never throws. */
export type GoLiveQuotesPort = (
  spread: GoLiveSpreadLegs
) => Promise<GoLiveQuote | null>;

type QuotesFetch = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// One bridge run spawns an IBKR client and waits up to 30 s for snapshots.
const GOLIVE_QUOTES_TIMEOUT_MS = 45_000;
// A spread quote is reused this long, so the queue the owner read and the approve that follows
// size the same order (the approve compares the order to the cent). Under the 120 s live-quote
// age limit of the sizing (GOLIVE_QUOTE_MAX_AGE_MS).
export const GOLIVE_QUOTES_CACHE_MS = 60_000;

const BridgeLegSchema = z.object({
  ask: z.number().finite().nullable(),
  bid: z.number().finite().nullable(),
  dataType: z.string().max(24),
  expiry: z.string().max(12),
  right: z.string().max(2),
  strike: z.number().finite(),
});

const BridgeQuotesSchema = z.object({
  asOf: z.string().max(40),
  legs: z.array(BridgeLegSchema).length(2),
  state: z.literal("complete"),
});

type BridgeLeg = z.infer<typeof BridgeLegSchema>;

const usable = (
  leg: BridgeLeg,
  want: GoLiveQuoteLeg
): leg is BridgeLeg & { ask: number; bid: number } =>
  leg.dataType === "live" &&
  leg.expiry === want.expiry &&
  leg.right === want.right &&
  leg.strike === want.strike &&
  leg.bid !== null &&
  leg.ask !== null &&
  leg.bid > 0 &&
  leg.ask >= leg.bid;

/**
 * The bridge reader. base: loopback http URL; token: the bridge token (>= 32 chars). Missing or
 * invalid configuration gives a reader that always answers null (no live quote), never an error.
 */
export const createBridgeQuotesReader = (
  base: string | null,
  token: string | null,
  options: Readonly<{ fetch?: QuotesFetch; now?: () => Date }> = {}
): GoLiveQuotesPort => {
  const url = base === null ? null : URL.parse(base);
  const configured =
    url !== null &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    token !== null &&
    token.length >= 32;
  if (!configured) return async () => null;
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}/quotes`;
  const fetchImpl: QuotesFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, { at: number; quote: GoLiveQuote | null }>();

  const read = async (
    spread: GoLiveSpreadLegs
  ): Promise<GoLiveQuote | null> => {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        body: JSON.stringify({ legs: [spread.long, spread.short] }),
        headers: {
          "content-type": "application/json",
          "x-vertex-bridge-token": token,
        },
        method: "POST",
        signal: AbortSignal.timeout(GOLIVE_QUOTES_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const parsed = BridgeQuotesSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) return null;
    const [long, short] = parsed.data.legs;
    if (
      long === undefined ||
      short === undefined ||
      !usable(long, spread.long) ||
      !usable(short, spread.short)
    )
      return null;
    const asOf = new Date(parsed.data.asOf);
    if (Number.isNaN(asOf.getTime())) return null;
    return {
      asOf,
      longAsk: long.ask,
      longBid: long.bid,
      shortAsk: short.ask,
      shortBid: short.bid,
      source: "ibkr_live",
    };
  };

  return async (spread) => {
    const key = JSON.stringify([spread.long, spread.short]);
    const time = now().getTime();
    const hit = cache.get(key);
    if (hit !== undefined && time - hit.at < GOLIVE_QUOTES_CACHE_MS)
      return hit.quote;
    const quote = await read(spread);
    for (const [k, v] of cache)
      if (time - v.at >= GOLIVE_QUOTES_CACHE_MS) cache.delete(k);
    cache.set(key, { at: time, quote });
    return quote;
  };
};

// One reader (and its cache) per bridge configuration for the life of the server process.
const readers = new Map<string, GoLiveQuotesPort>();
export const bridgeQuotesReaderFor = (
  base: string | null,
  token: string | null
): GoLiveQuotesPort => {
  const key = JSON.stringify([base, token]);
  let reader = readers.get(key);
  if (reader === undefined) {
    reader = createBridgeQuotesReader(base, token);
    readers.set(key, reader);
  }
  return reader;
};
