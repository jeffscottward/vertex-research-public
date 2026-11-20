import type {
  FlowMarketPremiumRanking,
  FlowMarketPremiumSessionRecord,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  SmartMoneyRankingOutput,
  SmartMoneySort,
} from "../contracts/smart-money.ts";
import type { ApiContext } from "./context.ts";
import {
  MARKET_PREMIUM_FILTER_PROFILE,
  MARKET_PREMIUM_MIN_SESSION_TICKERS,
} from "../flow-market-premium.ts";
import { MARKET_PREMIUM_HISTORY_DAYS } from "./flow-market-premium-collect.ts";
import { FLOW_STALE_SECONDS, flowSessionOpen } from "./flow-snapshot.ts";
import { newYorkDate, newYorkParts } from "./gex-context.ts";
import { requireOperator } from "./operator-access.ts";

// Read-only smart money ranking. flow.collect stores QuantData gainers-losers session totals
// (flow_market_premium) and a session ledger (flow_market_premium_sessions); this procedure only
// reads them. Research only: no orders. Design: docs/vertex-rebuild/designs/smart-money/plan-pr2.md.

const DAY_MS = 86_400_000;
const OPEN_MINUTE = 9 * 60 + 30;
const SOURCE =
  "QuantData gainers-losers: per-ticker totals of option trades with premium >= $100,000 each; bullish and bearish are QuantData's trade-side classes";
const DELAY =
  "QuantData, intraday: captured about every 15 minutes while options trade; final totals from a fetch after the session day";

const systemClock = (): Date => new Date();
let clock = systemClock;

/** Test seam: fixes "now" for the history window and the coverage state. */
export const setSmartMoneyClockForTesting = (
  next: (() => Date) | null
): void => {
  clock = next ?? systemClock;
};

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const isWeekday = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/** Coverage of today's live capture (see SmartMoneyCoverageSchema). */
const coverageOf = (
  today: FlowMarketPremiumSessionRecord | undefined,
  sessionDate: string,
  now: Date
): SmartMoneyRankingOutput["coverage"] => {
  const parts = newYorkParts(now);
  const minute = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  // The live capture window of flow.collect: while options trade (09:30-16:15 New York). Today's
  // row is never no_data in that window: no_data needs a fetch after the session date.
  const inSession = flowSessionOpen("options", "SPY", now);
  const capturedAt = today?.capturedAt ?? null;
  const limit = FLOW_STALE_SECONDS.market_premium;
  // The stale state starts `limit` seconds after the newest capture, or after the open without one.
  const staleFrom =
    capturedAt === null
      ? new Date(
          Math.floor(now.getTime() / 60_000) * 60_000 -
            ((minute - OPEN_MINUTE) * 60 - limit) * 1000
        )
      : new Date(capturedAt.getTime() + limit * 1000);
  const state = ((): SmartMoneyRankingOutput["coverage"]["state"] => {
    if (!inSession) return "closed";
    if (staleFrom.getTime() <= now.getTime()) return "stale";
    return capturedAt === null ? "never" : "fresh";
  })();
  return {
    capturedAt,
    lastAttemptAt: today?.lastAttemptAt ?? null,
    lastMessage: today?.lastMessage ?? null,
    overdueSince: state === "stale" ? staleFrom : null,
    sessionDate,
    state,
    status: today?.status ?? null,
  };
};

type Failures = Readonly<{
  STORAGE_ERROR: () => Error;
  UNAVAILABLE: () => Error;
}>;

const api = implement(appContract).$context<ApiContext>();

const ranking = api.smartMoney.ranking
  .use(requireOperator)
  .handler(
    async ({ context, input, errors }): Promise<SmartMoneyRankingOutput> => {
      const failures = errors as unknown as Failures;
      const { flow } = context.repositories;
      if (flow === undefined) throw failures.UNAVAILABLE();
      const now = clock();
      const today = newYorkDate(now);
      const from = addDays(today, -MARKET_PREMIUM_HISTORY_DAYS);
      const sort: SmartMoneySort = input.sort;
      let ledger: FlowMarketPremiumSessionRecord[];
      let read: FlowMarketPremiumRanking;
      let sessions: SmartMoneyRankingOutput["sessions"];
      try {
        ledger = await flow.marketPremiumLedger({ from, to: today });
        sessions = ledger
          // A ledger row has a capture time exactly when it is complete or partial (table check).
          // A complete session with almost no tickers is a holiday and takes no window slot.
          .flatMap((row) =>
            row.capturedAt === null ||
            (row.status === "complete" &&
              row.tickers < MARKET_PREMIUM_MIN_SESSION_TICKERS)
              ? []
              : [
                  {
                    capturedAt: row.capturedAt,
                    sessionDate: row.sessionDate,
                    status:
                      row.status === "complete"
                        ? ("complete" as const)
                        : ("partial" as const),
                  },
                ]
          )
          .reverse()
          .slice(0, input.sessions);
        read = await flow.marketPremiumRanking({
          filterProfile: MARKET_PREMIUM_FILTER_PROFILE,
          limit: input.limit,
          sessionDates: sessions.map((entry) => entry.sessionDate),
          sort,
          ticker: input.ticker ?? null,
        });
      } catch {
        throw failures.STORAGE_ERROR();
      }
      const past = ledger.filter((row) => row.sessionDate < today);
      let weekdays = 0;
      for (let date = from; date < today; date = addDays(date, 1))
        if (isWeekday(date)) weekdays += 1;
      const stored = past.filter(
        (row) => row.status === "complete" || row.status === "partial"
      ).length;
      const noData = past.filter((row) => row.status === "no_data").length;
      return {
        capturedAt: sessions[0]?.capturedAt ?? null,
        coverage: coverageOf(
          ledger.find((row) => row.sessionDate === today),
          today,
          now
        ),
        delay: DELAY,
        history: {
          from,
          noData,
          pending: Math.max(0, weekdays - stored - noData),
          stored,
          weekdays,
        },
        receivedAt: now,
        rows: read.rows.map((row) => ({
          ...row,
          netPremium: row.bullishPremium - row.bearishPremium,
        })),
        sessions,
        source: SOURCE,
        totals: {
          ...read.totals,
          netPremium: read.totals.bullishPremium - read.totals.bearishPremium,
        },
      };
    }
  );

export const smartMoneyRouter = { ranking };
