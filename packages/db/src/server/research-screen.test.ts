import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  researchReports,
  researchScreenBars,
  researchScreenRows,
  researchScreenRuns,
  researchScreenScheduler,
  researchScreenSwinglytics,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import { DatabasePersistenceError } from "./repository-errors.ts";
import {
  createResearchScreenRepository,
  RESEARCH_SCREEN_DEADLINE_MINUTES,
  RESEARCH_SCREEN_LEASE_SECONDS,
  type ResearchScreenFailedRowWrite,
  type ResearchScreenGoodRowWrite,
  type ResearchScreenObservationValue,
  type ResearchScreenSwinglyticsSnapshotValue,
} from "./research-screen.ts";

interface Operation {
  conflict?: "nothing" | "update";
  conflictSet?: Record<string, unknown>;
  kind: "select" | "insert" | "update" | "execute";
  lock?: string;
  order?: unknown[];
  set?: Record<string, unknown>;
  statement?: SQL;
  table?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
}

const dialect = new PgDialect();
/** The SQL text and parameters of a fragment the repository built. */
const render = (fragment: unknown) => {
  const query = dialect.sqlToQuery(sql`${fragment}`);
  return { params: query.params, text: query.sql };
};

/** Query double: every awaited query takes the next queued result (default: no rows). */
const createDouble = (outcomes: (unknown[] | Error)[] = []) => {
  const operations: Operation[] = [];
  const settle = () => {
    const next = outcomes.shift() ?? [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      for: (strength: string) => {
        operation.lock = strength;
        return chain;
      },
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      leftJoin: () => chain,
      limit: () => chain,
      onConflictDoNothing: () => {
        operation.conflict = "nothing";
        return chain;
      },
      onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
        operation.conflict = "update";
        operation.conflictSet = config.set;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.order = order;
        return chain;
      },
      returning: () => chain,
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => settle().then(resolve, reject),
      values: (values: Record<string, unknown>) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    return chain;
  };
  const database = {
    execute: (statement: SQL) => {
      operations.push({ kind: "execute", statement });
      return settle();
    },
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: (work: (transaction: unknown) => Promise<unknown>) =>
      work(database),
    update: (table: unknown) => builder({ kind: "update", table }),
  };
  return { database: database as unknown as DatabaseExecutor, operations };
};

const AT = new Date("2026-11-16T15:00:00.000Z");
const SLOT = new Date("2026-11-16T14:30:00.000Z");
const RUN_ID = "0b0f7c1e-1111-4222-8333-444455556666";
const clock = () => AT;

const observation: ResearchScreenObservationValue = {
  action: "watch",
  blockingWarnings: [],
  buyZone: { high: 102, low: 98 },
  changePercent: 0.4,
  momentumPercent: 3.1,
  price: 101,
  reasons: ["Above the 50-day average"],
  rewardRisk: 2.1,
  score: 61,
  stop: 95,
  support: 97,
  target: 114,
  warnings: [],
};

const good = (
  edit: Partial<ResearchScreenGoodRowWrite> = {}
): ResearchScreenGoodRowWrite => ({
  barsSource: "ibkr",
  historyAt: AT,
  kind: "good",
  observation,
  providerSymbol: "AAPL",
  quoteAt: AT,
  quoteSource: "yahoo",
  reportId: "AAPL",
  stops: { ibkrFailed: false, yahooRateLimited: false },
  ...edit,
});

const failed = (
  edit: Partial<ResearchScreenFailedRowWrite> = {}
): ResearchScreenFailedRowWrite => ({
  barsSource: null,
  errorCode: "provider-timeout",
  errorMessage: "The quote read timed out",
  kind: "failed",
  providerSymbol: "AAPL",
  reportId: "AAPL",
  stops: { ibkrFailed: null, yahooRateLimited: true },
  ...edit,
});

const snapshot: ResearchScreenSwinglyticsSnapshotValue = {
  breadth: {
    above20DayPercent: 61,
    above50DayPercent: 58,
    above200DayPercent: 55,
    regime: "Healthy",
    score: 64,
  },
  regime: { label: "Uptrend", riskLevel: "Moderate", trendStrength: "Strong" },
  scanner: { bearish: 40, bullish: 120, total: 500, withSetups: 160 },
  setups: [],
  themes: [],
  vix: { level: 15, percentile1Year: 22, regime: "Calm", trend: "Falling" },
};

const pgError = () => Object.assign(new Error("deadlock"), { code: "40P01" });

const operation = (operations: Operation[], index: number): Operation => {
  const found = operations[index];
  if (found === undefined) throw new Error(`no operation ${index}`);
  return found;
};

describe("research screen repository", () => {
  describe("claimSlot", () => {
    it("locks, checks the three refusal rules and inserts the run with the first lease", async () => {
      const run = { fence: 1, id: RUN_ID, status: "running" };
      const { database, operations } = createDouble([[], [], [run]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.claimSlot({
          labels: ["open"],
          owner: "request-1",
          slotAt: SLOT,
          total: 58,
        })
      ).resolves.toBe(run);

      expect(operations.map((entry) => entry.kind)).toEqual([
        "execute",
        "select",
        "insert",
      ]);
      expect(render(operation(operations, 0).statement).text).toContain(
        "pg_advisory_xact_lock"
      );
      const check = render(operation(operations, 1).where);
      expect(check.text).toBe(
        '("research_screen_runs"."status" = $1 or "research_screen_runs"."slot_at" >= $2)'
      );
      expect(check.params).toEqual(["running", SLOT.toISOString()]);
      const insert = operation(operations, 2);
      expect(insert.table).toBe(researchScreenRuns);
      expect(insert.conflict).toBe("nothing");
      expect(insert.values).toMatchObject({
        fence: 1,
        leaseOwner: "request-1",
        slotAt: SLOT,
        slotLabels: ["open"],
        status: "running",
        total: 58,
      });
      expect(render(insert.values?.["claimedAt"]).text).toBe("now()");
      expect(render(insert.values?.["deadlineAt"])).toEqual({
        params: [RESEARCH_SCREEN_DEADLINE_MINUTES],
        text: "now() + make_interval(mins => $1)",
      });
      expect(render(insert.values?.["leaseExpiresAt"])).toEqual({
        params: [RESEARCH_SCREEN_LEASE_SECONDS],
        text: "now() + make_interval(secs => $1)",
      });
    });

    it("refuses without an insert when a run is running or a newer or equal slot exists", async () => {
      const { database, operations } = createDouble([[], [{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.claimSlot({
          labels: [],
          owner: "request-1",
          slotAt: SLOT,
          total: 0,
        })
      ).resolves.toBeNull();
      expect(operations.map((entry) => entry.kind)).toEqual([
        "execute",
        "select",
      ]);
    });

    it("returns null when a unique index refuses the insert", async () => {
      const { database } = createDouble([[], [], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.claimSlot({
          labels: [],
          owner: "request-1",
          slotAt: SLOT,
          total: 1,
        })
      ).resolves.toBeNull();
    });
  });

  describe("leases", () => {
    it("takes a free or expired lease of a running run and returns the run with the raised fence", async () => {
      const run = { fence: 3, id: RUN_ID, succeeded: 4 };
      const { database, operations } = createDouble([[run]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.takeLease(RUN_ID, "request-2")).resolves.toBe(
        run
      );

      const update = operation(operations, 0);
      expect(update.table).toBe(researchScreenRuns);
      expect(update.set?.["leaseOwner"]).toBe("request-2");
      expect(render(update.set?.["fence"]).text).toBe(
        '"research_screen_runs"."fence" + 1'
      );
      expect(render(update.set?.["leaseExpiresAt"]).text).toBe(
        "now() + make_interval(secs => $1)"
      );
      const where = render(update.where);
      expect(where.text).toBe(
        '("research_screen_runs"."id" = $1 and "research_screen_runs"."status" = $2 and ("research_screen_runs"."lease_expires_at" is null or "research_screen_runs"."lease_expires_at" <= now()))'
      );
      expect(where.params).toEqual([RUN_ID, "running"]);
    });

    it("returns null while the lease is live", async () => {
      const { database } = createDouble([[]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.takeLease(RUN_ID, "request-2")
      ).resolves.toBeNull();
    });

    it("renews only with the current fence of a running run", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.renewLease(RUN_ID, 2)).resolves.toBe(true);
      await expect(repository.renewLease(RUN_ID, 1)).resolves.toBe(false);

      const update = operation(operations, 0);
      expect(Object.keys(update.set ?? {})).toEqual(["leaseExpiresAt"]);
      const where = render(update.where);
      expect(where.text).toBe(
        '("research_screen_runs"."id" = $1 and "research_screen_runs"."status" = $2 and "research_screen_runs"."fence" = $3)'
      );
      expect(where.params).toEqual([RUN_ID, "running", 2]);
    });

    it("releases only with the current fence of a running run", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.releaseLease(RUN_ID, 2)).resolves.toBe(true);
      await expect(repository.releaseLease(RUN_ID, 1)).resolves.toBe(false);

      const update = operation(operations, 0);
      expect(update.table).toBe(researchScreenRuns);
      expect(update.set).toEqual({ leaseExpiresAt: null, leaseOwner: null });
      const where = render(update.where);
      expect(where.text).toBe(
        '("research_screen_runs"."id" = $1 and "research_screen_runs"."status" = $2 and "research_screen_runs"."fence" = $3)'
      );
      expect(where.params).toEqual([RUN_ID, "running", 2]);
      expect(render(operation(operations, 1).where).params).toEqual([
        RUN_ID,
        "running",
        1,
      ]);
    });
  });

  describe("closeExpiredRun", () => {
    it("interrupts a running run whose deadline and lease have passed", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.closeExpiredRun(RUN_ID)).resolves.toBe(true);
      await expect(repository.closeExpiredRun(RUN_ID)).resolves.toBe(false);

      const update = operation(operations, 0);
      expect(update.set).toMatchObject({
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "interrupted",
      });
      expect(render(update.set?.["finishedAt"]).text).toBe("now()");
      expect(render(update.set?.["notReached"]).text).toBe(
        'greatest("research_screen_runs"."total" - "research_screen_runs"."succeeded" - "research_screen_runs"."failed", 0)'
      );
      expect(render(update.where).text).toBe(
        '("research_screen_runs"."id" = $1 and "research_screen_runs"."status" = $2 and "research_screen_runs"."deadline_at" <= now() and ("research_screen_runs"."lease_expires_at" is null or "research_screen_runs"."lease_expires_at" <= now()))'
      );
    });
  });

  describe("finishRun", () => {
    it("sets the status, the counts and the cut message, and clears the lease", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.finishRun(RUN_ID, 2, "partial", "m".repeat(301), 3)
      ).resolves.toBe(true);

      const update = operation(operations, 0);
      expect(update.set).toMatchObject({
        leaseExpiresAt: null,
        leaseOwner: null,
        message: "m".repeat(300),
        notReached: 3,
        status: "partial",
      });
      expect(render(update.set?.["finishedAt"]).text).toBe("now()");
      // The total follows the reports of the run: attempted plus not reached.
      expect(render(update.set?.["total"])).toEqual({
        params: [3],
        text: '"research_screen_runs"."succeeded" + "research_screen_runs"."failed" + $1',
      });
      expect(render(update.where).params).toEqual([RUN_ID, "running", 2]);
    });

    it("returns false for an old fence and stores no message when none is given", async () => {
      const { database, operations } = createDouble([[]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.finishRun(RUN_ID, 1, "completed", null, 0)
      ).resolves.toBe(false);
      expect(operation(operations, 0).set?.["message"]).toBeNull();
    });
  });

  describe("saveBars", () => {
    const bars = [{ c: 101, date: "2026-11-13", h: 102, l: 99, o: 100 }];

    it("locks the run row and replaces the stored bars", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.saveBars(RUN_ID, 2, "AAPL", "AAPL", "2026-11-13", bars)
      ).resolves.toBe(true);

      const lock = operation(operations, 0);
      expect(lock.lock).toBe("update");
      expect(render(lock.where).params).toEqual([RUN_ID, "running", 2]);
      const upsert = operation(operations, 1);
      const stored = {
        bars,
        fetchedAt: AT,
        providerSymbol: "AAPL",
        sessionDate: "2026-11-13",
      };
      expect(upsert.table).toBe(researchScreenBars);
      expect(upsert.values).toEqual({ ...stored, reportId: "AAPL" });
      expect(upsert.conflictSet).toEqual(stored);
    });

    it("writes nothing for an old fence", async () => {
      const { database, operations } = createDouble([[]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.saveBars(RUN_ID, 1, "AAPL", "AAPL", "2026-11-13", bars)
      ).resolves.toBe(false);
      expect(operations).toHaveLength(1);
    });
  });

  describe("writeRow", () => {
    const counterText = (set: Operation["set"]) =>
      Object.fromEntries(
        Object.entries(set ?? {}).map(([key, value]) => [
          key,
          render(value).text.replaceAll('"research_screen_runs".', ""),
        ])
      );

    it("stores a good observation, replaces the whole row and counts a success", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.writeRow(RUN_ID, 2, good())).resolves.toBe(true);

      const counters = operation(operations, 0);
      expect(counters.table).toBe(researchScreenRuns);
      expect(render(counters.where).params).toEqual([RUN_ID, "running", 2]);
      expect(counterText(counters.set)).toEqual({
        barsFromIbkr: '"bars_from_ibkr" + 1',
        barsFromYahoo: '"bars_from_yahoo"',
        failed: '"failed"',
        ibkrFailuresInRow: "0",
        succeeded: '"succeeded" + 1',
        yahooRateLimitsInRow: "0",
      });
      const upsert = operation(operations, 1);
      const stored = {
        attemptAt: AT,
        attemptRunId: RUN_ID,
        barsSource: "ibkr",
        errorCode: null,
        errorMessage: null,
        goodAt: AT,
        goodRunId: RUN_ID,
        historyAt: AT,
        observation,
        providerSymbol: "AAPL",
        quoteAt: AT,
        quoteSource: "yahoo",
      };
      expect(upsert.table).toBe(researchScreenRows);
      expect(upsert.values).toEqual({ ...stored, reportId: "AAPL" });
      expect(upsert.conflictSet).toEqual(stored);
    });

    it("counts an observation with the action unavailable as failed", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await repository.writeRow(
        RUN_ID,
        2,
        good({
          barsSource: "yahoo",
          observation: { ...observation, action: "unavailable" },
          stops: { ibkrFailed: true, yahooRateLimited: false },
        })
      );

      expect(counterText(operation(operations, 0).set)).toEqual({
        barsFromIbkr: '"bars_from_ibkr"',
        barsFromYahoo: '"bars_from_yahoo" + 1',
        failed: '"failed" + 1',
        ibkrFailuresInRow: '"ibkr_failures_in_row" + 1',
        succeeded: '"succeeded"',
        yahooRateLimitsInRow: "0",
      });
      expect(operation(operations, 1).values?.["goodRunId"]).toBe(RUN_ID);
    });

    it("stores a failed attempt and keeps the good columns only for the same provider symbol", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(
        repository.writeRow(
          RUN_ID,
          2,
          failed({ errorMessage: "e".repeat(301) })
        )
      ).resolves.toBe(true);

      expect(counterText(operation(operations, 0).set)).toEqual({
        barsFromIbkr: '"bars_from_ibkr"',
        barsFromYahoo: '"bars_from_yahoo"',
        failed: '"failed" + 1',
        ibkrFailuresInRow: '"ibkr_failures_in_row"',
        succeeded: '"succeeded"',
        yahooRateLimitsInRow: '"yahoo_rate_limits_in_row" + 1',
      });
      const upsert = operation(operations, 1);
      const attempt = {
        attemptAt: AT,
        attemptRunId: RUN_ID,
        errorCode: "provider-timeout",
        errorMessage: "e".repeat(300),
        providerSymbol: "AAPL",
      };
      expect(upsert.values).toEqual({ ...attempt, reportId: "AAPL" });
      expect(upsert.conflictSet).toMatchObject(attempt);
      const kept = Object.fromEntries(
        [
          "barsSource",
          "goodAt",
          "goodRunId",
          "historyAt",
          "observation",
          "quoteAt",
          "quoteSource",
        ].map((key) => [key, render(upsert.conflictSet?.[key]).text])
      );
      const keep = (column: string) =>
        `case when "research_screen_rows"."provider_symbol" = excluded.provider_symbol then "research_screen_rows"."${column}" end`;
      expect(kept).toEqual({
        barsSource: keep("bars_source"),
        goodAt: keep("good_at"),
        goodRunId: keep("good_run_id"),
        historyAt: keep("history_at"),
        observation: keep("observation"),
        quoteAt: keep("quote_at"),
        quoteSource: keep("quote_source"),
      });
    });

    it("leaves both stop counters when no request was made", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database, clock);

      await repository.writeRow(
        RUN_ID,
        2,
        failed({ stops: { ibkrFailed: null, yahooRateLimited: null } })
      );

      expect(counterText(operation(operations, 0).set)).toMatchObject({
        ibkrFailuresInRow: '"ibkr_failures_in_row"',
        yahooRateLimitsInRow: '"yahoo_rate_limits_in_row"',
      });
    });

    it("writes no row for an old fence", async () => {
      const { database, operations } = createDouble([[]]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.writeRow(RUN_ID, 1, failed())).resolves.toBe(
        false
      );
      expect(operations).toHaveLength(1);
    });
  });

  describe("reads", () => {
    it("finds the active run or null", async () => {
      const run = { id: RUN_ID };
      const { database, operations } = createDouble([[run], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.findActiveRun()).resolves.toBe(run);
      await expect(repository.findActiveRun()).resolves.toBeNull();
      expect(render(operation(operations, 0).where).params).toEqual([
        "running",
      ]);
    });

    it("counts the catalog reports", async () => {
      const { database, operations } = createDouble([[{ reports: 58 }], []]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.countReports()).resolves.toBe(58);
      await expect(repository.countReports()).resolves.toBe(0);
      expect(operation(operations, 0).table).toBe(researchReports);
    });

    it("lists the reports not attempted in the run, oldest attempt first", async () => {
      const items = [{ bars: null, report: { id: "AAPL" }, row: null }];
      const { database, operations } = createDouble([items]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.listWork(RUN_ID)).resolves.toBe(items);

      const select = operation(operations, 0);
      expect(select.table).toBe(researchReports);
      const where = render(select.where);
      expect(where.text).toBe(
        '("research_screen_rows"."attempt_run_id" is null or "research_screen_rows"."attempt_run_id" <> $1)'
      );
      expect(where.params).toEqual([RUN_ID]);
      expect(render(select.order?.[0]).text).toBe(
        '"research_screen_rows"."attempt_at" asc nulls first'
      );
      expect(select.order).toHaveLength(3);
    });

    it("reads the whole status", async () => {
      const scheduler = { lastTickAt: AT, lastTickDecision: "busy" };
      const activeRun = { id: RUN_ID };
      const lastRun = { id: "last" };
      const statusRows = [{ report: { id: "AAPL" }, row: null }];
      const swinglytics = { snapshot };
      const { database, operations } = createDouble([
        [scheduler],
        [activeRun],
        [lastRun],
        [{ slotAt: SLOT }],
        statusRows,
        [swinglytics],
      ]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.readStatus()).resolves.toEqual({
        activeRun,
        lastRun,
        rows: statusRows,
        runsSince: [SLOT],
        scheduler,
        swinglytics,
      });
      expect(operations.map((entry) => entry.table)).toEqual([
        researchScreenScheduler,
        researchScreenRuns,
        researchScreenRuns,
        researchScreenRuns,
        researchReports,
        researchScreenSwinglytics,
      ]);
      expect(render(operation(operations, 2).where).text).toBe(
        '"research_screen_runs"."status" <> $1'
      );
      expect(render(operation(operations, 3).where).text).toBe(
        '"research_screen_runs"."claimed_at" > now() - interval \'24 hours\''
      );
    });

    it("reads an empty status", async () => {
      const { database } = createDouble();
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.readStatus()).resolves.toEqual({
        activeRun: null,
        lastRun: null,
        rows: [],
        runsSince: [],
        scheduler: null,
        swinglytics: null,
      });
    });
  });

  describe("single rows", () => {
    it("records a tick with the database clock", async () => {
      const { database, operations } = createDouble();
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.recordTick("not-due")).resolves.toBeUndefined();

      const upsert = operation(operations, 0);
      expect(upsert.table).toBe(researchScreenScheduler);
      expect(upsert.values).toMatchObject({
        id: 1,
        lastTickDecision: "not-due",
      });
      expect(render(upsert.values?.["lastTickAt"]).text).toBe("now()");
      expect(upsert.conflictSet?.["lastTickDecision"]).toBe("not-due");
      expect(render(upsert.conflictSet?.["lastTickAt"]).text).toBe("now()");
    });

    it("stores a Swinglytics success", async () => {
      const { database, operations } = createDouble();
      const repository = createResearchScreenRepository(database, clock);

      await repository.saveSwinglytics({
        generatedAt: SLOT,
        kind: "ok",
        snapshot,
      });

      const stored = {
        generatedAt: SLOT,
        lastAttemptAt: AT,
        lastAttemptStatus: "ok",
        lastError: null,
        retrievedAt: AT,
        snapshot,
      };
      const upsert = operation(operations, 0);
      expect(upsert.table).toBe(researchScreenSwinglytics);
      expect(upsert.values).toEqual({ ...stored, id: 1 });
      expect(upsert.conflictSet).toEqual(stored);
    });

    it("stores a Swinglytics failure without touching the snapshot", async () => {
      const { database, operations } = createDouble();
      const repository = createResearchScreenRepository(database, clock);

      await repository.saveSwinglytics({
        kind: "error",
        message: "x".repeat(241),
      });

      const stored = {
        lastAttemptAt: AT,
        lastAttemptStatus: "error",
        lastError: "x".repeat(240),
      };
      const upsert = operation(operations, 0);
      expect(upsert.values).toEqual({ ...stored, id: 1 });
      expect(upsert.conflictSet).toEqual(stored);
    });
  });

  describe("failures and the default clock", () => {
    it("turns a Postgres failure into DatabasePersistenceError", async () => {
      const { database } = createDouble([pgError(), pgError()]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.findActiveRun()).rejects.toBeInstanceOf(
        DatabasePersistenceError
      );
      await expect(repository.recordTick("busy")).rejects.toThrow(
        "Database operation failed: research screen"
      );
    });

    it("passes any other failure through", async () => {
      const { database } = createDouble([new Error("not postgres")]);
      const repository = createResearchScreenRepository(database, clock);

      await expect(repository.readStatus()).rejects.toThrow("not postgres");
    });

    it("uses the system clock when none is given", async () => {
      const { database, operations } = createDouble([[{ id: RUN_ID }]]);
      const repository = createResearchScreenRepository(database);
      const before = Date.now();

      await repository.writeRow(RUN_ID, 1, failed());

      const attemptAt = operation(operations, 1).values?.["attemptAt"];
      expect(attemptAt).toBeInstanceOf(Date);
      expect((attemptAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });
  });
});
