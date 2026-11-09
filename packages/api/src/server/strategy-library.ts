import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type StrategyLibraryRepository,
  type StrategyListRow,
} from "@darkfactory/db/server";
import type { Strategy, StrategyPreset } from "@darkfactory/db/schema";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  StrategyLatestBacktestOutput,
  StrategyOutput,
  StrategyPresetOutput,
  StrategySummaryOutput,
} from "../contracts/strategy-library.ts";
import { latestBacktestStats, sortStrategies } from "../strategy-library.ts";
import {
  toBacktestSummariesWithTitles,
  toBacktestSummaryOutput,
} from "./agent-ops.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Operator strategy library. Every procedure uses requireOperator; agent keys reach it through the
// handler scope list, and read keys may call only list and get. The repository owns all field,
// params and preset validation; this module maps results and derives latest-backtest statistics.

const api = implement(appContract).$context<ApiContext>();

type StrategyErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";
type StrategyErrorFactories = Readonly<
  Record<StrategyErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): StrategyErrorFactories => {
  return errors as StrategyErrorFactories;
};

const strategiesFor = (
  context: ApiContext,
  errors: unknown
): StrategyLibraryRepository => {
  const repository = context.repositories.strategyLibrary;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapStrategyError = (
  error: unknown,
  errors: unknown,
  conflict = "A strategy with this slug already exists"
): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({
      message: error.message.replace(/^Invalid repository input: /u, ""),
    });
  }
  if (error instanceof DatabaseConflictError)
    throw failures.CONFLICT({ message: conflict });
  if (error instanceof DatabasePersistenceError) {
    throw failures.STORAGE_ERROR({
      message:
        "Strategy library storage unavailable. Apply migration 0019 if the tables are missing.",
    });
  }
  throw error;
};

// The repository already parsed the stored claim; this copies it so the output shares no reference.
const toExternalValidationOutput = (
  claim: Strategy["externalValidation"]
): StrategyOutput["externalValidation"] => {
  if (claim === null) return null;
  return {
    ...claim,
    claimedMetrics: claim.claimedMetrics.map((metric) => ({ ...metric })),
  };
};

const toStrategyOutput = (row: Strategy): StrategyOutput => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description ?? null,
  kind: row.kind,
  status: row.status,
  sourceRef: row.sourceRef ?? null,
  tags: [...(row.tags ?? [])],
  favorite: row.favorite,
  section: row.section ?? null,
  params: (row.params ?? []).map((param) => ({ ...param })),
  priority: row.priority,
  externalValidation: toExternalValidationOutput(row.externalValidation),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toStrategySummaryOutput = (
  row: StrategyListRow,
  latestBacktest: StrategyLatestBacktestOutput | null
): StrategySummaryOutput => ({
  ...toStrategyOutput(row),
  presetCount: row.presetCount,
  backtestCount: row.backtestCount,
  latestBacktest,
});

const toStrategyPresetOutput = (row: StrategyPreset): StrategyPresetOutput => ({
  id: row.id,
  strategyId: row.strategyId,
  name: row.name,
  values: { ...(row.values ?? {}) },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const latestByStrategy = async (
  repository: StrategyLibraryRepository,
  rows: readonly StrategyListRow[]
): Promise<Map<string, StrategyLatestBacktestOutput>> => {
  const linked = rows
    .filter((row) => row.backtestCount > 0)
    .map((row) => row.id);
  const latest = await repository.latestBacktests(linked);
  return new Map(
    latest.map((row) => [row.strategyId, latestBacktestStats(row)])
  );
};

const strategyLibraryList = api.strategyLibrary.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    try {
      const rows = await repository.list({
        ...(input.search === undefined ? {} : { search: input.search }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
        ...(input.section === undefined ? {} : { section: input.section }),
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      const latest = await latestByStrategy(repository, rows);
      const summaries = rows.map((row) =>
        toStrategySummaryOutput(row, latest.get(row.id) ?? null)
      );
      return { strategies: sortStrategies(summaries, input.sort ?? "updated") };
    } catch (error) {
      return mapStrategyError(error, errors);
    }
  });

const strategyLibraryGet = api.strategyLibrary.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    let found: Awaited<ReturnType<StrategyLibraryRepository["get"]>>;
    try {
      found = await repository.get(input.id);
    } catch (error) {
      return mapStrategyError(error, errors);
    }
    if (found === null)
      throw factories(errors).NOT_FOUND({ message: "Strategy not found" });
    const strategy = found.strategy;
    try {
      const latest = await latestByStrategy(repository, [strategy]);
      const backtestRepository = context.repositories.backtestResults;
      const backtestRows =
        backtestRepository === undefined || strategy.backtestCount === 0
          ? []
          : await backtestRepository.list({
              strategyId: strategy.id,
              limit: 200,
            });
      const tasks = context.repositories.agentOps;
      const backtests =
        tasks === undefined
          ? backtestRows.map((row) => toBacktestSummaryOutput(row, null))
          : await toBacktestSummariesWithTitles(tasks, backtestRows);
      return {
        strategy: toStrategySummaryOutput(
          strategy,
          latest.get(strategy.id) ?? null
        ),
        presets: found.presets.map(toStrategyPresetOutput),
        backtests,
      };
    } catch (error) {
      return mapStrategyError(error, errors);
    }
  });

const strategyLibraryCreate = api.strategyLibrary.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    try {
      const row = await repository.create({
        name: input.name,
        kind: input.kind,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.sourceRef === undefined
          ? {}
          : { sourceRef: input.sourceRef }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
        ...(input.section === undefined ? {} : { section: input.section }),
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.externalValidation === undefined
          ? {}
          : { externalValidation: input.externalValidation }),
      });
      return toStrategyOutput(row);
    } catch (error) {
      return mapStrategyError(error, errors);
    }
  });

const strategyLibraryUpdate = api.strategyLibrary.update
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    let row: Strategy | null;
    try {
      row = await repository.update({
        id: input.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.sourceRef === undefined
          ? {}
          : { sourceRef: input.sourceRef }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
        ...(input.section === undefined ? {} : { section: input.section }),
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.externalValidation === undefined
          ? {}
          : { externalValidation: input.externalValidation }),
      });
    } catch (error) {
      return mapStrategyError(error, errors);
    }
    if (row === null)
      throw factories(errors).NOT_FOUND({ message: "Strategy not found" });
    return toStrategyOutput(row);
  });

const strategyLibraryPresetsSave = api.strategyLibrary.presets.save
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    let preset: StrategyPreset | null;
    try {
      preset = await repository.savePreset({
        strategyId: input.strategyId,
        name: input.name,
        values: input.values,
      });
    } catch (error) {
      return mapStrategyError(
        error,
        errors,
        "A preset with this name was saved concurrently; retry"
      );
    }
    if (preset === null)
      throw factories(errors).NOT_FOUND({ message: "Strategy not found" });
    return toStrategyPresetOutput(preset);
  });

const strategyLibraryPresetsRemove = api.strategyLibrary.presets.remove
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = strategiesFor(context, errors);
    let removed: boolean;
    try {
      removed = await repository.removePreset({
        strategyId: input.strategyId,
        id: input.id,
      });
    } catch (error) {
      return mapStrategyError(error, errors);
    }
    if (!removed)
      throw factories(errors).NOT_FOUND({ message: "Preset not found" });
    return { removed: true as const };
  });

export const strategyLibraryRouter = {
  list: strategyLibraryList,
  get: strategyLibraryGet,
  create: strategyLibraryCreate,
  update: strategyLibraryUpdate,
  presets: {
    save: strategyLibraryPresetsSave,
    remove: strategyLibraryPresetsRemove,
  },
};
