import { oc } from "@orpc/contract";
import { z } from "zod";

// Signal alerts and watches (priceAlerts.signals.*), LuxAlgo P4. A rule compares two lines on one
// symbol's bars: price, a fixed value, an SMA/EMA, the N-bar high/low before the bar, or the session
// opening range. The operator is crossing (up, down, either) or above/below; the frequency is only
// once, once per bar, or once per bar close. A backfill counts how often a condition would have
// fired on the closed history. A watch is a rule proposed by Quant (the agent API or the
// deterministic watch parser): it waits as "proposed" until the owner starts or dismisses it. A
// scheduler tick evaluates active rules arithmetically (no model call in the tick loop), records
// each fire as an event (in-app list and browser notification) and sends one fixed-text ntfy push
// per owner. Research only: no order path, no instruction to trade. Operator-only.

export const SIGNAL_ALERT_TIMEFRAMES = ["5m", "15m", "1h", "1d"] as const;
export const SIGNAL_ALERT_OPERATORS = [
  "crosses-above",
  "crosses-below",
  "crosses",
  "above",
  "below",
] as const;
export const SIGNAL_ALERT_FREQUENCIES = [
  "once",
  "per-bar",
  "per-bar-close",
] as const;
export const SIGNAL_ALERT_KINDS = ["alert", "watch"] as const;
export const SIGNAL_ALERT_ORIGINS = ["manual", "strategy", "quant"] as const;
export const SIGNAL_ALERT_STATUSES = [
  "proposed",
  "active",
  "done",
  "dismissed",
] as const;
export const SIGNAL_ALERT_DELIVERIES = [
  "pending",
  "sent",
  "not-configured",
  "failed",
] as const;
export const SIGNAL_ALERT_PRICE_FIELDS = [
  "close",
  "open",
  "high",
  "low",
] as const;
/** A stock/ETF ticker, or a futures continuous contract written with Yahoo's suffix (NQ=F, ES=F). */
export const SIGNAL_ALERT_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}(?:[=]F)?$/;
export const SIGNAL_ALERT_NAME_MAX_LENGTH = 120;
/** Rules (any status) one owner may keep. */
export const SIGNAL_ALERT_MAX_RULES_PER_USER = 50;
/** Active rules one tick evaluates, least recently checked first. */
export const SIGNAL_ALERT_TICK_MAX_RULES = 100;
/** Distinct symbol/timeframe series fetched per run; other rules wait for the next run. */
export const SIGNAL_ALERT_MAX_SERIES_PER_RUN = 20;
/** Fire events returned by events (newest first). */
export const SIGNAL_ALERT_EVENTS_MAX = 50;

export type SignalAlertTimeframe = (typeof SIGNAL_ALERT_TIMEFRAMES)[number];
export type SignalAlertOperator = (typeof SIGNAL_ALERT_OPERATORS)[number];
export type SignalAlertFrequency = (typeof SIGNAL_ALERT_FREQUENCIES)[number];
export type SignalAlertKind = (typeof SIGNAL_ALERT_KINDS)[number];
export type SignalAlertOrigin = (typeof SIGNAL_ALERT_ORIGINS)[number];
export type SignalAlertStatus = (typeof SIGNAL_ALERT_STATUSES)[number];
export type SignalAlertDelivery = (typeof SIGNAL_ALERT_DELIVERIES)[number];

const period = z.number().int().min(2).max(500);

export const SignalAlertSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      field: z.enum(SIGNAL_ALERT_PRICE_FIELDS),
      type: z.literal("price"),
    })
    .strict(),
  z
    .object({
      type: z.literal("value"),
      value: z
        .string()
        .trim()
        .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/u),
    })
    .strict(),
  z.object({ period, type: z.literal("sma") }).strict(),
  z.object({ period, type: z.literal("ema") }).strict(),
  z.object({ period, type: z.literal("highest") }).strict(),
  z.object({ period, type: z.literal("lowest") }).strict(),
  z
    .object({
      minutes: z.number().int().min(5).max(240),
      side: z.enum(["high", "low"]),
      type: z.literal("opening-range"),
    })
    .strict(),
]);

export const SignalAlertConditionSchema = z
  .object({
    left: SignalAlertSourceSchema,
    operator: z.enum(SIGNAL_ALERT_OPERATORS),
    right: SignalAlertSourceSchema,
  })
  .strict();

export type SignalAlertSource = z.infer<typeof SignalAlertSourceSchema>;
export type SignalAlertCondition = z.infer<typeof SignalAlertConditionSchema>;

const symbol = z
  .string()
  .trim()
  .max(16)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(SIGNAL_ALERT_SYMBOL_PATTERN));

const name = z.string().trim().min(1).max(SIGNAL_ALERT_NAME_MAX_LENGTH);

const id = z.string().trim().min(1).max(128);

export const SignalAlertRuleSchema = z.object({
  condition: SignalAlertConditionSchema,
  createdAt: z.date(),
  /** Readable condition, e.g. "close crosses above SMA(50)". */
  description: z.string(),
  fireCount: z.number().int().min(0),
  frequency: z.enum(SIGNAL_ALERT_FREQUENCIES),
  id: z.string().min(1),
  kind: z.enum(SIGNAL_ALERT_KINDS),
  lastBarAt: z.date().nullable(),
  lastCheckedAt: z.date().nullable(),
  lastFiredAt: z.date().nullable(),
  name: z.string(),
  origin: z.enum(SIGNAL_ALERT_ORIGINS),
  status: z.enum(SIGNAL_ALERT_STATUSES),
  symbol: z.string(),
  timeframe: z.enum(SIGNAL_ALERT_TIMEFRAMES),
});

export const SignalAlertEventSchema = z.object({
  barAt: z.date(),
  delivery: z.enum(SIGNAL_ALERT_DELIVERIES),
  firedAt: z.date(),
  id: z.string().min(1),
  kind: z.enum(SIGNAL_ALERT_KINDS),
  name: z.string(),
  price: z.string(),
  ruleId: z.string().min(1),
  symbol: z.string(),
});

export const SignalAlertBackfillSchema = z.object({
  bars: z.number().int().min(0),
  count: z.number().int().min(0),
  days: z.number().int().min(0),
  from: z.date().nullable(),
  recent: z.array(z.date()),
  to: z.date().nullable(),
});

export const SIGNAL_ALERT_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Signal alert not found", status: 404 },
  STORAGE_ERROR: { message: "Signal alert storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UPSTREAM_ERROR: { message: "Market data unavailable", status: 502 },
  VALIDATION_ERROR: { message: "Signal alert validation failed", status: 422 },
} as const;

const signals = oc.errors(SIGNAL_ALERT_API_ERRORS);
const tags = ["Signal alerts"];

const BAR_MINUTES: Readonly<Record<SignalAlertTimeframe, number>> = {
  "15m": 15,
  "1d": 1440,
  "1h": 60,
  "5m": 5,
};

/**
 * A condition that can never fire is refused: an opening range on daily bars, not made of whole
 * bars or on futures hourly bars, and a zero value line.
 */
const refineConditionForTimeframe = (
  input: Readonly<{
    condition: SignalAlertCondition;
    symbol: string;
    timeframe: SignalAlertTimeframe;
  }>,
  context: z.RefinementCtx
): void => {
  for (const source of [input.condition.left, input.condition.right]) {
    if (source.type === "value" && Number(source.value) === 0)
      context.addIssue({
        code: "custom",
        message: "A value line must be greater than 0",
        path: ["condition"],
      });
    if (
      source.type === "opening-range" &&
      (input.timeframe === "1d" ||
        source.minutes % BAR_MINUTES[input.timeframe] !== 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "An opening range needs intraday bars and a whole number of bars",
        path: ["condition"],
      });
    // Futures and crypto hourly bars start on the hour, so no bar lines up with 09:30.
    if (
      source.type === "opening-range" &&
      input.timeframe === "1h" &&
      /[=-]/u.test(input.symbol)
    )
      context.addIssue({
        code: "custom",
        message:
          "Futures and crypto hourly bars start on the hour; use 5m or 15m bars for an opening range",
        path: ["condition"],
      });
  }
};

const ruleFields = {
  condition: SignalAlertConditionSchema,
  frequency: z.enum(SIGNAL_ALERT_FREQUENCIES),
  symbol,
  timeframe: z.enum(SIGNAL_ALERT_TIMEFRAMES),
};

export const SignalAlertListInputSchema = z.object({}).strict();
export const SignalAlertListOutputSchema = z.object({
  notifications: z.enum(["configured", "not-configured"]),
  rules: z.array(SignalAlertRuleSchema),
});

export const SignalAlertCreateInputSchema = z
  .object({
    ...ruleFields,
    name: name.optional(),
    origin: z.enum(["manual", "strategy"]).default("manual"),
  })
  .strict()
  .superRefine(refineConditionForTimeframe);
export const SignalAlertRuleOutputSchema = z.object({
  rule: SignalAlertRuleSchema,
});

export const SignalAlertBackfillInputSchema = z
  .object({
    condition: SignalAlertConditionSchema,
    symbol,
    timeframe: z.enum(SIGNAL_ALERT_TIMEFRAMES),
  })
  .strict()
  .superRefine(refineConditionForTimeframe);
export const SignalAlertBackfillOutputSchema = z.object({
  backfill: SignalAlertBackfillSchema,
  description: z.string(),
});

/** Quant proposes a watch: structured fields (agent API) or a plain-language request (parser). */
export const SignalAlertProposeInputSchema = z.union([
  z
    .object({ ...ruleFields, name: name.optional() })
    .strict()
    .superRefine(refineConditionForTimeframe),
  z.object({ text: z.string().trim().min(3).max(500) }).strict(),
]);
export const SignalAlertProposeOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    backfill: SignalAlertBackfillSchema.nullable(),
    ok: z.literal(true),
    rule: SignalAlertRuleSchema,
    summary: z.string(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export const SignalAlertIdInputSchema = z.object({ id }).strict();
export const SignalAlertRemoveOutputSchema = z.object({
  id: z.string().min(1),
  removed: z.literal(true),
});

export const SignalAlertEventsInputSchema = z
  .object({
    /** Only events fired after this instant (browser notification polling). */
    since: z.coerce.date().optional(),
  })
  .strict();
export const SignalAlertEventsOutputSchema = z.object({
  events: z.array(SignalAlertEventSchema),
});

const SeriesErrorSchema = z.object({
  reason: z.string(),
  symbol: z.string(),
  timeframe: z.enum(SIGNAL_ALERT_TIMEFRAMES),
});

export const SignalAlertCheckInputSchema = z.object({}).strict();
export const SignalAlertCheckOutputSchema = z.object({
  checked: z.number().int().min(0),
  delivery: z.enum(["none", "sent", "not-configured", "failed"]),
  events: z.array(SignalAlertEventSchema),
  seriesErrors: z.array(SeriesErrorSchema),
});

export const SignalAlertTickInputSchema = z.object({}).strict();
export const SignalAlertTickOutputSchema = z.object({
  checked: z.number().int().min(0),
  deliveries: z.object({
    failed: z.number().int().min(0),
    notConfigured: z.number().int().min(0),
    sent: z.number().int().min(0),
  }),
  fired: z.number().int().min(0),
  seriesErrors: z.array(SeriesErrorSchema),
});

const route = (
  method: "GET" | "POST" | "DELETE",
  operationId: string,
  path: string,
  summary: string
) =>
  signals.route({
    method,
    operationId: `priceAlerts.signals.${operationId}`,
    path: `/price-alerts/signals${path}`,
    summary,
    tags,
  });

const list = route("GET", "list", "", "List signal alerts and watches")
  .input(SignalAlertListInputSchema)
  .output(SignalAlertListOutputSchema);

const create = route(
  "POST",
  "create",
  "",
  "Create a signal or strategy alert (active immediately)"
)
  .input(SignalAlertCreateInputSchema)
  .output(SignalAlertRuleOutputSchema);

const backfill = route(
  "POST",
  "backfill",
  "/backfill",
  "Count how often a condition would have fired on the closed history"
)
  .input(SignalAlertBackfillInputSchema)
  .output(SignalAlertBackfillOutputSchema);

const propose = route(
  "POST",
  "propose",
  "/propose",
  "Quant proposes a watch; it waits until the owner starts or dismisses it"
)
  .input(SignalAlertProposeInputSchema)
  .output(SignalAlertProposeOutputSchema);

const start = route("POST", "start", "/{id}/start", "Start a proposed watch")
  .input(SignalAlertIdInputSchema)
  .output(SignalAlertRuleOutputSchema);

const dismiss = route(
  "POST",
  "dismiss",
  "/{id}/dismiss",
  "Dismiss a proposed watch or stop an active rule"
)
  .input(SignalAlertIdInputSchema)
  .output(SignalAlertRuleOutputSchema);

const remove = route("DELETE", "remove", "/{id}", "Remove a signal alert")
  .input(SignalAlertIdInputSchema)
  .output(SignalAlertRemoveOutputSchema);

const events = route(
  "GET",
  "events",
  "/events",
  "Recent signal alert fires, newest first"
)
  .input(SignalAlertEventsInputSchema)
  .output(SignalAlertEventsOutputSchema);

const check = route(
  "POST",
  "check",
  "/check",
  "Evaluate the caller's active signal alerts now"
)
  .input(SignalAlertCheckInputSchema)
  .output(SignalAlertCheckOutputSchema);

const tick = route(
  "POST",
  "tick",
  "/tick",
  "Scheduler: evaluate a bounded batch of every owner's active signal alerts"
)
  .input(SignalAlertTickInputSchema)
  .output(SignalAlertTickOutputSchema);

export const signalAlertsContract = {
  backfill,
  check,
  create,
  dismiss,
  events,
  list,
  propose,
  remove,
  start,
  tick,
};

export type SignalAlertRule = z.infer<typeof SignalAlertRuleSchema>;
export type SignalAlertEvent = z.infer<typeof SignalAlertEventSchema>;
export type SignalAlertBackfillResult = z.infer<
  typeof SignalAlertBackfillSchema
>;
export type SignalAlertListOutput = z.infer<typeof SignalAlertListOutputSchema>;
export type SignalAlertCreateInput = z.input<
  typeof SignalAlertCreateInputSchema
>;
export type SignalAlertProposeOutput = z.infer<
  typeof SignalAlertProposeOutputSchema
>;
export type SignalAlertBackfillOutput = z.infer<
  typeof SignalAlertBackfillOutputSchema
>;
export type SignalAlertCheckOutput = z.infer<
  typeof SignalAlertCheckOutputSchema
>;
export type SignalAlertTickOutput = z.infer<typeof SignalAlertTickOutputSchema>;
