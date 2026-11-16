import type { SafeAuthSession } from "@darkfactory/auth/server";
import type { FlowRepository, Repositories } from "@darkfactory/db/server";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  StrategyBacktestRun,
  StrategyBacktestStudy,
} from "../contracts/research-studies.ts";
import type { ApiContext } from "./context.ts";
import {
  flowRouter,
  readFlowControl,
  readFlowSnapshot,
  setFlowClockForTesting,
} from "./flow.ts";
import { setOptionsAnalyticsForTesting } from "./options-analytics.ts";

// Monday 2026-11-09 10:00 New York: every flow source's market is open.
const OPEN = new Date("2026-11-09T15:00:00.000Z");
const OPERATOR_EMAIL = "operator@domain.test";

const operatorSession: SafeAuthSession = {
  principal: { role: "member", status: "active", userId: "operator" },
  session: {
    createdAt: OPEN,
    expiresAt: new Date("2026-11-10T15:00:00.000Z"),
    id: "session-operator",
    ipAddress: null,
    updatedAt: OPEN,
    userAgent: null,
    userId: "operator",
  },
  user: {
    createdAt: OPEN,
    email: OPERATOR_EMAIL,
    emailVerified: true,
    id: "operator",
    image: null,
    name: "operator",
    role: "member",
    status: "active",
    updatedAt: OPEN,
  },
};

const agentKeys = {
  authenticate: vi.fn(async () => ({
    access: "write",
    apiKeyId: "key-1",
    email: OPERATOR_EMAIL,
    emailVerified: true,
    role: "member" as const,
    status: "active" as const,
    userId: "operator",
  })),
} as unknown as NonNullable<ApiContext["agentApiKeys"]>;

const emptyWindow = {
  books: [],
  events: [],
  gex: null,
  minutes: [],
  prints: [],
};

const fakeRepository = (overrides: Partial<FlowRepository> = {}) =>
  ({
    addOptionGap: vi.fn(async () => undefined),
    deleteOptionGap: vi.fn(async () => undefined),
    insertBooks: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertEvents: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertGex: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertOptionPrints: vi.fn(async (rows: readonly unknown[]) => rows.length),
    latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
    moveOptionGapEnd: vi.fn(async () => undefined),
    newestDataAt: vi.fn(async () => null),
    newestNetDriftMinute: vi.fn(async () => null),
    newestOptionPrintAt: vi.fn(async () => null),
    optionGaps: vi.fn(async () => []),
    prune: vi.fn(async () => 0),
    readNetDrift: vi.fn(async () => []),
    readWindow: vi.fn(async () => emptyWindow),
    recordSample: vi.fn(async () => undefined),
    upsertMinutes: vi.fn(async (rows: readonly unknown[]) => rows.length),
    upsertNetDrift: vi.fn(async (rows: readonly unknown[]) => rows.length),
    ...overrides,
  }) satisfies FlowRepository;

const clientFor = (
  flow: FlowRepository | undefined,
  overrides: Partial<ApiContext> = {}
) => {
  const repositories = {
    ...(flow === undefined ? {} : { flow }),
  } as Repositories;
  const context: ApiContext = {
    agentApiKeyPresented: true,
    agentApiKeys: agentKeys,
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    operatorEmails: [OPERATOR_EMAIL],
    repositories,
    requestId: "request-flow",
    requireRole: vi.fn(async () => operatorSession),
    requireSession: vi.fn(async () => operatorSession),
    ...overrides,
  };
  return createRouterClient(flowRouter, { context });
};

const expectCode = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

afterEach(() => {
  setFlowClockForTesting();
  vi.unstubAllGlobals();
  setOptionsAnalyticsForTesting({});
});

describe("flow.collect", () => {
  it("needs an agent API key", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, { agentApiKeyPresented: false });
    await expectCode(client.collect({}), "FORBIDDEN");
    expect(repository.latestSamples).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository", async () => {
    await expectCode(clientFor(undefined).collect({}), "STORAGE_ERROR");
    await expectCode(
      clientFor(undefined).snapshot({ symbol: "SPY" }),
      "STORAGE_ERROR"
    );
  });

  it("runs without market history or QuantData", async () => {
    setFlowClockForTesting(() => OPEN);
    const output = await clientFor(fakeRepository(), {
      marketHistory: null,
      quantData: null,
    }).collect({ dryRun: true });
    expect(output.at).toBe(OPEN.toISOString());
    const statuses = Object.fromEntries(
      output.runs.map((run) => [`${run.symbol}:${run.source}`, run])
    );
    expect(statuses["SPY:depth"]?.status).toBe("unavailable");
    expect(statuses["SPY:ticks"]?.message).toBe(
      "IBKR pacing unknown (history health failed)"
    );
    expect(statuses["SPY:options"]?.message).toBe("QuantData not configured");
    expect(statuses["SPY:gex"]?.message).toBe("QuantData not configured");
  });

  it("prunes at most once an hour and never on a dry run", async () => {
    let now = OPEN;
    setFlowClockForTesting(() => now);
    const repository = fakeRepository();
    const client = clientFor(repository, {
      marketHistory: null,
      quantData: null,
    });
    await client.collect({ dryRun: true });
    expect(repository.prune).not.toHaveBeenCalled();
    await client.collect({});
    await client.collect({});
    expect(repository.prune).toHaveBeenCalledTimes(1);
    now = new Date(OPEN.getTime() + 3_600_000);
    await client.collect({});
    expect(repository.prune).toHaveBeenCalledTimes(2);
  });

  it("answers busy while another collect run is active", async () => {
    setFlowClockForTesting(() => OPEN);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = fakeRepository({
      latestSamples: vi.fn(async () => {
        await gate;
        return { latest: [], latestOk: [] };
      }),
    });
    const client = clientFor(repository, {
      marketHistory: null,
      quantData: null,
    });
    const first = client.collect({ dryRun: true });
    await expect(client.collect({ dryRun: true })).resolves.toEqual({
      at: OPEN.toISOString(),
      budget: {
        ibkrLimit: 6,
        ibkrRecent: null,
        quantDataFree: null,
        quantDataReserve: 6,
        runSeconds: 0,
      },
      busy: true,
      dryRun: true,
      pruned: 0,
      runs: [],
    });
    release();
    await expect(first).resolves.toMatchObject({ busy: false });
    await expect(client.collect({ dryRun: true })).resolves.toMatchObject({
      busy: false,
    });
  });

  it("lets a run through once the active one is older than 180 s", async () => {
    let now = OPEN;
    setFlowClockForTesting(() => now);
    let release: () => void = () => undefined;
    const latestSamples = vi
      .fn<FlowRepository["latestSamples"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ latest: [], latestOk: [] });
          })
      )
      .mockResolvedValue({ latest: [], latestOk: [] });
    const client = clientFor(fakeRepository({ latestSamples }), {
      marketHistory: null,
      quantData: null,
    });
    const first = client.collect({ dryRun: true });
    await vi.waitFor(() => expect(latestSamples).toHaveBeenCalledTimes(1));
    now = new Date(OPEN.getTime() + 179_999);
    await expect(client.collect({ dryRun: true })).resolves.toMatchObject({
      busy: true,
    });
    now = new Date(OPEN.getTime() + 180_000);
    await expect(client.collect({ dryRun: true })).resolves.toMatchObject({
      busy: false,
    });
    release();
    await expect(first).resolves.toMatchObject({ busy: false });
    await expect(client.collect({ dryRun: true })).resolves.toMatchObject({
      busy: false,
    });
  });

  it("keeps pruning due after a failed run", async () => {
    setFlowClockForTesting(() => OPEN);
    const prune = vi
      .fn<FlowRepository["prune"]>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(3);
    const client = clientFor(fakeRepository({ prune }), {
      marketHistory: null,
      quantData: null,
    });
    await expect(client.collect({})).rejects.toBeDefined();
    await expect(client.collect({})).resolves.toMatchObject({ pruned: 3 });
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("wires history and QuantData into the collector", async () => {
    setFlowClockForTesting(() => OPEN);
    const urls: string[] = [];
    // flow.collect passes no fetch options, so the history calls use the global fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/health"))
          return Response.json({
            pacing: { backoff_seconds: 0, recent_requests: 0 },
          });
        return Response.json({ error: "down" }, { status: 502 });
      })
    );
    const quantDataFetch = vi.fn(async () =>
      Response.json({ error: "down" }, { status: 500 })
    );
    setOptionsAnalyticsForTesting(
      { fetch: quantDataFetch, minIntervalMs: 0, sleep: async () => undefined },
      () => OPEN
    );
    const output = await clientFor(fakeRepository(), {
      marketHistory: {
        token: "h".repeat(43),
        url: "https://history.test/vertex-history/v1",
      },
      quantData: { apiKey: "q".repeat(32), baseUrl: "https://qd.test" },
    }).collect({ dryRun: true, symbols: ["ES"] });
    const bySource = Object.fromEntries(
      output.runs.map((run) => [run.source, run.status])
    );
    // Ticks went past pacing to the ticks endpoint; options and GEX reached QuantData.
    expect(bySource["ticks"]).toBe("unavailable");
    expect(bySource["depth"]).toBe("unavailable");
    expect(bySource["options"]).not.toBe("skipped");
    expect(bySource["gex"]).not.toBe("skipped");
    expect(urls.some((url) => url.includes("/ticks"))).toBe(true);
    expect(urls.some((url) => url.includes("/depth"))).toBe(true);
    expect(quantDataFetch).toHaveBeenCalled();
    // Every collector request (option pages and GEX) went through the reserve view of the shared client.
    expect(output.budget).toEqual({
      ibkrLimit: 6,
      ibkrRecent: expect.any(Number),
      quantDataFree: 24 - quantDataFetch.mock.calls.length,
      quantDataReserve: 6,
      runSeconds: 0,
    });
  });
});

describe("flow.snapshot", () => {
  it("returns one symbol's window", async () => {
    setFlowClockForTesting(() => OPEN);
    const repository = fakeRepository();
    const output = await clientFor(repository).snapshot({ symbol: "ES" });
    expect(output.symbol).toBe("ES");
    expect(repository.readWindow).toHaveBeenCalledWith({
      from: new Date(OPEN.getTime() - 120 * 60_000),
      gexAt: OPEN,
      symbol: "ES",
      to: OPEN,
    });
  });

  it("maps repository failures to STORAGE_ERROR", async () => {
    const repository = fakeRepository({
      readWindow: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expectCode(
      clientFor(repository).snapshot({ symbol: "SPY" }),
      "STORAGE_ERROR"
    );
  });
});

describe("readFlowSnapshot window", () => {
  const windowTo = async (newest: Date | null) => {
    const repository = fakeRepository({
      newestDataAt: vi.fn(async () => newest),
    });
    const output = await readFlowSnapshot(
      repository,
      { minutes: 30, symbol: "SPY" },
      OPEN
    );
    expect(repository.readWindow).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SPY" })
    );
    return output;
  };

  it("ends at now when nothing is stored", async () => {
    const output = await windowTo(null);
    expect([output.windowStart, output.windowEnd]).toEqual([
      new Date(OPEN.getTime() - 30 * 60_000).toISOString(),
      OPEN.toISOString(),
    ]);
  });

  it("ends at the newest stored data", async () => {
    const newest = new Date(OPEN.getTime() - 3_600_000);
    const output = await windowTo(newest);
    expect(output.windowEnd).toBe(newest.toISOString());
  });

  it("ends at now when the newest data is in the future", async () => {
    const output = await windowTo(new Date(OPEN.getTime() + 60_000));
    expect(output.windowEnd).toBe(OPEN.toISOString());
  });
});

// A strategy-backtest study (illustrative values, as in research-studies-strategy-backtest.test.ts).
const RUN: StrategyBacktestRun = {
  buyHoldCagr: 0.104,
  buyHoldSharpe: 0.62,
  cagr: 0.071,
  exposure: 0.38,
  from: "2004-01-02",
  market: "US equity index ETF",
  maxDrawdown: -0.143,
  oosCagr: 0.052,
  oosSharpe: 0.48,
  profitFactor: 1.42,
  sharpe: 0.66,
  symbol: "SPY",
  to: "2026-11-06",
  trades: 212,
  winRate: 0.41,
};

const STUDY: StrategyBacktestStudy = {
  comparison: [
    {
      cagr: 0.104,
      kind: "buy-and-hold",
      maxDrawdown: -0.552,
      name: "SPY buy and hold",
      sharpe: 0.62,
    },
    {
      cagr: 0.048,
      kind: "library",
      maxDrawdown: -0.211,
      name: "Donchian breakout (library)",
      sharpe: 0.41,
    },
    {
      cagr: 0.071,
      kind: "strategy",
      maxDrawdown: -0.143,
      name: "LD34 as stated",
      sharpe: 0.66,
    },
  ],
  equity: [
    { drawdown: 0, month: "2026-06", value: 0 },
    { drawdown: 0, month: "2026-07", value: 0.012 },
    { drawdown: -0.021, month: "2026-08", value: -0.009 },
    { drawdown: 0, month: "2026-09", value: 0.018 },
  ],
  equityLabel: "LD34 as stated on SPY, return since start",
  forms: [
    {
      description:
        "Hourly close above the daily 20/50/100/200-day Donchian ladder; 2x ATR(14) stop, 1% risk.",
      key: "underlying",
      label: "As stated (underlying)",
      runs: [RUN],
    },
    {
      description:
        "Call debit vertical on the same signal, sized so the debit is at most 2% of equity.",
      key: "options",
      label: "Vertex form (options, defined risk)",
      runs: [
        {
          ...RUN,
          buyHoldCagr: null,
          buyHoldSharpe: null,
          oosCagr: null,
          oosSharpe: null,
          profitFactor: null,
          trades: 0,
          winRate: 0,
        },
      ],
    },
  ],
  gaps: [
    {
      choice: "20/50/100/200 days, the ladder shown on the chart.",
      gap: "Donchian lookbacks are not spoken.",
    },
  ],
  id: "ld34-nested-donchian-breakout",
  kind: "strategy-backtest",
  notes: "Test fixture.\nNumbers are illustrative.",
  provenance: {
    commit: "bde73275",
    dataHash: "sha256:3f1c9a0e",
    engine: "nautilus_trader 1.221.0",
    runId: "ld34-2026-11-08T21:00Z",
  },
  ran: "2026-11-08",
  robustness: [
    { check: "Walk-forward", pass: true, result: "OOS Sharpe 0.48 (> 0)" },
    {
      check: "Deflated Sharpe",
      pass: false,
      result: "0.41 after 24 trials",
    },
    { check: "Monte Carlo", pass: null, result: "5th percentile CAGR 2.1%" },
  ],
  rules: [
    {
      item: "Entry",
      rule: "Buy when an hourly bar closes above the 20-day Donchian high.",
      source: "transcript [18.50-22.70]",
    },
  ],
  sensitivity: [
    {
      cagr: 0.064,
      maxDrawdown: -0.151,
      param: "ATR stop multiple",
      sharpe: 0.6,
      trades: 230,
      value: "1.5",
    },
  ],
  source: {
    label: "Instagram reel DffCOSDBMoC",
    url: "https://www.instagram.com/reel/DffCOSDBMoC/",
  },
  spec: "docs/specs/strategies/ld34-nested-donchian-breakout.md",
  title: "LD34 nested Donchian long-only breakout",
  verdict: "needs-more-data",
  verdictReason: "Positive OOS Sharpe, but the deflated Sharpe fails.",
};

describe("flow.control", () => {
  const MON_10_00 = new Date("2026-11-09T15:00:00.000Z");
  const studyRepo = (summary: unknown) => ({
    get: vi.fn(async () =>
      summary === null
        ? null
        : {
            createdAt: MON_10_00,
            id: "flow-control-continuation",
            ranOn: "2026-11-08",
            specRef: null,
            summary: summary as Record<string, unknown>,
            updatedAt: MON_10_00,
          }
    ),
    upsert: vi.fn(),
  });
  const studyOf = async (summary: unknown) =>
    (
      await readFlowControl(
        {
          flow: fakeRepository(),
          researchStudies: studyRepo(summary) as never,
        },
        { group: "sp500" },
        MON_10_00
      )
    ).study;

  it("flow.control returns the document for a group", async () => {
    setFlowClockForTesting(() => MON_10_00);
    const document = await clientFor(fakeRepository()).control({
      group: "nasdaq100",
    });
    expect(document).toMatchObject({
      group: "nasdaq100",
      schemaVersion: "flow-control.v1",
    });
  });

  it("flow.control fails with STORAGE_ERROR without a flow repository and on a repository failure", async () => {
    await expectCode(
      clientFor(undefined).control({ group: "sp500" }),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor(
        fakeRepository({
          readNetDrift: vi.fn(async () => {
            throw new Error("db down");
          }),
        })
      ).control({ group: "sp500" }),
      "STORAGE_ERROR"
    );
  });

  it("reads the last stored session when the market is closed and today's date when nothing is stored", async () => {
    const saturday = new Date("2026-11-07T16:00:00.000Z");
    const stored = fakeRepository({
      newestNetDriftMinute: vi.fn(async () => new Date("2026-11-06T21:14:00Z")),
    });
    const closed = await readFlowControl(
      { flow: stored, researchStudies: undefined },
      { group: "sp500" },
      saturday
    );
    expect(closed.session.date).toBe("2026-11-06");
    expect(stored.readNetDrift).toHaveBeenCalledWith({
      from: new Date("2026-11-06T14:30:00.000Z"),
      tickers: ["SPX", "SPY"],
      to: new Date("2026-11-06T21:15:00.000Z"),
    });
    const empty = await readFlowControl(
      { flow: fakeRepository(), researchStudies: undefined },
      { group: "sp500" },
      saturday
    );
    expect(empty.session.date).toBe("2026-11-07");
    const open = await readFlowControl(
      { flow: fakeRepository(), researchStudies: undefined },
      { group: "sp500" },
      MON_10_00
    );
    expect(open.session.date).toBe("2026-11-09");
  });

  it("study is not_tested without a repository, without a record, for a malformed document and for another kind", async () => {
    const notTested = {
      rulesVersion: null,
      status: "not_tested",
      testedOn: null,
    };
    const none = await readFlowControl(
      { flow: fakeRepository(), researchStudies: undefined },
      { group: "sp500" },
      MON_10_00
    );
    expect(none.study).toMatchObject(notTested);
    expect(await studyOf(null)).toMatchObject(notTested);
    expect(await studyOf({ kind: "strategy-backtest" })).toMatchObject(
      notTested
    );
    expect(await studyOf({ ...STUDY, kind: "qc-port" })).toMatchObject(
      notTested
    );
  });

  it("maps verdict, run date and the Rules version entry of a stored study", async () => {
    const study = await studyOf({
      ...STUDY,
      rules: [
        ...STUDY.rules,
        {
          item: "Rules version",
          rule: "flow-control-rules.v1",
          source: "code",
        },
      ],
    });
    expect(study).toMatchObject({
      rulesVersion: "flow-control-rules.v1",
      status: STUDY.verdict,
      testedOn: STUDY.ran,
    });
  });

  it("rules version is null when the entry is missing", async () => {
    expect((await studyOf(STUDY)).rulesVersion).toBeNull();
  });

  it("reads prints and gaps only for sp500, for the window plus 10 minutes", async () => {
    const flow = fakeRepository();
    await readFlowControl(
      { flow, researchStudies: undefined },
      { group: "sp500" },
      MON_10_00
    );
    expect(flow.readWindow).toHaveBeenCalledWith({
      from: new Date(MON_10_00.getTime() - 40 * 60_000),
      symbol: "ES",
      to: MON_10_00,
    });
    expect(flow.optionGaps).toHaveBeenCalledWith("ES");
    const closed = fakeRepository();
    await readFlowControl(
      { flow: closed, researchStudies: undefined },
      { group: "sp500" },
      new Date("2026-11-09T22:00:00.000Z")
    );
    expect(closed.readWindow).toHaveBeenCalledWith(
      expect.objectContaining({ to: new Date("2026-11-09T21:15:00.000Z") })
    );
    const nasdaq = fakeRepository();
    await readFlowControl(
      { flow: nasdaq, researchStudies: undefined },
      { group: "nasdaq100" },
      MON_10_00
    );
    expect(nasdaq.readWindow).not.toHaveBeenCalled();
    expect(nasdaq.optionGaps).not.toHaveBeenCalled();
    expect(nasdaq.latestSamples).toHaveBeenCalledWith("QQQ");
    expect(nasdaq.latestSamples).toHaveBeenCalledWith("NQ");
  });
});
