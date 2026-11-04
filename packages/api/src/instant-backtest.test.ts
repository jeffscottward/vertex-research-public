import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  INSTANT_BACKTEST_EQUITY_MAX_POINTS,
  type InstantBacktestRunInput,
  InstantBacktestRunInputSchema,
} from "./contracts/instant-backtest.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { clearInstantBacktestCacheForTesting } from "./server/instant-backtest.ts";

const at = new Date("2026-10-18T12:00:00.000Z");
const DAY_MS = 86_400_000;

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-10-19T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const seriesRow = (
  overrides: Partial<MarketBarSeries> = {}
): MarketBarSeries => ({
  id: "SPY:1d",
  symbol: "SPY",
  timeframe: "1d",
  source: "Test daily bars",
  sourceSha256: "b".repeat(64),
  barCount: 3000,
  firstT: 0,
  lastT: 2999 * DAY_MS,
  importedAt: at,
  ...overrides,
});

// A slow sine wave on a rising trend: several crossings for every rule.
const waveColumns = (size: number): MarketBarColumns => {
  const close = Float64Array.from(
    { length: size },
    (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 40)
  );
  return {
    t: Float64Array.from({ length: size }, (_, index) => index * DAY_MS),
    o: close.map((value, index) =>
      index === 0 ? value : (close[index - 1] as number)
    ),
    h: close.map((value) => value + 1),
    l: close.map((value) => value - 1),
    c: close,
  };
};

const fakeRepository = (
  overrides: Partial<MarketBarsRepository> = {}
): MarketBarsRepository => ({
  listSeries: vi.fn(async () => [seriesRow()]),
  getSeries: vi.fn(async () => seriesRow()),
  loadColumns: vi.fn(async () => waveColumns(3000)),
  replaceSeries: vi.fn(),
  ...overrides,
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  marketBars: MarketBarsRepository | undefined
) => {
  const repositories = {
    profiles: {},
    addresses: {},
    userPreferences: {},
    featureItems: {},
    adminUsers: {},
    dashboard: {},
    marketBars,
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      requireRole: async () => {
        throw denied();
      },
      operatorEmails: ["operator@domain.test"],
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const runInput: InstantBacktestRunInput = {
  symbol: "SPY",
  timeframe: "1d",
  rule: { kind: "smaCross", fast: 20, slow: 100 },
  stopLossPct: 0,
  takeProfitPct: 0,
  costBps: 2,
};

afterEach(() => clearInstantBacktestCacheForTesting());

describe("instant backtest input schema", () => {
  it("accepts both rules and rejects a fast window that is not shorter", () => {
    expect(InstantBacktestRunInputSchema.safeParse(runInput).success).toBe(
      true
    );
    expect(
      InstantBacktestRunInputSchema.safeParse({
        ...runInput,
        rule: {
          kind: "breakout",
          entryLookback: 20,
          exitLookback: 10,
          trendSma: 0,
        },
      }).success
    ).toBe(true);
    expect(
      InstantBacktestRunInputSchema.safeParse({
        ...runInput,
        rule: { kind: "smaCross", fast: 100, slow: 100 },
      }).success
    ).toBe(false);
  });

  it("accepts Yahoo continuous futures symbols such as ES=F", () => {
    expect(
      InstantBacktestRunInputSchema.safeParse({ ...runInput, symbol: "ES=F" })
        .success
    ).toBe(true);
    expect(
      InstantBacktestRunInputSchema.safeParse({ ...runInput, symbol: "es=f" })
        .success
    ).toBe(false);
  });
});

describe("instantBacktest procedures", () => {
  it("are operator-only", async () => {
    const repository = fakeRepository();
    await expectCode(
      clientFor(null, repository).instantBacktest.series(),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), repository).instantBacktest.run(runInput),
      "FORBIDDEN",
      403
    );
    expect(repository.getSeries).not.toHaveBeenCalled();
  });

  it("lists stored series", async () => {
    const output = await clientFor(
      session("operator"),
      fakeRepository()
    ).instantBacktest.series();
    expect(output.series).toEqual([
      {
        symbol: "SPY",
        timeframe: "1d",
        source: "Test daily bars",
        sourceSha256: "b".repeat(64),
        barCount: 3000,
        firstT: 0,
        lastT: 2999 * DAY_MS,
        importedAt: at.toISOString(),
      },
    ]);
  });

  it("lists the universes with Core 7 futures as the default and marks stored members", async () => {
    const output = await clientFor(
      session("operator"),
      fakeRepository({
        listSeries: vi.fn(async () => [
          seriesRow({ id: "ES=F:1d", symbol: "ES=F" }),
          seriesRow({ id: "ES=F:1m", symbol: "ES=F", timeframe: "1m" }),
          seriesRow(),
        ]),
      })
    ).instantBacktest.universes();
    expect(output.defaultUniverseId).toBe("core7-futures");
    const [futures, twins] = output.universes;
    expect(futures?.label).toBe("Core 7 futures");
    expect(futures?.members.map((member) => member.symbol)).toEqual([
      "ES=F",
      "NQ=F",
      "YM=F",
      "RTY=F",
      "GC=F",
      "SI=F",
      "CL=F",
    ]);
    expect(futures?.members[0]).toEqual({
      market: "S&P 500",
      storedTimeframes: ["1d", "1m"],
      symbol: "ES=F",
      twin: "SPY",
    });
    expect(futures?.members[1]?.storedTimeframes).toEqual([]);
    expect(twins?.label).toBe("Core 7 ETF twins");
    expect(twins?.members[0]).toMatchObject({
      storedTimeframes: ["1d"],
      symbol: "SPY",
      twin: "ES=F",
    });
  });

  it("runs a rule, caches the bars and downsamples the curve", async () => {
    const repository = fakeRepository();
    const client = clientFor(session("operator"), repository);
    const first = await client.instantBacktest.run(runInput);
    expect(first.timing.cache).toBe("miss");
    expect(first.stats.bars).toBe(3000);
    expect(first.stats.trades).toBeGreaterThan(0);
    expect(first.equity.length).toBeLessThanOrEqual(
      INSTANT_BACKTEST_EQUITY_MAX_POINTS
    );
    expect(first.equity[0]).toEqual({ t: 0, equity: 1 });
    expect(first.equity.at(-1)?.t).toBe(2999 * DAY_MS);
    const second = await client.instantBacktest.run({
      ...runInput,
      rule: {
        kind: "breakout",
        entryLookback: 30,
        exitLookback: 15,
        trendSma: 50,
      },
      stopLossPct: 8,
      takeProfitPct: 25,
    });
    expect(second.timing.cache).toBe("hit");
    expect(second.stats).not.toEqual(first.stats);
    expect(repository.loadColumns).toHaveBeenCalledTimes(1);
  });

  it("reloads when the series version changes and keeps at most four series", async () => {
    let imported = at;
    const repository = fakeRepository({
      getSeries: vi.fn(async (symbol: string) =>
        seriesRow({ id: `${symbol}:1d`, symbol, importedAt: imported })
      ),
    });
    const client = clientFor(session("operator"), repository);
    await client.instantBacktest.run(runInput);
    imported = new Date("2026-10-18T13:00:00.000Z");
    const reloaded = await client.instantBacktest.run(runInput);
    expect(reloaded.timing.cache).toBe("miss");
    for (const symbol of ["QQQ", "IWM", "DIA", "GLD"]) {
      await client.instantBacktest.run({ ...runInput, symbol });
    }
    const evicted = await client.instantBacktest.run(runInput);
    expect(evicted.timing.cache).toBe("miss");
    expect(repository.loadColumns).toHaveBeenCalledTimes(7);
  });

  it("evicts by bytes and shares a load that is in flight", async () => {
    const big = 4_000_000;
    const repository = fakeRepository({
      getSeries: vi.fn(async (symbol: string) =>
        seriesRow({ id: `${symbol}:1d`, symbol, barCount: big })
      ),
    });
    const client = clientFor(session("operator"), repository);
    await client.instantBacktest.run(runInput);
    // Two 160 MB series exceed the 256 MB budget, so the older one is dropped.
    await client.instantBacktest.run({ ...runInput, symbol: "QQQ" });
    const again = await client.instantBacktest.run(runInput);
    expect(again.timing.cache).toBe("miss");
    clearInstantBacktestCacheForTesting();
    const shared = fakeRepository();
    const sharedClient = clientFor(session("operator"), shared);
    const [first, second] = await Promise.all([
      sharedClient.instantBacktest.run(runInput),
      sharedClient.instantBacktest.run(runInput),
    ]);
    expect([first.timing.cache, second.timing.cache].sort()).toEqual([
      "hit",
      "miss",
    ]);
    expect(shared.loadColumns).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed load unless a newer version replaced it", async () => {
    let imported = at;
    const loads: Array<(error: Error) => void> = [];
    const repository = fakeRepository({
      getSeries: vi.fn(async () => seriesRow({ importedAt: imported })),
      loadColumns: vi.fn(
        () =>
          new Promise<MarketBarColumns>((_, reject) => {
            loads.push(reject);
          })
      ),
    });
    const client = clientFor(session("operator"), repository);
    const older = client.instantBacktest.run(runInput);
    await vi.waitFor(() => expect(loads).toHaveLength(1));
    imported = new Date("2026-10-18T14:00:00.000Z");
    const newer = client.instantBacktest.run(runInput);
    await vi.waitFor(() => expect(loads).toHaveLength(2));
    loads[0]?.(new Error("older load failed"));
    await expectCode(older, "STORAGE_ERROR", 503);
    loads[1]?.(new Error("newer load failed"));
    await expectCode(newer, "STORAGE_ERROR", 503);
    const retry = client.instantBacktest.run(runInput);
    await vi.waitFor(() => expect(loads).toHaveLength(3));
    loads[2]?.(new Error("retry failed"));
    await expectCode(retry, "STORAGE_ERROR", 503);
  });

  it("maps a missing series, bad windows and storage failures to typed errors", async () => {
    const operator = session("operator");
    await expectCode(
      clientFor(
        operator,
        fakeRepository({ getSeries: vi.fn(async () => null) })
      ).instantBacktest.run(runInput),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientFor(operator, fakeRepository()).instantBacktest.run({
        ...runInput,
        rule: { kind: "smaCross", fast: 20, slow: 4000 },
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      clientFor(operator, undefined).instantBacktest.series(),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          listSeries: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).instantBacktest.series(),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          listSeries: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).instantBacktest.universes(),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(null, fakeRepository()).instantBacktest.universes(),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          getSeries: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).instantBacktest.run(runInput),
      "STORAGE_ERROR",
      503
    );
    clearInstantBacktestCacheForTesting();
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          loadColumns: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).instantBacktest.run(runInput),
      "STORAGE_ERROR",
      503
    );
  });

  it("maps engine input errors to BAD_REQUEST and other failures to internal errors", async () => {
    await expectCode(
      clientFor(
        session("operator"),
        fakeRepository({
          loadColumns: vi.fn(async () => ({
            ...waveColumns(3000),
            o: Float64Array.of(1),
          })),
        })
      ).instantBacktest.run(runInput),
      "BAD_REQUEST",
      400
    );
    clearInstantBacktestCacheForTesting();
    await expectCode(
      clientFor(
        session("operator"),
        fakeRepository({
          loadColumns: vi.fn(
            async () =>
              ({
                ...waveColumns(3000),
                c: undefined,
              }) as unknown as MarketBarColumns
          ),
        })
      ).instantBacktest.run(runInput),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });
});
