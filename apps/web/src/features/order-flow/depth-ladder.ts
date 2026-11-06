// What: a price ladder from an IBKR depth snapshot: asks above bids, highest price first, with
// sizes in shares or contracts (IBKR size x sizeMultiplier, a lower bound for stock lots) and size cumulated outward from the
// best price on each side. SMART depth can hold several venues at one price; each keeps its row.
// Used by: components/portal/order-flow-panel.tsx.
import type { MarketDepthLevel } from "@darkfactory/api";

export type LadderSide = "bid" | "ask";

export type LadderRow = Readonly<{
  key: string;
  side: LadderSide;
  price: number;
  /** Shares or contracts (IBKR size x sizeMultiplier). */
  size: number;
  /** Size outward from the best price on this side, including this row. */
  cumulative: number;
  venue: string | null;
  /** Position from the best price on its side (0 = best). */
  depth: number;
}>;

/** Book state at the touch; null when a side is empty. */
type BookState = "normal" | "locked" | "crossed";

export type DepthLadder = Readonly<{
  rows: readonly LadderRow[];
  bestBid: number | null;
  bestAsk: number | null;
  /** bestAsk - bestBid; null for a one-sided, locked or crossed book. */
  spread: number | null;
  /** locked: best bid == best ask; crossed: best bid > best ask. */
  bookState: BookState | null;
  mid: number | null;
  totalBid: number;
  totalAsk: number;
  /** Bid share of all displayed size (0-1); null for an empty book. */
  bidShare: number | null;
  maxSize: number;
  maxCumulative: number;
  sizeMultiplier: number;
}>;

export type DepthLadderInput = Readonly<{
  bids: readonly MarketDepthLevel[];
  asks: readonly MarketDepthLevel[];
  sizeMultiplier: number;
}>;

const sideRows = (
  levels: readonly MarketDepthLevel[],
  side: LadderSide,
  multiplier: number
): LadderRow[] => {
  // Best first: highest bid, lowest ask. Sort is stable, so venues at one price keep IBKR order.
  const ordered = levels
    .filter((level) => Number.isFinite(level.price) && level.size >= 0)
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  let cumulative = 0;
  return ordered.map((level, depth) => {
    const size = level.size * multiplier;
    cumulative += size;
    return {
      cumulative,
      depth,
      key: `${side}:${depth}:${level.price}:${level.venue ?? ""}`,
      price: level.price,
      side,
      size,
      venue: level.venue,
    };
  });
};

export const buildDepthLadder = (input: DepthLadderInput): DepthLadder => {
  const multiplier =
    Number.isFinite(input.sizeMultiplier) && input.sizeMultiplier > 0
      ? input.sizeMultiplier
      : 1;
  const bids = sideRows(input.bids, "bid", multiplier);
  const asks = sideRows(input.asks, "ask", multiplier);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const totalBid = bids.at(-1)?.cumulative ?? 0;
  const totalAsk = asks.at(-1)?.cumulative ?? 0;
  const rows = [...[...asks].reverse(), ...bids];
  let bookState: BookState | null = null;
  if (bestBid !== null && bestAsk !== null) {
    if (bestBid > bestAsk) bookState = "crossed";
    else bookState = bestBid === bestAsk ? "locked" : "normal";
  }
  return {
    bestAsk,
    bestBid,
    bidShare:
      totalBid + totalAsk === 0 ? null : totalBid / (totalBid + totalAsk),
    bookState,
    maxCumulative: Math.max(totalBid, totalAsk),
    maxSize: Math.max(0, ...rows.map((row) => row.size)),
    mid: bestBid === null || bestAsk === null ? null : (bestBid + bestAsk) / 2,
    rows,
    sizeMultiplier: multiplier,
    spread:
      bookState === "normal" && bestBid !== null && bestAsk !== null
        ? bestAsk - bestBid
        : null,
    totalAsk,
    totalBid,
  };
};

/** How depth sizes relate to IBKR's numbers, for the ladder's size note. */
export const depthSizeNote = (
  sizeMultiplier: number,
  unit: "shares" | "contracts"
): string =>
  sizeMultiplier > 1
    ? `IBKR reports stock depth in lots of mdSizeMultiplier shares (${sizeMultiplier}), rounded down, so shown shares are a lower bound.`
    : `Sizes in ${unit} as IBKR reports them.`;
