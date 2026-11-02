import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_RATING_VALUES, AgentRatingSchema } from "./agent-ops.ts";
import { CalendarDateSchema } from "./calendar-date.ts";

// Agent model runs: one framework run (for example TradingAgents) on one ticker and decision date,
// recorded by the agent that ran it through an operator API key or MCP. Research only: the rating
// and the entry/stop/target levels are labels. They never authorize, create or size an order.
// Operator-only like agentOps.*: read keys may list, get, break down and export; write keys record
// and update.

export const AGENT_MODEL_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const AGENT_MODEL_RUN_TERMINAL_STATUS_VALUES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const AGENT_MODEL_RUN_RATING_SOURCE_VALUES = [
  "stated",
  "mapped",
  "missing",
] as const;
export const AGENT_MODEL_RUN_PURPOSE_VALUES = [
  "live",
  "backtest",
  "benchmark",
  "imported",
] as const;
export const AGENT_MODEL_RUN_HORIZON_BUCKET_VALUES = [
  "days",
  "weeks",
  "months",
  "quarters_plus",
  "unknown",
] as const;
export const AGENT_MODEL_RUN_FACET_VALUES = [
  "framework",
  "provider",
  "model",
  "servedModel",
  "ticker",
  "rating",
  "status",
  "flags",
  "purpose",
  "variant",
  "horizonBucket",
  "batch",
] as const;
export const AGENT_MODEL_RUN_GROUP_BY_VALUES = [
  "framework",
  "model",
  "servedModel",
  "provider",
  "ticker",
  "variant",
  "purpose",
] as const;
export const AGENT_MODEL_RUN_EVENT_KIND_VALUES = [
  "llm_call",
  "tool_call",
  "tool_result",
  "reasoning",
  "message",
  "decision",
  "status",
  "flag",
] as const;
export const AGENT_MODEL_RUN_UNRATED = "unrated" as const;
export const AGENT_MODEL_RUN_APPEND_MAX = 200;
export const AGENT_MODEL_RUN_EVENTS_PAGE_MAX = 500;
export const AGENT_MODEL_RUN_EVENT_BODY_MAX = 16_000;
const SEQ_MAX = 1_000_000;
export const AGENT_MODEL_RUN_LIST_MAX = 200;
export const AGENT_MODEL_RUN_EXPORT_MAX = 5000;
// A reported time may run ahead of the server clock by at most this much.
export const AGENT_MODEL_RUN_CLOCK_SKEW_MS = 60_000;
const FILTER_VALUES_MAX = 20;
const COUNT_MAX = 2_147_483_647;
const COST_MAX_USD = 1_000_000;
const PRICE_LIMIT = 1e12;

export const AGENT_MODEL_RUN_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;
export const AGENT_MODEL_RUN_TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.=/-]{0,19}$/u;
const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const text = (max: number) => z.string().trim().min(1).max(max);
const SlugSchema = z.string().trim().regex(AGENT_MODEL_RUN_SLUG_PATTERN, {
  message: "Use a lowercase slug: a-z first, then a-z, 0-9, _ or - (max 40)",
});
const LabelSchema = z.string().trim().regex(LABEL_PATTERN, {
  message: "Use 1-64 letters, digits, '.', '_', ':' or '-'",
});
const TickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(AGENT_MODEL_RUN_TICKER_PATTERN, {
    message: "Use an uppercase ticker (A-Z, 0-9, '.', '=', '/', '-'; max 20)",
  });
const IdSchema = z.string().regex(ID_PATTERN, { message: "Invalid id" });
const CountSchema = z.number().int().min(0).max(COUNT_MAX);
const CostSchema = z.number().finite().min(0).max(COST_MAX_USD);
const PriceSchema = z.number().finite().positive().lt(PRICE_LIMIT).nullable();
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const AgentModelRunStatusSchema = z.enum(AGENT_MODEL_RUN_STATUS_VALUES);
export const AgentModelRunRatingSourceSchema = z.enum(
  AGENT_MODEL_RUN_RATING_SOURCE_VALUES
);
export const AgentModelRunPurposeSchema = z.enum(
  AGENT_MODEL_RUN_PURPOSE_VALUES
);
export const AgentModelRunHorizonBucketSchema = z.enum(
  AGENT_MODEL_RUN_HORIZON_BUCKET_VALUES
);
export const AgentModelRunFacetSchema = z.enum(AGENT_MODEL_RUN_FACET_VALUES);
export const AgentModelRunGroupBySchema = z.enum(
  AGENT_MODEL_RUN_GROUP_BY_VALUES
);
export const AgentModelRunRatingFilterSchema = z.enum([
  ...AGENT_RATING_VALUES,
  AGENT_MODEL_RUN_UNRATED,
]);

export const AgentModelServedSchema = z
  .object({ requested: text(200), served: text(200) })
  .strict();

const UsageFields = {
  costUsd: CostSchema.optional(),
  durationMs: CountSchema.nullable().optional(),
  inputTokens: CountSchema.optional(),
  llmCalls: CountSchema.optional(),
  outputTokens: CountSchema.optional(),
  toolCalls: CountSchema.optional(),
};

const ResultFields = {
  entryPrice: PriceSchema.optional(),
  error: z.string().trim().max(2000).nullable().optional(),
  finishedAt: TimestampSchema.nullable().optional(),
  flags: z.array(SlugSchema).max(16).optional(),
  horizon: text(64).nullable().optional(),
  modelsServed: z.array(AgentModelServedSchema).max(16).optional(),
  rating: AgentRatingSchema.nullable().optional(),
  ratingSource: AgentModelRunRatingSourceSchema.optional(),
  startedAt: TimestampSchema.nullable().optional(),
  status: AgentModelRunStatusSchema.optional(),
  stopPrice: PriceSchema.optional(),
  targetPrice: PriceSchema.optional(),
};

export const AgentModelRunRecordInputSchema = z
  .object({
    ...UsageFields,
    ...ResultFields,
    analysts: z.array(text(64)).max(16).optional(),
    batch: LabelSchema.nullable().optional(),
    dataSource: text(120).nullable().optional(),
    decisionDate: CalendarDateSchema,
    framework: SlugSchema,
    frameworkVersion: text(64).nullable().optional(),
    memory: z.boolean().optional(),
    model: text(200),
    provider: text(64),
    purpose: AgentModelRunPurposeSchema.optional(),
    runKey: z.string().trim().regex(RUN_KEY_PATTERN, {
      message: "runKey must be 1-128 letters, digits, '.', '_', ':' or '-'",
    }),
    taskId: IdSchema.nullable().optional(),
    ticker: TickerSchema,
    variant: LabelSchema.nullable().optional(),
  })
  .strict();

export const AgentModelRunUpdateInputSchema = z
  .object({ ...UsageFields, ...ResultFields, id: IdSchema })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== "id"), {
    message: "Change at least one field",
  });

const listOf = <T extends z.ZodType>(item: T) =>
  z.array(item).max(FILTER_VALUES_MAX).optional();

const FilterFields = {
  batch: LabelSchema.optional(),
  decisionFrom: CalendarDateSchema.optional(),
  decisionTo: CalendarDateSchema.optional(),
  flags: listOf(SlugSchema),
  framework: listOf(SlugSchema),
  horizonBucket: listOf(AgentModelRunHorizonBucketSchema),
  model: listOf(text(200)),
  provider: listOf(text(64)),
  purpose: listOf(AgentModelRunPurposeSchema),
  rating: listOf(AgentModelRunRatingFilterSchema),
  servedModel: listOf(text(200)),
  status: listOf(AgentModelRunStatusSchema),
  ticker: listOf(TickerSchema),
  variant: listOf(LabelSchema),
};

const datesInOrder = (input: {
  decisionFrom?: string | undefined;
  decisionTo?: string | undefined;
}) =>
  input.decisionFrom === undefined ||
  input.decisionTo === undefined ||
  input.decisionFrom <= input.decisionTo;
const DATE_ORDER_MESSAGE = {
  message: "decisionFrom must not be after decisionTo",
};

export const AgentModelRunFiltersSchema = z
  .object(FilterFields)
  .strict()
  .refine(datesInOrder, DATE_ORDER_MESSAGE);

export const AgentModelRunListInputSchema = z
  .object({
    ...FilterFields,
    cursor: z.string().min(1).max(400).optional(),
    // Facet counts cost one query per facet. Default: on the first page only.
    includeFacets: z.boolean().optional(),
    limit: z.number().int().min(1).max(AGENT_MODEL_RUN_LIST_MAX).optional(),
  })
  .strict()
  .refine(datesInOrder, DATE_ORDER_MESSAGE);

export const AgentModelRunBreakdownInputSchema = z
  .object({ ...FilterFields, groupBy: AgentModelRunGroupBySchema })
  .strict()
  .refine(datesInOrder, DATE_ORDER_MESSAGE);

export const AgentModelRunGetInputSchema = z.object({ id: IdSchema }).strict();

export const AgentModelRunEventKindSchema = z.enum(
  AGENT_MODEL_RUN_EVENT_KIND_VALUES
);

// One event of a run. Model text is stored as plain text and never rendered as HTML or Markdown.
export const AgentModelRunEventInputSchema = z
  .object({
    agent: text(100),
    at: TimestampSchema.optional(),
    body: z.string().max(AGENT_MODEL_RUN_EVENT_BODY_MAX).nullable().optional(),
    costUsd: CostSchema.nullable().optional(),
    durationMs: CountSchema.nullable().optional(),
    inputTokens: CountSchema.nullable().optional(),
    kind: AgentModelRunEventKindSchema,
    model: text(200).nullable().optional(),
    outputTokens: CountSchema.nullable().optional(),
    seq: z.number().int().min(0).max(SEQ_MAX),
    title: text(300),
    toolName: text(100).nullable().optional(),
  })
  .strict()
  .refine(
    (event) =>
      event.kind !== "flag" || AGENT_MODEL_RUN_SLUG_PATTERN.test(event.title),
    { message: "A flag event title must be a lowercase slug", path: ["title"] }
  );

export const AgentModelRunAppendEventsInputSchema = z
  .object({
    events: z
      .array(AgentModelRunEventInputSchema)
      .min(1)
      .max(AGENT_MODEL_RUN_APPEND_MAX),
    runId: IdSchema,
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.events.map((event) => event.seq)).size ===
      input.events.length,
    { message: "Each event in a batch needs its own seq", path: ["events"] }
  );

export const AgentModelRunAppendEventsOutputSchema = z.object({
  appended: z.number().int().nonnegative(),
  redactedSeqs: z.array(z.number().int().nonnegative()),
  lastSeq: z.number().int().nonnegative().nullable(),
});

// Numbers are coerced so the OpenAPI GET route can pass them in the query string.
export const AgentModelRunEventsInputSchema = z
  .object({
    afterSeq: z.coerce.number().int().min(-1).max(SEQ_MAX).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGENT_MODEL_RUN_EVENTS_PAGE_MAX)
      .optional(),
    runId: IdSchema,
  })
  .strict();

export const AgentModelRunSearchInputSchema = z
  .object({ ...FilterFields, query: text(200) })
  .strict()
  .refine(datesInOrder, DATE_ORDER_MESSAGE);

// Benchmark: compares groups of runs ("arms") on the same (ticker, decision date) cells. Research
// only: agreement and directional hits describe ratings; they never authorize an order.
export const AGENT_MODEL_BENCHMARK_ARM_BY_VALUES = [
  "model",
  "servedModel",
  "provider_model",
  "framework",
  "variant",
] as const;
/** At most this many runs are compared; more matching runs set `truncated`. */
export const AGENT_MODEL_BENCHMARK_RUNS_MAX = 5000;
/** Arms in the summary table and in the agreement matrix. */
export const AGENT_MODEL_BENCHMARK_ARMS_MAX = 100;
export const AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX = 12;
/** Tickers whose daily bars are loaded for the paired comparison. */
export const AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX = 50;
/** Directional hit: the close-to-close return over the next 5 trading days. */
export const AGENT_MODEL_BENCHMARK_FORWARD_DAYS = 5;

export const AgentModelBenchmarkArmBySchema = z.enum(
  AGENT_MODEL_BENCHMARK_ARM_BY_VALUES
);
const ArmKeySchema = text(420);

export const AgentModelBenchmarkInputSchema = z
  .object({
    ...FilterFields,
    armBy: AgentModelBenchmarkArmBySchema,
    baselineArm: ArmKeySchema.optional(),
    pair: z
      .object({ control: ArmKeySchema, treatment: ArmKeySchema })
      .strict()
      .refine((pair) => pair.control !== pair.treatment, {
        message: "Pick two different arms",
        path: ["treatment"],
      })
      .optional(),
  })
  .strict()
  .refine(datesInOrder, DATE_ORDER_MESSAGE);

export const AgentModelRunSchema = z.object({
  id: z.string().min(1),
  runKey: z.string(),
  taskId: z.string().nullable(),
  framework: z.string(),
  frameworkVersion: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  modelsServed: z.array(
    z.object({ requested: z.string(), served: z.string() })
  ),
  ticker: z.string(),
  decisionDate: z.string(),
  analysts: z.array(z.string()),
  rating: AgentRatingSchema.nullable(),
  ratingSource: AgentModelRunRatingSourceSchema,
  entryPrice: z.number().nullable(),
  stopPrice: z.number().nullable(),
  targetPrice: z.number().nullable(),
  horizon: z.string().nullable(),
  horizonBucket: AgentModelRunHorizonBucketSchema,
  status: AgentModelRunStatusSchema,
  error: z.string().nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  llmCalls: z.number().int(),
  toolCalls: z.number().int(),
  costUsd: z.number(),
  durationMs: z.number().int().nullable(),
  flags: z.array(z.string()),
  batch: z.string().nullable(),
  purpose: AgentModelRunPurposeSchema,
  variant: z.string().nullable(),
  memory: z.boolean(),
  dataSource: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const FacetValuesSchema = z.array(
  z.object({ value: z.string(), count: z.number().int().nonnegative() })
);
export const AgentModelRunFacetsSchema = z.object(
  Object.fromEntries(
    AGENT_MODEL_RUN_FACET_VALUES.map((facet) => [facet, FacetValuesSchema])
  ) as Record<
    (typeof AGENT_MODEL_RUN_FACET_VALUES)[number],
    typeof FacetValuesSchema
  >
);

export const AgentModelRunListOutputSchema = z.object({
  runs: z.array(AgentModelRunSchema),
  facets: AgentModelRunFacetsSchema,
  nextCursor: z.string().nullable(),
});

export const AgentModelRunBreakdownRowSchema = z.object({
  key: z.string().nullable(),
  runs: z.number().int().nonnegative(),
  rated: z.number().int().nonnegative(),
  holdShare: z.number().min(0).max(1).nullable(),
  failed: z.number().int().nonnegative(),
  avgCostUsd: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});

export const AgentModelRunBreakdownOutputSchema = z.object({
  groupBy: AgentModelRunGroupBySchema,
  rows: z.array(AgentModelRunBreakdownRowSchema),
});

export const AgentModelRunExportOutputSchema = z.object({
  filename: z.string().min(1),
  csv: z.string(),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const AgentModelRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: z.date(),
  agent: z.string(),
  kind: AgentModelRunEventKindSchema,
  title: z.string(),
  body: z.string().nullable(),
  model: z.string().nullable(),
  toolName: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
});

// nextSeq is the afterSeq for the next poll. done: the run is finished and no event is left to read.
const EventPageFields = {
  done: z.boolean(),
  events: z.array(AgentModelRunEventSchema),
  nextSeq: z.number().int().min(-1),
  run: AgentModelRunSchema,
};

export const AgentModelRunEventsOutputSchema = z.object(EventPageFields);

export const AgentModelRunGetOutputSchema = z.object(EventPageFields);

export const AgentModelRunSearchOutputSchema = z.object({
  results: z.array(
    z.object({
      run: AgentModelRunSchema,
      rank: z.number(),
      snippets: z.array(
        z.object({
          seq: z.number().int().nonnegative(),
          agent: z.string(),
          kind: AgentModelRunEventKindSchema,
          segments: z.array(z.object({ text: z.string(), match: z.boolean() })),
        })
      ),
    })
  ),
});

const ShareSchema = z.number().min(0).max(1);
const NonNegativeInt = z.number().int().nonnegative();

export const AgentModelBenchmarkRatingMixSchema = z.object(
  Object.fromEntries(
    AGENT_RATING_VALUES.map((rating) => [rating, NonNegativeInt])
  ) as Record<(typeof AGENT_RATING_VALUES)[number], typeof NonNegativeInt>
);

export const AgentModelBenchmarkArmSchema = z.object({
  avgCostUsd: z.number().nonnegative(),
  baseline: z
    .object({
      matchRate: ShareSchema.nullable(),
      meanClosestDistance: z.number().min(0).max(4).nullable(),
      sharedCells: NonNegativeInt,
    })
    .nullable(),
  cells: NonNegativeInt,
  extremityShare: ShareSchema.nullable(),
  failed: NonNegativeInt,
  finished: NonNegativeInt,
  inputTokens: NonNegativeInt,
  key: z.string(),
  llmCalls: NonNegativeInt,
  local: z.boolean(),
  medianDurationMs: z.number().nonnegative().nullable(),
  outputTokens: NonNegativeInt,
  rated: NonNegativeInt,
  ratedCells: NonNegativeInt,
  ratingMix: AgentModelBenchmarkRatingMixSchema,
  rerun: z.object({
    allAgreeShare: ShareSchema.nullable(),
    cells: NonNegativeInt,
    meanModalShare: ShareSchema.nullable(),
  }),
  runs: NonNegativeInt,
  servedModels: z.array(z.string()),
  toolCalls: NonNegativeInt,
  totalCostUsd: z.number().nonnegative(),
  unrated: NonNegativeInt,
});

const PairArmSchema = z.object({
  hits: NonNegativeInt,
  medianDurationMs: z.number().nonnegative().nullable(),
  runs: NonNegativeInt,
  totalCostUsd: z.number().nonnegative(),
  totalTokens: NonNegativeInt,
});

export const AgentModelBenchmarkPairSchema = z.object({
  changedRating: NonNegativeInt,
  compared: NonNegativeInt,
  control: z.string(),
  controlArm: PairArmSchema,
  excludedNoBars: NonNegativeInt,
  excludedNoCall: NonNegativeInt,
  forwardDays: z.number().int().positive(),
  losses: NonNegativeInt,
  sharedCells: NonNegativeInt,
  signTestP: ShareSchema,
  /** Tickers past the bar-loading cap: their cells are counted in excludedNoBars. */
  tickersOverCap: z.array(z.string()),
  tickersWithoutBars: z.array(z.string()),
  ties: NonNegativeInt,
  treatment: z.string(),
  treatmentArm: PairArmSchema,
  wins: NonNegativeInt,
});

export const AgentModelBenchmarkOutputSchema = z.object({
  armBy: AgentModelBenchmarkArmBySchema,
  arms: z.array(AgentModelBenchmarkArmSchema),
  armsTruncated: z.boolean(),
  baselineArm: z.string().nullable(),
  cells: NonNegativeInt,
  matrix: z.object({
    arms: z.array(z.string()),
    rows: z.array(
      z.array(
        z.object({
          agreeShare: ShareSchema.nullable(),
          sharedCells: NonNegativeInt,
        })
      )
    ),
  }),
  pair: AgentModelBenchmarkPairSchema.nullable(),
  runCount: NonNegativeInt,
  truncated: z.boolean(),
});

// Framework reference sheets: a static catalog of the agent frameworks Vertex can benchmark, with
// how each one is wired into Vertex, its stages, its data and the tools it may use.
export const AGENT_FRAMEWORK_STATUS_VALUES = [
  "reimplemented",
  "adapted",
  "external",
] as const;
export const AGENT_FRAMEWORK_POINT_IN_TIME_VALUES = [
  "yes",
  "no",
  "caller",
] as const;

const SheetText = z.string().min(1).max(600);

export const AgentFrameworkSchema = z.object({
  /** Name of the arm in `python -m agents.framework_bench`, or null when it is not registered. */
  benchName: z.string().nullable(),
  code: z.array(z.string().min(1)),
  dataSources: z.array(
    z.object({
      name: SheetText,
      note: SheetText,
      pointInTime: z.enum(AGENT_FRAMEWORK_POINT_IN_TIME_VALUES),
    })
  ),
  guards: z.array(SheetText),
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  license: SheetText,
  links: z.array(
    z.object({
      href: z.string().url().startsWith("https://"),
      label: z.string().min(1),
    })
  ),
  name: z.string().min(1),
  stages: z.array(z.object({ name: z.string().min(1), summary: SheetText })),
  status: z.enum(AGENT_FRAMEWORK_STATUS_VALUES),
  summary: SheetText,
  toolsAllowed: z.array(z.string().min(1)),
  toolsExcluded: z.array(z.string().min(1)),
  version: z.string().min(1).max(120),
});

export const AgentFrameworksInputSchema = z.object({}).strict();
export const AgentFrameworksOutputSchema = z.object({
  frameworks: z.array(AgentFrameworkSchema),
});

export const AGENT_MODEL_RUNS_API_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Model run not found" },
  CONFLICT: { status: 409, message: "Model run status is final" },
  VALIDATION_ERROR: { status: 422, message: "Model run validation failed" },
  RUN_CLOSED: {
    status: 409,
    message:
      "The run finished more than 10 minutes ago and takes no new events",
  },
  SEQ_CONFLICT: {
    status: 409,
    message: "Event seqs must increase; resend only new seqs or exact retries",
  },
  SEARCH_TIMEOUT: {
    status: 503,
    message: "Search took too long; narrow the filters or the query",
  },
  EVENT_LIMIT: {
    status: 409,
    message: "The run holds the maximum of 5000 events",
  },
  STORAGE_ERROR: { status: 503, message: "Model run storage unavailable" },
} as const;

const base = oc.errors(AGENT_MODEL_RUNS_API_ERRORS);
const TAGS = ["Agent model runs"];

const record = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.record",
    path: "/agent-model-runs",
    summary:
      "Record a model run (idempotent by runKey: a repeated key returns the first run unchanged)",
    tags: TAGS,
  })
  .input(AgentModelRunRecordInputSchema)
  .output(AgentModelRunSchema);

const update = base
  .route({
    method: "PATCH",
    operationId: "agentModelRuns.update",
    path: "/agent-model-runs/{id}",
    summary:
      "Report status, usage, rating or levels (a terminal status is final)",
    tags: TAGS,
  })
  .input(AgentModelRunUpdateInputSchema)
  .output(AgentModelRunSchema);

const list = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.list",
    path: "/agent-model-runs/list",
    summary: "List model runs, newest decision first, with facet counts",
    tags: TAGS,
  })
  .input(AgentModelRunListInputSchema)
  .output(AgentModelRunListOutputSchema);

const breakdown = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.breakdown",
    path: "/agent-model-runs/breakdown",
    summary:
      "Group the filtered runs by one field (runs, rated, hold share, failed, cost)",
    tags: TAGS,
  })
  .input(AgentModelRunBreakdownInputSchema)
  .output(AgentModelRunBreakdownOutputSchema);

const exportCsv = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.exportCsv",
    path: "/agent-model-runs/export",
    summary: `Export the filtered runs as CSV (at most ${AGENT_MODEL_RUN_EXPORT_MAX} rows)`,
    tags: TAGS,
  })
  .input(AgentModelRunFiltersSchema)
  .output(AgentModelRunExportOutputSchema);

const benchmark = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.benchmark",
    path: "/agent-model-runs/benchmark",
    summary: `Compare arms of runs on shared cells: coverage, rating mix, agreement, paired directional hits (at most ${AGENT_MODEL_BENCHMARK_RUNS_MAX} runs)`,
    tags: TAGS,
  })
  .input(AgentModelBenchmarkInputSchema)
  .output(AgentModelBenchmarkOutputSchema);

const get = base
  .route({
    method: "GET",
    operationId: "agentModelRuns.get",
    path: "/agent-model-runs/{id}",
    summary: "One model run with its first page of events",
    tags: TAGS,
  })
  .input(AgentModelRunGetInputSchema)
  .output(AgentModelRunGetOutputSchema);

const appendEvents = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.appendEvents",
    path: "/agent-model-runs/{runId}/events",
    summary:
      "Append up to 200 events (idempotent by seq: an existing seq is kept as it was)",
    tags: TAGS,
  })
  .input(AgentModelRunAppendEventsInputSchema)
  .output(AgentModelRunAppendEventsOutputSchema);

const events = base
  .route({
    method: "GET",
    operationId: "agentModelRuns.events",
    path: "/agent-model-runs/{runId}/events",
    summary: "Events after a seq, with the run status and usage (for polling)",
    tags: TAGS,
  })
  .input(AgentModelRunEventsInputSchema)
  .output(AgentModelRunEventsOutputSchema);

const search = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.search",
    path: "/agent-model-runs/search",
    summary:
      "Full-text search over event text (up to 50 runs, 3 snippets each)",
    tags: TAGS,
  })
  .input(AgentModelRunSearchInputSchema)
  .output(AgentModelRunSearchOutputSchema);

const frameworks = base
  .route({
    method: "POST",
    operationId: "agentModelRuns.frameworks",
    path: "/agent-model-runs/frameworks",
    summary:
      "Reference sheets of the agent frameworks Vertex benchmarks (static catalog)",
    tags: TAGS,
  })
  .input(AgentFrameworksInputSchema)
  .output(AgentFrameworksOutputSchema);

export const agentModelRunsContract = {
  appendEvents,
  benchmark,
  breakdown,
  events,
  exportCsv,
  frameworks,
  get,
  list,
  record,
  search,
  update,
};

export type AgentModelRunOutput = z.infer<typeof AgentModelRunSchema>;
export type AgentModelRunFacetsOutput = z.infer<
  typeof AgentModelRunFacetsSchema
>;
export type AgentModelRunFacetName = z.infer<typeof AgentModelRunFacetSchema>;
export type AgentModelRunGroupByValue = z.infer<
  typeof AgentModelRunGroupBySchema
>;
export type AgentModelRunFiltersInput = z.input<
  typeof AgentModelRunFiltersSchema
>;
export type AgentModelRunListInput = z.input<
  typeof AgentModelRunListInputSchema
>;
export type AgentModelRunListOutput = z.infer<
  typeof AgentModelRunListOutputSchema
>;
export type AgentModelRunBreakdownOutput = z.infer<
  typeof AgentModelRunBreakdownOutputSchema
>;
export type AgentModelRunBreakdownRowOutput = z.infer<
  typeof AgentModelRunBreakdownRowSchema
>;
export type AgentModelRunExportOutput = z.infer<
  typeof AgentModelRunExportOutputSchema
>;
export type AgentModelRunGetOutput = z.infer<
  typeof AgentModelRunGetOutputSchema
>;
export type AgentModelRunRecordInput = z.input<
  typeof AgentModelRunRecordInputSchema
>;
export type AgentModelRunUpdateInput = z.input<
  typeof AgentModelRunUpdateInputSchema
>;
export type AgentModelRunEventOutput = z.infer<typeof AgentModelRunEventSchema>;
export type AgentModelRunEventKindValue = z.infer<
  typeof AgentModelRunEventKindSchema
>;
export type AgentModelRunEventsOutput = z.infer<
  typeof AgentModelRunEventsOutputSchema
>;
export type AgentModelRunEventInput = z.input<
  typeof AgentModelRunEventInputSchema
>;
export type AgentModelRunAppendEventsOutput = z.infer<
  typeof AgentModelRunAppendEventsOutputSchema
>;
export type AgentModelRunSearchOutput = z.infer<
  typeof AgentModelRunSearchOutputSchema
>;
export type AgentModelBenchmarkArmByValue = z.infer<
  typeof AgentModelBenchmarkArmBySchema
>;
export type AgentModelBenchmarkInput = z.input<
  typeof AgentModelBenchmarkInputSchema
>;
export type AgentModelBenchmarkOutput = z.infer<
  typeof AgentModelBenchmarkOutputSchema
>;
export type AgentModelBenchmarkArmOutput = z.infer<
  typeof AgentModelBenchmarkArmSchema
>;
export type AgentModelBenchmarkPairOutput = z.infer<
  typeof AgentModelBenchmarkPairSchema
>;
export type AgentFrameworkOutput = z.infer<typeof AgentFrameworkSchema>;
export type AgentFrameworksOutput = z.infer<typeof AgentFrameworksOutputSchema>;
export type AgentFrameworkStatusValue =
  (typeof AGENT_FRAMEWORK_STATUS_VALUES)[number];
