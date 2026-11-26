// What: pure assembly of flow-live-dom.v1 (Jigsaw-style Live DOM ladder for ES and NQ).
// Maps resting CME L2 bids/asks and per-price traded volume onto a contiguous 1-tick ladder
// centered on the inside market, computing outward cumulative depth, book state, POC, and 3x
// aggressive imbalances. Research only: describes the book and tape, never a trade signal.
// Used by: packages/api/src/server/flow-live-dom.ts and apps/web/src/lab/fixtures/flow.ts.

import {
  FLOW_LIVE_DOM_HEARTBEAT_MS,
  FLOW_LIVE_DOM_MAX_LEVELS,
  FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE,
  FLOW_LIVE_DOM_RULES_VERSION,
  FLOW_LIVE_DOM_STREAM_LEASE_MS,
  FLOW_LIVE_DOM_VERSION,
  type FlowLiveDom,
  type FlowLiveDomBookState,
  type FlowLiveDomFeed,
  type FlowLiveDomImbalanceSide,
  type FlowLiveDomLastTrade,
  type FlowLiveDomRow,
  type FlowLiveDomRules,
  type FlowLiveDomSource,
  type FlowLiveDomVolumeSource,
  type FlowTapeSymbol,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

export const FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS = 15;
export const FLOW_LIVE_DOM_IMBALANCE_RATIO = 3;

export const FLOW_LIVE_DOM_RULES: FlowLiveDomRules = Object.freeze({
  heartbeatMs: FLOW_LIVE_DOM_HEARTBEAT_MS,
  imbalanceMinContracts: FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS,
  imbalanceRatio: FLOW_LIVE_DOM_IMBALANCE_RATIO,
  maxLevels: FLOW_LIVE_DOM_MAX_LEVELS,
  maxPollsPerLease: FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE,
  streamLeaseMs: FLOW_LIVE_DOM_STREAM_LEASE_MS,
  version: FLOW_LIVE_DOM_RULES_VERSION,
});

export type LiveDomBookLevelInput = readonly [price: number, size: number];

export type LiveDomVolumeLevelInput = readonly [
  price: number,
  buyVolume: number,
  sellVolume: number,
  unsignedVolume: number,
  trades: number,
];

export type BuildFlowLiveDomInput = Readonly<{
  asks: readonly LiveDomBookLevelInput[];
  bids: readonly LiveDomBookLevelInput[];
  capturedAt: string;
  contract: string | null;
  depthFeed: FlowLiveDomFeed;
  depthUpdates: number;
  lastTrade: FlowLiveDomLastTrade | null;
  minTick: number | null;
  seq: number;
  since: number | null;
  source: FlowLiveDomSource;
  symbol: FlowTapeSymbol;
  tapeFeed: FlowLiveDomFeed;
  tapeSeq: number;
  volumeByPrice: readonly LiveDomVolumeLevelInput[];
  volumeSource: FlowLiveDomVolumeSource;
  windowSeconds: number;
}>;

interface VolumeBucket {
  buy: number;
  sell: number;
  trades: number;
  unsigned: number;
}

const roundPrice = (value: number): number =>
  Math.round(value * 1_000_000) / 1_000_000;

export const canonicalDomTickIndex = (price: number, minTick: number): number =>
  Math.round(price / minTick);

export const canonicalDomPrice = (tickIndex: number, minTick: number): number =>
  roundPrice(tickIndex * minTick);

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const isNonNegativeFinite = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const classifyImbalance = (
  tradedBuy: number,
  tradedSell: number
): FlowLiveDomImbalanceSide | null => {
  if (
    tradedBuy >= FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS &&
    tradedBuy >= FLOW_LIVE_DOM_IMBALANCE_RATIO * tradedSell
  ) {
    return "buy";
  }
  if (
    tradedSell >= FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS &&
    tradedSell >= FLOW_LIVE_DOM_IMBALANCE_RATIO * tradedBuy
  ) {
    return "sell";
  }
  return null;
};

const aggregateSide = (
  levels: readonly LiveDomBookLevelInput[],
  minTick: number
): Map<number, number> => {
  const byTick = new Map<number, number>();
  for (const [price, size] of levels) {
    if (!(isPositiveFinite(price) && isPositiveFinite(size))) continue;
    const tick = canonicalDomTickIndex(price, minTick);
    if (tick <= 0) continue;
    byTick.set(tick, (byTick.get(tick) ?? 0) + size);
  }
  return byTick;
};

const aggregateVolumes = (
  levels: readonly LiveDomVolumeLevelInput[],
  minTick: number
): Map<number, VolumeBucket> => {
  const byTick = new Map<number, VolumeBucket>();
  for (const [price, buy, sell, unsigned, trades] of levels) {
    if (
      !(
        isPositiveFinite(price) &&
        isNonNegativeFinite(buy) &&
        isNonNegativeFinite(sell) &&
        isNonNegativeFinite(unsigned) &&
        isNonNegativeFinite(trades)
      )
    ) {
      continue;
    }
    const tick = canonicalDomTickIndex(price, minTick);
    if (tick <= 0) continue;
    const existing = byTick.get(tick);
    if (existing === undefined) {
      byTick.set(tick, { buy, sell, trades: Math.round(trades), unsigned });
    } else {
      existing.buy += buy;
      existing.sell += sell;
      existing.unsigned += unsigned;
      existing.trades += Math.round(trades);
    }
  }
  return byTick;
};

const classifyBookState = (
  bestBidTick: number | null,
  bestAskTick: number | null
): FlowLiveDomBookState => {
  if (bestBidTick === null && bestAskTick === null) return "empty";
  if (bestBidTick === null || bestAskTick === null) return "one_sided";
  if (bestBidTick === bestAskTick) return "locked";
  if (bestBidTick > bestAskTick) return "crossed";
  return "normal";
};

const findPoc = (
  volumes: ReadonlyMap<number, VolumeBucket>,
  anchorTick: number
): Readonly<{ tick: number | null; volume: number }> => {
  let pocTick: number | null = null;
  let pocVolume = 0;
  for (const [tick, bucket] of volumes) {
    const total = bucket.buy + bucket.sell + bucket.unsigned;
    if (total <= 0) continue;
    if (pocTick === null || total > pocVolume) {
      pocTick = tick;
      pocVolume = total;
      continue;
    }
    if (total === pocVolume) {
      const distNew = Math.abs(tick - anchorTick);
      const distOld = Math.abs(pocTick - anchorTick);
      if (distNew < distOld || (distNew === distOld && tick > pocTick)) {
        pocTick = tick;
      }
    }
  }
  return { tick: pocTick, volume: pocVolume };
};

const computeCumulatives = (
  byTick: ReadonlyMap<number, number>,
  descending: boolean
): Map<number, number> => {
  const entries = [...byTick.entries()].sort(([a], [b]) =>
    descending ? b - a : a - b
  );
  const out = new Map<number, number>();
  let running = 0;
  for (const [tick, size] of entries) {
    running += size;
    out.set(tick, running);
  }
  return out;
};

const pickTickBounds = (
  allTicks: readonly number[],
  anchorTick: number
): Readonly<{ lowTick: number; highTick: number }> => {
  let minTickIdx = Number.POSITIVE_INFINITY;
  let maxTickIdx = Number.NEGATIVE_INFINITY;
  for (const tick of allTicks) {
    if (tick < minTickIdx) minTickIdx = tick;
    if (tick > maxTickIdx) maxTickIdx = tick;
  }
  const span = maxTickIdx - minTickIdx + 1;
  if (span <= FLOW_LIVE_DOM_MAX_LEVELS) {
    return { highTick: maxTickIdx, lowTick: minTickIdx };
  }
  const halfDown = Math.floor((FLOW_LIVE_DOM_MAX_LEVELS - 1) / 2);
  const halfUp = FLOW_LIVE_DOM_MAX_LEVELS - 1 - halfDown;
  let lowTick = anchorTick - halfDown;
  let highTick = anchorTick + halfUp;
  if (lowTick < 1) {
    highTick += 1 - lowTick;
    lowTick = 1;
  }
  return { highTick, lowTick };
};

/** Builds a contiguous 1-tick Jigsaw-style flow-live-dom.v1 ladder frame. */
export const buildFlowLiveDom = (input: BuildFlowLiveDomInput): FlowLiveDom => {
  const minTick =
    input.minTick !== null && isPositiveFinite(input.minTick)
      ? input.minTick
      : FLOW_INSTRUMENTS[input.symbol].minTick;

  const bidsByTick = aggregateSide(input.bids, minTick);
  const asksByTick = aggregateSide(input.asks, minTick);
  const volumesByTick = aggregateVolumes(input.volumeByPrice, minTick);

  const bidTicks = [...bidsByTick.keys()];
  const askTicks = [...asksByTick.keys()];
  const bestBidTick = bidTicks.length > 0 ? Math.max(...bidTicks) : null;
  const bestAskTick = askTicks.length > 0 ? Math.min(...askTicks) : null;

  const bestBid =
    bestBidTick === null ? null : canonicalDomPrice(bestBidTick, minTick);
  const bestAsk =
    bestAskTick === null ? null : canonicalDomPrice(bestAskTick, minTick);
  const bookState = classifyBookState(bestBidTick, bestAskTick);

  const mid =
    bestBid !== null && bestAsk !== null
      ? roundPrice((bestBid + bestAsk) / 2)
      : (bestBid ?? bestAsk);
  const spread =
    bestBid !== null && bestAsk !== null ? roundPrice(bestAsk - bestBid) : null;
  const spreadTicks =
    bestBidTick !== null && bestAskTick !== null
      ? bestAskTick - bestBidTick
      : null;

  const lastTradeTick =
    input.lastTrade === null
      ? null
      : canonicalDomTickIndex(input.lastTrade.price, minTick);

  const initialAnchorTick =
    mid === null ? (lastTradeTick ?? 0) : canonicalDomTickIndex(mid, minTick);

  const poc = findPoc(volumesByTick, initialAnchorTick);
  const pocPrice =
    poc.tick === null ? null : canonicalDomPrice(poc.tick, minTick);

  const anchorTick =
    mid === null
      ? (lastTradeTick ?? poc.tick)
      : canonicalDomTickIndex(mid, minTick);

  const cumBid = computeCumulatives(bidsByTick, true);
  const cumAsk = computeCumulatives(asksByTick, false);

  let totalBid = 0;
  for (const size of bidsByTick.values()) totalBid += size;
  let totalAsk = 0;
  for (const size of asksByTick.values()) totalAsk += size;

  let tradedBuyTotal = 0;
  let tradedSellTotal = 0;
  let tradedUnsignedTotal = 0;
  let tradesTotal = 0;
  for (const bucket of volumesByTick.values()) {
    tradedBuyTotal += bucket.buy;
    tradedSellTotal += bucket.sell;
    tradedUnsignedTotal += bucket.unsigned;
    tradesTotal += bucket.trades;
  }

  const ladderTicks = [
    ...bidTicks,
    ...askTicks,
    ...(lastTradeTick === null ? [] : [lastTradeTick]),
    ...volumesByTick.keys(),
  ];

  const rows: FlowLiveDomRow[] = [];
  if (ladderTicks.length > 0 && anchorTick !== null) {
    const { lowTick, highTick } = pickTickBounds(ladderTicks, anchorTick);
    for (let tick = highTick; tick >= lowTick; tick -= 1) {
      const bidSize = bidsByTick.get(tick) ?? 0;
      const askSize = asksByTick.get(tick) ?? 0;
      const vol = volumesByTick.get(tick);
      const tradedBuy = vol?.buy ?? 0;
      const tradedSell = vol?.sell ?? 0;
      const tradedUnsigned = vol?.unsigned ?? 0;
      const tradedTotal = tradedBuy + tradedSell + tradedUnsigned;
      rows.push({
        askSize,
        bidSize,
        cumAskSize: cumAsk.get(tick) ?? 0,
        cumBidSize: cumBid.get(tick) ?? 0,
        imbalance: classifyImbalance(tradedBuy, tradedSell),
        isBestAsk: bestAskTick === tick,
        isBestBid: bestBidTick === tick,
        isLastTrade: lastTradeTick === tick,
        isPoc: poc.tick === tick,
        price: canonicalDomPrice(tick, minTick),
        tickIndex: tick,
        tradedBuy,
        tradedDelta: roundPrice(tradedBuy - tradedSell),
        tradedSell,
        tradedTotal,
        tradedUnsigned,
        trades: vol?.trades ?? 0,
      });
    }
  }

  const totalBook = totalBid + totalAsk;
  const bidSharePct =
    totalBook > 0 ? Math.round((totalBid / totalBook) * 1000) / 10 : null;

  return {
    bestAsk,
    bestBid,
    bookState,
    capturedAt: input.capturedAt,
    contract: input.contract,
    depthFeed: input.depthFeed,
    depthUpdates: input.depthUpdates,
    lastTrade: input.lastTrade,
    mid,
    minTick,
    pocPrice,
    pocVolume: poc.volume,
    rows,
    rules: FLOW_LIVE_DOM_RULES,
    schemaVersion: FLOW_LIVE_DOM_VERSION,
    seq: input.seq,
    since: input.since,
    source: input.source,
    spread,
    spreadTicks,
    symbol: input.symbol,
    tapeFeed: input.tapeFeed,
    tapeSeq: input.tapeSeq,
    totals: {
      askSize: totalAsk,
      bidSharePct,
      bidSize: totalBid,
      tradedBuy: tradedBuyTotal,
      tradedDelta: roundPrice(tradedBuyTotal - tradedSellTotal),
      tradedSell: tradedSellTotal,
      tradedTotal: tradedBuyTotal + tradedSellTotal + tradedUnsignedTotal,
      tradedUnsigned: tradedUnsignedTotal,
      trades: tradesTotal,
    },
    volumeSource: input.volumeSource,
    windowSeconds: input.windowSeconds,
  };
};
