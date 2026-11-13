import {
  AgentApiKeyRateLimitedError,
  AuthAuthorizationError,
  type SafePrincipal,
} from "@darkfactory/auth/server";
import { isOperatorIdentity } from "@darkfactory/config/server";
import { ORPCError, implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { ApiContext } from "./context.ts";

// Operator gate for the agent ledger: agentOps.* (including agentOps.optimizations.*), papers.*, strategyLibrary.*, agentModelRuns.* and agentApiKeys.*.
// Sign-up is public, so an active session alone is not enough. The caller must be
// active, email-verified and on VERTEX_OPERATOR_EMAILS (context.operatorEmails).
// An absent or empty list means nobody is an operator (fail closed).
// Key requests (x-api-key) re-check the key OWNER on every request after the
// plugin verifies the key, so removing an email from the list disables that
// owner's keys immediately. Re-exported from router.ts next to requireAdmin;
// it lives here because agent-ops.ts and agent-api-keys.ts are imported by
// router.ts (defining it there would create an import cycle).

const api = implement(appContract).$context<ApiContext>();

const OPERATOR_ACCESS_REQUIRED_MESSAGE = "Operator access required";
const READ_ONLY_KEY_MESSAGE = "This API key is read-only";

// Procedures a read-access key may call. Every other ledger procedure needs a write key.
export const AGENT_API_KEY_READ_PROCEDURES: ReadonlySet<string> = new Set([
  "agentOps.summary",
  "agentOps.tasks.list",
  "agentOps.tasks.get",
  "agentOps.backtests.list",
  "agentOps.backtests.get",
  "agentOps.optimizations.list",
  "agentOps.optimizations.get",
  "agentOps.deployment.status",
  "papers.list",
  "strategyLibrary.list",
  "strategyLibrary.get",
  "marketData.bars",
  "marketData.ticks",
  "optionsAnalytics.snapshot",
  "backtestRuns.list",
  "backtestRuns.get",
  "backtestRuns.sweep",
  "backtestRuns.comparisons.list",
  "backtestRuns.drift.list",
  "backtestRuns.drift.get",
  "backtestRuns.definitions.validate",
  "backtestRuns.definitions.list",
  "backtestRuns.definitions.get",
  "todos.list",
  "priceAlerts.list",
  "priceAlerts.signals.list",
  "priceAlerts.signals.events",
  "priceAlerts.signals.backfill",
  "sectorRotation.snapshot",
  "semanticTerms.list",
  "semanticTerms.query",
  "agentModelRuns.list",
  "agentModelRuns.get",
  "agentModelRuns.breakdown",
  "agentModelRuns.exportCsv",
  "agentModelRuns.events",
  "agentModelRuns.search",
  "agentModelRuns.benchmark",
  "agentModelRuns.frameworks",
  "clickLog.query",
  "pickLists.list",
  "pickLists.proposal",
  "pickLists.screen",
  "flow.snapshot",
  "openbb.status",
  "openbb.volContext",
  "openbb.cot",
  "openbb.macro",
  "openbb.events",
  "openbb.shorts",
  "openbb.sec",
  "openbb.factors",
  "breadth90.get",
  "goLiveDrafts.queue",
]);

type OperatorErrorFactories = Readonly<{
  UNAUTHORIZED: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
}>;

const factories = (errors: unknown): OperatorErrorFactories => {
  return errors as OperatorErrorFactories;
};

// Authenticates an x-api-key request: the key owner must still be an operator, and a
// read-access key may call only AGENT_API_KEY_READ_PROCEDURES. Any cookie is ignored.
export const agentKeyOwnerPrincipal = async (
  context: ApiContext,
  path: readonly string[],
  errors: unknown
): Promise<SafePrincipal> =>
  (await agentKeyOwner(context, path, errors)).principal;

// agentKeyOwnerPrincipal with the key's access.
const agentKeyOwner = async (
  context: ApiContext,
  path: readonly string[],
  errors: unknown
): Promise<Readonly<{ canWrite: boolean; principal: SafePrincipal }>> => {
  const failures = factories(errors);
  const keys = context.agentApiKeys;
  if (keys === undefined) throw failures.UNAUTHORIZED();
  const owner = await keys.authenticate();
  if (!isOperatorIdentity(owner, context.operatorEmails)) {
    throw failures.FORBIDDEN({ message: OPERATOR_ACCESS_REQUIRED_MESSAGE });
  }
  if (
    owner.access !== "write" &&
    !AGENT_API_KEY_READ_PROCEDURES.has(path.join("."))
  ) {
    throw failures.FORBIDDEN({ message: READ_ONLY_KEY_MESSAGE });
  }
  return {
    canWrite: owner.access === "write",
    principal: {
      role: owner.role,
      status: owner.status,
      userId: owner.userId,
    },
  };
};

export const requireOperator = api.middleware(
  async ({ context, next, errors, path }) => {
    const failures = factories(errors);
    const denied = () =>
      failures.FORBIDDEN({ message: OPERATOR_ACCESS_REQUIRED_MESSAGE });
    let principal: SafePrincipal;
    let callerCanWrite: boolean;
    let callerIsAgentViewer = false;
    try {
      if (context.agentApiKeyPresented === true) {
        ({ canWrite: callerCanWrite, principal } = await agentKeyOwner(
          context,
          path,
          errors
        ));
      } else {
        const session = await context.requireSession();
        // A read-only agent viewer passes here; agentViewerReadOnlyInterceptor already refused
        // every non-read procedure for it.
        callerCanWrite = isOperatorIdentity(
          session.user,
          context.operatorEmails
        );
        callerIsAgentViewer =
          !callerCanWrite &&
          isOperatorIdentity(session.user, context.agentViewerEmails);
        if (!(callerCanWrite || callerIsAgentViewer)) throw denied();
        principal = session.principal;
      }
    } catch (error) {
      if (error instanceof AgentApiKeyRateLimitedError) {
        throw new ORPCError("TOO_MANY_REQUESTS", {
          status: 429,
          message: "Agent API key rate limit exceeded",
        });
      }
      if (!(error instanceof AuthAuthorizationError)) throw error;
      if (error.status === 401) throw failures.UNAUTHORIZED();
      throw denied();
    }
    return next({
      context: { callerCanWrite, callerIsAgentViewer, principal },
    });
  }
);
