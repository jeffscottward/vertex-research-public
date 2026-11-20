// What: one parser for vertex-history bars answers (vertex-history-bars-v1 and vertex-history-bars-v2) and
// the volume rule every web reader uses.
// Why: the history service moved to ibapi 10.30.1 (design docs/vertex-rebuild/designs/history-ibapi-10-30).
// Bars v2 adds `volume_unit`: "shares" (STK in USD), "contracts" (FUT, CONTFUT), "unqualified" (STK in
// another currency, bar `v` null) or null (IND, CASH, bar `v` null). Volume is kept as sent only when the
// unit is "shares" or "contracts". Bars v1 came from ibapi 9.81, whose stock volume has no fixed unit
// (the lot was 40 shares for SPY on 2026-11-19, not 100), so a v1 answer keeps futures volume and sets
// STK, IND and CASH volume to null. Missing volume stays null; it is never written as 0.
// Modes: "v2-only" (ibkr-history.ts; a v1 answer is a schema failure, so the callers fall back to Yahoo)
// and "v1-or-v2" (market-data.ts, the /charts reader).

import { z } from "zod";

import {
  HISTORY_SEC_TYPES,
  HISTORY_WHAT_TO_SHOW,
  MARKET_BAR_SIZES,
  MARKET_BARS_MAX,
  type MarketBar,
  MarketBarSchema,
  MarketContractSchema,
} from "../contracts/market-data.ts";

const HISTORY_BARS_SCHEMA_V1 = "vertex-history-bars-v1";
const HISTORY_BARS_SCHEMA_V2 = "vertex-history-bars-v2";
export const HISTORY_VOLUME_UNITS = [
  "shares",
  "contracts",
  "unqualified",
] as const;
export type HistoryVolumeUnit = (typeof HISTORY_VOLUME_UNITS)[number];
export type HistoryAnswerMode = "v1-or-v2" | "v2-only";

// IBKR's UTC end-date form YYYYMMDD-HH:MM:SS.
export const HISTORY_END_DATETIME_RE = /^\d{8}-\d{2}:\d{2}:\d{2}$/;
const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

const answerFields = {
  as_of: isoUtc.nullable(),
  bars: z.array(MarketBarSchema).max(MARKET_BARS_MAX),
  cache: z
    .object({
      age_seconds: z.number().int().nonnegative(),
      hit: z.boolean(),
      stale: z.boolean(),
      ttl_seconds: z.number().int().nonnegative(),
    })
    .strict(),
  client_id: z.literal(77),
  contract: MarketContractSchema,
  count: z.number().int().nonnegative(),
  fetched_at: isoUtc,
  request: z
    .object({
      barSize: z.enum(MARKET_BAR_SIZES),
      contractMonth: z.string().max(8).nullable(),
      currency: z.string().max(3),
      duration: z.string().max(8),
      endDateTime: z.string().regex(HISTORY_END_DATETIME_RE).optional(),
      exchange: z.string().max(16),
      secType: z.enum(HISTORY_SEC_TYPES),
      symbol: z.string().max(12),
      useRTH: z.boolean(),
      whatToShow: z.enum(HISTORY_WHAT_TO_SHOW),
    })
    .strict(),
  source: z.literal("ibkr-gateway"),
};

const HistoryBarsV1Schema = z
  .object({ ...answerFields, schema: z.literal(HISTORY_BARS_SCHEMA_V1) })
  .strict();

const HistoryBarsV2Schema = z
  .object({
    ...answerFields,
    schema: z.literal(HISTORY_BARS_SCHEMA_V2),
    volume_unit: z.enum(HISTORY_VOLUME_UNITS).nullable(),
  })
  .strict();

const HistoryBarsAnswerSchema = z
  .discriminatedUnion("schema", [HistoryBarsV1Schema, HistoryBarsV2Schema])
  .refine((document) => document.count === document.bars.length, {
    message: "count mismatch",
  });

type HistoryBarsDocument = z.infer<typeof HistoryBarsAnswerSchema>;

export type HistoryBarsAnswer = Readonly<{
  schema: HistoryBarsDocument["schema"];
  // v2: as sent. v1: not sent, so null.
  volumeUnit: HistoryVolumeUnit | null;
  request: HistoryBarsDocument["request"];
  contract: HistoryBarsDocument["contract"];
  // In the order sent. `v` follows the volume rule above.
  bars: MarketBar[];
  count: number;
  fetchedAt: string;
  asOf: string | null;
  cache: HistoryBarsDocument["cache"];
  source: HistoryBarsDocument["source"];
}>;

/** True when the bar volume of this answer has a known unit (shares or contracts) and is kept as sent. */
const keepsVolume = (document: HistoryBarsDocument): boolean => {
  if (document.schema === HISTORY_BARS_SCHEMA_V2)
    return (
      document.volume_unit === "shares" || document.volume_unit === "contracts"
    );
  return (
    document.request.secType === "FUT" || document.request.secType === "CONTFUT"
  );
};

/**
 * Parses one bars answer. Returns null when the answer fails the schema, and in "v2-only" mode also for a
 * v1 answer. The caller turns null into its own schema-failure error.
 */
export const parseHistoryBarsAnswer = (
  raw: unknown,
  mode: HistoryAnswerMode
): HistoryBarsAnswer | null => {
  const parsed = HistoryBarsAnswerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const document = parsed.data;
  if (mode === "v2-only" && document.schema !== HISTORY_BARS_SCHEMA_V2)
    return null;
  const keep = keepsVolume(document);
  return {
    asOf: document.as_of,
    bars: keep
      ? document.bars
      : document.bars.map((bar) =>
          bar.v === null ? bar : { ...bar, v: null }
        ),
    cache: document.cache,
    contract: document.contract,
    count: document.count,
    fetchedAt: document.fetched_at,
    request: document.request,
    schema: document.schema,
    source: document.source,
    volumeUnit:
      document.schema === HISTORY_BARS_SCHEMA_V2 ? document.volume_unit : null,
  };
};
