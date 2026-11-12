import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { goLiveDraftRuns, goLiveDrafts, goLivePlans } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createGoLiveDraftsRepository,
  type GoLiveDraftCandidateInput,
  GoLiveDraftConflictError,
  GoLiveDraftNotFoundError,
  GoLivePlanMismatchError,
  type GoLivePlanSeedInput,
  goLiveEntryDraftId,
} from "./golive-drafts.ts";

const NOW = new Date("2026-11-11T21:15:00.000Z");
const GENERATED_AT = new Date("2026-11-11T14:35:00.000Z");
const DAY = "2026-11-11";
const dialect = new PgDialect();

interface Operation {
  conflict?: "nothing" | Record<string, unknown>;
  fields?: unknown;
  kind: "select" | "insert" | "update";
  limit?: number;
  orderBy?: unknown[];
  returning?: boolean;
  set?: unknown;
  table?: unknown;
  target?: unknown;
  values?: unknown;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued rows.
const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      onConflictDoNothing: (config: { target: unknown }) => {
        operation.conflict = "nothing";
        operation.target = config.target;
        return chain;
      },
      onConflictDoUpdate: (config: Record<string, unknown>) => {
        operation.conflict = config;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: () => {
        operation.returning = true;
        return chain;
      },
      set: (values: unknown) => {
        operation.set = values;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
      values: (values: unknown) => {
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
  const transactions: unknown[] = [];
  const database = {
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: (fields?: unknown) => builder({ fields, kind: "select" }),
    transaction: async (operation: (transaction: unknown) => unknown) => {
      transactions.push(operation);
      return await operation(database);
    },
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations, transactions };
};

const query = (condition: SQL | undefined) => {
  const { params, sql } = dialect.sqlToQuery(condition as SQL);
  return { params, sql };
};

const SEED: GoLivePlanSeedInput = {
  approvalBasis: null,
  approvedBy: null,
  evidenceUrl: null,
  id: "test-plan",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 4,
    positionRiskPct: 1,
  },
  name: "Test plan",
  ownerMessageUrl: null,
  sleeves: [
    {
      anchorDelta: 0.5,
      budgetPct: 2,
      definitionNote: "Always on.",
      definitionVariant: "always_on_entry",
      dteMin: 45,
      dteTarget: 60,
      key: "long-index",
      name: "Long index",
      runKey: "oil-predicts-equity/B",
      structure: "callDebitVertical",
      symbols: ["SPY", "QQQ"],
      widthSigma: 1,
    },
  ],
  status: "proposed",
};

const planRow = (overrides: Record<string, unknown> = {}) => ({
  approvalBasis: null,
  approvedAt: null,
  approvedBy: null,
  createdAt: NOW,
  evidenceUrl: null,
  exitRule: "owner_standing_rule_v1",
  id: SEED.id,
  limits: SEED.limits,
  name: SEED.name,
  ownerMessageUrl: null,
  retiredAt: null,
  sleeves: SEED.sleeves,
  status: "proposed",
  updatedAt: NOW,
  version: 3,
  ...overrides,
});

const candidate = (
  overrides: Partial<GoLiveDraftCandidateInput> = {}
): GoLiveDraftCandidateInput => ({
  entryBasis: "signal_today",
  expiry: "20270115",
  longStrike: 600,
  quote: null,
  shortStrike: 620.5,
  signalFacts: ["VIX 19.5 on 2026-11-11"],
  sleeveKey: "long-index",
  structure: "callDebitVertical",
  symbol: "SPY",
  ...overrides,
});

const draftRow = (overrides: Record<string, unknown> = {}) => ({
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  expiry: "20270115",
  id: "draft-1",
  kind: "entry",
  longStrike: 600,
  nodeBadgeAtDecision: null,
  parentDraftId: null,
  planId: SEED.id,
  planVersion: 3,
  quote: null,
  shortStrike: 620.5,
  signalFacts: ["VIX 19.5 on 2026-11-11"],
  sleeveKey: "long-index",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  tradingDay: DAY,
  updatedAt: NOW,
  ...overrides,
});

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

const repositoryFor = (database: Database) =>
  createGoLiveDraftsRepository(database, { now: () => NOW });

const RUN = {
  generatedAt: GENERATED_AT,
  planId: SEED.id,
  planVersion: 3,
  tradingDay: DAY,
};

describe("goLiveEntryDraftId", () => {
  it("is the first 32 hex characters of the SHA-256 of the documented key", async () => {
    const id = await goLiveEntryDraftId(RUN, candidate());
    expect(id).toBe(
      sha(
        "test-plan|3|2026-11-11|entry|long-index|SPY|callDebitVertical|20270115|600|620.5"
      )
    );
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("changes with the plan version, the trading day and the structure, and with nothing else", async () => {
    const base = await goLiveEntryDraftId(RUN, candidate());
    const others = await Promise.all([
      goLiveEntryDraftId({ ...RUN, planVersion: 4 }, candidate()),
      goLiveEntryDraftId({ ...RUN, planId: "other" }, candidate()),
      goLiveEntryDraftId({ ...RUN, tradingDay: "2026-11-12" }, candidate()),
      goLiveEntryDraftId(RUN, candidate({ sleeveKey: "rotation" })),
      goLiveEntryDraftId(RUN, candidate({ symbol: "QQQ" })),
      goLiveEntryDraftId(RUN, candidate({ structure: "putCreditVertical" })),
      goLiveEntryDraftId(RUN, candidate({ expiry: "20270219" })),
      goLiveEntryDraftId(RUN, candidate({ longStrike: 601 })),
      goLiveEntryDraftId(RUN, candidate({ shortStrike: 621 })),
    ]);
    expect(new Set([base, ...others]).size).toBe(10);
    await expect(
      goLiveEntryDraftId(
        RUN,
        candidate({
          entryBasis: "model_holds_account_does_not",
          signalFacts: [],
        })
      )
    ).resolves.toBe(base);
  });
});

describe("createGoLiveDraftsRepository", () => {
  it("reads the plan in force, or null when there is none", async () => {
    const row = planRow();
    const double = createDouble([[row], []]);
    const repository = repositoryFor(double.database);
    await expect(repository.planInForce()).resolves.toEqual(row);
    await expect(repository.planInForce()).resolves.toBeNull();
    const [select] = double.operations;
    expect(select?.table).toBe(goLivePlans);
    expect(select?.limit).toBe(1);
    expect(query(select?.where)).toEqual({
      params: ["proposed", "approved"],
      sql: '"golive_plans"."status" in ($1, $2)',
    });
  });

  it("writes a proposed plan as the next version after retiring the plan in force", async () => {
    const stored = planRow({ version: 4 });
    const double = createDouble([[], [{ version: 3 }], [stored]]);
    await expect(
      repositoryFor(double.database).writePlan(SEED, { actor: "seed-script" })
    ).resolves.toEqual(stored);
    expect(double.transactions).toHaveLength(1);
    const [retire, latest, insert] = double.operations;
    expect(retire?.kind).toBe("update");
    expect(retire?.table).toBe(goLivePlans);
    expect(retire?.set).toEqual({
      retiredAt: NOW,
      status: "retired",
      updatedAt: NOW,
    });
    expect(query(retire?.where)).toEqual({
      params: ["proposed", "approved"],
      sql: '"golive_plans"."status" in ($1, $2)',
    });
    expect(latest?.table).toBe(goLivePlans);
    expect(
      query(((latest as Operation).fields as { version: SQL }).version).sql
    ).toBe('coalesce(max("golive_plans"."version"), 0)');
    expect(insert?.kind).toBe("insert");
    expect(insert?.table).toBe(goLivePlans);
    expect(insert?.returning).toBe(true);
    expect(insert?.values).toEqual({
      approvalBasis: null,
      approvedAt: null,
      approvedBy: null,
      createdAt: NOW,
      evidenceUrl: null,
      exitRule: "owner_standing_rule_v1",
      id: "test-plan",
      limits: SEED.limits,
      name: "Test plan",
      ownerMessageUrl: null,
      sleeves: SEED.sleeves,
      status: "proposed",
      updatedAt: NOW,
      version: 4,
    });
  });

  it("stamps an approved plan with the approval time and who approved", async () => {
    const approved: GoLivePlanSeedInput = {
      ...SEED,
      approvalBasis: "owner_delegation",
      approvedBy: "owner",
      evidenceUrl: "https://example.com/evidence",
      ownerMessageUrl: "https://discord.com/channels/1/2/3",
      status: "approved",
    };
    // No plan row yet: the aggregate double returns no row, so the first version is 1.
    const double = createDouble([[], [], [planRow()], [], [], [planRow()]]);
    const repository = repositoryFor(double.database);
    await repository.writePlan(approved, { actor: "seed-script" });
    expect(double.operations[2]?.values).toEqual(
      expect.objectContaining({
        approvalBasis: "owner_delegation",
        approvedAt: NOW,
        approvedBy: "owner",
        evidenceUrl: "https://example.com/evidence",
        ownerMessageUrl: "https://discord.com/channels/1/2/3",
        status: "approved",
        version: 1,
      })
    );
    // approved_by is never null on an approved plan: without a name the writer is recorded.
    await repository.writePlan(
      { ...approved, approvedBy: null },
      { actor: "seed-script" }
    );
    expect(double.operations[5]?.values).toEqual(
      expect.objectContaining({ approvedAt: NOW, approvedBy: "seed-script" })
    );
  });

  it("drops an approver name from a plan that is only proposed", async () => {
    const double = createDouble([[], [{ version: 1 }], [planRow()]]);
    await repositoryFor(double.database).writePlan(
      { ...SEED, approvedBy: "owner" },
      { actor: "seed-script" }
    );
    expect(double.operations[2]?.values).toEqual(
      expect.objectContaining({ approvedAt: null, approvedBy: null })
    );
  });

  it("lists the drafts of a trading day by sleeve, symbol and id", async () => {
    const row = draftRow({
      quote: {
        asOf: "2026-11-11T15:00:00.000Z",
        longAsk: 1,
        longBid: 0.9,
        shortAsk: 0.5,
        shortBid: 0.4,
        source: "ibkr_live",
      },
    });
    const double = createDouble([[row]]);
    await expect(
      repositoryFor(double.database).listDrafts({ tradingDay: DAY })
    ).resolves.toEqual([row]);
    const [select] = double.operations;
    expect(select?.table).toBe(goLiveDrafts);
    expect(query(select?.where)).toEqual({
      params: [DAY],
      sql: '"golive_drafts"."trading_day" = $1',
    });
    expect(
      ((select as Operation).orderBy as SQL[]).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual([
      '"golive_drafts"."sleeve_key" asc',
      '"golive_drafts"."symbol" asc',
      '"golive_drafts"."id" asc',
    ]);
  });

  it("reads the last generator run of a trading day, or null", async () => {
    const double = createDouble([
      [
        {
          candidateCount: 2,
          generatedAt: GENERATED_AT,
          planId: SEED.id,
          planVersion: 3,
          tradingDay: DAY,
        },
      ],
      [],
    ]);
    const repository = repositoryFor(double.database);
    await expect(repository.lastRun(DAY)).resolves.toEqual({
      candidateCount: 2,
      generatedAt: GENERATED_AT,
      planId: SEED.id,
      planVersion: 3,
    });
    await expect(repository.lastRun(DAY)).resolves.toBeNull();
    const [select] = double.operations;
    expect(select?.table).toBe(goLiveDraftRuns);
    expect(select?.limit).toBe(1);
    expect(query(select?.where).params).toEqual([DAY]);
  });

  it.each([
    {
      inForce: null,
      message:
        "Go-live plan test-plan version 3 was sent and no plan is in force",
      rows: [],
    },
    {
      inForce: { planId: "other-plan", planVersion: 3 },
      message:
        "Go-live plan test-plan version 3 was sent and the plan in force is other-plan version 3",
      rows: [planRow({ id: "other-plan" })],
    },
    {
      inForce: { planId: "test-plan", planVersion: 4 },
      message:
        "Go-live plan test-plan version 3 was sent and the plan in force is test-plan version 4",
      rows: [planRow({ version: 4 })],
    },
  ])(
    "refuses a run for a plan that is not in force ($message)",
    async ({ inForce, message, rows }) => {
      const double = createDouble([rows]);
      const failure = await repositoryFor(double.database)
        .collect({ ...RUN, candidates: [candidate()] })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GoLivePlanMismatchError);
      const mismatch = failure as GoLivePlanMismatchError;
      expect(mismatch.name).toBe("GoLivePlanMismatchError");
      expect(mismatch.message).toBe(message);
      expect(mismatch.sent).toEqual({ planId: "test-plan", planVersion: 3 });
      expect(mismatch.inForce).toEqual(inForce);
      // Only the plan was read: nothing was written.
      expect(double.operations.map((operation) => operation.kind)).toEqual([
        "select",
      ]);
    }
  );

  it("stores new candidates as proposed entries, expires what is no longer wanted and records the run", async () => {
    const spy = candidate({
      quote: {
        asOf: new Date("2026-11-11T15:00:00.000Z"),
        longAsk: 1,
        longBid: 0.9,
        shortAsk: 0.5,
        shortBid: 0.4,
        source: "ibkr_live",
      },
    });
    const qqq = candidate({
      entryBasis: "model_holds_account_does_not",
      symbol: "QQQ",
    });
    const spyId = await goLiveEntryDraftId(RUN, spy);
    const qqqId = await goLiveEntryDraftId(RUN, qqq);
    // The SPY draft is new; the QQQ draft was stored by an earlier run; two old drafts expire.
    const double = createDouble([
      [planRow()],
      [{ id: spyId }],
      [],
      [{ id: "old-1" }, { id: "old-2" }],
      [],
    ]);
    await expect(
      repositoryFor(double.database).collect({
        ...RUN,
        // The same candidate twice is one draft.
        candidates: [spy, qqq, { ...spy, signalFacts: ["sent twice"] }],
      })
    ).resolves.toEqual({ created: 1, expired: 2, unchanged: 1 });
    expect(double.transactions).toHaveLength(1);
    const [, insert, , expire, run] = double.operations;
    expect(insert?.table).toBe(goLiveDrafts);
    expect(insert?.conflict).toBe("nothing");
    expect(insert?.target).toBe(goLiveDrafts.id);
    expect(insert?.returning).toBe(true);
    expect(insert?.values).toEqual([
      {
        createdAt: NOW,
        entryBasis: "signal_today",
        exitRule: "owner_standing_rule_v1",
        expiry: "20270115",
        id: spyId,
        kind: "entry",
        longStrike: 600,
        planId: "test-plan",
        planVersion: 3,
        quote: {
          asOf: "2026-11-11T15:00:00.000Z",
          longAsk: 1,
          longBid: 0.9,
          shortAsk: 0.5,
          shortBid: 0.4,
          source: "ibkr_live",
        },
        shortStrike: 620.5,
        signalFacts: ["VIX 19.5 on 2026-11-11"],
        sleeveKey: "long-index",
        state: "proposed",
        structure: "callDebitVertical",
        symbol: "SPY",
        tradingDay: DAY,
        updatedAt: NOW,
      },
      expect.objectContaining({
        entryBasis: "model_holds_account_does_not",
        id: qqqId,
        quote: null,
        symbol: "QQQ",
      }),
    ]);
    expect(expire?.kind).toBe("update");
    expect(expire?.table).toBe(goLiveDrafts);
    expect(expire?.set).toEqual({ state: "expired", updatedAt: NOW });
    expect(expire?.returning).toBe(true);
    // Only proposed drafts expire, so approved and rejected drafts never change.
    expect(query(expire?.where)).toEqual({
      params: ["proposed", DAY, DAY, "entry", spyId, qqqId],
      sql: '("golive_drafts"."state" = $1 and ("golive_drafts"."trading_day" < $2 or ("golive_drafts"."trading_day" = $3 and "golive_drafts"."kind" = $4 and "golive_drafts"."id" not in ($5, $6))))',
    });
    expect(run?.kind).toBe("insert");
    expect(run?.table).toBe(goLiveDraftRuns);
    const runValues = {
      candidateCount: 3,
      generatedAt: GENERATED_AT,
      planId: "test-plan",
      planVersion: 3,
    };
    expect(run?.values).toEqual({ ...runValues, tradingDay: DAY });
    expect(run?.conflict).toEqual({
      set: runValues,
      target: goLiveDraftRuns.tradingDay,
    });
  });

  describe("a draft that returns in a later run of the same trading day", () => {
    const collectAgain = async () => {
      const spy = candidate();
      const spyId = await goLiveEntryDraftId(RUN, spy);
      // The id is stored already (expired by an earlier run), so the insert creates nothing.
      const double = createDouble([[planRow()], [], [], [], []]);
      const result = await repositoryFor(double.database).collect({
        ...RUN,
        candidates: [spy],
      });
      const revive = double.operations[2] as Operation;
      return { double, result, revive, spyId, where: query(revive.where) };
    };

    it("revives the same-day expired draft to proposed and counts it as unchanged", async () => {
      const { double, result, revive, spyId, where } = await collectAgain();
      expect(result).toEqual({ created: 0, expired: 0, unchanged: 1 });
      expect(
        double.operations.map((operation) => [operation.kind, operation.table])
      ).toEqual([
        ["select", goLivePlans],
        ["insert", goLiveDrafts],
        ["update", goLiveDrafts],
        ["update", goLiveDrafts],
        ["insert", goLiveDraftRuns],
      ]);
      expect(revive.set).toEqual({ state: "proposed", updatedAt: NOW });
      expect(where.params).toEqual([DAY, "expired", spyId]);
      expect(where.sql).toContain('"golive_drafts"."id" in ($3)');
    });

    it("leaves an expired draft of an earlier trading day expired", async () => {
      const { where } = await collectAgain();
      // Only this trading day is matched; no earlier day is.
      expect(where.sql).toContain('"golive_drafts"."trading_day" = $1');
      expect(where.sql).not.toMatch(/trading_day" (<|<=|<>|>)/u);
      expect(where.params[0]).toBe(DAY);
    });

    it("leaves a rejected draft rejected and an approved draft approved", async () => {
      const { where } = await collectAgain();
      // Only state expired without a decision is matched, so a decided draft never changes.
      expect(where.sql).toBe(
        '("golive_drafts"."trading_day" = $1 and "golive_drafts"."state" = $2 and "golive_drafts"."decided_by" is null and "golive_drafts"."id" in ($3))'
      );
      expect(where.params).not.toContain("rejected");
      expect(where.params).not.toContain("approved");
    });
  });

  it("expires every proposed entry of the day when a run wants nothing", async () => {
    const double = createDouble([[planRow()], [{ id: "old-1" }], []]);
    await expect(
      repositoryFor(double.database).collect({ ...RUN, candidates: [] })
    ).resolves.toEqual({ created: 0, expired: 1, unchanged: 0 });
    // No draft insert: plan read, expiry, run row.
    expect(
      double.operations.map((operation) => [operation.kind, operation.table])
    ).toEqual([
      ["select", goLivePlans],
      ["update", goLiveDrafts],
      ["insert", goLiveDraftRuns],
    ]);
    expect(query(double.operations[1]?.where)).toEqual({
      params: ["proposed", DAY, DAY, "entry"],
      sql: '("golive_drafts"."state" = $1 and ("golive_drafts"."trading_day" < $2 or ("golive_drafts"."trading_day" = $3 and "golive_drafts"."kind" = $4)))',
    });
    expect(double.operations[2]?.values).toEqual(
      expect.objectContaining({ candidateCount: 0 })
    );
  });

  it("records a decision only on a draft that is still proposed", async () => {
    const decided = draftRow({
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "ok",
      nodeBadgeAtDecision: "running-disarmed",
      state: "approved",
    });
    const double = createDouble([[decided]]);
    await expect(
      repositoryFor(double.database).decide({
        decidedBy: "owner-1",
        decision: "approved",
        id: "draft-1",
        nodeBadge: "running-disarmed",
        note: "ok",
      })
    ).resolves.toEqual(decided);
    expect(double.operations).toHaveLength(1);
    const [update] = double.operations;
    expect(update?.kind).toBe("update");
    expect(update?.table).toBe(goLiveDrafts);
    expect(update?.returning).toBe(true);
    expect(update?.set).toEqual({
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "ok",
      nodeBadgeAtDecision: "running-disarmed",
      state: "approved",
      updatedAt: NOW,
    });
    expect(query(update?.where)).toEqual({
      params: ["draft-1", "proposed"],
      sql: '("golive_drafts"."id" = $1 and "golive_drafts"."state" = $2)',
    });
  });

  it("reports an unknown draft and a draft that is no longer proposed differently", async () => {
    const input = {
      decidedBy: "owner-1",
      decision: "rejected",
      id: "draft-9",
      nodeBadge: null,
      note: "not now",
    } as const;
    const missing = createDouble([[], []]);
    const notFound = await repositoryFor(missing.database)
      .decide(input)
      .catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(GoLiveDraftNotFoundError);
    expect(notFound).toMatchObject({
      draftId: "draft-9",
      message: "Go-live draft draft-9 does not exist",
      name: "GoLiveDraftNotFoundError",
    });
    const [, lookup] = missing.operations;
    expect(lookup?.table).toBe(goLiveDrafts);
    expect(lookup?.limit).toBe(1);
    expect(query(lookup?.where).params).toEqual(["draft-9"]);

    const decidedBefore = createDouble([[], [{ id: "draft-9" }]]);
    const conflict = await repositoryFor(decidedBefore.database)
      .decide(input)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(GoLiveDraftConflictError);
    expect(conflict).toMatchObject({
      draftId: "draft-9",
      message: "Go-live draft draft-9 is no longer proposed",
      name: "GoLiveDraftConflictError",
    });
  });

  it("uses the current time by default", async () => {
    const double = createDouble([[draftRow({ state: "rejected" })]]);
    await createGoLiveDraftsRepository(double.database).decide({
      decidedBy: "owner-1",
      decision: "rejected",
      id: "draft-1",
      nodeBadge: null,
      note: "no",
    });
    expect(
      ((double.operations[0] as Operation).set as { decidedAt: unknown })
        .decidedAt
    ).toBeInstanceOf(Date);
  });
});
