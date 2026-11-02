import type { SafeAuthSession } from "@darkfactory/auth/server";
import {
  type DeploymentRequestRow,
  type DeploymentRequestsRepository,
  InvalidRepositoryInputError,
  type MarketBarsRepository,
  type Repositories,
} from "@darkfactory/db/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { AcademyDeployRequestInputSchema } from "./contracts/academy.ts";
import { setAcademyPortfolioFetchForTesting } from "./server/academy.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-10-28T12:00:00.000Z");
const NOW_S = Math.floor(Date.now() / 1000);

const session = (): SafeAuthSession => ({
  user: {
    id: "owner",
    name: "owner",
    email: "operator@domain.test",
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: "s1",
    userId: "owner",
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "owner", role: "member", status: "active" },
});

// 300 business days of a gently rising SPY-like series.
const bars = (() => {
  const t = new Float64Array(300);
  const c = new Float64Array(300);
  for (let index = 0; index < 300; index += 1) {
    t[index] = Date.UTC(2024, 0, 2) + index * 86_400_000;
    c[index] = 500 * (1 + 0.0004) ** index * (1 + 0.004 * Math.sin(index / 4));
  }
  return { t, o: c, h: c, l: c, c };
})();

// VIX at 18 on every bar date: SPY backtests then use it as implied volatility.
const vixBars = {
  t: bars.t,
  o: bars.c.map(() => 18),
  h: bars.c.map(() => 18),
  l: bars.c.map(() => 18),
  c: bars.c.map(() => 18),
};

const marketBars = (): MarketBarsRepository =>
  ({
    listSeries: vi.fn(async () => [
      {
        id: "spy",
        symbol: "SPY",
        timeframe: "1d",
        source: "test",
        sourceSha256: "0".repeat(64),
        barCount: 300,
        firstT: bars.t[0],
        lastT: bars.t[299],
        importedAt: at,
      },
    ]),
    getSeries: vi.fn(async (symbol: string) =>
      symbol === "SPY" || symbol === "^VIX"
        ? {
            id: symbol === "SPY" ? "spy" : "vix",
            symbol,
            timeframe: "1d",
            source: "test fixture",
            sourceSha256: "0".repeat(64),
            barCount: 300,
            firstT: 0,
            lastT: 0,
            importedAt: at,
          }
        : null
    ),
    loadColumns: vi.fn(async (id: string) => (id === "vix" ? vixBars : bars)),
    replaceSeries: vi.fn(),
  }) as unknown as MarketBarsRepository;

const row = (
  overrides: Partial<DeploymentRequestRow>
): DeploymentRequestRow => ({
  id: "dr-1",
  strategyId: "st-1",
  presetId: null,
  params: {},
  symbol: "SPY",
  timeframe: "1d",
  mode: "paper",
  limits: {
    maxOrderSize: 1,
    maxPosition: 1,
    maxOrdersPerMinute: 4,
    dailyLossLimit: 1,
  },
  status: "draft",
  requestedBy: "owner",
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: at,
  updatedAt: at,
  strategySlug: "dyr-x",
  strategyName: "x",
  presetName: null,
  ...overrides,
});

const stores = () => {
  const created: DeploymentRequestRow[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const deploymentRequests = {
    list: vi.fn(async (filters: { status?: string } = {}) =>
      created.filter(
        (entry) =>
          filters.status === undefined || entry.status === filters.status
      )
    ),
    create: vi.fn(
      async (input: {
        strategyId: string;
        symbol: string;
        params: Record<string, unknown>;
      }) => {
        const next = row({
          id: `dr-${created.length + 1}`,
          strategyId: input.strategyId,
          strategySlug: "dyr-lesson",
          symbol: input.symbol,
          params: input.params as DeploymentRequestRow["params"],
        });
        created.push(next);
        return next;
      }
    ),
    transition: vi.fn(
      async (input: { id: string; action: string; note?: string | null }) => {
        // Same rule as the repository: only approve/reject take a note.
        if (
          input.note !== undefined &&
          input.note !== null &&
          input.action !== "approve" &&
          input.action !== "reject"
        )
          throw new InvalidRepositoryInputError(
            "note applies only when approving or rejecting"
          );
        const found = created.find((entry) => entry.id === input.id);
        if (found === undefined) return null;
        const next = {
          ...found,
          status: input.action === "submit" ? "requested" : "withdrawn",
        } as DeploymentRequestRow;
        created.splice(created.indexOf(found), 1, next);
        return next;
      }
    ),
  } as unknown as DeploymentRequestsRepository;
  const strategyLibrary = {
    get: vi.fn(async (id: string) =>
      id === "st-dyr"
        ? { strategy: { id, slug: "dyr-itm-debit-call-spread" }, presets: [] }
        : null
    ),
    list: vi.fn(async () => []),
    create: vi.fn(async (input: { slug: string }) => ({
      id: "st-1",
      slug: input.slug,
    })),
  } as unknown as Repositories["strategyLibrary"];
  const academyAudit = {
    countSince: vi.fn(
      async (input: { actorUserId: string; action: string }) =>
        audits.filter((entry) => entry.action === input.action).length
    ),
    record: vi.fn(
      async (input: { action: string; metadata: Record<string, unknown> }) => {
        audits.push(input);
        return { id: `audit-${audits.length}` };
      }
    ),
  };
  return { created, audits, deploymentRequests, strategyLibrary, academyAudit };
};

type FeedOptions = Readonly<{
  connected?: boolean;
  ageSeconds?: number;
  positions?: unknown[];
}>;

const portfolio = (nlv: number | null, feed: FeedOptions = {}) =>
  setAcademyPortfolioFetchForTesting({
    fetch: async () =>
      nlv === null
        ? new Response("down", { status: 503 })
        : new Response(
            JSON.stringify({
              schema: "vertex-portfolio-snapshot-v1",
              source: "ibkr-gateway",
              clientId: 78,
              version: "1.0.0",
              generatedAt: NOW_S - (feed.ageSeconds ?? 0),
              state: "live",
              connected: feed.connected ?? true,
              lastError: null,
              accountMode: "live",
              accountCount: 1,
              dataAsOf: NOW_S - (feed.ageSeconds ?? 1),
              ordersAsOf: NOW_S - 1,
              summary: { NetLiquidation: nlv },
              pnl: {},
              positions: feed.positions ?? [],
              orders: [],
              completed: [],
              executions: [],
              errors: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          ),
  });

const clientFor = (
  store: ReturnType<typeof stores>,
  options: Readonly<{ password?: string; apiKey?: boolean }> = {}
) => {
  const verify = vi.fn(
    async (_headers: Headers, password: string) => password === options.password
  );
  const client = createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKey === true)
        request.headers.set("x-api-key", `vrk_${"C".repeat(64)}`);
      return handleApiRequest(
        request,
        createApiContext(request, {
          repositories: {
            profiles: {} as Repositories["profiles"],
            addresses: {} as Repositories["addresses"],
            userPreferences: {} as Repositories["userPreferences"],
            featureItems: {} as Repositories["featureItems"],
            adminUsers: {} as Repositories["adminUsers"],
            dashboard: {} as Repositories["dashboard"],
            marketBars: marketBars(),
            deploymentRequests: store.deploymentRequests,
            strategyLibrary: store.strategyLibrary,
            academyAudit: store.academyAudit,
          } as Repositories,
          requestId: "request-1",
          capabilities: {
            ai: false,
            emailDelivery: false,
            analytics: false,
            telemetryExport: false,
          },
          requireSession: async () => session(),
          requireRole: async () => session(),
          operatorEmails: ["operator@domain.test"],
          portfolioMonitor: { url: "http://portfolio.test", token: "t" },
          verifyPassword: verify,
        })
      );
    },
  });
  return { client, verify };
};

// long_call-style lesson with defined risk: the deep ITM call lesson (structure deep_itm_call).
const PASSING = {
  slug: "deep-itm-call-stock-replacement",
  ticker: "SPY",
  allocationPct: 5,
  riskPerTradePct: 20,
  tranches: 2,
} as const;

afterEach(() => setAcademyPortfolioFetchForTesting({}));

describe("academy.deployRequest", () => {
  it("creates and submits a paper request when every gate passes, with one audit row", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store);
    const result = await client.academy.deployRequest(PASSING);
    expect(result.gate.verdict).toBe("pass");
    expect(result.gate.nlvSource).toBe("portfolio-monitor");
    expect(result.request).toMatchObject({
      status: "requested",
      mode: "paper",
      executionAuthorized: false,
      brokerSubmissionAllowed: false,
    });
    expect(result.override.used).toBe(false);
    expect(store.audits.map((entry) => entry.action)).toEqual([
      "academy.deploy.request",
    ]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("ignores a forged stated NLV: without the live feed the request is blocked by nlv-known", async () => {
    portfolio(null);
    const store = stores();
    const { client } = clientFor(store);
    await expect(
      client.academy.deployRequest({ ...PASSING, statedNlv: 1e9 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      statedNlv: 1e9,
    });
    expect(preview.conflicts).toContain("nlv-known");
    expect(preview.nlv).toBeNull();
    expect(store.created).toHaveLength(0);
  });

  it("refuses client-supplied hit-rate evidence (strict input)", () => {
    expect(
      AcademyDeployRequestInputSchema.safeParse({
        ...PASSING,
        evidence: { trades: 1000, wins: 999 },
      }).success
    ).toBe(false);
  });

  it("blocks a rule conflict without an override and creates nothing", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client } = clientFor(store);
    await expect(
      client.academy.deployRequest({
        ...PASSING,
        slug: "itm-covered-call-otm-put",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.created).toHaveLength(0);
  });

  it("refuses an override whose explanation does not name each rule, before checking the password", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    await expect(
      client.academy.deployRequest({
        ...PASSING,
        slug: "itm-covered-call-otm-put",
        override: {
          password: "right",
          acknowledged: [...preview.conflicts],
          explanation: "I accept this for a small paper test of the structure.",
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(verify).not.toHaveBeenCalled();
    expect(store.created).toHaveLength(0);
  });

  it("refuses a wrong password", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    const explanation = `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure the structure.`;
    await expect(
      client.academy.deployRequest({
        ...PASSING,
        slug: "itm-covered-call-otm-put",
        override: {
          password: "wrong",
          acknowledged: [...preview.conflicts],
          explanation,
        },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.created).toHaveLength(0);
  });

  it("creates the request with a verified password and audits the broken rules without the password", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    expect(preview.conflicts).toContain("options-only");
    const explanation = `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure the structure.`;
    const result = await client.academy.deployRequest({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
      override: {
        password: "right",
        acknowledged: [...preview.conflicts],
        explanation,
      },
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.override).toMatchObject({
      used: true,
      rules: preview.conflicts,
    });
    expect(result.request.status).toBe("requested");
    const override = store.audits.find(
      (entry) => entry.action === "academy.deploy.override"
    );
    expect(override?.metadata).toMatchObject({
      brokenRules: preview.conflicts,
      explanation,
      stepUp: "password-verified",
    });
    expect(JSON.stringify(store.audits)).not.toContain('right"');
  });

  it("locks the override after 5 failed passwords and audits each failure", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    const override = (password: string) => ({
      password,
      acknowledged: [...preview.conflicts],
      explanation: `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure the structure.`,
    });
    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(
        client.academy.deployRequest({
          ...PASSING,
          slug: "itm-covered-call-otm-put",
          override: override("wrong"),
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      store.audits.filter(
        (entry) => entry.action === "academy.deploy.password-failed"
      )
    ).toHaveLength(5);
    await expect(
      client.academy.deployRequest({
        ...PASSING,
        slug: "itm-covered-call-otm-put",
        override: override("right"),
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Too many failed password attempts"),
    });
    expect(verify).toHaveBeenCalledTimes(5);
    expect(store.created).toHaveLength(0);
  });

  it("maps a password-check outage to STORAGE_ERROR without counting it as a failure", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    const override = {
      password: "right",
      acknowledged: [...preview.conflicts],
      explanation: `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure the structure.`,
    };
    verify.mockImplementation(async () => {
      throw new Error("auth database down");
    });
    for (let attempt = 0; attempt < 6; attempt += 1)
      await expect(
        client.academy.deployRequest({
          ...PASSING,
          slug: "itm-covered-call-otm-put",
          override,
        })
      ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(
      store.audits.filter(
        (entry) => entry.action === "academy.deploy.password-failed"
      )
    ).toHaveLength(0);
    verify.mockImplementation(
      async (_headers, password) => password === "right"
    );
    const result = await client.academy.deployRequest({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
      override,
    });
    expect(result.override.used).toBe(true);
  });

  it("checks at most 5 passwords from a parallel burst", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview({
      ...PASSING,
      slug: "itm-covered-call-otm-put",
    });
    verify.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return false;
    });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        client.academy.deployRequest({
          ...PASSING,
          slug: "itm-covered-call-otm-put",
          override: {
            password: "wrong",
            acknowledged: [...preview.conflicts],
            explanation: `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure the structure.`,
          },
        })
      )
    );
    expect(results.every((entry) => entry.status === "rejected")).toBe(true);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("refuses Academy strategies on the generic deployment-request path", async () => {
    const store = stores();
    const { client } = clientFor(store);
    await expect(
      client.deploymentRequests.create({
        strategyId: "st-dyr",
        symbol: "SPY",
        timeframe: "1d",
        limits: {
          maxOrderSize: 1,
          maxPosition: 1,
          maxOrdersPerMinute: 1,
          dailyLossLimit: 1,
        },
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Academy lesson page"),
    });
    expect(store.created).toHaveLength(0);
  });

  it("refuses editing or submitting an Academy request on the generic path", async () => {
    const store = stores();
    (
      store.deploymentRequests as unknown as {
        get: (id: string) => Promise<DeploymentRequestRow>;
      }
    ).get = async (id) =>
      row({ id, strategySlug: "dyr-itm-debit-call-spread" });
    const { client } = clientFor(store);
    await expect(
      client.deploymentRequests.update({ id: "dr-1", symbol: "QQQ" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client.deploymentRequests.submit({ id: "dr-1" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses agent API keys", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client } = clientFor(store, { apiKey: true });
    await expect(client.academy.deployRequest(PASSING)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("academy gate inputs from the live feed", () => {
  it("treats a disconnected, stale or future-dated feed as unknown NLV", async () => {
    for (const feed of [
      { connected: false },
      { ageSeconds: 3600 },
      { ageSeconds: -3600 },
    ]) {
      portfolio(1_000_000, feed);
      const { client } = clientFor(stores());
      const preview = await client.academy.deployPreview(PASSING);
      expect(preview.nlvSource).toBe("unavailable");
      expect(preview.conflicts).toContain("nlv-known");
    }
  });

  it("adds long option premium already open in the ticker to the per-name cap", async () => {
    portfolio(100_000, {
      positions: [
        {
          conId: 1,
          symbol: "SPY",
          secType: "OPT",
          currency: "USD",
          right: "C",
          strike: 500,
          expiry: "20270115",
          multiplier: "100",
          localSymbol: "SPY C",
          position: 2,
          avgCost: 900,
          acctMarketPrice: 10,
          acctMarketValue: 1900,
          acctUnrealized: 100,
          realized: 0,
          pnlValue: null,
          dailyPnl: null,
          pnlUnrealized: null,
          pnlT: null,
        },
      ],
    });
    const { client } = clientFor(stores());
    const preview = await client.academy.deployPreview({
      ...PASSING,
      allocationPct: 1,
      riskPerTradePct: 100,
    });
    expect(preview.openPremiumInNameUsd).toBeGreaterThan(0);
    expect(preview.conflicts).toContain("premium-cap");
  });

  it("withdraws the draft and reports storage failure when the audit write fails", async () => {
    portfolio(1_000_000);
    const store = stores();
    store.academyAudit.record.mockImplementationOnce(async () => {
      throw new Error("audit down");
    });
    const { client } = clientFor(store);
    await expect(client.academy.deployRequest(PASSING)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    expect(store.created.map((entry) => entry.status)).toEqual(["withdrawn"]);
  });

  it("asks for a stated NLV before the password when the feed is down", async () => {
    portfolio(null);
    const store = stores();
    const { client, verify } = clientFor(store, { password: "right" });
    const preview = await client.academy.deployPreview(PASSING);
    const override = {
      password: "right",
      acknowledged: [...preview.conflicts],
      explanation: `Paper test only: I break ${preview.conflicts.join(" and ")} knowingly.`,
    };
    await expect(
      client.academy.deployRequest({ ...PASSING, override })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("state your NLV"),
    });
    expect(verify).not.toHaveBeenCalled();
    const created = await client.academy.deployRequest({
      ...PASSING,
      statedNlv: 200_000,
      override,
    });
    expect(created.override.used).toBe(true);
    expect(created.gate.statedNlv).toBe(200_000);
  });
});

describe("academy allocation total counts every open Academy request", () => {
  it("refuses a second identical request while the first is still open", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client } = clientFor(store);
    const input = { ...PASSING, allocationPct: 60, riskPerTradePct: 1 };
    await client.academy.deployRequest(input);
    const preview = await client.academy.deployPreview(input);
    expect(preview.otherAllocationsPct).toBe(60);
    expect(preview.conflicts).toContain("allocation-total");
    await expect(client.academy.deployRequest(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(store.created).toHaveLength(1);
  });

  it("refuses a duplicate open request for the same lesson and ticker even within the allocation cap", async () => {
    portfolio(1_000_000);
    const store = stores();
    const { client } = clientFor(store);
    store.created.push(
      row({
        id: "dr-open",
        status: "requested",
        strategySlug: `dyr-${PASSING.slug}`,
        params: { allocationPct: 5 },
      })
    );
    await expect(client.academy.deployRequest(PASSING)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already open"),
    });
    expect(store.created).toHaveLength(1);
  });

  it("queries each open status at the maximum limit and fails closed when a page is full", async () => {
    portfolio(1_000_000);
    const store = stores();
    for (let index = 0; index < 200; index += 1)
      store.created.push(
        row({
          id: `dr-old-${index}`,
          status: "approved",
          strategySlug: index === 199 ? "dyr-old" : "other-strategy",
          params: { allocationPct: index === 199 ? 90 : 1 },
        })
      );
    const { client } = clientFor(store);
    await expect(client.academy.deployPreview(PASSING)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("cannot be verified"),
    });
    expect(store.deploymentRequests.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", limit: 200 })
    );
  });

  it("ignores closed and non-Academy rows and non-numeric allocations", async () => {
    portfolio(1_000_000);
    const store = stores();
    store.created.push(
      row({
        id: "a",
        status: "withdrawn",
        strategySlug: "dyr-a",
        params: { allocationPct: 50 },
      }),
      row({
        id: "b",
        status: "requested",
        strategySlug: "other",
        params: { allocationPct: 50 },
      }),
      row({
        id: "c",
        status: "draft",
        strategySlug: "dyr-c",
        params: { allocationPct: "x" },
      }),
      row({
        id: "d",
        status: "approved",
        strategySlug: "dyr-d",
        params: { allocationPct: 7 },
      })
    );
    const { client } = clientFor(store);
    const preview = await client.academy.deployPreview(PASSING);
    expect(preview.otherAllocationsPct).toBe(7);
  });
});

describe("academy unit sizing (one real unit within the budget)", () => {
  it("blocks a deep ITM call on a $500+ ticker at NLV $100k: one unit risks far more than the budget", async () => {
    portfolio(100_000);
    const store = stores();
    const { client } = clientFor(store);
    const input = {
      ...PASSING,
      slug: "stock-replacement-three-ways",
      allocationPct: 5,
      riskPerTradePct: 20,
    };
    const preview = await client.academy.deployPreview(input);
    expect(preview.conflicts).toContain("unit-fits-budget");
    expect(preview.unitLossUsd).toBeGreaterThan(
      preview.premiumPerPositionUsd * 4
    );
    await expect(client.academy.deployRequest(input)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("unit-fits-budget"),
    });
    expect(store.created).toHaveLength(0);
  });

  it("reports an unpriced unit as a conflict when the ticker has no stored bars", async () => {
    portfolio(1_000_000);
    const { client } = clientFor(stores());
    const preview = await client.academy.deployPreview({
      ...PASSING,
      ticker: "QQQ",
    });
    expect(preview.unitLossUsd).toBeNull();
    expect(preview.conflicts).toContain("unit-fits-budget");
  });

  it("sizes an overridden unit at exactly one contract", async () => {
    portfolio(100_000);
    const store = stores();
    const { client } = clientFor(store, { password: "right" });
    const input = {
      ...PASSING,
      slug: "stock-replacement-three-ways",
    };
    const preview = await client.academy.deployPreview(input);
    const result = await client.academy.deployRequest({
      ...input,
      override: {
        password: "right",
        acknowledged: [...preview.conflicts],
        explanation: `Paper test only. I break ${preview.conflicts.join(" and ")} on purpose to measure one unit.`,
      },
    });
    expect(result.override.rules).toContain("unit-fits-budget");
    expect(store.deploymentRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ maxPosition: 1, maxOrderSize: 1 }),
      })
    );
  });
});

describe("academy.backtest", () => {
  it("lists stored daily series and uses VIX as SPY implied volatility", async () => {
    const { client } = clientFor(stores());
    await expect(client.academy.tickers()).resolves.toMatchObject({
      tickers: [{ ticker: "SPY", bars: 300 }],
    });
    const result = await client.academy.backtest({
      slug: "itm-debit-call-spread",
      ticker: "SPY",
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(result.ivSource).toBe("supplied");
  });

  it("refuses concept lessons, reversed dates and tickers without bars", async () => {
    const { client } = clientFor(stores());
    await expect(
      client.academy.backtest({
        slug: "iv-vs-rv-beats-iv-rank",
        ticker: "SPY",
        start: "2024-01-01",
        end: "2024-12-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.academy.backtest({
        slug: "itm-debit-call-spread",
        ticker: "SPY",
        start: "2024-12-31",
        end: "2024-01-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.academy.backtest({
        slug: "itm-debit-call-spread",
        ticker: "QQQ",
        start: "2024-01-01",
        end: "2024-12-31",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.academy.backtest({
        slug: "itm-debit-call-spread",
        ticker: "SPY",
        start: "2030-01-01",
        end: "2030-12-31",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns a modeled backtest over stored bars", async () => {
    const { client } = clientFor(stores());
    const result = await client.academy.backtest({
      slug: "itm-debit-call-spread",
      ticker: "SPY",
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(result.modeled).toBe(true);
    expect(result.structure).toBe("call_debit_spread");
    expect(result.equity.length).toBeGreaterThan(100);
    expect(result.assumptions.join(" ")).toMatch(/modeled/iu);
  });

  it("refuses concept lessons and unknown rules", async () => {
    const { client } = clientFor(stores());
    await expect(
      client.academy.backtest({
        slug: "itm-debit-call-spread",
        ticker: "SPY",
        start: "2024-01-01",
        end: "2024-12-31",
        rules: { bogus: 1 },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.academy.backtest({
        slug: "no-such-lesson",
        ticker: "SPY",
        start: "2024-01-01",
        end: "2024-12-31",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
