import { readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  GoLiveDraftChangedError,
  GoLiveDraftConflictError,
  GoLiveDraftLimitError,
  GoLiveDraftNotFoundError,
  type GoLiveDraftRecord,
  GoLivePlanMismatchError,
  type GoLivePlanRecord,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type {
  GoLiveCollectInput,
  GoLiveDraftApproveInput,
} from "./contracts/golive-drafts.ts";
import type { JevVerdictOutput } from "./contracts/jev-verdict.ts";
import { createApiContext } from "./server/context.ts";
import {
  type GoLiveAccountReading,
  type GoLiveDraftsDependencies,
  type GoLiveDraftsRepositoryPort,
  goLiveDraftsRouter,
  setGoLiveDraftsDependenciesForTesting,
} from "./server/golive-drafts.ts";
import { handleApiRequest } from "./server/handler.ts";
import { setJevVerdictForTesting } from "./server/jev-verdict.ts";
import { setNautilusArmDependenciesForTesting } from "./server/nautilus-arm.ts";

// Friday 2026-11-13, 16:30 in New York: the session is closed, so an order would be placed in
// Monday's session. The session day differs from the New York date and from the UTC date.
const NOW = new Date("2026-11-13T21:30:00.000Z");
const TODAY = "2026-11-16";
const PLAINTEXT = "dfk_golive_test_key";
const EXPIRY = "20261218";
const LIVE_AS_OF = new Date(NOW.getTime() - 30_000).toISOString();
const NLV = 100_000;
// The updated time the in-memory store gives a draft that a later collect refreshed.
const REFRESHED_AT = new Date(NOW.getTime() + 1000);

const authError = (status: 401 | 403) =>
  new AuthAuthorizationError(
    status === 401
      ? AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED
      : AUTHORIZATION_ERROR_CODES.FORBIDDEN,
    status
  );

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "admin", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-14T21:30:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "admin",
    status: "active",
    updatedAt: NOW,
  },
});

const sleeve = (
  key: string,
  symbols: string[],
  structure: GoLivePlanRecord["sleeves"][number]["structure"],
  budgetPct: number
): GoLivePlanRecord["sleeves"][number] => ({
  anchorDelta: 0.3,
  budgetPct,
  definitionNote: "",
  definitionVariant: "as_studied",
  dteMin: 20,
  dteTarget: 35,
  key,
  name: key,
  runKey: `run-${key}`,
  structure,
  symbols,
  widthSigma: 1,
});

const plan = (overrides: Partial<GoLivePlanRecord> = {}): GoLivePlanRecord => ({
  approvalBasis: "owner_delegation",
  approvedAt: NOW,
  approvedBy: "owner",
  createdAt: NOW,
  evidenceUrl: "https://evidence.domain.test/report",
  exitRule: "owner_standing_rule_v1",
  id: "pie",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 6,
    positionRiskPct: 2,
  },
  name: "Lower-bar pie",
  ownerMessageUrl: "https://discord.com/channels/1/2/3",
  retiredAt: null,
  sleeves: [
    sleeve("trend", ["SPY", "QQQ"], "callDebitVertical", 4),
    sleeve("income", ["IWM"], "putCreditVertical", 2),
  ],
  status: "approved",
  updatedAt: NOW,
  version: 1,
  ...overrides,
});

// Long mid 2.35, short mid 1.10: debit 1.25, 125 per spread, 16 spreads in a 2,000 budget.
const liveQuote = (
  overrides: Partial<NonNullable<GoLiveDraftRecord["quote"]>> = {}
): NonNullable<GoLiveDraftRecord["quote"]> => ({
  asOf: LIVE_AS_OF,
  longAsk: 2.4,
  longBid: 2.3,
  shortAsk: 1.15,
  shortBid: 1.05,
  source: "ibkr_live",
  ...overrides,
});

const record = (
  id: string,
  overrides: Partial<GoLiveDraftRecord> = {}
): GoLiveDraftRecord => ({
  approvedOrder: null,
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  expiry: EXPIRY,
  id,
  kind: "entry",
  longStrike: 100,
  nodeBadgeAtDecision: null,
  parentDraftId: null,
  planId: "pie",
  planVersion: 1,
  quote: liveQuote(),
  revision: 1,
  shortStrike: 105,
  signalFacts: ["VIX 19.5 on 2026-11-11"],
  sleeveKey: "trend",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  tradingDay: TODAY,
  updatedAt: NOW,
  ...overrides,
});

const ORDER = {
  legs: [
    { expiry: EXPIRY, ratio: 1, right: "C", side: "BUY", strike: 100 },
    { expiry: EXPIRY, ratio: 1, right: "C", side: "SELL", strike: 105 },
  ],
  limitPrice: 1.25,
  quantity: 16,
  symbol: "SPY",
} satisfies GoLiveDraftApproveInput["order"];

type Seed = Readonly<{
  drafts?: readonly GoLiveDraftRecord[];
  generatedAt?: Date;
  plan?: GoLivePlanRecord | null;
}>;

/** In-memory store with the decide-once and insert-once rules of the Postgres one. */
const createMemoryRepository = (seed: Seed = {}) => {
  const drafts = new Map((seed.drafts ?? []).map((draft) => [draft.id, draft]));
  const runs = new Map<string, Date>();
  if (seed.generatedAt !== undefined) runs.set(TODAY, seed.generatedAt);
  const inForce = seed.plan === undefined ? plan() : seed.plan;
  const repository = {
    collect: vi.fn(
      async (run: Parameters<GoLiveDraftsRepositoryPort["collect"]>[0]) => {
        // The first of two equal candidates is kept.
        const wanted = new Map<string, (typeof run.candidates)[number]>();
        for (const candidate of run.candidates) {
          const id = `${run.tradingDay}|${candidate.sleeveKey}|${candidate.symbol}`;
          if (!wanted.has(id)) wanted.set(id, candidate);
        }
        const ofDay = [...drafts.values()].filter(
          (draft) => draft.tradingDay === run.tradingDay
        ).length;
        const added = [...wanted.keys()].filter((id) => !drafts.has(id)).length;
        if (ofDay + added > run.maxDrafts)
          throw new GoLiveDraftLimitError(
            run.tradingDay,
            run.maxDrafts,
            ofDay,
            added
          );
        let created = 0;
        let updated = 0;
        for (const [id, candidate] of wanted) {
          const content = {
            entryBasis: candidate.entryBasis,
            quote:
              candidate.quote === null
                ? null
                : {
                    ...candidate.quote,
                    asOf: candidate.quote.asOf.toISOString(),
                  },
            signalFacts: [...candidate.signalFacts],
          };
          const stored = drafts.get(id);
          if (stored === undefined) {
            created += 1;
            drafts.set(
              id,
              record(id, {
                ...candidate,
                ...content,
                tradingDay: run.tradingDay,
              })
            );
            continue;
          }
          // A decided draft never changes; a proposed one only when its content differs.
          const same =
            JSON.stringify(content) ===
            JSON.stringify({
              entryBasis: stored.entryBasis,
              quote: stored.quote,
              signalFacts: stored.signalFacts,
            });
          if (
            !(stored.state === "expired" || stored.state === "proposed") ||
            (stored.state === "proposed" && same)
          )
            continue;
          updated += 1;
          drafts.set(id, {
            ...stored,
            ...content,
            // As the Postgres store: every write to a draft adds 1 to its revision.
            revision: stored.revision + 1,
            state: "proposed",
            updatedAt: REFRESHED_AT,
          });
        }
        runs.set(run.tradingDay, run.generatedAt);
        return {
          created,
          expired: 0,
          unchanged: wanted.size - created - updated,
          updated,
        };
      }
    ),
    decide: vi.fn(
      async (input: Parameters<GoLiveDraftsRepositoryPort["decide"]>[0]) => {
        const draft = drafts.get(input.id);
        if (draft === undefined) throw new GoLiveDraftNotFoundError(input.id);
        if (draft.state !== "proposed")
          throw new GoLiveDraftConflictError(input.id);
        // As the Postgres store: an approval matches the draft only at the revision read.
        if (
          input.decision === "approved" &&
          input.expectedRevision !== draft.revision
        )
          throw new GoLiveDraftChangedError(input.id);
        const decided: GoLiveDraftRecord = {
          ...draft,
          // As the Postgres store: an approval stores a copy of its order, a rejection none.
          approvedOrder:
            input.decision === "approved"
              ? {
                  ...input.approvedOrder,
                  legs: input.approvedOrder.legs.map((leg) => ({ ...leg })),
                }
              : null,
          decidedAt: NOW,
          decidedBy: input.decidedBy,
          decisionNote: input.note,
          nodeBadgeAtDecision: input.nodeBadge,
          revision: draft.revision + 1,
          state: input.decision,
        };
        drafts.set(decided.id, decided);
        return decided;
      }
    ),
    lastRun: vi.fn(async (tradingDay: string) => {
      const generatedAt = runs.get(tradingDay);
      return generatedAt === undefined
        ? null
        : { candidateCount: 0, generatedAt, planId: "pie", planVersion: 1 };
    }),
    listDrafts: vi.fn(async (filter: Readonly<{ tradingDay: string }>) =>
      [...drafts.values()].filter(
        (draft) => draft.tradingDay === filter.tradingDay
      )
    ),
    planInForce: vi.fn(async () => inForce),
  } satisfies GoLiveDraftsRepositoryPort;
  return { drafts, repository };
};

type ClientOptions = Readonly<{
  // false: the session passes the operator check and fails the admin role check.
  admin?: boolean;
  agentViewerEmails?: readonly string[];
  apiKey?: string;
  ibkrRecovery?: Readonly<{ token: string; url: string }>;
  keyAccess?: "read" | "write";
  portfolioMonitor?: Readonly<{ token: string; url: string }>;
  repository?: GoLiveDraftsRepositoryPort;
  // null: no session.
  sessionUser?: string | null;
}>;

const contextFor = (request: Request, options: ClientOptions) => {
  const user =
    options.sessionUser === undefined ? "owner" : options.sessionUser;
  const repositories = {
    addresses: {},
    adminUsers: {},
    dashboard: {},
    featureItems: {},
    profiles: {},
    userPreferences: {},
    ...(options.repository === undefined
      ? {}
      : { goLiveDrafts: options.repository }),
  } as Repositories;
  const requireSession = async () => {
    if (user === null) throw authError(401);
    return session(user);
  };
  return createApiContext(request, {
    agentApiKeys: {
      authenticate: vi.fn(async (headers: Headers) => {
        if (headers.get("x-api-key") !== PLAINTEXT) throw authError(401);
        return {
          access: options.keyAccess ?? "write",
          apiKeyId: "key-1",
          email: "owner@domain.test",
          emailVerified: true,
          role: "admin" as const,
          status: "active" as const,
          userId: "owner",
        };
      }),
    } as never,
    agentViewerEmails: options.agentViewerEmails ?? [],
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    ibkrRecovery: options.ibkrRecovery ?? null,
    operatorEmails: ["owner@domain.test", "operator@domain.test"],
    portfolioMonitor: options.portfolioMonitor ?? null,
    repositories,
    requestId: "request-1",
    requireRole: async () => {
      if (options.admin === false) throw authError(403);
      return await requireSession();
    },
    requireSession,
  });
};

const clientFor = (options: ClientOptions = {}) =>
  createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKey !== undefined)
        request.headers.set("x-api-key", options.apiKey);
      return await handleApiRequest(request, contextFor(request, options));
    },
  });

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
  message?: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
    if (message !== undefined)
      expect((error as ORPCError<string, unknown>).message).toContain(message);
  }
};

const verdict = (
  stance: "BULLISH" | "NEUTRAL" | "BEARISH"
): JevVerdictOutput => ({
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: [],
  refreshed: false,
  staleAfterSeconds: 3600,
  state: "fresh",
  symbol: "SPY",
  throttled: false,
  verdict: {
    choice: stance,
    dataAsOf: "2026-11-11",
    decidedAt: "2026-11-13T21:00:00Z",
    factors: [],
    model: "m",
    probabilities: { BEARISH: 0.1, BULLISH: 0.8, NEUTRAL: 0.1 },
    reason: "r",
    sentFields: [],
    stance,
  },
});

const ACCOUNT: GoLiveAccountReading = {
  asOf: NOW,
  netLiquidation: NLV,
  unavailableReason: null,
};

const defaults = () =>
  ({
    account: async () => ACCOUNT,
    jevVerdict: () => verdict("BULLISH"),
    node: async () => ({ armedAt: null, badge: "running-disarmed" }),
    now: () => NOW,
  }) satisfies GoLiveDraftsDependencies;

const inject = (overrides: GoLiveDraftsDependencies = {}): void =>
  setGoLiveDraftsDependenciesForTesting({ ...defaults(), ...overrides });

/** The test dependencies without one of them, so the service uses its own reader. */
const injectWithout = (
  key: "account" | "jevVerdict" | "node",
  overrides: GoLiveDraftsDependencies = {}
): void => {
  const { [key]: _own, ...rest } = defaults();
  setGoLiveDraftsDependenciesForTesting({ ...rest, ...overrides });
};

beforeEach(() => inject());
afterEach(() => {
  setGoLiveDraftsDependenciesForTesting({});
  setNautilusArmDependenciesForTesting({});
  setJevVerdictForTesting();
});

const SIZED = {
  budget: 2000,
  limitPrice: 1.25,
  maxLoss: 2000,
  maxLossPctNlv: 2,
  maxLossPerSpread: 125,
  quantity: 16,
  reason: "sized",
};

describe("goLiveDrafts.queue", () => {
  it("answers with no plan and no drafts before the first run", async () => {
    const memory = createMemoryRepository({ plan: null });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue).toEqual({
      account: ACCOUNT,
      canDecide: true,
      drafts: [],
      generatedAt: null,
      marketNotes: "feature_not_deployed",
      node: { armedAt: null, badge: "running-disarmed", checkedAt: NOW },
      plan: null,
      sendsOrders: false,
      // The session in which an order would be placed, not today's date.
      tradingDay: TODAY,
    });
    expect(memory.repository.listDrafts).toHaveBeenCalledWith({
      tradingDay: TODAY,
    });
    expect(memory.repository.lastRun).toHaveBeenCalledWith(TODAY);
  });

  it("sizes each draft, builds the exact order and runs the dry pre-check", async () => {
    const generatedAt = new Date("2026-11-13T21:00:00.000Z");
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy"),
        record("d-qqq", {
          entryBasis: "model_holds_account_does_not",
          quote: liveQuote({ source: "yahoo_delayed_snapshot" }),
          symbol: "QQQ",
        }),
        record("d-iwm", {
          longStrike: 95,
          quote: null,
          shortStrike: 100,
          sleeveKey: "income",
          structure: "putCreditVertical",
          symbol: "IWM",
        }),
        record("d-other-day", { tradingDay: "2026-11-10" }),
      ],
      generatedAt,
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.plan).toEqual(plan());
    expect(queue.generatedAt).toEqual(generatedAt);
    expect(queue.drafts.map((draft) => draft.id)).toEqual([
      "d-spy",
      "d-qqq",
      "d-iwm",
    ]);
    const [spy, qqq, iwm] = queue.drafts;
    expect(spy).toEqual({
      ...record("d-spy"),
      approvedRoom: null,
      notApprovable: [],
      notes: [],
      order: ORDER,
      preCheck: {
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate: {
          decision: "allow",
          jevStance: "BULLISH",
          jevState: "fresh",
          maxLoss: 2000,
          maxLossPct: 2,
          reasons: [],
          structure: "debit-vertical",
        },
      },
      // The stored ISO text is returned as a date.
      quote: { ...liveQuote(), asOf: new Date(LIVE_AS_OF) },
      sizing: SIZED,
    });
    // A late entry on a delayed quote is listed with its size and cannot be approved.
    expect(qqq).toMatchObject({
      notApprovable: ["LATE_ENTRY_NOT_TESTED", "NO_LIVE_IBKR_QUOTE"],
      order: { ...ORDER, symbol: "QQQ" },
      sizing: SIZED,
    });
    expect(iwm).toMatchObject({
      notApprovable: ["NO_LIVE_IBKR_QUOTE", "SIZED_TO_ZERO"],
      order: null,
      preCheck: { webFinalGate: null },
      quote: null,
      sizing: { budget: 2000, quantity: 0, reason: "no_quote" },
    });
  });

  it("treats a stored quote time that does not parse as no quote", async () => {
    const memory = createMemoryRepository({
      drafts: [record("d-spy", { quote: liveQuote({ asOf: "yesterday" }) })],
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.drafts[0]).toMatchObject({
      notApprovable: ["NO_LIVE_IBKR_QUOTE", "SIZED_TO_ZERO"],
      order: null,
      quote: null,
      sizing: { limitPrice: null, quantity: 0, reason: "no_quote" },
    });
  });

  it("reads the trading day it is asked for", async () => {
    const memory = createMemoryRepository({
      drafts: [record("d-old", { tradingDay: "2026-11-10" })],
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({ tradingDay: "2026-11-10" });
    expect(queue.tradingDay).toBe("2026-11-10");
    expect(queue.drafts.map((draft) => draft.id)).toEqual(["d-old"]);
    expect(memory.repository.lastRun).toHaveBeenCalledWith("2026-11-10");
  });

  it("shows no money value, and never 0, when the account value is unavailable", async () => {
    inject({
      account: async () => ({
        asOf: null,
        netLiquidation: null,
        unavailableReason: "Portfolio monitor did not answer",
      }),
    });
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy"),
        record("d-qqq", { quote: null, symbol: "QQQ" }),
      ],
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.account).toEqual({
      asOf: null,
      netLiquidation: null,
      unavailableReason: "Portfolio monitor did not answer",
    });
    for (const draft of queue.drafts) {
      expect(draft.sizing).toEqual({
        budget: null,
        limitPrice: null,
        maxLoss: null,
        maxLossPctNlv: null,
        maxLossPerSpread: null,
        quantity: 0,
        reason: "nlv_unavailable",
      });
      expect(draft.order).toBeNull();
      expect(draft.preCheck.webFinalGate).toBeNull();
      expect(draft.notApprovable).toContain("NLV_UNAVAILABLE");
      expect(draft.notApprovable).toContain("SIZED_TO_ZERO");
    }
    // No money field anywhere in the answer is 0.
    expect(JSON.stringify(queue)).not.toMatch(
      /"(budget|limitPrice|maxLoss|maxLossPctNlv|maxLossPerSpread|netLiquidation)":0/u
    );
  });

  it("denies the pre-check when no fresh JEV verdict is cached", async () => {
    // No injected verdict: the shared verdict store is empty.
    setJevVerdictForTesting({ now: () => NOW });
    injectWithout("jevVerdict");
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.drafts[0]).toMatchObject({
      notApprovable: ["PRECHECK_DENIED"],
      preCheck: { webFinalGate: { decision: "deny", jevState: "none" } },
    });
  });

  it("attaches market notes only when a reader is wired", async () => {
    const memory = createMemoryRepository({
      drafts: [record("d-spy"), record("d-qqq", { symbol: "QQQ" })],
    });
    const note = { id: "n1", stance: "bullish", theme: "AI", verified: false };
    const marketNotes = vi.fn(async () => new Map([["QQQ", [note]]]));
    inject({ marketNotes });
    const client = clientFor({ repository: memory.repository });
    const attached = await client.goLiveDrafts.queue({});
    expect(attached.marketNotes).toBe("attached");
    expect(attached.drafts.map((draft) => draft.notes)).toEqual([[], [note]]);
    expect(marketNotes).toHaveBeenCalledWith(["SPY", "QQQ"]);
    inject({ marketNotes: async () => new Map() });
    expect((await client.goLiveDrafts.queue({})).marketNotes).toBe(
      "none_active"
    );
  });

  it("does not show the account value to an agent API key", async () => {
    const account = vi.fn(async () => ACCOUNT);
    inject({ account });
    const memory = createMemoryRepository({
      drafts: [record("d-spy"), record("d-qqq", { symbol: "QQQ" })],
    });
    const repository = memory.repository;
    for (const keyAccess of ["read", "write"] as const) {
      const queue = await clientFor({
        apiKey: PLAINTEXT,
        keyAccess,
        repository,
      }).goLiveDrafts.queue({});
      expect(queue.account).toEqual({
        asOf: null,
        netLiquidation: null,
        unavailableReason: "account value is not shown to API keys",
      });
      expect(queue.drafts).toHaveLength(2);
      for (const draft of queue.drafts) {
        expect(draft.sizing).toEqual({
          budget: null,
          limitPrice: null,
          maxLoss: null,
          maxLossPctNlv: null,
          maxLossPerSpread: null,
          quantity: 0,
          reason: "nlv_unavailable",
        });
        expect(draft.order).toBeNull();
        expect(draft.preCheck.webFinalGate).toBeNull();
      }
      // No money field in the answer holds a value.
      expect(JSON.stringify(queue)).not.toMatch(
        /"(budget|limitPrice|maxLoss|maxLossPctNlv|maxLossPerSpread|netLiquidation)":(?!null)/u
      );
    }
    expect(account).not.toHaveBeenCalled();
    // The service's own reader is not called either: nothing reaches the portfolio monitor.
    const fetch = vi.fn(async () => portfolioFeed());
    injectWithout("account", { portfolioFetch: { fetch } });
    await clientFor({
      apiKey: PLAINTEXT,
      portfolioMonitor: PORTFOLIO,
      repository,
    }).goLiveDrafts.queue({});
    expect(fetch).not.toHaveBeenCalled();
    // Sessions are unchanged: the operator and the agent viewer see the value and the sizes.
    inject({ account });
    for (const options of [
      { repository },
      {
        agentViewerEmails: ["viewer@domain.test"],
        repository,
        sessionUser: "viewer",
      },
    ]) {
      const queue = await clientFor(options).goLiveDrafts.queue({});
      expect(queue.account).toEqual(ACCOUNT);
      expect(queue.drafts.map((draft) => draft.sizing)).toEqual([SIZED, SIZED]);
      expect(queue.drafts[0]?.order).toEqual(ORDER);
    }
    expect(account).toHaveBeenCalledTimes(2);
  });

  it("admits an operator, an agent viewer and a read key, and nobody else", async () => {
    const memory = createMemoryRepository();
    const repository = memory.repository;
    for (const options of [
      { repository },
      { apiKey: PLAINTEXT, keyAccess: "read" as const, repository },
      {
        agentViewerEmails: ["viewer@domain.test"],
        repository,
        sessionUser: "viewer",
      },
    ])
      expect(
        (await clientFor(options).goLiveDrafts.queue({})).sendsOrders
      ).toBe(false);
    await expectCode(
      clientFor({ repository, sessionUser: "intruder" }).goLiveDrafts.queue({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ repository, sessionUser: null }).goLiveDrafts.queue({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({ apiKey: "dfk_wrong", repository }).goLiveDrafts.queue({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(clientFor().goLiveDrafts.queue({}), "STORAGE_ERROR", 503);
  });

  it("shows the stored approved order of an approved draft next to today's sizing", async () => {
    // Approved at 10 spreads for 1.20. Today's quote sizes 16 at 1.25.
    const approvedOrder = { ...ORDER, limitPrice: 1.2, quantity: 10 };
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy", {
          approvedOrder,
          decidedAt: NOW,
          decidedBy: "owner",
          state: "approved",
        }),
      ],
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.drafts[0]).toMatchObject({
      approvedOrder,
      notApprovable: ["DRAFT_NOT_PROPOSED"],
      order: ORDER,
      sizing: SIZED,
      state: "approved",
    });
  });

  it.each(["proposed", "rejected", "expired"] as const)(
    "shows no approved order for a %s draft",
    async (state) => {
      // The table check allows an order only on an approved row; the answer does not rely on it.
      const memory = createMemoryRepository({
        drafts: [record("d-spy", { approvedOrder: ORDER, state })],
      });
      const queue = await clientFor({
        repository: memory.repository,
      }).goLiveDrafts.queue({});
      expect(queue.drafts[0]).toMatchObject({ approvedOrder: null, state });
    }
  );

  it("does not show an approved order to an agent API key", async () => {
    // The quantity of an approved order was sized from the account value, and a key also sees
    // the plan's risk percentages: quantity x limit would bound the account value.
    // Values that appear nowhere else in the answer, so a leak is found by searching for them.
    const approvedOrder = { ...ORDER, limitPrice: 3.13, quantity: 7919 };
    const repository = createMemoryRepository({
      drafts: [
        record("d-spy", {
          approvedOrder,
          decidedAt: NOW,
          decidedBy: "owner",
          state: "approved",
        }),
      ],
    }).repository;
    for (const keyAccess of ["read", "write"] as const) {
      const queue = await clientFor({
        apiKey: PLAINTEXT,
        keyAccess,
        repository,
      }).goLiveDrafts.queue({});
      expect(queue.drafts[0]).toMatchObject({
        approvedOrder: null,
        order: null,
        state: "approved",
      });
      const answer = JSON.stringify(queue);
      expect(queue.drafts[0]?.approvedRoom).toBeNull();
      // 7,919 x 313 = 2,478,647: the room the approved order holds.
      for (const value of [
        approvedOrder.quantity,
        approvedOrder.limitPrice,
        2_478_647,
        NLV,
      ])
        expect(answer).not.toContain(String(value));
      expect(answer).not.toMatch(
        /"(budget|limitPrice|maxLoss|maxLossPctNlv|maxLossPerSpread|netLiquidation)":(?!null)/u
      );
      expect(answer).not.toMatch(/"quantity":(?!0[,}])/u);
    }
    // Sessions are unchanged: the owner, an operator and the agent viewer get the stored order.
    for (const options of [
      { repository },
      { admin: false, repository, sessionUser: "operator" },
      {
        agentViewerEmails: ["viewer@domain.test"],
        repository,
        sessionUser: "viewer",
      },
    ]) {
      const queue = await clientFor(options).goLiveDrafts.queue({});
      expect(queue.drafts[0]?.approvedOrder).toEqual(approvedOrder);
      expect(queue.drafts[0]?.approvedRoom).toEqual({
        maxLoss: 2_478_647,
        maxLossPctNlv: 2478.65,
      });
      expect(JSON.stringify(queue)).toContain('"quantity":7919');
    }
  });

  it("returns a plan whose links pass, and a plan without links", async () => {
    const proposed = plan({
      approvalBasis: null,
      approvedAt: null,
      approvedBy: null,
      evidenceUrl: null,
      ownerMessageUrl: null,
      status: "proposed",
    });
    for (const stored of [plan(), proposed]) {
      const queue = await clientFor({
        repository: createMemoryRepository({ plan: stored }).repository,
      }).goLiveDrafts.queue({});
      expect(queue.plan).toEqual(stored);
    }
  });

  it.each([
    [
      "ownerMessageUrl",
      { ownerMessageUrl: "javascript:alert(document.domain)" },
    ],
    // A channel link, not a message link.
    [
      "ownerMessageUrl",
      { ownerMessageUrl: "https://discord.com/channels/1/2" },
    ],
    [
      "ownerMessageUrl",
      { ownerMessageUrl: "https://discord.com.evil.test/channels/1/2/3" },
    ],
    ["evidenceUrl", { evidenceUrl: "http://evidence.domain.test/report" }],
    ["evidenceUrl", { evidenceUrl: "javascript:alert(document.domain)" }],
    ["evidenceUrl", { evidenceUrl: "evidence report" }],
    [
      "evidenceUrl, ownerMessageUrl",
      { evidenceUrl: "ftp://evidence.domain.test", ownerMessageUrl: "" },
    ],
  ] as const)(
    "refuses a stored plan by naming %s when a stored link does not pass (%j)",
    async (fields, links) => {
      const memory = createMemoryRepository({
        drafts: [record("d-spy"), record("d-qqq", { symbol: "QQQ" })],
        plan: plan(links),
      });
      const client = clientFor({ repository: memory.repository });
      const error: unknown = await client.goLiveDrafts
        .queue({})
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ORPCError);
      // A named error, not an unexplained 500 and not an answer that carries the link.
      expect(error).toMatchObject({
        code: "STORAGE_ERROR",
        message: `The stored plan pie version 1 is not valid (${fields}). Write the plan again with scripts/golive/seed-plan.ts`,
        status: 503,
      });
      // The stored value is not repeated anywhere in the error.
      for (const value of Object.values(links))
        if (value !== "") expect(JSON.stringify(error)).not.toContain(value);
      // Nothing is approved under that plan record, and nothing is stored.
      await expectCode(
        client.goLiveDrafts.approve(approval()),
        "STORAGE_ERROR",
        503,
        "The stored plan pie version 1 is not valid"
      );
      expect(memory.repository.decide).not.toHaveBeenCalled();
      expect(memory.drafts.get("d-spy")).toEqual(record("d-spy"));
      // A rejection does not depend on the plan record.
      await expect(
        client.goLiveDrafts.reject({ id: "d-qqq", note: "No" })
      ).resolves.toMatchObject({ approvedOrder: null, state: "rejected" });
    }
  );

  it.each([
    ["no order", null],
    ["a value that is not an order", { symbol: "SPY" }],
    ["an order with a zero quantity", { ...ORDER, quantity: 0 }],
    // Valid as an order, and not the order of this draft: its room cannot be trusted.
    ["the order of another symbol", { ...ORDER, symbol: "QQQ" }],
    ["an order with a credit limit", { ...ORDER, limitPrice: -1.25 }],
    ["an order with a limit of the whole width", { ...ORDER, limitPrice: 5 }],
    [
      "an order with another strike",
      { ...ORDER, legs: [ORDER.legs[0], { ...ORDER.legs[1], strike: 110 }] },
    ],
  ] as const)(
    "refuses an approved draft that holds %s by naming the draft",
    async (_name, stored) => {
      // The table check and the store prevent this; a row changed by hand is named, not hidden.
      const memory = createMemoryRepository({
        drafts: [
          record("d-qqq", { symbol: "QQQ" }),
          record("d-spy", {
            approvedOrder: stored as GoLiveDraftRecord["approvedOrder"],
            decidedAt: NOW,
            decidedBy: "owner",
            state: "approved",
          }),
        ],
      });
      const client = clientFor({ repository: memory.repository });
      const message =
        "Draft d-spy is approved and its stored approved order is missing or is not the order of that draft";
      await expectCode(
        client.goLiveDrafts.queue({}),
        "STORAGE_ERROR",
        503,
        message
      );
      // Nothing is approved on that day, and a rejection says that it was stored.
      await expectCode(
        client.goLiveDrafts.approve(
          approval({ id: "d-qqq", order: { ...ORDER, symbol: "QQQ" } })
        ),
        "STORAGE_ERROR",
        503,
        message
      );
      await expectCode(
        client.goLiveDrafts.reject({ id: "d-qqq", note: "No" }),
        "STORAGE_ERROR",
        503,
        `The rejection of draft d-qqq was stored. ${message}`
      );
    }
  );

  it("names a stored draft whose strikes are the wrong way round and sizes nothing", async () => {
    // collect refuses such a candidate; this is a row stored before that rule or changed by hand.
    // A call debit vertical that buys the higher strike is really a call credit vertical.
    const memory = createMemoryRepository({
      drafts: [
        record("d-qqq", { symbol: "QQQ" }),
        record("d-spy", { longStrike: 105, shortStrike: 100 }),
      ],
    });
    const repository = memory.repository;
    const message =
      "Draft d-spy has strikes that are the wrong way round for callDebitVertical and cannot be sized";
    // For a session and for a key: no draft of the day is sized or returned.
    for (const options of [{ repository }, { apiKey: PLAINTEXT, repository }])
      await expectCode(
        clientFor(options).goLiveDrafts.queue({}),
        "STORAGE_ERROR",
        503,
        message
      );
    const client = clientFor({ repository });
    // Nothing is approved on that day, also not the draft that is in order.
    await expectCode(
      client.goLiveDrafts.approve(
        approval({ id: "d-qqq", order: { ...ORDER, symbol: "QQQ" } })
      ),
      "STORAGE_ERROR",
      503,
      message
    );
    expect(repository.decide).not.toHaveBeenCalled();
    // A rejection is stored; its answer says so and names the draft.
    await expectCode(
      client.goLiveDrafts.reject({ id: "d-spy", note: "Wrong strikes" }),
      "STORAGE_ERROR",
      503,
      `The rejection of draft d-spy was stored. ${message}`
    );
    expect(memory.drafts.get("d-spy")).toMatchObject({
      approvedOrder: null,
      decisionNote: "Wrong strikes",
      state: "rejected",
    });
  });

  it("uses the system clock by default", async () => {
    setGoLiveDraftsDependenciesForTesting({
      account: async () => ACCOUNT,
      node: async () => ({ armedAt: null, badge: "unknown" }),
    });
    const before = Date.now();
    const queue = await clientFor({
      repository: createMemoryRepository().repository,
    }).goLiveDrafts.queue({});
    expect(queue.tradingDay).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(queue.node.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

const NOW_S = NOW.getTime() / 1000;
const PORTFOLIO = { token: "portfolio-token", url: "https://portfolio.test" };

const portfolioFeed = (
  overrides: Readonly<Record<string, unknown>> = {}
): Response =>
  new Response(
    JSON.stringify({
      accountCount: 1,
      accountMode: "live",
      clientId: 78,
      completed: [],
      connected: true,
      dataAsOf: NOW_S - 1,
      errors: [],
      executions: [],
      generatedAt: NOW_S - 5,
      lastError: null,
      orders: [],
      ordersAsOf: NOW_S - 1,
      pnl: {},
      positions: [],
      schema: "vertex-portfolio-snapshot-v1",
      source: "ibkr-gateway",
      state: "live",
      summary: { NetLiquidation: 250_000 },
      version: "1.0.0",
      ...overrides,
    }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );

describe("goLiveDrafts.queue account value", () => {
  const accountWith = async (
    feed: () => Response,
    options: ClientOptions = { portfolioMonitor: PORTFOLIO }
  ): Promise<GoLiveAccountReading> => {
    injectWithout("account", {
      portfolioFetch: { fetch: async () => feed(), now: () => NOW },
    });
    const queue = await clientFor({
      ...options,
      repository: createMemoryRepository().repository,
    }).goLiveDrafts.queue({});
    return queue.account;
  };

  it("takes a fresh NLV from the portfolio monitor", async () => {
    expect(await accountWith(() => portfolioFeed())).toEqual({
      asOf: new Date((NOW_S - 5) * 1000),
      netLiquidation: 250_000,
      unavailableReason: null,
    });
  });

  it("names the cause when the value cannot be used", async () => {
    const disconnected = { connected: false, state: "disconnected" };
    const cases: readonly (readonly [() => Response, string, Date | null])[] = [
      [
        () => portfolioFeed({ ...disconnected, dataAsOf: null }),
        "Portfolio monitor data has no time",
        null,
      ],
      [
        () => portfolioFeed(disconnected),
        "Portfolio monitor is not connected to IBKR",
        new Date((NOW_S - 1) * 1000),
      ],
      // 15 minutes and 1 second old.
      [
        () => portfolioFeed({ generatedAt: NOW_S - 901 }),
        "Portfolio monitor data is not fresh",
        new Date((NOW_S - 901) * 1000),
      ],
      // 61 seconds in the future.
      [
        () => portfolioFeed({ generatedAt: NOW_S + 61 }),
        "Portfolio monitor data is not fresh",
        new Date((NOW_S + 61) * 1000),
      ],
      [
        () => portfolioFeed({ summary: {} }),
        "Portfolio monitor has no net liquidation value",
        new Date((NOW_S - 5) * 1000),
      ],
      [
        () => portfolioFeed({ summary: { NetLiquidation: 0 } }),
        "Portfolio monitor has no net liquidation value",
        new Date((NOW_S - 5) * 1000),
      ],
      [
        () => new Response("down", { status: 503 }),
        "Portfolio monitor did not answer or is not configured",
        null,
      ],
    ];
    for (const [feed, unavailableReason, asOf] of cases)
      expect(await accountWith(feed)).toEqual({
        asOf,
        netLiquidation: null,
        unavailableReason,
      });
    // No endpoint configured, and no fetch options given.
    expect(await accountWith(() => portfolioFeed(), {})).toMatchObject({
      netLiquidation: null,
      unavailableReason:
        "Portfolio monitor did not answer or is not configured",
    });
    injectWithout("account");
    const queue = await clientFor({
      repository: createMemoryRepository().repository,
    }).goLiveDrafts.queue({});
    expect(queue.account.netLiquidation).toBeNull();
  });
});

const RECOVERY = { token: "recovery-token", url: "https://recovery.test" };
const ARMED_AT = "2026-11-13T14:00:00Z";

const nodeStatus = (
  state: "running" | "exited",
  armed: boolean | null
): Response =>
  new Response(
    JSON.stringify({
      arm:
        armed === null
          ? null
          : {
              armed,
              armedAt: armed ? ARMED_AT : null,
              armedBy: armed ? "owner" : null,
              detail: armed ? "armed" : "no_arm_record",
              imageVersion: "1.2.3",
              killSwitchActive: false,
              reason: armed ? "Go-live session" : null,
              state: armed ? "armed" : "disarmed",
            },
      armError: null,
      container: { health: null, state },
      generatedAt: "2026-11-13T21:29:59Z",
      schema: "vertex-nautilus-arm-status-v1",
      version: "1.2.3",
    }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );

describe("goLiveDrafts.queue node badge", () => {
  const nodeWith = async (
    reply: () => Response,
    options: ClientOptions = { ibkrRecovery: RECOVERY }
  ) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
    setNautilusArmDependenciesForTesting({ fetch, now: () => NOW });
    injectWithout("node");
    const queue = await clientFor({
      ...options,
      repository: createMemoryRepository().repository,
    }).goLiveDrafts.queue({});
    return { fetch, node: queue.node };
  };

  it("reads the badge through the read-only status call", async () => {
    const armed = await nodeWith(() => nodeStatus("running", true));
    expect(armed.node).toEqual({
      armedAt: ARMED_AT,
      badge: "running-armed",
      checkedAt: NOW,
    });
    // One GET of the status path; arm and disarm are POSTs to other paths.
    expect(armed.fetch).toHaveBeenCalledTimes(1);
    expect(armed.fetch.mock.calls[0]?.[0]).toBe(
      "https://recovery.test/nautilus/status"
    );
    expect(armed.fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect((await nodeWith(() => nodeStatus("running", false))).node).toEqual({
      armedAt: null,
      badge: "running-disarmed",
      checkedAt: NOW,
    });
    expect((await nodeWith(() => nodeStatus("exited", null))).node).toEqual({
      armedAt: null,
      badge: "down",
      checkedAt: NOW,
    });
  });

  it("answers unknown on any failure, without configuration and for an API key", async () => {
    const unknown = { armedAt: null, badge: "unknown", checkedAt: NOW };
    const failed = await nodeWith(() => new Response("down", { status: 503 }));
    expect(failed.node).toEqual(unknown);
    const unconfigured = await nodeWith(() => nodeStatus("running", true), {});
    expect(unconfigured.node).toEqual(unknown);
    expect(unconfigured.fetch).not.toHaveBeenCalled();
    // nautilusArm.status refuses agent API keys; the queue does not go around that rule.
    const key = await nodeWith(() => nodeStatus("running", true), {
      apiKey: PLAINTEXT,
      ibkrRecovery: RECOVERY,
      keyAccess: "read",
    });
    expect(key.node).toEqual(unknown);
    expect(key.fetch).not.toHaveBeenCalled();
  });
});

// The quote is a delayed one, as the rig generator sends it: the server refuses the label
// ibkr_live while no live IBKR option quote source exists.
const candidate = (
  overrides: Partial<GoLiveCollectInput["candidates"][number]> = {}
): GoLiveCollectInput["candidates"][number] => ({
  entryBasis: "signal_today",
  expiry: EXPIRY,
  longStrike: 100,
  quote: {
    ...liveQuote({ source: "yahoo_delayed_snapshot" }),
    asOf: LIVE_AS_OF,
  },
  shortStrike: 105,
  signalFacts: ["VIX 19.5 on 2026-11-11"],
  sleeveKey: "trend",
  structure: "callDebitVertical",
  symbol: "SPY",
  ...overrides,
});

const batch = (
  overrides: Partial<GoLiveCollectInput> = {}
): GoLiveCollectInput => ({
  candidates: [
    candidate(),
    candidate({
      longStrike: 95,
      quote: null,
      shortStrike: 100,
      sleeveKey: "income",
      structure: "putCreditVertical",
      symbol: "IWM",
    }),
  ],
  generatedAt: "2026-11-13T21:00:00.000Z",
  planId: "pie",
  planVersion: 1,
  tradingDay: TODAY,
  ...overrides,
});

describe("goLiveDrafts.collect", () => {
  const keyClient = (repository?: GoLiveDraftsRepositoryPort) =>
    clientFor({
      apiKey: PLAINTEXT,
      ...(repository === undefined ? {} : { repository }),
    });

  it("stores the generator's candidates once", async () => {
    const memory = createMemoryRepository();
    const client = keyClient(memory.repository);
    expect(await client.goLiveDrafts.collect(batch())).toEqual({
      created: 2,
      expired: 0,
      unchanged: 0,
      updated: 0,
    });
    const [run] = memory.repository.collect.mock.calls[0] ?? [];
    expect(run).toMatchObject({
      generatedAt: new Date("2026-11-13T21:00:00.000Z"),
      planId: "pie",
      planVersion: 1,
      tradingDay: TODAY,
    });
    const stored = run?.candidates ?? [];
    expect(stored.map((entry) => entry.symbol)).toEqual(["SPY", "IWM"]);
    expect(stored[0]?.quote?.asOf).toEqual(new Date(LIVE_AS_OF));
    // A rerun changes nothing.
    expect(await client.goLiveDrafts.collect(batch())).toEqual({
      created: 0,
      expired: 0,
      unchanged: 2,
      updated: 0,
    });
    const queue = await client.goLiveDrafts.queue({});
    expect(queue.generatedAt).toEqual(new Date("2026-11-13T21:00:00.000Z"));
    expect(queue.drafts.map((draft) => draft.state)).toEqual([
      "proposed",
      "proposed",
    ]);
  });

  it("needs an agent write key", async () => {
    const memory = createMemoryRepository();
    const repository = memory.repository;
    await expectCode(
      clientFor({ repository }).goLiveDrafts.collect(batch()),
      "FORBIDDEN",
      403,
      "needs an agent API key"
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        repository,
      }).goLiveDrafts.collect(batch()),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ apiKey: "dfk_wrong", repository }).goLiveDrafts.collect(
        batch()
      ),
      "UNAUTHORIZED",
      401
    );
    expect(repository.collect).not.toHaveBeenCalled();
  });

  it("refuses the whole batch for a foreign sleeve, symbol or structure", async () => {
    const memory = createMemoryRepository();
    const client = keyClient(memory.repository);
    const cases: readonly (readonly [
      Partial<GoLiveCollectInput["candidates"][number]>,
      string,
    ])[] = [
      [
        { sleeveKey: "momentum" },
        "Sleeve momentum is not in the plan in force",
      ],
      // IWM belongs to the income sleeve, not to trend.
      [{ symbol: "IWM" }, "IWM is not a symbol of sleeve trend"],
      // A bear put spread with its strikes the right way round; the trend sleeve trades calls.
      [
        { longStrike: 105, shortStrike: 100, structure: "putDebitVertical" },
        "Sleeve trend trades callDebitVertical, not putDebitVertical",
      ],
    ];
    for (const [foreign, message] of cases)
      await expectCode(
        client.goLiveDrafts.collect(
          batch({ candidates: [candidate(), candidate(foreign)] })
        ),
        "VALIDATION_ERROR",
        422,
        message
      );
    expect(memory.repository.collect).not.toHaveBeenCalled();
    expect(memory.drafts.size).toBe(0);
  });

  it("accepts only the session in which an order would be placed", async () => {
    const memory = createMemoryRepository();
    const client = keyClient(memory.repository);
    // A past day, today after the close, the weekend, and the session after the next.
    for (const tradingDay of [
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-17",
    ])
      await expectCode(
        client.goLiveDrafts.collect(batch({ tradingDay })),
        "VALIDATION_ERROR",
        422,
        `collect accepts only trading day ${TODAY}`
      );
    expect(memory.repository.planInForce).not.toHaveBeenCalled();
    expect(memory.repository.collect).not.toHaveBeenCalled();
  });

  it("refuses a batch built for another plan", async () => {
    const memory = createMemoryRepository();
    const client = keyClient(memory.repository);
    for (const other of [{ planVersion: 2 }, { planId: "other" }])
      await expectCode(
        client.goLiveDrafts.collect(batch(other)),
        "CONFLICT",
        409,
        "not the plan in force"
      );
    await expectCode(
      keyClient(
        createMemoryRepository({ plan: null }).repository
      ).goLiveDrafts.collect(batch()),
      "CONFLICT",
      409
    );
    expect(memory.repository.collect).not.toHaveBeenCalled();
    // The store checks the plan again inside its transaction.
    memory.repository.collect.mockRejectedValueOnce(
      new GoLivePlanMismatchError({ planId: "pie", planVersion: 1 }, null)
    );
    await expectCode(
      client.goLiveDrafts.collect(batch()),
      "CONFLICT",
      409,
      "not the plan in force"
    );
  });

  it("rejects an invalid batch and reports missing storage", async () => {
    const memory = createMemoryRepository();
    await expectCode(
      keyClient(memory.repository).goLiveDrafts.collect(
        batch({ candidates: [candidate({ shortStrike: 100 })] })
      ),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      keyClient().goLiveDrafts.collect(batch()),
      "STORAGE_ERROR",
      503
    );
  });

  // A stored proposed draft that the batches below do not name: a collect that ran would
  // expire it in the Postgres store.
  const withStoredDraft = () => {
    const memory = createMemoryRepository({
      drafts: [record("d-earlier", { symbol: "QQQ" })],
    });
    const untouched = async (): Promise<void> => {
      // The call stopped before the store: no plan read, no collect, so no expiry and no run.
      expect(memory.repository.planInForce).not.toHaveBeenCalled();
      expect(memory.repository.collect).not.toHaveBeenCalled();
      expect(memory.drafts.size).toBe(1);
      expect(memory.drafts.get("d-earlier")).toEqual(
        record("d-earlier", { symbol: "QQQ" })
      );
      const queue = await clientFor({
        repository: memory.repository,
      }).goLiveDrafts.queue({});
      expect(queue.drafts.map((draft) => [draft.id, draft.state])).toEqual([
        ["d-earlier", "proposed"],
      ]);
      expect(queue.generatedAt).toBeNull();
    };
    return { client: keyClient(memory.repository), memory, untouched };
  };

  it("refuses a quote labelled ibkr_live while no live quote source exists", async () => {
    const { client, untouched } = withStoredDraft();
    const labelled = batch({
      candidates: [
        candidate(),
        candidate({
          quote: { ...liveQuote(), asOf: LIVE_AS_OF },
          symbol: "QQQ",
        }),
      ],
    });
    // The test dependencies say nothing about a live source, the service on its own (no
    // dependencies at all) has none, and false says there is none: all three refuse.
    for (const dependencies of [
      defaults(),
      {},
      { ...defaults(), liveQuoteSource: false },
    ]) {
      setGoLiveDraftsDependenciesForTesting(dependencies);
      await expectCode(
        client.goLiveDrafts.collect(labelled),
        "BAD_REQUEST",
        400,
        "A quote labelled ibkr_live is not accepted: no live IBKR option quote source exists in this version"
      );
    }
    inject();
    await untouched();
  });

  it("accepts the label only where a live quote source is declared", async () => {
    inject({ liveQuoteSource: true });
    const memory = createMemoryRepository();
    await expect(
      keyClient(memory.repository).goLiveDrafts.collect(
        batch({
          candidates: [
            candidate({ quote: { ...liveQuote(), asOf: LIVE_AS_OF } }),
          ],
        })
      )
    ).resolves.toEqual({ created: 1, expired: 0, unchanged: 0, updated: 0 });
    expect(
      [...memory.drafts.values()].map((draft) => draft.quote?.source)
    ).toEqual(["ibkr_live"]);
  });

  it.each([
    ["callDebitVertical", 105, 100],
    ["putCreditVertical", 100, 95],
    ["putDebitVertical", 100, 105],
    ["callCreditVertical", 100, 105],
  ] as const)(
    "refuses a %s that buys %d and sells %d: the strikes are the wrong way round",
    async (structure, longStrike, shortStrike) => {
      const { client, untouched } = withStoredDraft();
      await expectCode(
        client.goLiveDrafts.collect(
          batch({
            candidates: [
              candidate(),
              candidate({ longStrike, shortStrike, structure, symbol: "QQQ" }),
            ],
          })
        ),
        "BAD_REQUEST",
        400
      );
      await untouched();
    }
  );

  it.each([
    ["is not a calendar day", "20261399"],
    ["is not a calendar day", "20260230"],
    ["is the trading day", TODAY.replaceAll("-", "")],
    ["is before the trading day", "20261113"],
  ])("refuses an expiry that %s (%s)", async (_name, expiry) => {
    const { client, untouched } = withStoredDraft();
    await expectCode(
      client.goLiveDrafts.collect(
        batch({ candidates: [candidate(), candidate({ expiry })] })
      ),
      "BAD_REQUEST",
      400
    );
    await untouched();
  });
});

const approval = (
  overrides: Partial<GoLiveDraftApproveInput> = {}
): GoLiveDraftApproveInput => ({
  confirm: true,
  id: "d-spy",
  order: ORDER,
  // The revision of a draft that no later run changed.
  revision: 1,
  ...overrides,
});

describe("goLiveDrafts.approve", () => {
  it("records the owner's approval of the exact order and nothing else", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const approved = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.approve(approval({ note: "As shown" }));
    expect(memory.repository.decide).toHaveBeenCalledTimes(1);
    expect(memory.repository.decide).toHaveBeenCalledWith({
      approvedOrder: ORDER,
      decidedBy: "owner",
      decision: "approved",
      // The revision the owner read, which is the revision of the draft this request read.
      expectedRevision: 1,
      id: "d-spy",
      nodeBadge: "running-disarmed",
      note: "As shown",
    });
    expect(memory.repository.collect).not.toHaveBeenCalled();
    expect(approved).toMatchObject({
      approvedOrder: ORDER,
      decidedAt: NOW,
      decidedBy: "owner",
      decisionNote: "As shown",
      id: "d-spy",
      nodeBadgeAtDecision: "running-disarmed",
      notApprovable: ["DRAFT_NOT_PROPOSED"],
      order: ORDER,
      sizing: SIZED,
      state: "approved",
    });
  });

  it("stores exactly the order the server sized", async () => {
    // A wider spread on another quote: debit 2.00, 200 per spread, 10 spreads in the 2,000 budget.
    const draft = record("d-qqq", {
      longStrike: 480,
      quote: liveQuote({
        longAsk: 5.1,
        longBid: 4.9,
        shortAsk: 3.1,
        shortBid: 2.9,
      }),
      shortStrike: 490,
      symbol: "QQQ",
    });
    const memory = createMemoryRepository({ drafts: [draft] });
    const client = clientFor({ repository: memory.repository });
    const sized = {
      legs: [
        { expiry: EXPIRY, ratio: 1, right: "C", side: "BUY", strike: 480 },
        { expiry: EXPIRY, ratio: 1, right: "C", side: "SELL", strike: 490 },
      ],
      limitPrice: 2,
      quantity: 10,
      symbol: "QQQ",
    } satisfies GoLiveDraftApproveInput["order"];
    // What the server sized from the stored draft, read before anything was approved.
    const before = await client.goLiveDrafts.queue({});
    expect(before.drafts[0]).toMatchObject({
      approvedOrder: null,
      order: sized,
    });
    const approved = await client.goLiveDrafts.approve(
      approval({ id: "d-qqq", order: sized })
    );
    expect(approved.approvedOrder).toEqual(sized);
    // The store got that order and holds it, field for field and with no other field.
    const written = memory.repository.decide.mock.calls[0]?.[0];
    expect(written).toEqual({
      approvedOrder: sized,
      decidedBy: "owner",
      decision: "approved",
      expectedRevision: 1,
      id: "d-qqq",
      nodeBadge: "running-disarmed",
      note: null,
    });
    expect(memory.drafts.get("d-qqq")).toEqual({
      ...draft,
      approvedOrder: sized,
      decidedAt: NOW,
      decidedBy: "owner",
      decisionNote: null,
      nodeBadgeAtDecision: "running-disarmed",
      // The decision is a write: the revision went from 1 to 2.
      revision: 2,
      state: "approved",
    });
    // The next read shows the stored order as the approved order.
    const after = await client.goLiveDrafts.queue({});
    expect(after.drafts[0]).toMatchObject({
      approvedOrder: sized,
      state: "approved",
    });
  });

  it("stores no note when none is given, and the badge it read", async () => {
    inject({ node: async () => ({ armedAt: null, badge: "unknown" }) });
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    await clientFor({ repository: memory.repository }).goLiveDrafts.approve(
      approval()
    );
    expect(memory.repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({ nodeBadge: "unknown", note: null })
    );
  });

  it("refuses a draft for each reason it cannot be approved", async () => {
    type Case = Readonly<{
      dependencies?: GoLiveDraftsDependencies;
      draft?: Partial<GoLiveDraftRecord>;
      plan?: GoLivePlanRecord | null;
      reasons: string;
    }>;
    const cases: readonly Case[] = [
      {
        plan: plan({ approvalBasis: null, status: "proposed" }),
        reasons: "PLAN_NOT_APPROVED",
      },
      { plan: null, reasons: "PLAN_NOT_APPROVED, SIZED_TO_ZERO" },
      {
        draft: { entryBasis: "model_holds_account_does_not" },
        reasons: "LATE_ENTRY_NOT_TESTED",
      },
      {
        draft: { quote: liveQuote({ source: "yahoo_delayed_snapshot" }) },
        reasons: "NO_LIVE_IBKR_QUOTE",
      },
      // 121 seconds old.
      {
        draft: {
          quote: liveQuote({
            asOf: new Date(NOW.getTime() - 121_000).toISOString(),
          }),
        },
        reasons: "NO_LIVE_IBKR_QUOTE",
      },
      {
        dependencies: {
          account: async () => ({
            asOf: null,
            netLiquidation: null,
            unavailableReason: "Portfolio monitor did not answer",
          }),
        },
        reasons: "NLV_UNAVAILABLE, SIZED_TO_ZERO",
      },
      // 2,500 per spread against a 2,000 budget.
      {
        draft: {
          quote: liveQuote({
            longAsk: 40.1,
            longBid: 39.9,
            shortAsk: 15.1,
            shortBid: 14.9,
          }),
          shortStrike: 150,
        },
        reasons: "SIZED_TO_ZERO",
      },
      {
        dependencies: { jevVerdict: () => verdict("BEARISH") },
        reasons: "PRECHECK_DENIED",
      },
      {
        dependencies: { jevVerdict: () => null },
        reasons: "PRECHECK_DENIED",
      },
      {
        draft: { approvedOrder: ORDER, state: "approved" },
        reasons: "DRAFT_NOT_PROPOSED",
      },
      { draft: { state: "rejected" }, reasons: "DRAFT_NOT_PROPOSED" },
      {
        draft: { state: "expired" },
        reasons: "DRAFT_NOT_PROPOSED, DRAFT_EXPIRED",
      },
    ];
    for (const entry of cases) {
      inject(entry.dependencies);
      const memory = createMemoryRepository({
        drafts: [record("d-spy", entry.draft)],
        ...(entry.plan === undefined ? {} : { plan: entry.plan }),
      });
      await expectCode(
        clientFor({ repository: memory.repository }).goLiveDrafts.approve(
          approval()
        ),
        "CONFLICT",
        409,
        `Draft cannot be approved: ${entry.reasons}`
      );
      expect(memory.repository.decide).not.toHaveBeenCalled();
    }
  });

  it("refuses an order that differs by one cent, one contract or one leg", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const client = clientFor({ repository: memory.repository });
    const [buy, sell] = ORDER.legs;
    for (const order of [
      { ...ORDER, limitPrice: 1.26 },
      { ...ORDER, limitPrice: 1.24 },
      { ...ORDER, quantity: 17 },
      { ...ORDER, quantity: 15 },
      { ...ORDER, symbol: "QQQ" },
      { ...ORDER, legs: [buy, { ...sell, strike: 106 }] },
      { ...ORDER, legs: [sell, buy] },
    ])
      await expectCode(
        client.goLiveDrafts.approve(
          approval({ order: order as GoLiveDraftApproveInput["order"] })
        ),
        "CONFLICT",
        409,
        "not the order the server sized"
      );
    expect(memory.repository.decide).not.toHaveBeenCalled();
    // Nothing was stored: the draft is as it was, proposed and without an order.
    expect(memory.drafts.get("d-spy")).toEqual(record("d-spy"));
    expect(memory.drafts.get("d-spy")?.approvedOrder).toBeNull();
  });

  it("refuses an agent API key, a non-admin operator and a non-operator", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const repository = memory.repository;
    for (const keyAccess of ["read", "write"] as const)
      await expectCode(
        clientFor({
          apiKey: PLAINTEXT,
          keyAccess,
          repository,
        }).goLiveDrafts.approve(approval()),
        "FORBIDDEN",
        403
      );
    // The procedure refuses a key by itself, without the handler's key scope list.
    const request = new Request("https://darkfactory.localhost/rpc", {
      headers: { "x-api-key": PLAINTEXT },
    });
    await expectCode(
      call(goLiveDraftsRouter.approve, approval(), {
        context: contextFor(request, { repository }),
      }),
      "FORBIDDEN",
      403,
      "owner's browser session"
    );
    await expectCode(
      clientFor({
        admin: false,
        repository,
        sessionUser: "operator",
      }).goLiveDrafts.approve(approval()),
      "FORBIDDEN",
      403,
      "Owner (admin) access required"
    );
    await expectCode(
      clientFor({ repository, sessionUser: "intruder" }).goLiveDrafts.approve(
        approval()
      ),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ repository, sessionUser: null }).goLiveDrafts.approve(
        approval()
      ),
      "UNAUTHORIZED",
      401
    );
    expect(repository.decide).not.toHaveBeenCalled();
    expect(repository.listDrafts).not.toHaveBeenCalled();
  });

  it("finds only a draft of the order session day", async () => {
    const memory = createMemoryRepository({
      drafts: [record("d-old", { tradingDay: "2026-11-10" })],
    });
    const client = clientFor({ repository: memory.repository });
    for (const id of ["d-old", "missing"])
      await expectCode(
        client.goLiveDrafts.approve(approval({ id })),
        "NOT_FOUND",
        404,
        `Draft is not in the queue of trading day ${TODAY}`
      );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });

  it("maps the store's errors and reports missing storage", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const client = clientFor({ repository: memory.repository });
    // Another session decided the draft between the read and the write.
    memory.repository.decide.mockRejectedValueOnce(
      new GoLiveDraftConflictError("d-spy")
    );
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "CONFLICT",
      409,
      "no longer proposed"
    );
    memory.repository.decide.mockRejectedValueOnce(
      new GoLiveDraftNotFoundError("d-spy")
    );
    await expectCode(client.goLiveDrafts.approve(approval()), "NOT_FOUND", 404);
    // Unknown failures are not turned into a draft error.
    memory.repository.decide.mockRejectedValueOnce(new Error("pool closed"));
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "INTERNAL_SERVER_ERROR",
      500
    );
    memory.repository.decide.mockRejectedValueOnce("not an error");
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "INTERNAL_SERVER_ERROR",
      500
    );
    await expectCode(
      clientFor().goLiveDrafts.approve(approval()),
      "STORAGE_ERROR",
      503
    );
  });
});

describe("goLiveDrafts live IBKR quotes (bridge POST /quotes)", () => {
  const delayed = liveQuote({ source: "yahoo_delayed_snapshot" });

  it("overlays the live spread quote on a proposed draft, so it becomes approvable", async () => {
    const reader = vi.fn(async () => ({
      ...liveQuote(),
      asOf: new Date(LIVE_AS_OF),
    }));
    inject({ liveQuotes: reader });
    const memory = createMemoryRepository({
      drafts: [record("d-spy", { quote: delayed })],
    });
    const client = clientFor({ repository: memory.repository });
    const queue = await client.goLiveDrafts.queue({});
    expect(reader).toHaveBeenCalledWith({
      long: { expiry: EXPIRY, right: "C", strike: 100, symbol: "SPY" },
      short: { expiry: EXPIRY, right: "C", strike: 105, symbol: "SPY" },
    });
    expect(queue.drafts[0]?.quote?.source).toBe("ibkr_live");
    expect(queue.drafts[0]?.notApprovable).toEqual([]);
    expect(queue.drafts[0]?.order).toEqual(ORDER);
    await client.goLiveDrafts.approve(approval());
    expect(memory.repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({ approvedOrder: ORDER, id: "d-spy" })
    );
  });

  it("keeps the stored delayed quote when the reader has no live quote", async () => {
    inject({ liveQuotes: async () => null });
    const memory = createMemoryRepository({
      drafts: [record("d-spy", { quote: delayed })],
    });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.drafts[0]?.quote?.source).toBe("yahoo_delayed_snapshot");
    expect(queue.drafts[0]?.notApprovable).toContain("NO_LIVE_IBKR_QUOTE");
  });

  it("never quotes a decided draft or an API key caller", async () => {
    const reader = vi.fn(async () => null);
    inject({ liveQuotes: reader });
    const memory = createMemoryRepository({
      drafts: [record("d-spy", { quote: delayed, state: "rejected" })],
    });
    await clientFor({ repository: memory.repository }).goLiveDrafts.queue({});
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("goLiveDrafts.reject", () => {
  it("records the owner's rejection with the note", async () => {
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy"),
        // A draft of an earlier day can still be rejected.
        record("d-old", { symbol: "QQQ", tradingDay: "2026-11-10" }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    const rejected = await client.goLiveDrafts.reject({
      id: "d-spy",
      note: "Too close to the event",
    });
    expect(memory.repository.decide).toHaveBeenCalledWith({
      decidedBy: "owner",
      decision: "rejected",
      id: "d-spy",
      nodeBadge: null,
      note: "Too close to the event",
    });
    // A rejection sends no order to the store, and none is stored or returned.
    expect(memory.repository.decide.mock.calls[0]?.[0]).not.toHaveProperty(
      "approvedOrder"
    );
    expect(memory.drafts.get("d-spy")?.approvedOrder).toBeNull();
    expect(rejected).toMatchObject({
      approvedOrder: null,
      decisionNote: "Too close to the event",
      id: "d-spy",
      nodeBadgeAtDecision: null,
      notApprovable: ["DRAFT_NOT_PROPOSED"],
      state: "rejected",
    });
    const old = await client.goLiveDrafts.reject({ id: "d-old", note: "Old" });
    expect(old).toMatchObject({ id: "d-old", state: "rejected" });
    expect(memory.repository.listDrafts).toHaveBeenLastCalledWith({
      tradingDay: "2026-11-10",
    });
    // A decided draft is not decided twice.
    await expectCode(
      client.goLiveDrafts.reject({ id: "d-spy", note: "Again" }),
      "CONFLICT",
      409
    );
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "CONFLICT",
      409,
      "DRAFT_NOT_PROPOSED"
    );
    await expectCode(
      client.goLiveDrafts.reject({ id: "missing", note: "No" }),
      "NOT_FOUND",
      404
    );
  });

  it("refuses an agent API key, a non-admin operator and missing storage", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const repository = memory.repository;
    const input = { id: "d-spy", note: "No" };
    await expectCode(
      clientFor({ apiKey: PLAINTEXT, repository }).goLiveDrafts.reject(input),
      "FORBIDDEN",
      403
    );
    const request = new Request("https://darkfactory.localhost/rpc", {
      headers: { "x-api-key": PLAINTEXT },
    });
    await expectCode(
      call(goLiveDraftsRouter.reject, input, {
        context: contextFor(request, { repository }),
      }),
      "FORBIDDEN",
      403,
      "owner's browser session"
    );
    await expectCode(
      clientFor({
        admin: false,
        repository,
        sessionUser: "operator",
      }).goLiveDrafts.reject(input),
      "FORBIDDEN",
      403,
      "Owner (admin) access required"
    );
    expect(repository.decide).not.toHaveBeenCalled();
    await expectCode(
      clientFor().goLiveDrafts.reject(input),
      "STORAGE_ERROR",
      503
    );
  });
});

// queue.canDecide and the approve and reject procedures use one check (decisionRefusal).
describe("goLiveDrafts.queue canDecide", () => {
  const VIEWER = {
    agentViewerEmails: ["viewer@domain.test"],
    sessionUser: "viewer",
  } as const;
  type Caller = Readonly<{
    canDecide: boolean;
    name: string;
    options: ClientOptions;
  }>;
  const CALLERS: readonly Caller[] = [
    { canDecide: true, name: "the owner in a browser session", options: {} },
    {
      canDecide: false,
      name: "an operator session without the admin role",
      options: { admin: false, sessionUser: "operator" },
    },
    { canDecide: false, name: "an agent viewer session", options: VIEWER },
    {
      canDecide: false,
      name: "an agent API key with read access",
      options: { apiKey: PLAINTEXT, keyAccess: "read" },
    },
    {
      canDecide: false,
      name: "an agent API key with write access",
      options: { apiKey: PLAINTEXT, keyAccess: "write" },
    },
  ];

  it.each(CALLERS)(
    "is $canDecide for $name, and approve and reject answer the same",
    async ({ canDecide, options }) => {
      const memory = createMemoryRepository({
        drafts: [record("d-spy"), record("d-qqq", { symbol: "QQQ" })],
      });
      const client = clientFor({ ...options, repository: memory.repository });
      const queue = await client.goLiveDrafts.queue({});
      expect(queue.canDecide).toBe(canDecide);
      const rejection = { id: "d-qqq", note: "No" };
      if (canDecide) {
        await expect(
          client.goLiveDrafts.approve(approval())
        ).resolves.toMatchObject({ state: "approved" });
        await expect(
          client.goLiveDrafts.reject(rejection)
        ).resolves.toMatchObject({ state: "rejected" });
        return;
      }
      await expectCode(
        client.goLiveDrafts.approve(approval()),
        "FORBIDDEN",
        403
      );
      await expectCode(client.goLiveDrafts.reject(rejection), "FORBIDDEN", 403);
      expect(memory.repository.decide).not.toHaveBeenCalled();
    }
  );

  it("refuses an agent viewer by the operator list, even where the role check passes", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const request = new Request("https://darkfactory.localhost/rpc");
    // Called directly, so the viewer's read-only interceptor does not run, and with a role
    // check that passes: what is left is the operator list.
    const context = {
      ...contextFor(request, { ...VIEWER, repository: memory.repository }),
      requireRole: async () => session("viewer"),
    };
    const queue = await call(goLiveDraftsRouter.queue, {}, { context });
    expect(queue.canDecide).toBe(false);
    await expectCode(
      call(goLiveDraftsRouter.approve, approval(), { context }),
      "FORBIDDEN",
      403,
      "Owner (admin) access required"
    );
    await expectCode(
      call(goLiveDraftsRouter.reject, { id: "d-spy", note: "No" }, { context }),
      "FORBIDDEN",
      403,
      "Owner (admin) access required"
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });
});

const accountOf = (netLiquidation: number) => async () => ({
  ...ACCOUNT,
  netLiquidation,
});

const approvedRecord = (
  id: string,
  order: GoLiveDraftRecord["approvedOrder"]
) =>
  record(id, {
    approvedOrder: order,
    decidedAt: NOW,
    decidedBy: "owner",
    state: "approved",
  });

describe("goLiveDrafts sizing rules at the API", () => {
  it("counts the stored order of an approved draft after the account value fell", async () => {
    // Approved as 16 x 125 = 2,000 at NLV 100,000. At NLV 10,000 the trend sleeve holds 400.
    inject({ account: accountOf(10_000) });
    const memory = createMemoryRepository({
      drafts: [
        approvedRecord("d-spy", ORDER),
        record("d-qqq", { symbol: "QQQ" }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    const [spy, qqq] = (await client.goLiveDrafts.queue({})).drafts;
    // Today's size of the approved draft is 1 spread in a budget of 200. Its order is unchanged.
    expect(spy).toMatchObject({
      approvedOrder: ORDER,
      // The room it holds is the approved 2,000: 20% of the account value now.
      approvedRoom: { maxLoss: 2000, maxLossPctNlv: 20 },
      sizing: { budget: 200, maxLoss: 125, quantity: 1, reason: "sized" },
    });
    // The approved 2,000 fill the sleeve. Sized again at today's value the approved draft would
    // count 125, and QQQ would fit.
    expect(qqq).toMatchObject({
      approvedRoom: null,
      notApprovable: ["SIZED_TO_ZERO"],
      order: null,
      sizing: { quantity: 0, reason: "sleeve_budget_used" },
    });
    await expectCode(
      client.goLiveDrafts.approve(
        approval({
          id: "d-qqq",
          order: { ...ORDER, quantity: 1, symbol: "QQQ" },
        })
      ),
      "CONFLICT",
      409,
      "SIZED_TO_ZERO"
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });

  it("holds the position of an approved draft whose own size today is 0", async () => {
    // NLV 6,000: the budget of 120 is below one spread of 125. One position is allowed. The
    // sleeve and the open risk have room for everything, and QQQ fits its own name cap of 120.
    inject({ account: accountOf(6000) });
    const memory = createMemoryRepository({
      drafts: [
        approvedRecord("d-spy", ORDER),
        // 115 per spread: one fits the budget.
        record("d-qqq", {
          quote: liveQuote({ longAsk: 2.3, longBid: 2.2 }),
          symbol: "QQQ",
        }),
      ],
      plan: plan({
        limits: {
          maxPositions: 1,
          nameRiskCapPct: 2,
          openRiskCapPct: 100,
          positionRiskPct: 2,
        },
        sleeves: [sleeve("trend", ["SPY", "QQQ"], "callDebitVertical", 100)],
      }),
    });
    const [spy, qqq] = (
      await clientFor({ repository: memory.repository }).goLiveDrafts.queue({})
    ).drafts;
    expect(spy?.sizing).toMatchObject({
      quantity: 0,
      reason: "budget_below_one_spread",
    });
    expect(qqq).toMatchObject({
      order: null,
      sizing: { quantity: 0, reason: "max_positions_reached" },
    });
  });

  it("lists a draft whose budget buys more spreads than one order may hold, with quantity 0", async () => {
    // Long mid 0.025, short mid 0.01: limit 0.01, 1 per spread. 2% of 600,000 buys 12,000.
    inject({ account: accountOf(600_000) });
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy", {
          quote: liveQuote({
            longAsk: 0.03,
            longBid: 0.02,
            shortAsk: 0.01,
            shortBid: 0.01,
          }),
        }),
        record("d-qqq", { symbol: "QQQ" }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    // The queue answers: before, the output check failed the whole answer as a 500.
    const [spy, qqq] = (await client.goLiveDrafts.queue({})).drafts;
    expect(spy).toMatchObject({
      notApprovable: ["SIZED_TO_ZERO"],
      order: null,
      preCheck: { webFinalGate: null },
      sizing: {
        budget: 12_000,
        limitPrice: 0.01,
        maxLoss: null,
        maxLossPerSpread: 1,
        quantity: 0,
        reason: "quantity_above_order_limit",
      },
    });
    expect(qqq).toMatchObject({
      order: { ...ORDER, quantity: 96, symbol: "QQQ" },
      sizing: { maxLoss: 12_000, quantity: 96, reason: "sized" },
    });
    await expectCode(
      client.goLiveDrafts.approve(
        approval({ order: { ...ORDER, limitPrice: 0.01, quantity: 10_000 } })
      ),
      "CONFLICT",
      409,
      "SIZED_TO_ZERO"
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });

  it("gives no size to a quote with a bid of 0", async () => {
    // Long 0/5.00 and short 0/0.05 gave a limit of 2.47 before.
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy", {
          quote: liveQuote({
            longAsk: 5,
            longBid: 0,
            shortAsk: 0.05,
            shortBid: 0,
          }),
        }),
        record("d-qqq", { quote: liveQuote({ shortBid: 0 }), symbol: "QQQ" }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    for (const draft of (await client.goLiveDrafts.queue({})).drafts)
      expect(draft).toMatchObject({
        notApprovable: ["SIZED_TO_ZERO"],
        order: null,
        sizing: { limitPrice: null, quantity: 0, reason: "no_quote" },
      });
    await expectCode(
      client.goLiveDrafts.approve(
        approval({ order: { ...ORDER, limitPrice: 2.47, quantity: 8 } })
      ),
      "CONFLICT",
      409,
      "SIZED_TO_ZERO"
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });

  it("reports the room an approved draft holds next to today's size", async () => {
    // Approved as 6 x 147 = 882. Today's quote sizes 1 x 125 at NLV 10,000.
    const approvedOrder = { ...ORDER, limitPrice: 1.47, quantity: 6 };
    const memory = createMemoryRepository({
      drafts: [
        approvedRecord("d-spy", approvedOrder),
        record("d-qqq", { symbol: "QQQ" }),
      ],
      plan: plan({
        limits: {
          maxPositions: 4,
          nameRiskCapPct: 2,
          openRiskCapPct: 9,
          positionRiskPct: 2,
        },
        sleeves: [sleeve("trend", ["SPY", "QQQ"], "callDebitVertical", 100)],
      }),
    });
    const client = clientFor({ repository: memory.repository });
    inject({ account: accountOf(10_000) });
    const [spy, qqq] = (await client.goLiveDrafts.queue({})).drafts;
    expect(spy).toMatchObject({
      approvedOrder,
      approvedRoom: { maxLoss: 882, maxLossPctNlv: 8.82 },
      order: { ...ORDER, quantity: 1 },
      sizing: { maxLoss: 125, maxLossPctNlv: 1.25, quantity: 1 },
    });
    // The 882 are what blocks the next draft: 882 + 125 is above the open risk cap of 900.
    expect(qqq).toMatchObject({
      approvedRoom: null,
      sizing: { quantity: 0, reason: "open_risk_cap_reached" },
    });
    // Without an account value the amount is still shown, and its share is empty.
    inject({
      account: async () => ({
        asOf: null,
        netLiquidation: null,
        unavailableReason: "Portfolio monitor did not answer",
      }),
    });
    const [unsized] = (await client.goLiveDrafts.queue({})).drafts;
    expect(unsized).toMatchObject({
      approvedRoom: { maxLoss: 882, maxLossPctNlv: null },
      sizing: { maxLoss: null, quantity: 0, reason: "nlv_unavailable" },
    });
  });

  it("gives no size to a leg quoted wider than half of its mid", async () => {
    // Long 0.01/5.00 and short 0.01/0.05 gave limit 2.47 and a size before.
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy", {
          quote: liveQuote({
            longAsk: 5,
            longBid: 0.01,
            shortAsk: 0.05,
            shortBid: 0.01,
          }),
        }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    expect((await client.goLiveDrafts.queue({})).drafts[0]).toMatchObject({
      notApprovable: ["SIZED_TO_ZERO"],
      order: null,
      sizing: { limitPrice: null, quantity: 0, reason: "no_quote" },
    });
    await expectCode(
      client.goLiveDrafts.approve(
        approval({ order: { ...ORDER, limitPrice: 2.47, quantity: 8 } })
      ),
      "CONFLICT",
      409,
      "SIZED_TO_ZERO"
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
  });

  it("gives a late entry no position ahead of a draft that can be approved", async () => {
    const memory = createMemoryRepository({
      drafts: [
        // QQQ is sorted before SPY. The account does not hold it and it cannot be approved.
        record("d-qqq", {
          entryBasis: "model_holds_account_does_not",
          symbol: "QQQ",
        }),
        record("d-spy"),
      ],
      plan: plan({
        limits: {
          maxPositions: 1,
          nameRiskCapPct: 2,
          openRiskCapPct: 6,
          positionRiskPct: 2,
        },
      }),
    });
    const client = clientFor({ repository: memory.repository });
    const [qqq, spy] = (await client.goLiveDrafts.queue({})).drafts;
    expect(qqq).toMatchObject({
      notApprovable: ["LATE_ENTRY_NOT_TESTED"],
      sizing: SIZED,
    });
    expect(spy).toMatchObject({
      notApprovable: [],
      order: ORDER,
      sizing: SIZED,
    });
    await expect(
      client.goLiveDrafts.approve(approval())
    ).resolves.toMatchObject({ approvedOrder: ORDER, state: "approved" });
  });
});

describe("goLiveDrafts.collect, a later run of the trading day", () => {
  const keyClient = (repository: GoLiveDraftsRepositoryPort) =>
    clientFor({ apiKey: PLAINTEXT, repository });
  const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
  const delayed = (asOf: string, prices = {}) => ({
    ...liveQuote({ source: "yahoo_delayed_snapshot", ...prices }),
    asOf,
  });
  // The id the in-memory store gives the SPY candidate of the trend sleeve.
  const SPY_ID = `${TODAY}|trend|SPY`;

  it("replaces the quote, the facts and the entry basis of a draft without a decision", async () => {
    const memory = createMemoryRepository();
    const key = keyClient(memory.repository);
    await key.goLiveDrafts.collect(batch({ candidates: [candidate()] }));
    const later = candidate({
      entryBasis: "model_holds_account_does_not",
      quote: delayed(at(-5000), { longAsk: 2.6, longBid: 2.5 }),
      signalFacts: ["model holds since 2026-11-09"],
    });
    // Before, the first run of the day stayed all day: the answer was unchanged 1.
    expect(
      await key.goLiveDrafts.collect(batch({ candidates: [later] }))
    ).toEqual({ created: 0, expired: 0, unchanged: 0, updated: 1 });
    const [draft] = (
      await clientFor({ repository: memory.repository }).goLiveDrafts.queue({})
    ).drafts;
    expect(draft).toMatchObject({
      entryBasis: "model_holds_account_does_not",
      id: SPY_ID,
      quote: { asOf: new Date(at(-5000)), longAsk: 2.6, longBid: 2.5 },
      revision: 2,
      signalFacts: ["model holds since 2026-11-09"],
      state: "proposed",
      updatedAt: REFRESHED_AT,
    });
    // A draft first sent as signal_today is a late entry now, and is not approvable as one.
    expect(draft?.notApprovable).toContain("LATE_ENTRY_NOT_TESTED");
    // The same batch again writes nothing.
    expect(
      await key.goLiveDrafts.collect(batch({ candidates: [later] }))
    ).toEqual({ created: 0, expired: 0, unchanged: 1, updated: 0 });
  });

  it.each(["approved", "rejected"] as const)(
    "never changes a draft that is %s",
    async (state) => {
      const decided = record(SPY_ID, {
        approvedOrder: state === "approved" ? ORDER : null,
        decidedAt: NOW,
        decidedBy: "owner",
        state,
      });
      const memory = createMemoryRepository({ drafts: [decided] });
      expect(
        await keyClient(memory.repository).goLiveDrafts.collect(
          batch({
            candidates: [
              candidate({
                entryBasis: "model_holds_account_does_not",
                quote: delayed(at(-5000), { longAsk: 9 }),
                signalFacts: ["changed"],
              }),
            ],
          })
        )
      ).toEqual({ created: 0, expired: 0, unchanged: 1, updated: 0 });
      expect(memory.drafts.get(SPY_ID)).toEqual(decided);
    }
  );

  it("refuses an approval of a draft that a later run changed after it was read", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const client = clientFor({ repository: memory.repository });
    // The approval read the draft as signal_today. Before its write, a collect made it a late
    // entry.
    const refreshed = record("d-spy", {
      entryBasis: "model_holds_account_does_not",
      revision: 2,
      updatedAt: REFRESHED_AT,
    });
    memory.drafts.set("d-spy", refreshed);
    memory.repository.listDrafts.mockResolvedValueOnce([record("d-spy")]);
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "CONFLICT",
      409,
      "The draft changed after the queue was read (a later generator run); reload the queue"
    );
    expect(memory.repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 })
    );
    // Nothing was stored, and the draft as it is now cannot be approved.
    expect(memory.drafts.get("d-spy")).toEqual(refreshed);
    await expectCode(
      client.goLiveDrafts.approve(approval()),
      "CONFLICT",
      409,
      "LATE_ENTRY_NOT_TESTED"
    );
  });

  it("refuses an approval of a revision the owner did not read, and stores nothing", async () => {
    inject({ liveQuoteSource: true });
    const memory = createMemoryRepository();
    const key = keyClient(memory.repository);
    const owner = clientFor({ repository: memory.repository });
    const live = { ...liveQuote(), asOf: LIVE_AS_OF };
    await key.goLiveDrafts.collect(
      batch({ candidates: [candidate({ quote: live })] })
    );
    // 12:39: the owner reads the queue.
    expect((await owner.goLiveDrafts.queue({})).drafts[0]).toMatchObject({
      id: SPY_ID,
      notApprovable: [],
      order: ORDER,
      revision: 1,
      signalFacts: ["VIX 19.5 on 2026-11-11"],
    });
    // 12:40: a run replaces the facts. The quote is the same, and so is the order.
    expect(
      await key.goLiveDrafts.collect(
        batch({
          candidates: [
            candidate({ quote: live, signalFacts: ["VIX 23.0 on 2026-11-13"] }),
          ],
        })
      )
    ).toEqual({ created: 0, expired: 0, unchanged: 0, updated: 1 });
    expect((await owner.goLiveDrafts.queue({})).drafts[0]).toMatchObject({
      notApprovable: [],
      order: ORDER,
      revision: 2,
      signalFacts: ["VIX 23.0 on 2026-11-13"],
    });
    // 12:41: the owner approves what was read at 12:39: the same order, other facts.
    const changed =
      "The draft changed after the queue was read (a later generator run); reload the queue";
    await expectCode(
      owner.goLiveDrafts.approve(approval({ id: SPY_ID, revision: 1 })),
      "CONFLICT",
      409,
      changed
    );
    // A revision the draft does not have yet is no better.
    await expectCode(
      owner.goLiveDrafts.approve(approval({ id: SPY_ID, revision: 3 })),
      "CONFLICT",
      409,
      changed
    );
    expect(memory.repository.decide).not.toHaveBeenCalled();
    expect(memory.drafts.get(SPY_ID)).toMatchObject({
      approvedOrder: null,
      decidedBy: null,
      revision: 2,
      state: "proposed",
    });
    // After a reload the owner approves revision 2, and that is stored.
    await expect(
      owner.goLiveDrafts.approve(approval({ id: SPY_ID, revision: 2 }))
    ).resolves.toMatchObject({
      approvedOrder: ORDER,
      revision: 3,
      signalFacts: ["VIX 23.0 on 2026-11-13"],
      state: "approved",
    });
    expect(memory.repository.decide).toHaveBeenCalledTimes(1);
    expect(memory.repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 })
    );
  });

  it("names the cause first when the changed draft cannot be approved any more", async () => {
    // Read as revision 1; since then the draft was rejected in another session (revision 2).
    const memory = createMemoryRepository({
      drafts: [record("d-spy", { revision: 2, state: "rejected" })],
    });
    await expectCode(
      clientFor({ repository: memory.repository }).goLiveDrafts.approve(
        approval({ revision: 1 })
      ),
      "CONFLICT",
      409,
      "Draft cannot be approved: DRAFT_NOT_PROPOSED"
    );
  });

  it("needs the revision in an approval, and none in a rejection", async () => {
    const memory = createMemoryRepository({
      drafts: [
        record("d-spy", { revision: 5 }),
        record("d-qqq", { revision: 7, symbol: "QQQ" }),
      ],
    });
    const client = clientFor({ repository: memory.repository });
    const { revision: _revision, ...without } = approval();
    for (const bad of [
      without,
      { ...without, revision: 0 },
      { ...without, revision: 1.5 },
      { ...without, revision: "5" },
      { ...without, revision: null },
    ])
      await expectCode(
        client.goLiveDrafts.approve(bad as GoLiveDraftApproveInput),
        "BAD_REQUEST",
        400
      );
    expect(memory.repository.decide).not.toHaveBeenCalled();
    // A rejection of a draft that changed is harmless: it does not depend on what the draft
    // holds, so it names no revision.
    await expect(
      client.goLiveDrafts.reject({ id: "d-qqq", note: "No" })
    ).resolves.toMatchObject({ revision: 8, state: "rejected" });
    await expect(
      client.goLiveDrafts.approve(approval({ revision: 5 }))
    ).resolves.toMatchObject({ revision: 6, state: "approved" });
  });

  it("refuses a quote dated more than 60 s after the server clock, and stores nothing", async () => {
    const stored = record("d-earlier", { symbol: "QQQ" });
    const memory = createMemoryRepository({ drafts: [stored] });
    const key = keyClient(memory.repository);
    for (const ahead of [60_001, 3_600_000, 86_400_000])
      await expectCode(
        key.goLiveDrafts.collect(
          batch({
            candidates: [
              candidate(),
              candidate({ quote: delayed(at(ahead)), symbol: "QQQ" }),
            ],
          })
        ),
        "VALIDATION_ERROR",
        422,
        "The quote of QQQ is dated more than 60 s after the server clock"
      );
    expect(memory.repository.planInForce).not.toHaveBeenCalled();
    expect(memory.repository.collect).not.toHaveBeenCalled();
    expect([...memory.drafts.values()]).toEqual([stored]);
    // Exactly 60 s ahead is the allowed clock difference, as in the approval rule.
    await expect(
      key.goLiveDrafts.collect(
        batch({ candidates: [candidate({ quote: delayed(at(60_000)) })] })
      )
    ).resolves.toMatchObject({ created: 1 });
  });

  it("refuses a time that is not ISO-8601 text with an offset", async () => {
    const memory = createMemoryRepository();
    const key = keyClient(memory.repository);
    // null and true were read as 1970 before.
    for (const bad of [null, true, 0, "2026-11-13T21:29:30", "2026-11-13"]) {
      const asOf = bad as unknown as string;
      await expectCode(
        key.goLiveDrafts.collect(
          batch({ candidates: [candidate({ quote: delayed(asOf) })] })
        ),
        "BAD_REQUEST",
        400
      );
      await expectCode(
        key.goLiveDrafts.collect(batch({ generatedAt: asOf })),
        "BAD_REQUEST",
        400
      );
    }
    expect(memory.repository.collect).not.toHaveBeenCalled();
    expect(memory.drafts.size).toBe(0);
  });

  it("keeps a trading day at or below the most drafts the queue lists", async () => {
    const drafts = Array.from({ length: 199 }, (_unused, index) =>
      record(`d-${index}`, { state: "expired" })
    );
    const memory = createMemoryRepository({ drafts });
    const key = keyClient(memory.repository);
    // 199 stored and 2 new: 201.
    await expectCode(
      key.goLiveDrafts.collect(batch()),
      "VALIDATION_ERROR",
      422,
      "The batch would take the trading day above 200 drafts; nothing was stored"
    );
    expect(memory.repository.collect).toHaveBeenCalledWith(
      expect.objectContaining({ maxDrafts: 200 })
    );
    expect(memory.drafts.size).toBe(199);
    // 199 stored and 1 new: 200, and the queue lists every one of them.
    await expect(
      key.goLiveDrafts.collect(batch({ candidates: [candidate()] }))
    ).resolves.toMatchObject({ created: 1 });
    const queue = await clientFor({
      repository: memory.repository,
    }).goLiveDrafts.queue({});
    expect(queue.drafts).toHaveLength(200);
  });

  it("refuses to list a part of a trading day that holds more than the limit", async () => {
    // collect prevents this, so it can only follow a manual change of the table.
    const drafts = Array.from({ length: 201 }, (_unused, index) =>
      record(`d-${index}`, { state: "expired" })
    );
    await expectCode(
      clientFor({
        repository: createMemoryRepository({ drafts }).repository,
      }).goLiveDrafts.queue({}),
      "STORAGE_ERROR",
      503,
      "The trading day holds 201 stored drafts, more than the 200 the queue lists"
    );
  });
});

describe("goLiveDrafts.reject note", () => {
  it("refuses a note of blanks alone and stores a note without the blanks around it", async () => {
    const memory = createMemoryRepository({ drafts: [record("d-spy")] });
    const client = clientFor({ repository: memory.repository });
    for (const note of [" ", " \t\n "])
      await expectCode(
        client.goLiveDrafts.reject({ id: "d-spy", note }),
        "BAD_REQUEST",
        400
      );
    expect(memory.repository.decide).not.toHaveBeenCalled();
    expect(memory.drafts.get("d-spy")?.state).toBe("proposed");
    await expect(
      client.goLiveDrafts.reject({ id: "d-spy", note: "  Too close \n" })
    ).resolves.toMatchObject({ decisionNote: "Too close", state: "rejected" });
  });
});

describe("go-live draft queue import boundary", () => {
  // The service, its sizing rules and the store it writes through.
  const FILES = [
    "./server/golive-drafts.ts",
    "./server/golive-drafts-sizing.ts",
    "../../db/src/server/golive-drafts.ts",
  ];
  const sourceOf = (file: string): string =>
    readFileSync(new URL(file, import.meta.url), "utf8");
  const importsOf = (file: string): string[] => {
    const source = sourceOf(file);
    return [
      ...source.matchAll(
        /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/gu
      ),
    ].map((match) => match[1] ?? "");
  };
  const isForbidden = (specifier: string): boolean =>
    /gateway|confirm/iu.test(specifier) ||
    (/vertex-orders/iu.test(specifier) &&
      !/(?:^|\/)contracts\/vertex-orders(?:\.ts)?$/u.test(specifier));

  it("imports no order route, gateway or confirm module", () => {
    for (const file of FILES) {
      const imports = importsOf(file);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter(isForbidden)).toEqual([]);
    }
    // The rule itself: what it refuses and the one exception it allows.
    expect(
      [
        "./vertex-orders.ts",
        "./vertex-orders-rules.ts",
        "./vertex-orders-gateway.ts",
        "./vertex-orders-confirm.ts",
        "./vertex-runtime-gateway.ts",
        "../contracts/vertex-orders-extra.ts",
      ].filter((specifier) => !isForbidden(specifier))
    ).toEqual([]);
    expect(isForbidden("../contracts/vertex-orders.ts")).toBe(false);
    expect(isForbidden("./final-order-gate.ts")).toBe(false);
  });

  // An import the list above cannot read: import(...) with any argument, and a module name
  // written as a template literal.
  const hiddenImports = (source: string): string[] =>
    source.match(
      /\bimport\s*\(|(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*`/gu
    ) ?? [];

  it("has no dynamic import and no module name in a template literal", () => {
    for (const file of FILES) expect(hiddenImports(sourceOf(file))).toEqual([]);
    // The rule itself.
    for (const bad of [
      'await import("./vertex-orders.ts")',
      "await import(name)",
      "await import (name)",
      "import(`./vertex-${name}.ts`)",
      "require(`./vertex-orders-gateway.ts`)",
      "export * from `./vertex-orders.ts`;",
    ])
      expect(hiddenImports(bad)).not.toEqual([]);
    for (const fine of [
      'import { call } from "@orpc/server";',
      'import type { ApiContext } from "./context.ts";',
      "// this module imports no order gateway (a test reads it)",
      "const reimport = (value: number) => value;\nreimport(1);",
    ])
      expect(hiddenImports(fine)).toEqual([]);
  });

  // Names of the order path: the order procedures on the context, a gateway, a bridge and the
  // confirm token of a send. Comments count too.
  const orderPathNames = (source: string): string[] =>
    source.match(/vertexOrders|orderGateway|orderBridge|confirmToken/giu) ?? [];

  it("names nothing of the order path", () => {
    for (const file of FILES)
      expect(orderPathNames(sourceOf(file))).toEqual([]);
    // The rule itself.
    for (const bad of [
      "await context.vertexOrders.comboSubmit(order)",
      "const { vertexOrders } = context;",
      'context["vertexOrders"]',
      "await orderGateway.place(order)",
      "callOrderBridge(order)",
      "input.confirmToken",
    ])
      expect(orderPathNames(bad)).not.toEqual([]);
    expect(orderPathNames("evaluateFinalOrderGate(order)")).toEqual([]);
  });

  // Every reference to the router outside its import line.
  const routerUses = (source: string): string[] =>
    source
      .replace(
        /^import \{ nautilusArmRouter \} from "\.\/nautilus-arm\.ts";$/mu,
        ""
      )
      .match(/nautilusArmRouter(?:\s*\.\s*\w+)?/gu) ?? [];
  const onlyStatus = (source: string): boolean =>
    routerUses(source).every((use) => use === "nautilusArmRouter.status");

  it("uses only the status procedure of the Nautilus arm router", () => {
    const source = readFileSync(
      new URL("./server/golive-drafts.ts", import.meta.url),
      "utf8"
    );
    expect(routerUses(source)).toEqual(["nautilusArmRouter.status"]);
    // The rule itself: arm, disarm and any pass-through of the router fail.
    expect(onlyStatus("call(nautilusArmRouter.status, {}, { context })")).toBe(
      true
    );
    for (const bad of [
      "call(nautilusArmRouter.arm, input, { context })",
      "call(nautilusArmRouter.disarm, {}, { context })",
      "nautilusArmRouter\n  .arm",
      'nautilusArmRouter["arm"]',
      "const router = nautilusArmRouter;",
      "const { arm } = nautilusArmRouter;",
      "run(nautilusArmRouter)",
      'import { nautilusArmRouter as router } from "./nautilus-arm.ts";',
    ])
      expect(onlyStatus(bad)).toBe(false);
  });
});
