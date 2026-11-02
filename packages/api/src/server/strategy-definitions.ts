import type {
  StrategyDefinitionRevisionRecord,
  StrategyDefinitionsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  STRATEGY_DEFINITION_HISTORY_MAX,
  type StrategyDefinitionRevision,
} from "../contracts/strategy-definitions.ts";
import {
  type StrategyDefinition,
  validateStrategyDefinition,
} from "../strategy-dsl.ts";
import { canonicalJson, sha256Hex } from "./backtest-runs.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Saved strategy definition procedures (backtestRuns.definitions.*). save stores a new definition at
// revision 1, or the next revision of an existing one; an unchanged definition (equal SHA-256 of the
// canonical JSON) stores nothing and returns the latest revision. The SHA-256 equals the content
// hash a definition backtest run uses for its snapshot id. save needs an operator session: agent
// API keys are refused, so an agent saves only through an assistant confirm card the operator
// approves. Research and backtest use only.

export const STRATEGY_DEFINITION_SAVE_SESSION_MESSAGE =
  "Saving a strategy definition needs an operator session; agents propose it as an assistant confirm card";

type Failures = Readonly<{
  NOT_FOUND: (options?: { message?: string }) => Error;
  CONFLICT: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): StrategyDefinitionsRepository => {
  const repository = context.repositories.strategyDefinitions;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

// Driver errors from the repository are storage failures; typed failures pass through.
const storage = <T>(operation: () => Promise<T>, failures: Failures) =>
  operation().catch(() => {
    throw failures.STORAGE_ERROR();
  });

/** SHA-256 of the canonical JSON of a parsed definition (defaults applied). */
export const strategyDefinitionSha256 = (
  definition: StrategyDefinition
): Promise<string> => sha256Hex(canonicalJson(definition));

const toRevision = (
  record: StrategyDefinitionRevisionRecord
): StrategyDefinitionRevision => ({
  createdAt: record.createdAt,
  definition: record.definition as StrategyDefinition,
  id: record.definitionId,
  name: record.name,
  note: record.note,
  revision: record.revision,
  sha256: record.sha256,
});

const api = implement(appContract).$context<ApiContext>();

const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true)
    throw (errors as unknown as Failures).FORBIDDEN({
      message: STRATEGY_DEFINITION_SAVE_SESSION_MESSAGE,
    });
  return await next();
});

const validate = api.backtestRuns.definitions.validate
  .use(requireOperator)
  .handler(async ({ input }) => {
    const result = validateStrategyDefinition(input.definition);
    if (!result.ok) return { issues: [...result.issues], ok: false as const };
    return {
      definition: result.definition,
      ok: true as const,
      sha256: await strategyDefinitionSha256(result.definition),
    };
  });

const save = api.backtestRuns.definitions.save
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const sha256 = await strategyDefinitionSha256(input.definition);
    let definitionId: string;
    let revision = 1;
    const requestedId = input.id;
    if (requestedId === undefined) {
      definitionId = crypto.randomUUID();
    } else {
      const latest = await storage(
        () => repository.latest(requestedId),
        failures
      );
      if (latest === null)
        throw failures.NOT_FOUND({ message: "Strategy definition not found" });
      if (latest.sha256 === sha256)
        return { created: false, revision: toRevision(latest) };
      definitionId = latest.definitionId;
      revision = latest.revision + 1;
    }
    const stored = await storage(
      () =>
        repository.insert({
          createdBy: context.principal.userId,
          definition: input.definition as Record<string, unknown>,
          definitionId,
          name: input.definition.name,
          note:
            input.note === undefined || input.note === "" ? null : input.note,
          revision,
          sha256,
        }),
      failures
    );
    if (stored === null) throw failures.CONFLICT();
    return { created: true, revision: toRevision(stored) };
  });

const list = api.backtestRuns.definitions.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const rows = await storage(
      () => repository.listLatest(input.limit),
      failures
    );
    return {
      definitions: rows.map((row) => ({
        id: row.definitionId,
        name: row.name,
        revision: row.revision,
        sha256: row.sha256,
        updatedAt: row.createdAt,
      })),
    };
  });

const get = api.backtestRuns.definitions.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const record = await storage(
      () =>
        input.revision === undefined
          ? repository.latest(input.id)
          : repository.get(input.id, input.revision),
      failures
    );
    if (record === null)
      throw failures.NOT_FOUND({
        message: "Strategy definition or revision not found",
      });
    const history = await storage(
      () => repository.history(input.id, STRATEGY_DEFINITION_HISTORY_MAX),
      failures
    );
    return { history, revision: toRevision(record) };
  });

export const strategyDefinitionsRouter = { get, list, save, validate };
