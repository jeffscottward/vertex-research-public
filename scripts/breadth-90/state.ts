// Local breadth-90 state (~/.local/share/vertex-breadth-90/state.json): stored sessions (history),
// per-channel alert delivery (dedupe: an alert key is sent once per channel), source cross-checks and
// test sends. history.jsonl beside it gets one summary line per tick.

import { z } from "zod";

const DaySchema = z.object({
  adv: z.number().nonnegative(),
  asOf: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decl: z.number().nonnegative(),
  dvol: z.number().nonnegative(),
  final: z.boolean(),
  source: z.string(),
  uvol: z.number().nonnegative(),
});

const DeliverySchema = z.object({
  at: z.string(),
  detail: z.string(),
  ok: z.boolean(),
});

export const StateSchema = z.object({
  crossChecks: z
    .array(
      z.object({
        at: z.string(),
        date: z.string(),
        diff: z.number(),
        disagree: z.boolean(),
        tvUpPct: z.number(),
        wsjUpPct: z.number(),
      })
    )
    .default([]),
  days: z.record(z.string(), DaySchema),
  lastTick: z.string().nullable().default(null),
  sent: z.record(
    z.string(),
    z.object({
      at: z.string(),
      channels: z.record(z.string(), DeliverySchema),
      seeded: z.boolean().default(false),
    })
  ),
  testAlerts: z
    .array(
      z.object({
        at: z.string(),
        channels: z.record(z.string(), DeliverySchema),
      })
    )
    .default([]),
  version: z.literal(1),
});
export type BreadthState = z.infer<typeof StateSchema>;

export const emptyState = (): BreadthState => ({
  crossChecks: [],
  days: {},
  lastTick: null,
  sent: {},
  testAlerts: [],
  version: 1,
});

export const parseState = (text: string | null): BreadthState =>
  text === null ? emptyState() : StateSchema.parse(JSON.parse(text));

/** Keeps the newest cross-checks and test sends so the file stays small. */
export const trimState = (state: BreadthState): BreadthState => ({
  ...state,
  crossChecks: state.crossChecks.slice(-200),
  testAlerts: state.testAlerts.slice(-20),
});
