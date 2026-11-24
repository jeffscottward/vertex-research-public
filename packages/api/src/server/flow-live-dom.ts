// What: server-side loader and bounded SSE streamer for flow.liveDom and flow.liveDomStream.
// Reads uncached live CME L2 + unsettled tape volume from vertex-history 1.8.0 GET /dom with zero
// Postgres queries on the live hot path, and falls back to stored flow_book_snapshots +
// flow_large_trades BEFORE returning any async generator so request-scope.ts finalizes Postgres
// immediately and zero DB connections are held while streaming.
// Used by: packages/api/src/server/flow.ts.

import type {
  FlowBookSnapshotRecord,
  FlowLargeTradeRecord,
  FlowRepository,
} from "@darkfactory/db/server";
import {
  FLOW_LIVE_DOM_HEARTBEAT_MS,
  FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE,
  FLOW_LIVE_DOM_STREAM_LEASE_MS,
  type FlowLiveDom,
  type FlowLiveDomFeed,
  type FlowLiveDomLastTrade,
  type FlowLiveDomParsedInput,
  type FlowLiveDomStreamEvent,
  type FlowLiveDomStreamParsedInput,
} from "../contracts/flow.ts";
import {
  buildFlowLiveDom,
  type LiveDomBookLevelInput,
  type LiveDomVolumeLevelInput,
} from "../flow-live-dom-rules.ts";
import type { FlowSampleRow } from "./flow-snapshot.ts";
import {
  MARKET_DOM_TIMEOUT_MS,
  MarketDataError,
  type MarketDom,
  type MarketDomFetchInput,
} from "./market-data.ts";

/** 72-hour lookback covers weekend/holiday market closures for recorded DOM fallback. */
const FLOW_LIVE_DOM_FALLBACK_LOOKBACK_MS = 72 * 3_600_000;
/** Cap on fallback large-trade rows folded into volumeByPrice so memory stays bounded. */
export const FLOW_LIVE_DOM_FALLBACK_TRADES_CAP = 5000;
const FLOW_LIVE_DOM_FALLBACK_RETRY_MS = 5000;
const FLOW_LIVE_DOM_LEASE_RECONNECT_MS = 250;
const MIN_LOOP_REMAINING_MS = 500;

export type LiveDomRepository = Pick<
  FlowRepository,
  "latestSamples" | "readBookSnapshots" | "readLargeTrades"
>;

export type FetchMarketDomFn = (
  input: MarketDomFetchInput,
  options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
) => Promise<MarketDom>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type FlowLiveDomDeps = Readonly<{
  fetchDom: FetchMarketDomFn | null;
  heartbeatMs?: number;
  leaseMs?: number;
  maxPolls?: number;
  now?: () => Date;
  repository: LiveDomRepository | null;
  sleep?: SleepFn;
}>;

/** Abort-aware sleep that clears its timer immediately on signal abort. */
export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Composite deduplication key so state, contract, or source transitions always emit a frame. */
export const liveDomFrameKey = (frame: FlowLiveDom): string =>
  `${frame.contract ?? ""}:${frame.source}:${frame.depthFeed.state}:${frame.tapeFeed.state}:${frame.depthUpdates}:${frame.tapeSeq}`;

const contractNameOf = (dom: MarketDom): string | null => {
  const local = dom.contract?.localSymbol?.trim();
  if (local !== undefined && local.length > 0 && local.length <= 20) {
    return local;
  }
  return null;
};

const buildFromMarketDom = (dom: MarketDom): FlowLiveDom =>
  buildFlowLiveDom({
    asks: dom.asks,
    bids: dom.bids,
    capturedAt: dom.fetchedAt,
    contract: contractNameOf(dom),
    depthFeed: {
      error: dom.depthStream.error,
      lastAt: dom.depthStream.lastAt,
      state: dom.depthStream.state,
    },
    depthUpdates: dom.depthUpdates,
    lastTrade:
      dom.lastTrade === null
        ? null
        : {
            price: dom.lastTrade.price,
            side: dom.lastTrade.side,
            size: dom.lastTrade.size,
            t: new Date(dom.lastTrade.t * 1000).toISOString(),
          },
    minTick: dom.minTick,
    seq: dom.seq,
    since: dom.since,
    source: "live_stream",
    symbol: dom.symbol,
    tapeFeed: {
      error: dom.tapeStream.error,
      lastAt: dom.tapeStream.lastAt,
      state: dom.tapeStream.state,
    },
    tapeSeq: dom.tapeSeq,
    volumeByPrice: dom.volumeByPrice,
    volumeSource: dom.volumeByPrice.length > 0 ? "streamed_tape" : "none",
    windowSeconds: dom.windowSeconds,
  });

const pairsFromArrays = (
  prices: readonly number[],
  sizes: readonly number[],
  rows: number
): LiveDomBookLevelInput[] => {
  const out: LiveDomBookLevelInput[] = [];
  for (const [index, price] of prices.entries()) {
    if (index >= rows) break;
    const size = sizes[index];
    if (size === undefined) break;
    out.push([price, size]);
  }
  return out;
};

const largeTradesToVolume = (
  trades: readonly FlowLargeTradeRecord[]
): Readonly<{
  lastTrade: FlowLiveDomLastTrade | null;
  volumeByPrice: LiveDomVolumeLevelInput[];
}> => {
  const capped =
    trades.length > FLOW_LIVE_DOM_FALLBACK_TRADES_CAP
      ? trades.slice(trades.length - FLOW_LIVE_DOM_FALLBACK_TRADES_CAP)
      : trades;
  const byPrice = new Map<
    number,
    { buy: number; price: number; sell: number; trades: number }
  >();
  let last: FlowLargeTradeRecord | null = null;
  for (const trade of capped) {
    if (
      last === null ||
      trade.second.getTime() > last.second.getTime() ||
      (trade.second.getTime() === last.second.getTime() && trade.seq > last.seq)
    ) {
      last = trade;
    }
    const key = Math.round(trade.price * 1_000_000) / 1_000_000;
    const entry = byPrice.get(key) ?? {
      buy: 0,
      price: trade.price,
      sell: 0,
      trades: 0,
    };
    if (trade.side === "buy") entry.buy += trade.size;
    else entry.sell += trade.size;
    entry.trades += 1;
    byPrice.set(key, entry);
  }
  const volumeByPrice: LiveDomVolumeLevelInput[] = [...byPrice.values()].map(
    (entry) => [entry.price, entry.buy, entry.sell, 0, entry.trades]
  );
  const lastTrade: FlowLiveDomLastTrade | null =
    last === null
      ? null
      : {
          price: last.price,
          side: last.side,
          size: last.size,
          t: last.second.toISOString(),
        };
  return { lastTrade, volumeByPrice };
};

const sampleFeedHealth = (
  latestOk: readonly FlowSampleRow[],
  source: "depth" | "ticks",
  overrideError: string | null
): FlowLiveDomFeed => {
  const okRow = latestOk.find((row) => row.source === source);
  return {
    error: overrideError,
    lastAt: okRow === undefined ? null : okRow.at.toISOString(),
    state: okRow === undefined ? "never" : "recorded",
  };
};

const describeLiveFailure = (error: unknown): string => {
  if (error instanceof MarketDataError) {
    if (error.code === "NOT_FOUND") {
      return "History service /dom endpoint not deployed yet (HTTP 404)";
    }
    return error.message.slice(0, 200);
  }
  return "Live history service request failed";
};

const toDomFetchInput = (
  input: FlowLiveDomParsedInput
): MarketDomFetchInput => ({
  rows: input.rows,
  ...(input.since === undefined ? {} : { since: input.since }),
  symbol: input.symbol,
  windowSeconds: input.windowSeconds,
});

const hasLiveBook = (dom: MarketDom): boolean =>
  dom.depthStream.state === "live" &&
  (dom.bids.length > 0 || dom.asks.length > 0);

const readRecordedFallback = async (
  repository: LiveDomRepository | null,
  input: FlowLiveDomParsedInput,
  now: Date,
  liveDom: MarketDom | null,
  liveReason: string
): Promise<FlowLiveDom> => {
  let snapshot: FlowBookSnapshotRecord | null = null;
  let largeTrades: readonly FlowLargeTradeRecord[] = [];
  let latestOk: readonly FlowSampleRow[] = [];

  if (repository !== null) {
    const [snapshots, samples] = await Promise.all([
      repository.readBookSnapshots({
        from: new Date(now.getTime() - FLOW_LIVE_DOM_FALLBACK_LOOKBACK_MS),
        limit: 1,
        symbol: input.symbol,
        to: now,
      }),
      repository.latestSamples(input.symbol, ["depth", "ticks"]),
    ]);
    snapshot = snapshots[0] ?? null;
    latestOk = samples.latestOk;
    const anchorMs =
      snapshot === null ? now.getTime() : snapshot.capturedAt.getTime();
    const baseFromMs = anchorMs - input.windowSeconds * 1000;
    const fromMs =
      input.since === undefined
        ? baseFromMs
        : Math.max(baseFromMs, input.since * 1000);
    if (fromMs <= anchorMs) {
      largeTrades = await repository.readLargeTrades({
        from: new Date(fromMs),
        symbol: input.symbol,
        to: new Date(anchorMs + 1),
      });
    }
  }

  const tradesAgg = largeTradesToVolume(largeTrades);
  const bids =
    snapshot === null
      ? []
      : pairsFromArrays(snapshot.bidPrices, snapshot.bidSizes, input.rows);
  const asks =
    snapshot === null
      ? []
      : pairsFromArrays(snapshot.askPrices, snapshot.askSizes, input.rows);

  const depthFeed: FlowLiveDomFeed =
    liveDom === null
      ? sampleFeedHealth(latestOk, "depth", liveReason)
      : {
          error: liveDom.depthStream.error ?? liveReason,
          lastAt:
            liveDom.depthStream.lastAt ??
            (snapshot === null ? null : snapshot.capturedAt.toISOString()),
          state: liveDom.depthStream.state,
        };

  const tapeFeed: FlowLiveDomFeed =
    liveDom === null
      ? sampleFeedHealth(latestOk, "ticks", null)
      : {
          error: liveDom.tapeStream.error,
          lastAt: liveDom.tapeStream.lastAt,
          state: liveDom.tapeStream.state,
        };

  const hasSnapshot = snapshot !== null && (bids.length > 0 || asks.length > 0);
  const useLiveTape =
    liveDom !== null &&
    liveDom.volumeByPrice.length > 0 &&
    (snapshot === null ||
      contractNameOf(liveDom) === null ||
      contractNameOf(liveDom) === snapshot.contract);

  const volumeByPrice = useLiveTape
    ? liveDom.volumeByPrice
    : tradesAgg.volumeByPrice;
  const lastTrade: FlowLiveDomLastTrade | null = useLiveTape
    ? liveDom.lastTrade === null
      ? null
      : {
          price: liveDom.lastTrade.price,
          side: liveDom.lastTrade.side,
          size: liveDom.lastTrade.size,
          t: new Date(liveDom.lastTrade.t * 1000).toISOString(),
        }
    : tradesAgg.lastTrade;
  const volumeSource = useLiveTape
    ? "streamed_tape"
    : volumeByPrice.length > 0
      ? "large_trades_only"
      : "none";

  return buildFlowLiveDom({
    asks,
    bids,
    capturedAt:
      snapshot === null ? now.toISOString() : snapshot.capturedAt.toISOString(),
    contract:
      snapshot?.contract ?? (liveDom === null ? null : contractNameOf(liveDom)),
    depthFeed,
    depthUpdates: liveDom?.depthUpdates ?? 0,
    lastTrade,
    minTick: snapshot?.minTick ?? liveDom?.minTick ?? null,
    seq: liveDom?.seq ?? 0,
    since: input.since ?? null,
    source: hasSnapshot ? "recorded_fallback" : "empty",
    symbol: input.symbol,
    tapeFeed,
    tapeSeq: liveDom?.tapeSeq ?? 0,
    volumeByPrice,
    volumeSource,
    windowSeconds: input.windowSeconds,
  });
};

/**
 * Reads one FlowLiveDom snapshot: live vertex-history /dom first (zero DB queries when live),
 * falling back cleanly to recorded Postgres flow_book_snapshots + flow_large_trades.
 */
export const readFlowLiveDomSnapshot = async (
  deps: FlowLiveDomDeps,
  input: FlowLiveDomParsedInput,
  signal?: AbortSignal
): Promise<FlowLiveDom> => {
  const now = (deps.now ?? (() => new Date()))();
  let liveDom: MarketDom | null = null;
  let liveReason =
    "History service URL not configured on this server (VERTEX_HISTORY_URL)";

  if (deps.fetchDom !== null) {
    try {
      const dom = await deps.fetchDom(toDomFetchInput(input), {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: MARKET_DOM_TIMEOUT_MS,
      });
      if (hasLiveBook(dom)) return buildFromMarketDom(dom);
      liveDom = dom;
      liveReason =
        dom.depthStream.error ??
        (dom.depthStream.state === "live"
          ? "Live CME depth stream returned an empty book"
          : `Live CME depth stream state is ${dom.depthStream.state}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      liveReason = describeLiveFailure(error);
    }
  }

  return readRecordedFallback(deps.repository, input, now, liveDom, liveReason);
};

/**
 * Opens a bounded SSE stream for flow.liveDomStream.
 * Intentionally a regular async function (NOT a top-level async function*) so the initial read
 * (including any Postgres fallback) completes BEFORE the generator is returned and request-scope.ts
 * finalizes Postgres immediately. The inner generator holds no repository reference.
 */
export const openFlowLiveDomStream = async (
  deps: FlowLiveDomDeps,
  input: FlowLiveDomStreamParsedInput,
  signal?: AbortSignal
): Promise<AsyncGenerator<FlowLiveDomStreamEvent, void, undefined>> => {
  const nowFn = deps.now ?? (() => new Date());
  const sleepFn = deps.sleep ?? abortableSleep;
  const leaseMs = deps.leaseMs ?? FLOW_LIVE_DOM_STREAM_LEASE_MS;
  const maxPolls = deps.maxPolls ?? FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE;
  const heartbeatMs = deps.heartbeatMs ?? FLOW_LIVE_DOM_HEARTBEAT_MS;
  const fetchDom = deps.fetchDom;

  const initialFrame = await readFlowLiveDomSnapshot(deps, input, signal);
  const fetchInput = toDomFetchInput(input);
  const leaseEndsAt = nowFn().getTime() + leaseMs;

  const run = async function* (): AsyncGenerator<
    FlowLiveDomStreamEvent,
    void,
    undefined
  > {
    yield { frame: initialFrame, type: "frame" };

    if (initialFrame.source !== "live_stream" || fetchDom === null) {
      yield {
        at: nowFn().toISOString(),
        reason: "recorded_fallback",
        retryAfterMs: FLOW_LIVE_DOM_FALLBACK_RETRY_MS,
        type: "reconnect",
      };
      return;
    }

    let lastKey = liveDomFrameKey(initialFrame);
    let lastSeq = initialFrame.seq;
    let lastEmitMs = nowFn().getTime();
    let polls = 0;

    while (
      !signal?.aborted &&
      polls < maxPolls &&
      leaseEndsAt - nowFn().getTime() >= MIN_LOOP_REMAINING_MS
    ) {
      const sleepMs = Math.min(
        input.cadenceMs,
        Math.max(0, leaseEndsAt - nowFn().getTime())
      );
      await sleepFn(sleepMs, signal);
      if (signal?.aborted) return;

      const remainingMs = leaseEndsAt - nowFn().getTime();
      if (remainingMs < MIN_LOOP_REMAINING_MS) break;

      polls += 1;
      let dom: MarketDom;
      try {
        dom = await fetchDom(fetchInput, {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.min(
            MARKET_DOM_TIMEOUT_MS,
            Math.max(MIN_LOOP_REMAINING_MS, remainingMs)
          ),
        });
      } catch {
        if (signal?.aborted) return;
        yield {
          at: nowFn().toISOString(),
          reason: "upstream_interrupted",
          retryAfterMs: FLOW_LIVE_DOM_FALLBACK_RETRY_MS,
          type: "reconnect",
        };
        return;
      }

      if (!hasLiveBook(dom)) {
        yield {
          at: nowFn().toISOString(),
          reason: "upstream_interrupted",
          retryAfterMs: FLOW_LIVE_DOM_FALLBACK_RETRY_MS,
          type: "reconnect",
        };
        return;
      }

      const nextFrame = buildFromMarketDom(dom);
      const nextKey = liveDomFrameKey(nextFrame);
      const currentMs = nowFn().getTime();
      if (nextKey !== lastKey) {
        lastKey = nextKey;
        lastSeq = nextFrame.seq;
        lastEmitMs = currentMs;
        yield { frame: nextFrame, type: "frame" };
      } else if (currentMs - lastEmitMs >= heartbeatMs) {
        lastEmitMs = currentMs;
        yield {
          at: new Date(currentMs).toISOString(),
          seq: lastSeq,
          type: "heartbeat",
        };
      }
    }

    if (!signal?.aborted) {
      yield {
        at: nowFn().toISOString(),
        reason: "lease_expired",
        retryAfterMs: FLOW_LIVE_DOM_LEASE_RECONNECT_MS,
        type: "reconnect",
      };
    }
  };

  return run();
};
