import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  WATCHLIST_SYMBOL_PATTERN,
  WatchlistDecimalSchema,
} from "./watchlist.ts";
import { signalAlertsContract } from "./signal-alerts.ts";

// Price alerts (priceAlerts.*): a rule watches one symbol from the caller's watchlist for a price
// at or above / at or below a level. A scheduler tick or a manual check evaluates active rules
// against public Yahoo quotes; a rule triggers once, then stays triggered. A trigger sends one
// fixed-text ntfy notification when configured. Research only: no order path, no instruction to
// trade. Operator-only: session operators manage their own rules; agent write keys may tick.

export const PRICE_ALERT_KINDS = ["above", "below"] as const;
export const PRICE_ALERT_ROLES = ["price", "stop", "target"] as const;
export const PRICE_ALERT_DELIVERIES = [
  "pending",
  "sent",
  "not-configured",
  "failed",
] as const;
export const PRICE_ALERT_NOTE_MAX_LENGTH = 200;
/** Rules (active and triggered) one user may keep. */
export const PRICE_ALERT_MAX_RULES_PER_USER = 100;
/** Active rules one scheduler tick evaluates, least recently checked first. */
export const PRICE_ALERT_TICK_MAX_RULES = 200;
/** Distinct symbols quoted per check or tick; other rules wait for the next run. */
export const PRICE_ALERT_MAX_SYMBOLS_PER_RUN = 25;

export type PriceAlertKind = (typeof PRICE_ALERT_KINDS)[number];
export type PriceAlertRole = (typeof PRICE_ALERT_ROLES)[number];
export type PriceAlertDelivery = (typeof PRICE_ALERT_DELIVERIES)[number];

const id = z.string().trim().min(1).max(128);

export const PriceAlertStateSchema = z.discriminatedUnion("status", [
  z.object({
    /** Null until the first evaluation; the next window starts here (or at creation). */
    lastCheckedAt: z.date().nullable(),
    status: z.literal("active"),
  }),
  z.object({
    delivery: z.enum(PRICE_ALERT_DELIVERIES),
    status: z.literal("triggered"),
    triggeredAt: z.date(),
    /** The observed price that reached the level (bar high/low or last price). */
    triggerPrice: z.string(),
  }),
]);

export const PriceAlertRuleSchema = z.object({
  createdAt: z.date(),
  id: z.string().min(1),
  kind: z.enum(PRICE_ALERT_KINDS),
  level: z.string(),
  note: z.string().max(PRICE_ALERT_NOTE_MAX_LENGTH).nullable(),
  role: z.enum(PRICE_ALERT_ROLES),
  state: PriceAlertStateSchema,
  symbol: z.string().regex(WATCHLIST_SYMBOL_PATTERN),
});

export const PRICE_ALERT_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Price alert not found", status: 404 },
  STORAGE_ERROR: { message: "Price alert storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  VALIDATION_ERROR: { message: "Price alert validation failed", status: 422 },
} as const;

const priceAlerts = oc.errors(PRICE_ALERT_API_ERRORS);
const tags = ["Price alerts"];

export const PriceAlertListInputSchema = z.object({}).strict();
export const PriceAlertListOutputSchema = z.object({
  /** Whether a trigger can send an ntfy notification. */
  notifications: z.enum(["configured", "not-configured"]),
  rules: z.array(PriceAlertRuleSchema),
  /** The caller's watchlist symbols: the only symbols a rule may watch. */
  symbols: z.array(z.string()),
});

export const PriceAlertCreateInputSchema = z
  .object({
    kind: z.enum(PRICE_ALERT_KINDS),
    level: WatchlistDecimalSchema,
    note: z
      .string()
      .max(PRICE_ALERT_NOTE_MAX_LENGTH)
      .transform((value) => {
        const trimmed = value.trim();
        return trimmed === "" ? null : trimmed;
      })
      .optional(),
    role: z.enum(PRICE_ALERT_ROLES),
    symbol: z
      .string()
      .trim()
      .max(16)
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(WATCHLIST_SYMBOL_PATTERN)),
  })
  .strict();
export const PriceAlertCreateOutputSchema = z.object({
  rule: PriceAlertRuleSchema,
});

export const PriceAlertRemoveInputSchema = z.object({ id }).strict();
export const PriceAlertRemoveOutputSchema = z.object({
  id: z.string().min(1),
  removed: z.literal(true),
});

const QuoteErrorSchema = z.object({
  reason: z.string(),
  symbol: z.string(),
});

export const PriceAlertCheckInputSchema = z.object({}).strict();
export const PriceAlertCheckOutputSchema = z.object({
  /** Active rules evaluated in this run. */
  checked: z.number().int().min(0),
  /** Outcome of the one notification for this run; "none" when nothing triggered. */
  delivery: z.enum(["none", "sent", "not-configured", "failed"]),
  quoteErrors: z.array(QuoteErrorSchema),
  rules: z.array(PriceAlertRuleSchema),
  /** Rules that triggered in this run. */
  triggered: z.array(PriceAlertRuleSchema),
});

export const PriceAlertTickInputSchema = z.object({}).strict();
export const PriceAlertTickOutputSchema = z.object({
  checked: z.number().int().min(0),
  /** Owners notified: one fixed-text notification per owner with a trigger. */
  deliveries: z.object({
    failed: z.number().int().min(0),
    notConfigured: z.number().int().min(0),
    sent: z.number().int().min(0),
  }),
  quoteErrors: z.array(QuoteErrorSchema),
  triggered: z.number().int().min(0),
});

const list = priceAlerts
  .route({
    method: "GET",
    operationId: "priceAlerts.list",
    path: "/price-alerts",
    summary: "List price alert rules and the watchlist symbols they may watch",
    tags,
  })
  .input(PriceAlertListInputSchema)
  .output(PriceAlertListOutputSchema);

const create = priceAlerts
  .route({
    method: "POST",
    operationId: "priceAlerts.create",
    path: "/price-alerts",
    summary: "Create a price, stop or target alert for a watchlist symbol",
    tags,
  })
  .input(PriceAlertCreateInputSchema)
  .output(PriceAlertCreateOutputSchema);

const remove = priceAlerts
  .route({
    method: "DELETE",
    operationId: "priceAlerts.remove",
    path: "/price-alerts/{id}",
    summary: "Remove a price alert rule",
    tags,
  })
  .input(PriceAlertRemoveInputSchema)
  .output(PriceAlertRemoveOutputSchema);

const check = priceAlerts
  .route({
    method: "POST",
    operationId: "priceAlerts.check",
    path: "/price-alerts/check",
    summary: "Evaluate the caller's active price alerts now",
    tags,
  })
  .input(PriceAlertCheckInputSchema)
  .output(PriceAlertCheckOutputSchema);

const tick = priceAlerts
  .route({
    method: "POST",
    operationId: "priceAlerts.tick",
    path: "/price-alerts/tick",
    summary:
      "Scheduler: evaluate a bounded batch of every owner's active price alerts",
    tags,
  })
  .input(PriceAlertTickInputSchema)
  .output(PriceAlertTickOutputSchema);

export const priceAlertsContract = {
  check,
  create,
  list,
  remove,
  signals: signalAlertsContract,
  tick,
};

export type PriceAlertState = z.infer<typeof PriceAlertStateSchema>;
export type PriceAlertRule = z.infer<typeof PriceAlertRuleSchema>;
export type PriceAlertListOutput = z.infer<typeof PriceAlertListOutputSchema>;
export type PriceAlertCreateInput = z.input<typeof PriceAlertCreateInputSchema>;
export type PriceAlertCreateOutput = z.infer<
  typeof PriceAlertCreateOutputSchema
>;
export type PriceAlertRemoveOutput = z.infer<
  typeof PriceAlertRemoveOutputSchema
>;
export type PriceAlertCheckOutput = z.infer<typeof PriceAlertCheckOutputSchema>;
export type PriceAlertTickOutput = z.infer<typeof PriceAlertTickOutputSchema>;
