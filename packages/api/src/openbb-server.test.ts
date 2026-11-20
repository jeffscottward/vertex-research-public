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
  OPENBB_BLOCKED_ESCALATE_MS,
  OPENBB_BLOCKED_RETRY_TOLERANCE_MS,
  OPENBB_CFE_FALLBACK_NOTE,
  OPENBB_JOBS,
  OPENBB_ROW_SCHEMAS,
  OPENBB_TABLES,
  OpenbbBatchDocumentSchema,
  OpenbbEventsInputSchema,
  OpenbbIngestInputSchema,
  OpenbbRecordRunInputSchema,
  openbbBlockedError,
  openbbBlockedRetryAt,
} from "./contracts/openbb.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  openbb13fChanges,
  openbbIvPercentile,
  openbbNewest13fBooks,
  openbbQuarterBefore,
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
    blockedStreaks: vi.fn(async () => []),
    congressFeed: vi.fn(async () => ({ filings: [], trades: [] })),
    cot: vi.fn(async () => []),
    cusipsForSymbol: vi.fn(async () => []),
    events: vi.fn(async () => []),
    factors: vi.fn(async () => []),
    ftd: vi.fn(async () => []),
    holdings13f: vi.fn(async () => []),
    holdings13fCounts: vi.fn(async () => new Map()),
    holdings13fOfFilings: vi.fn(async () => []),
    insiderTrades: vi.fn(async () => []),
    lastRunsFor: vi.fn(async () => []),
    latestRuns: vi.fn(async () => []),
    macroPoints: vi.fn(async () => []),
    macroSeries: vi.fn(async () => []),
    optionIvDaily: vi.fn(async () => []),
    optionIvTermLatest: vi.fn(async () => []),
    otcWeekly: vi.fn(async () => []),
    recordRun: vi.fn(async (run) => ({ ...run, id: "run-1" })),
    sec13fAccessions: vi.fn(async () => []),
    sec13fFilings: vi.fn(async () => []),
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

  it("checks congress doc ids per chamber and the parsed/reason/rowCount rule", () => {
    const filing = {
      amends: false,
      chamber: "house",
      docId: "20099001",
      filedOn: "2026-11-03",
      member: "Hon. Avery Example",
      parserVersion: "house.v1",
      reason: null,
      rowCount: 1,
      stateDistrict: "ZZ01",
      status: "parsed",
      url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20099001.pdf",
    };
    const ok = (row: unknown) =>
      OPENBB_ROW_SCHEMAS.congress_filings.safeParse(row).success;
    expect(ok(filing)).toBe(true);
    expect(ok({ ...filing, chamber: "senate" })).toBe(false);
    expect(ok({ ...filing, docId: "8a1b" })).toBe(false);
    expect(ok({ ...filing, reason: "layout_unknown" })).toBe(false);
    expect(
      ok({
        ...filing,
        reason: "layout_unknown",
        rowCount: 0,
        status: "unparsed",
      })
    ).toBe(true);
    expect(
      ok({ ...filing, reason: "layout_unknown", status: "unparsed" })
    ).toBe(false);
    expect(
      ok({ ...filing, reason: null, rowCount: 0, status: "unparsed" })
    ).toBe(false);
    const trade = {
      amountHigh: null,
      amountLabel: "Over $50,000,000",
      amountLow: 50_000_001,
      asset: "Example Holdings Inc.",
      assetType: null,
      chamber: "senate",
      docId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      filedOn: "2026-11-05",
      holder: null,
      member: "Jordan Placeholder",
      rowNumber: 1,
      ticker: null,
      transactionDate: null,
      transactionType: "other",
    };
    const tradeOk = (row: unknown) =>
      OPENBB_ROW_SCHEMAS.congress_trades.safeParse(row).success;
    expect(tradeOk(trade)).toBe(true);
    expect(tradeOk({ ...trade, rowNumber: 0 })).toBe(false);
    expect(tradeOk({ ...trade, docId: trade.docId.toUpperCase() })).toBe(false);
    expect(tradeOk({ ...trade, chamber: "house" })).toBe(false);
    expect(
      OpenbbBatchDocumentSchema.safeParse({
        job: "congress-house",
        openbbVersion: null,
        schemaVersion: "openbb-batch.v1",
        tables: [{ rows: [], table: "sec_filings" }],
        warnings: [],
      }).success
    ).toBe(false);
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
    await expect(
      clientFor({ apiKey: PLAINTEXT }).openbb.ingest(batch)
    ).rejects.toMatchObject({
      message:
        "OpenBB storage is not configured on this server; nothing was saved. Set the database connection, then retry.",
    });
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

  it("stores a 13F ledger row only when its whole book is stored, and serves the skip list", async () => {
    const repos = fakes();
    const client = clientFor({ apiKey: PLAINTEXT, fakes: repos });
    const ledger = (accessionNumber: string, rows: number) => ({
      accessionNumber,
      filedOn: "2026-11-14",
      filerCik: "1067983",
      filerName: "BERKSHIRE HATHAWAY INC",
      periodEnding: "2026-09-30",
      rows,
    });
    repos.openbb.holdings13fCounts.mockResolvedValue(
      new Map([
        ["0001193125-26-000001", 2],
        ["0001193125-26-000002", 1],
      ])
    );
    const complete = ledger("0001193125-26-000001", 2);
    expect(
      await client.openbb.ingest({
        batch: {
          rows: [
            complete,
            ledger("0001193125-26-000002", 3),
            ledger("0001193125-26-000003", 1),
          ],
          table: "sec_13f_filings",
        },
        job: "sec-13f",
      })
    ).toEqual({ received: 3, table: "sec_13f_filings", written: 1 });
    expect(repos.openbb.holdings13fCounts).toHaveBeenCalledWith([
      "0001193125-26-000001",
      "0001193125-26-000002",
      "0001193125-26-000003",
    ]);
    expect(repos.openbb.upsertRows).toHaveBeenCalledWith("sec_13f_filings", [
      complete,
    ]);

    repos.openbb.sec13fAccessions.mockResolvedValue(["0001193125-26-000001"]);
    expect(await client.openbb.sec13fAccessions({})).toEqual({
      accessions: ["0001193125-26-000001"],
    });
    expect(repos.openbb.sec13fAccessions).toHaveBeenCalledWith(5000);
    await expect(
      clientFor({ fakes: repos }).openbb.sec13fAccessions({})
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
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
    expect(status.runs[0]?.blocked).toBeNull();
    expect(status.tables).toHaveLength(1);
  });

  it("reports a blocked streak with its start and the next retry time", async () => {
    const run = (job: string, status: "ok" | "blocked_upstream") => ({
      error: status === "ok" ? null : "HTTP 403 from cdn-api.cboe.com",
      finishedAt: NOW,
      id: `run-${job}`,
      job,
      openbbVersion: "1.4.0",
      rowsReceived: 0,
      rowsWritten: 0,
      startedAt: NOW,
      status,
      warnings: [],
    });
    const since = new Date(NOW.getTime() - 26 * 3_600_000);
    const repos = fakes();
    repos.openbb.latestRuns.mockResolvedValue([
      run("cboe-option-iv", "blocked_upstream"),
      run("cboe-vol-indices", "blocked_upstream"),
      run("cboe-vx-curve", "ok"),
    ]);
    repos.openbb.blockedStreaks.mockResolvedValue([
      { attempts: 3, job: "cboe-option-iv", since },
      { attempts: 1, job: "cboe-vol-indices", since: NOW },
      // A run recorded between the two reads: the streak has no blocked newest run.
      { attempts: 1, job: "cboe-vx-curve", since: NOW },
    ]);
    const status = await clientFor({ fakes: repos }).openbb.status({});
    expect(status.runs.map((item) => item.blocked)).toEqual([
      {
        attempts: 3,
        nextRetryAt: new Date(NOW.getTime() + 6 * 3_600_000),
        since,
      },
      {
        attempts: 1,
        nextRetryAt: new Date(NOW.getTime() + 3_600_000),
        since: NOW,
      },
      null,
    ]);
  });

  it("computes the retry time and the blocked text, and checks the document key", () => {
    const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
    expect(openbbBlockedRetryAt(0, NOW)).toEqual(at(1));
    expect(openbbBlockedRetryAt(1, NOW)).toEqual(at(1));
    expect(openbbBlockedRetryAt(2, NOW)).toEqual(at(6));
    expect(openbbBlockedRetryAt(5, NOW)).toEqual(at(6));
    expect(OPENBB_BLOCKED_RETRY_TOLERANCE_MS).toBe(5 * 60_000);
    expect(OPENBB_BLOCKED_ESCALATE_MS).toBe(7 * 24 * 3_600_000);
    expect(OPENBB_CFE_FALLBACK_NOTE).toBe("used the CFE settlement file");
    const blocked = { host: "cdn-api.cboe.com", httpStatus: 403 };
    expect(openbbBlockedError(blocked)).toBe("HTTP 403 from cdn-api.cboe.com");
    const document = {
      job: "cboe-vx-curve",
      openbbVersion: null,
      schemaVersion: "openbb-batch.v1",
      tables: [{ rows: [], table: "vx_curve" }],
      warnings: [],
    };
    const parse = (extra: object) =>
      OpenbbBatchDocumentSchema.safeParse({ ...document, ...extra }).success;
    expect(parse({})).toBe(true);
    expect(parse({ blocked: null })).toBe(true);
    expect(parse({ blocked })).toBe(true);
    expect(parse({ blocked: { ...blocked, httpStatus: 99 } })).toBe(false);
    expect(parse({ blocked: { ...blocked, host: "" } })).toBe(false);
    expect(parse({ blocked: { ...blocked, path: "/x" } })).toBe(false);
    expect(
      OpenbbRecordRunInputSchema.safeParse({
        error: openbbBlockedError(blocked),
        finishedAt: NOW.toISOString(),
        job: "cboe-option-iv",
        openbbVersion: null,
        rowsReceived: 0,
        rowsWritten: 0,
        startedAt: NOW.toISOString(),
        status: "blocked_upstream",
        warnings: [],
      }).success
    ).toBe(true);
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
    repos.openbb.cusipsForSymbol.mockResolvedValue(["78462F103", "78462F999"]);
    const sec = await client.openbb.sec({ symbol: "SPY" });
    expect(repos.openbb.holdings13f).toHaveBeenCalledWith("SPY", [
      "78462F103",
      "78462F999",
    ]);
    expect(repos.openbb.holdings13fOfFilings).toHaveBeenCalledWith([], "SPY", [
      "78462F103",
      "78462F999",
    ]);
    expect(sec.changes13f).toEqual([]);
    const book = (periodEnding: string, accessionNumber: string) => ({
      accessionNumber,
      filedOn: "2026-11-14",
      filerCik: "1067983",
      filerName: "BERKSHIRE HATHAWAY INC",
      periodEnding,
      rows: 1,
    });
    repos.openbb.sec13fFilings.mockResolvedValue([
      book("2026-09-30", "0001193125-26-000002"),
      book("2026-06-30", "0001193125-26-000001"),
    ]);
    repos.openbb.holdings13fOfFilings.mockResolvedValue([
      {
        accessionNumber: "0001193125-26-000002",
        assetClass: null,
        cusip: "78462F103",
        filedOn: "2026-11-14",
        filerCik: "1067983",
        filerName: "BERKSHIRE HATHAWAY INC",
        issuer: "SPDR S&P 500",
        optionType: "",
        periodEnding: "2026-09-30",
        shares: 5,
        symbol: "SPY",
        value: 3000,
        weight: null,
      },
    ]);
    const changed = await client.openbb.sec({ symbol: "SPY" });
    expect(repos.openbb.holdings13fOfFilings).toHaveBeenLastCalledWith(
      ["0001193125-26-000002", "0001193125-26-000001"],
      "SPY",
      ["78462F103", "78462F999"]
    );
    expect(changed.changes13f).toMatchObject([
      { change: "new", period: "2026-09-30", previousPeriod: "2026-06-30" },
    ]);
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

  it("names the quarter before each quarter end", () => {
    expect(
      ["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"].map(
        openbbQuarterBefore
      )
    ).toEqual(["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]);
  });

  it("computes 13F changes between consecutive full books only", () => {
    const filing = (
      filerCik: string,
      periodEnding: string,
      accessionNumber: string,
      filedOn: string
    ) => ({
      accessionNumber,
      filedOn,
      filerCik,
      filerName: `Filer ${filerCik}`,
      periodEnding,
      rows: 1,
    });
    const books = openbbNewest13fBooks([
      filing("1", "2026-09-30", "0000000001-26-000003", "2026-11-14"),
      filing("1", "2026-06-30", "0000000001-26-000002", "2026-08-14"),
      // A later original for the same period: the earliest filing (the one sec-13f picks) is used.
      filing("1", "2026-06-30", "0000000001-26-000009", "2026-08-20"),
      filing("1", "2026-03-31", "0000000001-26-000001", "2026-05-14"),
      // One book only: no change.
      filing("2", "2026-09-30", "0000000002-26-000001", "2026-11-10"),
      // Not consecutive (a quarter is missing): no change.
      filing("3", "2026-09-30", "0000000003-26-000002", "2026-11-10"),
      filing("3", "2026-03-31", "0000000003-26-000001", "2026-05-10"),
    ]);
    expect(books.get("1")?.map((book) => book.accessionNumber)).toEqual([
      "0000000001-26-000003",
      "0000000001-26-000002",
    ]);
    const row = (
      accessionNumber: string,
      cusip: string,
      optionType: "" | "call" | "put",
      shares: number | null,
      value: number
    ) => ({
      accessionNumber,
      assetClass: null,
      cusip,
      filedOn: null,
      filerCik: "1",
      filerName: "Filer 1",
      issuer: `Issuer ${cusip}`,
      optionType,
      periodEnding: "2026-09-30",
      shares,
      symbol: null,
      value,
      weight: null,
    });
    const now = "0000000001-26-000003";
    const before = "0000000001-26-000002";
    const changes = openbb13fChanges(books, [
      row(now, "AAAAAAAA1", "", 20, 2000),
      row(before, "AAAAAAAA1", "", 10, 900),
      row(now, "AAAAAAAA1", "call", 5, 100),
      row(before, "AAAAAAAA1", "call", 10, 150),
      row(now, "AAAAAAAA1", "put", null, 50),
      row(before, "AAAAAAAA1", "put", 3, 50),
      row(now, "BBBBBBBB2", "", 1, 10),
      row(before, "CCCCCCCC3", "", 7, 700),
      row("0000000002-26-000001", "AAAAAAAA1", "", 1, 1),
    ]);
    expect(
      changes.map((change) => [change.cusip, change.optionType, change.change])
    ).toEqual([
      ["AAAAAAAA1", "", "added"],
      ["CCCCCCCC3", "", "sold"],
      ["AAAAAAAA1", "call", "reduced"],
      ["AAAAAAAA1", "put", "unchanged"],
      ["BBBBBBBB2", "", "new"],
    ]);
    expect(changes[0]).toEqual({
      accessionNumber: now,
      change: "added",
      cusip: "AAAAAAAA1",
      delayDays: 45,
      filedOn: "2026-11-14",
      filerCik: "1",
      filerName: "Filer 1",
      issuer: "Issuer AAAAAAAA1",
      optionType: "",
      period: "2026-09-30",
      previousPeriod: "2026-06-30",
      previousShares: 10,
      previousValue: 900,
      shares: 20,
      value: 2000,
    });
    expect(changes[1]).toMatchObject({ shares: null, value: null });
    expect(changes[4]).toMatchObject({
      previousShares: null,
      previousValue: null,
    });
    // Ties in size sort by filer, CUSIP and option type.
    const tied = openbb13fChanges(books, [
      row(now, "BBBBBBBB2", "put", 1, 5),
      row(now, "BBBBBBBB2", "call", 1, 5),
      row(now, "AAAAAAAA1", "call", 1, 5),
    ]);
    expect(tied.map((change) => `${change.cusip}${change.optionType}`)).toEqual(
      ["AAAAAAAA1call", "BBBBBBBB2call", "BBBBBBBB2put"]
    );
    expect(openbb13fChanges(new Map([["9", []]]), [])).toEqual([]);
  });

  it("uses the real clock when no test clock is set", async () => {
    const repos = fakes();
    const result = await clientFor({ fakes: repos }).openbb.events({});
    expect(result.from < result.to).toBe(true);
  });
});
