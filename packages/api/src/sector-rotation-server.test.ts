import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Repositories,
  SectorRotationAlertKey,
  SectorRotationPointRecord,
  SectorRotationRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { SECTOR_ROTATION_SECTORS } from "./contracts/sector-rotation.ts";
import {
  computeTimeframePoints,
  latestOf,
  quadrantChanges,
} from "./sector-rotation.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import { resetIbkrPacing } from "./server/merged-bars.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./server/merged-bars.test-support.ts";
import type { PriceAlertsNtfyConfig } from "./server/price-alerts.ts";
import {
  sectorRotationAlertLine,
  setSectorRotationOptionsForTesting,
} from "./server/sector-rotation.ts";

const NOW = new Date("2026-11-02T22:00:00.000Z");
const LAST_DATE = "2026-11-02";
const PLAINTEXT = "dfk_sector_rotation_test_key";
const NTFY: PriceAlertsNtfyConfig = {
  origin: "https://ntfy.domain.test",
  token: "tk_secret-token",
  topic: "vertex-secret-topic",
};
const PERIOD = 120;
const BARS = { "2y": 520, "5y": 1300 } as const;

/** `count` weekdays ending on LAST_DATE, oldest first. */
const weekdays = (count: number): string[] => {
  const out: string[] = [];
  const day = new Date(`${LAST_DATE}T00:00:00Z`);
  while (out.length < count) {
    if (day.getUTCDay() % 6 !== 0) out.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return out;
};

// Index k counts bars back from the last date, so a 2y and a 5y chart agree on shared dates.
const benchmarkClose = (k: number) => 100 * 1.0003 ** -k;
const sectorClose = (k: number, phase: number) =>
  benchmarkClose(k) *
  (1 + 0.05 * Math.sin((2 * Math.PI * (phase - k)) / PERIOD));

const closesOf = (count: number, close: (k: number) => number) =>
  weekdays(count).map((date, index) => ({
    close: close(count - 1 - index),
    date,
  }));

// Phases whose daily series changes quadrant exactly on the last date (found, not hand-picked).
const phaseEntering = (to: string, used: readonly number[] = []): number => {
  const benchmark = closesOf(BARS["5y"], benchmarkClose);
  for (let phase = 0; phase < PERIOD; phase += 1) {
    if (used.includes(phase)) continue;
    const points = computeTimeframePoints(
      closesOf(BARS["5y"], (k) => sectorClose(k, phase)),
      benchmark,
      "daily",
      "0000-01-01"
    );
    const last = quadrantChanges(points).at(-1);
    if (last?.date === LAST_DATE && last.to === to) return phase;
  }
  throw new Error(`no phase enters ${to}`);
};
const phaseQuiet = (): number => {
  const benchmark = closesOf(BARS["5y"], benchmarkClose);
  for (let phase = 0; phase < PERIOD; phase += 1) {
    const points = computeTimeframePoints(
      closesOf(BARS["5y"], (k) => sectorClose(k, phase)),
      benchmark,
      "daily",
      "0000-01-01"
    );
    if (quadrantChanges(points).at(-1)?.date !== LAST_DATE) return phase;
  }
  throw new Error("no quiet phase");
};

// A phase whose daily series is in `quadrant` on the last date with a streak that began 2 to 4
// bars earlier (a change the alert must still report after a missed run).
const phaseRecentStreak = (quadrant: string): number => {
  const benchmark = closesOf(BARS["5y"], benchmarkClose);
  for (let phase = 0; phase < PERIOD; phase += 1) {
    const points = computeTimeframePoints(
      closesOf(BARS["5y"], (k) => sectorClose(k, phase)),
      benchmark,
      "daily",
      "0000-01-01"
    );
    const latest = latestOf(points);
    if (
      latest?.quadrant === quadrant &&
      latest.periods >= 3 &&
      latest.periods <= 5
    )
      return phase;
  }
  throw new Error(`no recent ${quadrant} streak`);
};

const LEADING = phaseEntering("leading");
const LAGGING = phaseEntering("lagging");
const IMPROVING = phaseEntering("improving");
const QUIET = phaseQuiet();

type Spec =
  | Readonly<{ phase: number; name?: string; adjusted?: boolean }>
  | Readonly<{ status: number }>
  | Readonly<{ body: unknown }>
  | Readonly<{ short: true }>;

const chart = (
  dates: readonly string[],
  closes: readonly (number | null)[],
  meta: Record<string, unknown>,
  adjusted: boolean
) => ({
  chart: {
    result: [
      {
        indicators: {
          quote: [{ close: closes }],
          ...(adjusted ? { adjclose: [{ adjclose: closes }] } : {}),
        },
        meta,
        timestamp: dates.map((date) => Date.parse(`${date}T14:30:00Z`) / 1000),
      },
    ],
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const DEFAULT_SPECS: Record<string, Spec> = {
  SPY: { name: "SPDR S&P 500", phase: 0 },
  XLB: { adjusted: false, phase: QUIET },
  XLC: { short: true },
  XLE: { phase: LAGGING },
  XLF: { phase: QUIET },
  XLI: { phase: QUIET },
  XLK: { phase: LEADING },
  XLP: { phase: QUIET },
  XLRE: { status: 503 },
  XLU: { phase: QUIET },
  XLV: { phase: IMPROVING },
  XLY: { phase: QUIET },
};

// Yahoo stand-in: serves synthetic daily charts by symbol and range; unknown symbols are a 404.
const yahooWith = (specs: Record<string, Spec>) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    const symbol = decodeURIComponent(/chart\/([^?]+)\?/u.exec(url)?.[1] ?? "");
    const range = /range=(\w+)/u.exec(url)?.[1] as keyof typeof BARS;
    const spec = specs[symbol];
    if (spec === undefined) return json({ chart: { result: null } }, 404);
    if ("status" in spec) return json({}, spec.status);
    if ("body" in spec) return json(spec.body);
    const count = BARS[range];
    const dates = weekdays("short" in spec ? 40 : count);
    if ("short" in spec)
      return json(
        chart(
          dates,
          dates.map(() => 50),
          {},
          true
        )
      );
    const closes = dates.map((_, index) =>
      symbol === "SPY"
        ? benchmarkClose(count - 1 - index)
        : sectorClose(count - 1 - index, spec.phase)
    );
    return json(
      chart(
        dates,
        closes,
        spec.name === undefined ? {} : { shortName: spec.name },
        spec.adjusted ?? true
      )
    );
  });

// In-memory repository with the same ordering and insert-once rules as Postgres.
const memoryRepository = (initial: SectorRotationPointRecord[] = []) => {
  const points = new Map<string, SectorRotationPointRecord>();
  const keyOf = (point: SectorRotationPointRecord) =>
    `${point.timeframe}|${point.symbol}|${point.date}`;
  for (const point of initial) points.set(keyOf(point), point);
  const alerts = new Map<string, string>();
  const alertKey = (key: SectorRotationAlertKey) =>
    `${key.symbol}|${key.quadrant}|${key.enteredOn}`;
  const repository = {
    listPoints: vi.fn(async (query) =>
      [...points.values()]
        .filter(
          (point) =>
            point.timeframe === query.timeframe &&
            point.date >= query.fromDate &&
            (query.toDate === undefined || point.date <= query.toDate) &&
            (query.symbols === undefined ||
              query.symbols.includes(point.symbol))
        )
        .sort(
          (a, b) =>
            a.symbol.localeCompare(b.symbol) || a.date.localeCompare(b.date)
        )
    ),
    recordAlert: vi.fn(async (input) => {
      if (alerts.has(alertKey(input))) return false;
      alerts.set(alertKey(input), "pending");
      return true;
    }),
    recordDelivery: vi.fn(async (input) => {
      alerts.set(alertKey(input), input.delivery);
    }),
    recordChatDelivery: vi.fn(async (input) => {
      const current = alerts.get(alertKey(input));
      if (current !== "not-configured" && current !== "failed") return false;
      alerts.set(alertKey(input), input.delivery);
      return true;
    }),
    upsertPoints: vi.fn(async (next: readonly SectorRotationPointRecord[]) => {
      for (const point of next) points.set(keyOf(point), point);
      return next.length;
    }),
  } satisfies SectorRotationRepository;
  return { alerts, points, repository };
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-03T22:00:00.000Z"),
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
    repository?: SectorRotationRepository;
    ntfy?: PriceAlertsNtfyConfig | null;
    apiKey?: string;
    keyAccess?: "read" | "write";
    marketHistory?: DeployStatusConfig;
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
      : { sectorRotation: options.repository }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        access: options.keyAccess ?? "write",
        apiKeyId: "key-1",
        email: "owner@domain.test",
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "owner",
      };
    }),
  };
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
        priceAlertsNtfy: options.ntfy ?? null,
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => session("owner"),
      });
      return handleApiRequest(request, context);
    },
  });
};

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

const ntfyAccepting = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { topic: string };
  return Response.json({ event: "message", id: "msg1", topic: body.topic });
});

const useYahoo = (
  specs: Record<string, Spec> = DEFAULT_SPECS,
  now: () => Date = () => NOW
) => {
  const fetch = yahooWith(specs);
  setSectorRotationOptionsForTesting({ fetch, notify: ntfyAccepting, now });
  return fetch;
};

const stored = (
  symbol: string,
  date: string,
  quadrant: SectorRotationPointRecord["quadrant"],
  overrides: Partial<SectorRotationPointRecord> = {}
): SectorRotationPointRecord => ({
  benchmark: "SPY",
  computedAt: new Date("2026-11-02T21:00:00.000Z"),
  date,
  momentum: quadrant === "leading" || quadrant === "improving" ? 101 : 99,
  quadrant,
  ratio: quadrant === "leading" || quadrant === "weakening" ? 101 : 99,
  symbol,
  timeframe: "daily",
  ...overrides,
});

afterEach(() => {
  setSectorRotationOptionsForTesting({});
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sectorRotationAlertLine", () => {
  it("writes one fixed-format line with or without a name", () => {
    const point = {
      date: LAST_DATE,
      momentum: 100.44,
      quadrant: "leading" as const,
      ratio: 101.16,
    };
    const transition = {
      date: LAST_DATE,
      from: "improving" as const,
      name: "Technology",
      symbol: "XLK",
      to: "leading" as const,
    };
    expect(sectorRotationAlertLine(transition, point)).toBe(
      "Sector rotation: XLK (Technology) entered Leading on 2026-11-02 (latest ratio 101.2, momentum 100.4). Research only."
    );
    expect(
      sectorRotationAlertLine({ ...transition, name: null }, point)
    ).toContain("Sector rotation: XLK entered Leading");
  });
});

describe("sectorRotation.collect", () => {
  it("needs an agent API key and a repository", async () => {
    useYahoo();
    const { repository } = memoryRepository();
    await expectCode(
      clientFor({ repository }).sectorRotation.collect({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ apiKey: PLAINTEXT }).sectorRotation.collect({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        repository,
      }).sectorRotation.collect({}),
      "FORBIDDEN",
      403
    );
  });

  it("dry run computes transitions and alert lines but stores and sends nothing", async () => {
    const fetch = useYahoo();
    const { repository } = memoryRepository();
    const result = await clientFor({
      apiKey: PLAINTEXT,
      ntfy: NTFY,
      repository,
    }).sectorRotation.collect({ dryRun: true });
    expect(result.asOf).toBe(LAST_DATE);
    expect(result.dryRun).toBe(true);
    expect(result.stored).toEqual({ daily: 0, weekly: 0 });
    expect(result.fetchErrors).toEqual([
      { reason: "Too little price history", symbol: "XLC" },
      { reason: "Yahoo chart returned HTTP 503", symbol: "XLRE" },
    ]);
    expect(
      result.transitions.map((change) => [change.symbol, change.to])
    ).toEqual([
      ["XLE", "lagging"],
      ["XLK", "leading"],
      ["XLV", "improving"],
    ]);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        delivery: "dry-run",
        line: expect.stringMatching(
          /^Sector rotation: XLE \(Energy\) entered Lagging on 2026-11-02 \(latest ratio [\d.]+, momentum [\d.]+\)\. Research only\.$/u
        ),
        symbol: "XLE",
      }),
      expect.objectContaining({ delivery: "dry-run", symbol: "XLK" }),
    ]);
    expect(repository.upsertPoints).not.toHaveBeenCalled();
    expect(repository.recordAlert).not.toHaveBeenCalled();
    expect(ntfyAccepting).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(12);
    expect(fetch.mock.calls[0]?.[0]).toContain("/SPY?range=5y&interval=1d");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "user-agent": expect.stringContaining(
          "vertex-research/sector-rotation"
        ),
      },
    });
  });

  it("stores every computed date, sends each new alert once and never repeats it", async () => {
    useYahoo();
    const memory = memoryRepository();
    const client = clientFor({
      apiKey: PLAINTEXT,
      ntfy: NTFY,
      repository: memory.repository,
    });
    const first = await client.sectorRotation.collect({});
    expect(first.stored.daily).toBeGreaterThan(9 * 1000);
    expect(first.stored.weekly).toBeGreaterThan(9 * 200);
    expect(memory.repository.upsertPoints).toHaveBeenCalledTimes(2);
    expect(first.alerts.map((alert) => [alert.symbol, alert.delivery])).toEqual(
      [
        ["XLE", "sent"],
        ["XLK", "sent"],
      ]
    );
    expect(ntfyAccepting).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(String(ntfyAccepting.mock.calls[1]?.[1].body)) as {
      message: string;
      title: string;
    };
    expect(sent.title).toBe("Vertex sector rotation");
    expect(sent.message).toBe(first.alerts[1]?.line);
    expect(memory.alerts.get(`XLK|leading|${LAST_DATE}`)).toBe("sent");
    const second = await client.sectorRotation.collect({});
    expect(second.alerts).toEqual([]);
    expect(second.transitions).toHaveLength(3);
    expect(ntfyAccepting).toHaveBeenCalledTimes(2);
  });

  it("stores only final weeks and alerts a streak that began after a missed run", async () => {
    const recent = phaseRecentStreak("leading");
    // XLY: a new listing with 3 points after the warm-up, all leading (relative strength grows
    // faster each day). Its streak starts inside the window with no point before it: no alert.
    const fresh = weekdays(78);
    useYahoo({
      ...DEFAULT_SPECS,
      XLF: { phase: recent },
      XLY: {
        body: chart(
          fresh,
          fresh.map(
            (_, index) => benchmarkClose(77 - index) * 1.0001 ** (index * index)
          ),
          {},
          true
        ),
      },
    });
    const memory = memoryRepository();
    const result = await clientFor({
      apiKey: PLAINTEXT,
      repository: memory.repository,
    }).sectorRotation.collect({});
    // LAST_DATE is a Monday: its partial week is not stored; the previous Friday is.
    const weekly = await memory.repository.listPoints({
      fromDate: "2026-10-01",
      timeframe: "weekly",
    });
    expect(weekly.map((point) => point.date)).not.toContain(LAST_DATE);
    expect(weekly.map((point) => point.date)).toContain("2026-10-30");
    const xlf = result.alerts.find((alert) => alert.symbol === "XLF");
    expect(xlf).toMatchObject({ delivery: "not-configured", to: "leading" });
    expect(String(xlf?.date) < LAST_DATE).toBe(true);
    expect(String(xlf?.date) >= "2026-10-26").toBe(true);
    expect(result.transitions.map((change) => change.symbol)).not.toContain(
      "XLF"
    );
    expect(result.alerts.map((alert) => alert.symbol)).not.toContain("XLY");
    const xly = await memory.repository.listPoints({
      fromDate: "2026-01-01",
      symbols: ["XLY"],
      timeframe: "daily",
    });
    expect(xly.map((point) => point.quadrant)).toEqual([
      "leading",
      "leading",
      "leading",
    ]);
  });

  it("records not-configured when no ntfy destination is set", async () => {
    useYahoo();
    const memory = memoryRepository();
    const result = await clientFor({
      apiKey: PLAINTEXT,
      repository: memory.repository,
    }).sectorRotation.collect({});
    expect(result.alerts.map((alert) => alert.delivery)).toEqual([
      "not-configured",
      "not-configured",
    ]);
    expect(memory.alerts.get(`XLE|lagging|${LAST_DATE}`)).toBe(
      "not-configured"
    );
  });

  it("is unavailable when the benchmark or every sector fails", async () => {
    const { repository } = memoryRepository();
    const client = clientFor({ apiKey: PLAINTEXT, repository });
    useYahoo({ ...DEFAULT_SPECS, SPY: { status: 502 } });
    await expectCode(client.sectorRotation.collect({}), "UNAVAILABLE", 503);
    useYahoo({
      SPY: { phase: 0 },
      ...Object.fromEntries(
        SECTOR_ROTATION_SECTORS.map((sector) => [
          sector.symbol,
          { short: true },
        ])
      ),
    });
    await expectCode(client.sectorRotation.collect({}), "UNAVAILABLE", 503);
    expect(repository.upsertPoints).not.toHaveBeenCalled();
  });
});

describe("sectorRotation.recordChatDelivery", () => {
  const key = {
    enteredOn: LAST_DATE,
    quadrant: "lagging" as const,
    symbol: "xle",
  };

  it("needs an operator agent write key and a repository", async () => {
    const { repository } = memoryRepository();
    await expectCode(
      clientFor({ repository }).sectorRotation.recordChatDelivery({
        ...key,
        delivery: "sent",
      }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ apiKey: PLAINTEXT }).sectorRotation.recordChatDelivery({
        ...key,
        delivery: "sent",
      }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        repository,
      }).sectorRotation.recordChatDelivery({ ...key, delivery: "sent" }),
      "FORBIDDEN",
      403
    );
    expect(repository.recordChatDelivery).not.toHaveBeenCalled();
  });

  it("moves a collected not-configured alert to sent once and never inserts", async () => {
    useYahoo();
    const memory = memoryRepository();
    const client = clientFor({
      apiKey: PLAINTEXT,
      repository: memory.repository,
    });
    await client.sectorRotation.collect({});
    expect(memory.alerts.get(`XLE|lagging|${LAST_DATE}`)).toBe(
      "not-configured"
    );
    await expect(
      client.sectorRotation.recordChatDelivery({ ...key, delivery: "sent" })
    ).resolves.toEqual({ updated: true });
    expect(memory.alerts.get(`XLE|lagging|${LAST_DATE}`)).toBe("sent");
    expect(memory.repository.recordChatDelivery).toHaveBeenCalledWith({
      ...key,
      delivery: "sent",
      symbol: "XLE",
    });
    await expect(
      client.sectorRotation.recordChatDelivery({ ...key, delivery: "failed" })
    ).resolves.toEqual({ updated: false });
    await expect(
      client.sectorRotation.recordChatDelivery({
        ...key,
        delivery: "sent",
        symbol: "XLU",
      })
    ).resolves.toEqual({ updated: false });
    expect(memory.alerts.has(`XLU|lagging|${LAST_DATE}`)).toBe(false);
  });
});

describe("sectorRotation.map (stored)", () => {
  it("needs a repository and stored points", async () => {
    useYahoo();
    await expectCode(
      clientFor({}).sectorRotation.map({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        repository: memoryRepository().repository,
      }).sectorRotation.map({}),
      "NOT_FOUND",
      404
    );
  });

  it("serves 12 months of stored points in sector order, with missing sectors as errors", async () => {
    useYahoo();
    const later = new Date("2026-11-02T21:30:00.000Z");
    const { repository } = memoryRepository([
      stored("XLK", "2025-10-20", "lagging"),
      stored("XLK", "2025-11-03", "improving"),
      stored("XLK", "2026-10-30", "leading", { computedAt: later }),
      stored("XLK", LAST_DATE, "leading"),
      stored("XLB", LAST_DATE, "weakening"),
      stored("XLB", "2026-10-26", "weakening", { timeframe: "weekly" }),
    ]);
    const result = await clientFor({ repository }).sectorRotation.map({
      timeframe: "daily",
    });
    expect(result).toMatchObject({
      asOf: LAST_DATE,
      benchmark: "SPY",
      generatedAt: later.toISOString(),
      params: { trendWindow: 50 },
      source: "stored",
      timeframe: "daily",
      universe: "sectors",
    });
    expect(result.series.map((series) => series.symbol)).toEqual([
      "XLB",
      "XLK",
    ]);
    expect(result.series[1]).toMatchObject({
      latest: { periods: 2, quadrant: "leading", since: "2026-10-30" },
      name: "Technology",
    });
    // 2025-10-20 is outside the 366-day window before asOf.
    expect(result.series[1]?.points.map((point) => point.date)).toEqual([
      "2025-11-03",
      "2026-10-30",
      LAST_DATE,
    ]);
    expect(result.errors).toHaveLength(9);
    expect(result.errors[0]).toEqual({
      reason: "Not yet collected",
      symbol: "XLC",
    });
    const weekly = await clientFor({ repository }).sectorRotation.map({});
    expect(weekly).toMatchObject({ asOf: "2026-10-26", timeframe: "weekly" });
  });
});

describe("sectorRotation.map (computed)", () => {
  it("computes a custom list on request, reports bad symbols and caches for 10 minutes", async () => {
    let now = NOW;
    const fetch = useYahoo(
      {
        ...DEFAULT_SPECS,
        AAPL: { name: "Apple Inc.", phase: LEADING },
        BLANK: { name: "  ", phase: QUIET },
        BRK: { body: { chart: {} } },
        "BRK-B": { phase: QUIET },
        GAPS: {
          body: chart(["2026-10-30", LAST_DATE], [null, 0], {}, false),
        },
        NONE: { body: { chart: { result: null } } },
      },
      () => now
    );
    const client = clientFor({});
    const input = {
      timeframe: "weekly" as const,
      universe: {
        kind: "custom" as const,
        symbols: [
          "aapl",
          "XLK",
          "BLANK",
          "BRK.B",
          "BRK",
          "NONE",
          "GAPS",
          "ZZZZ",
          "XLC",
        ],
      },
    };
    const result = await client.sectorRotation.map(input);
    expect(result).toMatchObject({
      asOf: LAST_DATE,
      benchmark: "SPY",
      generatedAt: NOW.toISOString(),
      params: { trendWindow: 26 },
      source: "computed",
      universe: "custom",
    });
    expect(result.series.map((series) => [series.symbol, series.name])).toEqual(
      [
        ["AAPL", "Apple Inc."],
        ["XLK", "Technology"],
        ["BLANK", null],
        ["BRK.B", null],
      ]
    );
    expect(result.series[0]?.points.length).toBeGreaterThan(50);
    expect(String(result.series[0]?.points[0]?.date) >= "2025-11-01").toBe(
      true
    );
    expect(result.errors).toEqual([
      { reason: "Yahoo returned an unexpected document", symbol: "BRK" },
      { reason: "Yahoo has no daily bars for this symbol", symbol: "NONE" },
      { reason: "Yahoo has no daily bars for this symbol", symbol: "GAPS" },
      { reason: "Yahoo chart returned HTTP 404", symbol: "ZZZZ" },
      { reason: "Too little price history", symbol: "XLC" },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toContain(
      "https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?range=2y&interval=1d"
    );
    const calls = fetch.mock.calls.length;
    expect(await client.sectorRotation.map(input)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(calls);
    now = new Date(NOW.getTime() + 10 * 60_000);
    // A different key evicts the expired entry; the original key is fetched again.
    await client.sectorRotation.map({ ...input, timeframe: "daily" });
    await client.sectorRotation.map(input);
    expect(fetch.mock.calls.length).toBeGreaterThan(calls + 9);
  });

  it("fills an empty newest close from the quote only after the regular session", async () => {
    const dates = weekdays(BARS["2y"]);
    const closes = dates.map((_, index) =>
      index === dates.length - 1
        ? null
        : sectorClose(dates.length - 1 - index, QUIET)
    );
    const full = dates.map((_, index) =>
      sectorClose(dates.length - 1 - index, QUIET)
    );
    const opened = Date.parse(`${LAST_DATE}T14:30:00Z`) / 1000;
    const quote = (hours: number) => ({
      regularMarketPrice: sectorClose(0, QUIET),
      regularMarketTime: opened + hours * 3600,
    });
    useYahoo({
      ...DEFAULT_SPECS,
      EARLY: { body: chart(dates, closes, quote(3), true) },
      FILLED: { body: chart(dates, closes, quote(7), true) },
      // A live intraday price in the newest row is dropped until the session ends.
      LIVE: { body: chart(dates, full, quote(2), true) },
      // After the session a present close stays; a quote without a price fills nothing.
      CLOSED: { body: chart(dates, full, quote(7), true) },
      NOPRICE: {
        body: chart(
          dates,
          closes,
          { regularMarketTime: opened + 7 * 3600 },
          true
        ),
      },
      // A missing adjusted close drops that date; the raw close never fills it.
      MIXED: {
        body: {
          chart: {
            result: [
              {
                indicators: {
                  adjclose: [
                    {
                      adjclose: full.map((close, index) =>
                        index === dates.length - 5 ? null : close
                      ),
                    },
                  ],
                  quote: [{ close: full }],
                },
                timestamp: dates.map(
                  (date) => Date.parse(`${date}T14:30:00Z`) / 1000
                ),
              },
            ],
          },
        },
      },
    });
    const result = await clientFor({}).sectorRotation.map({
      timeframe: "daily",
      universe: {
        kind: "custom",
        symbols: ["FILLED", "EARLY", "LIVE", "MIXED", "CLOSED", "NOPRICE"],
      },
    });
    const mixed = result.series.find((series) => series.symbol === "MIXED");
    expect(mixed?.points.map((point) => point.date)).not.toContain(
      dates.at(-5)
    );
    expect(mixed?.points.at(-1)?.date).toBe(LAST_DATE);
    expect(
      result.series.map((series) => [series.symbol, series.points.at(-1)?.date])
    ).toEqual([
      ["FILLED", LAST_DATE],
      ["EARLY", "2026-10-30"],
      ["LIVE", "2026-10-30"],
      ["MIXED", LAST_DATE],
      ["CLOSED", LAST_DATE],
      ["NOPRICE", "2026-10-30"],
    ]);
  });

  it("computes the sectors against another benchmark and keeps at most 50 cached maps", async () => {
    const fetch = useYahoo({
      ...DEFAULT_SPECS,
      QQQ: { name: "Invesco QQQ", phase: 0 },
    });
    const client = clientFor({});
    const sectors = await client.sectorRotation.map({ benchmark: "qqq" });
    expect(sectors).toMatchObject({
      benchmark: "QQQ",
      source: "computed",
      universe: "sectors",
    });
    expect(sectors.series).toHaveLength(9);
    for (let index = 0; index < 50; index += 1)
      await client.sectorRotation.map({
        universe: { kind: "custom", symbols: [`S${index}`] },
      });
    const calls = fetch.mock.calls.length;
    await client.sectorRotation.map({ benchmark: "QQQ" });
    // The oldest entry (the QQQ sector map) was evicted.
    expect(fetch.mock.calls.length).toBe(calls + 12);
  });

  it("maps an unknown benchmark to NOT_FOUND and an outage to UNAVAILABLE", async () => {
    useYahoo({ ...DEFAULT_SPECS, DOWN: { status: 504 } });
    const client = clientFor({});
    await expectCode(
      client.sectorRotation.map({ benchmark: "NOPE" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.sectorRotation.map({ benchmark: "DOWN" }),
      "UNAVAILABLE",
      503
    );
  });

  it("uses the global fetch and the real clock without seams", async () => {
    const fetch = yahooWith(DEFAULT_SPECS);
    vi.stubGlobal("fetch", fetch);
    const result = await clientFor({}).sectorRotation.map({
      universe: { kind: "custom", symbols: ["XLK"] },
    });
    expect(result.series).toHaveLength(1);
    expect(fetch).toHaveBeenCalled();
  });
});

describe("sectorRotation.snapshot", () => {
  it("needs a repository and stored points", async () => {
    useYahoo();
    await expectCode(
      clientFor({}).sectorRotation.snapshot({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        repository: memoryRepository().repository,
      }).sectorRotation.snapshot({}),
      "NOT_FOUND",
      404
    );
  });

  it("lists current quadrants, today's changes and recent transitions for a read key", async () => {
    useYahoo();
    const quadrants = ["leading", "weakening", "lagging", "improving"] as const;
    const history: SectorRotationPointRecord[] = [];
    // XLF rotates every day for 30 days: more transitions than a snapshot lists.
    weekdays(30).forEach((date, index) => {
      history.push(stored("XLF", date, quadrants[index % 4] as "leading"));
    });
    const { repository } = memoryRepository([
      ...history,
      stored("XLK", "2026-10-29", "improving"),
      stored("XLK", "2026-10-30", "improving"),
      stored("XLK", LAST_DATE, "leading"),
      stored("XLB", "2026-10-30", "lagging"),
      stored("XLB", LAST_DATE, "lagging"),
      stored("XLE", "2026-10-30", "weakening"),
    ]);
    const result = await clientFor({
      apiKey: PLAINTEXT,
      keyAccess: "read",
      repository,
    }).sectorRotation.snapshot({});
    expect(result).toMatchObject({
      asOf: LAST_DATE,
      benchmark: "SPY",
      previousDate: "2026-10-30",
      schemaVersion: 1,
      timeframe: "daily",
    });
    expect(
      result.sectors.map((sector) => [sector.symbol, sector.date])
    ).toEqual([
      ["XLB", LAST_DATE],
      ["XLE", "2026-10-30"],
      ["XLF", LAST_DATE],
      ["XLK", LAST_DATE],
    ]);
    expect(result.sectors[3]).toMatchObject({
      name: "Technology",
      periods: 1,
      quadrant: "leading",
      since: LAST_DATE,
    });
    expect(result.changes.map((change) => change.symbol)).toEqual([
      "XLF",
      "XLK",
    ]);
    expect(result.recentTransitions).toHaveLength(20);
    expect(result.recentTransitions[0]).toMatchObject({
      date: LAST_DATE,
      symbol: "XLF",
    });
    expect(result.recentTransitions[1]).toMatchObject({
      date: LAST_DATE,
      symbol: "XLK",
    });
  });

  it("has no previous date when one period is stored", async () => {
    useYahoo();
    const { repository } = memoryRepository([
      stored("XLK", "2026-10-26", "leading", { timeframe: "weekly" }),
    ]);
    const result = await clientFor({ repository }).sectorRotation.snapshot({
      timeframe: "weekly",
    });
    expect(result).toMatchObject({
      asOf: "2026-10-26",
      changes: [],
      previousDate: null,
      recentTransitions: [],
      timeframe: "weekly",
    });
  });
});

describe("sector rotation closes from IBKR history", () => {
  const PHASES: Record<string, number> = { AAPL: LEADING };
  // IBKR ADJUSTED_LAST bars with the same synthetic closes as the Yahoo stand-in.
  const ibkrBars = (symbol: string, count: number) =>
    weekdays(count).map((date, index) =>
      historyBar(
        Date.parse(`${date}T00:00:00Z`) / 1000,
        symbol === "SPY"
          ? benchmarkClose(count - 1 - index)
          : sectorClose(count - 1 - index, PHASES[symbol] ?? QUIET)
      )
    );
  const symbolOf = (url: string) =>
    new URL(url).searchParams.get("symbol") as string;
  // SPY and AAPL: two requests fit the per-isolate pacing budget.
  const input = {
    timeframe: "daily" as const,
    universe: { kind: "custom" as const, symbols: ["AAPL"] },
  };
  const specs = {
    ...DEFAULT_SPECS,
    AAPL: { name: "Apple Inc.", phase: LEADING },
  };
  const client = () => clientFor({ marketHistory: HISTORY_CONFIG });

  beforeEach(() => {
    resetIbkrPacing();
  });

  it("computes a custom map from IBKR bars without a Yahoo request", async () => {
    const yahoo = yahooWith(specs);
    let fetchedAt = "2026-11-10T20:00:00Z";
    const history = withHistory((url) => {
      const bars = ibkrBars(symbolOf(url), BARS["2y"]);
      // A bar without a positive close is dropped.
      bars[5] = historyBar((bars[5] as { t: number }).t, 0);
      return historyResponse(url, bars, { fetchedAt, longName: "APPLE INC" });
    }, yahoo);
    setSectorRotationOptionsForTesting({
      fetch: history.fetch,
      now: () => NOW,
    });
    const result = await client().sectorRotation.map(input);
    expect(yahoo).not.toHaveBeenCalled();
    expect(history.urls.map(symbolOf)).toEqual(["SPY", "AAPL"]);
    expect(history.urls[0]).toContain("whatToShow=ADJUSTED_LAST");
    expect(history.urls[0]).toContain("duration=2+Y");
    expect(result.asOf).toBe(LAST_DATE);
    // The display name is never IBKR's contract name: no Yahoo name yet, so the symbol.
    expect(result.series.map((series) => [series.symbol, series.name])).toEqual(
      [["AAPL", "AAPL"]]
    );
    // A cached copy fetched during the session holds a live newest bar: it is dropped.
    resetIbkrPacing();
    fetchedAt = "2026-11-02T15:00:00Z";
    setSectorRotationOptionsForTesting({
      fetch: history.fetch,
      now: () => new Date(NOW.getTime() + 11 * 60_000),
    });
    expect((await client().sectorRotation.map(input)).asOf).toBe("2026-10-30");
    expect(yahoo).not.toHaveBeenCalled();
  });

  it("reads Yahoo when IBKR fails", async () => {
    const yahoo = useYahoo(specs);
    const failing = withHistory(
      () => Response.json({ error: "down" }, { status: 503 }),
      yahoo
    );
    setSectorRotationOptionsForTesting({
      fetch: failing.fetch,
      now: () => NOW,
    });
    const result = await client().sectorRotation.map(input);
    expect(failing.urls).toHaveLength(2);
    expect(yahoo).toHaveBeenCalledTimes(2);
    expect(result.series[0]?.name).toBe("Apple Inc.");
  });

  it("collects from IBKR for every symbol, or from Yahoo for every symbol when one fails", async () => {
    const yahoo = yahooWith(DEFAULT_SPECS);
    const served = withHistory(
      (url) => historyResponse(url, ibkrBars(symbolOf(url), BARS["5y"] + 10)),
      yahoo
    );
    setSectorRotationOptionsForTesting({
      fetch: served.fetch,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const collect = () =>
      clientFor({
        apiKey: PLAINTEXT,
        marketHistory: HISTORY_CONFIG,
        repository: memoryRepository().repository,
      }).sectorRotation.collect({ dryRun: true });
    expect((await collect()).asOf).toBe(LAST_DATE);
    // Scheduled run: no per-isolate budget, every symbol from IBKR, no Yahoo request.
    expect(served.urls).toHaveLength(12);
    expect(served.urls[0]).toContain("duration=5+Y");
    expect(yahoo).not.toHaveBeenCalled();
    const partial = withHistory(
      (url) =>
        symbolOf(url) === "XLK"
          ? Response.json({ error: "no_contract" }, { status: 422 })
          : historyResponse(url, ibkrBars(symbolOf(url), BARS["5y"] + 10)),
      yahoo
    );
    setSectorRotationOptionsForTesting({
      fetch: partial.fetch,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    expect((await collect()).asOf).toBe(LAST_DATE);
    // XLK fails after SPY..XLI: the run reads Yahoo for all 12 symbols.
    expect(partial.urls.map(symbolOf)).toEqual([
      "SPY",
      "XLB",
      "XLC",
      "XLE",
      "XLF",
      "XLI",
      "XLK",
    ]);
    expect(yahoo).toHaveBeenCalledTimes(12);
    // IBKR serves each symbol but the run passes its 150 s budget after the third: Yahoo for all.
    yahoo.mockClear();
    let clock = NOW.getTime();
    const slow = withHistory((url) => {
      clock += 60_000;
      return historyResponse(url, ibkrBars(symbolOf(url), BARS["5y"] + 10));
    }, yahoo);
    setSectorRotationOptionsForTesting({
      fetch: slow.fetch,
      notify: ntfyAccepting,
      now: () => new Date(clock),
    });
    expect((await collect()).asOf).toBe(LAST_DATE);
    expect(slow.urls).toHaveLength(3);
    expect(yahoo).toHaveBeenCalledTimes(12);
  });

  it("fills the days before IBKR's late first bar from Yahoo without a seam", async () => {
    const yahoo = yahooWith(specs);
    setSectorRotationOptionsForTesting({ fetch: yahoo, now: () => NOW });
    const yahooOnly = await clientFor({}).sectorRotation.map(input);
    // IBKR has the last 10 weekdays only; Yahoo fills the 510 before them.
    const late = withHistory(
      (url) =>
        historyResponse(url, ibkrBars(symbolOf(url), BARS["2y"]).slice(-10)),
      yahoo
    );
    setSectorRotationOptionsForTesting({ fetch: late.fetch, now: () => NOW });
    yahoo.mockClear();
    const merged = await client().sectorRotation.map(input);
    expect(late.urls).toHaveLength(2);
    expect(yahoo).toHaveBeenCalledTimes(2);
    expect(merged.series).toEqual(yahooOnly.series);
    // A failed gap fill keeps IBKR's 10 days (too few for a map).
    resetIbkrPacing();
    const broken = withHistory(
      (url) =>
        historyResponse(url, ibkrBars(symbolOf(url), BARS["2y"]).slice(-10)),
      yahooWith({})
    );
    setSectorRotationOptionsForTesting({ fetch: broken.fetch, now: () => NOW });
    const short = await client().sectorRotation.map(input);
    expect(short.errors).toEqual([
      { reason: "Too little price history", symbol: "AAPL" },
    ]);
  });
});
