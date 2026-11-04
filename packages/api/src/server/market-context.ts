import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  GexIndexRowSchema,
  MacroEventSchema,
  MacroRegimeSchema,
  MacroSeriesSchema,
  MARKET_CONTEXT_SECTIONS,
  MARKET_CONTEXT_STALE_SECONDS,
  type MarketContextOutput,
  MarketContextOutputSchema,
  NewsHeadlineSchema,
  NewsThemeSchema,
} from "../contracts/market-context.ts";
import type { ApiContext } from "./context.ts";
import {
  fetchLoopbackStatus,
  type LoopbackStatusFile,
  LoopbackStatusError,
  type LoopbackStatusOptions,
  toLoopbackStatusProcedureError,
} from "./loopback-status.ts";
import { requireOperator } from "./operator-access.ts";

// Market context: GET /markets.json from the rig status file server on the Vertex host (the same
// server and ENGINE_STATUS_URL as engines.status). The rig writes the file through the forced-command
// key (infra/rig/engine-status/market_context.py). Public market data only.

const MARKET_CONTEXT_FILE: LoopbackStatusFile = {
  label: "Market context",
  envName: "ENGINE_STATUS_URL",
  file: "markets.json",
  maxBytes: 256 * 1024,
  missing: "No market context pushed yet",
};

const epoch = z.number().int().positive();

// A list whose rows are checked one at a time: a bad row (for example a headline link that the URL
// parser rejects) is dropped instead of failing the whole document.
const rows = <T extends z.ZodType>(row: T, max: number) =>
  z
    .array(z.unknown())
    .max(max * 4)
    .transform((items): z.output<T>[] =>
      items
        .flatMap((item) => {
          const parsed = row.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, max)
    );

// Collector document `vertex-market-context-v1`: the contract rows, with unix-second times.
const UpstreamSchema = z.object({
  schema: z.literal("vertex-market-context-v1"),
  generatedAt: epoch,
  missing: z.array(z.enum(MARKET_CONTEXT_SECTIONS)).max(3),
  gex: z
    .object({
      asOf: epoch.nullable(),
      oiSession: z.iso.date().nullable(),
      label: z.string().min(1).max(300).nullable(),
      index: rows(GexIndexRowSchema, 2),
    })
    .nullable(),
  macro: z
    .object({
      asOf: epoch.nullable(),
      series: rows(MacroSeriesSchema, 40),
      regimes: rows(MacroRegimeSchema, 12),
      events: rows(MacroEventSchema, 8),
    })
    .nullable(),
  news: z
    .object({
      asOf: epoch.nullable(),
      themes: rows(NewsThemeSchema, 12),
      headlines: rows(NewsHeadlineSchema.extend({ publishedAt: epoch }), 25),
    })
    .nullable(),
});

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const isoOrNull = (seconds: number | null): string | null =>
  seconds === null ? null : iso(seconds);

export const toMarketContext = (
  raw: unknown,
  now: Date
): MarketContextOutput => {
  const parsed = UpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new LoopbackStatusError(
      "UPSTREAM_ERROR",
      "Market context file has an unexpected shape"
    );
  const { generatedAt, missing, gex, macro, news } = parsed.data;
  return MarketContextOutputSchema.parse({
    generatedAt: iso(generatedAt),
    stale: now.getTime() / 1000 - generatedAt > MARKET_CONTEXT_STALE_SECONDS,
    missing,
    gex: gex === null ? null : { ...gex, asOf: isoOrNull(gex.asOf) },
    macro: macro === null ? null : { ...macro, asOf: isoOrNull(macro.asOf) },
    news:
      news === null
        ? null
        : {
            ...news,
            asOf: isoOrNull(news.asOf),
            headlines: news.headlines.map((headline) => ({
              ...headline,
              publishedAt: iso(headline.publishedAt),
            })),
          },
  });
};

export const fetchMarketContext = async (
  base: string | null,
  options: LoopbackStatusOptions = {}
): Promise<MarketContextOutput> =>
  toMarketContext(
    await fetchLoopbackStatus(base, MARKET_CONTEXT_FILE, options),
    (options.now ?? (() => new Date()))()
  );

let marketContextOptions: LoopbackStatusOptions = {};
export const setMarketContextOptionsForTesting = (
  options: LoopbackStatusOptions
): void => {
  marketContextOptions = options;
};

const api = implement(appContract).$context<ApiContext>();

const marketContextGet = api.marketContext.get
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    try {
      return await fetchMarketContext(
        context.engineStatus ?? null,
        marketContextOptions
      );
    } catch (error) {
      throw toLoopbackStatusProcedureError(
        error,
        errors,
        "Market context read failed"
      );
    }
  });

export const marketContextRouter = { get: marketContextGet };
