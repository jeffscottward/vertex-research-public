import { readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  GoLiveDraftConflictError,
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
        let created = 0;
        for (const candidate of run.candidates) {
          const id = `${run.tradingDay}|${candidate.sleeveKey}|${candidate.symbol}`;
          if (drafts.has(id)) continue;
          created += 1;
          drafts.set(
            id,
            record(id, {
              ...candidate,
              quote:
                candidate.quote === null
                  ? null
                  : {
                      ...candidate.quote,
                      asOf: candidate.quote.asOf.toISOString(),
                    },
              signalFacts: [...candidate.signalFacts],
              tradingDay: run.tradingDay,
            })
          );
        }
        runs.set(run.tradingDay, run.generatedAt);
        return {
          created,
          expired: 0,
          unchanged: run.candidates.length - created,
        };
      }
    ),
    decide: vi.fn(
      async (input: Parameters<GoLiveDraftsRepositoryPort["decide"]>[0]) => {
        const draft = drafts.get(input.id);
        if (draft === undefined) throw new GoLiveDraftNotFoundError(input.id);
        if (draft.state !== "proposed")
          throw new GoLiveDraftConflictError(input.id);
        const decided: GoLiveDraftRecord = {
          ...draft,
          decidedAt: NOW,
          decidedBy: input.decidedBy,
          decisionNote: input.note,
          nodeBadgeAtDecision: input.nodeBadge,
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

const candidate = (
  overrides: Partial<GoLiveCollectInput["candidates"][number]> = {}
): GoLiveCollectInput["candidates"][number] => ({
  entryBasis: "signal_today",
  expiry: EXPIRY,
  longStrike: 100,
  quote: { ...liveQuote(), asOf: LIVE_AS_OF },
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
      [
        { structure: "putDebitVertical" },
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
});

const approval = (
  overrides: Partial<GoLiveDraftApproveInput> = {}
): GoLiveDraftApproveInput => ({
  confirm: true,
  id: "d-spy",
  order: ORDER,
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
      decidedBy: "owner",
      decision: "approved",
      id: "d-spy",
      nodeBadge: "running-disarmed",
      note: "As shown",
    });
    expect(memory.repository.collect).not.toHaveBeenCalled();
    expect(approved).toMatchObject({
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
      { draft: { state: "approved" }, reasons: "DRAFT_NOT_PROPOSED" },
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
    expect(memory.drafts.get("d-spy")?.state).toBe("proposed");
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
    expect(rejected).toMatchObject({
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

describe("go-live draft queue import boundary", () => {
  const importsOf = (file: string): string[] => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
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
    for (const file of [
      "./server/golive-drafts.ts",
      "./server/golive-drafts-sizing.ts",
    ]) {
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
