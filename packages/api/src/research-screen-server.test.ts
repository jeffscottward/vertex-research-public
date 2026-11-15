import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type Repositories,
  type ResearchScreenBarsRecord,
  type ResearchScreenReportRecord,
  type ResearchScreenRepository,
  type ResearchScreenRowRecord,
  type ResearchScreenRowWrite,
  type ResearchScreenRunRecord,
  type ResearchScreenStatusRecord,
  type ResearchScreenSwinglyticsResult,
  type ResearchScreenWorkItem,
} from "@darkfactory/db/server";
import type { SemanticEventPort } from "@darkfactory/observability/port";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  CALENDAR_UNVERIFIED_LIMITATION,
  type CatalogEntry,
  RESEARCH_SCREEN_LIMITATIONS,
  RESEARCH_SCREEN_WARNING_TEXTS,
  type ResearchScreenBar,
} from "./research-screen.ts";
import { slotsBetween } from "./research-screen-slots.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./server/merged-bars.test-support.ts";
import { resetIbkrPacing } from "./server/merged-bars.ts";
import {
  chooseBars,
  contextFailureMessage,
  contextFailureReporter,
  countWrite,
  ibkrNotServed,
  RESEARCH_SCREEN_CONTEXT_FAILED_EVENT,
  type ResearchScreenEngine,
  runTick,
  storedBarsCurrent,
} from "./server/research-screen.ts";
import { setResearchScreenOptionsForTesting } from "./server/research-screen-evidence.ts";
import { SWINGLYTICS_URL, SWINGLYTICS_WARNING } from "./swinglytics.ts";

// Synthetic fixtures only: invented symbols, prices and runs.

// A Tuesday, 15:05 in New York: the session runs, and the newest slot is the 20:00 UTC grid slot.
const NOW = new Date("2026-11-10T20:05:00.000Z");
const SLOT = new Date("2026-11-10T20:00:00.000Z");
const LAST_SESSION = "2026-11-09";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const PLAINTEXT = "dfk_research_screen_test_key";
const YAHOO = "https://query1.finance.yahoo.com/";

const clock = { at: NOW.getTime() };
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

/** The UTC midnight of the session `back` days before the last completed session. */
const sessionDay = (back: number): number =>
  Date.parse(`${LAST_SESSION}T00:00:00Z`) - back * DAY_MS;

/** A Yahoo chart answer with `count` completed daily bars that end at the last session. */
const chartOf = (instrumentType = "EQUITY", count = 60) => {
  const days = Array.from({ length: count }, (_, index) => count - 1 - index);
  const closes = days.map((back) => 200 - back);
  return {
    chart: {
      error: null,
      result: [
        {
          indicators: {
            quote: [
              {
                close: closes,
                high: closes.map((close) => close + 1),
                low: closes.map((close) => close - 1),
                open: closes,
              },
            ],
          },
          meta: {
            currency: "USD",
            currentTradingPeriod: {
              regular: {
                end: Date.parse("2026-11-10T21:00:00Z") / 1000,
                start: Date.parse("2026-11-10T14:30:00Z") / 1000,
              },
            },
            exchangeTimezoneName: "America/New_York",
            instrumentType,
            regularMarketPrice: 200.5,
            regularMarketTime: (NOW.getTime() - MINUTE_MS) / 1000,
          },
          // 14:30 UTC is 09:30 in New York on the same date.
          timestamp: days.map((back) => sessionDay(back) / 1000 + 52_200),
        },
      ],
    },
  };
};

const screenBars = (count = 60): ResearchScreenBar[] =>
  Array.from({ length: count }, (_, index) => {
    const back = count - 1 - index;
    const close = 200 - back;
    return {
      c: close,
      date: new Date(sessionDay(back)).toISOString().slice(0, 10),
      h: close + 1,
      l: close - 1,
      o: close,
    };
  });

const historyBars = (count = 60) =>
  Array.from({ length: count }, (_, index) => {
    const back = count - 1 - index;
    return historyBar(sessionDay(back) / 1000, 200 - back);
  });

const report = (
  id: string,
  overrides: Partial<ResearchScreenReportRecord> = {}
): ResearchScreenReportRecord => ({
  assetType: "equity",
  companyResearchAcceptedAt: null,
  companyResearchReportRevision: null,
  companyResearchRevision: null,
  dataRevision: "rev-1",
  id,
  identityStatus: "verified",
  importedAt: at(-DAY_MS),
  metadata: { currency: "USD", timeZone: "America/New_York" },
  name: `Synthetic ${id}`,
  position: 0,
  providerSymbol: id.toUpperCase(),
  sourceUpdatedAt: null,
  status: "active",
  symbol: id.toUpperCase(),
  ...overrides,
});

/** A report that IBKR cannot serve: an index with a symbol that has no contract. */
const indexReport = (id: string): ResearchScreenReportRecord =>
  report(id, { assetType: "index", providerSymbol: `^${id.toUpperCase()}` });

const runOf = (
  overrides: Partial<ResearchScreenRunRecord> = {}
): ResearchScreenRunRecord => ({
  barsFromIbkr: 0,
  barsFromYahoo: 0,
  claimedAt: at(-MINUTE_MS),
  deadlineAt: at(24 * MINUTE_MS),
  failed: 0,
  fence: 1,
  finishedAt: null,
  ibkrFailuresInRow: 0,
  id: "run-1",
  leaseExpiresAt: at(3 * MINUTE_MS),
  leaseOwner: "request-0",
  message: null,
  notReached: 0,
  slotAt: SLOT,
  slotLabels: ["Every 4 hours"],
  status: "running",
  succeeded: 0,
  total: 0,
  yahooRateLimitsInRow: 0,
  ...overrides,
});

const storedBars = (
  reportId: string,
  overrides: Partial<ResearchScreenBarsRecord> = {}
): ResearchScreenBarsRecord => ({
  bars: screenBars(),
  fetchedAt: at(-DAY_MS),
  providerSymbol: reportId.toUpperCase(),
  reportId,
  sessionDate: LAST_SESSION,
  ...overrides,
});

const EMPTY_STATUS: ResearchScreenStatusRecord = {
  activeRun: null,
  lastRun: null,
  rows: [],
  runsSince: [],
  scheduler: null,
  swinglytics: null,
};

type Seed = Readonly<{
  bars?: readonly ResearchScreenBarsRecord[];
  reports?: readonly ResearchScreenReportRecord[];
  run?: ResearchScreenRunRecord;
  /** Reports the seeded run attempted before this test. */
  attempted?: readonly string[];
  status?: Partial<ResearchScreenStatusRecord>;
}>;

/** An in-memory stand-in with the write rules the engine relies on (fence, counters, order). */
const fakeRepository = (seed: Seed = {}) => {
  const reports = seed.reports ?? [];
  const state = {
    accept: {
      bars: true,
      claim: true,
      finish: true,
      lease: true,
      renew: true,
      write: true,
    },
    attempted: new Set(seed.attempted ?? []),
    finished: [] as unknown[][],
    run: (seed.run ?? null) as ResearchScreenRunRecord | null,
    savedBars: [] as unknown[][],
    swinglytics: [] as ResearchScreenSwinglyticsResult[],
    ticks: [] as string[],
    writes: [] as { fence: number; row: ResearchScreenRowWrite }[],
  };
  const stopCount = (count: number, signal: boolean | null): number => {
    if (signal === null) return count;
    return signal ? count + 1 : 0;
  };
  const repository = {
    claimSlot: vi.fn(async (input) => {
      if (!state.accept.claim) return null;
      state.run = runOf({
        claimedAt: new Date(clock.at),
        deadlineAt: new Date(clock.at + 25 * MINUTE_MS),
        leaseExpiresAt: new Date(clock.at + 4 * MINUTE_MS),
        leaseOwner: input.owner,
        slotAt: input.slotAt,
        slotLabels: [...input.labels],
        total: input.total,
      });
      return state.run;
    }),
    closeExpiredRun: vi.fn(async () => {
      state.run = null;
      return true;
    }),
    findActiveRun: vi.fn(async () => state.run),
    finishRun: vi.fn(async (...input) => {
      state.finished.push(input);
      if (state.accept.finish) state.run = null;
      return state.accept.finish;
    }),
    listWork: vi.fn(async () =>
      reports
        .filter((item) => !state.attempted.has(item.id))
        .map(
          (item): ResearchScreenWorkItem => ({
            bars: seed.bars?.find((bars) => bars.reportId === item.id) ?? null,
            report: item,
            row: null,
          })
        )
    ),
    readStatus: vi.fn(async () => ({
      ...EMPTY_STATUS,
      rows: reports.map((item) => ({ report: item, row: null })),
      ...seed.status,
    })),
    recordTick: vi.fn(async (decision) => {
      state.ticks.push(decision);
    }),
    renewLease: vi.fn(async () => state.accept.renew),
    saveBars: vi.fn(async (...input) => {
      state.savedBars.push(input);
      return state.accept.bars;
    }),
    saveSwinglytics: vi.fn(async (result) => {
      state.swinglytics.push(result);
    }),
    takeLease: vi.fn(async (_runId, owner) => {
      const run = state.run as ResearchScreenRunRecord;
      if (!state.accept.lease) return null;
      state.run = { ...run, fence: run.fence + 1, leaseOwner: owner };
      return { fence: run.fence + 1 };
    }),
    writeRow: vi.fn(async (_runId, fence, row) => {
      if (!state.accept.write) return false;
      const run = state.run as ResearchScreenRunRecord;
      const good = row.kind === "good";
      state.writes.push({ fence, row });
      state.attempted.add(row.reportId);
      state.run = {
        ...run,
        failed: run.failed + (good ? 0 : 1),
        ibkrFailuresInRow: stopCount(
          run.ibkrFailuresInRow,
          row.stops.ibkrFailed
        ),
        succeeded: run.succeeded + (good ? 1 : 0),
        yahooRateLimitsInRow: stopCount(
          run.yahooRateLimitsInRow,
          row.stops.yahooRateLimited
        ),
      };
      return true;
    }),
  } satisfies ResearchScreenRepository;
  return { repository, state };
};

type Route = (url: string) => Response;

/**
 * Installs the fetch and clock seam. Chart requests go to `chart` (default: a good equity chart),
 * Swinglytics answers 503 unless `swinglytics` is given, history URLs go to `history`.
 */
const useFetch = (
  routes: Readonly<{
    chart?: Route;
    history?: Route;
    swinglytics?: Route;
  }> = {}
) => {
  const charts: string[] = [];
  const pages: string[] = [];
  const { fetch, urls } = withHistory(
    routes.history ?? ((url) => historyResponse(url, historyBars())),
    async (url) => {
      if (url === SWINGLYTICS_URL) {
        pages.push(url);
        return (
          routes.swinglytics?.(url) ?? new Response("down", { status: 503 })
        );
      }
      if (!url.startsWith(YAHOO)) throw new Error(`Unexpected URL ${url}`);
      charts.push(url);
      return routes.chart?.(url) ?? Response.json(chartOf());
    }
  );
  setResearchScreenOptionsForTesting({ fetch, now: () => new Date(clock.at) });
  return { charts, history: urls, pages };
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: at(DAY_MS),
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
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const clientFor = (
  options: Readonly<{
    repository?: ResearchScreenRepository;
    apiKey?: string;
    /** The session user; null is an anonymous caller. */
    user?: string | null;
    marketHistory?: DeployStatusConfig;
    semanticEvents?: SemanticEventPort;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.repository === undefined
      ? {}
      : { researchScreen: options.repository }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        access: "write" as const,
        apiKeyId: "key-1",
        email: "owner@domain.test",
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "owner",
      };
    }),
  };
  const user = options.user === undefined ? "owner" : options.user;
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKey !== undefined)
        request.headers.set("x-api-key", options.apiKey);
      const context = createApiContext(request, {
        agentApiKeys: agentApiKeys as never,
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        ...(options.marketHistory === undefined
          ? {}
          : { marketHistory: options.marketHistory }),
        operatorEmails: ["owner@domain.test"],
        repositories,
        requestId: "request-1",
        ...(options.semanticEvents === undefined
          ? {}
          : { semanticEvents: options.semanticEvents }),
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (user === null) throw denied();
          return session(user);
        },
      });
      return handleApiRequest(request, context);
    },
  });
};

/** The scheduler's client: an operator's write key. */
const scheduler = (
  repository: ResearchScreenRepository,
  marketHistory?: DeployStatusConfig
) =>
  clientFor({
    apiKey: PLAINTEXT,
    repository,
    ...(marketHistory === undefined ? {} : { marketHistory }),
  });

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

beforeEach(() => {
  clock.at = NOW.getTime();
  resetIbkrPacing();
});

afterEach(() => {
  setResearchScreenOptionsForTesting({});
});

describe("researchScreen access", () => {
  it("answers UNAUTHORIZED to an anonymous caller", async () => {
    const { repository } = fakeRepository();
    const client = clientFor({ repository, user: null });

    await expectCode(client.researchScreen.tick({}), "UNAUTHORIZED", 401);
    await expectCode(client.researchScreen.status({}), "UNAUTHORIZED", 401);
  });

  it("answers FORBIDDEN to a signed-in caller who is not an operator", async () => {
    const { repository } = fakeRepository();
    const client = clientFor({ repository, user: "guest" });

    await expectCode(client.researchScreen.tick({}), "FORBIDDEN", 403);
    await expectCode(client.researchScreen.status({}), "FORBIDDEN", 403);
  });

  it("refuses the tick of an operator session without an agent API key", async () => {
    const { repository, state } = fakeRepository();
    const client = clientFor({ repository });

    await expect(client.researchScreen.tick({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "researchScreen.tick needs an agent API key",
      status: 403,
    });
    expect(state.ticks).toStrictEqual([]);
    expect(repository.findActiveRun).not.toHaveBeenCalled();
  });

  it("answers STORAGE_ERROR when the repository is missing", async () => {
    await expectCode(
      clientFor({ apiKey: PLAINTEXT }).researchScreen.tick({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({}).researchScreen.status({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("maps a persistence failure to STORAGE_ERROR and passes other errors on", async () => {
    useFetch();
    const { repository } = fakeRepository();
    repository.findActiveRun.mockRejectedValueOnce(
      new DatabasePersistenceError("research screen")
    );
    repository.readStatus.mockRejectedValueOnce(
      new DatabasePersistenceError("research screen")
    );

    await expectCode(
      scheduler(repository).researchScreen.tick({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({ repository }).researchScreen.status({}),
      "STORAGE_ERROR",
      503
    );

    repository.readStatus.mockRejectedValueOnce(new Error("synthetic defect"));
    await expectCode(
      clientFor({ repository }).researchScreen.status({}),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });
});

describe("researchScreen.tick decisions", () => {
  it("answers not-due when the newest slot cannot be claimed", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({ reports: [report("aaa")] });
    state.accept.claim = false;

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toStrictEqual({
      decision: "not-due",
      done: true,
      processed: 0,
      remaining: 0,
      requestId: "request-1",
      runId: null,
      runStatus: null,
      slotAt: null,
      slotLabels: [],
      total: 0,
    });
    expect(state.ticks).toStrictEqual(["not-due"]);
    expect(seen.charts).toStrictEqual([]);
    expect(seen.pages).toStrictEqual([]);
    expect(repository.listWork).not.toHaveBeenCalled();
  });

  it("claims the newest slot, reads Swinglytics once and completes the run", async () => {
    const seen = useFetch({
      chart: (url) =>
        Response.json(chartOf(url.includes("%5E") ? "INDEX" : "EQUITY")),
    });
    const { repository, state } = fakeRepository({
      reports: [report("aaa"), indexReport("syn")],
    });

    const answer = await scheduler(
      repository,
      HISTORY_CONFIG
    ).researchScreen.tick({});

    expect(answer).toStrictEqual({
      decision: "claimed",
      done: true,
      processed: 2,
      remaining: 0,
      requestId: "request-1",
      runId: "run-1",
      runStatus: "completed",
      slotAt: SLOT,
      slotLabels: ["Every 4 hours"],
      total: 2,
    });
    expect(seen.charts).toHaveLength(2);
    expect(seen.pages).toHaveLength(1);
    expect(seen.history).toHaveLength(1);
    expect(repository.claimSlot).toHaveBeenCalledExactlyOnceWith({
      labels: ["Every 4 hours"],
      owner: "request-1",
      slotAt: SLOT,
      total: 2,
    });
    expect(state.ticks).toStrictEqual(["claimed"]);
    expect(state.swinglytics).toStrictEqual([
      { kind: "error", message: expect.stringContaining("Swinglytics") },
    ]);
    expect(state.finished).toStrictEqual([
      ["run-1", 1, "completed", "2 of 2 reports screened"],
    ]);
    // The served report: IBKR bars read, stored, and used. The index: the Yahoo bars of its chart.
    expect(state.savedBars).toStrictEqual([
      ["run-1", 1, "aaa", "AAA", LAST_SESSION, screenBars()],
    ]);
    expect(state.writes.map(({ fence, row }) => [fence, row])).toStrictEqual([
      [
        1,
        expect.objectContaining({
          barsSource: "ibkr",
          historyAt: new Date("2026-11-10T00:00:00.000Z"),
          kind: "good",
          providerSymbol: "AAA",
          quoteAt: at(-MINUTE_MS),
          quoteSource: "yahoo",
          reportId: "aaa",
          stops: { ibkrFailed: false, yahooRateLimited: false },
        }),
      ],
      [
        1,
        expect.objectContaining({
          barsSource: "yahoo",
          kind: "good",
          providerSymbol: "^SYN",
          reportId: "syn",
          stops: { ibkrFailed: null, yahooRateLimited: false },
        }),
      ],
    ]);
    const [first] = state.writes;
    expect(first?.row).toMatchObject({
      observation: {
        action: expect.stringMatching(/^(review-entry|watch|wait)$/u),
        price: 200.5,
        support: 180,
        target: 201,
      },
    });
    expect(first?.row).not.toHaveProperty("observation.quoteAt");
    expect(repository.renewLease).toHaveBeenCalledTimes(2);
  });

  it("answers busy while the lease of the active run is live", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa")],
      run: runOf({ failed: 1, succeeded: 2, total: 5 }),
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toStrictEqual({
      decision: "busy",
      done: true,
      processed: 3,
      remaining: 2,
      requestId: "request-1",
      runId: "run-1",
      runStatus: "running",
      slotAt: SLOT,
      slotLabels: ["Every 4 hours"],
      total: 5,
    });
    expect(state.ticks).toStrictEqual(["busy"]);
    expect(repository.takeLease).not.toHaveBeenCalled();
    expect(seen.charts).toStrictEqual([]);
  });

  it("takes an expired lease over and resumes with the raised fence", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      attempted: ["aaa"],
      reports: [report("aaa"), report("bbb")],
      run: runOf({
        fence: 3,
        leaseExpiresAt: at(-1000),
        succeeded: 1,
        total: 2,
      }),
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      decision: "resumed",
      done: true,
      processed: 2,
      remaining: 0,
      runStatus: "completed",
      total: 2,
    });
    expect(repository.takeLease).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "request-1"
    );
    expect(state.ticks).toStrictEqual(["resumed"]);
    expect(state.writes.map(({ fence, row }) => [fence, row.reportId])).toEqual(
      [[4, "bbb"]]
    );
    expect(state.finished).toStrictEqual([
      ["run-1", 4, "completed", "2 of 2 reports screened"],
    ]);
    // A resumed run reads no Swinglytics page.
    expect(seen.pages).toStrictEqual([]);
    expect(repository.claimSlot).not.toHaveBeenCalled();
  });

  it("answers busy when another tick takes the free lease first", async () => {
    useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa")],
      run: runOf({ leaseExpiresAt: null, total: 1 }),
    });
    state.accept.lease = false;

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      decision: "busy",
      done: true,
      processed: 0,
      remaining: 1,
    });
    expect(state.ticks).toStrictEqual(["busy"]);
    expect(repository.listWork).not.toHaveBeenCalled();
  });

  it("ends a run whose deadline and lease passed, then claims the due slot", async () => {
    useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa")],
      run: runOf({
        deadlineAt: at(-MINUTE_MS),
        id: "run-0",
        leaseExpiresAt: at(-MINUTE_MS),
        slotAt: new Date("2026-11-10T16:00:00.000Z"),
      }),
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(repository.closeExpiredRun).toHaveBeenCalledExactlyOnceWith("run-0");
    expect(repository.takeLease).not.toHaveBeenCalled();
    expect(answer).toMatchObject({
      decision: "claimed",
      done: true,
      runId: "run-1",
      runStatus: "completed",
      slotAt: SLOT,
    });
    expect(state.ticks).toStrictEqual(["claimed"]);
  });
});

describe("researchScreen.tick shares", () => {
  it("starts no report after the share budget and resumes in the next tick", async () => {
    const { repository, state } = fakeRepository({
      reports: [indexReport("one"), indexReport("two"), indexReport("six")],
    });
    // Each chart request takes 30 seconds: the third report starts after 60 seconds.
    useFetch({
      chart: () => {
        clock.at += 30_000;
        return Response.json(chartOf("INDEX"));
      },
    });
    const client = scheduler(repository);

    const first = await client.researchScreen.tick({});

    expect(first).toMatchObject({
      decision: "claimed",
      done: false,
      processed: 2,
      remaining: 1,
      runStatus: "running",
      total: 3,
    });
    expect(state.finished).toStrictEqual([]);

    // The first tick ended: its lease is free.
    state.run = {
      ...(state.run as ResearchScreenRunRecord),
      leaseExpiresAt: null,
    };
    const second = await client.researchScreen.tick({});

    expect(second).toMatchObject({
      decision: "resumed",
      done: true,
      processed: 3,
      remaining: 0,
      runStatus: "completed",
    });
    expect(state.ticks).toStrictEqual(["claimed", "resumed"]);
    expect(state.finished).toStrictEqual([
      ["run-1", 2, "completed", "3 of 3 reports screened"],
    ]);
  });

  it("ends the share when the fence refuses a row write", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      reports: [indexReport("one"), indexReport("two")],
    });
    state.accept.write = false;

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      decision: "claimed",
      done: true,
      processed: 0,
      remaining: 2,
      runStatus: "running",
    });
    expect(seen.charts).toHaveLength(1);
    expect(repository.renewLease).not.toHaveBeenCalled();
    expect(repository.finishRun).not.toHaveBeenCalled();
  });

  it("ends the share when the lease cannot be renewed", async () => {
    const seen = useFetch({ chart: () => Response.json(chartOf("INDEX")) });
    const { repository, state } = fakeRepository({
      reports: [indexReport("one"), indexReport("two")],
    });
    state.accept.renew = false;

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      done: true,
      processed: 1,
      remaining: 1,
      runStatus: "running",
    });
    expect(seen.charts).toHaveLength(1);
    expect(repository.finishRun).not.toHaveBeenCalled();
  });

  it("ends the share when the fence refuses the bars of a report", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa"), report("bbb")],
    });
    state.accept.bars = false;

    const answer = await scheduler(
      repository,
      HISTORY_CONFIG
    ).researchScreen.tick({});

    expect(answer).toMatchObject({
      done: true,
      processed: 0,
      remaining: 2,
      runStatus: "running",
    });
    expect(seen.history).toHaveLength(1);
    expect(repository.writeRow).not.toHaveBeenCalled();
    expect(repository.finishRun).not.toHaveBeenCalled();
  });

  it("reports a run as running when the fence refuses its end", async () => {
    useFetch({ chart: () => Response.json(chartOf("INDEX")) });
    const { repository, state } = fakeRepository({
      reports: [indexReport("one")],
    });
    state.accept.finish = false;

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      done: true,
      processed: 1,
      remaining: 0,
      runStatus: "running",
    });
    expect(state.finished).toHaveLength(1);
  });

  it("ends the run as partial when the deadline comes before every report", async () => {
    const { repository, state } = fakeRepository({
      reports: [indexReport("one"), indexReport("two"), indexReport("six")],
    });
    useFetch({
      chart: () => {
        clock.at += 26 * MINUTE_MS;
        return Response.json(chartOf("INDEX"));
      },
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      decision: "claimed",
      done: true,
      processed: 1,
      remaining: 2,
      runStatus: "partial",
      total: 3,
    });
    expect(state.finished).toStrictEqual([
      ["run-1", 1, "partial", "1 of 3 reports screened"],
    ]);
  });

  it("ends the run as failed when no report succeeds", async () => {
    useFetch({ chart: () => new Response("no", { status: 500 }) });
    const { repository, state } = fakeRepository({
      reports: [
        indexReport("one"),
        report("two", { identityStatus: "pending" }),
        report("six", { metadata: { currency: "USD" } }),
      ],
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      done: true,
      processed: 3,
      remaining: 0,
      runStatus: "failed",
    });
    expect(state.writes.map(({ row }) => row)).toStrictEqual([
      {
        barsSource: null,
        errorCode: "provider-http",
        errorMessage: expect.stringContaining("Yahoo chart"),
        kind: "failed",
        providerSymbol: "^ONE",
        reportId: "one",
        stops: { ibkrFailed: null, yahooRateLimited: false },
      },
      expect.objectContaining({
        errorCode: "identity-unverified",
        reportId: "two",
        stops: { ibkrFailed: null, yahooRateLimited: false },
      }),
      expect.objectContaining({
        errorCode: "metadata-invalid",
        reportId: "six",
      }),
    ]);
    expect(state.finished).toStrictEqual([
      ["run-1", 1, "failed", "3 of 3 reports screened"],
    ]);
  });

  it("ends the run of an empty catalog as failed", async () => {
    useFetch();
    const { repository, state } = fakeRepository();

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({
      decision: "claimed",
      done: true,
      processed: 0,
      remaining: 0,
      runStatus: "failed",
      total: 0,
    });
    expect(state.finished).toStrictEqual([
      ["run-1", 1, "failed", "0 of 0 reports screened"],
    ]);
  });

  it("writes a failed row with the bars source when the screen refuses the evidence", async () => {
    useFetch({ chart: () => Response.json(chartOf("INDEX", 10)) });
    const { repository, state } = fakeRepository({
      reports: [indexReport("one")],
    });

    await scheduler(repository).researchScreen.tick({});

    expect(state.writes.map(({ row }) => row)).toStrictEqual([
      {
        barsSource: "yahoo",
        errorCode: "too-few-bars",
        errorMessage: expect.stringContaining("it received 10"),
        kind: "failed",
        providerSymbol: "^ONE",
        reportId: "one",
        stops: { ibkrFailed: null, yahooRateLimited: false },
      },
    ]);
  });
});

describe("researchScreen.tick stop rules and bars", () => {
  it("sends no Yahoo request after 3 rate-limit answers in a row", async () => {
    const seen = useFetch({
      chart: () => new Response("slow down", { status: 429 }),
    });
    const { repository, state } = fakeRepository({
      reports: [
        indexReport("one"),
        indexReport("two"),
        indexReport("six"),
        indexReport("ten"),
        report("bad", { identityStatus: "pending" }),
      ],
    });

    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({ processed: 5, runStatus: "failed" });
    expect(seen.charts).toHaveLength(3);
    expect(
      state.writes.map(({ row }) => [
        row.kind === "failed" ? row.errorCode : null,
        row.stops,
      ])
    ).toStrictEqual([
      ["rate-limited", { ibkrFailed: null, yahooRateLimited: true }],
      ["rate-limited", { ibkrFailed: null, yahooRateLimited: true }],
      ["rate-limited", { ibkrFailed: null, yahooRateLimited: true }],
      ["rate-limited", { ibkrFailed: null, yahooRateLimited: true }],
      // A catalog failure makes no request and keeps the stop.
      ["identity-unverified", { ibkrFailed: null, yahooRateLimited: true }],
    ]);
    expect(state.writes[3]?.row).toMatchObject({
      errorMessage:
        "Yahoo chart: not requested after 3 rate-limit answers in a row in this run.",
    });
  });

  it("reads no IBKR bars after 3 failed reads in a row", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa"), report("bbb"), report("ccc"), report("ddd")],
    });

    // No history service is configured: every due read fails without a request.
    const answer = await scheduler(repository).researchScreen.tick({});

    expect(answer).toMatchObject({ processed: 4, runStatus: "completed" });
    expect(seen.history).toStrictEqual([]);
    expect(
      state.writes.map(({ row }) => [row.barsSource, row.stops.ibkrFailed])
    ).toStrictEqual([
      ["yahoo", true],
      ["yahoo", true],
      ["yahoo", true],
      ["yahoo", null],
    ]);
  });

  it("keeps the IBKR stop of the run record across shares", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      reports: [report("aaa")],
      run: runOf({ ibkrFailuresInRow: 3, leaseExpiresAt: null, total: 1 }),
    });

    await scheduler(repository, HISTORY_CONFIG).researchScreen.tick({});

    expect(seen.history).toStrictEqual([]);
    expect(state.writes[0]?.row).toMatchObject({
      barsSource: "yahoo",
      stops: { ibkrFailed: null },
    });
  });

  it("requests IBKR bars only when the stored bars are due", async () => {
    const seen = useFetch();
    const { repository, state } = fakeRepository({
      bars: [
        storedBars("cur"),
        storedBars("old", { sessionDate: "2026-11-06" }),
        storedBars("mov", { providerSymbol: "MOVOLD" }),
      ],
      reports: [report("cur"), report("old"), report("new"), report("mov")],
    });

    const answer = await scheduler(
      repository,
      HISTORY_CONFIG
    ).researchScreen.tick({});

    expect(answer).toMatchObject({ processed: 4, runStatus: "completed" });
    // Not due: no request. Old, missing and of another provider symbol: one request each.
    expect(
      seen.history.map((url) => new URL(url).searchParams.get("symbol"))
    ).toStrictEqual(["OLD", "NEW", "MOV"]);
    expect(state.savedBars.map((saved) => saved.slice(2, 5))).toStrictEqual([
      ["old", "OLD", LAST_SESSION],
      ["new", "NEW", LAST_SESSION],
      ["mov", "MOV", LAST_SESSION],
    ]);
    expect(
      state.writes.map(({ row }) => [
        row.reportId,
        row.barsSource,
        row.stops.ibkrFailed,
      ])
    ).toStrictEqual([
      ["cur", "ibkr", null],
      ["old", "ibkr", false],
      ["new", "ibkr", false],
      ["mov", "ibkr", false],
    ]);
  });

  it("leaves the run unchanged when the Swinglytics context cannot be stored", async () => {
    const seen = useFetch({ chart: () => Response.json(chartOf("INDEX")) });
    const { repository, state } = fakeRepository({
      reports: [indexReport("one")],
    });
    repository.saveSwinglytics.mockRejectedValueOnce(
      new DatabasePersistenceError("research screen")
    );

    const emit = vi.fn<SemanticEventPort["emit"]>(
      async () =>
        ({
          accepted: true,
        }) as never
    );
    const answer = await clientFor({
      apiKey: PLAINTEXT,
      repository,
      semanticEvents: { emit },
    }).researchScreen.tick({});

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      {
        action: "collect-context",
        attributes: {
          message:
            "DatabasePersistenceError: Database operation failed: research screen",
        },
        correlation: {
          procedure: "researchScreen.tick",
          requestId: "request-1",
          route: "/api/research-screen/tick",
        },
        entityType: "research-screen-context",
        eventId: expect.any(String),
        name: "research.screen.context.failed",
        occurredAt: NOW.toISOString(),
        outcome: "failure",
        source: "api",
      },
      expect.any(Object)
    );
    expect(seen.pages).toHaveLength(1);
    expect(answer).toMatchObject({
      decision: "claimed",
      done: true,
      processed: 1,
      runStatus: "completed",
    });
    expect(state.swinglytics).toStrictEqual([]);
  });
});

describe("research screen engine", () => {
  const entry: CatalogEntry = {
    aliases: [],
    assetType: "equity",
    currency: "USD",
    hasContractSpecs: false,
    id: "aaa",
    providerSymbol: "AAA",
    status: "active",
    symbol: "AAA",
    timeZone: "America/New_York",
  };
  const engineOf = (
    repository: ResearchScreenRepository,
    readers: Partial<ResearchScreenEngine["readers"]>
  ): ResearchScreenEngine => ({
    marketHistory: HISTORY_CONFIG,
    now: () => new Date(clock.at),
    readers: {
      readChart: async () => ({ bars: screenBars(), ok: true, quote: null }),
      readIbkrBars: async () => ({
        message: "synthetic",
        ok: false,
        reason: "failed",
      }),
      readSwinglytics: async () => ({ error: "synthetic", ok: false }),
      ...readers,
    },
    reportContextFailure: async () => undefined,
    repository,
    requestId: "request-9",
  });
  const counters = () => ({
    failed: 0,
    ibkrFailuresInRow: 0,
    succeeded: 0,
    yahooRateLimitsInRow: 0,
  });

  it("stores a Swinglytics snapshot of the claiming tick", async () => {
    const { repository, state } = fakeRepository();
    const generatedAt = at(-MINUTE_MS);
    const snapshot = {
      breadth: {
        above20DayPercent: null,
        above50DayPercent: null,
        above200DayPercent: null,
        regime: null,
        score: null,
      },
      regime: { label: "Synthetic", riskLevel: null, trendStrength: null },
      scanner: { bearish: null, bullish: null, total: null, withSetups: null },
      setups: [],
      themes: [],
      vix: { level: null, percentile1Year: null, regime: null, trend: null },
    };

    const answer = await runTick(
      engineOf(repository, {
        readSwinglytics: async () => ({
          generatedAt,
          ok: true,
          retrievedAt: NOW,
          snapshot,
        }),
      })
    );

    expect(answer).toMatchObject({
      decision: "claimed",
      requestId: "request-9",
      runStatus: "failed",
    });
    expect(state.swinglytics).toStrictEqual([
      { generatedAt, kind: "ok", snapshot },
    ]);
  });

  it("reports a reader that throws and goes on with the run", async () => {
    const { repository, state } = fakeRepository();
    const reported: string[] = [];

    const answer = await runTick({
      ...engineOf(repository, {
        readSwinglytics: async () => {
          throw new Error(
            `Synthetic defect at https://example.test/page?x=1\n${"x".repeat(400)}`
          );
        },
      }),
      reportContextFailure: async (message) => {
        reported.push(message);
      },
    });

    expect(answer).toMatchObject({ decision: "claimed", runStatus: "failed" });
    expect(state.swinglytics).toStrictEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toHaveLength(240);
    expect(reported[0]).toMatch(/^Error: Synthetic defect at \[url\] x+$/u);
    expect(contextFailureMessage("  plain\ttext ")).toBe("plain text");
  });

  it("emits the context failure through the event port, best-effort", async () => {
    useFetch();
    const emit = vi.fn<SemanticEventPort["emit"]>(async () => {
      throw new Error("port down");
    });
    const span = { correlation: { traceId: "trace-1" } } as never;
    const waitUntil = vi.fn();

    await contextFailureReporter({ requestId: "request-9" })("unreported");
    await expect(
      contextFailureReporter({
        requestId: "request-9",
        semanticEvents: { emit },
        span,
        waitUntil,
      })("Synthetic failure")
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attributes: { message: "Synthetic failure" },
        correlation: {
          procedure: "researchScreen.tick",
          requestId: "request-9",
          route: "/api/research-screen/tick",
          traceId: "trace-1",
        },
        name: RESEARCH_SCREEN_CONTEXT_FAILED_EVENT,
      }),
      { span, waitUntil }
    );
  });

  it("tells a report that IBKR cannot serve from a read that failed", () => {
    expect(
      ibkrNotServed({ message: "none", ok: false, reason: "not-served" })
    ).toBe(true);
    expect(
      ibkrNotServed({ message: "down", ok: false, reason: "failed" })
    ).toBe(false);
    expect(ibkrNotServed({ bars: [], ok: true })).toBe(false);
  });

  it("uses stored bars only with a known due date, the same symbol and a current session", () => {
    expect(storedBarsCurrent(storedBars("aaa"), "AAA", NOW)).toBe(true);
    expect(storedBarsCurrent(null, "AAA", NOW)).toBe(false);
    expect(
      storedBarsCurrent(storedBars("aaa"), "AAA", new Date(Number.NaN))
    ).toBe(false);
    expect(storedBarsCurrent(storedBars("aaa"), "AAB", NOW)).toBe(false);
    expect(
      storedBarsCurrent(
        storedBars("aaa", { sessionDate: "2026-11-06" }),
        "AAA",
        NOW
      )
    ).toBe(false);
  });

  it("stores the newest 300 IBKR bars and treats an empty read as a failed read", async () => {
    const { repository, state } = fakeRepository();
    const lease = { fence: 2, run: runOf() };
    const item = { bars: null, report: report("aaa"), row: null };
    const work = {
      counters: counters(),
      entry,
      now: NOW,
      yahooBars: screenBars(55),
    };
    const long = screenBars(310);

    const stored = await chooseBars(
      engineOf(repository, {
        readIbkrBars: async (_entry, config) =>
          config === null
            ? { message: "probe", ok: false, reason: "not-configured" }
            : { bars: long, ok: true },
      }),
      lease,
      item,
      work
    );
    const empty = await chooseBars(
      engineOf(repository, {
        readIbkrBars: async () => ({ bars: [], ok: true }),
      }),
      lease,
      item,
      work
    );

    expect(stored).toStrictEqual({
      bars: long,
      ibkrFailed: false,
      source: "ibkr",
    });
    expect(state.savedBars).toStrictEqual([
      ["run-1", 2, "aaa", "AAA", LAST_SESSION, long.slice(10)],
    ]);
    expect(empty).toStrictEqual({
      bars: work.yahooBars,
      ibkrFailed: true,
      source: "yahoo",
    });
  });

  it("counts an accepted write as the repository does", () => {
    const run = counters();
    const base = {
      providerSymbol: "AAA",
      reportId: "aaa",
      stops: { ibkrFailed: true, yahooRateLimited: true },
    };
    const observation = {
      action: "watch",
      blockingWarnings: [],
      buyZone: null,
      changePercent: null,
      momentumPercent: null,
      price: 1,
      reasons: [],
      rewardRisk: null,
      score: 50,
      stop: null,
      support: null,
      target: null,
      warnings: [],
    };
    const good = {
      ...base,
      barsSource: "yahoo",
      historyAt: null,
      kind: "good",
      observation,
      quoteAt: null,
      quoteSource: "yahoo",
    } as const;

    countWrite(run, good);
    expect(run).toStrictEqual({
      failed: 0,
      ibkrFailuresInRow: 1,
      succeeded: 1,
      yahooRateLimitsInRow: 1,
    });

    // An observation with the action `unavailable` is not a success.
    countWrite(run, {
      ...good,
      observation: { ...observation, action: "unavailable" },
      stops: { ibkrFailed: null, yahooRateLimited: false },
    });
    expect(run).toStrictEqual({
      failed: 1,
      ibkrFailuresInRow: 1,
      succeeded: 1,
      yahooRateLimitsInRow: 0,
    });

    countWrite(run, {
      ...base,
      barsSource: null,
      errorCode: "provider-http",
      errorMessage: "synthetic",
      kind: "failed",
      stops: { ibkrFailed: false, yahooRateLimited: false },
    });
    expect(run).toStrictEqual({
      failed: 2,
      ibkrFailuresInRow: 0,
      succeeded: 1,
      yahooRateLimitsInRow: 0,
    });
  });
});

describe("researchScreen.status", () => {
  const statusOf = async (
    status: Partial<ResearchScreenStatusRecord>,
    reports: readonly ResearchScreenReportRecord[] = []
  ) => {
    useFetch();
    const { repository } = fakeRepository({ reports, status });
    return clientFor({ repository }).researchScreen.status({});
  };

  const storedRow = (
    reportId: string,
    overrides: Partial<ResearchScreenRowRecord> = {}
  ): ResearchScreenRowRecord => ({
    attemptAt: at(-10 * MINUTE_MS),
    attemptRunId: "run-1",
    barsSource: "ibkr",
    errorCode: null,
    errorMessage: null,
    goodAt: at(-10 * MINUTE_MS),
    goodRunId: "run-1",
    historyAt: new Date("2026-11-10T00:00:00.000Z"),
    observation: {
      action: "review-entry",
      blockingWarnings: [],
      buyZone: { high: 190, low: 180 },
      changePercent: 0.5,
      momentumPercent: 4,
      price: 185,
      reasons: ["Synthetic reason"],
      rewardRisk: 2.5,
      score: 100,
      stop: 175,
      support: 180,
      target: 210,
      warnings: ["Synthetic warning"],
    },
    providerSymbol: reportId.toUpperCase(),
    quoteAt: at(-11 * MINUTE_MS),
    quoteSource: "yahoo",
    reportId,
    ...overrides,
  });

  const NO_VALUES = {
    action: "unavailable",
    blockingWarnings: [],
    buyZone: null,
    changePercent: null,
    momentumPercent: null,
    price: null,
    quoteAgeMs: null,
    reasons: [],
    rewardRisk: null,
    score: 0,
    stop: null,
    storedAction: null,
    storedScore: null,
    support: null,
    target: null,
    warnings: [],
  };

  it("answers the empty state before the first tick", async () => {
    const answer = await statusOf({});

    expect(answer).toStrictEqual({
      activeRun: null,
      evaluatedAt: NOW,
      lastRun: null,
      limitations: [...RESEARCH_SCREEN_LIMITATIONS],
      missedSlots: slotsBetween(at(-DAY_MS), NOW)
        .map((slot) => ({ at: slot.at, labels: [...slot.labels] }))
        .reverse(),
      nextSlots: slotsBetween(NOW, at(3 * DAY_MS))
        .slice(0, 12)
        .map((slot) => ({ at: slot.at, labels: [...slot.labels] })),
      rows: [],
      scheduler: { lastTickAt: null, lastTickDecision: null, state: "never" },
      swinglytics: null,
    });
    expect(answer.nextSlots).toHaveLength(12);
    expect(answer.nextSlots[0]?.at).toStrictEqual(
      new Date("2026-11-10T20:30:00.000Z")
    );
    expect(answer.missedSlots[0]?.at).toStrictEqual(SLOT);
  });

  it.each([
    [5, "ok"],
    [20, "late"],
    [40, "silent"],
  ] as const)(
    "shows a last tick %i minutes ago as %s",
    async (minutes, state) => {
      const lastTickAt = at(-minutes * MINUTE_MS);

      const answer = await statusOf({
        scheduler: { lastTickAt, lastTickDecision: "busy" },
      });

      expect(answer.scheduler).toStrictEqual({
        lastTickAt,
        lastTickDecision: "busy",
        state,
      });
    }
  );

  it("shows an active run as interrupted once its deadline and lease are both past", async () => {
    const past = { deadlineAt: at(-MINUTE_MS), total: 4 };
    const lastRun = runOf({
      finishedAt: at(-5 * 60 * MINUTE_MS),
      id: "run-0",
      leaseExpiresAt: null,
      message: "4 of 4 reports screened",
      slotAt: new Date("2026-11-10T12:00:00.000Z"),
      status: "completed",
      succeeded: 4,
      total: 4,
    });

    const interrupted = await statusOf({
      activeRun: runOf({ ...past, leaseExpiresAt: at(-1000) }),
      lastRun,
    });
    const freeLease = await statusOf({
      activeRun: runOf({ ...past, leaseExpiresAt: null }),
    });
    const liveLease = await statusOf({ activeRun: runOf(past) });
    const inTime = await statusOf({
      activeRun: runOf({ leaseExpiresAt: at(-1000) }),
    });

    expect(interrupted.activeRun).toStrictEqual({
      barsFromIbkr: 0,
      barsFromYahoo: 0,
      claimedAt: at(-MINUTE_MS),
      deadlineAt: at(-MINUTE_MS),
      failed: 0,
      finishedAt: null,
      id: "run-1",
      message: null,
      notReached: 0,
      slotAt: SLOT,
      slotLabels: ["Every 4 hours"],
      status: "interrupted",
      succeeded: 0,
      total: 4,
    });
    expect(interrupted.lastRun).toMatchObject({
      id: "run-0",
      message: "4 of 4 reports screened",
      status: "completed",
    });
    expect(freeLease.activeRun?.status).toBe("interrupted");
    expect(liveLease.activeRun?.status).toBe("running");
    expect(inTime.activeRun?.status).toBe("running");
  });

  it("lists the slots of the last 24 hours that have no run, newest first", async () => {
    const all = slotsBetween(at(-DAY_MS), NOW).map((slot) => slot.at);
    const finished = new Date("2026-11-10T16:00:00.000Z");

    const answer = await statusOf({
      activeRun: runOf(),
      runsSince: [finished],
    });

    const missed = answer.missedSlots.map((slot) => slot.at.getTime());
    expect(missed).toStrictEqual(
      all
        .map((slot) => slot.getTime())
        .filter(
          (time) => time !== SLOT.getTime() && time !== finished.getTime()
        )
        .reverse()
    );
    expect(missed).toHaveLength(all.length - 2);
    expect(answer.missedSlots[0]).toStrictEqual({
      at: new Date("2026-11-10T17:00:00.000Z"),
      labels: ["Noon"],
    });
  });

  it("maps each catalog report to a row with the read-time rule", async () => {
    const reports = [
      report("new"),
      report("mov"),
      report("exp"),
      report("bad"),
      report("err"),
      report("odd"),
    ];
    const rows = [
      null,
      // Stored for another provider symbol: a row of another instrument.
      storedRow("mov", { providerSymbol: "MOVOLD" }),
      // A review-entry whose quote is older than 4 hours.
      storedRow("exp", { quoteAt: at(-5 * 60 * MINUTE_MS) }),
      // The last attempt failed after a good observation.
      storedRow("bad", {
        attemptAt: at(-MINUTE_MS),
        attemptRunId: "run-2",
        errorCode: "provider-timeout",
        errorMessage: "Yahoo chart: request timed out",
      }),
      // Only failed attempts so far.
      storedRow("err", {
        barsSource: null,
        errorCode: "rate-limited",
        errorMessage: "Yahoo chart: HTTP 429",
        goodAt: null,
        goodRunId: null,
        historyAt: null,
        observation: null,
        quoteAt: null,
        quoteSource: null,
      }),
      // An action outside the contract, no quote time, a quote source the contract does not name.
      storedRow("odd", {
        attemptAt: null,
        goodAt: null,
        observation: {
          ...(storedRow("odd").observation as NonNullable<
            ResearchScreenRowRecord["observation"]
          >),
          action: "buy",
        },
        quoteSource: "ibkr",
      }),
    ];

    const answer = await statusOf(
      {
        rows: reports.map((item, index) => ({
          report: {
            id: item.id,
            name: item.name,
            position: index,
            providerSymbol: item.providerSymbol,
            symbol: item.symbol,
          },
          row: rows[index] ?? null,
        })),
      },
      reports
    );

    const never = {
      ...NO_VALUES,
      barsSource: null,
      collection: "never",
      errorCode: null,
      errorMessage: null,
      historyAt: null,
      lastAttemptAt: null,
      lastAttemptRunId: null,
      lastGoodAt: null,
      lastGoodRunId: null,
      quoteAt: null,
      quoteSource: null,
    };
    const values = {
      blockingWarnings: [],
      buyZone: { high: 190, low: 180 },
      changePercent: 0.5,
      momentumPercent: 4,
      price: 185,
      reasons: ["Synthetic reason"],
      rewardRisk: 2.5,
      stop: 175,
      support: 180,
      target: 210,
    };
    expect(answer.rows).toStrictEqual([
      { ...never, providerSymbol: "NEW", reportId: "new", symbol: "NEW" },
      { ...never, providerSymbol: "MOV", reportId: "mov", symbol: "MOV" },
      {
        ...values,
        action: "watch",
        barsSource: "ibkr",
        collection: "fresh",
        errorCode: null,
        errorMessage: null,
        historyAt: new Date("2026-11-10T00:00:00.000Z"),
        lastAttemptAt: at(-10 * MINUTE_MS),
        lastAttemptRunId: "run-1",
        lastGoodAt: at(-10 * MINUTE_MS),
        lastGoodRunId: "run-1",
        providerSymbol: "EXP",
        quoteAgeMs: 5 * 60 * MINUTE_MS,
        quoteAt: at(-5 * 60 * MINUTE_MS),
        quoteSource: "yahoo",
        reportId: "exp",
        score: 80,
        storedAction: "review-entry",
        storedScore: 100,
        symbol: "EXP",
        warnings: [
          "Synthetic warning",
          RESEARCH_SCREEN_WARNING_TEXTS["entry-expired"],
        ],
      },
      {
        ...values,
        action: "review-entry",
        barsSource: "ibkr",
        collection: "failed",
        errorCode: "provider-timeout",
        errorMessage: "Yahoo chart: request timed out",
        historyAt: new Date("2026-11-10T00:00:00.000Z"),
        lastAttemptAt: at(-MINUTE_MS),
        lastAttemptRunId: "run-2",
        lastGoodAt: at(-10 * MINUTE_MS),
        lastGoodRunId: "run-1",
        providerSymbol: "BAD",
        quoteAgeMs: 11 * MINUTE_MS,
        quoteAt: at(-11 * MINUTE_MS),
        quoteSource: "yahoo",
        reportId: "bad",
        score: 100,
        storedAction: "review-entry",
        storedScore: 100,
        symbol: "BAD",
        warnings: ["Synthetic warning"],
      },
      {
        ...NO_VALUES,
        barsSource: null,
        collection: "failed",
        errorCode: "rate-limited",
        errorMessage: "Yahoo chart: HTTP 429",
        historyAt: null,
        lastAttemptAt: at(-10 * MINUTE_MS),
        lastAttemptRunId: "run-1",
        lastGoodAt: null,
        lastGoodRunId: null,
        providerSymbol: "ERR",
        quoteAt: null,
        quoteSource: null,
        reportId: "err",
        symbol: "ERR",
      },
      {
        ...NO_VALUES,
        barsSource: "ibkr",
        collection: "fresh",
        errorCode: null,
        errorMessage: null,
        historyAt: new Date("2026-11-10T00:00:00.000Z"),
        lastAttemptAt: null,
        lastAttemptRunId: "run-1",
        lastGoodAt: null,
        lastGoodRunId: "run-1",
        providerSymbol: "ODD",
        quoteAt: at(-11 * MINUTE_MS),
        quoteSource: null,
        reportId: "odd",
        symbol: "ODD",
      },
    ]);
  });

  it("shows a good observation without a quote time with no quote age", async () => {
    const item = report("aaa");
    const observation = storedRow("aaa").observation as NonNullable<
      ResearchScreenRowRecord["observation"]
    >;

    const answer = await statusOf({
      rows: [
        {
          report: { ...item, position: 0 },
          row: storedRow("aaa", {
            observation: { ...observation, action: "wait", score: 20 },
            quoteAt: null,
          }),
        },
      ],
    });

    expect(answer.rows[0]).toMatchObject({
      action: "wait",
      quoteAgeMs: null,
      quoteAt: null,
      score: 20,
      storedAction: "wait",
      storedScore: 20,
    });
  });

  it("marks the Swinglytics context stale by either clock", async () => {
    const snapshot = {
      breadth: {
        above20DayPercent: 60,
        above50DayPercent: 58,
        above200DayPercent: 55,
        regime: "Synthetic",
        score: 61,
      },
      regime: { label: "Synthetic", riskLevel: null, trendStrength: null },
      scanner: { bearish: 1, bullish: 2, total: 3, withSetups: 3 },
      setups: [],
      themes: [],
      vix: { level: 15, percentile1Year: 20, regime: null, trend: null },
    };
    const fresh = {
      generatedAt: at(-60 * MINUTE_MS),
      lastAttemptAt: at(-59 * MINUTE_MS),
      lastAttemptStatus: "ok" as const,
      lastError: null,
      retrievedAt: at(-59 * MINUTE_MS),
      snapshot,
    };

    const current = await statusOf({ swinglytics: fresh });
    const future = await statusOf({
      swinglytics: { ...fresh, generatedAt: at(MINUTE_MS) },
    });
    const old = await statusOf({
      swinglytics: { ...fresh, retrievedAt: at(-5 * 60 * MINUTE_MS) },
    });
    const failedOnly = await statusOf({
      swinglytics: {
        generatedAt: null,
        lastAttemptAt: at(-MINUTE_MS),
        lastAttemptStatus: "error",
        lastError: "Swinglytics: HTTP 503",
        retrievedAt: null,
        snapshot: null,
      },
    });

    expect(current.swinglytics).toStrictEqual({
      ...fresh,
      stale: false,
      warning: SWINGLYTICS_WARNING,
    });
    expect(future.swinglytics?.stale).toBe(true);
    expect(old.swinglytics?.stale).toBe(true);
    expect(failedOnly.swinglytics).toStrictEqual({
      generatedAt: null,
      lastAttemptAt: at(-MINUTE_MS),
      lastAttemptStatus: "error",
      lastError: "Swinglytics: HTTP 503",
      retrievedAt: null,
      snapshot: null,
      stale: true,
      warning: SWINGLYTICS_WARNING,
    });
  });

  it("adds the calendar limitation after the last verified year", async () => {
    clock.at = Date.parse("2029-01-10T15:00:00.000Z");

    const answer = await statusOf({});

    expect(answer.limitations).toStrictEqual([
      ...RESEARCH_SCREEN_LIMITATIONS,
      CALENDAR_UNVERIFIED_LIMITATION,
    ]);
    expect(answer.nextSlots).toHaveLength(12);
  });
});
