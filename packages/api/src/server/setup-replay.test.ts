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

import { createApiClient } from "../client.ts";
import {
  SETUP_REPLAY_SETUP_IDS,
  type SetupReplayRunInput,
  SetupReplayRunInputSchema,
  setupReplaySeriesId,
} from "../contracts/setup-replay.ts";
import { createApiContext } from "./context.ts";
import { handleApiRequest } from "./handler.ts";
import { clearInstantBacktestCacheForTesting } from "./instant-backtest.ts";

const at = new Date("2026-10-18T12:00:00.000Z");
const DAY_MS = 86_400_000;
const BARS = 800;

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-19T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const seriesRow = (
  overrides: Partial<MarketBarSeries> = {}
): MarketBarSeries => ({
  barCount: BARS,
  firstT: 0,
  id: "SPY:1d",
  importedAt: at,
  lastT: (BARS - 1) * DAY_MS,
  source: "Test daily bars",
  sourceSha256: "c".repeat(64),
  symbol: "SPY",
  timeframe: "1d",
  ...overrides,
});

// Deterministic daily wave with a gap up every third bar: every preset occurs on it.
const waveColumns = (size: number): MarketBarColumns => {
  const close = Float64Array.from(
    { length: size },
    (_, index) =>
      100 + index * 0.12 + 8 * Math.sin(index / 9) + 3 * Math.sin(index / 2.3)
  );
  const open = close.map((_, index) =>
    index === 0
      ? (close[0] as number)
      : (close[index - 1] as number) + (index % 3 === 0 ? 1 : 0)
  );
  return {
    c: close,
    h: close.map(
      (value, index) => Math.max(value, open[index] as number) + 0.3
    ),
    l: close.map(
      (value, index) => Math.min(value, open[index] as number) - 0.3
    ),
    o: open,
    t: Float64Array.from({ length: size }, (_, index) => index * DAY_MS),
  };
};

const fakeRepository = (
  overrides: Partial<MarketBarsRepository> = {}
): MarketBarsRepository => ({
  getSeries: vi.fn(async () => seriesRow()),
  listSeries: vi.fn(async () => [seriesRow()]),
  loadColumns: vi.fn(async () => waveColumns(BARS)),
  replaceSeries: vi.fn(),
  ...overrides,
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  marketBars: MarketBarsRepository | undefined
) => {
  const repositories = {
    addresses: {},
    adminUsers: {},
    dashboard: {},
    featureItems: {},
    marketBars,
    profiles: {},
    userPreferences: {},
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: ["operator@domain.test"],
      repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
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

const runInput: SetupReplayRunInput = {
  maxHoldBars: 10,
  paths: 1000,
  seriesId: setupReplaySeriesId("SPY"),
  setup: "breakout20",
  stop: { kind: "atr", multiple: 1.5 },
  targetR: 2,
};

afterEach(() => clearInstantBacktestCacheForTesting());

describe("setup replay input schema", () => {
  it("accepts only the listed choices and daily series ids", () => {
    expect(runInput.seriesId).toBe("SPY:1d");
    expect(SetupReplayRunInputSchema.safeParse(runInput).success).toBe(true);
    for (const bad of [
      { seriesId: "SPY:1m" },
      { seriesId: "spy:1d" },
      { setup: "shortSqueeze" },
      { stop: { kind: "pct", multiple: 1 } },
      { stop: { kind: "atr", multiple: 2.5 } },
      { targetR: 4 },
      { maxHoldBars: 7 },
      { paths: 2000 },
    ]) {
      expect(
        SetupReplayRunInputSchema.safeParse({ ...runInput, ...bad }).success
      ).toBe(false);
    }
  });
});

describe("setupReplay procedures", () => {
  it("are operator-only", async () => {
    const repository = fakeRepository();
    await expectCode(
      clientFor(null, repository).setupReplay.presets(),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), repository).setupReplay.presets(),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(session("outsider"), repository).setupReplay.run(runInput),
      "FORBIDDEN",
      403
    );
    expect(repository.getSeries).not.toHaveBeenCalled();
  });

  it("lists the presets", async () => {
    const output = await clientFor(
      session("operator"),
      fakeRepository()
    ).setupReplay.presets();
    expect(output.presets.map((preset) => preset.id)).toEqual([
      ...SETUP_REPLAY_SETUP_IDS,
    ]);
  });

  it("replays a setup on the stored daily series and repeats the same numbers", async () => {
    const repository = fakeRepository();
    const client = clientFor(session("operator"), repository);
    const first = await client.setupReplay.run(runInput);
    expect(repository.getSeries).toHaveBeenCalledWith("SPY", "1d");
    expect(first.series).toEqual({
      bars: BARS,
      from: "1970-01-01",
      id: "SPY:1d",
      symbol: "SPY",
      to: "1972-03-10",
    });
    expect(first.summary.count).toBeGreaterThan(0);
    expect(first.summary.count).toBe(
      first.summary.targetFirst +
        first.summary.stopFirst +
        first.summary.timeExit
    );
    expect(first.occurrences).toHaveLength(first.summary.count);
    expect(first.monteCarlo?.paths).toBe(1000);
    const again = await client.setupReplay.run(runInput);
    expect(again).toEqual(first);
    // The cached columns are reused.
    expect(repository.loadColumns).toHaveBeenCalledTimes(1);
  });

  it("maps a missing series, short data and storage failures to typed errors", async () => {
    const operator = session("operator");
    await expectCode(
      clientFor(
        operator,
        fakeRepository({ getSeries: vi.fn(async () => null) })
      ).setupReplay.run(runInput),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientFor(operator, undefined).setupReplay.run(runInput),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          getSeries: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).setupReplay.run(runInput),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          loadColumns: vi.fn(async () => {
            throw new Error("down");
          }),
        })
      ).setupReplay.run(runInput),
      "STORAGE_ERROR",
      503
    );
    clearInstantBacktestCacheForTesting();
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          getSeries: vi.fn(async () => seriesRow({ barCount: 100 })),
          loadColumns: vi.fn(async () => waveColumns(100)),
        })
      ).setupReplay.run({ ...runInput, setup: "rsi2Oversold" }),
      "BAD_REQUEST",
      400
    );
  });

  it("maps other failures to internal errors", async () => {
    await expectCode(
      clientFor(
        session("operator"),
        fakeRepository({
          loadColumns: vi.fn(
            async () =>
              ({
                ...waveColumns(BARS),
                c: undefined,
              }) as unknown as MarketBarColumns
          ),
        })
      ).setupReplay.run(runInput),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });
});
