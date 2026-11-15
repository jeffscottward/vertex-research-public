import type {
  Breadth90Repository,
  Breadth90StoredDay,
  Breadth90StoredEvent,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  BREADTH90_GET_DAYS,
  BREADTH90_GET_EVENTS,
  BREADTH90_THRESHOLDS,
  type Breadth90Day,
  type Breadth90StoredEvent as Breadth90EventOutput,
} from "../contracts/breadth-90.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Breadth-90 procedures (breadth90.*). Operator-only. collect (rig tick, operator agent WRITE key;
// a read key gets 403 from requireOperator and a session gets 403 here) upserts the pushed sessions
// by date, records each event once by (kind, date, tier) and replaces the status row, all in one
// transaction. get (portal
// read: operator session, agent viewer or a read key) returns the status, the last 30 sessions and
// the newest 20 events. Research only: no order path.

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): Breadth90Repository => {
  const repository = context.repositories.breadth90;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

/**
 * The window breadth90.get shows, oldest first: the newest final sessions plus the newest row when
 * it is still intraday. An intraday row older than a final session (a missed close) is left out.
 */
export const sessionWindow = (
  newestFirst: readonly Breadth90StoredDay[]
): Breadth90StoredDay[] =>
  newestFirst
    .filter((day, index) => day.final || index === 0)
    .slice(0, BREADTH90_GET_DAYS)
    .reverse();

const dayOutput = (day: Breadth90StoredDay): Breadth90Day => ({
  adv: day.adv,
  advPct: day.advPct,
  date: day.date,
  decl: day.decl,
  dvol: day.dvol,
  final: day.final,
  kind: day.kind,
  source: day.source,
  sourceAsOf: day.sourceAsOf,
  updatedAt: day.updatedAt.toISOString(),
  upPct: day.upPct,
  uvol: day.uvol,
});

const eventOutput = ({
  createdAt,
  id: _id,
  ...event
}: Breadth90StoredEvent): Breadth90EventOutput => ({
  ...event,
  createdAt: createdAt.toISOString(),
});

const collect = api.breadth90.collect
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Rig tick only: one push per tick writes the sessions and status for the whole deployment.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "breadth90.collect needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    // Sessions, events and status land in one transaction: a failed push writes nothing.
    const { created, days } = await repository.collect({
      days: input.days.map((day) => ({
        ...day,
        adv: Math.round(day.adv),
        decl: Math.round(day.decl),
      })),
      events: input.events,
      status: {
        armedOn: input.armedOn,
        asOf: new Date(input.asOf),
        basket: input.basket,
        sessionsLeft: input.sessionsLeft,
        state: input.state,
        strict: input.strict,
      },
    });
    return {
      asOf: input.asOf,
      newEvents: created.map(
        ({ createdAt: _createdAt, id: _id, ...event }) => event
      ),
      stored: { days, events: created.length },
    };
  });

const get = api.breadth90.get
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = repositoryFor(context, errors as unknown as Failures);
    const [status, days, events] = await Promise.all([
      repository.getStatus(),
      // One extra row, so a stale intraday row the window leaves out still leaves 30 sessions.
      repository.listRecentDays(BREADTH90_GET_DAYS + 1),
      repository.listRecentEvents(BREADTH90_GET_EVENTS),
    ]);
    return {
      days: sessionWindow(days).map(dayOutput),
      events: events.map(eventOutput),
      status:
        status === null
          ? null
          : {
              armedOn: status.armedOn,
              asOf: status.asOf.toISOString(),
              basket: status.basket,
              sessionsLeft: status.sessionsLeft,
              state: status.state,
              strict: status.strict,
            },
      thresholds: { ...BREADTH90_THRESHOLDS },
    };
  });

export const breadth90Router = { collect, get };
