import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type AgentOpsRepository,
  type BacktestResultSummary,
  type BacktestResultsRepository,
  type BacktestTrialLedger,
  type MarketBarColumns,
  type ResearchPapersRepository,
} from "@darkfactory/db/server";
import type {
  AgentTask,
  AgentTaskEvent,
  BacktestResult,
  ResearchPaper,
} from "@darkfactory/db/schema";
import { implement } from "@orpc/server";

import { evaluateAgentRatings } from "../agent-rating-placebo.ts";
import { computeBacktestAnalytics } from "../backtest-analytics.ts";
import { appContract } from "../contract.ts";
import {
  type AgentTaskEventOutput,
  type AgentTaskOutput,
  type BacktestResultOutput,
  type BacktestResultSummaryOutput,
  type RatingEvaluationOutput,
  RatingEvaluationSchema,
  type ResearchPaperOutput,
} from "../contracts/agent-ops.ts";
import {
  ArxivInputError,
  ArxivNotFoundError,
  ArxivUpstreamError,
  arxivNotes,
  fetchArxivMetadata,
  parseArxivReference,
  type FetchArxivOptions,
} from "./arxiv.ts";
import type { ApiContext } from "./context.ts";
import {
  DeployStatusNotConfiguredError,
  DeployStatusUpstreamError,
  fetchDeploymentSnapshot,
  type FetchDeployStatusOptions,
} from "./deploy-status.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";

// Workspace-scoped and operator-only: every procedure uses requireOperator (active, email-verified,
// on VERTEX_OPERATOR_EMAILS). Inputs never carry a user id. Agents may instead authenticate with an
// operator-issued API key (x-api-key header); the key owner is re-checked against the allow-list on
// every request, and the handler interceptor limits key requests to agentOps.*, papers.* and strategyLibrary.*.

const api = implement(appContract).$context<ApiContext>();

type AgentOpsErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR"
  | "UPSTREAM_ERROR"
  | "NOT_CONFIGURED";

type AgentOpsErrorFactories = Readonly<
  Record<AgentOpsErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): AgentOpsErrorFactories => {
  return errors as AgentOpsErrorFactories;
};

const agentOpsFor = (
  context: ApiContext,
  errors: unknown
): AgentOpsRepository => {
  const repository = context.repositories.agentOps;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const papersFor = (
  context: ApiContext,
  errors: unknown
): ResearchPapersRepository => {
  const repository = context.repositories.researchPapers;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const backtestsFor = (
  context: ApiContext,
  errors: unknown
): BacktestResultsRepository => {
  const repository = context.repositories.backtestResults;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapAgentOpsError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({ message: error.message });
  }
  if (error instanceof DatabaseConflictError) throw failures.CONFLICT();
  if (error instanceof DatabasePersistenceError) throw failures.STORAGE_ERROR();
  throw error;
};

export const toAgentTaskOutput = (task: AgentTask): AgentTaskOutput => ({
  id: task.id,
  kind: task.kind,
  agent: task.agent,
  title: task.title,
  summary: task.summary ?? null,
  status: task.status,
  metrics: { ...(task.metrics ?? {}) },
  links: (task.links ?? []).map((link) => ({
    label: link.label,
    url: link.url,
  })),
  paperId: task.paperId ?? null,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  startedAt: task.startedAt ?? null,
  finishedAt: task.finishedAt ?? null,
});

const toAgentTaskEventOutput = (
  event: AgentTaskEvent
): AgentTaskEventOutput => ({
  id: event.id,
  taskId: event.taskId,
  at: event.at,
  level: event.level,
  message: event.message,
});

const toResearchPaperOutput = (paper: ResearchPaper): ResearchPaperOutput => ({
  id: paper.id,
  title: paper.title,
  authors: paper.authors ?? null,
  year: paper.year ?? null,
  sourceUrl: paper.sourceUrl ?? null,
  identifier: paper.identifier ?? null,
  kind: paper.kind,
  stage: paper.stage,
  verdict: paper.verdict,
  blockers: paper.blockers ?? null,
  notes: paper.notes ?? null,
  reportedMetrics: { ...(paper.reportedMetrics ?? {}) },
  reproducedMetrics: { ...(paper.reproducedMetrics ?? {}) },
  createdAt: paper.createdAt,
  updatedAt: paper.updatedAt,
});

const backtestSummaryFields = (
  row: BacktestResultSummary | BacktestResult
) => ({
  id: row.id,
  taskId: row.taskId,
  paperId: row.paperId ?? null,
  strategyId: row.strategyId ?? null,
  strategy: row.strategy,
  instruments: row.instruments,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  dataSource: row.dataSource,
  isSplit: row.isSplit ?? null,
  metrics: { ...(row.metrics ?? {}) },
  maxDrawdown: row.maxDrawdown ?? null,
  tradeCount: row.tradeCount,
  notes: row.notes ?? null,
  createdAt: row.createdAt,
});

export const toBacktestSummaryOutput = (
  row: BacktestResultSummary,
  taskTitle: string | null
): BacktestResultSummaryOutput => ({
  ...backtestSummaryFields(row),
  pointCount: Number(row.pointCount),
  foldCount: Number(row.foldCount),
  taskTitle,
});

const toBacktestOutput = (
  row: BacktestResult,
  ledger: BacktestTrialLedger | null,
  ratingEvaluation: RatingEvaluationOutput | null
): BacktestResultOutput => {
  const equity = row.equity ?? [];
  const trades = row.trades ?? [];
  const runConfig = row.runConfig ?? null;
  const benchmark = row.benchmark ?? null;
  return {
    ...backtestSummaryFields(row),
    equity,
    drawdown: row.drawdown ?? [],
    trades,
    folds: row.folds ?? [],
    runConfig,
    benchmark,
    ratingSeries: row.ratingSeries ?? null,
    ratingEvaluation,
    analytics: computeBacktestAnalytics({
      id: row.id,
      equity,
      trades,
      initialCapital: runConfig?.initialCapital ?? null,
      benchmark: benchmark?.points ?? null,
      ledger,
    }),
  };
};

// Replays a stored rating series against the imported daily bars (research only; never an order).
// A missing series, a storage failure or a failed evaluation reports the evaluation as unavailable;
// it never fails the whole read, and never reports a stored result as failed (a retry of record
// would add a duplicate trial). The result is checked against the output schema here for the
// same reason.
const ratingEvaluationFor = async (
  context: ApiContext,
  row: BacktestResult
): Promise<RatingEvaluationOutput | null> => {
  const series = row.ratingSeries ?? null;
  if (series === null) return null;
  const repository = context.repositories.marketBars;
  if (repository === undefined)
    return { status: "unavailable", reason: "no_bars" };
  let bars: MarketBarColumns;
  try {
    const stored = await repository.getSeries(
      series.symbol.toUpperCase(),
      "1d"
    );
    if (stored === null) return { status: "unavailable", reason: "no_bars" };
    bars = (await columnsFor(repository, stored)).columns;
  } catch {
    return { status: "unavailable", reason: "storage_error" };
  }
  try {
    return RatingEvaluationSchema.parse(
      evaluateAgentRatings({ bars, series, seedKey: row.id })
    );
  } catch {
    return { status: "unavailable", reason: "evaluation_error" };
  }
};

const agentOpsSummary = api.agentOps.summary
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = agentOpsFor(context, errors);
    try {
      const summary = await repository.summary();
      return {
        statusCounts: summary.statusCounts,
        failedLast24h: summary.failedLast24h,
        paperStageCounts: summary.paperStageCounts,
        latestEvents: summary.latestEvents.map((event) => ({
          ...toAgentTaskEventOutput(event),
          taskTitle: event.taskTitle,
          taskKind: event.taskKind,
        })),
      };
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const agentOpsTasksList = api.agentOps.tasks.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = agentOpsFor(context, errors);
    try {
      const tasks = await repository.listTasks({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { tasks: tasks.map(toAgentTaskOutput) };
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const agentOpsTasksGet = api.agentOps.tasks.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = agentOpsFor(context, errors);
    let found: Awaited<ReturnType<AgentOpsRepository["getTask"]>>;
    try {
      found = await repository.getTask(input.id);
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    if (found === null) throw factories(errors).NOT_FOUND();
    return {
      task: toAgentTaskOutput(found.task),
      events: found.events.map(toAgentTaskEventOutput),
    };
  });

const agentOpsTasksCreate = api.agentOps.tasks.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = agentOpsFor(context, errors);
    try {
      const task = await repository.createTask({
        kind: input.kind,
        agent: input.agent,
        title: input.title,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
        ...(input.links === undefined ? {} : { links: input.links }),
        ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
      });
      return toAgentTaskOutput(task);
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const agentOpsTasksUpdate = api.agentOps.tasks.update
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = agentOpsFor(context, errors);
    let task: AgentTask | null;
    try {
      task = await repository.updateTask({
        id: input.id,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
        ...(input.links === undefined ? {} : { links: input.links }),
        ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
      });
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    if (task === null) throw factories(errors).NOT_FOUND();
    return toAgentTaskOutput(task);
  });

const agentOpsTasksAppendEvent = api.agentOps.tasks.appendEvent
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = agentOpsFor(context, errors);
    let event: AgentTaskEvent | null;
    try {
      event = await repository.appendEvent({
        taskId: input.taskId,
        message: input.message,
        ...(input.level === undefined ? {} : { level: input.level }),
      });
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    if (event === null) throw factories(errors).NOT_FOUND();
    return toAgentTaskEventOutput(event);
  });

const papersList = api.papers.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = papersFor(context, errors);
    try {
      const papers = await repository.list();
      return { papers: papers.map(toResearchPaperOutput) };
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const papersAdd = api.papers.add
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = papersFor(context, errors);
    try {
      const paper = await repository.add({
        title: input.title,
        ...(input.sourceUrl === undefined
          ? {}
          : { sourceUrl: input.sourceUrl }),
        ...(input.authors === undefined ? {} : { authors: input.authors }),
        ...(input.year === undefined ? {} : { year: input.year }),
        ...(input.identifier === undefined
          ? {}
          : { identifier: input.identifier }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
      });
      return toResearchPaperOutput(paper);
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const papersUpdate = api.papers.update
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = papersFor(context, errors);
    let paper: ResearchPaper | null;
    try {
      paper = await repository.update({
        id: input.id,
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
        ...(input.blockers === undefined ? {} : { blockers: input.blockers }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.reportedMetrics === undefined
          ? {}
          : { reportedMetrics: input.reportedMetrics }),
        ...(input.reproducedMetrics === undefined
          ? {}
          : { reproducedMetrics: input.reproducedMetrics }),
      });
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    if (paper === null) throw factories(errors).NOT_FOUND();
    return toResearchPaperOutput(paper);
  });

const agentOpsBacktestsRecord = api.agentOps.backtests.record
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = backtestsFor(context, errors);
    let row: BacktestResult;
    try {
      row = await repository.record({
        taskId: input.taskId,
        paperId: input.paperId ?? null,
        strategyId: input.strategyId ?? null,
        strategy: input.strategy,
        instruments: input.instruments,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dataSource: input.dataSource,
        isSplit: input.isSplit ?? null,
        metrics: input.metrics ?? {},
        equity: input.equity ?? [],
        trades: input.trades ?? [],
        folds: input.folds ?? [],
        notes: input.notes ?? null,
        runConfig: input.runConfig ?? null,
        benchmark: input.benchmark ?? null,
        ratingSeries: input.ratingSeries ?? null,
      });
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    // The ledger is read on backtests.get only: a failed ledger read must never report a
    // stored result as failed (a retry would add a duplicate trial).
    return toBacktestOutput(row, null, await ratingEvaluationFor(context, row));
  });

// Resolves ledger task titles for summary rows (one list call plus at most 50 lookups).
export const toBacktestSummariesWithTitles = async (
  tasks: AgentOpsRepository,
  rows: readonly BacktestResultSummary[]
): Promise<BacktestResultSummaryOutput[]> => {
  if (rows.length === 0) return [];
  const titles = new Map<string, string | null>(
    (await tasks.listTasks({ kind: "backtest", limit: 200 })).map((task) => [
      task.id,
      task.title,
    ])
  );
  const missing = [
    ...new Set(rows.map((row) => row.taskId).filter((id) => !titles.has(id))),
  ];
  for (const id of missing.slice(0, 50)) {
    const found = await tasks.getTask(id);
    titles.set(id, found?.task.title ?? null);
  }
  return rows.map((row) =>
    toBacktestSummaryOutput(row, titles.get(row.taskId) ?? null)
  );
};

const agentOpsBacktestsList = api.agentOps.backtests.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = backtestsFor(context, errors);
    const tasks = agentOpsFor(context, errors);
    try {
      const rows = await repository.list({
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
        ...(input.strategyId === undefined
          ? {}
          : { strategyId: input.strategyId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { backtests: await toBacktestSummariesWithTitles(tasks, rows) };
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
  });

const agentOpsBacktestsGet = api.agentOps.backtests.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = backtestsFor(context, errors);
    let row: BacktestResult | null;
    let task: AgentTask | null = null;
    let ledger: BacktestTrialLedger | null = null;
    try {
      row = await repository.get(input.id);
      if (row !== null) {
        task =
          (await agentOpsFor(context, errors).getTask(row.taskId))?.task ??
          null;
        ledger = await repository.trialLedger(row);
      }
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    if (row === null || ledger === null) throw factories(errors).NOT_FOUND();
    return {
      backtest: toBacktestOutput(
        row,
        ledger,
        await ratingEvaluationFor(context, row)
      ),
      task: task === null ? null : toAgentTaskOutput(task),
    };
  });

// Network options are injectable for tests; production uses globalThis.fetch against export.arxiv.org only.
let arxivFetchOptions: FetchArxivOptions = {};
export const setArxivFetchOptionsForTesting = (
  options: FetchArxivOptions
): void => {
  arxivFetchOptions = options;
};

const papersAddFromArxiv = api.papers.addFromArxiv
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = factories(errors);
    const repository = papersFor(context, errors);
    let reference: ReturnType<typeof parseArxivReference>;
    try {
      reference = parseArxivReference(input.arxiv);
    } catch (error) {
      if (error instanceof ArxivInputError)
        throw failures.VALIDATION_ERROR({ message: error.message });
      throw error;
    }
    const findExisting = async (): Promise<ResearchPaper | null> => {
      const rows = await repository.findByArxivId(reference.baseId);
      if (reference.version === null) return rows[0] ?? null;
      return (
        rows.find(
          (row) =>
            row.identifier === `arXiv:${reference.baseId}v${reference.version}`
        ) ??
        rows.find((row) => row.identifier === `arXiv:${reference.baseId}`) ??
        null
      );
    };
    try {
      const existing = await findExisting();
      if (existing !== null)
        return { paper: toResearchPaperOutput(existing), created: false };
    } catch (error) {
      return mapAgentOpsError(error, errors);
    }
    let metadata: Awaited<ReturnType<typeof fetchArxivMetadata>>;
    try {
      metadata = await fetchArxivMetadata(reference, arxivFetchOptions);
    } catch (error) {
      if (error instanceof ArxivNotFoundError)
        throw failures.NOT_FOUND({ message: error.message });
      if (error instanceof ArxivUpstreamError)
        throw failures.UPSTREAM_ERROR({ message: error.message });
      throw error;
    }
    try {
      // A bare-id request may resolve to a version already stored under its versioned identifier.
      const [stored] = (await repository.findByArxivId(metadata.baseId)).filter(
        (row) => row.identifier === metadata.identifier
      );
      if (stored !== undefined)
        return { paper: toResearchPaperOutput(stored), created: false };
      const paper = await repository.add({
        title: metadata.title,
        sourceUrl: metadata.sourceUrl,
        authors: metadata.authors,
        year: metadata.year,
        identifier: metadata.identifier,
        kind: "paper",
        stage: "ingested",
        notes: arxivNotes(metadata),
      });
      return { paper: toResearchPaperOutput(paper), created: true };
    } catch (error) {
      if (error instanceof DatabaseConflictError) {
        try {
          const [raced] = (
            await repository.findByArxivId(metadata.baseId)
          ).filter((row) => row.identifier === metadata.identifier);
          if (raced !== undefined)
            return { paper: toResearchPaperOutput(raced), created: false };
        } catch (readError) {
          return mapAgentOpsError(readError, errors);
        }
      }
      return mapAgentOpsError(error, errors);
    }
  });

// Read-only deployment monitor. Network options are injectable for tests; production uses globalThis.fetch
// against the configured VERTEX_DEPLOY_STATUS_URL only. The bearer token stays server-side and is never logged.
let deployStatusFetchOptions: FetchDeployStatusOptions = {};
export const setDeployStatusFetchOptionsForTesting = (
  options: FetchDeployStatusOptions
): void => {
  deployStatusFetchOptions = options;
};

const agentOpsDeploymentStatus = api.agentOps.deployment.status
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = factories(errors);
    try {
      return await fetchDeploymentSnapshot(
        context.deployStatus ?? null,
        context.deployStatusV2 ?? null,
        deployStatusFetchOptions
      );
    } catch (error) {
      if (error instanceof DeployStatusNotConfiguredError)
        throw failures.NOT_CONFIGURED();
      if (error instanceof DeployStatusUpstreamError)
        throw failures.UPSTREAM_ERROR({ message: error.message });
      throw failures.UPSTREAM_ERROR({ message: "Status request failed" });
    }
  });

export const agentOpsRouter = {
  summary: agentOpsSummary,
  tasks: {
    list: agentOpsTasksList,
    get: agentOpsTasksGet,
    create: agentOpsTasksCreate,
    update: agentOpsTasksUpdate,
    appendEvent: agentOpsTasksAppendEvent,
  },
  backtests: {
    record: agentOpsBacktestsRecord,
    list: agentOpsBacktestsList,
    get: agentOpsBacktestsGet,
  },
  deployment: {
    status: agentOpsDeploymentStatus,
  },
};

export const papersRouter = {
  list: papersList,
  add: papersAdd,
  update: papersUpdate,
  addFromArxiv: papersAddFromArxiv,
};
