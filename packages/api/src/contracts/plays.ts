import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";
import { CalendarDateSchema } from "./calendar-date.ts";

// Plays: potential option trades the owner is watching. Ideas only: nothing here places,
// stages or sizes an order. Rows live in Postgres (plays table, packages/db) and are written
// server-side only (seeds, operator scripts); the API is read-only and operator-only. Standing
// rule: options only with defined risk, so every play carries a positive maxLossUsd, definedRisk
// true and an exit rule.

export const PLAY_STATUSES = ["idea", "armed", "taken", "dropped"] as const;
export type PlayStatus = (typeof PLAY_STATUSES)[number];

export const PLAYS_MAX = 200;
export const PLAY_MAX_LEGS = 8;

export const PLAYS_API_ERRORS = {
  ...AGENT_OPS_API_ERRORS,
  STORAGE_ERROR: {
    message: "Plays storage request failed. Nothing was changed. Try again.",
    status: 503,
  },
} as const;

export const PlayLegSchema = z
  .object({
    expiry: CalendarDateSchema,
    quantity: z.number().int().positive(),
    right: z.enum(["call", "put"]),
    side: z.enum(["buy", "sell"]),
    strike: z.number().positive(),
  })
  .strict();
export type PlayLegOutput = z.infer<typeof PlayLegSchema>;

export const PlaySchema = z
  .object({
    createdAt: z.string(),
    definedRisk: z.literal(true),
    exitRule: z.string().min(1).max(500),
    id: z.string().min(1).max(128),
    legs: z.array(PlayLegSchema).min(1).max(PLAY_MAX_LEGS),
    // Standing rule: options only with a defined max loss.
    maxLossUsd: z.number().positive(),
    notes: z.string().max(2000).nullable(),
    sourceUrl: z.string().max(2000).nullable(),
    status: z.enum(PLAY_STATUSES),
    structure: z.string().min(1).max(80),
    thesis: z.string().min(1).max(2000),
    ticker: z.string().min(1).max(10),
    trigger: z.string().min(1).max(500),
    updatedAt: z.string(),
  })
  .strict();
export type Play = z.infer<typeof PlaySchema>;

export const PlaysListOutputSchema = z
  .object({ plays: z.array(PlaySchema).max(PLAYS_MAX) })
  .strict();
export type PlaysListOutput = z.infer<typeof PlaysListOutputSchema>;

const list = oc
  .errors(PLAYS_API_ERRORS)
  .route({
    method: "GET",
    operationId: "plays.list",
    path: "/plays",
    summary:
      "Read-only list of potential option plays (ideas only, never orders)",
    tags: ["Plays"],
  })
  .input(z.object({}).strict())
  .output(PlaysListOutputSchema);

export const playsContract = { list };
