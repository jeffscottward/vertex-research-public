import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { goLiveDraftRuns, goLiveDrafts, goLivePlans } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createGoLiveDraftsRepository,
  type GoLiveApprovedOrderInput,
  type GoLiveDecideInput,
  type GoLiveDraftCandidateInput,
  GoLiveDraftChangedError,
  GoLiveDraftConflictError,
  GoLiveDraftLimitError,
  GoLiveDraftNotFoundError,
  GoLivePlanMismatchError,
  type GoLivePlanSeedInput,
  goLiveEntryDraftId,
} from "./golive-drafts.ts";

const NOW = new Date("2026-11-11T21:15:00.000Z");
const GENERATED_AT = new Date("2026-11-11T14:35:00.000Z");
// When the owner's request read the draft it approves.
const READ_AT = new Date("2026-11-11T21:14:30.000Z");
const DAY = "2026-11-11";
const dialect = new PgDialect();

interface Operation {
  conflict?: "nothing" | Record<string, unknown>;
  fields?: unknown;
  kind: "select" | "insert" | "update";
  limit?: number;
  lock?: string;
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
      for: (strength: string) => {
        operation.lock = strength;
        return chain;
      },
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

// The order of the SPY draft below: 16 call debit spreads at 1.25.
const ORDER = {
  legs: [
    { expiry: "20270115", ratio: 1, right: "C", side: "BUY", strike: 600 },
    { expiry: "20270115", ratio: 1, right: "C", side: "SELL", strike: 620.5 },
  ],
  limitPrice: 1.25,
  quantity: 16,
  symbol: "SPY",
} as const satisfies GoLiveApprovedOrderInput;

const draftRow = (overrides: Record<string, unknown> = {}) => ({
  approvedOrder: null,
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
  // GOLIVE_DRAFT_LIST_MAX of packages/api: the service passes it.
  maxDrafts: 200,
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
    // An approved row comes back with the order that was stored with the approval.
    const approved = draftRow({
      approvedOrder: ORDER,
      decidedAt: NOW,
      decidedBy: "owner-1",
      id: "draft-2",
      state: "approved",
    });
    const double = createDouble([[row, approved]]);
    const listed = await repositoryFor(double.database).listDrafts({
      tradingDay: DAY,
    });
    expect(listed).toEqual([row, approved]);
    expect(listed.map((draft) => draft.approvedOrder)).toEqual([null, ORDER]);
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

  // The stored fields collect reads of a draft, as the select returns them.
  const storedOf = async (
    wanted: GoLiveDraftCandidateInput,
    overrides: Record<string, unknown> = {}
  ) => ({
    entryBasis: wanted.entryBasis,
    id: await goLiveEntryDraftId(RUN, wanted),
    quote:
      wanted.quote === null
        ? null
        : { ...wanted.quote, asOf: wanted.quote.asOf.toISOString() },
    signalFacts: [...wanted.signalFacts],
    state: "proposed",
    ...overrides,
  });
  const QUOTE = {
    asOf: new Date("2026-11-11T15:00:00.000Z"),
    longAsk: 1,
    longBid: 0.9,
    shortAsk: 0.5,
    shortBid: 0.4,
    source: "yahoo_delayed_snapshot",
  } as const;
  const steps = (operations: readonly Operation[]) =>
    operations.map((operation) => [operation.kind, operation.table]);

  it("stores new candidates as proposed entries, expires what is no longer wanted and records the run", async () => {
    const spy = candidate({ quote: QUOTE });
    const qqq = candidate({
      entryBasis: "model_holds_account_does_not",
      symbol: "QQQ",
    });
    const spyId = await goLiveEntryDraftId(RUN, spy);
    const qqqId = await goLiveEntryDraftId(RUN, qqq);
    // The SPY draft is new. The QQQ draft was stored by an earlier run with the same content,
    // so nothing is written for it. Two old drafts expire.
    const double = createDouble([
      [planRow()],
      [await storedOf(qqq)],
      [{ id: spyId }],
      [{ id: "old-1" }, { id: "old-2" }],
      [],
    ]);
    await expect(
      repositoryFor(double.database).collect({
        ...RUN,
        // The same candidate twice is one draft.
        candidates: [spy, qqq, { ...spy, signalFacts: ["sent twice"] }],
      })
    ).resolves.toEqual({ created: 1, expired: 2, unchanged: 1, updated: 0 });
    expect(double.transactions).toHaveLength(1);
    expect(steps(double.operations)).toEqual([
      ["select", goLivePlans],
      ["select", goLiveDrafts],
      ["insert", goLiveDrafts],
      ["update", goLiveDrafts],
      ["insert", goLiveDraftRuns],
    ]);
    const [, stored, insert, expire, run] = double.operations;
    // The drafts of this trading day and of no other, locked in id order until the end.
    expect(query(stored?.where)).toEqual({
      params: [DAY],
      sql: '"golive_drafts"."trading_day" = $1',
    });
    expect(stored?.lock).toBe("update");
    expect(
      (stored?.orderBy ?? []).map(
        (order) => dialect.sqlToQuery(order as SQL).sql
      )
    ).toEqual(['"golive_drafts"."id" asc']);
    expect(insert?.conflict).toBe("nothing");
    expect(insert?.target).toBe(goLiveDrafts.id);
    expect(insert?.returning).toBe(true);
    // Only the draft that is not stored yet.
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
          source: "yahoo_delayed_snapshot",
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
    ]);
    expect(expire?.set).toEqual({ state: "expired", updatedAt: NOW });
    expect(expire?.returning).toBe(true);
    // Only proposed drafts expire, so approved and rejected drafts never change.
    expect(query(expire?.where)).toEqual({
      params: ["proposed", DAY, DAY, "entry", spyId, qqqId],
      sql: '("golive_drafts"."state" = $1 and ("golive_drafts"."trading_day" < $2 or ("golive_drafts"."trading_day" = $3 and "golive_drafts"."kind" = $4 and "golive_drafts"."id" not in ($5, $6))))',
    });
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

  describe("a draft that is sent again in a later run of the same trading day", () => {
    const LATER_QUOTE = {
      ...QUOTE,
      asOf: new Date("2026-11-11T17:40:00.000Z"),
      longAsk: 1.2,
    };
    // The update of one stored draft: every field a rerun may change, and the guard.
    const expectRefresh = (
      update: Operation | undefined,
      id: string,
      wanted: GoLiveDraftCandidateInput
    ): void => {
      expect(update?.kind).toBe("update");
      expect(update?.table).toBe(goLiveDrafts);
      expect(update?.returning).toBe(true);
      expect(update?.set).toEqual({
        entryBasis: wanted.entryBasis,
        quote:
          wanted.quote === null
            ? null
            : { ...wanted.quote, asOf: wanted.quote.asOf.toISOString() },
        signalFacts: wanted.signalFacts,
        state: "proposed",
        updatedAt: NOW,
      });
      // Only a draft without a decision: an approved or rejected draft is never matched.
      expect(query(update?.where)).toEqual({
        params: [id, "proposed", "expired"],
        sql: '("golive_drafts"."id" = $1 and "golive_drafts"."state" in ($2, $3) and "golive_drafts"."decided_by" is null)',
      });
    };

    it("gives a proposed draft the quote, the facts and the entry basis of the later run", async () => {
      const first = candidate({ quote: QUOTE });
      const later = candidate({
        entryBasis: "model_holds_account_does_not",
        quote: LATER_QUOTE,
        signalFacts: ["VIX 21.0 on 2026-11-11", "model holds since 2026-11-09"],
      });
      const stored = await storedOf(first);
      const double = createDouble([
        [planRow()],
        [stored],
        [{ id: stored.id }],
        [],
        [],
      ]);
      await expect(
        repositoryFor(double.database).collect({ ...RUN, candidates: [later] })
      ).resolves.toEqual({ created: 0, expired: 0, unchanged: 0, updated: 1 });
      // No insert: the id is stored.
      expect(steps(double.operations)).toEqual([
        ["select", goLivePlans],
        ["select", goLiveDrafts],
        ["update", goLiveDrafts],
        ["update", goLiveDrafts],
        ["insert", goLiveDraftRuns],
      ]);
      expectRefresh(double.operations[2], stored.id, later);
    });

    it.each([
      ["a later quote time", { quote: LATER_QUOTE }],
      ["one other price", { quote: { ...QUOTE, shortBid: 0.41 } }],
      ["another quote source", { quote: { ...QUOTE, source: "model" } }],
      ["no quote any more", { quote: null }],
      ["one more fact", { signalFacts: ["VIX 19.5 on 2026-11-11", "new"] }],
      ["another fact", { signalFacts: ["VIX 20.1 on 2026-11-11"] }],
      ["no fact", { signalFacts: [] }],
      ["another entry basis", { entryBasis: "model_holds_account_does_not" }],
    ] as const)("updates the stored draft for %s", async (_name, change) => {
      const first = candidate({ quote: QUOTE });
      const later = candidate({ quote: QUOTE, ...change });
      const stored = await storedOf(first);
      const double = createDouble([
        [planRow()],
        [stored],
        [{ id: stored.id }],
        [],
        [],
      ]);
      await expect(
        repositoryFor(double.database).collect({ ...RUN, candidates: [later] })
      ).resolves.toEqual({ created: 0, expired: 0, unchanged: 0, updated: 1 });
      expectRefresh(double.operations[2], stored.id, later);
    });

    it("gives a stored draft without a quote the quote of the later run", async () => {
      const later = candidate({ quote: QUOTE });
      const stored = await storedOf(candidate());
      const double = createDouble([
        [planRow()],
        [stored],
        [{ id: stored.id }],
        [],
        [],
      ]);
      await expect(
        repositoryFor(double.database).collect({ ...RUN, candidates: [later] })
      ).resolves.toMatchObject({ unchanged: 0, updated: 1 });
      expectRefresh(double.operations[2], stored.id, later);
    });

    it("writes nothing for a proposed draft that is sent again unchanged", async () => {
      for (const same of [candidate({ quote: QUOTE }), candidate()]) {
        const double = createDouble([
          [planRow()],
          [await storedOf(same)],
          [],
          [],
        ]);
        await expect(
          repositoryFor(double.database).collect({ ...RUN, candidates: [same] })
        ).resolves.toEqual({
          created: 0,
          expired: 0,
          unchanged: 1,
          updated: 0,
        });
        // Plan, stored drafts, the expiry of others, the run row: no insert, no draft update.
        expect(steps(double.operations)).toEqual([
          ["select", goLivePlans],
          ["select", goLiveDrafts],
          ["update", goLiveDrafts],
          ["insert", goLiveDraftRuns],
        ]);
        expect(double.operations[2]?.set).toEqual({
          state: "expired",
          updatedAt: NOW,
        });
      }
    });

    it.each(["approved", "rejected"])(
      "never changes a draft that is %s, whatever the later run sends",
      async (state) => {
        const later = candidate({
          entryBasis: "model_holds_account_does_not",
          quote: LATER_QUOTE,
          signalFacts: ["changed"],
        });
        const stored = await storedOf(candidate({ quote: QUOTE }), { state });
        const double = createDouble([[planRow()], [stored], [], []]);
        await expect(
          repositoryFor(double.database).collect({
            ...RUN,
            candidates: [later],
          })
        ).resolves.toEqual({
          created: 0,
          expired: 0,
          unchanged: 1,
          updated: 0,
        });
        // The one update is the expiry, which matches proposed drafts only.
        expect(steps(double.operations)).toEqual([
          ["select", goLivePlans],
          ["select", goLiveDrafts],
          ["update", goLiveDrafts],
          ["insert", goLiveDraftRuns],
        ]);
        expect(double.operations[2]?.set).toEqual({
          state: "expired",
          updatedAt: NOW,
        });
      }
    );

    it("brings a same-day expired draft back to proposed with the later content, counted as updated", async () => {
      // Expired by an earlier run of today and wanted again, also when nothing else changed.
      for (const later of [
        candidate({ quote: QUOTE }),
        candidate({ quote: LATER_QUOTE }),
      ]) {
        const stored = await storedOf(candidate({ quote: QUOTE }), {
          state: "expired",
        });
        const double = createDouble([
          [planRow()],
          [stored],
          [{ id: stored.id }],
          [],
          [],
        ]);
        await expect(
          repositoryFor(double.database).collect({
            ...RUN,
            candidates: [later],
          })
        ).resolves.toEqual({
          created: 0,
          expired: 0,
          unchanged: 0,
          updated: 1,
        });
        expectRefresh(double.operations[2], stored.id, later);
      }
    });

    it("counts a draft as unchanged when the guarded update or insert matched no row", async () => {
      // Another transaction decided the draft, or stored the new id, first.
      const stored = await storedOf(candidate({ quote: QUOTE }));
      const double = createDouble([[planRow()], [stored], [], [], [], []]);
      await expect(
        repositoryFor(double.database).collect({
          ...RUN,
          candidates: [
            candidate({ quote: LATER_QUOTE }),
            candidate({ symbol: "QQQ" }),
          ],
        })
      ).resolves.toEqual({ created: 0, expired: 0, unchanged: 2, updated: 0 });
      expect(steps(double.operations)).toEqual([
        ["select", goLivePlans],
        ["select", goLiveDrafts],
        ["insert", goLiveDrafts],
        ["update", goLiveDrafts],
        ["update", goLiveDrafts],
        ["insert", goLiveDraftRuns],
      ]);
    });
  });

  describe("the most drafts one trading day may hold", () => {
    const other = (index: number) => ({
      entryBasis: "signal_today",
      id: `other-${index}`,
      quote: null,
      signalFacts: [],
      state: index % 2 === 0 ? "expired" : "rejected",
    });

    it("refuses a run that would take the day above the limit, before anything is written", async () => {
      const stored = await storedOf(candidate());
      const double = createDouble([[planRow()], [other(0), other(1), stored]]);
      const failure = await repositoryFor(double.database)
        .collect({
          ...RUN,
          candidates: [
            candidate(),
            candidate({ symbol: "QQQ" }),
            candidate({ symbol: "IWM" }),
          ],
          maxDrafts: 4,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GoLiveDraftLimitError);
      expect(failure).toMatchObject({
        limit: 4,
        message: `Trading day ${DAY} holds 3 go-live drafts and the run adds 2: more than the limit of 4`,
        name: "GoLiveDraftLimitError",
        tradingDay: DAY,
      });
      // Two reads and no write: nothing is stored, refreshed or expired, and no run is recorded.
      expect(steps(double.operations)).toEqual([
        ["select", goLivePlans],
        ["select", goLiveDrafts],
      ]);
    });

    it("accepts a run that fills the day exactly, and a rerun of a full day", async () => {
      const stored = await storedOf(candidate());
      const fresh = candidate({ symbol: "QQQ" });
      const freshId = await goLiveEntryDraftId(RUN, fresh);
      const filling = createDouble([
        [planRow()],
        [other(0), other(1), stored],
        [{ id: freshId }],
        [],
        [],
      ]);
      await expect(
        repositoryFor(filling.database).collect({
          ...RUN,
          candidates: [candidate(), fresh],
          maxDrafts: 4,
        })
      ).resolves.toEqual({ created: 1, expired: 0, unchanged: 1, updated: 0 });
      // Every id is stored: the run adds nothing, so a full day is not above the limit.
      const full = createDouble([[planRow()], [other(0), stored], [], []]);
      await expect(
        repositoryFor(full.database).collect({
          ...RUN,
          candidates: [candidate()],
          maxDrafts: 2,
        })
      ).resolves.toEqual({ created: 0, expired: 0, unchanged: 1, updated: 0 });
    });
  });

  it("expires every proposed entry of the day when a run wants nothing", async () => {
    const double = createDouble([[planRow()], [{ id: "old-1" }], []]);
    await expect(
      repositoryFor(double.database).collect({ ...RUN, candidates: [] })
    ).resolves.toEqual({ created: 0, expired: 1, unchanged: 0, updated: 0 });
    // No draft read and no draft insert: plan read, expiry, run row.
    expect(steps(double.operations)).toEqual([
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

  it("stores the approved order in the statement that approves a proposed draft", async () => {
    const decided = draftRow({
      approvedOrder: ORDER,
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "ok",
      nodeBadgeAtDecision: "running-disarmed",
      state: "approved",
    });
    const double = createDouble([[decided]]);
    // A field that is not part of an order is not stored.
    const sent = { ...ORDER, clientNote: "not an order field" };
    const approved = await repositoryFor(double.database).decide({
      approvedOrder: sent,
      decidedBy: "owner-1",
      decision: "approved",
      expectedUpdatedAt: READ_AT,
      id: "draft-1",
      nodeBadge: "running-disarmed",
      note: "ok",
    });
    expect(approved).toEqual(decided);
    expect(approved.approvedOrder).toEqual(ORDER);
    // One statement and no other: the order is never written apart from the state change.
    expect(double.operations).toHaveLength(1);
    expect(double.transactions).toHaveLength(0);
    const [update] = double.operations;
    expect(update?.kind).toBe("update");
    expect(update?.table).toBe(goLiveDrafts);
    expect(update?.returning).toBe(true);
    expect(update?.set).toEqual({
      approvedOrder: ORDER,
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "ok",
      nodeBadgeAtDecision: "running-disarmed",
      state: "approved",
      updatedAt: NOW,
    });
    // A copy: changing the caller's object later cannot change what was stored. The double
    // records set() as unknown; the toEqual above proved this shape.
    const written = update?.set as { approvedOrder: GoLiveApprovedOrderInput };
    expect(written.approvedOrder).not.toBe(sent);
    expect(written.approvedOrder.legs).not.toBe(sent.legs);
    expect(written.approvedOrder.legs[0]).not.toBe(sent.legs[0]);
    // Decided once: only a draft that is still proposed is matched, and only as it was read:
    // a later collect that changed its quote, facts or entry basis moved updated_at.
    expect(query(update?.where)).toEqual({
      params: ["draft-1", "proposed", READ_AT.toISOString()],
      sql: '("golive_drafts"."id" = $1 and "golive_drafts"."state" = $2 and "golive_drafts"."updated_at" = $3)',
    });
  });

  it("stores no order with a rejection", async () => {
    const decided = draftRow({
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "not now",
      state: "rejected",
    });
    const double = createDouble([[decided]]);
    const rejected = await repositoryFor(double.database).decide({
      decidedBy: "owner-1",
      decision: "rejected",
      id: "draft-1",
      nodeBadge: null,
      note: "not now",
    });
    expect(rejected).toEqual(decided);
    expect(rejected.approvedOrder).toBeNull();
    expect(double.operations).toHaveLength(1);
    expect(double.operations[0]?.set).toEqual({
      approvedOrder: null,
      decidedAt: NOW,
      decidedBy: "owner-1",
      decisionNote: "not now",
      nodeBadgeAtDecision: null,
      state: "rejected",
      updatedAt: NOW,
    });
    expect(query(double.operations[0]?.where)).toEqual({
      params: ["draft-1", "proposed"],
      sql: '("golive_drafts"."id" = $1 and "golive_drafts"."state" = $2)',
    });
  });

  it("has no input type for an approval without an order or a rejection with one", async () => {
    const base = {
      decidedBy: "owner-1",
      id: "draft-1",
      nodeBadge: null,
      note: null,
    };
    // @ts-expect-error an approval needs approvedOrder
    const withoutOrder: GoLiveDecideInput = {
      ...base,
      decision: "approved",
      expectedUpdatedAt: READ_AT,
    };
    // @ts-expect-error an approval needs the time the draft was read at
    const withoutReadTime: GoLiveDecideInput = {
      ...base,
      approvedOrder: ORDER,
      decision: "approved",
    };
    // @ts-expect-error a rejection takes no approvedOrder
    const withOrder: GoLiveDecideInput = {
      ...base,
      approvedOrder: ORDER,
      decision: "rejected",
    };
    // A caller that gets past the types (plain JavaScript) writes nothing for an approval
    // without an order; the table check golive_drafts_approved_order_check is the last guard.
    const double = createDouble([[draftRow()]]);
    await expect(
      repositoryFor(double.database).decide(withoutOrder)
    ).rejects.toThrow();
    expect(double.operations).toHaveLength(0);
    // The same without the time the draft was read at: no statement is sent.
    await expect(
      repositoryFor(double.database).decide(withoutReadTime)
    ).rejects.toThrow();
    expect(double.operations).toHaveLength(0);
    // A rejection that carries an order by mistake still stores none.
    await repositoryFor(double.database).decide(withOrder);
    expect(double.operations[0]?.set).toEqual(
      expect.objectContaining({ approvedOrder: null, state: "rejected" })
    );
  });

  it("refuses an approval of a draft that changed after it was read", async () => {
    // A collect refreshed the draft between the owner's read and the approval: the update
    // matches no row, and the draft is still proposed.
    const double = createDouble([[], [{ id: "draft-1", state: "proposed" }]]);
    const changed = await repositoryFor(double.database)
      .decide({
        approvedOrder: ORDER,
        decidedBy: "owner-1",
        decision: "approved",
        expectedUpdatedAt: READ_AT,
        id: "draft-1",
        nodeBadge: null,
        note: null,
      })
      .catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(GoLiveDraftChangedError);
    expect(changed).toMatchObject({
      draftId: "draft-1",
      message: "Go-live draft draft-1 changed after it was read",
      name: "GoLiveDraftChangedError",
    });
    expect(double.operations.map((operation) => operation.kind)).toEqual([
      "update",
      "select",
    ]);
    // A rejection does not depend on what the draft holds: it has no such condition.
    const rejecting = createDouble([[draftRow({ state: "rejected" })]]);
    await repositoryFor(rejecting.database).decide({
      decidedBy: "owner-1",
      decision: "rejected",
      id: "draft-1",
      nodeBadge: null,
      note: "no",
    });
    expect(query(rejecting.operations[0]?.where).sql).toBe(
      '("golive_drafts"."id" = $1 and "golive_drafts"."state" = $2)'
    );
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

    for (const state of ["approved", "rejected", "expired"]) {
      const decidedBefore = createDouble([[], [{ id: "draft-9", state }]]);
      const conflict = await repositoryFor(decidedBefore.database)
        .decide(input)
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(GoLiveDraftConflictError);
      expect(conflict).toMatchObject({
        draftId: "draft-9",
        message: "Go-live draft draft-9 is no longer proposed",
        name: "GoLiveDraftConflictError",
      });
      // The same for an approval, whatever time it was read at.
      const approving = createDouble([[], [{ id: "draft-9", state }]]);
      await expect(
        repositoryFor(approving.database).decide({
          approvedOrder: ORDER,
          decidedBy: "owner-1",
          decision: "approved",
          expectedUpdatedAt: READ_AT,
          id: "draft-9",
          nodeBadge: null,
          note: null,
        })
      ).rejects.toBeInstanceOf(GoLiveDraftConflictError);
    }
    const decidedBefore = createDouble([
      [],
      [{ id: "draft-9", state: "approved" }],
    ]);
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
