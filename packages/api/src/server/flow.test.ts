import type { SafeAuthSession } from "@darkfactory/auth/server";
import type {
  FlowRepository,
  OpenbbRepository,
  Repositories,
} from "@darkfactory/db/server";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FlowHedgingPressureSchema,
  FlowOptionBubblesSchema,
  FlowPutCallRatioSchema,
  FlowStrikeHeatmapSchema,
  FlowTapeSpeedSchema,
} from "../contracts/flow.ts";
import type {
  StrategyBacktestRun,
  StrategyBacktestStudy,
} from "../contracts/research-studies.ts";
import { isAgentViewerReadProcedure } from "./agent-viewer.ts";
import type { ApiContext } from "./context.ts";
import {
  flowRouter,
  readFlowControl,
  readFlowSnapshot,
  setFlowClockForTesting,
} from "./flow.ts";
import { handleOpenApiRequest, isAgentApiKeyProcedurePath } from "./handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./operator-access.ts";
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

// A stored event whose time cannot be read: the pure assembly throws on it.
const unreadableWindow = {
  ...emptyWindow,
  events: [
    {
      at: new Date(Number.NaN),
      detail: "dummy",
      direction: "neutral" as const,
      key: "print:dummy",
      kind: "large_print" as const,
      premium: null,
      price: 1,
      size: 1,
      source: "ibkr" as const,
      symbol: "SPY" as const,
    },
  ],
};

const fakeRepository = (overrides: Partial<FlowRepository> = {}) =>
  ({
    addOptionGap: vi.fn(async () => undefined),
    deleteOptionGap: vi.fn(async () => undefined),
    insertBooks: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertEvents: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertGex: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertOptionPrints: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertTickSample: vi.fn(async () => ({ events: 0, trades: 0 })),
    latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
    marketPremiumLedger: vi.fn(async () => []),
    marketPremiumRanking: vi.fn(async () => ({
      rows: [],
      totals: { bearishPremium: 0, bullishPremium: 0, premium: 0, tickers: 0 },
    })),
    moveOptionGapEnd: vi.fn(async () => undefined),
    netDriftPriceAtOrBefore: vi.fn(async () => null),
    newestDataAt: vi.fn(async () => null),
    newestNetDriftMinute: vi.fn(async () => null),
    newestOptionPrintAt: vi.fn(async () => null),
    optionGaps: vi.fn(async () => []),
    prune: vi.fn(async () => 0),
    readBookSnapshots: vi.fn(async () => []),
    readEvents: vi.fn(async () => []),
    readHedgingPrints: vi.fn(async () => []),
    readLargeOptionPrints: vi.fn(async () => []),
    readLargeTrades: vi.fn(async () => []),
    readMinuteStarts: vi.fn(async () => []),
    readNetDrift: vi.fn(async () => []),
    readOptionPrintDays: vi.fn(async () => []),
    readOptionPrintMinutes: vi.fn(async () => []),
    readOptionPrintSlotPrices: vi.fn(async () => []),
    readOptionPrintStrikeBuckets: vi.fn(async () => []),
    readOptionStrikeTotals: vi.fn(async () => []),
    readTapeSeconds: vi.fn(async () => []),
    readWindow: vi.fn(async () => emptyWindow),
    recordSample: vi.fn(async () => undefined),
    storeMarketPremium: vi.fn(async () => 0),
    upsertBookSnapshots: vi.fn(async (rows: readonly unknown[]) => rows.length),
    upsertMinutes: vi.fn(async (rows: readonly unknown[]) => rows.length),
    upsertNetDrift: vi.fn(async (rows: readonly unknown[]) => rows.length),
    upsertTapeSeconds: vi.fn(async (rows: readonly unknown[]) => rows.length),
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

const expectStorageError = async (promise: Promise<unknown>, message: string) =>
  expect(promise).rejects.toMatchObject({
    code: "STORAGE_ERROR",
    message,
    status: 503,
  });

const NOT_CONFIGURED =
  "Flow storage is not configured on this server; ask the operator";
const DATABASE_FAILED = "Flow storage: database request failed; retry";
const UNEXPECTED =
  "Flow storage request failed inside the API (unexpected error); retry, and report it if it repeats";

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
    await expectStorageError(clientFor(undefined).collect({}), NOT_CONFIGURED);
    await expectStorageError(
      clientFor(undefined).snapshot({ symbol: "SPY" }),
      NOT_CONFIGURED
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
      "IBKR history health check failed (no pacing data); tick sample skipped, retry next run"
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
    // The ES tape read went to the tape endpoint without a pacing read; options and GEX reached
    // QuantData.
    expect(bySource["ticks"]).toBe("unavailable");
    expect(bySource["depth"]).toBe("unavailable");
    expect(bySource["options"]).not.toBe("skipped");
    expect(bySource["gex"]).not.toBe("skipped");
    // Without a stored ok sample the read starts two minutes before the present minute.
    expect(urls.filter((url) => url.includes("/tape"))).toEqual([
      `https://history.test/vertex-history/v1/tape?symbol=ES&since=${OPEN.getTime() / 1000 - 120}`,
    ]);
    expect(urls.some((url) => url.includes("/ticks"))).toBe(false);
    expect(urls.some((url) => url.endsWith("/health"))).toBe(false);
    expect(urls.some((url) => url.includes("/depth"))).toBe(true);
    expect(quantDataFetch).toHaveBeenCalled();
    // Every collector request (option pages and GEX) went through the reserve view of the shared client.
    expect(output.budget).toEqual({
      ibkrLimit: 6,
      ibkrRecent: null,
      quantDataFree: 24 - quantDataFetch.mock.calls.length,
      quantDataReserve: 6,
      runSeconds: 0,
    });
    const collectOne = async (symbol: "NQ" | "SPY") => {
      urls.length = 0;
      return await clientFor(fakeRepository(), {
        marketHistory: {
          token: "h".repeat(43),
          url: "https://history.test/vertex-history/v1",
        },
        quantData: { apiKey: "q".repeat(32), baseUrl: "https://qd.test" },
      }).collect({ dryRun: true, symbols: [symbol] });
    };
    // NQ reads the tape, like ES.
    await collectOne("NQ");
    expect(urls.filter((url) => url.includes("/tape"))).toEqual([
      `https://history.test/vertex-history/v1/tape?symbol=NQ&since=${OPEN.getTime() / 1000 - 120}`,
    ]);
    expect(urls.some((url) => url.includes("/ticks"))).toBe(false);
    // SPY takes its tick turn with trades and quotes, past the pacing read.
    const spy = await collectOne("SPY");
    const spyTicks = urls.filter((url) => url.includes("/ticks"));
    expect(spyTicks).toHaveLength(1);
    expect(spyTicks[0]).toContain("symbol=SPY");
    expect(spyTicks[0]).toContain("quotes=1");
    expect(urls.some((url) => url.endsWith("/health"))).toBe(true);
    expect(urls.some((url) => url.includes("/tape"))).toBe(false);
    expect(spy.budget.ibkrRecent).toEqual(expect.any(Number));
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

  it("maps repository failures to STORAGE_ERROR and names the case", async () => {
    // The repository lets a driver error pass through: a plain Error is a database failure.
    await expectStorageError(
      clientFor(
        fakeRepository({
          readWindow: vi.fn(async () => {
            throw new Error("connection terminated");
          }),
        })
      ).snapshot({ symbol: "SPY" }),
      DATABASE_FAILED
    );
    // The rows were read; only the assembly of the answer failed.
    await expectStorageError(
      clientFor(
        fakeRepository({ readWindow: vi.fn(async () => unreadableWindow) })
      ).snapshot({ symbol: "SPY" }),
      UNEXPECTED
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

describe("flow.tapeSpeed", () => {
  const MINUTE_MS = 60_000;

  it("reads the axis of the window with the lead-in of the rule and returns the document", async () => {
    setFlowClockForTesting(() => OPEN);
    const repository = fakeRepository();
    const document = await clientFor(repository).tapeSpeed({ symbol: "ES" });
    // Nothing is stored: the window of 120 minutes ends at now (15:00:00).
    const axisStart = new Date(OPEN.getTime() - 120 * MINUTE_MS);
    const axisEnd = new Date(OPEN.getTime() + MINUTE_MS);
    expect(repository.newestDataAt).toHaveBeenCalledWith("ES");
    expect(repository.readTapeSeconds).toHaveBeenCalledWith({
      // Two baselines of the rule before the axis.
      from: new Date(axisStart.getTime() - 1_200_000),
      symbol: "ES",
      to: axisEnd,
    });
    expect(repository.readMinuteStarts).toHaveBeenCalledWith({
      from: axisStart,
      symbol: "ES",
      to: axisEnd,
    });
    expect(repository.latestSamples).toHaveBeenCalledWith("ES", ["ticks"]);
    expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
    expect(document).toMatchObject({
      axisStart: axisStart.toISOString(),
      bucketSeconds: 20,
      schemaVersion: "flow-tape-speed.v1",
      storedUntil: null,
      symbol: "ES",
    });
    expect(document.bars).toHaveLength(363);
  });

  it("ends the window at the newest stored data, and at now when that data is in the future", async () => {
    setFlowClockForTesting(() => OPEN);
    // The newest data is 59 min 33 s old: the window ends inside the minute 14:00.
    const newest = new Date(OPEN.getTime() - 60 * MINUTE_MS + 27_000);
    const stored = fakeRepository({ newestDataAt: vi.fn(async () => newest) });
    const document = await clientFor(stored).tapeSpeed({
      minutes: 60,
      symbol: "NQ",
    });
    const axisStart = new Date(OPEN.getTime() - 120 * MINUTE_MS);
    expect(document.axisStart).toBe(axisStart.toISOString());
    expect(document.bars).toHaveLength(366);
    expect(stored.readMinuteStarts).toHaveBeenCalledWith({
      from: axisStart,
      symbol: "NQ",
      to: new Date(OPEN.getTime() - 59 * MINUTE_MS),
    });
    const future = fakeRepository({
      newestDataAt: vi.fn(async () => new Date(OPEN.getTime() + MINUTE_MS)),
    });
    await clientFor(future).tapeSpeed({ minutes: 60, symbol: "NQ" });
    expect(future.readMinuteStarts).toHaveBeenCalledWith(
      expect.objectContaining({ to: new Date(OPEN.getTime() + MINUTE_MS) })
    );
  });

  it("is not open to API keys: an operator session only (the viewer account reads it as a GET procedure)", () => {
    expect(isAgentApiKeyProcedurePath(["flow", "tapeSpeed"])).toBe(false);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.tapeSpeed")).toBe(false);
    expect(isAgentViewerReadProcedure(["flow", "tapeSpeed"])).toBe(true);
    // The two documents that agents read stay open to keys.
    expect(isAgentApiKeyProcedurePath(["flow", "snapshot"])).toBe(true);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.control")).toBe(true);
  });

  it("refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.tapeSpeed({ symbol: "ES" }), "FORBIDDEN");
    expect(repository.newestDataAt).not.toHaveBeenCalled();
    expect(repository.readTapeSeconds).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository, on a failed read and on a failed assembly", async () => {
    await expectStorageError(
      clientFor(undefined).tapeSpeed({ symbol: "ES" }),
      NOT_CONFIGURED
    );
    // The table does not exist (a deploy step was missed): the read throws.
    await expectStorageError(
      clientFor(
        fakeRepository({
          readTapeSeconds: vi.fn(async () => {
            throw new Error('relation "flow_tape_seconds" does not exist');
          }),
        })
      ).tapeSpeed({ symbol: "ES" }),
      DATABASE_FAILED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          // A stored sample whose time cannot be read: the pure assembly throws on it.
          latestSamples: vi.fn(async () => ({
            latest: [],
            latestOk: [
              {
                at: new Date(Number.NaN),
                items: 1,
                message: null,
                source: "ticks" as const,
                status: "ok" as const,
                symbol: "ES" as const,
              },
            ],
          })),
        })
      ).tapeSpeed({ symbol: "ES" }),
      UNEXPECTED
    );
  });
});

describe("flow.hedgingPressure", () => {
  // Friday 2026-11-20 10:00 New York.
  const FRIDAY = new Date("2026-11-20T15:00:00.000Z");
  const SESSION_FROM = new Date("2026-11-20T14:30:00.000Z");
  const SESSION_TO = new Date("2026-11-20T21:15:00.000Z");
  const stored = {
    dte: 0.4,
    id: "print-1",
    iv: 18.5,
    right: "call" as const,
    side: "ask" as const,
    size: 100,
    strike: 6650,
    tradedAt: new Date("2026-11-20T14:31:10.000Z"),
    underlyingPrice: 6625.5,
  };

  it("reads the newest session's prints, gaps and options sample and returns the response", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      optionGaps: vi.fn(async () => [
        {
          createdAt: FRIDAY,
          endTime: new Date("2026-11-20T14:50:00.000Z"),
          startTime: new Date("2026-11-20T14:40:00.000Z"),
          symbol: "ES" as const,
        },
      ]),
      readHedgingPrints: vi.fn(async () => [stored]),
    });
    const response = await clientFor(repository).hedgingPressure({
      symbol: "ES",
    });
    expect(repository.newestOptionPrintAt).toHaveBeenCalledWith("ES");
    expect(repository.readHedgingPrints).toHaveBeenCalledWith({
      from: SESSION_FROM,
      limit: 200_001,
      symbol: "ES",
      to: SESSION_TO,
    });
    expect(repository.optionGaps).toHaveBeenCalledWith("ES");
    expect(repository.latestSamples).toHaveBeenCalledWith("ES", ["options"]);
    expect(FlowHedgingPressureSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      schemaVersion: "flow-hedging-pressure.v1",
      session: "2026-11-20",
      storedUntil: stored.tradedAt.toISOString(),
      symbol: "ES",
      ticker: "SPX",
      unread: {
        from: "2026-11-20T14:40:00.000Z",
        ranges: 1,
        to: "2026-11-20T14:50:00.000Z",
      },
    });
    expect(response.points).toHaveLength(1);
  });

  it("answers session null without a stored print and reads no prints", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository();
    const response = await clientFor(repository).hedgingPressure({
      symbol: "SPY",
    });
    expect(response).toMatchObject({
      points: [],
      session: null,
      symbol: "SPY",
      ticker: "SPY",
      unread: null,
    });
    expect(repository.readHedgingPrints).not.toHaveBeenCalled();
    expect(repository.optionGaps).not.toHaveBeenCalled();
  });

  it("maps a Sunday newest print to the Friday session", async () => {
    setFlowClockForTesting(() => new Date("2026-11-22T20:00:00.000Z"));
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(
        async () => new Date("2026-11-22T19:00:00.000Z")
      ),
    });
    const response = await clientFor(repository).hedgingPressure({
      symbol: "ES",
    });
    expect(response.session).toBe("2026-11-20");
    expect(repository.readHedgingPrints).toHaveBeenCalledWith(
      expect.objectContaining({ from: SESSION_FROM, to: SESSION_TO })
    );
  });

  it("is not open to API keys: an operator session only (the viewer account reads it as a GET procedure)", () => {
    expect(isAgentApiKeyProcedurePath(["flow", "hedgingPressure"])).toBe(false);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.hedgingPressure")).toBe(
      false
    );
    expect(isAgentViewerReadProcedure(["flow", "hedgingPressure"])).toBe(true);
  });

  it("refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.hedgingPressure({ symbol: "SPY" }), "FORBIDDEN");
    expect(repository.newestOptionPrintAt).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository, on a failed read and on a failed assembly", async () => {
    await expectStorageError(
      clientFor(undefined).hedgingPressure({ symbol: "SPY" }),
      NOT_CONFIGURED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          newestOptionPrintAt: vi.fn(async () => FRIDAY),
          readHedgingPrints: vi.fn(async () => {
            throw new Error("connection reset");
          }),
        })
      ).hedgingPressure({ symbol: "SPY" }),
      DATABASE_FAILED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          // A stored sample whose time cannot be read: the pure assembly throws on it.
          latestSamples: vi.fn(async () => ({
            latest: [],
            latestOk: [
              {
                at: new Date(Number.NaN),
                items: 1,
                message: null,
                source: "options" as const,
                status: "ok" as const,
                symbol: "SPY" as const,
              },
            ],
          })),
        })
      ).hedgingPressure({ symbol: "SPY" }),
      UNEXPECTED
    );
  });
});

describe("flow.putCallRatio", () => {
  const FRIDAY = new Date("2026-11-20T15:00:00.000Z");
  const SESSION_FROM = new Date("2026-11-20T14:30:00.000Z");
  const SESSION_TO = new Date("2026-11-20T21:15:00.000Z");
  // 20 calendar days before 2026-11-20 is 2026-10-31 (EDT = UTC-4, so 09:30 NY is 13:30Z).
  const LOOKBACK_FROM = new Date("2026-10-31T13:30:00.000Z");
  const minuteRow = {
    callPremium: 200_000,
    callPrints: 2,
    callVolume: 200,
    lastPrice: 6625.5,
    lastTradedAt: new Date("2026-11-20T14:31:10.000Z"),
    minute: new Date("2026-11-20T14:31:00.000Z"),
    putPremium: 300_000,
    putPrints: 3,
    putVolume: 250,
  };
  const dayRow = {
    callPremium: 1_000_000,
    callPrints: 10,
    callVolume: 1000,
    lastPrice: 6625.5,
    putPremium: 1_200_000,
    putPrints: 12,
    putVolume: 1100,
    session: "2026-11-20",
  };

  it("reads the newest session minutes, multi-day sessions, gaps and options sample", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      optionGaps: vi.fn(async () => [
        {
          createdAt: FRIDAY,
          endTime: new Date("2026-11-20T14:50:00.000Z"),
          startTime: new Date("2026-11-20T14:40:00.000Z"),
          symbol: "ES" as const,
        },
      ]),
      readOptionPrintDays: vi.fn(async () => [dayRow]),
      readOptionPrintMinutes: vi.fn(async () => [minuteRow]),
    });
    const response = await clientFor(repository).putCallRatio({
      symbol: "ES",
    });
    expect(repository.newestOptionPrintAt).toHaveBeenCalledWith("ES");
    expect(repository.readOptionPrintMinutes).toHaveBeenCalledWith({
      from: SESSION_FROM,
      symbol: "ES",
      to: SESSION_TO,
    });
    expect(repository.readOptionPrintDays).toHaveBeenCalledWith({
      from: LOOKBACK_FROM,
      limit: 20,
      symbol: "ES",
      to: SESSION_TO,
    });
    expect(repository.optionGaps).toHaveBeenCalledWith("ES");
    expect(repository.latestSamples).toHaveBeenCalledWith("ES", ["options"]);
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      schemaVersion: "flow-put-call-ratio.v1",
      session: "2026-11-20",
      storedUntil: minuteRow.lastTradedAt.toISOString(),
      symbol: "ES",
      ticker: "SPX",
      totals: {
        premiumRatio: 1.5,
        volumeRatio: 1.25,
      },
      unread: {
        from: "2026-11-20T14:40:00.000Z",
        ranges: 1,
        to: "2026-11-20T14:50:00.000Z",
      },
    });
    expect(response.points).toHaveLength(1);
    expect(response.days).toHaveLength(1);
    expect(response.days[0]?.incomplete).toBe(true);
  });

  it("answers session null without a stored print and skips minute/day/gap queries", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository();
    const response = await clientFor(repository).putCallRatio({
      symbol: "SPY",
    });
    expect(response).toMatchObject({
      days: [],
      points: [],
      session: null,
      symbol: "SPY",
      ticker: "SPY",
      unread: null,
    });
    expect(repository.readOptionPrintMinutes).not.toHaveBeenCalled();
    expect(repository.readOptionPrintDays).not.toHaveBeenCalled();
    expect(repository.optionGaps).not.toHaveBeenCalled();
  });

  it("maps a Sunday newest print to the Friday session", async () => {
    setFlowClockForTesting(() => new Date("2026-11-22T20:00:00.000Z"));
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(
        async () => new Date("2026-11-22T19:00:00.000Z")
      ),
    });
    const response = await clientFor(repository).putCallRatio({
      symbol: "ES",
    });
    expect(response.session).toBe("2026-11-20");
    expect(repository.readOptionPrintMinutes).toHaveBeenCalledWith(
      expect.objectContaining({ from: SESSION_FROM, to: SESSION_TO })
    );
  });

  it("is not open to API keys: an operator session only (the viewer account reads it as a GET procedure)", () => {
    expect(isAgentApiKeyProcedurePath(["flow", "putCallRatio"])).toBe(false);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.putCallRatio")).toBe(false);
    expect(isAgentViewerReadProcedure(["flow", "putCallRatio"])).toBe(true);
  });

  it("refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.putCallRatio({ symbol: "SPY" }), "FORBIDDEN");
    expect(repository.newestOptionPrintAt).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository, on a failed read and on a failed assembly", async () => {
    await expectStorageError(
      clientFor(undefined).putCallRatio({ symbol: "SPY" }),
      NOT_CONFIGURED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          newestOptionPrintAt: vi.fn(async () => FRIDAY),
          readOptionPrintMinutes: vi.fn(async () => {
            throw new Error("connection reset");
          }),
        })
      ).putCallRatio({ symbol: "SPY" }),
      DATABASE_FAILED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          latestSamples: vi.fn(async () => ({
            latest: [],
            latestOk: [
              {
                at: new Date(Number.NaN),
                items: 1,
                message: null,
                source: "options" as const,
                status: "ok" as const,
                symbol: "SPY" as const,
              },
            ],
          })),
        })
      ).putCallRatio({ symbol: "SPY" }),
      UNEXPECTED
    );
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
          openbb: undefined,
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

  it("flow.control refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.control({ group: "sp500" }), "FORBIDDEN");
    expect(repository.latestSamples).not.toHaveBeenCalled();
  });

  it("flow.control fails with STORAGE_ERROR without a flow repository and on a repository failure", async () => {
    await expectStorageError(
      clientFor(undefined).control({ group: "sp500" }),
      NOT_CONFIGURED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          readNetDrift: vi.fn(async () => {
            throw new Error("connection terminated");
          }),
        })
      ).control({ group: "sp500" }),
      DATABASE_FAILED
    );
    await expectStorageError(
      clientFor(
        fakeRepository({
          // A stored sample whose time cannot be read: the pure assembly throws on it.
          latestSamples: vi.fn(async () => ({
            latest: [],
            latestOk: [
              {
                at: new Date(Number.NaN),
                items: 1,
                message: null,
                source: "net_drift" as const,
                status: "ok" as const,
                symbol: "SPY" as const,
              },
            ],
          })),
        })
      ).control({ group: "sp500" }),
      UNEXPECTED
    );
  });

  it("reads the last stored session when the market is closed and today's date when nothing is stored", async () => {
    const saturday = new Date("2026-11-07T16:00:00.000Z");
    const stored = fakeRepository({
      newestNetDriftMinute: vi.fn(async () => new Date("2026-11-06T21:14:00Z")),
    });
    const closed = await readFlowControl(
      { flow: stored, openbb: undefined, researchStudies: undefined },
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
      { flow: fakeRepository(), openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      saturday
    );
    expect(empty.session.date).toBe("2026-11-07");
    const open = await readFlowControl(
      { flow: fakeRepository(), openbb: undefined, researchStudies: undefined },
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
      { flow: fakeRepository(), openbb: undefined, researchStudies: undefined },
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

  it("reads the prints of the whole options session, so the fold window is inside the read range open and closed", async () => {
    const open = new Date("2026-11-09T14:30:00.000Z");
    const buckets = Array.from({ length: 31 }, (_, index) => ({
      filterProfile: "otm-clean.v1",
      minute: new Date(open.getTime() + index * 60_000),
      netCallPremium: 1000,
      netCallVolume: 1,
      netPutPremium: 0,
      netPutVolume: 0,
      part: "total" as const,
      ticker: "SPX" as const,
      underlyingPrice: null,
    }));
    const prints = Array.from({ length: 20 }, () => ({
      premium: 1000,
      right: "call",
      side: "ask",
      ticker: "SPX",
      tradedAt: new Date("2026-11-09T14:50:00.000Z"),
    }));
    const flow = fakeRepository({
      newestNetDriftMinute: vi.fn(async () => buckets[30]?.minute ?? null),
      readNetDrift: vi.fn(async () => buckets),
      readWindow: vi.fn(async () => ({
        ...emptyWindow,
        prints: prints as never,
      })),
    });
    // After the close the prints of 09:30 to 16:15 are read; the fold window ends at 10:01 and is
    // inside that range, so the stored prints are compared.
    const closed = await readFlowControl(
      { flow, openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      new Date("2026-11-09T22:00:00.000Z")
    );
    expect(closed.options.windowEnd).toBe("2026-11-09T15:01:00.000Z");
    expect(closed.crossCheck).toMatchObject({
      result: "same_direction",
      storedPrints: 20,
    });
    expect(flow.readWindow).toHaveBeenCalledWith({
      from: open,
      symbol: "ES",
      to: new Date("2026-11-09T21:15:00.000Z"),
    });
    const live = await readFlowControl(
      { flow, openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      new Date("2026-11-09T15:02:00.000Z")
    );
    expect(live.crossCheck).toMatchObject({
      result: "same_direction",
      storedPrints: 20,
    });
  });

  it("reads the future's window for both groups and gaps only for sp500", async () => {
    const flow = fakeRepository();
    await readFlowControl(
      { flow, openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      MON_10_00
    );
    const session = {
      from: new Date("2026-11-09T14:30:00.000Z"),
      to: new Date("2026-11-09T21:15:00.000Z"),
    };
    expect(flow.readWindow).toHaveBeenCalledWith({ ...session, symbol: "ES" });
    expect(flow.optionGaps).toHaveBeenCalledWith("ES");
    expect(flow.latestSamples).toHaveBeenCalledWith("ES");
    const nasdaq = fakeRepository();
    await readFlowControl(
      { flow: nasdaq, openbb: undefined, researchStudies: undefined },
      { group: "nasdaq100" },
      MON_10_00
    );
    expect(nasdaq.readWindow).toHaveBeenCalledWith({
      ...session,
      symbol: "NQ",
    });
    expect(nasdaq.optionGaps).not.toHaveBeenCalled();
    expect(nasdaq.latestSamples).toHaveBeenCalledWith("QQQ");
    expect(nasdaq.latestSamples).toHaveBeenCalledWith("NQ");
    expect(nasdaq.latestSamples).toHaveBeenCalledTimes(2);
  });

  it("reads the deep trades of the group's future for the futures session", async () => {
    const flow = fakeRepository();
    const document = await readFlowControl(
      { flow, openbb: undefined, researchStudies: undefined },
      { group: "nasdaq100" },
      MON_10_00
    );
    expect(flow.readLargeTrades).toHaveBeenCalledWith({
      from: new Date("2026-11-09T14:30:00.000Z"),
      symbol: "NQ",
      to: new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(document.deepTrades).toMatchObject({ limitSize: 10, symbol: "NQ" });
  });

  it("passes the tape minutes, the deep trades and the tape samples of the future to the futures side", async () => {
    const open = new Date("2026-11-09T14:30:00.000Z");
    const minuteAt = (minute: number) =>
      new Date(open.getTime() + minute * 60_000);
    const read = {
      at: MON_10_00,
      items: 1,
      message: "streamed tape NQZ6: 900 prints in 1 complete minutes",
      source: "ticks" as const,
      status: "ok" as const,
      symbol: "NQ" as const,
    };
    const flow = fakeRepository({
      latestSamples: vi.fn(async (symbol: string) =>
        symbol === "NQ"
          ? { latest: [read], latestOk: [read] }
          : { latest: [], latestOk: [] }
      ),
      readLargeTrades: vi.fn(async () =>
        Array.from({ length: 30 }, (_, minute) => ({
          capture: "streamed" as const,
          limitSize: 10,
          price: 25_000,
          sampledAt: MON_10_00,
          second: new Date(minuteAt(minute).getTime() + 5000),
          seq: 0,
          side: "sell" as const,
          signing: "quote" as const,
          size: 12,
          symbol: "NQ" as const,
        }))
      ),
      readWindow: vi.fn(async () => ({
        ...emptyWindow,
        minutes: Array.from({ length: 30 }, (_, minute) => ({
          absorption: null,
          buyVolume: 40,
          close: 24_999,
          coveredSeconds: 60,
          delta: -20,
          high: 25_001,
          largePrints: 0,
          largePrintVolume: 0,
          low: 24_998,
          minute: minuteAt(minute),
          offExchangeVolume: 0,
          open: 25_000,
          sellVolume: 60,
          stackedBuy: 0,
          stackedSell: 0,
          symbol: "NQ" as const,
          trades: 50,
          volume: 100,
          vwap: 25_000,
        })),
      })),
    });
    const document = await readFlowControl(
      { flow, openbb: undefined, researchStudies: undefined },
      { group: "nasdaq100" },
      MON_10_00
    );
    expect(document.futures).toMatchObject({
      asOf: MON_10_00.toISOString(),
      direction: "bearish",
      hold: null,
      instrument: "NQ",
      label: "NQ futures: sellers in control",
      ratio: -1,
      since: minuteAt(9).toISOString(),
      state: "sellers",
      trades: 30,
    });
    expect(document.futuresRules.version).toBe("flow-futures-rules.v1");
    expect(document.deepTrades).toMatchObject({
      capture: "streamed",
      signing: "quote",
      totalTrades: 30,
    });
    expect(document.freshness.at(-1)).toEqual({
      ageSeconds: 0,
      instrument: "NQ",
      lastOkAt: MON_10_00.toISOString(),
      message: "streamed tape NQZ6: 900 prints in 1 complete minutes",
      source: "ticks",
      state: "fresh",
    });
    expect(document.agreement.state).toBe("not_comparable");
  });

  it("previous close: the last bucket of the day before, one more read after a holiday, null without a row and for a pre-market row", async () => {
    const previousClose = async (
      answers: ({ minute: string; price: number } | null)[]
    ) => {
      const queue = [...answers];
      const read = vi.fn(async () => {
        const next = queue.shift() ?? null;
        return next === null
          ? null
          : { minute: new Date(next.minute), price: next.price };
      });
      const flow = fakeRepository({ netDriftPriceAtOrBefore: read });
      const document = await readFlowControl(
        { flow, openbb: undefined, researchStudies: undefined },
        { group: "sp500" },
        MON_10_00
      );
      return { calls: read.mock.calls as unknown[], document };
    };
    // Monday 2026-11-09: the weekday before is Friday 2026-11-06; 15:59 New York = 20:59Z.
    const friday = await previousClose([
      { minute: "2026-11-06T20:59:00.000Z", price: 6848.3 },
    ]);
    expect(friday.calls).toEqual([
      ["SPX", new Date("2026-11-06T20:59:00.000Z")],
    ]);
    expect(friday.document.levels?.previousClose).toBe(6848.3);
    // A holiday on Friday: the newest row is Thursday after 15:59; read again at Thursday 15:59.
    const holiday = await previousClose([
      { minute: "2026-11-05T21:10:00.000Z", price: 1 },
      { minute: "2026-11-05T20:59:00.000Z", price: 6840 },
    ]);
    expect(holiday.calls[1]).toEqual([
      "SPX",
      new Date("2026-11-05T20:59:00.000Z"),
    ]);
    expect(holiday.document.levels?.previousClose).toBe(6840);
    expect(
      (
        await previousClose([
          { minute: "2026-11-05T21:10:00.000Z", price: 1 },
          null,
        ])
      ).document.levels?.previousClose ?? null
    ).toBeNull();
    expect(
      (await previousClose([])).document.levels?.previousClose ?? null
    ).toBeNull();
    expect(
      (
        await previousClose([
          { minute: "2026-11-06T14:00:00.000Z", price: 6800 },
        ])
      ).document.levels?.previousClose ?? null
    ).toBeNull();
    // After the close the stored session (Monday) is used, so the read goes back to Friday.
    const evening = fakeRepository({
      newestNetDriftMinute: vi.fn(async () => new Date("2026-11-09T21:14:00Z")),
    });
    await readFlowControl(
      { flow: evening, openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      new Date("2026-11-10T03:00:00.000Z")
    );
    expect(evening.netDriftPriceAtOrBefore).toHaveBeenCalledWith(
      "SPX",
      new Date("2026-11-06T20:59:00.000Z")
    );
  });

  const eventsRepo = (events: () => Promise<readonly { source: string }[]>) =>
    ({ events: vi.fn(events) }) as unknown as OpenbbRepository;

  it("session event: fomc for a federal_reserve fomc_meeting row of the session date, null without a row, null for a row of another source, each with calendar read", async () => {
    const eventOf = async (rows: readonly { source: string }[]) => {
      const openbb = eventsRepo(async () => rows);
      const document = await readFlowControl(
        { flow: fakeRepository(), openbb, researchStudies: undefined },
        { group: "sp500" },
        MON_10_00
      );
      expect(openbb.events).toHaveBeenCalledWith("2026-11-09", "2026-11-09", [
        "fomc_meeting",
      ]);
      return document;
    };
    const fomc = await eventOf([{ source: "federal_reserve" }]);
    expect(fomc.session.event).toBe("fomc");
    expect(fomc.notes).toContain(
      "FOMC meeting day (Federal Reserve calendar)."
    );
    for (const rows of [[], [{ source: "other" }]]) {
      const document = await eventOf(rows);
      expect(document.session.event).toBeNull();
      expect(document.notes.join(" ")).not.toContain("not read");
    }
  });

  it("session event is not_read without the repository and when the read throws, and the document is still returned", async () => {
    const note =
      "The event calendar was not read; no FOMC mark for this session.";
    const missing = await readFlowControl(
      { flow: fakeRepository(), openbb: undefined, researchStudies: undefined },
      { group: "sp500" },
      MON_10_00
    );
    expect(missing.session.event).toBeNull();
    expect(missing.notes).toContain(note);
    const failing = await readFlowControl(
      {
        flow: fakeRepository(),
        openbb: eventsRepo(async () => {
          throw new Error("db down");
        }),
        researchStudies: undefined,
      },
      { group: "sp500" },
      MON_10_00
    );
    expect(failing.schemaVersion).toBe("flow-control.v1");
    expect(failing.notes).toContain(note);
  });
});

describe("flow.events", () => {
  it("returns stored flow_events for the requested symbol, window and kinds, flagging truncation", async () => {
    const readEvents = vi.fn(async () => [
      {
        at: new Date("2026-11-09T15:10:00.000Z"),
        detail: "1 stacked buy imbalance (≥3:1 on ≥3 levels)",
        direction: "bullish" as const,
        key: "stack:buy:1",
        kind: "stacked_imbalance" as const,
        premium: null,
        price: 590.25,
        size: null,
        source: "ibkr" as const,
        symbol: "SPY" as const,
      },
      {
        at: new Date("2026-11-09T15:05:00.000Z"),
        detail: "Buying absorbed: delta 800 of 1200",
        direction: "bearish" as const,
        key: "absorption:2",
        kind: "absorption" as const,
        premium: null,
        price: 591,
        size: 1200,
        source: "ibkr" as const,
        symbol: "SPY" as const,
      },
    ]);
    const flow = fakeRepository({ readEvents });
    const client = clientFor(flow);
    const output = await client.events({
      from: "2026-11-09T14:30:00Z",
      kinds: ["stacked_imbalance", "absorption"],
      limit: 1,
      symbol: "SPY",
      to: "2026-11-09T16:00:00Z",
    });
    expect(readEvents).toHaveBeenCalledWith({
      from: new Date("2026-11-09T14:30:00.000Z"),
      kinds: ["stacked_imbalance", "absorption"],
      limit: 2,
      symbol: "SPY",
      to: new Date("2026-11-09T16:00:00.000Z"),
    });
    expect(output).toEqual({
      events: [
        {
          at: "2026-11-09T15:10:00.000Z",
          detail: "1 stacked buy imbalance (≥3:1 on ≥3 levels)",
          direction: "bullish",
          kind: "stacked_imbalance",
          premium: null,
          price: 590.25,
          size: null,
        },
      ],
      from: "2026-11-09T14:30:00.000Z",
      schemaVersion: "flow-events.v1",
      symbol: "SPY",
      to: "2026-11-09T16:00:00.000Z",
      truncated: true,
    });
  });

  it("omits kinds when unspecified and sets truncated=false when within limit", async () => {
    const readEvents = vi.fn(async () => []);
    const client = clientFor(fakeRepository({ readEvents }));
    const output = await client.events({
      from: "2026-11-09T14:30:00Z",
      symbol: "ES",
      to: "2026-11-09T16:00:00Z",
    });
    expect(readEvents).toHaveBeenCalledWith({
      from: new Date("2026-11-09T14:30:00.000Z"),
      limit: 201,
      symbol: "ES",
      to: new Date("2026-11-09T16:00:00.000Z"),
    });
    expect(output.truncated).toBe(false);
    expect(output.events).toEqual([]);
  });

  it("rejects unparseable or reversed time bounds with BAD_REQUEST", async () => {
    const client = clientFor(fakeRepository());
    await expect(
      client.events({
        from: "not-a-date",
        symbol: "SPY",
        to: "2026-11-09T16:00:00Z",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.events({
        from: "2026-11-09T16:00:00Z",
        symbol: "SPY",
        to: "2026-11-09T14:30:00Z",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps repository failures to STORAGE_ERROR", async () => {
    const client = clientFor(
      fakeRepository({
        readEvents: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      })
    );
    await expect(
      client.events({
        from: "2026-11-09T14:30:00Z",
        symbol: "SPY",
        to: "2026-11-09T16:00:00Z",
      })
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("denies non-operators with FORBIDDEN and reports STORAGE_ERROR when flow storage is absent", async () => {
    const outsider = clientFor(fakeRepository(), {
      agentApiKeyPresented: false,
      operatorEmails: ["other@domain.test"],
    });
    await expectCode(
      outsider.events({
        from: "2026-11-09T14:30:00Z",
        symbol: "SPY",
        to: "2026-11-09T16:00:00Z",
      }),
      "FORBIDDEN"
    );
    await expectStorageError(
      clientFor(undefined).events({
        from: "2026-11-09T14:30:00Z",
        symbol: "SPY",
        to: "2026-11-09T16:00:00Z",
      }),
      NOT_CONFIGURED
    );
  });

  it("accepts a read-only agent API key over OpenAPI GET and coerces query string limit", async () => {
    const readEvents = vi.fn(async () => [
      {
        at: new Date("2026-11-09T15:10:00.000Z"),
        detail: "1 stacked buy imbalance (≥3:1 on ≥3 levels)",
        direction: "bullish" as const,
        key: "stack:buy:1",
        kind: "stacked_imbalance" as const,
        premium: null,
        price: 590.25,
        size: null,
        source: "ibkr" as const,
        symbol: "SPY" as const,
      },
      {
        at: new Date("2026-11-09T15:05:00.000Z"),
        detail: "Buying absorbed: delta 800 of 1200",
        direction: "bearish" as const,
        key: "absorption:2",
        kind: "absorption" as const,
        premium: null,
        price: 591,
        size: 1200,
        source: "ibkr" as const,
        symbol: "SPY" as const,
      },
    ]);
    const readOnlyKeys = {
      authenticate: vi.fn(async () => ({
        access: "read" as const,
        apiKeyId: "key-read",
        email: OPERATOR_EMAIL,
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "operator",
      })),
    } as unknown as NonNullable<ApiContext["agentApiKeys"]>;
    const request = new Request(
      "https://vertex.test/api/openapi/flow/events?symbol=SPY&from=2026-11-09T14:30:00Z&to=2026-11-09T16:00:00Z&limit=1",
      { headers: { "x-api-key": "vx_read_test" }, method: "GET" }
    );
    const response = await handleOpenApiRequest(request, {
      agentApiKeyPresented: true,
      agentApiKeys: readOnlyKeys,
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: [OPERATOR_EMAIL],
      repositories: {
        flow: fakeRepository({ readEvents }),
      } as unknown as Repositories,
      requestId: "req-openapi-events",
      requireRole: vi.fn(async () => operatorSession),
      requireSession: vi.fn(async () => operatorSession),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: unknown[];
      truncated: boolean;
      symbol: string;
    };
    expect(body.symbol).toBe("SPY");
    expect(body.events).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(readEvents).toHaveBeenCalledWith({
      from: new Date("2026-11-09T14:30:00.000Z"),
      limit: 2,
      symbol: "SPY",
      to: new Date("2026-11-09T16:00:00.000Z"),
    });
  });
});

describe("flow.strikeHeatmap", () => {
  const FRIDAY = new Date("2026-11-20T15:00:00.000Z");
  const SESSION_FROM = new Date("2026-11-20T14:30:00.000Z");
  const SESSION_TO = new Date("2026-11-20T21:15:00.000Z");

  it("reads strike buckets, slot prices, gaps and options sample for the newest session", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      optionGaps: vi.fn(async () => [
        {
          createdAt: FRIDAY,
          endTime: new Date("2026-11-20T14:50:00.000Z"),
          startTime: new Date("2026-11-20T14:40:00.000Z"),
          symbol: "SPY" as const,
        },
      ]),
      readOptionPrintSlotPrices: vi.fn(async () => [
        {
          price: 600.8,
          pricedAt: new Date("2026-11-20T14:35:00.000Z"),
          slotIndex: 0,
        },
      ]),
      readOptionPrintStrikeBuckets: vi.fn(async () => [
        {
          lastTradedAt: new Date("2026-11-20T14:35:00.000Z"),
          premium: 350_000,
          prints: 3,
          right: "call" as const,
          side: "ask" as const,
          slotIndex: 0,
          strike: 602,
          volume: 350,
        },
      ]),
    });
    const response = await clientFor(repository).strikeHeatmap({
      bucketMinutes: 5,
      symbol: "SPY",
    });
    expect(repository.newestOptionPrintAt).toHaveBeenCalledWith("SPY");
    expect(repository.readOptionPrintStrikeBuckets).toHaveBeenCalledWith({
      bucketMinutes: 5,
      from: SESSION_FROM,
      symbol: "SPY",
      to: SESSION_TO,
    });
    expect(repository.readOptionPrintSlotPrices).toHaveBeenCalledWith({
      bucketMinutes: 5,
      from: SESSION_FROM,
      symbol: "SPY",
      to: SESSION_TO,
    });
    expect(FlowStrikeHeatmapSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      bucketMinutes: 5,
      schemaVersion: "flow-strike-heatmap.v1",
      session: "2026-11-20",
      symbol: "SPY",
      ticker: "SPY",
    });
    expect(response.strikes).toHaveLength(1);
    expect(response.cells).toHaveLength(1);
  });

  it("returns an empty response without bucket reads when no option print is stored", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => null),
    });
    const response = await clientFor(repository).strikeHeatmap({
      symbol: "ES",
    });
    expect(repository.readOptionPrintStrikeBuckets).not.toHaveBeenCalled();
    expect(repository.readOptionPrintSlotPrices).not.toHaveBeenCalled();
    expect(FlowStrikeHeatmapSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      bucketMinutes: 15,
      cells: [],
      session: null,
      slots: [],
      strikes: [],
      symbol: "ES",
      ticker: "SPX",
    });
  });

  it("is not open to API keys: an operator session only (the viewer account reads it as a GET procedure)", () => {
    expect(isAgentApiKeyProcedurePath(["flow", "strikeHeatmap"])).toBe(false);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.strikeHeatmap")).toBe(false);
    expect(isAgentViewerReadProcedure(["flow", "strikeHeatmap"])).toBe(true);
  });

  it("refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.strikeHeatmap({ symbol: "SPY" }), "FORBIDDEN");
    expect(repository.newestOptionPrintAt).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository and on a failed read", async () => {
    setFlowClockForTesting(() => FRIDAY);
    await expectStorageError(
      clientFor(undefined).strikeHeatmap({ symbol: "SPY" }),
      NOT_CONFIGURED
    );
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      readOptionPrintStrikeBuckets: vi.fn(async () => {
        throw new Error("db timeout");
      }),
    });
    await expectStorageError(
      clientFor(repository).strikeHeatmap({ symbol: "SPY" }),
      DATABASE_FAILED
    );
  });
});

describe("flow.optionBubbles", () => {
  const FRIDAY = new Date("2026-11-20T16:00:00.000Z");
  const SESSION_FROM = new Date("2026-11-20T14:30:00.000Z");
  const SESSION_TO = new Date("2026-11-20T21:15:00.000Z");

  it("reads option print minutes, large prints, gaps and options sample for the newest session", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      readLargeOptionPrints: vi.fn<FlowRepository["readLargeOptionPrints"]>(
        async () => [
          {
            ask: 3.4,
            bid: 3.3,
            consolidation: "sweep",
            dte: 4,
            expiry: "2026-11-24",
            goldenSweep: true,
            id: "bub-1",
            iv: 17.5,
            moneyness: "otm",
            moneynessPct: 0.4,
            openInterest: 1000,
            opening: true,
            premium: 850_000,
            price: 3.4,
            right: "call",
            sentiment: "bullish",
            side: "above_ask",
            size: 2500,
            strike: 686,
            symbol: "SPY",
            ticker: "SPY",
            tradedAt: new Date("2026-11-20T15:10:15.000Z"),
            underlyingPrice: 683.8,
            unusual: true,
            volume: 3200,
            volumeOverOi: true,
          },
        ]
      ),
      readOptionPrintMinutes: vi.fn(async () => [
        {
          callPremium: 900_000,
          callPrints: 3,
          callVolume: 2800,
          lastPrice: 683.8,
          lastTradedAt: new Date("2026-11-20T15:10:45.000Z"),
          minute: new Date("2026-11-20T15:10:00.000Z"),
          putPremium: 120_000,
          putPrints: 1,
          putVolume: 400,
        },
      ]),
    });
    const response = await clientFor(repository).optionBubbles({
      minPremiumUsd: 500_000,
      symbol: "SPY",
    });
    expect(repository.newestOptionPrintAt).toHaveBeenCalledWith("SPY");
    expect(repository.readOptionPrintMinutes).toHaveBeenCalledWith({
      from: SESSION_FROM,
      symbol: "SPY",
      to: SESSION_TO,
    });
    expect(repository.readLargeOptionPrints).toHaveBeenCalledWith({
      from: SESSION_FROM,
      limit: 121,
      minPremiumUsd: 500_000,
      symbol: "SPY",
      to: SESSION_TO,
    });
    expect(FlowOptionBubblesSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      minPremiumUsd: 500_000,
      schemaVersion: "flow-option-bubbles.v1",
      session: "2026-11-20",
      symbol: "SPY",
      ticker: "SPY",
    });
    expect(response.bubbles).toHaveLength(1);
    expect(response.pricePoints).toHaveLength(1);
  });

  it("returns an empty response without print reads when no option print is stored", async () => {
    setFlowClockForTesting(() => FRIDAY);
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => null),
    });
    const response = await clientFor(repository).optionBubbles({
      symbol: "ES",
    });
    expect(repository.readOptionPrintMinutes).not.toHaveBeenCalled();
    expect(repository.readLargeOptionPrints).not.toHaveBeenCalled();
    expect(FlowOptionBubblesSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      bubbles: [],
      minPremiumUsd: 250_000,
      pricePoints: [],
      session: null,
      symbol: "ES",
      ticker: "SPX",
    });
  });

  it("is not open to API keys: an operator session only (the viewer account reads it as a GET procedure)", () => {
    expect(isAgentApiKeyProcedurePath(["flow", "optionBubbles"])).toBe(false);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("flow.optionBubbles")).toBe(false);
    expect(isAgentViewerReadProcedure(["flow", "optionBubbles"])).toBe(true);
  });

  it("refuses a signed-in user who is not an operator", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, {
      operatorEmails: ["someone-else@domain.test"],
    });
    await expectCode(client.optionBubbles({ symbol: "SPY" }), "FORBIDDEN");
    expect(repository.newestOptionPrintAt).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository and on a failed read", async () => {
    setFlowClockForTesting(() => FRIDAY);
    await expectStorageError(
      clientFor(undefined).optionBubbles({ symbol: "SPY" }),
      NOT_CONFIGURED
    );
    const repository = fakeRepository({
      newestOptionPrintAt: vi.fn(async () => FRIDAY),
      readLargeOptionPrints: vi.fn(async () => {
        throw new Error("db timeout");
      }),
    });
    await expectStorageError(
      clientFor(repository).optionBubbles({ symbol: "SPY" }),
      DATABASE_FAILED
    );
  });
});

describe("flow.liquidityHeatmap handler", () => {
  it("reads stored book snapshots and large trades for operators and maps repository failures to STORAGE_ERROR", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository);
    const out = await client.liquidityHeatmap({
      minutes: 15,
      symbol: "ES",
    });
    expect(out.symbol).toBe("ES");
    expect(out.capture).toBe("none");
    expect(repository.readBookSnapshots).toHaveBeenCalledTimes(1);
    expect(repository.readLargeTrades).toHaveBeenCalledTimes(1);

    const broken = fakeRepository({
      readBookSnapshots: vi.fn(async () => {
        throw new Error("db unavailable");
      }),
    });
    await expectStorageError(
      clientFor(broken).liquidityHeatmap({ minutes: 60, symbol: "NQ" }),
      DATABASE_FAILED
    );
  });
});
