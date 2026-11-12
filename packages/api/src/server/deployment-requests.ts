import { isAcademyStrategySlug } from "@darkfactory/academy/courses";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  DeploymentRequestInputError,
  DeploymentRequestStateError,
  InvalidRepositoryInputError,
  normalizeDeploymentOptions,
  normalizeDeploymentSymbol,
  type DeploymentRequestOptions,
  type DeploymentRequestRow,
  type DeploymentRequestsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  DEPLOYMENT_NOT_DISPATCHED_REASON,
  type DeploymentRequestOutput,
} from "../contracts/deployment-requests.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Paper deployment requests: LOCKED records. Every procedure refuses agent API keys before the
// operator check (session only), so no agent can approve. This module has no network client and no
// execution transport; it only reads and writes rows through the repository. Every output carries the
// literal lock below, and approve changes only the recorded status, never the dispatch state.

const api = implement(appContract).$context<ApiContext>();

export const DEPLOYMENT_REQUESTS_SESSION_REQUIRED_MESSAGE =
  "Deployment requests require a signed-in operator session; API keys are refused";

const DEPLOYMENT_LOCK = Object.freeze({
  executionAuthorized: false as const,
  brokerSubmissionAllowed: false as const,
  dispatch: Object.freeze({
    state: "not-dispatched" as const,
    reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
  }),
});

type DeploymentErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";
type DeploymentErrorFactories = Readonly<
  Record<DeploymentErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): DeploymentErrorFactories => {
  return errors as DeploymentErrorFactories;
};

const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true) {
    throw factories(errors).FORBIDDEN({
      message: DEPLOYMENT_REQUESTS_SESSION_REQUIRED_MESSAGE,
    });
  }
  return await next();
});

const requestsFor = (
  context: ApiContext,
  errors: unknown
): DeploymentRequestsRepository => {
  const repository = context.repositories.deploymentRequests;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapDeploymentError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({
      message: error.message.replace(/^Invalid repository input: /u, ""),
    });
  }
  if (error instanceof DeploymentRequestInputError)
    throw failures.VALIDATION_ERROR({ message: error.message });
  if (error instanceof DeploymentRequestStateError)
    throw failures.CONFLICT({ message: error.message });
  if (error instanceof DatabaseConflictError)
    throw failures.CONFLICT({
      message: "The request changed concurrently; reload",
    });
  if (error instanceof DatabasePersistenceError) {
    throw failures.STORAGE_ERROR({
      message:
        "Deployment request storage unavailable. Apply migration 0021 if the table is missing, and 0067 for the options column.",
    });
  }
  throw error;
};

// The stored options block; null for a request in the old format (written before migration 0067).
const storedOptions = (
  row: DeploymentRequestRow
): DeploymentRequestOptions | null => {
  return (
    (row as Readonly<{ options?: DeploymentRequestOptions | null }>).options ??
    null
  );
};

const toOptionsOutput = (
  options: DeploymentRequestOptions | null
): DeploymentRequestOutput["options"] => {
  if (options === null) return null;
  return {
    structure: options.structure,
    dte: { target: options.dte.target, min: options.dte.min },
    width: { unit: options.width.unit, value: options.width.value },
    anchorDelta: options.anchorDelta,
    legs: options.legs.map((leg) => ({ ...leg })),
    budgetPctOfAccount: options.budgetPctOfAccount,
    maxLossPctOfAccount: options.maxLossPctOfAccount,
    group:
      options.group === null
        ? null
        : { key: options.group.key, symbols: [...options.group.symbols] },
  };
};

const toDeploymentRequestOutput = (
  row: DeploymentRequestRow
): DeploymentRequestOutput => ({
  id: row.id,
  strategyId: row.strategyId,
  strategySlug: row.strategySlug,
  strategyName: row.strategyName,
  presetId: row.presetId ?? null,
  presetName: row.presetName ?? null,
  params: { ...(row.params ?? {}) },
  symbol: row.symbol,
  timeframe: row.timeframe,
  mode: "paper",
  limits: {
    maxOrderSize: row.limits.maxOrderSize,
    maxPosition: row.limits.maxPosition,
    maxOrdersPerMinute: row.limits.maxOrdersPerMinute,
    dailyLossLimit: row.limits.dailyLossLimit,
  },
  options: toOptionsOutput(storedOptions(row)),
  status: row.status,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt ?? null,
  decidedBy: row.decidedBy ?? null,
  decidedAt: row.decidedAt ?? null,
  decisionNote: row.decisionNote ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...DEPLOYMENT_LOCK,
});

const found = (
  row: DeploymentRequestRow | null,
  errors: unknown,
  message = "Deployment request not found"
): DeploymentRequestOutput => {
  if (row === null) throw factories(errors).NOT_FOUND({ message });
  return toDeploymentRequestOutput(row);
};

const procedure = <T>(
  operation: () => Promise<T>,
  errors: unknown
): Promise<T> => {
  return operation().catch((error: unknown) =>
    mapDeploymentError(error, errors)
  );
};

const deploymentRequestsList = api.deploymentRequests.list
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    const rows = await procedure(
      () =>
        repository.list({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.strategyId === undefined
            ? {}
            : { strategyId: input.strategyId }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      errors
    );
    return {
      requests: rows.map(toDeploymentRequestOutput),
      ...DEPLOYMENT_LOCK,
    };
  });

const deploymentRequestsGet = api.deploymentRequests.get
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    return found(
      await procedure(() => repository.get(input.id), errors),
      errors
    );
  });

const ACADEMY_REQUEST_PATH_MESSAGE =
  "Academy strategies are requested from their Academy lesson page, where the rule gates, the password step-up and the audit apply";

// Academy strategies (every course prefix in the course registry: dyr-*, qftg-*, ...) must go
// through academy.deployRequest: this generic path has no rule gates, no password step-up and no
// audit, so create, edit and submit refuse them.
const refuseAcademyStrategy = async (
  context: ApiContext,
  strategyId: string,
  errors: unknown
): Promise<void> => {
  // Fail closed: without the library the strategy cannot be proven to be outside the Academy.
  const library = context.repositories.strategyLibrary;
  if (library === undefined)
    throw factories(errors).STORAGE_ERROR({
      message: "Strategy library unavailable",
    });
  const record = await procedure(() => library.get(strategyId), errors);
  if (record !== null && isAcademyStrategySlug(record.strategy.slug))
    throw factories(errors).FORBIDDEN({
      message: ACADEMY_REQUEST_PATH_MESSAGE,
    });
};

const refuseAcademyRequest = async (
  context: ApiContext,
  id: string,
  errors: unknown
): Promise<void> => {
  const row = await procedure(
    () => requestsFor(context, errors).get(id),
    errors
  );
  if (row !== null && isAcademyStrategySlug(row.strategySlug))
    throw factories(errors).FORBIDDEN({
      message: ACADEMY_REQUEST_PATH_MESSAGE,
    });
};

const deploymentRequestsCreate = api.deploymentRequests.create
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    await refuseAcademyStrategy(context, input.strategyId, errors);
    const row = await procedure(
      () =>
        repository.create({
          strategyId: input.strategyId,
          ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
          ...(input.params === undefined ? {} : { params: input.params }),
          symbol: input.symbol,
          timeframe: input.timeframe,
          limits: input.limits,
          ...(input.options === undefined ? {} : { options: input.options }),
          requestedBy: context.principal.userId,
        }),
      errors
    );
    return found(row, errors, "Strategy not found");
  });

// One draft per symbol, all or nothing: the options block is checked for every symbol before the
// repository is called, and the repository writes all rows in one transaction.
const deploymentRequestsCreateGroup = api.deploymentRequests.createGroup
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    await refuseAcademyStrategy(context, input.strategyId, errors);
    const groupKey = `grp-${crypto.randomUUID()}`;
    const rows = await procedure(async () => {
      const symbols = input.symbols.map(normalizeDeploymentSymbol);
      const options = { ...input.options, group: { key: groupKey, symbols } };
      // Refuses repeated symbols and every options rule before anything is written.
      for (const symbol of symbols) normalizeDeploymentOptions(options, symbol);
      return await repository.createGroup({
        strategyId: input.strategyId,
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
        ...(input.params === undefined ? {} : { params: input.params }),
        symbols,
        timeframe: input.timeframe,
        limits: input.limits,
        options,
        requestedBy: context.principal.userId,
      });
    }, errors);
    if (rows === null)
      throw factories(errors).NOT_FOUND({ message: "Strategy not found" });
    return {
      groupKey,
      requests: rows.map(toDeploymentRequestOutput),
      ...DEPLOYMENT_LOCK,
    };
  });

const deploymentRequestsUpdate = api.deploymentRequests.update
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    await refuseAcademyRequest(context, input.id, errors);
    const row = await procedure(
      () =>
        repository.update({
          id: input.id,
          ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
          ...(input.params === undefined ? {} : { params: input.params }),
          ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
          ...(input.timeframe === undefined
            ? {}
            : { timeframe: input.timeframe }),
          ...(input.limits === undefined ? {} : { limits: input.limits }),
          ...(input.options === undefined ? {} : { options: input.options }),
        }),
      errors
    );
    return found(row, errors);
  });

const deploymentRequestsSubmit = api.deploymentRequests.submit
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    await refuseAcademyRequest(context, input.id, errors);
    return found(
      await procedure(
        () =>
          repository.transition({
            id: input.id,
            action: "submit",
            actorId: context.principal.userId,
          }),
        errors
      ),
      errors
    );
  });

export const deploymentRequestsApprove = api.deploymentRequests.approve
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    // The stored options block is checked again: a request that breaks a rule (for example a max
    // loss above the ceiling written before the rule, or by hand) can never be approved.
    await procedure(async () => {
      const current = await repository.get(input.id);
      if (current !== null)
        normalizeDeploymentOptions(storedOptions(current), current.symbol);
    }, errors);
    const row = await procedure(
      () =>
        repository.transition({
          id: input.id,
          action: "approve",
          actorId: context.principal.userId,
          confirmSlug: input.confirmSlug,
          ...(input.note === undefined ? {} : { note: input.note }),
        }),
      errors
    );
    return found(row, errors);
  });

const deploymentRequestsReject = api.deploymentRequests.reject
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    return found(
      await procedure(
        () =>
          repository.transition({
            id: input.id,
            action: "reject",
            actorId: context.principal.userId,
            note: input.note,
          }),
        errors
      ),
      errors
    );
  });

const deploymentRequestsWithdraw = api.deploymentRequests.withdraw
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = requestsFor(context, errors);
    return found(
      await procedure(
        () =>
          repository.transition({
            id: input.id,
            action: "withdraw",
            actorId: context.principal.userId,
          }),
        errors
      ),
      errors
    );
  });

export const deploymentRequestsRouter = {
  list: deploymentRequestsList,
  get: deploymentRequestsGet,
  create: deploymentRequestsCreate,
  createGroup: deploymentRequestsCreateGroup,
  update: deploymentRequestsUpdate,
  submit: deploymentRequestsSubmit,
  approve: deploymentRequestsApprove,
  reject: deploymentRequestsReject,
  withdraw: deploymentRequestsWithdraw,
};
