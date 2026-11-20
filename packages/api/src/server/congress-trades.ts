import type { OpenbbCongressFeed, OpenbbJobRuns } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  CONGRESS_TRADES_OVERDUE_HOURS,
  type CongressCoverage,
  type CongressTradesFeedOutput,
} from "../contracts/congress-trades.ts";
import {
  OPENBB_CONGRESS_CHAMBERS,
  OPENBB_CONGRESS_UNPARSED_REASONS,
  type OpenbbCongressChamber,
} from "../contracts/openbb.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Read-only congress trade feed. The OpenBB rig jobs congress-house and congress-senate parse the
// House Clerk and Senate eFD periodic transaction reports into Postgres; this procedure only reads
// them (openbb repository congressFeed and lastRunsFor). Research only: no orders.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const JOB_OF: Readonly<Record<OpenbbCongressChamber, string>> = {
  house: "congress-house",
  senate: "congress-senate",
};
const SOURCE =
  "U.S. House Clerk and Senate eFD STOCK Act periodic transaction reports, parsed by the OpenBB jobs congress-house and congress-senate";

const systemClock = (): Date => new Date();
let clock = systemClock;

/** Test seam: fixes "now" for the window and the overdue check. */
export const setCongressTradesClockForTesting = (
  next: (() => Date) | null
): void => {
  clock = next ?? systemClock;
};

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS
  );

const coverageOf = (
  chamber: OpenbbCongressChamber,
  runs: readonly OpenbbJobRuns[],
  now: Date
): CongressCoverage => {
  const entry = runs.find((run) => run.job === JOB_OF[chamber]);
  const latest = entry?.latest ?? null;
  const usable = entry?.latestUsable ?? null;
  return {
    chamber,
    lastOkAt: usable?.finishedAt ?? null,
    lastRunAt: latest?.finishedAt ?? null,
    lastStatus: latest?.status ?? null,
    overdue:
      usable === null ||
      now.getTime() - usable.finishedAt.getTime() >
        CONGRESS_TRADES_OVERDUE_HOURS * HOUR_MS,
  };
};

type Failures = Readonly<{
  STORAGE_ERROR: () => Error;
  UNAVAILABLE: () => Error;
}>;

const api = implement(appContract).$context<ApiContext>();

const feed = api.congressTrades.feed
  .use(requireOperator)
  .handler(
    async ({ context, input, errors }): Promise<CongressTradesFeedOutput> => {
      const failures = errors as unknown as Failures;
      const { openbb } = context.repositories;
      if (openbb === undefined) throw failures.UNAVAILABLE();
      const now = clock();
      const today = NY_DATE.format(now);
      const from = new Date(
        Date.parse(`${today}T00:00:00Z`) - input.days * DAY_MS
      )
        .toISOString()
        .slice(0, 10);
      let read: OpenbbCongressFeed;
      let runs: OpenbbJobRuns[];
      try {
        [read, runs] = await Promise.all([
          openbb.congressFeed({
            from,
            ...(input.chamber === undefined ? {} : { chamber: input.chamber }),
            ...(input.member === undefined ? {} : { member: input.member }),
            ...(input.ticker === undefined ? {} : { ticker: input.ticker }),
          }),
          openbb.lastRunsFor(Object.values(JOB_OF)),
        ]);
      } catch {
        throw failures.STORAGE_ERROR();
      }
      const filings = read.filings.map(
        ({ firstSeenAt: _firstSeenAt, ...filing }) => filing
      );
      const unparsed = filings.filter((filing) => filing.status === "unparsed");
      return {
        coverage: OPENBB_CONGRESS_CHAMBERS.map((chamber) =>
          coverageOf(chamber, runs, now)
        ),
        filings,
        // With a ticker, only the members who traded it; otherwise every filer in the window.
        members: [
          ...new Set(
            (input.ticker === undefined ? filings : read.trades).map(
              (row) => row.member
            )
          ),
        ].sort(),
        receivedAt: now,
        source: SOURCE,
        trades: read.trades.map(({ firstSeenAt: _firstSeenAt, ...trade }) => ({
          ...trade,
          delayDays:
            trade.transactionDate === null
              ? null
              : daysBetween(trade.transactionDate, trade.filedOn),
        })),
        unparsed: {
          byReason: Object.fromEntries(
            OPENBB_CONGRESS_UNPARSED_REASONS.map((reason) => [
              reason,
              unparsed.filter((filing) => filing.reason === reason).length,
            ])
          ) as CongressTradesFeedOutput["unparsed"]["byReason"],
          total: unparsed.length,
        },
      };
    }
  );

export const congressTradesRouter = { feed };
