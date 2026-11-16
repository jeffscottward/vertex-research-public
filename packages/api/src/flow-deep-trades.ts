import type { FlowInstrument } from "./flow-features.ts";
import type { SignedTrade } from "./flow-trade-signing.ts";

// Deep trades (docs/vertex-rebuild/flow-pipeline.md, "Deep trades"): single futures prints at or
// above the deep-trade limit of their market. The one detection pass is buildMinuteFeatures
// (deepPrints); this module turns those prints into insert-once rows. Research only.

/** One stored deep trade; the same shape as FlowLargeTradeRecord of the flow repository. */
export type FlowDeepTradeRow = Readonly<{
  symbol: "ES" | "NQ";
  second: Date;
  seq: number;
  side: "buy" | "sell";
  size: number;
  price: number;
  limitSize: number;
  signing: "quote" | "tick";
  capture: "sampled";
  sampledAt: Date;
}>;

/**
 * Deep-trade rows of one sample. sample.first and sample.last are the smallest and largest print
 * time of the whole fetched sample: the sample edge can cut those seconds, so their prints are left
 * out. Within a second, seq counts the deep prints in input (IBKR) order before the side is read,
 * so a key never depends on the signing. A print without a side is numbered but not stored.
 */
export const deepTradesOf = (
  instrument: FlowInstrument,
  deepPrints: readonly SignedTrade[],
  sample: Readonly<{ first: number; last: number }>,
  sampledAt: Date
): Readonly<{ rows: readonly FlowDeepTradeRow[]; unsigned: number }> => {
  const limitSize = instrument.deepTradeLimit;
  if (
    limitSize === null ||
    (instrument.symbol !== "ES" && instrument.symbol !== "NQ")
  )
    return { rows: [], unsigned: 0 };
  const symbol = instrument.symbol;
  const rows: FlowDeepTradeRow[] = [];
  const seqs = new Map<number, number>();
  let unsigned = 0;
  for (const print of deepPrints) {
    if (print.t <= sample.first || print.t >= sample.last) continue;
    const seq = seqs.get(print.t) ?? 0;
    seqs.set(print.t, seq + 1);
    if (print.method === "none" || print.side === "unknown") {
      unsigned += 1;
      continue;
    }
    rows.push({
      capture: "sampled",
      limitSize,
      price: print.price,
      sampledAt,
      second: new Date(print.t * 1000),
      seq,
      side: print.side,
      signing: print.method,
      size: print.size,
      symbol,
    });
  }
  return { rows, unsigned };
};

/** Deep-trade volume of one session minute (minute = whole minutes after the session open). */
export type FlowDeepMinute = Readonly<{
  minute: number;
  buyVolume: number;
  sellVolume: number;
  trades: number;
}>;

/** One entry per session minute that holds a deep trade, ascending; rows before the open are left out. */
export const sumDeepTradesByMinute = (
  rows: readonly FlowDeepTradeRow[],
  sessionOpen: Date
): readonly FlowDeepMinute[] => {
  const minutes = new Map<
    number,
    { buyVolume: number; sellVolume: number; trades: number }
  >();
  for (const row of rows) {
    const minute = Math.floor(
      (row.second.getTime() - sessionOpen.getTime()) / 60_000
    );
    if (minute < 0) continue;
    const entry = minutes.get(minute) ?? {
      buyVolume: 0,
      sellVolume: 0,
      trades: 0,
    };
    if (row.side === "buy") entry.buyVolume += row.size;
    else entry.sellVolume += row.size;
    entry.trades += 1;
    minutes.set(minute, entry);
  }
  return [...minutes.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minute, entry]) => ({ minute, ...entry }));
};
