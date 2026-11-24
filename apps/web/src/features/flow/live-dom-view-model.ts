// What: pure view-model for the Jigsaw-style Live DOM ladder panel of /flow
// (flow.liveDom / flow.liveDomStream, flow-live-dom.v1). Computes pulling/stacking queue deltas
// keyed by integer tickIndex, axis-lock / recenter row slicing, proportional depth & volume bars,
// KPI summaries, status-language-compliant connection banners, and keyboard row inspection.
// Research only: describes the resting book and executed tape, never a trade signal.
// Used by: apps/web/src/components/portal/flow-live-dom-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.

import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  FLOW_LIVE_DOM_CADENCE_MS,
  FLOW_LIVE_DOM_WINDOW_SECONDS,
  type FlowLiveDom,
  type FlowLiveDomCadenceMs,
  type FlowLiveDomRow,
  type FlowLiveDomWindowSeconds,
  type FlowTapeSymbol,
} from "@darkfactory/api";

import { formatEtSeconds, formatNyDateTime } from "./format.ts";
import { tapeSymbolOf } from "./tape-speed-view-model.ts";
import type { FlowSymbol } from "./view-model.ts";

export type LiveDomRequest = Readonly<{
  rows?: number;
  since?: number;
  symbol: FlowTapeSymbol;
  windowSeconds: FlowLiveDomWindowSeconds;
}>;

export type LiveDomStreamRequest = LiveDomRequest &
  Readonly<{
    cadenceMs: FlowLiveDomCadenceMs;
  }>;

export type LiveDomConnectionPhase =
  | "connecting"
  | "streaming"
  | "paused"
  | "hidden"
  | "reconnecting"
  | "error";

export type BookLevelSizes = Readonly<{
  askSize: number;
  bidSize: number;
}>;

export type BookSizesByTick = ReadonlyMap<number, BookLevelSizes>;

export type LiveDomDisplayRow = Readonly<{
  ariaLabel: string;
  askBarPct: number;
  askDelta: number;
  askDeltaText: string;
  askSizeText: string;
  askTradeBarPct: number;
  askTradeText: string;
  bidBarPct: number;
  bidDelta: number;
  bidDeltaText: string;
  bidSizeText: string;
  bidTradeBarPct: number;
  bidTradeText: string;
  priceText: string;
  row: FlowLiveDomRow;
  tradedDeltaText: string;
  tradedTotalText: string;
  volBuyBarPct: number;
  volSellBarPct: number;
}>;

export type LiveDomKpi = Readonly<{
  detail: string;
  id: "inside" | "last" | "imbalance" | "volume";
  label: string;
  value: string;
}>;

export type LiveDomStatusBanner = Readonly<{
  badge: string;
  detail: string;
  tone: "success" | "warning" | "destructive" | "neutral";
}>;

const LIVE_DOM_DEFAULT_VISIBLE_ROWS = 25;
const LIVE_DOM_BACKOFF_BASE_MS = 1000;
const LIVE_DOM_BACKOFF_MAX_MS = 15_000;

export const LIVE_DOM_WINDOW_OPTIONS: readonly Readonly<{
  label: string;
  seconds: FlowLiveDomWindowSeconds;
}>[] = FLOW_LIVE_DOM_WINDOW_SECONDS.map((seconds) => ({
  label: `${Math.round(seconds / 60)}m`,
  seconds,
}));

export const LIVE_DOM_CADENCE_OPTIONS: readonly Readonly<{
  label: string;
  ms: FlowLiveDomCadenceMs;
}>[] = FLOW_LIVE_DOM_CADENCE_MS.map((ms) => ({
  label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s`,
  ms,
}));

const wholeFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/** Futures contract symbol paired with the active /flow page symbol (SPY->ES, QQQ->NQ). */
export const domSymbolOf = (symbol: FlowSymbol): FlowTapeSymbol =>
  tapeSymbolOf(symbol);

/** Panel title naming the futures contract and, for SPY/QQQ, the paired index group. */
export const liveDomTitle = (symbol: FlowSymbol): string => {
  const future = domSymbolOf(symbol);
  if (future === symbol) return `Live DOM ladder (${future})`;
  const group = FLOW_GROUPS[FLOW_INSTRUMENTS[symbol].group].label;
  return `Live DOM ladder (${future}, the future of the ${group} group)`;
};

/** Price decimals required to display minTick cleanly (minimum 2 decimals for futures). */
export const domPriceDecimals = (minTick: number): number => {
  const text = String(minTick);
  const dot = text.indexOf(".");
  if (dot === -1) return 2;
  return Math.max(2, text.length - dot - 1);
};

export const formatDomPrice = (price: number, decimals: number): string =>
  price.toFixed(decimals);

export const formatSignedContracts = (value: number): string => {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${wholeFmt.format(rounded)}`;
  if (rounded < 0) return `-${wholeFmt.format(Math.abs(rounded))}`;
  return "0";
};

/** Exponential reconnect backoff (1 s -> 2 s -> 4 s -> 8 s -> capped at 15 s). */
export const nextDomBackoffMs = (attempt: number): number => {
  const bounded = Math.max(0, Math.min(attempt, 4));
  return Math.min(
    LIVE_DOM_BACKOFF_MAX_MS,
    LIVE_DOM_BACKOFF_BASE_MS * 2 ** bounded
  );
};

/** Snapshots current resting bid/ask sizes keyed by integer tickIndex for next-frame diffing. */
export const captureBookSizes = (
  rows: readonly FlowLiveDomRow[]
): BookSizesByTick => {
  const map = new Map<number, BookLevelSizes>();
  for (const row of rows) {
    if (row.bidSize > 0 || row.askSize > 0) {
      map.set(row.tickIndex, { askSize: row.askSize, bidSize: row.bidSize });
    }
  }
  return map;
};

/** True when symbol, contract, or data source changed and client deltas/axis-lock must reset. */
export const shouldResetDomClientState = (
  prev: FlowLiveDom | null,
  next: FlowLiveDom
): boolean =>
  prev === null ||
  prev.symbol !== next.symbol ||
  prev.contract !== next.contract ||
  prev.source !== next.source;

/** Center tick index of a frame (mid -> bestBid/bestAsk -> lastTrade -> POC -> middle row). */
export const frameCenterTick = (frame: FlowLiveDom): number | null => {
  if (frame.mid !== null) return Math.round(frame.mid / frame.minTick);
  if (frame.lastTrade !== null) {
    return Math.round(frame.lastTrade.price / frame.minTick);
  }
  if (frame.pocPrice !== null) {
    return Math.round(frame.pocPrice / frame.minTick);
  }
  return null;
};

/** Slices up to `maxVisibleRows` contiguous rows centered on `centerTick` (descending price). */
export const sliceDomRows = (
  rows: readonly FlowLiveDomRow[],
  centerTick: number | null,
  maxVisibleRows = LIVE_DOM_DEFAULT_VISIBLE_ROWS
): readonly FlowLiveDomRow[] => {
  if (rows.length <= maxVisibleRows || centerTick === null) return rows;
  let nearestIdx = 0;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const [index, row] of rows.entries()) {
    const dist = Math.abs(row.tickIndex - centerTick);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = index;
    }
  }
  const half = Math.floor(maxVisibleRows / 2);
  let start = Math.max(0, nearestIdx - half);
  if (start + maxVisibleRows > rows.length) {
    start = rows.length - maxVisibleRows;
  }
  return rows.slice(start, start + maxVisibleRows);
};

const pctOf = (value: number, max: number): number =>
  value <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));

const buildRowAriaLabel = (
  row: FlowLiveDomRow,
  priceText: string,
  bidDelta: number,
  askDelta: number
): string => {
  const parts: string[] = [`Price ${priceText}`];
  if (row.isBestAsk) parts.push("best ask");
  if (row.isBestBid) parts.push("best bid");
  if (row.isLastTrade) parts.push("last trade");
  if (row.isPoc) parts.push("point of control");
  if (row.bidSize > 0) parts.push(`bid ${wholeFmt.format(row.bidSize)}`);
  if (bidDelta !== 0)
    parts.push(`bid change ${formatSignedContracts(bidDelta)}`);
  if (row.askSize > 0) parts.push(`ask ${wholeFmt.format(row.askSize)}`);
  if (askDelta !== 0)
    parts.push(`ask change ${formatSignedContracts(askDelta)}`);
  if (row.tradedTotal > 0) {
    parts.push(
      `traded ${wholeFmt.format(row.tradedTotal)} (${wholeFmt.format(row.tradedSell)} sold at bid, ${wholeFmt.format(row.tradedBuy)} bought at ask, net ${formatSignedContracts(row.tradedDelta)})`
    );
  }
  if (row.imbalance === "buy") parts.push("3x buy imbalance");
  if (row.imbalance === "sell") parts.push("3x sell imbalance");
  return parts.join(", ");
};

/** Builds display rows with queue deltas, normalized bar widths, formatted text, and aria labels. */
export const buildLiveDomDisplayRows = (
  frame: FlowLiveDom,
  prevBookSizes: BookSizesByTick | null,
  lockedCenterTick: number | null,
  maxVisibleRows = LIVE_DOM_DEFAULT_VISIBLE_ROWS
): readonly LiveDomDisplayRow[] => {
  const centerTick = lockedCenterTick ?? frameCenterTick(frame);
  const visible = sliceDomRows(frame.rows, centerTick, maxVisibleRows);
  const decimals = domPriceDecimals(frame.minTick);

  let maxBook = 0;
  let maxSideTrade = 0;
  let maxVol = 0;
  for (const row of visible) {
    if (row.bidSize > maxBook) maxBook = row.bidSize;
    if (row.askSize > maxBook) maxBook = row.askSize;
    if (row.tradedSell > maxSideTrade) maxSideTrade = row.tradedSell;
    if (row.tradedBuy > maxSideTrade) maxSideTrade = row.tradedBuy;
    if (row.tradedTotal > maxVol) maxVol = row.tradedTotal;
  }

  return visible.map((row) => {
    const prev = prevBookSizes?.get(row.tickIndex);
    const bidDelta =
      prevBookSizes === null ? 0 : row.bidSize - (prev?.bidSize ?? 0);
    const askDelta =
      prevBookSizes === null ? 0 : row.askSize - (prev?.askSize ?? 0);
    const priceText = formatDomPrice(row.price, decimals);
    const totalPct = pctOf(row.tradedTotal, maxVol);
    const volBuyBarPct =
      row.tradedTotal > 0
        ? Math.round((row.tradedBuy / row.tradedTotal) * totalPct)
        : 0;
    const volSellBarPct = Math.max(0, totalPct - volBuyBarPct);

    return {
      ariaLabel: buildRowAriaLabel(row, priceText, bidDelta, askDelta),
      askBarPct: pctOf(row.askSize, maxBook),
      askDelta,
      askDeltaText: askDelta === 0 ? "" : formatSignedContracts(askDelta),
      askSizeText: row.askSize > 0 ? wholeFmt.format(row.askSize) : "",
      askTradeBarPct: pctOf(row.tradedBuy, maxSideTrade),
      askTradeText: row.tradedBuy > 0 ? wholeFmt.format(row.tradedBuy) : "",
      bidBarPct: pctOf(row.bidSize, maxBook),
      bidDelta,
      bidDeltaText: bidDelta === 0 ? "" : formatSignedContracts(bidDelta),
      bidSizeText: row.bidSize > 0 ? wholeFmt.format(row.bidSize) : "",
      bidTradeBarPct: pctOf(row.tradedSell, maxSideTrade),
      bidTradeText: row.tradedSell > 0 ? wholeFmt.format(row.tradedSell) : "",
      priceText,
      row,
      tradedDeltaText:
        row.tradedTotal > 0 ? formatSignedContracts(row.tradedDelta) : "",
      tradedTotalText:
        row.tradedTotal > 0 ? wholeFmt.format(row.tradedTotal) : "",
      volBuyBarPct,
      volSellBarPct,
    };
  });
};

/** Builds the four KPI cards shown above the Live DOM ladder. */
export const buildLiveDomKpis = (frame: FlowLiveDom): readonly LiveDomKpi[] => {
  const decimals = domPriceDecimals(frame.minTick);

  let insideValue = "No resting quotes";
  let insideDetail = "Waiting for CME L2 quotes";
  if (
    frame.bookState === "normal" &&
    frame.bestBid !== null &&
    frame.bestAsk !== null &&
    frame.spread !== null &&
    frame.spreadTicks !== null
  ) {
    insideValue = `${formatDomPrice(frame.bestBid, decimals)} × ${formatDomPrice(frame.bestAsk, decimals)}`;
    insideDetail = `Spread ${frame.spread.toFixed(decimals)} (${frame.spreadTicks} ${frame.spreadTicks === 1 ? "tick" : "ticks"})`;
  } else if (frame.bookState === "locked" && frame.bestBid !== null) {
    insideValue = `Locked ${formatDomPrice(frame.bestBid, decimals)}`;
    insideDetail = "Best bid equals best ask (0 ticks)";
  } else if (
    frame.bookState === "crossed" &&
    frame.bestBid !== null &&
    frame.bestAsk !== null &&
    frame.spread !== null
  ) {
    insideValue = `${formatDomPrice(frame.bestBid, decimals)} × ${formatDomPrice(frame.bestAsk, decimals)}`;
    insideDetail = `Crossed book (${frame.spread.toFixed(decimals)})`;
  } else if (frame.bookState === "one_sided") {
    const sideText =
      frame.bestBid === null
        ? `Ask ${formatDomPrice(frame.bestAsk as number, decimals)}`
        : `Bid ${formatDomPrice(frame.bestBid, decimals)}`;
    insideValue = sideText;
    insideDetail = "One-sided book";
  }

  const lastValue =
    frame.lastTrade === null
      ? "No prints yet"
      : `${formatDomPrice(frame.lastTrade.price, decimals)} × ${wholeFmt.format(frame.lastTrade.size)} ${frame.lastTrade.side}`;
  const lastDetail =
    frame.lastTrade === null
      ? frame.since === null
        ? `No trades in ${Math.round(frame.windowSeconds / 60)}m window`
        : "No trades since reset"
      : `Last print at ${formatEtSeconds(frame.lastTrade.t)}`;

  const imbalanceValue =
    frame.totals.bidSharePct === null
      ? "No resting depth"
      : `${pctFmt.format(frame.totals.bidSharePct)}% bid`;
  const imbalanceDetail =
    frame.totals.bidSharePct === null
      ? "0 bid / 0 ask contracts"
      : `${wholeFmt.format(frame.totals.bidSize)} bid / ${wholeFmt.format(frame.totals.askSize)} ask`;

  const volumeValue = `${wholeFmt.format(frame.totals.tradedTotal)} contracts`;
  const pocText =
    frame.pocPrice === null
      ? "no POC yet"
      : `POC ${formatDomPrice(frame.pocPrice, decimals)}`;
  const volumeDetail =
    frame.totals.tradedTotal > 0
      ? `Net ${formatSignedContracts(frame.totals.tradedDelta)} · ${pocText}`
      : frame.volumeSource === "large_trades_only"
        ? "Large trades only in fallback window"
        : "0 prints in active window";

  return [
    {
      detail: insideDetail,
      id: "inside",
      label: "Inside market",
      value: insideValue,
    },
    { detail: lastDetail, id: "last", label: "Last print", value: lastValue },
    {
      detail: imbalanceDetail,
      id: "imbalance",
      label: "Book imbalance",
      value: imbalanceValue,
    },
    {
      detail: volumeDetail,
      id: "volume",
      label: frame.since === null ? "Window volume" : "Since-reset volume",
      value: volumeValue,
    },
  ];
};

export type LiveDomStatusInput = Readonly<{
  cadenceMs: FlowLiveDomCadenceMs;
  errorAtMs: number | null;
  errorMessage: string | null;
  frame: FlowLiveDom | null;
  pausedAtMs: number | null;
  phase: LiveDomConnectionPhase;
  retryInMs: number | null;
  symbol: FlowTapeSymbol;
}>;

/** Definite status-language banner (cause + ET timestamp + next action; never vague text). */
export const buildLiveDomStatusBanner = (
  input: LiveDomStatusInput
): LiveDomStatusBanner => {
  const contractLabel = input.frame?.contract ?? input.symbol;

  if (input.phase === "paused") {
    const stamp =
      input.pausedAtMs === null
        ? "paused by operator"
        : `paused at ${formatEtSeconds(new Date(input.pausedAtMs).toISOString())}`;
    return {
      badge: "Paused",
      detail: `${contractLabel} stream ${stamp} · select Resume live to reconnect`,
      tone: "neutral",
    };
  }

  if (input.phase === "hidden") {
    return {
      badge: "Tab hidden",
      detail: `${contractLabel} stream paused while tab is hidden · resumes automatically when visible`,
      tone: "neutral",
    };
  }

  if (input.phase === "error") {
    const stamp =
      input.errorAtMs === null
        ? "Stream interrupted"
        : `Stream interrupted at ${formatEtSeconds(new Date(input.errorAtMs).toISOString())}`;
    const waitSec = Math.max(1, Math.round((input.retryInMs ?? 1000) / 1000));
    const cause = input.errorMessage ?? "transport connection dropped";
    return {
      badge: "Retrying",
      detail: `${stamp}: ${cause} · retrying in ${waitSec} s`,
      tone: "destructive",
    };
  }

  if (input.frame === null) {
    return {
      badge: "Connecting",
      detail: `Connecting to ${input.symbol} live DOM stream at ${input.cadenceMs} ms cadence · waiting for first frame`,
      tone: "neutral",
    };
  }

  if (input.frame.source === "live_stream") {
    const cadenceLabel =
      input.cadenceMs < 1000
        ? `${input.cadenceMs} ms`
        : `${input.cadenceMs / 1000} s`;
    const suffix =
      input.phase === "reconnecting"
        ? " · renewing stream lease"
        : ` · ${wholeFmt.format(input.frame.depthUpdates)} book updates`;
    return {
      badge: "Live stream",
      detail: `${contractLabel} live stream · updated ${formatEtSeconds(input.frame.capturedAt)} · ${cadenceLabel} cadence${suffix}`,
      tone: "success",
    };
  }

  if (input.frame.source === "recorded_fallback") {
    const reason =
      input.frame.depthFeed.error ??
      `live depth feed state is ${input.frame.depthFeed.state}`;
    const volNote =
      input.frame.volumeSource === "large_trades_only"
        ? " · volume from recorded large trades only"
        : "";
    return {
      badge: "Recorded fallback",
      detail: `${reason} · showing snapshot from ${formatNyDateTime(input.frame.capturedAt)}${volNote} · checking live stream every 5 s`,
      tone: "warning",
    };
  }

  const emptyReason =
    input.frame.depthFeed.error ??
    `depth feed state is ${input.frame.depthFeed.state}`;
  return {
    badge: "No depth yet",
    detail: `${input.symbol} has no live or recorded L2 book (${emptyReason}) · checking again in 5 s`,
    tone: "warning",
  };
};

/** Detailed single-line readout for the currently inspected ladder row. */
export const inspectLiveDomRow = (displayRow: LiveDomDisplayRow): string => {
  const { row, priceText, bidDelta, askDelta } = displayRow;
  const tags: string[] = [];
  if (row.isBestAsk) tags.push("Best Ask");
  if (row.isBestBid) tags.push("Best Bid");
  if (row.isLastTrade) tags.push("Last Trade");
  if (row.isPoc) tags.push("POC");
  if (row.imbalance === "buy") tags.push("3x Buy Imbalance");
  if (row.imbalance === "sell") tags.push("3x Sell Imbalance");

  const header =
    tags.length > 0 ? `${priceText} (${tags.join(" · ")})` : priceText;
  const bidPart = `Bid ${wholeFmt.format(row.bidSize)} (cum ${wholeFmt.format(row.cumBidSize)}${bidDelta === 0 ? "" : `, Δ ${formatSignedContracts(bidDelta)}`})`;
  const askPart = `Ask ${wholeFmt.format(row.askSize)} (cum ${wholeFmt.format(row.cumAskSize)}${askDelta === 0 ? "" : `, Δ ${formatSignedContracts(askDelta)}`})`;
  const volPart =
    row.tradedTotal > 0
      ? `Vol ${wholeFmt.format(row.tradedTotal)} (${wholeFmt.format(row.tradedSell)} sold × ${wholeFmt.format(row.tradedBuy)} bought, net ${formatSignedContracts(row.tradedDelta)})`
      : "Vol 0 contracts";

  return `${header} · ${bidPart} · ${askPart} · ${volPart}`;
};
