import {
  researchScreenBars,
  researchScreenRows,
  researchScreenRuns,
  researchScreenScheduler,
  researchScreenSwinglytics,
} from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createResearchReportsRepository,
  createResearchScreenRepository,
  type Database,
  type ResearchScreenFailedRowWrite,
  type ResearchScreenGoodRowWrite,
  type ResearchScreenObservationValue,
  type ResearchScreenRunRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadResearchCatalog } from "../../../scripts/research-reports/load.ts";
import {
  FIXTURE_ROOT,
  researchFixture,
} from "../../../scripts/research-reports/test-fixtures.ts";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const SLOT_1 = new Date("2026-11-16T12:00:00.000Z");
const SLOT_2 = new Date("2026-11-16T16:00:00.000Z");
const SLOT_3 = new Date("2026-11-16T20:00:00.000Z");
const FIRST = "FLAT";
const SECOND = "TWO";

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
  historyAt: SLOT_1,
  kind: "good",
  observation,
  providerSymbol: FIRST,
  quoteAt: SLOT_1,
  quoteSource: "yahoo",
  reportId: FIRST,
  stops: { ibkrFailed: false, yahooRateLimited: false },
  ...edit,
});

const failed = (
  edit: Partial<ResearchScreenFailedRowWrite> = {}
): ResearchScreenFailedRowWrite => ({
  barsSource: null,
  errorCode: "provider-timeout",
  errorMessage: "The read timed out",
  kind: "failed",
  providerSymbol: FIRST,
  reportId: FIRST,
  stops: { ibkrFailed: null, yahooRateLimited: false },
  ...edit,
});

const claim = async (
  slotAt: Date,
  owner = "request-1",
  total = 2
): Promise<ResearchScreenRunRecord> => {
  const run = await createResearchScreenRepository(database()).claimSlot({
    labels: ["grid"],
    owner,
    slotAt,
    total,
  });
  if (run === null) throw new Error("claim refused");
  return run;
};

const storedRun = async (id: string): Promise<ResearchScreenRunRecord> => {
  const all = await database().select().from(researchScreenRuns);
  const run = all.find((candidate) => candidate.id === id);
  if (run === undefined) throw new Error("run not found");
  return run;
};

const storedRow = async (reportId: string) => {
  const all = await database().select().from(researchScreenRows);
  return all.find((row) => row.reportId === reportId) ?? null;
};

/**
 * Moves the lease end (and optionally the deadline) of the running run into the past. At most one
 * run is running, so the status names the row.
 */
const expire = (deadline = false) =>
  database().execute(
    `update research_screen_runs set lease_expires_at = now() - interval '1 second'${
      deadline ? ", deadline_at = now() - interval '1 second'" : ""
    } where status = 'running'`
  );

/** Moves only the deadline of the running run into the past; its lease stays as it is. */
const passDeadline = () =>
  database().execute(
    "update research_screen_runs set deadline_at = now() - interval '1 second' where status = 'running'"
  );

describe("research screen repository (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
    const input = await loadResearchCatalog(FIXTURE_ROOT, researchFixture().fs);
    expect(input.reports.map((report) => report.id).sort()).toEqual([
      FIRST,
      SECOND,
    ]);
    await createResearchReportsRepository(resource.db).replaceCatalog(input);
  }, 60_000);

  beforeEach(async () => {
    await database().delete(researchScreenRows);
    await database().delete(researchScreenBars);
    await database().delete(researchScreenRuns);
    await database().delete(researchScreenScheduler);
    await database().delete(researchScreenSwinglytics);
  });

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined) {
        await dropPostgresTestDatabase(testDatabase);
      }
    }
  });

  it("claims a slot with the first lease and applies the three refusal rules", async () => {
    const repository = createResearchScreenRepository(database());

    const run = await claim(SLOT_2);
    expect(run).toMatchObject({
      failed: 0,
      fence: 1,
      finishedAt: null,
      leaseOwner: "request-1",
      slotAt: SLOT_2,
      slotLabels: ["grid"],
      status: "running",
      succeeded: 0,
      total: 2,
    });
    expect(run.deadlineAt.getTime() - run.claimedAt.getTime()).toBe(
      25 * 60_000
    );
    expect((run.leaseExpiresAt?.getTime() ?? 0) - run.claimedAt.getTime()).toBe(
      240_000
    );
    await expect(repository.findActiveRun()).resolves.toEqual(run);

    const refuse = (slotAt: Date) =>
      repository.claimSlot({
        labels: [],
        owner: "request-2",
        slotAt,
        total: 2,
      });
    // A run is running.
    await expect(refuse(SLOT_3)).resolves.toBeNull();
    await expect(
      repository.finishRun(run.id, 1, "failed", "nothing succeeded", 2)
    ).resolves.toBe(true);
    await expect(repository.findActiveRun()).resolves.toBeNull();
    // The slot has a run.
    await expect(refuse(SLOT_2)).resolves.toBeNull();
    // A newer slot was claimed.
    await expect(refuse(SLOT_1)).resolves.toBeNull();
    await expect(refuse(SLOT_3)).resolves.toMatchObject({
      fence: 1,
      leaseOwner: "request-2",
      slotAt: SLOT_3,
    });
    await expect(
      database().select().from(researchScreenRuns)
    ).resolves.toHaveLength(2);
  });

  it("lets exactly one of two claims at one time win", async () => {
    const repository = createResearchScreenRepository(database());
    const attempt = (slotAt: Date, owner: string) =>
      repository.claimSlot({ labels: [], owner, slotAt, total: 2 });

    const sameSlot = await Promise.all([
      attempt(SLOT_1, "request-a"),
      attempt(SLOT_1, "request-b"),
    ]);
    expect(sameSlot.filter((run) => run !== null)).toHaveLength(1);

    const [winner] = sameSlot.filter((run) => run !== null);
    if (winner === undefined) throw new Error("no winner");
    await repository.finishRun(winner.id, 1, "failed", null, 2);

    const twoSlots = await Promise.all([
      attempt(SLOT_2, "request-c"),
      attempt(SLOT_3, "request-d"),
    ]);
    expect(twoSlots.filter((run) => run !== null)).toHaveLength(1);
    await expect(
      database().select().from(researchScreenRuns)
    ).resolves.toHaveLength(2);
  });

  it("hands the lease over after it expires and refuses the late writes of the old fence", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    const bars = [{ c: 101, date: "2026-11-13", h: 102, l: 99, o: 100 }];

    // The lease is live.
    await expect(repository.takeLease(run.id, "request-2")).resolves.toBeNull();
    await expect(repository.renewLease(run.id, 1)).resolves.toBe(true);

    await expire();
    const fresh = await repository.takeLease(run.id, "request-2");
    const taken = await storedRun(run.id);
    // The answer is the stored run after the takeover.
    expect(fresh).toEqual(taken);
    expect(taken.fence).toBe(2);
    expect(taken.leaseOwner).toBe("request-2");
    expect(taken.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    await expect(repository.renewLease(run.id, 1)).resolves.toBe(false);
    await expect(
      repository.saveBars(run.id, 1, FIRST, FIRST, "2026-11-13", bars)
    ).resolves.toBe(false);
    await expect(repository.writeRow(run.id, 1, good())).resolves.toBe(false);
    await expect(
      repository.finishRun(run.id, 1, "completed", null, 0)
    ).resolves.toBe(false);
    await expect(storedRow(FIRST)).resolves.toBeNull();
    await expect(database().select().from(researchScreenBars)).resolves.toEqual(
      []
    );
    expect(await storedRun(run.id)).toMatchObject({
      failed: 0,
      status: "running",
      succeeded: 0,
    });

    await expect(
      repository.saveBars(run.id, 2, FIRST, FIRST, "2026-11-13", bars)
    ).resolves.toBe(true);
    await expect(repository.writeRow(run.id, 2, good())).resolves.toBe(true);
    await expect(
      repository.finishRun(run.id, 2, "partial", "m".repeat(400), 1)
    ).resolves.toBe(true);
    const finished = await storedRun(run.id);
    expect(finished).toMatchObject({
      leaseExpiresAt: null,
      leaseOwner: null,
      notReached: 1,
      status: "partial",
      succeeded: 1,
      total: 2,
    });
    expect(finished.message).toHaveLength(300);
    expect(finished.finishedAt).toBeInstanceOf(Date);
    // An ended run takes no lease and no write.
    await expect(repository.takeLease(run.id, "request-3")).resolves.toBeNull();
    await expect(repository.writeRow(run.id, 2, failed())).resolves.toBe(false);
  });

  it("frees the lease of a share so the next tick takes it at once, twice in a row", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    await repository.writeRow(run.id, 1, good());

    // An old fence frees nothing.
    await expect(repository.releaseLease(run.id, 0)).resolves.toBe(false);
    await expect(repository.takeLease(run.id, "request-2")).resolves.toBeNull();

    await expect(repository.releaseLease(run.id, 1)).resolves.toBe(true);
    expect(await storedRun(run.id)).toMatchObject({
      fence: 1,
      leaseExpiresAt: null,
      leaseOwner: null,
      status: "running",
    });
    const second = await repository.takeLease(run.id, "request-2");
    expect(second).toMatchObject({
      fence: 2,
      id: run.id,
      leaseOwner: "request-2",
      succeeded: 1,
    });
    expect(second?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    // The released fence is old now.
    await expect(repository.releaseLease(run.id, 1)).resolves.toBe(false);
    await expect(repository.takeLease(run.id, "request-3")).resolves.toBeNull();

    await expect(repository.releaseLease(run.id, 2)).resolves.toBe(true);
    await expect(
      repository.takeLease(run.id, "request-3")
    ).resolves.toMatchObject({ fence: 3, leaseOwner: "request-3" });

    await repository.finishRun(run.id, 3, "partial", null, 1);
    // An ended run has no lease to free.
    await expect(repository.releaseLease(run.id, 3)).resolves.toBe(false);
  });

  it("counts the catalog reports and leaves the Yahoo stop counter without a request", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);

    await expect(repository.countReports()).resolves.toBe(2);

    await repository.writeRow(
      run.id,
      1,
      failed({ stops: { ibkrFailed: null, yahooRateLimited: true } })
    );
    await repository.writeRow(
      run.id,
      1,
      failed({
        providerSymbol: SECOND,
        reportId: SECOND,
        stops: { ibkrFailed: null, yahooRateLimited: null },
      })
    );
    expect(await storedRun(run.id)).toMatchObject({
      failed: 2,
      yahooRateLimitsInRow: 1,
    });
  });

  it("keeps the counters, the stop counters and the row rules", async () => {
    let at = new Date("2026-11-16T12:01:00.000Z");
    const repository = createResearchScreenRepository(database(), () => at);
    const run = await claim(SLOT_1, "request-1", 5);

    await expect(
      repository
        .listWork(run.id)
        .then((items) =>
          items.map((item) => [item.report.id, item.row, item.bars])
        )
    ).resolves.toEqual([
      [FIRST, null, null],
      [SECOND, null, null],
    ]);

    await repository.writeRow(run.id, 1, good());
    expect(await storedRun(run.id)).toMatchObject({
      barsFromIbkr: 1,
      barsFromYahoo: 0,
      failed: 0,
      ibkrFailuresInRow: 0,
      succeeded: 1,
      yahooRateLimitsInRow: 0,
    });
    expect(await storedRow(FIRST)).toMatchObject({
      attemptAt: at,
      attemptRunId: run.id,
      barsSource: "ibkr",
      errorCode: null,
      goodAt: at,
      goodRunId: run.id,
      observation,
      quoteSource: "yahoo",
    });
    await expect(
      repository
        .listWork(run.id)
        .then((items) => items.map((item) => item.report.id))
    ).resolves.toEqual([SECOND]);

    // A failed attempt keeps the good observation of the same provider symbol.
    const goodAt = at;
    at = new Date("2026-11-16T12:02:00.000Z");
    await repository.writeRow(
      run.id,
      1,
      failed({
        barsSource: "yahoo",
        stops: { ibkrFailed: true, yahooRateLimited: true },
      })
    );
    await repository.writeRow(
      run.id,
      1,
      failed({
        providerSymbol: SECOND,
        reportId: SECOND,
        stops: { ibkrFailed: true, yahooRateLimited: true },
      })
    );
    expect(await storedRun(run.id)).toMatchObject({
      barsFromIbkr: 1,
      barsFromYahoo: 1,
      failed: 2,
      ibkrFailuresInRow: 2,
      succeeded: 1,
      yahooRateLimitsInRow: 2,
    });
    expect(await storedRow(FIRST)).toMatchObject({
      attemptAt: at,
      barsSource: "ibkr",
      errorCode: "provider-timeout",
      errorMessage: "The read timed out",
      goodAt,
      goodRunId: run.id,
      observation,
    });
    expect(await storedRow(SECOND)).toMatchObject({
      attemptRunId: run.id,
      goodAt: null,
      observation: null,
    });

    // null leaves the IBKR counter; false resets a counter.
    await repository.writeRow(
      run.id,
      1,
      failed({ stops: { ibkrFailed: null, yahooRateLimited: false } })
    );
    expect(await storedRun(run.id)).toMatchObject({
      ibkrFailuresInRow: 2,
      yahooRateLimitsInRow: 0,
    });
    // An observation with the action "unavailable" counts as failed.
    await repository.writeRow(
      run.id,
      1,
      good({
        barsSource: "yahoo",
        observation: { ...observation, action: "unavailable" },
      })
    );
    expect(await storedRun(run.id)).toMatchObject({
      barsFromYahoo: 2,
      failed: 4,
      ibkrFailuresInRow: 0,
      succeeded: 1,
    });

    // A failed attempt under another provider symbol clears the good observation.
    await repository.writeRow(run.id, 1, failed({ providerSymbol: "FLAT.L" }));
    expect(await storedRow(FIRST)).toMatchObject({
      barsSource: null,
      goodAt: null,
      goodRunId: null,
      historyAt: null,
      observation: null,
      providerSymbol: "FLAT.L",
      quoteAt: null,
      quoteSource: null,
    });

    await expect(
      repository.finishRun(run.id, 1, "partial", null, 0)
    ).resolves.toBe(true);
    // The claim said 5 reports; the run attempted 6 and left none: the total follows the run.
    expect(await storedRun(run.id)).toMatchObject({
      failed: 5,
      notReached: 0,
      succeeded: 1,
      total: 6,
    });
  });

  it("orders the work of the next run by the oldest attempt and reads the status", async () => {
    let at = new Date("2026-11-16T12:01:00.000Z");
    const repository = createResearchScreenRepository(database(), () => at);
    const first = await claim(SLOT_1);
    await repository.writeRow(
      first.id,
      1,
      good({ providerSymbol: SECOND, reportId: SECOND })
    );
    at = new Date("2026-11-16T12:02:00.000Z");
    await repository.writeRow(first.id, 1, failed());
    await repository.saveBars(first.id, 1, FIRST, FIRST, "2026-11-13", [
      { c: 101, date: "2026-11-13", h: 102, l: 99, o: 100 },
    ]);
    await repository.finishRun(first.id, 1, "partial", "one failed", 0);

    const second = await claim(SLOT_2);
    const work = await repository.listWork(second.id);
    expect(work.map((item) => item.report.id)).toEqual([SECOND, FIRST]);
    expect(work[1]?.bars).toMatchObject({
      fetchedAt: at,
      providerSymbol: FIRST,
      sessionDate: "2026-11-13",
    });
    expect(work[0]?.bars).toBeNull();
    expect(work[0]?.row?.goodRunId).toBe(first.id);

    await repository.recordTick("claimed");
    await repository.recordTick("busy");
    await repository.saveSwinglytics({
      kind: "error",
      message: "x".repeat(300),
    });
    const status = await repository.readStatus();
    expect(status.scheduler?.lastTickDecision).toBe("busy");
    expect(status.scheduler?.lastTickAt).toBeInstanceOf(Date);
    expect(status.activeRun?.id).toBe(second.id);
    expect(status.lastRun).toMatchObject({
      id: first.id,
      message: "one failed",
      notReached: 0,
      status: "partial",
    });
    expect(status.runsSince).toEqual([SLOT_2, SLOT_1]);
    expect(
      status.rows.map((entry) => [entry.report.id, entry.row?.errorCode])
    ).toEqual([
      [FIRST, "provider-timeout"],
      [SECOND, null],
    ]);
    expect(status.swinglytics).toEqual({
      generatedAt: null,
      lastAttemptAt: at,
      lastAttemptStatus: "error",
      lastError: "x".repeat(240),
      retrievedAt: null,
      snapshot: null,
    });

    const snapshot = {
      breadth: {
        above20DayPercent: 61,
        above50DayPercent: 58,
        above200DayPercent: 55,
        regime: "Healthy",
        score: 64,
      },
      regime: { label: "Uptrend", riskLevel: null, trendStrength: "Strong" },
      scanner: { bearish: 40, bullish: 120, total: 500, withSetups: 160 },
      setups: [],
      themes: [],
      vix: { level: 15, percentile1Year: 22, regime: "Calm", trend: null },
    };
    await repository.saveSwinglytics({
      generatedAt: SLOT_1,
      kind: "ok",
      snapshot,
    });
    const okAt = at;
    at = new Date("2026-11-16T12:03:00.000Z");
    await repository.saveSwinglytics({ kind: "error", message: "HTTP 503" });
    await expect(
      repository.readStatus().then((read) => read.swinglytics)
    ).resolves.toEqual({
      generatedAt: SLOT_1,
      lastAttemptAt: at,
      lastAttemptStatus: "error",
      lastError: "HTTP 503",
      retrievedAt: okAt,
      snapshot,
    });
  });

  it("interrupts a run only after its deadline and its lease have passed", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    await repository.writeRow(run.id, 1, good());

    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);
    await expire();
    // The lease passed, the deadline did not.
    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);
    await repository.takeLease(run.id, "request-2");
    await passDeadline();
    // The deadline passed, the lease is live.
    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);

    await expire(true);
    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(true);
    const closed = await storedRun(run.id);
    expect(closed).toMatchObject({
      leaseOwner: null,
      notReached: 1,
      status: "interrupted",
      succeeded: 1,
    });
    expect(closed.finishedAt).toBeInstanceOf(Date);
    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);
    await expect(
      repository.claimSlot({
        labels: [],
        owner: "request-3",
        slotAt: SLOT_2,
        total: 2,
      })
    ).resolves.not.toBeNull();
  });

  it("does not interrupt a run past its deadline whose lease was released, and hands its lease on", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    await repository.writeRow(run.id, 1, good());
    await expect(repository.releaseLease(run.id, 1)).resolves.toBe(true);
    await passDeadline();
    const released = await storedRun(run.id);
    expect(released.leaseExpiresAt).toBeNull();
    expect(released.deadlineAt.getTime()).toBeLessThan(Date.now());

    // A released lease is not an expired one: no holder vanished.
    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);
    expect(await storedRun(run.id)).toMatchObject({
      finishedAt: null,
      leaseExpiresAt: null,
      notReached: 0,
      status: "running",
    });

    // The next share takes the lease and ends the run by its counts.
    await expect(
      repository.takeLease(run.id, "request-2")
    ).resolves.toMatchObject({
      fence: 2,
      id: run.id,
      leaseOwner: "request-2",
      status: "running",
      succeeded: 1,
    });
    await expect(
      repository.finishRun(run.id, 2, "partial", "1 of 2 reports screened", 1)
    ).resolves.toBe(true);
    expect(await storedRun(run.id)).toMatchObject({
      notReached: 1,
      status: "partial",
      succeeded: 1,
      total: 2,
    });
  });

  it("interrupts a run past its deadline whose lease is set and expired, with the reports not reached", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1, "request-1", 5);
    await repository.writeRow(run.id, 1, good());
    await repository.writeRow(
      run.id,
      1,
      failed({ providerSymbol: SECOND, reportId: SECOND })
    );
    await expire(true);
    const abandoned = await storedRun(run.id);
    expect(abandoned.leaseOwner).toBe("request-1");
    expect(abandoned.leaseExpiresAt?.getTime()).toBeLessThan(Date.now());

    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(true);

    const closed = await storedRun(run.id);
    expect(closed).toMatchObject({
      failed: 1,
      leaseExpiresAt: null,
      leaseOwner: null,
      // 5 claimed - 1 succeeded - 1 failed.
      notReached: 3,
      status: "interrupted",
      succeeded: 1,
      total: 5,
    });
    expect(closed.finishedAt).toBeInstanceOf(Date);
    await expect(repository.findActiveRun()).resolves.toBeNull();
    // An ended run takes no lease.
    await expect(repository.takeLease(run.id, "request-2")).resolves.toBeNull();
  });

  it("does not interrupt a run past its deadline whose lease is still live", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    await passDeadline();
    const held = await storedRun(run.id);
    expect(held.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    await expect(repository.closeExpiredRun(run.id)).resolves.toBe(false);

    expect(await storedRun(run.id)).toMatchObject({
      finishedAt: null,
      leaseOwner: "request-1",
      status: "running",
    });
    // The holder still works: its writes are accepted and no other tick gets the lease.
    await expect(repository.takeLease(run.id, "request-2")).resolves.toBeNull();
    await expect(repository.writeRow(run.id, 1, good())).resolves.toBe(true);
  });

  it("removes the row and the bars of a report that leaves the catalog", async () => {
    const repository = createResearchScreenRepository(database());
    const run = await claim(SLOT_1);
    for (const reportId of [FIRST, SECOND]) {
      await repository.writeRow(
        run.id,
        1,
        good({ providerSymbol: reportId, reportId })
      );
      await repository.saveBars(run.id, 1, reportId, reportId, "2026-11-13", [
        { c: 101, date: "2026-11-13", h: 102, l: 99, o: 100 },
      ]);
    }

    const input = await loadResearchCatalog(FIXTURE_ROOT, researchFixture().fs);
    const result = await createResearchReportsRepository(
      database()
    ).replaceCatalog(
      {
        categories: [],
        companyResearch: input.companyResearch,
        reports: input.reports.filter((report) => report.id === SECOND),
        revisions: input.revisions.filter(
          (revision) => revision.reportId === SECOND
        ),
      },
      { allowRemoval: true }
    );
    expect(result.reportsRemoved).toBe(1);

    await expect(
      database()
        .select({ id: researchScreenRows.reportId })
        .from(researchScreenRows)
    ).resolves.toEqual([{ id: SECOND }]);
    await expect(
      database()
        .select({ id: researchScreenBars.reportId })
        .from(researchScreenBars)
    ).resolves.toEqual([{ id: SECOND }]);
    await expect(
      repository
        .listWork("00000000-0000-4000-8000-000000000000")
        .then((items) => items.map((item) => item.report.id))
    ).resolves.toEqual([SECOND]);
    expect((await storedRun(run.id)).succeeded).toBe(2);
  });
});
