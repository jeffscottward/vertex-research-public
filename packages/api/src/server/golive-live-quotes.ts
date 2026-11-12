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

/**
 * The live quote of each vertical, in order, or null where there is none now. Never throws. One
 * bridge run serves up to GOLIVE_QUOTES_SPREADS_PER_CALL spreads: the bridge shares the IBKR
 * client (and its lock) with the order runs, so the reader asks as few times as it can.
 */
export type GoLiveQuotesPort = (
  spreads: readonly GoLiveSpreadLegs[]
) => Promise<(GoLiveQuote | null)[]>;

type QuotesFetch = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// One bridge run spawns an IBKR client and waits up to 30 s for snapshots.
const GOLIVE_QUOTES_TIMEOUT_MS = 45_000;
// A spread quote is reused this long, so the queue the owner read and the approve that follows
// size the same order (the approve compares the order to the cent). Under the 120 s live-quote
// age limit of the sizing (GOLIVE_QUOTE_MAX_AGE_MS), so a cached quote is still live.
export const GOLIVE_QUOTES_CACHE_MS = 100_000;
// A spread with no live quote is asked again after this long (a Reload soon after a miss).
const GOLIVE_QUOTES_MISS_CACHE_MS = 10_000;
// The bridge takes at most 8 legs per request.
const GOLIVE_QUOTES_SPREADS_PER_CALL = 4;

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
  legs: z.array(BridgeLegSchema).min(2).max(8),
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

// A spread's quote, read or being read: `miss` is set once the read gave no live quote.
interface Entry {
  at: number;
  miss: boolean;
  quote: Promise<GoLiveQuote | null>;
}

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
  if (!configured) return async (spreads) => spreads.map(() => null);
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}/quotes`;
  const fetchImpl: QuotesFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, Entry>();

  const spreadQuote = (
    spread: GoLiveSpreadLegs,
    long: BridgeLeg | undefined,
    short: BridgeLeg | undefined,
    asOf: Date
  ): GoLiveQuote | null =>
    long === undefined ||
    short === undefined ||
    !usable(long, spread.long) ||
    !usable(short, spread.short)
      ? null
      : {
          asOf,
          longAsk: long.ask,
          longBid: long.bid,
          shortAsk: short.ask,
          shortBid: short.bid,
          source: "ibkr_live",
        };

  // One bridge run for up to 4 spreads (8 legs, in order: long, short of each).
  const read = async (
    spreads: readonly GoLiveSpreadLegs[]
  ): Promise<ReadonlyMap<number, GoLiveQuote>> => {
    const none = new Map<number, GoLiveQuote>();
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        body: JSON.stringify({
          legs: spreads.flatMap((spread) => [spread.long, spread.short]),
        }),
        headers: {
          "content-type": "application/json",
          "x-vertex-bridge-token": token,
        },
        method: "POST",
        signal: AbortSignal.timeout(GOLIVE_QUOTES_TIMEOUT_MS),
      });
    } catch {
      return none;
    }
    if (!response.ok) return none;
    const parsed = BridgeQuotesSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success || parsed.data.legs.length !== spreads.length * 2)
      return none;
    const asOf = new Date(parsed.data.asOf);
    if (Number.isNaN(asOf.getTime())) return none;
    const legs = parsed.data.legs;
    const quotes = new Map<number, GoLiveQuote>();
    for (const [index, spread] of spreads.entries()) {
      const quote = spreadQuote(
        spread,
        legs[index * 2],
        legs[index * 2 + 1],
        asOf
      );
      if (quote !== null) quotes.set(index, quote);
    }
    return quotes;
  };

  // A read in flight counts as fresh: a second caller waits for it instead of a new bridge run.
  const fresh = (entry: Entry | undefined, time: number): entry is Entry =>
    entry !== undefined &&
    time - entry.at <
      (entry.miss ? GOLIVE_QUOTES_MISS_CACHE_MS : GOLIVE_QUOTES_CACHE_MS);

  return async (spreads) => {
    const time = now().getTime();
    for (const [key, entry] of cache)
      if (!fresh(entry, time)) cache.delete(key);
    const pairs = spreads.map(
      (spread) => [JSON.stringify([spread.long, spread.short]), spread] as const
    );
    const missing = [
      ...new Map(pairs.filter(([key]) => !cache.has(key))).entries(),
    ];
    for (
      let start = 0;
      start < missing.length;
      start += GOLIVE_QUOTES_SPREADS_PER_CALL
    ) {
      const chunk = missing.slice(
        start,
        start + GOLIVE_QUOTES_SPREADS_PER_CALL
      );
      const run = read(chunk.map(([, spread]) => spread));
      for (const [index, [key]] of chunk.entries()) {
        const entry: Entry = {
          at: time,
          miss: false,
          quote: run.then((batch) => {
            const quote = batch.get(index) ?? null;
            entry.miss = quote === null;
            return quote;
          }),
        };
        cache.set(key, entry);
      }
    }
    return await Promise.all(
      pairs.map(([key]) => (cache.get(key) as Entry).quote)
    );
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
