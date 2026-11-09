import { readdirSync, readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type MarketDailyColumns,
  MarketDailySeriesInputError,
  type MarketDailySeriesRepository,
  type OpenbbRepository,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";

import { createApiClient } from "./client.ts";
import {
  OPENBB_JOBS,
  OPENBB_ROW_SCHEMAS,
  OPENBB_TABLES,
  OpenbbBatchDocumentSchema,
  OpenbbEventsInputSchema,
  OpenbbIngestInputSchema,
  OpenbbRecordRunInputSchema,
} from "./contracts/openbb.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  openbbIvPercentile,
  setOpenbbClockForTesting,
} from "./server/openbb.ts";

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PLAINTEXT = "dfk_openbb_test_key";

const session = (userId: string, email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-09T15:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email,
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

type Fakes = Readonly<{
  openbb: { [K in keyof OpenbbRepository]: Mock };
  series: { [K in keyof MarketDailySeriesRepository]: Mock };
}>;

const fakes = (): Fakes => ({
  openbb: {
    cot: vi.fn(async () => []),
    events: vi.fn(async () => []),
    factors: vi.fn(async () => []),
    ftd: vi.fn(async () => []),
    holdings13f: vi.fn(async () => []),
    insiderTrades: vi.fn(async () => []),
    latestRuns: vi.fn(async () => []),
    macroPoints: vi.fn(async () => []),
    macroSeries: vi.fn(async () => []),
    optionIvDaily: vi.fn(async () => []),
    optionIvTermLatest: vi.fn(async () => []),
    otcWeekly: vi.fn(async () => []),
    recordRun: vi.fn(async (run) => ({ ...run, id: "run-1" })),
    secFilings: vi.fn(async () => []),
    shortInterest: vi.fn(async () => []),
    shortVolume: vi.fn(async () => []),
    tableStats: vi.fn(async () => []),
    upsertMacroPoints: vi.fn(async (rows: unknown[]) => rows.length),
    upsertRows: vi.fn(async (_table: string, rows: unknown[]) => rows.length),
    vxCurve: vi.fn(async () => []),
    vxCurveDates: vi.fn(async () => []),
  },
  series: {
    listSeries: vi.fn(async () => []),
    loadSeries: vi.fn(async () => new Map()),
    replaceSeries: vi.fn(),
    upsertPoints: vi.fn(
      async (_series: unknown, points: readonly { date: string }[]) => ({
        series: {},
        written: new Set(points.map((point) => point.date)).size,
      })
    ),
  },
});

const clientFor = (
  options: Readonly<{
    fakes?: Fakes;
    apiKey?: string;
    keyAccess?: "read" | "write";
    email?: string;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.fakes === undefined
      ? {}
      : {
          marketDailySeries: options.fakes
            .series as unknown as MarketDailySeriesRepository,
          openbb: options.fakes.openbb as unknown as OpenbbRepository,
        }),
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
        operatorEmails: ["owner@domain.test"],
        priceAlertsNtfy: null,
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () =>
          session("owner", options.email ?? "owner@domain.test"),
      });
      return handleApiRequest(request, context);
    },
  });
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
};

const vxRows = [
  { asOf: "2026-11-06", contractMonth: "2026-11", price: 19 },
  { asOf: "2026-10-30", contractMonth: "2026-11", price: 17 },
];

const ivRow = (underlying: string, asOf: string, atmIv30d: number | null) => ({
  asOf,
  atmIv30d,
  callIv25d30d: null,
  callOi: 1,
  callVolume: 1,
  callWall: null,
  contracts: 10,
  gammaFlip: null,
  netGex: null,
  putIv25d30d: null,
  putOi: 1,
  putVolume: 1,
  putWall: null,
  underlying,
  underlyingPrice: 100,
});

const columns = (dates: string[], close: number[]): MarketDailyColumns => ({
  adjClose: dates.map(() => null),
  close,
  dates,
  high: dates.map(() => null),
  low: dates.map(() => null),
  open: dates.map(() => null),
});

afterEach(() => setOpenbbClockForTesting(null));

const PYTHON_FIXTURES = new URL(
  "../../../services/openbb/tests/fixtures/",
  import.meta.url
);
const FIXTURE_DIRS = [
  PYTHON_FIXTURES,
  new URL("./fixtures/openbb/", import.meta.url),
];
/** Rows the Python row validator refuses; the Zod row schemas must refuse each one too. */
const INVALID_ROWS = "invalid-rows.json";
/** Edge rows the Python row validator accepts; the Zod row schemas must accept each one too. */
const VALID_EDGE_ROWS = "valid-edge-rows.json";
const RowCasesSchema = z
  .array(
    z.object({
      row: z.unknown(),
      table: z.enum(OPENBB_TABLES),
      why: z.string().min(1),
    })
  )
  .min(1);
const rowCases = (name: string) =>
  RowCasesSchema.parse(
    JSON.parse(readFileSync(new URL(name, PYTHON_FIXTURES), "utf8"))
  );

describe("openbb contract fixtures", () => {
  it("accepts every fetcher fixture document (one per job) and covers every table", () => {
    const seen = new Set<string>();
    const jobs = new Set<string>();
    for (const dir of FIXTURE_DIRS) {
      const names = readdirSync(dir).filter(
        (name) =>
          name.endsWith(".json") &&
          name !== INVALID_ROWS &&
          name !== VALID_EDGE_ROWS
      );
      for (const name of names) {
        const document = OpenbbBatchDocumentSchema.parse(
          JSON.parse(readFileSync(new URL(name, dir), "utf8"))
        );
        if (dir === PYTHON_FIXTURES) jobs.add(document.job);
        for (const { table, rows } of document.tables) {
          if (rows.length > 0) seen.add(table);
          for (const row of rows.slice(0, 2000))
            expect(OPENBB_ROW_SCHEMAS[table].safeParse(row).success).toBe(true);
        }
      }
    }
    expect([...jobs].sort()).toEqual([...OPENBB_JOBS].sort());
    expect([...seen].sort()).toEqual([...OPENBB_TABLES].sort());
  });

  it("refuses every row the Python validator refuses", () => {
    const entries = rowCases(INVALID_ROWS);
    const accepted = entries.filter(
      (entry) => OPENBB_ROW_SCHEMAS[entry.table].safeParse(entry.row).success
    );
    expect(accepted.map((entry) => `${entry.table}: ${entry.why}`)).toEqual([]);
  });

  it("accepts every edge row the Python validator accepts", () => {
    const refused = rowCases(VALID_EDGE_ROWS).filter(
      (entry) => !OPENBB_ROW_SCHEMAS[entry.table].safeParse(entry.row).success
    );
    expect(refused.map((entry) => `${entry.table}: ${entry.why}`)).toEqual([]);
  });

  it("refuses bad rows, empty or oversized chunks and inverted runs", () => {
    const row = { asOf: "2026-11-06", contractMonth: "2026-12", price: 1 };
    const ingest = (rows: unknown[]) =>
      OpenbbIngestInputSchema.safeParse({
        batch: { rows, table: "vx_curve" },
        job: "cboe-vx-curve",
      }).success;
    expect(ingest([row])).toBe(true);
    expect(ingest([])).toBe(false);
    expect(ingest(Array.from({ length: 2001 }, () => row))).toBe(false);
    expect(ingest([{ ...row, asOf: "2026-02-30" }])).toBe(false);
    expect(ingest([{ ...row, price: Number.POSITIVE_INFINITY }])).toBe(false);
    expect(ingest([{ ...row, extra: 1 }])).toBe(false);
    expect(
      OPENBB_ROW_SCHEMAS.option_iv_term.safeParse({
        asOf: "2026-11-06",
        atmIv: null,
        atmStrike: null,
        callOi: 0,
        callVolume: 0,
        dte: 0,
        expiration: "2026-11-05",
        putOi: 0,
        putVolume: 0,
        underlying: "SPY",
      }).success
    ).toBe(false);
    const run = {
      error: null,
      finishedAt: "2026-11-06T21:00:00.000Z",
      job: "fed-rates",
      openbbVersion: null,
      rowsReceived: 0,
      rowsWritten: 0,
      startedAt: "2026-11-06T21:01:00.000Z",
      status: "failed",
      warnings: [],
    };
    expect(OpenbbRecordRunInputSchema.safeParse(run).success).toBe(false);
    const iv = OPENBB_ROW_SCHEMAS.option_iv_daily.shape;
    expect(iv.atmIv30d.safeParse(0.15).success).toBe(true);
    expect(iv.atmIv30d.safeParse(11).success).toBe(false);
    expect(iv.atmIv30d.safeParse(-0.1).success).toBe(false);
    expect(iv.underlyingPrice.safeParse(0).success).toBe(false);
    expect(
      OPENBB_ROW_SCHEMAS.vx_curve.safeParse({ ...row, price: 0 }).success
    ).toBe(false);
    expect(
      OpenbbEventsInputSchema.safeParse({
        from: "2026-11-02",
        to: "2026-11-01",
      }).success
    ).toBe(false);
    expect(
      OpenbbEventsInputSchema.safeParse({ from: "2026-11-02" }).success
    ).toBe(true);
    expect(
      OpenbbBatchDocumentSchema.safeParse({
        job: "fed-rates",
        openbbVersion: null,
        schemaVersion: "openbb-batch.v1",
        tables: [{ rows: [row], table: "vx_curve" }],
        warnings: [],
      }).success
    ).toBe(false);
  });
});

describe("openbb writes", () => {
  it("needs storage, an operator and an agent write key", async () => {
    const batch = {
      batch: { rows: vxRows, table: "vx_curve" as const },
      job: "cboe-vx-curve" as const,
    };
    await expectCode(
      clientFor({ fakes: fakes() }).openbb.ingest(batch),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({ fakes: fakes() }).openbb.recordRun({
        error: null,
        finishedAt: "2026-11-06T21:00:00.000Z",
        job: "cboe-vx-curve",
        openbbVersion: null,
        rowsReceived: 0,
        rowsWritten: 0,
        startedAt: "2026-11-06T21:00:00.000Z",
        status: "failed",
        warnings: [],
      }),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({ apiKey: PLAINTEXT }).openbb.ingest(batch),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        fakes: fakes(),
        keyAccess: "read",
      }).openbb.ingest(batch),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({ email: "member@domain.test", fakes: fakes() }).openbb.status(
        {}
      ),
      "FORBIDDEN"
    );
  });

  it("refuses a table the job does not write and maps series input errors to BAD_REQUEST", async () => {
    const repos = fakes();
    const client = clientFor({ apiKey: PLAINTEXT, fakes: repos });
    await expectCode(
      client.openbb.ingest({
        batch: { rows: vxRows, table: "vx_curve" },
        job: "fed-rates",
      }),
      "BAD_REQUEST"
    );
    expect(repos.openbb.upsertRows).not.toHaveBeenCalled();
    const row = {
      close: 19,
      date: "2026-11-06",
      high: null,
      low: null,
      open: null,
      seriesId: "VIX" as const,
    };
    const batch = {
      batch: { rows: [row], table: "daily_series" as const },
      job: "cboe-vol-indices" as const,
    };
    repos.series.upsertPoints.mockRejectedValueOnce(
      new MarketDailySeriesInputError("at least 1 point needed")
    );
    const refused = await client.openbb.ingest(batch).then(
      () => null,
      (error: unknown) => error as ORPCError<string, unknown>
    );
    expect(refused?.code).toBe("BAD_REQUEST");
    expect(refused?.message).toBe("VIX: at least 1 point needed");
    repos.series.upsertPoints.mockRejectedValueOnce(new Error("db down"));
    await expectCode(client.openbb.ingest(batch), "INTERNAL_SERVER_ERROR");
  });

  it("routes vol index closes to upsertPoints, macro points and other tables to the openbb repository", async () => {
    const repos = fakes();
    const client = clientFor({ apiKey: PLAINTEXT, fakes: repos });
    const daily = await client.openbb.ingest({
      batch: {
        rows: [
          {
            close: 19,
            date: "2026-11-06",
            high: 20,
            low: 18,
            open: 18.5,
            seriesId: "VIX",
          },
          {
            close: 19.1,
            date: "2026-11-06",
            high: null,
            low: null,
            open: null,
            seriesId: "VIX",
          },
          {
            close: 21,
            date: "2026-11-06",
            high: null,
            low: null,
            open: null,
            seriesId: "VIX3M",
          },
        ],
        table: "daily_series",
      },
      job: "cboe-vol-indices",
    });
    expect(daily).toEqual({ received: 3, table: "daily_series", written: 2 });
    // `written` is what the repository stored (an imported series appends only newer dates).
    repos.series.upsertPoints.mockResolvedValueOnce({ series: {}, written: 0 });
    expect(
      (
        await client.openbb.ingest({
          batch: {
            rows: [
              {
                close: 1,
                date: "2026-11-06",
                high: null,
                low: null,
                open: null,
                seriesId: "VVIX",
              },
            ],
            table: "daily_series",
          },
          job: "cboe-vol-indices",
        })
      ).written
    ).toBe(0);
    expect(repos.series.upsertPoints).toHaveBeenCalledTimes(3);
    const [series, points] = repos.series.upsertPoints.mock.calls[0] as [
      { sourceSha256: string },
      unknown[],
    ];
    expect(series).toMatchObject({ id: "VIX", kind: "index", source: "cboe" });
    expect(series.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(points[0]).toEqual({
      adjClose: null,
      close: 19,
      date: "2026-11-06",
      high: 20,
      low: 18,
      open: 18.5,
    });

    const macroRow = {
      date: "2026-11-05",
      frequency: "daily",
      name: "EFFR",
      seriesId: "EFFR",
      source: "federal_reserve",
      unit: "percent",
      value: 3.88,
    };
    expect(
      await client.openbb.ingest({
        batch: { rows: [macroRow], table: "macro_points" },
        job: "fed-rates",
      })
    ).toEqual({ received: 1, table: "macro_points", written: 1 });
    expect(repos.openbb.upsertMacroPoints).toHaveBeenCalledWith([macroRow]);

    expect(
      await client.openbb.ingest({
        batch: { rows: vxRows, table: "vx_curve" },
        job: "cboe-vx-curve",
      })
    ).toEqual({ received: 2, table: "vx_curve", written: 2 });
    expect(repos.openbb.upsertRows).toHaveBeenCalledWith("vx_curve", vxRows);
  });

  it("records a run with parsed timestamps", async () => {
    const repos = fakes();
    const result = await clientFor({
      apiKey: PLAINTEXT,
      fakes: repos,
    }).openbb.recordRun({
      error: "fetcher exited 3",
      finishedAt: "2026-11-06T21:01:00.000Z",
      job: "cftc-cot",
      openbbVersion: "1.4.0",
      rowsReceived: 0,
      rowsWritten: 0,
      startedAt: "2026-11-06T21:00:00.000Z",
      status: "failed",
      warnings: ["x"],
    });
    expect(result).toEqual({ id: "run-1" });
    expect(repos.openbb.recordRun.mock.calls[0]?.[0]).toMatchObject({
      finishedAt: new Date("2026-11-06T21:01:00.000Z"),
      startedAt: new Date("2026-11-06T21:00:00.000Z"),
      status: "failed",
    });
  });
});

describe("openbb reads", () => {
  it("reports status", async () => {
    const repos = fakes();
    repos.openbb.latestRuns.mockResolvedValue([
      {
        error: null,
        finishedAt: NOW,
        id: "run-1",
        job: "cftc-cot",
        openbbVersion: "1.4.0",
        rowsReceived: 2,
        rowsWritten: 2,
        startedAt: NOW,
        status: "ok",
        warnings: [],
      },
    ]);
    repos.openbb.tableStats.mockResolvedValue([
      { newestDate: "2026-11-03", rows: 2, table: "openbb_cot_positions" },
    ]);
    const status = await clientFor({ fakes: repos }).openbb.status({});
    expect(status.runs[0]?.startedAt).toEqual(NOW);
    expect(status.tables).toHaveLength(1);
  });

  it("builds the vol context with ratios, the VX curve, IV percentile and term rows", async () => {
    setOpenbbClockForTesting(() => NOW);
    const repos = fakes();
    repos.series.loadSeries.mockResolvedValue(
      new Map([
        ["VIX", columns(["2026-11-05", "2026-11-06"], [18, 20])],
        ["VIX9D", columns(["2026-11-06"], [18])],
        ["VIX3M", columns(["2026-11-06"], [22])],
        // An older session: VIX3M/VIX6M must not mix dates.
        ["VIX6M", columns(["2026-11-05"], [24])],
        ["VVIX", columns([], [])],
      ])
    );
    repos.openbb.vxCurveDates.mockResolvedValue([
      "2026-11-06",
      "2026-11-05",
      "2026-11-04",
      "2026-11-03",
      "2026-11-02",
      "2026-10-30",
    ]);
    repos.openbb.vxCurve.mockResolvedValue(vxRows);
    const days = Array.from({ length: 21 }, (_, index) =>
      new Date(Date.UTC(2026, 9, 1) + index * 86_400_000)
        .toISOString()
        .slice(0, 10)
    );
    repos.openbb.optionIvDaily.mockResolvedValue([
      ...days.map((day, index) =>
        ivRow("SPY", day, index === 20 ? 0.3 : 0.1 + index / 100)
      ),
      ivRow("QQQ", "2026-11-06", 0.2),
    ]);
    repos.openbb.optionIvTermLatest.mockResolvedValue([
      {
        asOf: "2026-11-06",
        atmIv: 0.2,
        atmStrike: 590,
        callOi: 1,
        callVolume: 1,
        dte: 7,
        expiration: "2026-11-13",
        putOi: 1,
        putVolume: 1,
        underlying: "SPY",
      },
    ]);
    const context = await clientFor({ fakes: repos }).openbb.volContext({});
    expect(repos.series.loadSeries.mock.calls[0]?.[1]).toEqual({
      from: "2026-10-09",
    });
    expect(context.asOf).toBe("2026-11-06");
    expect(context.indices.map((index) => index.id)).toEqual([
      "VIX",
      "VIX9D",
      "VIX3M",
      "VIX6M",
    ]);
    expect(context.ratios).toEqual({
      vix3mVix6m: null,
      vix9dVix: 0.9,
      vixVix3m: 20 / 22,
    });
    repos.series.loadSeries.mockResolvedValueOnce(
      new Map([
        ["VIX3M", columns(["2026-11-06"], [22])],
        ["VIX6M", columns(["2026-11-06"], [0])],
      ])
    );
    expect(
      (await clientFor({ fakes: repos }).openbb.volContext({})).ratios
    ).toEqual({ vix3mVix6m: null, vix9dVix: null, vixVix3m: null });
    expect(context.vxCurve.latest).toEqual({
      asOf: "2026-11-06",
      points: [{ contractMonth: "2026-11", price: 19 }],
    });
    expect(context.vxCurve.earlier?.asOf).toBe("2026-10-30");
    expect(
      context.ivDaily.map((row) => [
        row.underlying,
        row.ivPercentile,
        row.sessions,
      ])
    ).toEqual([
      ["SPY", 100, 21],
      ["QQQ", null, 1],
    ]);
    expect(context.term).toHaveLength(1);

    const empty = fakes();
    const bare = await clientFor({ fakes: empty }).openbb.volContext({
      asOf: "2026-11-02",
    });
    expect(empty.series.loadSeries.mock.calls[0]?.[1]).toEqual({
      from: "2026-10-03",
      to: "2026-11-02",
    });
    expect(empty.openbb.vxCurve).toHaveBeenCalledWith([]);
    expect(bare).toMatchObject({
      asOf: null,
      indices: [],
      ivDaily: [],
      ratios: { vix3mVix6m: null, vix9dVix: null, vixVix3m: null },
      vxCurve: { earlier: null, latest: null },
    });
  });

  it("ranks IV within the stored window", () => {
    const window = (values: (number | null)[]) =>
      values.map((atmIv30d) => ({ atmIv30d }));
    expect(openbbIvPercentile([])).toBeNull();
    expect(
      openbbIvPercentile(window([...new Array(25).fill(0.2), null]))
    ).toBeNull();
    expect(openbbIvPercentile(window(new Array(19).fill(0.2)))).toBeNull();
    const ramp = Array.from({ length: 21 }, (_, index) => index / 100);
    expect(openbbIvPercentile(window(ramp))).toBe(100);
    expect(openbbIvPercentile(window([...ramp.slice(1), 0]))).toBe(0);
    expect(openbbIvPercentile(window([null, ...ramp.slice(0, 20), 0.1]))).toBe(
      50
    );
  });

  it("serves cot net, macro, events, shorts, sec and factors with default windows", async () => {
    setOpenbbClockForTesting(() => NOW);
    const repos = fakes();
    const client = clientFor({ fakes: repos });
    repos.openbb.cot.mockResolvedValue([
      {
        category: "leveraged_funds",
        long: 10,
        market: "ES",
        marketCode: "13874A",
        openInterest: 100,
        reportDate: "2026-11-03",
        reportType: "tff",
        short: 25,
        spreading: 3,
      },
    ]);
    const cot = await client.openbb.cot({ market: "ES" });
    expect(cot.from).toBe("2025-11-09");
    expect(cot.rows[0]).toMatchObject({ net: -15 });
    expect(cot.rows[0]).not.toHaveProperty("spreading");
    expect(repos.openbb.cot).toHaveBeenCalledWith("ES", "2025-11-09");
    await client.openbb.cot({ weeks: 1 });
    expect(repos.openbb.cot).toHaveBeenLastCalledWith(null, "2026-11-01");

    repos.openbb.macroSeries.mockResolvedValue([
      {
        firstDate: "2026-11-05",
        frequency: "daily",
        id: "EFFR",
        lastDate: "2026-11-06",
        name: "EFFR",
        pointCount: 2,
        source: "federal_reserve",
        unit: "percent",
        updatedAt: NOW,
      },
    ]);
    repos.openbb.macroPoints.mockResolvedValue([
      { date: "2026-11-05", seriesId: "EFFR", value: 3.88 },
      { date: "2026-11-05", seriesId: "SOFR", value: 3.9 },
    ]);
    const macro = await client.openbb.macro({
      from: "2026-11-01",
      ids: ["EFFR"],
    });
    expect(macro.series[0]?.points).toEqual([
      { date: "2026-11-05", value: 3.88 },
    ]);
    expect(macro.from).toBe("2026-11-01");
    expect((await client.openbb.macro({})).from).toBe("2025-10-04");
    expect(repos.openbb.macroSeries).toHaveBeenLastCalledWith(null);
    expect(repos.openbb.macroPoints).toHaveBeenLastCalledWith(
      ["EFFR"],
      "2025-10-04"
    );

    expect(await client.openbb.events({})).toEqual({
      events: [],
      from: "2026-11-01",
      to: "2026-12-08",
    });
    await client.openbb.events({
      from: "2026-11-02",
      kinds: ["fomc_statement"],
      to: "2026-11-03",
    });
    expect(repos.openbb.events).toHaveBeenLastCalledWith(
      "2026-11-02",
      "2026-11-03",
      ["fomc_statement"]
    );
    // A lone `from` after the default end gets its own 30-day window; an earlier one keeps it.
    expect(await client.openbb.events({ from: "2027-03-01" })).toMatchObject({
      from: "2027-03-01",
      to: "2027-03-31",
    });
    expect(await client.openbb.events({ from: "2026-10-01" })).toMatchObject({
      to: "2026-12-08",
    });
    await expectCode(
      client.openbb.macro({ from: "1899-12-31" }),
      "BAD_REQUEST"
    );
    await expectCode(
      client.openbb.factors({ frequency: "daily", from: "1850-01-01" }),
      "BAD_REQUEST"
    );

    repos.openbb.shortVolume.mockResolvedValue([
      {
        date: "2026-11-06",
        shortExemptVolume: 0,
        shortVolume: 25,
        symbol: "SPY",
        totalVolume: 100,
      },
      {
        date: "2026-11-05",
        shortExemptVolume: 0,
        shortVolume: 0,
        symbol: "SPY",
        totalVolume: 0,
      },
    ]);
    const shorts = await client.openbb.shorts({ symbol: " spy " });
    expect(shorts.symbol).toBe("SPY");
    expect(shorts.from).toBe("2026-09-09");
    expect(shorts.shortVolume.map((row) => row.shortRatio)).toEqual([
      0.25,
      null,
    ]);

    const ftd = {
      cusip: "78462F103",
      price: 1,
      quantity: 5,
      settlementDate: "2026-10-15",
      symbol: "SPY",
    };
    repos.openbb.ftd.mockResolvedValue([
      ftd,
      { ...ftd, settlementDate: "2026-10-14" },
    ]);
    const sec = await client.openbb.sec({ symbol: "SPY" });
    expect(repos.openbb.holdings13f).toHaveBeenCalledWith("SPY", ["78462F103"]);
    expect(repos.openbb.secFilings).toHaveBeenCalledWith("SPY", 25);
    expect(repos.openbb.insiderTrades).toHaveBeenCalledWith("SPY", 50);
    expect(sec.ftd).toHaveLength(2);

    expect((await client.openbb.factors({ frequency: "monthly" })).from).toBe(
      "2016-11-07"
    );
    expect(repos.openbb.factors).toHaveBeenLastCalledWith(
      "monthly",
      "2016-11-07"
    );
    expect((await client.openbb.factors({ frequency: "daily" })).from).toBe(
      "2025-10-04"
    );
    expect(
      await client.openbb.factors({ frequency: "daily", from: "2026-01-01" })
    ).toEqual({
      frequency: "daily",
      from: "2026-01-01",
      rows: [],
    });
  });

  it("uses the real clock when no test clock is set", async () => {
    const repos = fakes();
    const result = await clientFor({ fakes: repos }).openbb.events({});
    expect(result.from < result.to).toBe(true);
  });
});
