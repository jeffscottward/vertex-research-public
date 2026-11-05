import { AuthAuthorizationError } from "@darkfactory/auth/server";
import {
  type ClickLogInsert,
  type ClickLogRepository,
  DatabasePersistenceError,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { redactClickRoute, redactClickText } from "../click-log-redaction.ts";
import { appContract } from "../contract.ts";
import {
  type ClickLogEventInput,
  ClickLogEventSchema,
} from "../contracts/click-log.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// clickLog.*: the UI click log (card vertex-click-log). record takes the signed-in user's own
// clicks (the user id comes from the session; agent API keys are rejected by the handler's key
// scope). It redacts every text field again, so a modified client cannot store raw text. query is
// operator-only (session or operator API key, read access is enough).

const api = implement(appContract).$context<ApiContext>();

/** Browser times further than this from the server clock are replaced by the server time. */
export const CLICK_LOG_MAX_CLOCK_SKEW_MS = 10 * 60_000;
const QUERY_DEFAULT_LIMIT = 500;

type Errors = Readonly<{
  FORBIDDEN: () => Error;
  STORAGE_ERROR: () => Error;
  UNAUTHORIZED: () => Error;
}>;

/** Runs work with the repository, mapping storage failures once. */
const withRepository = async <T>(
  context: ApiContext,
  errors: Errors,
  work: (repository: ClickLogRepository) => Promise<T>
): Promise<T> => {
  const repository = context.repositories.clickLog;
  if (repository === undefined) throw errors.STORAGE_ERROR();
  try {
    return await work(repository);
  } catch (error) {
    if (error instanceof DatabasePersistenceError) throw errors.STORAGE_ERROR();
    throw error;
  }
};

export const toClickLogInsert = (
  event: ClickLogEventInput,
  base: Readonly<{
    buildSha: string;
    now: Date;
    recordRequestId: string;
    tabId: string;
    userId: string;
  }>
): ClickLogInsert => {
  const at = new Date(event.at);
  const skewed =
    Math.abs(at.getTime() - base.now.getTime()) > CLICK_LOG_MAX_CLOCK_SKEW_MS;
  return {
    buildSha: base.buildSha,
    important: event.important,
    kind: event.kind,
    label: redactClickText(event.label),
    occurredAt: skewed ? base.now : at,
    recordRequestId: base.recordRequestId,
    requestIds: event.requestIds,
    role: event.role,
    route: redactClickRoute(event.route),
    tabId: base.tabId,
    targetRoute:
      event.targetRoute === null ? null : redactClickRoute(event.targetRoute),
    testId: event.testId === null ? null : redactClickText(event.testId),
    userId: base.userId,
  };
};

const record = api.clickLog.record.handler(
  async ({ context, errors, input }) => {
    let userId: string;
    try {
      userId = (await context.requireSession()).principal.userId;
    } catch (error) {
      if (!(error instanceof AuthAuthorizationError)) throw error;
      if (error.status === 401) throw errors.UNAUTHORIZED();
      throw errors.FORBIDDEN();
    }
    const now = new Date();
    const rows = input.events.map((event) =>
      toClickLogInsert(event, {
        buildSha: input.buildSha,
        now,
        recordRequestId: context.requestId,
        tabId: input.tabId,
        userId,
      })
    );
    return {
      accepted: await withRepository(context, errors, (repository) =>
        repository.record(rows)
      ),
    };
  }
);

const query = api.clickLog.query
  .use(requireOperator)
  .handler(({ context, errors, input }) =>
    withRepository(context, errors, async (repository) => {
      const result = await repository.query({
        from: new Date(input.from),
        limit: input.limit ?? QUERY_DEFAULT_LIMIT,
        to: new Date(input.to),
        ...(input.user === undefined ? {} : { user: input.user }),
      });
      return {
        events: result.events.map((row) => ClickLogEventSchema.parse(row)),
        truncated: result.truncated,
      };
    })
  );

export const clickLogRouter = { query, record };
