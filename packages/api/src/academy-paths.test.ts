import type * as AcademyModule from "@darkfactory/academy";
import type { SafeAuthSession } from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type DeploymentRequestRow,
  DeploymentRequestStateError,
  InvalidRepositoryInputError,
  type MarketBarColumns,
  type Repositories,
} from "@darkfactory/db/server";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioMonitorOutput } from "./contracts/portfolio-monitor.ts";
import { academyRouter } from "./server/academy.ts";
import type { ApiContext } from "./server/context.ts";
import { fetchPortfolioMonitor } from "./server/portfolio-monitor.ts";

const academy = vi.hoisted(() => ({
  evaluateDeployGates: vi.fn(),
  payoffSummary: vi.fn(),
  realizedVol: vi.fn(),
  resolveRules: vi.fn(),
  runOptionsBacktest: vi.fn(),
}));

vi.mock("@darkfactory/academy", async (importOriginal) => {
  const actual = await importOriginal<typeof AcademyModule>();
  academy.evaluateDeployGates.mockImplementation(actual.evaluateDeployGates);
  academy.payoffSummary.mockImplementation(actual.payoffSummary);
  academy.realizedVol.mockImplementation(actual.realizedVol);
  academy.resolveRules.mockImplementation(actual.resolveRules);
  academy.runOptionsBacktest.mockImplementation(actual.runOptionsBacktest);
  return { ...actual, ...academy };
});

vi.mock("./server/portfolio-monitor.ts", () => ({
  fetchPortfolioMonitor: vi.fn(),
}));

const feed = vi.mocked(fetchPortfolioMonitor);
const at = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;

const session = (): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId: "owner" },
  session: {
    createdAt: at,
    expiresAt: new Date(Date.now() + DAY),
    id: "s1",
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId: "owner",
  },
  user: {
    createdAt: at,
    email: "operator@domain.test",
    emailVerified: true,
    id: "owner",
    image: null,
    name: "owner",
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const columns = (count: number, value?: number): MarketBarColumns => {
  const t = new Float64Array(count);
  const c = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    t[index] = Date.UTC(2024, 0, 2) + index * DAY;
    c[index] =
      value ?? 500 * 1.0004 ** index * (1 + 0.004 * Math.sin(index / 4));
  }
  return { c, h: c, l: c, o: c, t } as unknown as MarketBarColumns;
};

type Series = Readonly<Record<string, MarketBarColumns>>;

const marketBars = (series: Series): Repositories["marketBars"] =>
  ({
    getSeries: vi.fn(async (symbol: string) =>
      series[symbol] === undefined ? null : { id: symbol, source: "fixture" }
    ),
    listSeries: vi.fn(async () => [
      {
        barCount: 3,
        firstT: 0,
        id: "SPY",
        lastT: DAY,
        source: "s",
        symbol: "SPY",
        timeframe: "1d",
      },
      {
        barCount: 3,
        firstT: 0,
        id: "x",
        lastT: 0,
        source: "s",
        symbol: "spy-lower",
        timeframe: "1d",
      },
      {
        barCount: 3,
        firstT: 0,
        id: "y",
        lastT: 0,
        source: "s",
        symbol: "QQQ",
        timeframe: "1h",
      },
    ]),
    loadColumns: vi.fn(async (id: string) => series[id]),
  }) as unknown as Repositories["marketBars"];

const row = (
  overrides: Partial<DeploymentRequestRow> = {}
): DeploymentRequestRow =>
  ({
    id: "dr-1",
    params: {},
    status: "draft",
    strategyId: "st-1",
    strategySlug: "dyr-x",
    symbol: "SPY",
    ...overrides,
  }) as DeploymentRequestRow;

const stores = () => {
  const deploymentRequests = {
    create: vi.fn(async () => row() as DeploymentRequestRow | null),
    list: vi.fn(async () => [] as DeploymentRequestRow[]),
    transition: vi.fn(async (input: { action: string }) =>
      input.action === "submit" ? row({ status: "requested" }) : null
    ),
  };
  const strategyLibrary = {
    create: vi.fn(async () => ({ id: "st-new", slug: "dyr-new" })),
    list: vi.fn(async () => [] as { id: string; slug: string }[]),
  };
  const academyAudit = {
    countSince: vi.fn(async () => 0),
    record: vi.fn(async () => ({ id: "audit-1" })),
  };
  return { academyAudit, deploymentRequests, strategyLibrary };
};

type Stores = ReturnType<typeof stores>;

const contextFor = (
  options: Readonly<{
    store?: Partial<Stores>;
    series?: Series | null;
    verifyPassword?: (password: string) => Promise<boolean>;
    apiKey?: boolean;
    noMonitor?: boolean;
  }> = {}
): ApiContext =>
  ({
    agentApiKeyPresented: options.apiKey === true,
    operatorEmails: ["operator@domain.test"],
    ...(options.noMonitor === true
      ? {}
      : { portfolioMonitor: { token: "t", url: "http://portfolio.test" } }),
    repositories: {
      ...options.store,
      ...(options.series === null
        ? {}
        : {
            marketBars: marketBars(
              options.series ?? { "^VIX": columns(300, 18), SPY: columns(300) }
            ),
          }),
    },
    requestId: "request-1",
    requireSession: async () => session(),
    ...(options.verifyPassword === undefined
      ? {}
      : { verifyPassword: options.verifyPassword }),
  }) as unknown as ApiContext;

const snapshot = (
  overrides: Readonly<{
    connected?: boolean;
    dataAsOf?: string | null;
    nlv?: number | null;
    positions?: unknown[];
  }> = {}
) =>
  ({
    positions: overrides.positions ?? [],
    status: {
      connected: overrides.connected ?? true,
      dataAsOf:
        overrides.dataAsOf === undefined
          ? new Date().toISOString()
          : overrides.dataAsOf,
    },
    summary: {
      netLiquidation: overrides.nlv === undefined ? 1_000_000 : overrides.nlv,
    },
  }) as unknown as PortfolioMonitorOutput;

const PASSING = {
  allocationPct: 5,
  riskPerTradePct: 20,
  slug: "deep-itm-call-stock-replacement",
  ticker: "SPY",
  tranches: 2,
};
const BACKTEST = {
  end: "2024-12-31",
  slug: "itm-debit-call-spread",
  start: "2024-01-01",
  ticker: "SPY",
};
const OVERRIDE_SLUG = "itm-covered-call-otm-put";

const preview = (context: ApiContext, input: object = PASSING) =>
  call(academyRouter.deployPreview, input as typeof PASSING, { context });
const request = (context: ApiContext, input: object = PASSING) =>
  call(academyRouter.deployRequest, input as typeof PASSING, { context });
const backtest = (context: ApiContext, input: object = BACKTEST) =>
  call(academyRouter.backtest, input as typeof BACKTEST, { context });

const overrideInput = async (context: ApiContext, input: object) => {
  const gate = await preview(context, input);
  return {
    ...input,
    override: {
      acknowledged: [...gate.conflicts],
      explanation: `Paper test only. I break ${gate.conflicts.join(" and ")} on purpose.`,
      password: "right",
    },
  };
};

beforeEach(() => {
  feed.mockReset();
  feed.mockResolvedValue(snapshot());
});
afterEach(() => vi.clearAllMocks());

describe("academy.tickers", () => {
  it("lists only valid daily symbols", async () => {
    await expect(
      call(academyRouter.tickers, undefined, { context: contextFor() })
    ).resolves.toEqual({
      tickers: [
        { bars: 3, first: "1970-01-01", last: "1970-01-02", ticker: "SPY" },
      ],
    });
  });

  it("reports missing bar storage", async () => {
    await expect(
      call(academyRouter.tickers, undefined, {
        context: contextFor({ series: null }),
      })
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("academy.backtest paths", () => {
  it("maps a non-Error rule failure to BAD_REQUEST", async () => {
    academy.resolveRules.mockImplementationOnce(() => {
      throw "nope";
    });
    await expect(backtest(contextFor())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid rules",
    });
  });

  it("maps engine failures to BAD_REQUEST", async () => {
    academy.runOptionsBacktest.mockImplementationOnce(() => {
      throw new Error("engine broke");
    });
    await expect(backtest(contextFor())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "engine broke",
    });
    academy.runOptionsBacktest.mockImplementationOnce(() => {
      throw 42;
    });
    await expect(backtest(contextFor())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Backtest failed",
    });
  });

  it("falls back to the input dates and null stats for an empty engine result", async () => {
    const real = await vi.importActual<typeof AcademyModule>(
      "@darkfactory/academy"
    );
    academy.runOptionsBacktest.mockImplementationOnce(
      (input: Parameters<typeof real.runOptionsBacktest>[0]) => ({
        ...real.runOptionsBacktest(input),
        benchmark: [
          { equity: 0, t: "2024-01-02" },
          { equity: 100, t: "2024-01-03" },
          { equity: 90, t: "2024-01-04" },
        ],
        equity: [],
      })
    );
    const result = await backtest(contextFor());
    expect(result).toMatchObject({
      end: BACKTEST.end,
      start: BACKTEST.start,
      stats: { sortino: null, volatility: null },
    });
    expect(result.stats.benchmarkMaxDrawdown).toBeCloseTo(-0.1);
  });

  it("models SPY volatility when VIX is absent or too sparse, and uses VIX when nearly complete", async () => {
    const spy = columns(300);
    await expect(
      backtest(contextFor({ series: { SPY: spy } }))
    ).resolves.toMatchObject({ ivSource: "rv-model" });
    const sparse = columns(100, 18);
    await expect(
      backtest(contextFor({ series: { "^VIX": sparse, SPY: spy } }))
    ).resolves.toMatchObject({ ivSource: "rv-model" });
    const nearly = columns(300, 18);
    const gappy = {
      ...nearly,
      c: nearly.c.filter((_value, index) => index !== 50),
      t: nearly.t.filter((_value, index) => index !== 50),
    } as MarketBarColumns;
    await expect(
      backtest(contextFor({ series: { "^VIX": gappy, SPY: spy } }))
    ).resolves.toMatchObject({ ivSource: "supplied" });
  });

  it("uses the model for other tickers and trims bars after the end date", async () => {
    const result = await backtest(
      contextFor({ series: { QQQ: columns(300) } }),
      {
        ...BACKTEST,
        end: "2024-06-30",
        ticker: "QQQ",
      }
    );
    expect(result.ivSource).toBe("rv-model");
    expect(result.data.last).toBe("2024-06-30");
  });

  it("downsamples long equity curves", async () => {
    const result = await backtest(
      contextFor({ series: { QQQ: columns(3000) } }),
      { ...BACKTEST, end: "2032-01-01", ticker: "QQQ" }
    );
    expect(result.equity.length).toBeLessThan(result.data.bars);
  });
});

describe("academy.deployPreview inputs", () => {
  it("refuses agent API keys", async () => {
    await expect(preview(contextFor({ apiKey: true }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("treats a missing feed config, missing timestamp or thrown non-Error as unknown NLV", async () => {
    feed.mockResolvedValueOnce(snapshot({ dataAsOf: null }));
    const missing = await preview(
      contextFor({ noMonitor: true, store: stores() })
    );
    expect(feed).toHaveBeenCalledWith(null, expect.anything());
    expect(missing.nlvDetail).toContain("data as of unknown");
    feed.mockRejectedValueOnce("boom");
    const thrown = await preview(contextFor({ store: stores() }));
    expect(thrown.nlvDetail).toBe("Portfolio feed unavailable: error.");
    feed.mockResolvedValueOnce(snapshot({ nlv: null }));
    expect((await preview(contextFor())).nlvSource).toBe("unavailable");
    feed.mockResolvedValueOnce(snapshot({ nlv: -5 }));
    expect((await preview(contextFor())).nlv).toBeNull();
  });

  it("counts open premium only for long options in the ticker", async () => {
    feed.mockResolvedValueOnce(
      snapshot({
        positions: [
          { marketValue: -300, position: 1, secType: "OPT", symbol: "SPY" },
          { marketValue: null, position: 1, secType: "OPT", symbol: "SPY" },
          { marketValue: 900, position: -1, secType: "OPT", symbol: "SPY" },
          { marketValue: 900, position: 1, secType: "STK", symbol: "SPY" },
          { marketValue: 900, position: 1, secType: "OPT", symbol: "QQQ" },
        ],
      })
    );
    const gate = await preview(contextFor());
    expect(gate.openPremiumInNameUsd).toBe(300);
    expect(gate.otherAllocationsPct).toBe(0);
  });

  it("prices nothing without bar storage or enough bars", async () => {
    expect(
      (await preview(contextFor({ series: null }))).unitLossUsd
    ).toBeNull();
    expect(
      (await preview(contextFor({ series: { SPY: columns(10) } }))).unitLossUsd
    ).toBeNull();
  });

  it("falls back to default volatility and a 20% unit loss for undefined risk", async () => {
    academy.realizedVol.mockReturnValueOnce(null);
    academy.payoffSummary.mockImplementationOnce(() => ({ maxLoss: null }));
    const gate = await preview(contextFor({ store: stores() }));
    expect(gate.unitLossUsd).toBeGreaterThan(0);
  });

  it("defaults the IV multiplier when the rules omit it", async () => {
    const real = await vi.importActual<typeof AcademyModule>(
      "@darkfactory/academy"
    );
    academy.resolveRules.mockImplementationOnce(
      (...args: Parameters<typeof real.resolveRules>) => {
        const { ivMult: _omitted, ...rest } = real.resolveRules(...args);
        return rest;
      }
    );
    const gate = await preview(contextFor({ store: stores() }));
    expect(gate.unitLossUsd).toBeGreaterThan(0);
  });

  it("prices share structures at 100 shares", async () => {
    const gate = await preview(contextFor(), {
      ...PASSING,
      slug: OVERRIDE_SLUG,
    });
    expect(gate.unitLossUsd).toBeGreaterThan(10_000);
  });

  it("reports an infinite premium share as -1", async () => {
    feed.mockResolvedValueOnce(snapshot({ nlv: null }));
    const gate = await preview(contextFor());
    expect(gate.premiumPerPositionPctNlv).toBe(-1);
  });
});

describe("academy.deployRequest storage paths", () => {
  it("needs deployment-request and audit storage", async () => {
    const { academyAudit, deploymentRequests } = stores();
    await expect(
      request(contextFor({ store: { academyAudit } }))
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(
      request(contextFor({ store: { deploymentRequests } }))
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("needs the strategy library", async () => {
    const { academyAudit, deploymentRequests } = stores();
    await expect(
      request(contextFor({ store: { academyAudit, deploymentRequests } }))
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Strategy library unavailable",
    });
  });

  it("reuses an existing lesson strategy and falls back to the draft when submit returns nothing", async () => {
    const store = stores();
    store.strategyLibrary.list.mockResolvedValueOnce([
      { id: "other", slug: "dyr-other" },
      { id: "st-existing", slug: `dyr-${PASSING.slug}` },
    ]);
    store.deploymentRequests.transition.mockResolvedValueOnce(null);
    const result = await request(contextFor({ store }));
    expect(store.strategyLibrary.create).not.toHaveBeenCalled();
    expect(store.deploymentRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ strategyId: "st-existing" })
    );
    expect(result.request.status).toBe("draft");
  });

  it("creates the lesson strategy with every rule as a parameter", async () => {
    const store = stores();
    await request(contextFor({ store }));
    expect(store.strategyLibrary.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "external", status: "idea" })
    );
  });

  it("reports a missing strategy record when create returns null", async () => {
    const store = stores();
    store.deploymentRequests.create.mockResolvedValueOnce(null);
    await expect(request(contextFor({ store }))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("maps repository errors to typed codes and rethrows unknown ones", async () => {
    const cases: [Error, string][] = [
      [new InvalidRepositoryInputError("bad symbol"), "BAD_REQUEST"],
      [new DeploymentRequestStateError("not a draft"), "CONFLICT"],
      [new DatabasePersistenceError("insert"), "STORAGE_ERROR"],
      [new Error("other"), "INTERNAL_SERVER_ERROR"],
    ];
    for (const [error, code] of cases) {
      const store = stores();
      store.deploymentRequests.create.mockRejectedValueOnce(error);
      const failure = request(contextFor({ store }));
      if (code === "INTERNAL_SERVER_ERROR")
        await expect(failure).rejects.toBe(error);
      else await expect(failure).rejects.toMatchObject({ code });
    }
    const store = stores();
    store.deploymentRequests.create.mockRejectedValueOnce(
      new InvalidRepositoryInputError("bad symbol")
    );
    await expect(request(contextFor({ store }))).rejects.toMatchObject({
      message: "bad symbol",
    });
  });

  it("withdraws the draft when submit fails, even if the withdraw fails too", async () => {
    const store = stores();
    store.deploymentRequests.transition.mockImplementation(async () => {
      throw new DeploymentRequestStateError("raced");
    });
    await expect(request(contextFor({ store }))).rejects.toMatchObject({
      code: "CONFLICT",
      message: "raced",
    });
    expect(store.deploymentRequests.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "withdraw" })
    );
  });

  it("reports the audit failure even when the withdraw fails", async () => {
    const store = stores();
    store.academyAudit.record.mockRejectedValueOnce(new Error("audit down"));
    store.deploymentRequests.transition.mockRejectedValueOnce(
      new Error("withdraw down")
    );
    await expect(request(contextFor({ store }))).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Audit write failed; the request was withdrawn",
    });
  });
});

describe("academy.deployRequest gates and step-up", () => {
  it("refuses overrides when the server has no password step-up", async () => {
    const store = stores();
    const context = contextFor({ store });
    const input = await overrideInput(context, {
      ...PASSING,
      slug: OVERRIDE_SLUG,
    });
    await expect(request(context, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("not available"),
    });
  });

  it("needs a last close for the paper limits after a verified override", async () => {
    const store = stores();
    const context = contextFor({
      store,
      verifyPassword: async (password) => password === "right",
    });
    const input = await overrideInput(context, { ...PASSING, ticker: "QQQ" });
    await expect(request(context, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("need a last close"),
    });
  });

  it("blocks a unit that does not fit the sizing budget when that gate was not overridden", async () => {
    academy.evaluateDeployGates.mockImplementationOnce(() => ({
      checks: [],
      conflicts: [],
      premiumPerPositionPctNlv: 0,
      premiumPerPositionUsd: 1,
      rewardRisk: null,
      verdict: "pass",
    }));
    await expect(
      request(contextFor({ store: stores() }), {
        ...PASSING,
        allocationPct: 0.1,
        riskPerTradePct: 0.1,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Blocked by unit-fits-budget"),
    });
  });
});
