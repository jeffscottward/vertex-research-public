import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";

// Market context (card vertex-markets-gex-macro-news, 2026-11-03). The rig pushes public market data
// from market-watch-bot (GEX for SPY/QQQ, macro series, macro news headlines) to QuantVPS
// (infra/rig/engine-status/market_context.py). Read-only and operator-only. No account data:
// no positions, no held or watchlist symbols, no per-symbol news.

// The rig pushes every 5 min; older than 3 missed pushes is stale.
export const MARKET_CONTEXT_STALE_SECONDS = 900;
export const MARKET_CONTEXT_SECTIONS = ["gex", "macro", "news"] as const;

export const MARKET_CONTEXT_API_ERRORS = {
  ...AGENT_OPS_API_ERRORS,
  NOT_CONFIGURED: { status: 503, message: "Market context not configured" },
  UNAVAILABLE: { status: 503, message: "Market context unavailable" },
  UPSTREAM_ERROR: { status: 502, message: "Market context unreadable" },
} as const;

const value = z.number().nullable();
const day = z.iso.date().nullable();
const label = (max: number) => z.string().min(1).max(max);
const at = z.iso.datetime().nullable();

export const GexZeroDteSchema = z
  .object({
    expiry: day,
    netGex: value,
    flip: value,
    callWall: value,
    putWall: value,
  })
  .strict();

export const GexIndexRowSchema = z
  .object({
    symbol: z.enum(["SPY", "QQQ"]),
    status: label(20),
    spot: value,
    netGex: value,
    regime: label(20).nullable(),
    flip: value,
    spotVsFlip: label(10).nullable(),
    callWall: value,
    putWall: value,
    netVex: value,
    netChex: value,
    netDex: value,
    fadeNote: label(200).nullable(),
    zeroDte: GexZeroDteSchema.nullable(),
    notes: z.array(label(300)).max(6),
  })
  .strict();
export type GexIndexRow = z.infer<typeof GexIndexRowSchema>;

export const MacroSeriesSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/u),
    label: label(120),
    group: label(30),
    units: z.string().max(20),
    status: label(20),
    stale: z.boolean(),
    value,
    date: day,
    change1d: value,
    change1w: value,
    change1m: value,
    change1y: value,
    pct1y: value,
    source: label(40).nullable(),
    sourceUrl: z
      .url({ protocol: /^https?$/u })
      .max(2000)
      .nullable(),
  })
  .strict();
export type MacroSeries = z.infer<typeof MacroSeriesSchema>;

export const MacroRegimeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/u),
    label: label(120),
    rule: label(300).nullable(),
  })
  .strict();
export type MacroRegime = z.infer<typeof MacroRegimeSchema>;

export const MacroEventSchema = z
  .object({
    date: z.iso.date(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}( ET)?$/u)
      .nullable(),
    name: label(80),
  })
  .strict();
export type MacroEvent = z.infer<typeof MacroEventSchema>;

export const NewsThemeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/u),
    label: label(80),
    count24h: z.number().int().nonnegative(),
    count72h: z.number().int().nonnegative(),
    sentiment24h: value,
    shock: z.boolean(),
  })
  .strict();
export type NewsTheme = z.infer<typeof NewsThemeSchema>;

export const NewsHeadlineSchema = z
  .object({
    title: label(300),
    publisher: label(80).nullable(),
    url: z.url({ protocol: /^https?$/u }).max(2000),
    publishedAt: z.iso.datetime(),
    theme: label(80).nullable(),
    sentiment: value,
    materiality: z.enum(["low", "medium", "high"]).nullable(),
  })
  .strict();
export type NewsHeadline = z.infer<typeof NewsHeadlineSchema>;

export const MarketContextOutputSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    // True when the rig has not pushed for MARKET_CONTEXT_STALE_SECONDS.
    stale: z.boolean(),
    // Sections the rig could not read on its last push (they are null below).
    missing: z.array(z.enum(MARKET_CONTEXT_SECTIONS)).max(3),
    gex: z
      .object({
        asOf: at,
        oiSession: day,
        label: label(300).nullable(),
        index: z.array(GexIndexRowSchema).max(2),
      })
      .strict()
      .nullable(),
    macro: z
      .object({
        asOf: at,
        series: z.array(MacroSeriesSchema).max(40),
        regimes: z.array(MacroRegimeSchema).max(12),
        events: z.array(MacroEventSchema).max(8),
      })
      .strict()
      .nullable(),
    news: z
      .object({
        asOf: at,
        themes: z.array(NewsThemeSchema).max(12),
        headlines: z.array(NewsHeadlineSchema).max(25),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MarketContextOutput = z.infer<typeof MarketContextOutputSchema>;

const get = oc
  .errors(MARKET_CONTEXT_API_ERRORS)
  .route({
    method: "GET",
    path: "/market-context",
    operationId: "marketContext.get",
    summary:
      "Read-only public market context from the rig: GEX (SPY, QQQ), macro series and macro news",
    tags: ["Market context"],
  })
  .input(z.object({}).strict())
  .output(MarketContextOutputSchema);

export const marketContextContract = { get };
