import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lte,
  max,
  or,
  is,
  SQL,
  sql,
} from "drizzle-orm";

import {
  AGENT_MODEL_RUN_TERMINAL_STATUSES,
  type AgentModelRun,
  type AgentModelRunEvent,
  type AgentModelRunEventKind,
  type AgentModelRunPurpose,
  type AgentModelRunRatingSource,
  type AgentModelRunStatus,
  type AgentModelServed,
  agentModelRunEvents,
  agentModelRuns,
  type BacktestRating,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Agent model runs (one framework run on one ticker and decision date). Agents record a run with a
// client idempotency key and report status, usage and the research rating through update. The list
// is faceted: each facet counts the runs that match every OTHER active filter. Research only: the
// rating and levels are labels and never reach an order path.

export const AGENT_MODEL_RUN_LIST_MAX = 200;
export const AGENT_MODEL_RUN_EXPORT_MAX = 5000;
export const AGENT_MODEL_RUN_FACET_VALUES_MAX = 50;
export const AGENT_MODEL_RUN_BREAKDOWN_MAX = 100;

export const AGENT_MODEL_RUN_FACETS = [
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
export type AgentModelRunFacet = (typeof AGENT_MODEL_RUN_FACETS)[number];

export const AGENT_MODEL_RUN_GROUP_BY = [
  "framework",
  "model",
  "servedModel",
  "provider",
  "ticker",
  "variant",
  "purpose",
] as const;
export type AgentModelRunGroupBy = (typeof AGENT_MODEL_RUN_GROUP_BY)[number];

export const AGENT_MODEL_RUN_HORIZON_BUCKETS = [
  "days",
  "weeks",
  "months",
  "quarters_plus",
  "unknown",
] as const;
export type AgentModelRunHorizonBucket =
  (typeof AGENT_MODEL_RUN_HORIZON_BUCKETS)[number];

// Horizon text to bucket. The first matching rule wins; rules run from the largest unit down, so
// "2 weeks to 3 months" is months. The patterns use syntax that JavaScript and Postgres (~*) read the
// same way, so the list filter and the facet count agree with horizonBucketOf.
export const AGENT_MODEL_RUN_HORIZON_RULES: readonly Readonly<{
  bucket: Exclude<AgentModelRunHorizonBucket, "unknown">;
  pattern: string;
}>[] = Object.freeze([
  {
    bucket: "quarters_plus",
    pattern: "quarter|year|annual|long[ _-]?term|[0-9] *(y|yr|yrs|q)([^a-z]|$)",
  },
  {
    bucket: "months",
    pattern: "month|medium[ _-]?term|mid[ _-]?term|[0-9] *(m|mo|mos)([^a-z]|$)",
  },
  { bucket: "weeks", pattern: "week|[0-9] *(w|wk|wks)([^a-z]|$)" },
  {
    bucket: "days",
    pattern: "day|intraday|overnight|short[ _-]?term|[0-9] *d([^a-z]|$)",
  },
]);

export const horizonBucketOf = (
  horizon: string | null
): AgentModelRunHorizonBucket => {
  if (horizon === null) return "unknown";
  const rule = AGENT_MODEL_RUN_HORIZON_RULES.find((candidate) =>
    new RegExp(candidate.pattern, "i").test(horizon)
  );
  return rule === undefined ? "unknown" : rule.bucket;
};

export const UNRATED = "unrated" as const;
export type AgentModelRunRatingFilter = BacktestRating | typeof UNRATED;

export type AgentModelRunFilters = Readonly<{
  framework?: readonly string[];
  provider?: readonly string[];
  model?: readonly string[];
  servedModel?: readonly string[];
  ticker?: readonly string[];
  rating?: readonly AgentModelRunRatingFilter[];
  status?: readonly AgentModelRunStatus[];
  flags?: readonly string[];
  purpose?: readonly AgentModelRunPurpose[];
  variant?: readonly string[];
  horizonBucket?: readonly AgentModelRunHorizonBucket[];
  batch?: string;
  decisionFrom?: string;
  decisionTo?: string;
}>;

export type AgentModelRunUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  llmCalls?: number;
  toolCalls?: number;
  costUsd?: number;
  durationMs?: number | null;
}>;

export type AgentModelRunLevels = Readonly<{
  rating?: BacktestRating | null;
  ratingSource?: AgentModelRunRatingSource;
  entryPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  horizon?: string | null;
}>;

export type AgentModelRunRecordInput = AgentModelRunUsage &
  AgentModelRunLevels &
  Readonly<{
    runKey: string;
    taskId?: string | null;
    framework: string;
    frameworkVersion?: string | null;
    provider: string;
    model: string;
    modelsServed?: readonly AgentModelServed[];
    ticker: string;
    decisionDate: string;
    analysts?: readonly string[];
    status?: AgentModelRunStatus;
    error?: string | null;
    flags?: readonly string[];
    batch?: string | null;
    purpose?: AgentModelRunPurpose;
    variant?: string | null;
    memory?: boolean;
    dataSource?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  }>;

export type AgentModelRunUpdateInput = AgentModelRunUsage &
  AgentModelRunLevels &
  Readonly<{
    id: string;
    status?: AgentModelRunStatus;
    error?: string | null;
    modelsServed?: readonly AgentModelServed[];
    flags?: readonly string[];
    startedAt?: Date | null;
    finishedAt?: Date | null;
  }>;

export type AgentModelRunFacetValue = Readonly<{
  value: string;
  count: number;
}>;
export type AgentModelRunFacets = Readonly<
  Record<AgentModelRunFacet, AgentModelRunFacetValue[]>
>;

export type AgentModelRunPage = Readonly<{
  runs: AgentModelRun[];
  nextCursor: string | null;
}>;

export type AgentModelRunBreakdownRow = Readonly<{
  key: string | null;
  runs: number;
  rated: number;
  holdShare: number | null;
  failed: number;
  avgCostUsd: number;
  totalCostUsd: number;
}>;

export type AgentModelRunRecordResult = Readonly<{
  run: AgentModelRun;
  created: boolean;
}>;

export type AgentModelRunsRepository = Readonly<{
  record: (
    input: AgentModelRunRecordInput
  ) => Promise<AgentModelRunRecordResult>;
  update: (input: AgentModelRunUpdateInput) => Promise<AgentModelRun | null>;
  get: (id: string) => Promise<AgentModelRun | null>;
  list: (
    input: Readonly<{
      filters: AgentModelRunFilters;
      limit: number;
      cursor?: string;
    }>
  ) => Promise<AgentModelRunPage>;
  facets: (filters: AgentModelRunFilters) => Promise<AgentModelRunFacets>;
  breakdown: (
    filters: AgentModelRunFilters,
    groupBy: AgentModelRunGroupBy
  ) => Promise<AgentModelRunBreakdownRow[]>;
  appendEvents: (
    runId: string,
    events: readonly AgentModelRunEventInput[]
  ) => Promise<AgentModelRunAppendResult | null>;
  events: (
    runId: string,
    afterSeq: number,
    limit: number
  ) => Promise<AgentModelRunEventRecord[]>;
  search: (
    query: string,
    filters: AgentModelRunFilters
  ) => Promise<AgentModelRunSearchHit[]>;
}>;

// Events: at most 5000 per run, appended in batches of up to 200. A finished run accepts late events
// for 10 minutes after it finished, then it is closed.
export const AGENT_MODEL_RUN_EVENTS_MAX = 5000;
export const AGENT_MODEL_RUN_EVENTS_PAGE_MAX = 500;
export const AGENT_MODEL_RUN_EVENTS_CLOSE_AFTER_MS = 10 * 60 * 1000;
export const AGENT_MODEL_RUN_SEARCH_MAX = 50;
export const AGENT_MODEL_RUN_SEARCH_SNIPPETS = 3;
const AGENT_MODEL_RUN_SEARCH_CANDIDATES = 5000;
const AGENT_MODEL_RUN_SEARCH_TIMEOUT_MS = 2000;
// ts_headline marks matches with two private-use characters, which model text does not use.
export const SEARCH_MATCH_START = "\uE000";
export const SEARCH_MATCH_STOP = "\uE001";

export type AgentModelRunEventInput = Readonly<{
  seq: number;
  at?: Date;
  agent: string;
  kind: AgentModelRunEventKind;
  title: string;
  body?: string | null;
  model?: string | null;
  toolName?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  // The service replaced secrets in this event's text; the run gets the "redacted" flag.
  redacted?: boolean;
}>;

export type AgentModelRunEventRecord = Omit<AgentModelRunEvent, "search">;

export type AgentModelRunAppendResult = Readonly<{
  appended: number;
  lastSeq: number | null;
}>;

export type AgentModelRunSearchSnippet = Readonly<{
  seq: number;
  agent: string;
  kind: AgentModelRunEventKind;
  text: string;
}>;

export type AgentModelRunSearchHit = Readonly<{
  run: AgentModelRun;
  rank: number;
  snippets: AgentModelRunSearchSnippet[];
}>;

export class AgentModelRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelRunInputError";
  }
}

// A terminal status is final: a finished run cannot move back to queued or running.
export class AgentModelRunStateError extends Error {
  readonly from: AgentModelRunStatus;
  readonly to: AgentModelRunStatus;
  constructor(
    from: AgentModelRunStatus,
    to: AgentModelRunStatus,
    message = `run is ${from}; it cannot move to ${to}`
  ) {
    super(message);
    this.name = "AgentModelRunStateError";
    this.from = from;
    this.to = to;
  }
}

// A terminal run stops accepting events 10 minutes after it finished.
export class AgentModelRunClosedError extends Error {
  constructor() {
    super("run finished more than 10 minutes ago; it takes no new events");
    this.name = "AgentModelRunClosedError";
  }
}

export class AgentModelRunEventLimitError extends Error {
  constructor() {
    super(`a run holds at most ${AGENT_MODEL_RUN_EVENTS_MAX} events`);
    this.name = "AgentModelRunEventLimitError";
  }
}

// Seqs increase per run: a new event needs a seq above the highest stored one.
export class AgentModelRunSeqError extends Error {
  readonly highest: number;
  constructor(highest: number) {
    super(
      `seq must increase: the run's highest seq is ${highest}; send new events above it`
    );
    this.name = "AgentModelRunSeqError";
    this.highest = highest;
  }
}

export class AgentModelRunSearchTimeoutError extends Error {
  constructor() {
    super("search took too long; narrow the filters or the query");
    this.name = "AgentModelRunSearchTimeoutError";
  }
}

// A finished run stays open for late events for 10 minutes after it finished.
export const isModelRunClosed = (
  run: Readonly<{
    status: AgentModelRunStatus;
    finishedAt: Date | null;
    updatedAt: Date;
  }>,
  now: Date
): boolean =>
  isTerminalModelRunStatus(run.status) &&
  now.getTime() - (run.finishedAt ?? run.updatedAt).getTime() >
    AGENT_MODEL_RUN_EVENTS_CLOSE_AFTER_MS;

export class AgentModelRunStorageError extends Error {
  constructor(operation: string) {
    super(`model run storage failed: ${operation}`);
    this.name = "AgentModelRunStorageError";
  }
}

export const isTerminalModelRunStatus = (
  status: AgentModelRunStatus
): boolean =>
  (AGENT_MODEL_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);

// Source statuses from which a run may move to `to`. Forward only; a terminal status only repeats.
export const modelRunSourcesFor = (
  to: AgentModelRunStatus
): AgentModelRunStatus[] => {
  if (to === "queued") return ["queued"];
  if (to === "running") return ["queued", "running"];
  return ["queued", "running", to];
};

const TERMINAL_EDITABLE: ReadonlySet<string> = new Set([
  "updatedAt",
  "status",
  "rating",
  "ratingSource",
  "flags",
]);

const pgErrorCode = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = Reflect.get(current, "cause");
  }
  return null;
};

// Postgres constraint and data errors become input errors; other database failures become a storage
// error; anything else (a programming error) is rethrown unchanged.
export const mapModelRunWriteError = (
  error: unknown,
  operation: string
): never => {
  const code = pgErrorCode(error);
  if (code === "23503")
    throw new AgentModelRunInputError("taskId does not match an agent task");
  if (code === "23514" || code?.startsWith("22") === true)
    throw new AgentModelRunInputError("run violates a field constraint");
  if (code !== null) throw new AgentModelRunStorageError(operation);
  throw error;
};

// rating null (or absent) always means "missing". A rating without a stated source is "stated".
export const resolveRatingSource = (
  rating: BacktestRating | null,
  source: AgentModelRunRatingSource | undefined
): AgentModelRunRatingSource => {
  if (rating === null) {
    if (source !== undefined && source !== "missing")
      throw new AgentModelRunInputError(
        "ratingSource must be missing when there is no rating"
      );
    return "missing";
  }
  if (source === "missing")
    throw new AgentModelRunInputError(
      "ratingSource cannot be missing when a rating is given"
    );
  return source ?? "stated";
};

export const uniqueValues = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,400}$/u;

export const encodeModelRunCursor = (run: AgentModelRun): string =>
  Buffer.from(
    JSON.stringify([run.decisionDate, run.createdAt.toISOString(), run.id])
  ).toString("base64url");

export const decodeModelRunCursor = (
  cursor: string
): readonly [string, Date, string] => {
  const invalid = () => new AgentModelRunInputError("cursor is not valid");
  if (!CURSOR_PATTERN.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [date, created, id] = parsed as unknown[];
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    typeof created !== "string" ||
    typeof id !== "string" ||
    id.length === 0
  )
    throw invalid();
  const createdAt = new Date(created);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return [date, createdAt, id];
};

const table = agentModelRuns;

const horizonBucketSql = (): SQL => {
  const cases = AGENT_MODEL_RUN_HORIZON_RULES.map(
    (rule) => sql` when ${table.horizon} ~* ${rule.pattern} then ${rule.bucket}`
  );
  return sql`(case${sql.join(cases)} else 'unknown' end)`;
};

const jsonbContainsAny = (
  column: SQL | typeof table.flags | typeof table.modelsServed,
  values: readonly unknown[]
): SQL =>
  or(
    ...values.map(
      (value) => sql`${column} @> ${JSON.stringify([value])}::jsonb`
    )
  ) as SQL;

const present = <T>(values: readonly T[] | undefined): values is readonly T[] =>
  values !== undefined && values.length > 0;

// WHERE conditions for every active filter except `skip` (the facet being counted).
export const modelRunConditions = (
  filters: AgentModelRunFilters,
  skip?: AgentModelRunFacet
): SQL[] => {
  const conditions: SQL[] = [];
  const scalar = (
    facet: AgentModelRunFacet,
    values: readonly string[] | undefined,
    column:
      | typeof table.framework
      | typeof table.provider
      | typeof table.model
      | typeof table.ticker
      | typeof table.status
      | typeof table.purpose
      | typeof table.variant
  ) => {
    if (skip !== facet && present(values))
      conditions.push(inArray(column, [...values]));
  };
  scalar("framework", filters.framework, table.framework);
  scalar("provider", filters.provider, table.provider);
  scalar("model", filters.model, table.model);
  scalar("ticker", filters.ticker, table.ticker);
  scalar("status", filters.status, table.status);
  scalar("purpose", filters.purpose, table.purpose);
  scalar("variant", filters.variant, table.variant);
  if (skip !== "servedModel" && present(filters.servedModel))
    conditions.push(
      jsonbContainsAny(
        table.modelsServed,
        filters.servedModel.map((served) => ({ served }))
      )
    );
  if (skip !== "flags" && present(filters.flags))
    conditions.push(jsonbContainsAny(table.flags, filters.flags));
  if (skip !== "rating" && present(filters.rating)) {
    const named = filters.rating.filter(
      (value): value is BacktestRating => value !== UNRATED
    );
    const parts: SQL[] = [];
    if (named.length > 0) parts.push(inArray(table.rating, named));
    if (named.length < filters.rating.length) parts.push(isNull(table.rating));
    conditions.push(or(...parts) as SQL);
  }
  if (skip !== "horizonBucket" && present(filters.horizonBucket))
    conditions.push(
      sql`${horizonBucketSql()} in (${sql.join(
        filters.horizonBucket.map((bucket) => sql`${bucket}`),
        sql`, `
      )})`
    );
  if (skip !== "batch" && filters.batch !== undefined)
    conditions.push(eq(table.batch, filters.batch));
  if (filters.decisionFrom !== undefined)
    conditions.push(gte(table.decisionDate, filters.decisionFrom));
  if (filters.decisionTo !== undefined)
    conditions.push(lte(table.decisionDate, filters.decisionTo));
  return conditions;
};

const whereOf = (conditions: readonly SQL[]): SQL | undefined =>
  conditions.length === 0 ? undefined : and(...conditions);

// The value each facet counts. flags and servedModel unnest the JSON arrays (one row per value).
export const facetValueSql = (facet: AgentModelRunFacet): SQL => {
  switch (facet) {
    case "servedModel":
      return sql`(jsonb_array_elements(${table.modelsServed}) ->> 'served')`;
    case "flags":
      return sql`jsonb_array_elements_text(${table.flags})`;
    case "rating":
      return sql`coalesce(${table.rating}, ${UNRATED})`;
    case "horizonBucket":
      return horizonBucketSql();
    default:
      return sql`${table[facet]}`;
  }
};

export const clampLimit = (limit: number, ceiling: number): number =>
  Math.min(Math.max(Math.trunc(limit), 1), ceiling);

export const createAgentModelRunsRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): AgentModelRunsRepository => {
  const get = async (id: string): Promise<AgentModelRun | null> => {
    const [row] = await database
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return row ?? null;
  };

  const facetCounts = async (
    filters: AgentModelRunFilters,
    facet: AgentModelRunFacet
  ): Promise<AgentModelRunFacetValue[]> => {
    const inner = database
      .select({ id: table.id, value: facetValueSql(facet).as("value") })
      .from(table)
      .where(whereOf(modelRunConditions(filters, facet)))
      .as("facet");
    const rows = await database
      .select({
        value: sql<string>`"facet"."value"`,
        count: sql<number>`count(distinct "facet"."id")`.mapWith(Number),
      })
      .from(inner)
      .where(sql`"facet"."value" is not null`)
      .groupBy(sql`"facet"."value"`)
      .orderBy(sql`2 desc`, sql`1 asc`)
      .limit(AGENT_MODEL_RUN_FACET_VALUES_MAX);
    return rows.map((row) => ({ count: row.count, value: row.value }));
  };

  const events = agentModelRunEvents;
  const { search: _search, ...eventColumns } = getTableColumns(events);

  return {
    appendEvents: async (runId, input) =>
      database.transaction(async (transaction) => {
        // The row lock serializes appends per run, so the seq and count checks are exact.
        const [run] = await transaction
          .select({
            finishedAt: table.finishedAt,
            status: table.status,
            updatedAt: table.updatedAt,
          })
          .from(table)
          .where(eq(table.id, runId))
          .for("update");
        if (run === undefined) return null;
        const now = dependencies.now();
        if (isModelRunClosed(run, now)) throw new AgentModelRunClosedError();
        const [before] = await transaction
          .select({ events: count(), lastSeq: max(events.seq) })
          .from(events)
          .where(eq(events.runId, runId));
        const stored = before?.events ?? 0;
        const highest = before?.lastSeq ?? -1;
        // Seqs only increase, so a reader polling after its last seq never misses an event. A seq at
        // or below the highest stored one is accepted only as a retry of an event that exists.
        const low = [
          ...new Set(
            input
              .filter((event) => event.seq <= highest)
              .map((event) => event.seq)
          ),
        ];
        if (low.length > 0) {
          const existing = await transaction
            .select({ seq: events.seq })
            .from(events)
            .where(and(eq(events.runId, runId), inArray(events.seq, low)));
          if (existing.length < low.length)
            throw new AgentModelRunSeqError(highest);
        }
        let inserted: {
          kind: AgentModelRunEventKind;
          seq: number;
          title: string;
        }[];
        try {
          inserted = await transaction
            .insert(events)
            .values(
              input.map((event) => ({
                agent: event.agent,
                at: event.at ?? now,
                body: event.body ?? null,
                costUsd: event.costUsd ?? null,
                durationMs: event.durationMs ?? null,
                id: dependencies.generateId(),
                inputTokens: event.inputTokens ?? null,
                kind: event.kind,
                model: event.model ?? null,
                outputTokens: event.outputTokens ?? null,
                runId,
                seq: event.seq,
                title: event.title,
                toolName: event.toolName ?? null,
              }))
            )
            // An existing (run, seq) is kept as it was: retries never duplicate or overwrite.
            .onConflictDoNothing({ target: [events.runId, events.seq] })
            .returning({
              kind: events.kind,
              seq: events.seq,
              title: events.title,
            });
        } catch (error) {
          return mapModelRunWriteError(error, "append events");
        }
        if (stored + inserted.length > AGENT_MODEL_RUN_EVENTS_MAX)
          throw new AgentModelRunEventLimitError();
        // A flag event adds its slug to the run's flags once, and a stored event whose text was
        // redacted adds "redacted" (in this transaction). Beyond 16 flags the flag is not added.
        const redactedSeqs = new Set(
          input
            .filter((event) => event.redacted === true)
            .map((event) => event.seq)
        );
        const flags = uniqueValues([
          ...inserted
            .filter((event) => event.kind === "flag")
            .map((event) => event.title),
          ...(inserted.some((event) => redactedSeqs.has(event.seq))
            ? ["redacted"]
            : []),
        ]);
        for (const flag of flags) {
          const value = JSON.stringify([flag]);
          await transaction
            .update(table)
            .set({
              flags: sql`${table.flags} || ${value}::jsonb`,
              updatedAt: now,
            })
            .where(
              and(
                eq(table.id, runId),
                sql`not (${table.flags} @> ${value}::jsonb)`,
                sql`jsonb_array_length(${table.flags}) < 16`
              )
            );
        }
        const lastSeq = Math.max(
          highest,
          ...inserted.map((event) => event.seq)
        );
        return {
          appended: inserted.length,
          lastSeq: lastSeq < 0 ? null : lastSeq,
        };
      }),

    events: async (runId, afterSeq, limit) =>
      database
        .select(eventColumns)
        .from(events)
        .where(and(eq(events.runId, runId), sql`${events.seq} > ${afterSeq}`))
        .orderBy(asc(events.seq))
        .limit(clampLimit(limit, AGENT_MODEL_RUN_EVENTS_PAGE_MAX)),

    search: async (query, filters) => {
      try {
        return await database.transaction(async (transaction) => {
          // A common word can match many events: rank only the newest matches, and stop a slow query.
          await transaction.execute(
            sql.raw(
              `set local statement_timeout = ${AGENT_MODEL_RUN_SEARCH_TIMEOUT_MS}`
            )
          );
          const tsquery = sql`websearch_to_tsquery('english', ${query})`;
          const candidates = transaction
            .select({
              rank: sql<number>`ts_rank(${events.search}, ${tsquery})`.as(
                "rank"
              ),
              runId: events.runId,
            })
            .from(events)
            .innerJoin(table, eq(events.runId, table.id))
            .where(
              and(
                sql`${events.search} @@ ${tsquery}`,
                ...modelRunConditions(filters)
              )
            )
            .orderBy(desc(events.at))
            .limit(AGENT_MODEL_RUN_SEARCH_CANDIDATES)
            .as("candidates");
          const hits = await transaction
            .select({
              ...getTableColumns(table),
              rank: sql<number>`max("candidates"."rank")`
                .mapWith(Number)
                .as("rank"),
            })
            .from(table)
            .innerJoin(candidates, sql`"candidates"."run_id" = ${table.id}`)
            .groupBy(table.id)
            .orderBy(
              sql`"rank" desc`,
              desc(table.decisionDate),
              desc(table.createdAt)
            )
            .limit(AGENT_MODEL_RUN_SEARCH_MAX);
          if (hits.length === 0) return [];
          const ranked = transaction
            .select({
              agent: events.agent,
              document:
                sql<string>`${events.title} || ' ' || coalesce(${events.body}, '')`.as(
                  "document"
                ),
              kind: events.kind,
              place:
                sql<number>`row_number() over (partition by ${events.runId} order by ts_rank(${events.search}, ${tsquery}) desc, ${events.seq} asc)`.as(
                  "place"
                ),
              runId: events.runId,
              seq: events.seq,
            })
            .from(events)
            .where(
              and(
                inArray(
                  events.runId,
                  hits.map((hit) => hit.id)
                ),
                sql`${events.search} @@ ${tsquery}`
              )
            )
            .as("ranked");
          const snippets = await transaction
            .select({
              agent: sql<string>`"ranked"."agent"`,
              kind: sql<AgentModelRunEventKind>`"ranked"."kind"`,
              runId: sql<string>`"ranked"."run_id"`,
              seq: sql<number>`"ranked"."seq"`.mapWith(Number),
              // ts_headline parses its input as HTML and replaces tags such as <b> with a space.
              // Escaping & and < turns them into entity tokens, which it keeps; the outer
              // replaces undo the escaping, so the snippet matches the stored text.
              text: sql<string>`replace(replace(ts_headline('english', replace(replace("ranked"."document", '&', '&amp;'), '<', '&lt;'), ${tsquery}, ${`StartSel=${SEARCH_MATCH_START}, StopSel=${SEARCH_MATCH_STOP}, MaxWords=24, MinWords=8, MaxFragments=1`}), '&lt;', '<'), '&amp;', '&')`,
            })
            .from(ranked)
            .where(sql`"ranked"."place" <= ${AGENT_MODEL_RUN_SEARCH_SNIPPETS}`)
            .orderBy(sql`"ranked"."run_id"`, sql`"ranked"."place"`);
          return hits.map(({ rank, ...run }) => ({
            rank,
            run,
            snippets: snippets
              .filter((snippet) => snippet.runId === run.id)
              .map(({ runId: _runId, ...snippet }) => snippet),
          }));
        });
      } catch (error) {
        if (pgErrorCode(error) === "57014")
          throw new AgentModelRunSearchTimeoutError();
        throw error;
      }
    },

    breakdown: async (filters, groupBy) => {
      const inner = database
        .selectDistinct({
          id: table.id,
          rating: table.rating,
          status: table.status,
          costUsd: table.costUsd,
          key: facetValueSql(groupBy).as("key"),
        })
        .from(table)
        .where(whereOf(modelRunConditions(filters)))
        .as("grouped");
      const rows = await database
        .select({
          key: sql<string | null>`"grouped"."key"`,
          runs: sql<number>`count(*)`.mapWith(Number),
          rated:
            sql<number>`count(*) filter (where "grouped"."rating" is not null)`.mapWith(
              Number
            ),
          holds:
            sql<number>`count(*) filter (where "grouped"."rating" = 'hold')`.mapWith(
              Number
            ),
          failed:
            sql<number>`count(*) filter (where "grouped"."status" = 'failed')`.mapWith(
              Number
            ),
          totalCostUsd:
            sql<number>`coalesce(sum("grouped"."cost_usd"), 0)`.mapWith(Number),
        })
        .from(inner)
        .groupBy(sql`"grouped"."key"`)
        .orderBy(sql`2 desc`, sql`1 asc nulls last`)
        .limit(AGENT_MODEL_RUN_BREAKDOWN_MAX);
      return rows.map((row) => ({
        avgCostUsd: row.totalCostUsd / row.runs,
        failed: row.failed,
        holdShare: row.rated === 0 ? null : row.holds / row.rated,
        key: row.key,
        rated: row.rated,
        runs: row.runs,
        totalCostUsd: row.totalCostUsd,
      }));
    },

    facets: async (filters) => {
      const entries: [AgentModelRunFacet, AgentModelRunFacetValue[]][] = [];
      // Sequential on purpose: the request scope may hold a single connection.
      for (const facet of AGENT_MODEL_RUN_FACETS)
        entries.push([facet, await facetCounts(filters, facet)]);
      return Object.fromEntries(entries) as Record<
        AgentModelRunFacet,
        AgentModelRunFacetValue[]
      >;
    },

    get,

    list: async ({ filters, limit, cursor }) => {
      const size = clampLimit(limit, AGENT_MODEL_RUN_EXPORT_MAX);
      const conditions = modelRunConditions(filters);
      if (cursor !== undefined) {
        const [date, createdAt, id] = decodeModelRunCursor(cursor);
        conditions.push(
          sql`(${table.decisionDate}, ${table.createdAt}, ${table.id}) < (${date}::date, ${createdAt.toISOString()}::timestamptz, ${id})`
        );
      }
      const rows = await database
        .select()
        .from(table)
        .where(whereOf(conditions))
        .orderBy(
          desc(table.decisionDate),
          desc(table.createdAt),
          desc(table.id)
        )
        .limit(size + 1);
      const runs = rows.slice(0, size);
      const last = runs.at(-1);
      return {
        nextCursor:
          rows.length > size && last !== undefined
            ? encodeModelRunCursor(last)
            : null,
        runs,
      };
    },

    record: async (input) => {
      const rating = input.rating ?? null;
      const status = input.status ?? "queued";
      const now = dependencies.now();
      const values = {
        analysts: uniqueValues(input.analysts ?? []),
        batch: input.batch ?? null,
        costUsd: input.costUsd ?? 0,
        createdAt: now,
        dataSource: input.dataSource ?? null,
        decisionDate: input.decisionDate,
        durationMs: input.durationMs ?? null,
        entryPrice: input.entryPrice ?? null,
        error: input.error ?? null,
        finishedAt:
          input.finishedAt ?? (isTerminalModelRunStatus(status) ? now : null),
        flags: uniqueValues(input.flags ?? []),
        framework: input.framework,
        frameworkVersion: input.frameworkVersion ?? null,
        horizon: input.horizon ?? null,
        id: dependencies.generateId(),
        inputTokens: input.inputTokens ?? 0,
        llmCalls: input.llmCalls ?? 0,
        memory: input.memory ?? false,
        model: input.model,
        modelsServed: [...(input.modelsServed ?? [])],
        outputTokens: input.outputTokens ?? 0,
        provider: input.provider,
        purpose: input.purpose ?? "live",
        rating,
        ratingSource: resolveRatingSource(rating, input.ratingSource),
        runKey: input.runKey,
        startedAt: input.startedAt ?? (status === "queued" ? null : now),
        status,
        stopPrice: input.stopPrice ?? null,
        targetPrice: input.targetPrice ?? null,
        taskId: input.taskId ?? null,
        ticker: input.ticker,
        toolCalls: input.toolCalls ?? 0,
        updatedAt: now,
        variant: input.variant ?? null,
      };
      try {
        const [created] = await database
          .insert(table)
          .values(values)
          .onConflictDoNothing({ target: table.runKey })
          .returning();
        if (created !== undefined) return { created: true, run: created };
        // Same run key: the first record wins and is returned unchanged.
        const [existing] = await database
          .select()
          .from(table)
          .where(eq(table.runKey, input.runKey))
          .limit(1);
        if (existing === undefined)
          throw new AgentModelRunStorageError("record (key vanished)");
        return { created: false, run: existing };
      } catch (error) {
        if (error instanceof AgentModelRunStorageError) throw error;
        return mapModelRunWriteError(error, "record");
      }
    },

    update: async (input) => {
      const now = dependencies.now();
      const changes: Record<string, unknown> = { updatedAt: now };
      const copy = (key: keyof AgentModelRunUpdateInput & string) => {
        const value = input[key];
        if (value !== undefined) changes[key] = value;
      };
      for (const key of [
        "status",
        "error",
        "entryPrice",
        "stopPrice",
        "targetPrice",
        "horizon",
        "inputTokens",
        "outputTokens",
        "llmCalls",
        "toolCalls",
        "costUsd",
        "durationMs",
      ] as const)
        copy(key);
      if (input.modelsServed !== undefined)
        changes["modelsServed"] = [...input.modelsServed];
      if (input.flags !== undefined)
        changes["flags"] = uniqueValues(input.flags);
      if (input.rating !== undefined) {
        changes["rating"] = input.rating;
        changes["ratingSource"] = resolveRatingSource(
          input.rating,
          input.ratingSource
        );
      } else if (input.ratingSource !== undefined) {
        // The stored rating decides whether this source fits (the column check enforces it).
        changes["ratingSource"] = input.ratingSource;
      }
      if (input.startedAt !== undefined) changes["startedAt"] = input.startedAt;
      else if (input.status !== undefined && input.status !== "queued")
        changes["startedAt"] =
          sql`coalesce(${table.startedAt}, ${now.toISOString()}::timestamptz)`;
      // A terminal status always has a finish time: the one given, the stored one or now.
      if (input.status !== undefined && isTerminalModelRunStatus(input.status))
        changes["finishedAt"] =
          input.finishedAt ??
          sql`coalesce(${table.finishedAt}, ${now.toISOString()}::timestamptz)`;
      else if (input.finishedAt !== undefined)
        changes["finishedAt"] = input.finishedAt;
      // A finished run is final: only the rating, its source and the flags may still change.
      // Times filled in by coalesce keep a stored value, so repeating a terminal status is allowed.
      const restricted = Object.entries(changes).some(
        ([key, value]) => !(TERMINAL_EDITABLE.has(key) || is(value, SQL))
      );
      const conditions = [eq(table.id, input.id)];
      if (input.status !== undefined)
        conditions.push(
          inArray(table.status, modelRunSourcesFor(input.status))
        );
      if (restricted)
        conditions.push(inArray(table.status, ["queued", "running"]));
      const where = and(...conditions);
      let updated: AgentModelRun | undefined;
      try {
        [updated] = await database
          .update(table)
          .set(changes)
          .where(where)
          .returning();
      } catch (error) {
        return mapModelRunWriteError(error, "update");
      }
      if (updated !== undefined) return updated;
      const current = await get(input.id);
      if (current === null) return null;
      if (
        input.status !== undefined &&
        !modelRunSourcesFor(input.status).includes(current.status)
      )
        throw new AgentModelRunStateError(current.status, input.status);
      if (restricted && isTerminalModelRunStatus(current.status))
        throw new AgentModelRunStateError(
          current.status,
          current.status,
          `run is ${current.status}; only rating, ratingSource and flags can change`
        );
      // The row changed between the update and this read; the caller may retry.
      return null;
    },
  };
};
