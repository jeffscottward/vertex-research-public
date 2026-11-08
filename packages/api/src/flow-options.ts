// What: parses QuantData `order-flow/consolidated` rows into typed option prints (aggressor side,
// moneyness, sweep/block, volume vs open interest) and derives option-flow events. Pure; rows that
// fail the boundary schema are skipped and counted. Doc: docs/vertex-rebuild/flow-pipeline.md.
import { z } from "zod";

import type {
  FlowConsolidation,
  FlowMoneyness,
  FlowOptionSentiment,
  FlowOptionSide,
  FlowOptionTicker,
  FlowSymbol,
} from "./contracts/flow.ts";
import type { FlowEventRow } from "./flow-features.ts";

const num = z.number().finite();

// Only the fields we use; QuantData sends more (greeks, sector, ...), which are ignored.
const QuantDataFlowRowSchema = z.object({
  askPrice: num.nullish(),
  bidPrice: num.nullish(),
  contractType: z.enum(["CALL", "PUT", "call", "put"]),
  dte: num.nullish(),
  expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  id: z.string().min(1).max(64),
  impliedVolatility: num.nullish(),
  isGoldenSweep: z.boolean().nullish(),
  isOpeningPosition: z.boolean().nullish(),
  isUnusual: z.boolean().nullish(),
  isVolumeGreaterThanOpenInterest: z.boolean().nullish(),
  moneyness: z
    .object({ degreeInPercent: num.nullish(), moneyType: z.string().nullish() })
    .nullish(),
  openInterest: num.nullish(),
  optionPrice: num.nullish(),
  premium: num.nonnegative(),
  sentimentType: z.string().nullish(),
  size: num.nonnegative(),
  stockPrice: num.nullish(),
  strikePrice: num,
  tradeConsolidationType: z.string().nullish(),
  tradeSideCode: z.string().nullish(),
  tradeTime: z.union([num, z.string().min(1)]),
  volume: num.nullish(),
});

export type FlowOptionPrintRow = Readonly<{
  id: string;
  symbol: FlowSymbol;
  ticker: FlowOptionTicker;
  tradedAt: Date;
  right: "call" | "put";
  strike: number;
  expiry: string;
  dte: number | null;
  size: number;
  price: number | null;
  premium: number;
  bid: number | null;
  ask: number | null;
  side: FlowOptionSide;
  sentiment: FlowOptionSentiment;
  consolidation: FlowConsolidation;
  unusual: boolean;
  goldenSweep: boolean;
  opening: boolean;
  volumeOverOi: boolean;
  volume: number | null;
  openInterest: number | null;
  moneyness: FlowMoneyness;
  moneynessPct: number | null;
  underlyingPrice: number | null;
  iv: number | null;
}>;

const SIDES: Readonly<Record<string, FlowOptionSide>> = {
  ABOVE_ASK: "above_ask",
  ASK: "ask",
  BELOW_BID: "below_bid",
  BID: "bid",
  MID_MARKET: "mid",
};
const MONEYNESS: Readonly<Record<string, FlowMoneyness>> = {
  AT_THE_MONEY: "atm",
  IN_THE_MONEY: "itm",
  OUT_OF_THE_MONEY: "otm",
};
const CONSOLIDATIONS: Readonly<Record<string, FlowConsolidation>> = {
  BLOCK: "block",
  SPLIT: "split",
  SWEEP: "sweep",
};
const SENTIMENTS: Readonly<Record<string, FlowOptionSentiment>> = {
  BEARISH: "bearish",
  BULLISH: "bullish",
};

/** QuantData sends tradeTime as epoch milliseconds or an ISO string. */
const toTime = (value: number | string): Date | null => {
  const numeric = Number(value);
  const ms = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/**
 * Oldest tradeTime among a page's rows, rows that fail the print schema included (the collector
 * resumes a capped range there even when its rows do not parse). Null: no row has a trade time.
 */
export const oldestRowTime = (data: unknown): Date | null => {
  let oldest: Date | null = null;
  for (const row of Array.isArray(data) ? data : []) {
    const value: unknown =
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>)["tradeTime"]
        : null;
    if (
      typeof value !== "number" &&
      (typeof value !== "string" || value === "")
    )
      continue;
    const time = toTime(value);
    if (time !== null && (oldest === null || time < oldest)) oldest = time;
  }
  return oldest;
};

const optionKind = (print: FlowOptionPrintRow): FlowEventRow["kind"] => {
  if (print.goldenSweep) return "option_golden_sweep";
  if (print.consolidation === "sweep") return "option_sweep";
  if (print.consolidation === "block") return "option_block";
  return "option_print";
};

export type ParsedOptionPrints = Readonly<{
  prints: FlowOptionPrintRow[];
  skipped: number;
}>;

export const parseOptionPrints = (
  data: unknown,
  symbol: FlowSymbol,
  ticker: FlowOptionTicker
): ParsedOptionPrints => {
  const rows = Array.isArray(data) ? data : [];
  const prints: FlowOptionPrintRow[] = [];
  for (const raw of rows) {
    const parsed = QuantDataFlowRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const tradedAt = toTime(row.tradeTime);
    if (tradedAt === null) continue;
    prints.push({
      ask: row.askPrice ?? null,
      bid: row.bidPrice ?? null,
      consolidation:
        CONSOLIDATIONS[String(row.tradeConsolidationType).toUpperCase()] ??
        "other",
      dte: row.dte ?? null,
      expiry: row.expirationDate.slice(0, 10),
      goldenSweep: row.isGoldenSweep === true,
      id: row.id,
      iv: row.impliedVolatility ?? null,
      moneyness:
        MONEYNESS[String(row.moneyness?.moneyType).toUpperCase()] ?? "unknown",
      moneynessPct: row.moneyness?.degreeInPercent ?? null,
      openInterest: row.openInterest ?? null,
      opening: row.isOpeningPosition === true,
      premium: row.premium,
      price: row.optionPrice ?? null,
      right: row.contractType.toLowerCase() as "call" | "put",
      sentiment:
        SENTIMENTS[String(row.sentimentType).toUpperCase()] ?? "neutral",
      side: SIDES[String(row.tradeSideCode).toUpperCase()] ?? "unknown",
      size: Math.trunc(row.size),
      strike: row.strikePrice,
      symbol,
      ticker,
      tradedAt,
      underlyingPrice: row.stockPrice ?? null,
      unusual: row.isUnusual === true,
      volume: row.volume ?? null,
      volumeOverOi: row.isVolumeGreaterThanOpenInterest === true,
    });
  }
  return { prints, skipped: rows.length - prints.length };
};

/** Option prints worth an event: premium at or above the symbol's floor, or a golden sweep. */
export const optionEvents = (
  prints: readonly FlowOptionPrintRow[],
  minPremium: number
): FlowEventRow[] =>
  prints
    .filter((print) => print.premium >= minPremium || print.goldenSweep)
    .map((print) => ({
      at: print.tradedAt,
      detail: `${print.ticker} ${print.expiry} ${print.strike}${print.right === "call" ? "C" : "P"} ${print.size}x @ ${print.price ?? "?"} (${print.side.replace("_", " ")}, ${print.moneyness})${print.unusual ? ", unusual" : ""}${print.volumeOverOi ? ", vol > OI" : ""}`,
      direction: print.sentiment,
      key: `option:${print.id}`,
      kind: optionKind(print),
      premium: print.premium,
      price: print.strike,
      size: print.size,
      source: "quantdata",
      symbol: print.symbol,
    }));
