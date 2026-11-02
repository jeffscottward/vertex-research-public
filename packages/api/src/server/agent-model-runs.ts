import {
  AGENT_MODEL_RUN_EVENTS_PAGE_MAX,
  AGENT_MODEL_RUN_EXPORT_MAX,
  type AgentModelRunAppendResult,
  AgentModelRunClosedError,
  AgentModelRunEventLimitError,
  type AgentModelRunEventInput,
  AgentModelRunSearchTimeoutError,
  AgentModelRunSeqError,
  type AgentModelRunEventRecord,
  type AgentModelRunFacets,
  AgentModelRunInputError,
  type AgentModelRunFilters,
  type AgentModelRunsRepository,
  AgentModelRunStateError,
  AgentModelRunStorageError,
  horizonBucketOf,
  isModelRunClosed,
  isTerminalModelRunStatus,
  SEARCH_MATCH_START,
  SEARCH_MATCH_STOP,
} from "@darkfactory/db/server";
import type { AgentModelRun } from "@darkfactory/db/schema";
import {
  containsCredential,
  scrubSecretText,
} from "@darkfactory/observability";
import { implement } from "@orpc/server";

import { AGENT_FRAMEWORKS } from "../agent-frameworks.ts";
import {
  type BenchmarkBars,
  benchmarkPairTickers,
  computeBenchmark,
} from "../agent-model-benchmark.ts";
import { modelRunsCsv, modelRunsCsvFilename } from "../agent-model-runs-csv.ts";
import { appContract } from "../contract.ts";
import {
  AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX,
  AGENT_MODEL_BENCHMARK_RUNS_MAX,
  AGENT_MODEL_RUN_CLOCK_SKEW_MS,
  AGENT_MODEL_RUN_FACET_VALUES,
  type AgentModelRunEventOutput,
  type AgentModelRunOutput,
} from "../contracts/agent-model-runs.ts";
import type { ApiContext } from "./context.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";

// Operator-only (requireOperator), like agentOps.*: a session operator or an operator API key. Read
// keys may list, get, break down and export; record and update need a write key. Research only:
// nothing here reads or writes an order, intent or position.

const api = implement(appContract).$context<ApiContext>();

type ErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RUN_CLOSED"
  | "EVENT_LIMIT"
  | "SEQ_CONFLICT"
  | "SEARCH_TIMEOUT"
  | "STORAGE_ERROR";
type ErrorFactories = Readonly<
  Record<ErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): ErrorFactories => errors as ErrorFactories;

const repositoryFor = (
  context: ApiContext,
  errors: unknown
): AgentModelRunsRepository => {
  const repository = context.repositories.agentModelRuns;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof AgentModelRunInputError)
    throw failures.VALIDATION_ERROR({ message: error.message });
  if (error instanceof AgentModelRunStateError)
    throw failures.CONFLICT({ message: error.message });
  if (error instanceof AgentModelRunClosedError) throw failures.RUN_CLOSED();
  if (error instanceof AgentModelRunEventLimitError)
    throw failures.EVENT_LIMIT();
  if (error instanceof AgentModelRunSeqError)
    throw failures.SEQ_CONFLICT({ message: error.message });
  if (error instanceof AgentModelRunSearchTimeoutError)
    throw failures.SEARCH_TIMEOUT();
  if (error instanceof AgentModelRunStorageError)
    throw failures.STORAGE_ERROR();
  throw error;
};

export const toAgentModelRunOutput = (
  run: AgentModelRun
): AgentModelRunOutput => ({
  id: run.id,
  runKey: run.runKey,
  taskId: run.taskId,
  framework: run.framework,
  frameworkVersion: run.frameworkVersion,
  provider: run.provider,
  model: run.model,
  modelsServed: run.modelsServed.map((entry) => ({
    requested: entry.requested,
    served: entry.served,
  })),
  ticker: run.ticker,
  decisionDate: run.decisionDate,
  analysts: [...run.analysts],
  rating: run.rating,
  ratingSource: run.ratingSource,
  entryPrice: run.entryPrice,
  stopPrice: run.stopPrice,
  targetPrice: run.targetPrice,
  horizon: run.horizon,
  horizonBucket: horizonBucketOf(run.horizon),
  status: run.status,
  error: run.error,
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  llmCalls: run.llmCalls,
  toolCalls: run.toolCalls,
  costUsd: run.costUsd,
  durationMs: run.durationMs,
  flags: [...run.flags],
  batch: run.batch,
  purpose: run.purpose,
  variant: run.variant,
  memory: run.memory,
  dataSource: run.dataSource,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

const toEventOutput = (
  event: AgentModelRunEventRecord
): AgentModelRunEventOutput => ({
  id: event.id,
  runId: event.runId,
  seq: event.seq,
  at: event.at,
  agent: event.agent,
  kind: event.kind,
  title: event.title,
  body: event.body,
  model: event.model,
  toolName: event.toolName,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  costUsd: event.costUsd,
  durationMs: event.durationMs,
});

// Splits ts_headline output into plain segments; `match` marks the words that matched the query.
export const highlightSegments = (
  text: string
): { text: string; match: boolean }[] => {
  const segments: { text: string; match: boolean }[] = [];
  const [lead = "", ...marked] = text.split(SEARCH_MATCH_START);
  if (lead !== "") segments.push({ match: false, text: lead });
  for (const part of marked) {
    const stop = part.indexOf(SEARCH_MATCH_STOP);
    const matched = stop === -1 ? part : part.slice(0, stop);
    const rest = stop === -1 ? "" : part.slice(stop + 1);
    if (matched !== "") segments.push({ match: true, text: matched });
    if (rest !== "") segments.push({ match: false, text: rest });
  }
  return segments;
};

// One page of events after `afterSeq`, the run (status and usage) and whether polling can stop.
const eventPage = async (
  repository: AgentModelRunsRepository,
  errors: unknown,
  runId: string,
  afterSeq: number,
  limit: number
) => {
  let run: AgentModelRun | null;
  let rows: AgentModelRunEventRecord[];
  try {
    run = await repository.get(runId);
    rows = run === null ? [] : await repository.events(runId, afterSeq, limit);
  } catch (error) {
    return mapError(error, errors);
  }
  if (run === null) throw factories(errors).NOT_FOUND();
  return {
    // done: finished, nothing left to read, and the late-event window has closed.
    done:
      isTerminalModelRunStatus(run.status) &&
      rows.length < limit &&
      isModelRunClosed(run, new Date()),
    events: rows.map(toEventOutput),
    nextSeq: rows.at(-1)?.seq ?? afterSeq,
    run: toAgentModelRunOutput(run),
  };
};

const EVENT_TEXT_LIMITS = {
  agent: 100,
  body: 16_000,
  model: 200,
  title: 300,
  toolName: 100,
} as const;

type EventTextField = keyof typeof EVENT_TEXT_LIMITS;

type EventInputShape = Readonly<{
  [K in keyof AgentModelRunEventInput]?: AgentModelRunEventInput[K] | undefined;
}> &
  Pick<AgentModelRunEventInput, "agent" | "kind" | "seq" | "title">;

// Scrubs secrets and personal values from every text field of one event and marks it redacted
// when anything changed. A scrubbed text is cut back to its column limit.
const scrubEvent = (event: EventInputShape): AgentModelRunEventInput => {
  let redacted = false;
  const scrub = (field: EventTextField, value: string): string => {
    const clean = scrubSecretText(value).slice(0, EVENT_TEXT_LIMITS[field]);
    if (clean !== value) redacted = true;
    return clean;
  };
  const optional = (field: EventTextField, value: string | null | undefined) =>
    value === undefined || value === null ? value : scrub(field, value);
  const scrubbed = {
    ...defined(event),
    agent: scrub("agent", event.agent),
    body: optional("body", event.body),
    kind: event.kind,
    model: optional("model", event.model),
    seq: event.seq,
    title: scrub("title", event.title),
    toolName: optional("toolName", event.toolName),
  };
  return {
    ...defined(scrubbed),
    agent: scrubbed.agent,
    kind: event.kind,
    seq: event.seq,
    title: scrubbed.title,
    redacted,
  };
};

// Error text often quotes provider responses. Secrets and personal values are replaced by the shared
// log redaction detectors before storage; blank text is stored as null.
const storedError = (
  error: string | null | undefined
): string | null | undefined => {
  if (error === undefined || error === null) return error;
  return error === "" ? null : scrubSecretText(error);
};

// Copies only the keys that are present: the repository reads an absent key as "no filter" or
// "no change", and exactOptionalPropertyTypes keeps undefined out of those objects.
const defined = <T extends Record<string, unknown>>(
  input: T
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };

type FilterInput = Readonly<{
  [K in keyof AgentModelRunFilters]?: AgentModelRunFilters[K] | undefined;
}>;

const filtersOf = (input: FilterInput): AgentModelRunFilters =>
  defined({
    batch: input.batch,
    decisionFrom: input.decisionFrom,
    decisionTo: input.decisionTo,
    flags: input.flags,
    framework: input.framework,
    horizonBucket: input.horizonBucket,
    model: input.model,
    provider: input.provider,
    purpose: input.purpose,
    rating: input.rating,
    servedModel: input.servedModel,
    status: input.status,
    ticker: input.ticker,
    variant: input.variant,
  });

// Facets left out (a cursor page or includeFacets: false) come back as empty lists.
const NO_FACETS = Object.fromEntries(
  AGENT_MODEL_RUN_FACET_VALUES.map((facet) => [facet, []])
) as unknown as AgentModelRunFacets;

// A run cannot report a start or finish time in the future (beyond a small clock skew).
const requirePastTimes = (
  input: Readonly<{
    startedAt?: Date | null | undefined;
    finishedAt?: Date | null | undefined;
  }>,
  errors: unknown
): void => {
  const limit = Date.now() + AGENT_MODEL_RUN_CLOCK_SKEW_MS;
  for (const [name, value] of [
    ["startedAt", input.startedAt],
    ["finishedAt", input.finishedAt],
  ] as const)
    if (value !== undefined && value !== null && value.getTime() > limit)
      throw factories(errors).VALIDATION_ERROR({
        message: `${name} is in the future`,
      });
};

const record = api.agentModelRuns.record
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    requirePastTimes(input, errors);
    try {
      const { run } = await repository.record({
        ...defined({ ...input, error: storedError(input.error) }),
        decisionDate: input.decisionDate,
        framework: input.framework,
        model: input.model,
        provider: input.provider,
        runKey: input.runKey,
        ticker: input.ticker,
      });
      return toAgentModelRunOutput(run);
    } catch (error) {
      return mapError(error, errors);
    }
  });

const update = api.agentModelRuns.update
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    requirePastTimes(input, errors);
    let run: AgentModelRun | null;
    try {
      run = await repository.update({
        ...defined({ ...input, error: storedError(input.error) }),
        id: input.id,
      });
    } catch (error) {
      return mapError(error, errors);
    }
    if (run === null) throw factories(errors).NOT_FOUND();
    return toAgentModelRunOutput(run);
  });

const list = api.agentModelRuns.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    const filters = filtersOf(input);
    try {
      const page = await repository.list({
        filters,
        limit: input.limit ?? 50,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const facets =
        (input.includeFacets ?? input.cursor === undefined)
          ? await repository.facets(filters)
          : NO_FACETS;
      return {
        facets,
        nextCursor: page.nextCursor,
        runs: page.runs.map(toAgentModelRunOutput),
      };
    } catch (error) {
      return mapError(error, errors);
    }
  });

const breakdown = api.agentModelRuns.breakdown
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      return {
        groupBy: input.groupBy,
        rows: await repository.breakdown(filtersOf(input), input.groupBy),
      };
    } catch (error) {
      return mapError(error, errors);
    }
  });

const exportCsv = api.agentModelRuns.exportCsv
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const page = await repository.list({
        filters: filtersOf(input),
        limit: AGENT_MODEL_RUN_EXPORT_MAX,
      });
      return {
        csv: modelRunsCsv(page.runs.map(toAgentModelRunOutput)),
        filename: modelRunsCsvFilename(new Date()),
        rowCount: page.runs.length,
        truncated: page.nextCursor !== null,
      };
    } catch (error) {
      return mapError(error, errors);
    }
  });

// Daily bars for the paired comparison, read from the imported market bars. A ticker without bars,
// past the ticker cap or with a storage failure is left out of the map; the benchmark counts its
// cells as excluded instead of failing the whole read.
const benchmarkBars = async (
  context: ApiContext,
  tickers: readonly string[]
): Promise<Map<string, BenchmarkBars>> => {
  const bars = new Map<string, BenchmarkBars>();
  const repository = context.repositories.marketBars;
  if (repository === undefined) return bars;
  // Sequential on purpose: the request scope may hold a single connection.
  for (const ticker of tickers.slice(0, AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX))
    try {
      const series = await repository.getSeries(ticker, "1d");
      if (series !== null)
        bars.set(ticker, (await columnsFor(repository, series)).columns);
    } catch {
      // Counted as missing bars.
    }
  return bars;
};

const benchmark = api.agentModelRuns.benchmark
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const page = await repository.list({
        filters: filtersOf(input),
        limit: AGENT_MODEL_BENCHMARK_RUNS_MAX,
      });
      const runs = page.runs.map(toAgentModelRunOutput);
      const options = {
        armBy: input.armBy,
        baselineArm: input.baselineArm,
        pair: input.pair,
      };
      const bars = await benchmarkBars(
        context,
        benchmarkPairTickers(runs, options)
      );
      return computeBenchmark(runs, options, bars, page.nextCursor !== null);
    } catch (error) {
      return mapError(error, errors);
    }
  });

const get = api.agentModelRuns.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) =>
    eventPage(
      repositoryFor(context, errors),
      errors,
      input.id,
      -1,
      AGENT_MODEL_RUN_EVENTS_PAGE_MAX
    )
  );

const appendEvents = api.agentModelRuns.appendEvents
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    // Model text is stored scrubbed by the shared redaction detectors (the run gets the "redacted"
    // flag). Only a high-precision credential (private key, Bearer/Basic, URL password) refuses
    // the batch, naming the event to fix.
    const leaked = input.events.find((event) =>
      [event.title, event.body, event.agent, event.model, event.toolName].some(
        (text) => typeof text === "string" && containsCredential(text)
      )
    );
    if (leaked !== undefined)
      throw factories(errors).VALIDATION_ERROR({
        message: `Event seq ${leaked.seq} contains a credential; remove it and send it again`,
      });
    const prepared = input.events.map((event) => scrubEvent(event));
    let result: AgentModelRunAppendResult | null;
    try {
      result = await repository.appendEvents(input.runId, prepared);
    } catch (error) {
      return mapError(error, errors);
    }
    if (result === null) throw factories(errors).NOT_FOUND();
    return {
      ...result,
      redactedSeqs: prepared
        .filter((event) => event.redacted === true)
        .map((event) => event.seq),
    };
  });

const events = api.agentModelRuns.events
  .use(requireOperator)
  .handler(async ({ context, input, errors }) =>
    eventPage(
      repositoryFor(context, errors),
      errors,
      input.runId,
      input.afterSeq ?? -1,
      input.limit ?? 200
    )
  );

const search = api.agentModelRuns.search
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const hits = await repository.search(input.query, filtersOf(input));
      return {
        results: hits.map((hit) => ({
          rank: hit.rank,
          run: toAgentModelRunOutput(hit.run),
          snippets: hit.snippets.map((snippet) => ({
            agent: snippet.agent,
            kind: snippet.kind,
            segments: highlightSegments(snippet.text),
            seq: snippet.seq,
          })),
        })),
      };
    } catch (error) {
      return mapError(error, errors);
    }
  });

// Static reference sheets; no repository read, so storage outages never hide them.
const frameworks = api.agentModelRuns.frameworks
  .use(requireOperator)
  .handler(() => ({ frameworks: [...AGENT_FRAMEWORKS] }));

export const agentModelRunsRouter = {
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
