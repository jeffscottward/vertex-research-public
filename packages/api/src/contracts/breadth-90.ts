import { oc } from "@orpc/contract";
import { z } from "zod";

// Breadth-90 signal (breadth90.*): NYSE up-volume share (USI:UVOL / (UVOL + DVOL)) and advancer share
// (USI:ADV / (ADV + DECL)) per session, classified by the rig tick (scripts/breadth-90, see
// docs/vertex-rebuild/breadth-90.md). ARMED after a final 80% down day in the last 30 sessions,
// FIRED on a 90% up day or two 80% up days in a row while armed, FORMING when today's unfinished
// session meets that rule. Research only: no order path, no instruction to trade.

export const BREADTH90_DAY_KINDS = [
  "UP_90",
  "UP_80",
  "NEUTRAL",
  "DOWN_80",
  "DOWN_90",
] as const;
export const BREADTH90_STATES = ["IDLE", "ARMED", "FORMING", "FIRED"] as const;
export const BREADTH90_EVENT_KINDS = [
  "ARMED",
  "FORMING",
  "FIRED",
  "THRUST",
] as const;
export const BREADTH90_TIERS = [
  "strict",
  "standard",
  "major",
  "volume-only",
] as const;
export const BREADTH90_TRIGGERS = ["UP_90", "UP_80_X2"] as const;
export const BREADTH90_GRADES = ["major", "volume-only"] as const;
/** Day-kind bars (up-volume share, percent): the classifier's thresholds. */
export const BREADTH90_THRESHOLDS = Object.freeze({
  down80: 20,
  down90: 10,
  up80: 80,
  up90: 90,
});
/** Sessions one collect may push: a full backfill with margin. */
export const BREADTH90_MAX_COLLECT_DAYS = 2500;
/** Events one collect may push (every event the stored history produces). */
export const BREADTH90_MAX_COLLECT_EVENTS = 1000;
/** Sessions breadth90.get returns: the arming window. */
export const BREADTH90_GET_DAYS = 30;
/** Events breadth90.get returns, newest first. */
export const BREADTH90_GET_EVENTS = 20;

export type Breadth90State = (typeof BREADTH90_STATES)[number];
export type Breadth90DayKind = (typeof BREADTH90_DAY_KINDS)[number];
export type Breadth90EventKind = (typeof BREADTH90_EVENT_KINDS)[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pct = z.number().finite().min(0).max(100);
const count = z.number().finite().min(0);
const timestamp = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().max(max);

export const Breadth90BasketTierSchema = z
  .object({
    id: text(80),
    label: text(120),
    tickers: z.array(text(16)).max(100),
    weightPctNlv: z.number().finite().nullable(),
  })
  .strict();

/** The dip basket summary the research desk writes (read by the tick; all fields optional there). */
export const Breadth90BasketSchema = z
  .object({
    asOf: text(64).nullable(),
    reportPath: text(500).nullable(),
    rulesNote: text(1000).nullable(),
    summary: text(1000).nullable(),
    tiers: z.array(Breadth90BasketTierSchema).max(20),
  })
  .strict();

export const Breadth90DayInputSchema = z
  .object({
    adv: count,
    advPct: pct.nullable(),
    date,
    decl: count,
    dvol: count,
    final: z.boolean(),
    kind: z.enum(BREADTH90_DAY_KINDS),
    source: z.string().min(1).max(40),
    /** The source's own timestamp, kept as sent. */
    sourceAsOf: z.string().min(1).max(64),
    upPct: pct,
    uvol: count,
  })
  .strict();

export const Breadth90EventSchema = z
  .object({
    advPct: pct.nullable(),
    /** Newest 80%+ down day in the window (the arming day); null for THRUST. */
    armedOn: date.nullable(),
    date,
    grade: z.enum(BREADTH90_GRADES).nullable(),
    kind: z.enum(BREADTH90_EVENT_KINDS),
    strict: z.boolean(),
    /** Dedupe tier: strict|standard for ARMED, the grade for FORMING/FIRED/THRUST. */
    tier: z.enum(BREADTH90_TIERS),
    trigger: z.enum(BREADTH90_TRIGGERS).nullable(),
    upPct: pct,
  })
  .strict();

/** Flags every item whose key an earlier item already used (the store keys rows by it). */
const uniqueBy =
  <T>(key: (item: T) => string, message: (key: string) => string) =>
  (items: readonly T[], context: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const value = key(item);
      if (seen.has(value))
        context.addIssue({
          code: "custom",
          message: message(value),
          path: [index],
        });
      seen.add(value);
    });
  };

/** The rig tick's push (scripts/breadth-90/tick.ts): its evaluation, sessions, events and basket. */
export const Breadth90CollectInputSchema = z
  .object({
    armedOn: date.nullable(),
    asOf: timestamp,
    basket: Breadth90BasketSchema,
    days: z
      .array(Breadth90DayInputSchema)
      .max(BREADTH90_MAX_COLLECT_DAYS)
      .superRefine(
        uniqueBy(
          (day) => day.date,
          (repeat) => `days must have unique dates; ${repeat} appears twice`
        )
      ),
    events: z
      .array(Breadth90EventSchema)
      .max(BREADTH90_MAX_COLLECT_EVENTS)
      .superRefine(
        uniqueBy(
          (event) => `${event.kind}|${event.date}|${event.tier}`,
          (key) =>
            `events must be unique by (kind, date, tier); ${key} appears twice`
        )
      ),
    sessionsLeft: z.number().int().min(0).nullable(),
    state: z.enum(BREADTH90_STATES),
    strict: z.boolean(),
  })
  .strict();

export const Breadth90CollectOutputSchema = z.object({
  asOf: timestamp,
  /** Events first recorded by this push (insert-once by kind, date and tier). */
  newEvents: z.array(Breadth90EventSchema),
  stored: z.object({
    days: z.number().int().min(0),
    events: z.number().int().min(0),
  }),
});

export const Breadth90GetInputSchema = z.object({}).strict();

export const Breadth90StatusSchema = z.object({
  armedOn: date.nullable(),
  asOf: timestamp,
  basket: Breadth90BasketSchema.nullable(),
  sessionsLeft: z.number().int().min(0).nullable(),
  state: z.enum(BREADTH90_STATES),
  strict: z.boolean(),
});

export const Breadth90DaySchema = Breadth90DayInputSchema.extend({
  updatedAt: timestamp,
});

export const Breadth90StoredEventSchema = Breadth90EventSchema.extend({
  createdAt: timestamp,
});

export const Breadth90GetOutputSchema = z.object({
  /** The last 30 sessions, oldest first: final sessions plus today's intraday session, if any. */
  days: z.array(Breadth90DaySchema).max(BREADTH90_GET_DAYS),
  /** The newest 20 events, newest first. */
  events: z.array(Breadth90StoredEventSchema).max(BREADTH90_GET_EVENTS),
  /** Null before the first push. */
  status: Breadth90StatusSchema.nullable(),
  thresholds: z.object({
    down80: z.number(),
    down90: z.number(),
    up80: z.number(),
    up90: z.number(),
  }),
});

export const BREADTH90_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Breadth-90 storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const breadth90 = oc.errors(BREADTH90_API_ERRORS);
const tags = ["Breadth 90"];

const collect = breadth90
  .route({
    method: "POST",
    operationId: "breadth90.collect",
    path: "/breadth-90/collect",
    summary:
      "Rig tick: store NYSE breadth sessions, record signal events and replace the status",
    tags,
  })
  .input(Breadth90CollectInputSchema)
  .output(Breadth90CollectOutputSchema);

const get = breadth90
  .route({
    method: "GET",
    operationId: "breadth90.get",
    path: "/breadth-90",
    summary:
      "Breadth-90 status, the last 30 sessions and the newest signal events",
    tags,
  })
  .input(Breadth90GetInputSchema)
  .output(Breadth90GetOutputSchema);

export const breadth90Contract = { collect, get };

export type Breadth90CollectInput = z.input<typeof Breadth90CollectInputSchema>;
export type Breadth90CollectOutput = z.infer<
  typeof Breadth90CollectOutputSchema
>;
export type Breadth90GetOutput = z.infer<typeof Breadth90GetOutputSchema>;
export type Breadth90Day = z.infer<typeof Breadth90DaySchema>;
export type Breadth90StoredEvent = z.infer<typeof Breadth90StoredEventSchema>;
export type Breadth90Status = z.infer<typeof Breadth90StatusSchema>;
