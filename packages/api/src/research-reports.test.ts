import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type MarketBarColumns,
  type MarketBarSeries,
  type MarketBarsRepository,
  type Repositories,
  type ResearchReportRecord,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { toResearchReportSummary } from "./server/research-reports.ts";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const hex = (digit: string) => digit.repeat(64);

const report = (
  overrides: Partial<ResearchReportRecord> = {}
): ResearchReportRecord => ({
  assetType: "equity",
  companyResearchAcceptedAt: NOW,
  companyResearchReportRevision: hex("a"),
  companyResearchRevision: hex("e"),
  dataRevision: hex("a"),
  id: "AAA",
  identityStatus: "verified",
  importedAt: NOW,
  metadata: { currency: "USD", exchange: "Fixture Exchange", id: "AAA" },
  name: "Fixture A",
  position: 0,
  providerSymbol: "AAA",
  sourceUpdatedAt: null,
  status: "ready",
  symbol: "AAA",
  ...overrides,
});

const fakeRepository = (
  overrides: Partial<ResearchReportsRepository> = {}
): ResearchReportsRepository => ({
  counts: () => Promise.reject(new Error("unused")),
  getCompanyResearch: (revision) =>
    Promise.resolve(
      revision === hex("e")
        ? { body: '{"note":"accepted"}', reportId: "AAA", revision }
        : null
    ),
  getDataset: (reportId, dataRevision, dataset) =>
    Promise.resolve(
      dataRevision === hex("0")
        ? null
        : {
            body: dataset === "news" ? "not json" : `{"dataset":"${dataset}"}`,
            byteLength: 20,
            dataRevision,
            dataset,
            reportId,
            sha256: hex("c"),
          }
    ),
  getReport: (id) =>
    Promise.resolve(
      id === "AAA"
        ? report()
        : id === "BBB"
          ? report({
              companyResearchAcceptedAt: null,
              companyResearchRevision: null,
              id: "BBB",
            })
          : id === "CCC"
            ? report({ companyResearchRevision: hex("f"), id: "CCC" })
            : id === "DDD"
              ? report({ id: "DDD" })
              : null
    ),
  listCatalog: () =>
    Promise.resolve({
      categories: [
        {
          description: "Fixture group",
          id: "group",
          label: "Group",
          position: 0,
          reportIds: ["AAA"],
          sourceIds: ["source"],
        },
      ],
      reports: [report()],
    }),
  listRevisions: () => Promise.resolve([hex("b"), hex("a")]),
  replaceCatalog: () => Promise.reject(new Error("unused")),
  ...overrides,
});

const at = new Date("2026-11-01T12:00:00.000Z");
const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-04T12:00:00.000Z"),
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

const clientFor = (
  requestSession: SafeAuthSession | null,
  researchReports: ResearchReportsRepository | undefined,
  marketBars?: MarketBarsRepository
) => {
  const repositories = (researchReports === undefined
    ? {}
    : {
        ...(marketBars === undefined ? {} : { marketBars }),
        researchReports,
      }) as unknown as Repositories;
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
  message: RegExp = /.*/u
) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).toMatch(message);
  }
};

const operator = session("operator");

describe("research report summary mapping", () => {
  it("reads currency and exchange from metadata and keeps absent research null", () => {
    expect(toResearchReportSummary(report())).toMatchObject({
      companyResearch: {
        acceptedAt: NOW,
        reportRevision: hex("a"),
        revision: hex("e"),
      },
      currency: "USD",
      exchange: "Fixture Exchange",
    });
    expect(
      toResearchReportSummary(
        report({
          companyResearchAcceptedAt: null,
          metadata: { currency: 1 },
        })
      )
    ).toMatchObject({ companyResearch: null, currency: null, exchange: null });
  });
});

describe("researchReports procedures", () => {
  it("are operator-only", async () => {
    const repository = fakeRepository();
    await expectCode(
      clientFor(null, repository).researchReports.list({}),
      "UNAUTHORIZED"
    );
    await expectCode(
      clientFor(session("outsider"), repository).researchReports.dataset({
        dataset: "market",
        reportId: "AAA",
      }),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor(
        session("outsider"),
        repository
      ).researchReports.companyResearch({ reportId: "AAA" }),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor(session("outsider"), repository).researchReports.technicals({
        reportId: "AAA",
      }),
      "FORBIDDEN"
    );
  });

  it("builds the technicals of one revision from its technicals and market datasets", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      close: 10 + index,
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      high: 11 + index,
      isPartial: false,
      low: 9 + index,
      volume: 100,
    }));
    const reads: string[] = [];
    const repository = fakeRepository({
      getDataset: (reportId, dataRevision, dataset) => {
        reads.push(`${dataRevision.slice(0, 1)}:${dataset}`);
        const bodies: Record<string, string> = {
          market: JSON.stringify({
            collectedAt: "2026-01-25T22:00:00Z",
            history,
          }),
          technicals: JSON.stringify({
            asOf: "2026-01-25",
            latestClose: 34,
            portfolio: { cash: 1 },
            rsi14: 100,
            sampleCount: 25,
          }),
        };
        const body = bodies[dataset];
        return Promise.resolve(
          body === undefined || dataRevision === hex("0")
            ? null
            : {
                body,
                byteLength: body.length,
                dataRevision,
                dataset,
                reportId,
                sha256: hex("c"),
              }
        );
      },
    });
    const client = clientFor(operator, repository);
    const output = await client.researchReports.technicals({
      reportId: "AAA",
    });
    expect(reads).toEqual(["a:technicals", "a:market"]);
    expect(output).toMatchObject({
      bars: { count: 25, lastDate: "2026-01-25" },
      // The stored body has no ATR and no SMA 20, so those two differ.
      check: { mismatches: ["atr14", "sma20"], status: "mismatch" },
      dataRevision: hex("a"),
      reportId: "AAA",
      stored: { latestClose: 34, rsi14: 100, sampleCount: 25 },
    });
    expect(output.stored).not.toHaveProperty("portfolio");
    expect(output.fibonacci?.window).toBe(25);
    expect(output.volumeProfile?.sessions).toBe(25);
    expect(output.weinstein).toBeNull();

    const older = await client.researchReports.technicals({
      reportId: "AAA",
      revision: hex("b"),
    });
    expect(older.dataRevision).toBe(hex("b"));
    expect(reads.slice(2)).toEqual(["b:technicals", "b:market"]);
  });

  it("returns the stored technicals without markers when the revision has no market dataset", async () => {
    const output = await clientFor(
      operator,
      fakeRepository({
        getDataset: (reportId, dataRevision, dataset) =>
          Promise.resolve(
            dataset === "technicals"
              ? {
                  body: '{"rsi14":55}',
                  byteLength: 12,
                  dataRevision,
                  dataset,
                  reportId,
                  sha256: hex("c"),
                }
              : null
          ),
      })
    ).researchReports.technicals({ reportId: "AAA" });
    expect(output).toMatchObject({
      bars: null,
      check: { status: "unavailable" },
      stored: { rsi14: 55 },
    });
    expect(output.warnings).toHaveLength(1);
  });

  it("reports missing technicals, unknown reports and unreadable bodies", async () => {
    const client = clientFor(operator, fakeRepository());
    await expectCode(
      client.researchReports.technicals({ reportId: "ZZZ" }),
      "NOT_FOUND"
    );
    await expectCode(
      client.researchReports.technicals({
        reportId: "AAA",
        revision: hex("0"),
      }),
      "NOT_FOUND"
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          getDataset: (reportId, dataRevision, dataset) =>
            Promise.resolve({
              body: dataset === "market" ? "not json" : "{}",
              byteLength: 2,
              dataRevision,
              dataset,
              reportId,
              sha256: hex("c"),
            }),
        })
      ).researchReports.technicals({ reportId: "AAA" }),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          getDataset: (reportId, dataRevision, dataset) =>
            Promise.resolve({
              body: null,
              byteLength: 0,
              dataRevision,
              dataset,
              reportId,
              sha256: hex("c"),
            }),
        })
      ).researchReports.technicals({ reportId: "AAA" }),
      "NOT_FOUND"
    );
  });

  it("lists the catalog with its categories", async () => {
    const output = await clientFor(
      operator,
      fakeRepository()
    ).researchReports.list({});
    expect(output.categories).toEqual([
      {
        description: "Fixture group",
        id: "group",
        label: "Group",
        reportIds: ["AAA"],
      },
    ]);
    expect(output.reports[0]).toMatchObject({
      currency: "USD",
      dataRevision: hex("a"),
      id: "AAA",
      importedAt: NOW,
    });
  });

  it("reads a dataset of the current or a named revision", async () => {
    const client = clientFor(operator, fakeRepository());
    expect(
      await client.researchReports.dataset({
        dataset: "technicals",
        reportId: "AAA",
      })
    ).toEqual({
      byteLength: 20,
      data: { dataset: "technicals" },
      dataRevision: hex("a"),
      dataset: "technicals",
      reportId: "AAA",
      revisions: [hex("b"), hex("a")],
      sha256: hex("c"),
    });
    expect(
      await client.researchReports.dataset({
        dataset: "market",
        reportId: "AAA",
        revision: hex("b"),
      })
    ).toMatchObject({ data: { dataset: "market" }, dataRevision: hex("b") });
    await expectCode(
      client.researchReports.dataset({ dataset: "market", reportId: "ZZZ" }),
      "NOT_FOUND"
    );
    await expectCode(
      client.researchReports.dataset({
        dataset: "market",
        reportId: "AAA",
        revision: hex("0"),
      }),
      "NOT_FOUND"
    );
    await expectCode(
      client.researchReports.dataset({ dataset: "news", reportId: "AAA" }),
      "STORAGE_ERROR",
      /does not parse/u
    );
  });

  it("never serves the private portfolio dataset", async () => {
    const client = clientFor(operator, fakeRepository());
    await expectCode(
      client.researchReports.dataset({
        // portfolio is outside the contract on purpose; the cast sends it anyway.
        dataset: "portfolio" as unknown as "market",
        reportId: "AAA",
      }),
      "BAD_REQUEST"
    );
    const stored = clientFor(
      operator,
      fakeRepository({
        getDataset: (reportId, dataRevision, dataset) =>
          Promise.resolve({
            body: null,
            byteLength: 5,
            dataRevision,
            dataset,
            reportId,
            sha256: hex("c"),
          }),
      })
    );
    await expectCode(
      stored.researchReports.dataset({ dataset: "market", reportId: "AAA" }),
      "NOT_FOUND"
    );
  });

  it("sanitizes private broker, portfolio, NLV and order text from options-analysis responses", async () => {
    const sentinel = "SENTINEL_ROUTER_OPTIONS_418";
    const client = clientFor(
      operator,
      fakeRepository({
        getDataset: (reportId, dataRevision, dataset) =>
          Promise.resolve({
            body: JSON.stringify({
              asOf: "2026-11-22",
              brokerRefresh: { note: `${sentinel}-broker` },
              currency: "USD",
              sections: [
                {
                  body: ["Public line.", `IBKR ${sentinel} line.`],
                  id: "tenor-and-budget",
                  title: "Tenor and budget",
                },
              ],
              strategies: [
                {
                  expiry: "2027-01-15",
                  kind: "long-call",
                  legs: [
                    {
                      multiplier: 100,
                      note: `${sentinel}-leg`,
                      premium: 4.5,
                      side: "buy",
                      strike: 100,
                      type: "call",
                    },
                  ],
                  multiplier: 100,
                  name: `${sentinel}-name`,
                },
                {
                  hypothetical: false,
                  kind: "stock",
                  stockEntry: 88.88,
                  stockShares: 777,
                },
              ],
              summary: `Cap at 2% NLV after ${sentinel} limit order.`,
            }),
            byteLength: 500,
            dataRevision,
            dataset,
            reportId,
            sha256: hex("c"),
          }),
      })
    );
    const output = await client.researchReports.dataset({
      dataset: "options-analysis",
      reportId: "AAA",
    });
    const serialized = JSON.stringify(output.data);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("777");
    expect(serialized).not.toContain("88.88");
    expect(output.data).toEqual({
      asOf: "2026-11-22",
      currency: "USD",
      sections: [
        {
          body: ["Public line."],
          id: "tenor-and-budget",
          title: "Tenor and budget",
        },
      ],
      strategies: [
        {
          expiry: "2027-01-15",
          kind: "long-call",
          legs: [
            {
              multiplier: 100,
              premium: 4.5,
              side: "buy",
              strike: 100,
              type: "call",
            },
          ],
          multiplier: 100,
        },
        {
          hypothetical: false,
          kind: "stock",
        },
      ],
    });

    const sentinelPayload = JSON.stringify({
      asOf: `IBKR broker refresh ${sentinel}`,
      currency: `${sentinel}-CUR`,
      strategies: [
        {
          expiry: `${sentinel}-expiry`,
          kind: "long-call",
          legs: [],
          stockEntry: 88.88,
          stockShares: 777,
        },
        {
          kind: `${sentinel}-kind`,
        },
      ],
    });
    const sentinelClient = clientFor(
      operator,
      fakeRepository({
        getDataset: (reportId, dataRevision, dataset) =>
          Promise.resolve({
            body: sentinelPayload,
            byteLength: sentinelPayload.length,
            dataRevision,
            dataset,
            reportId,
            sha256: hex("f"),
          }),
      })
    );
    const sentinelOut = await sentinelClient.researchReports.dataset({
      dataset: "options-analysis",
      reportId: "AAA",
    });
    expect(JSON.stringify(sentinelOut.data)).not.toContain(sentinel);
    expect(JSON.stringify(sentinelOut.data)).not.toContain("777");
    expect(JSON.stringify(sentinelOut.data)).not.toContain("88.88");
    expect(sentinelOut.data).toEqual({
      strategies: [{ kind: "long-call", legs: [] }, {}],
    });
  });

  it("reads the accepted company research", async () => {
    const client = clientFor(operator, fakeRepository());
    expect(
      await client.researchReports.companyResearch({ reportId: "AAA" })
    ).toEqual({
      acceptedAt: NOW,
      data: { note: "accepted" },
      reportId: "AAA",
      reportRevision: hex("a"),
      revision: hex("e"),
    });
    // DDD's head points at a dossier stored for AAA: never served as DDD's.
    for (const reportId of ["ZZZ", "BBB", "CCC", "DDD"]) {
      await expectCode(
        client.researchReports.companyResearch({ reportId }),
        "NOT_FOUND"
      );
    }
  });

  it("maps storage failures to STORAGE_ERROR and keeps other errors internal", async () => {
    await expectCode(
      clientFor(operator, undefined).researchReports.list({}),
      "STORAGE_ERROR",
      /^Research report storage is not configured on this server/u
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({
          listCatalog: () =>
            Promise.reject(new DatabasePersistenceError("research read")),
        })
      ).researchReports.list({}),
      "STORAGE_ERROR",
      /^Research report storage: the database returned an error at \d\d:\d\d UTC\. Nothing was changed\. Try again\.$/u
    );
    await expectCode(
      clientFor(
        operator,
        fakeRepository({ listCatalog: () => Promise.reject(new Error("bug")) })
      ).researchReports.list({}),
      "INTERNAL_SERVER_ERROR"
    );
  });

  it("is published under /research-reports and not reachable with agent API keys or MCP tools", async () => {
    const document = await buildOpenApiDocument();
    expect(document.paths?.["/research-reports"]?.get?.operationId).toBe(
      "researchReports.list"
    );
    expect(
      document.paths?.["/research-reports/{reportId}/datasets/{dataset}"]?.get
        ?.operationId
    ).toBe("researchReports.dataset");
    expect(
      document.paths?.["/research-reports/{reportId}/company-research"]?.get
        ?.operationId
    ).toBe("researchReports.companyResearch");
    expect(
      document.paths?.["/research-reports/{reportId}/technicals"]?.get
        ?.operationId
    ).toBe("researchReports.technicals");
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("researchReports");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("researchReports"))
    ).toBe(false);
  });
});

const makeDailyColumns = (
  count: number,
  startUtc: number
): MarketBarColumns => {
  const t = new Float64Array(count);
  const o = new Float64Array(count);
  const h = new Float64Array(count);
  const l = new Float64Array(count);
  const c = new Float64Array(count);
  const v = new Float64Array(count);
  let day = startUtc;
  let written = 0;
  while (written < count) {
    const weekday = new Date(day).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      const price = 100 + written * 0.5;
      t[written] = day;
      o[written] = price;
      h[written] = price + 2;
      l[written] = price - 2;
      c[written] = price + 0.25;
      v[written] = 1_000_000;
      written += 1;
    }
    day += 86_400_000;
  }
  return { c, h, l, o, t, v };
};

const fakeMarketBars = (
  entries: Readonly<
    Record<
      string,
      Readonly<{ series: MarketBarSeries; columns: MarketBarColumns }>
    >
  >
): MarketBarsRepository => ({
  appendBars: () => Promise.reject(new Error("unused")),
  getSeries: (symbol, timeframe) => {
    const entry = entries[`${symbol}:${timeframe}`];
    return Promise.resolve(entry === undefined ? null : entry.series);
  },
  latestBars: () => Promise.reject(new Error("unused")),
  listSeries: () =>
    Promise.resolve(Object.values(entries).map((e) => e.series)),
  loadColumns: (seriesId) => {
    const entry = entries[seriesId];
    if (entry === undefined)
      return Promise.reject(new Error(`missing ${seriesId}`));
    return Promise.resolve(entry.columns);
  },
  replaceSeries: () => Promise.reject(new Error("unused")),
});

describe("index ETF dossiers and read-time market_bars refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds IWM and DIA to list in the SPY/QQQ category and refreshes SPY/QQQ dataDate from market_bars", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
    const cols = makeDailyColumns(260, Date.UTC(2025, 10, 24));
    const lastT = cols.t.at(-1) as number;
    const firstT = cols.t[0] as number;
    const importedAt = new Date("2026-11-23T05:00:00Z");
    const makeSeries = (symbol: string, shaDigit: string): MarketBarSeries => ({
      barCount: 260,
      firstT,
      id: `${symbol}:1d`,
      importedAt,
      lastT,
      source: "yahoo",
      sourceSha256: hex(shaDigit),
      symbol,
      timeframe: "1d",
    });
    const marketBars = fakeMarketBars({
      "DIA:1d": { columns: cols, series: makeSeries("DIA", "4") },
      "IWM:1d": { columns: cols, series: makeSeries("IWM", "3") },
      "QQQ:1d": { columns: cols, series: makeSeries("QQQ", "2") },
      "SPY:1d": { columns: cols, series: makeSeries("SPY", "1") },
    });
    const oldDate = new Date("2026-09-10T21:00:00Z");
    const repository = fakeRepository({
      listCatalog: () =>
        Promise.resolve({
          categories: [
            {
              description: "Major indices",
              id: "indices",
              label: "Indices",
              position: 0,
              reportIds: ["SPY", "QQQ"],
              sourceIds: [],
            },
            {
              description: "Single equities",
              id: "equities",
              label: "Equities",
              position: 1,
              reportIds: ["AAPL"],
              sourceIds: [],
            },
          ],
          reports: [
            report({
              assetType: "etf",
              id: "SPY",
              name: "SPDR S&P 500 ETF Trust",
              providerSymbol: "SPY",
              sourceUpdatedAt: oldDate,
              symbol: "SPY",
            }),
            report({
              assetType: "etf",
              id: "QQQ",
              name: "Invesco QQQ Trust",
              providerSymbol: "QQQ",
              sourceUpdatedAt: oldDate,
              symbol: "QQQ",
            }),
            report({
              id: "AAPL",
              name: "Apple Inc.",
              providerSymbol: "AAPL",
              sourceUpdatedAt: oldDate,
              symbol: "AAPL",
            }),
          ],
        }),
    });

    const out = await clientFor(
      operator,
      repository,
      marketBars
    ).researchReports.list({});
    const expectedLastDate = new Date(lastT).toISOString().slice(0, 10);
    expect(out.reports.map((r) => r.id)).toEqual([
      "SPY",
      "QQQ",
      "AAPL",
      "IWM",
      "DIA",
    ]);
    expect(out.categories[0]?.reportIds).toEqual(["SPY", "QQQ", "IWM", "DIA"]);
    for (const id of ["SPY", "QQQ", "IWM", "DIA"]) {
      const entry = out.reports.find((r) => r.id === id);
      expect(entry?.dataDate).toBe(expectedLastDate);
      expect(entry?.dataSource).toBe("market_bars");
      expect(entry?.freshness.status).toBe("fresh");
    }
    const aapl = out.reports.find((r) => r.id === "AAPL");
    expect(aapl?.dataDate).toBe("2026-09-10");
    expect(aapl?.dataSource).toBe("revision");
    expect(aapl?.freshness.isStale).toBe(true);
  });

  it("creates an index-etfs category when no existing category holds SPY or QQQ", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
    const cols = makeDailyColumns(5, Date.UTC(2026, 10, 16));
    const marketBars = fakeMarketBars({
      "IWM:1d": {
        columns: cols,
        series: {
          barCount: 5,
          firstT: cols.t[0] as number,
          id: "IWM:1d",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT: cols.t[4] as number,
          source: "yahoo",
          sourceSha256: hex("3"),
          symbol: "IWM",
          timeframe: "1d",
        },
      },
      "IWM:1m": {
        columns: cols,
        series: {
          barCount: 5,
          firstT: cols.t[0] as number,
          id: "IWM:1m",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT: cols.t[4] as number,
          source: "yahoo",
          sourceSha256: hex("9"),
          symbol: "IWM",
          timeframe: "1m",
        },
      },
    });
    const out = await clientFor(
      operator,
      fakeRepository(),
      marketBars
    ).researchReports.list({});
    expect(out.categories.find((c) => c.id === "index-etfs")).toMatchObject({
      label: "Index ETFs",
      reportIds: ["IWM"],
    });
  });

  it("refreshes stored QQQ technicals from market_bars by default, supports providerSymbol fallback, and pins explicit revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
    const cols = makeDailyColumns(260, Date.UTC(2025, 10, 24));
    const lastT = cols.t.at(-1) as number;
    const expectedLastDate = new Date(lastT).toISOString().slice(0, 10);
    const marketBars = fakeMarketBars({
      "ES=F:1d": {
        columns: cols,
        series: {
          barCount: 260,
          firstT: cols.t[0] as number,
          id: "ES=F:1d",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT,
          source: "yahoo",
          sourceSha256: hex("6"),
          symbol: "ES=F",
          timeframe: "1d",
        },
      },
      "QQQ:1d": {
        columns: cols,
        series: {
          barCount: 260,
          firstT: cols.t[0] as number,
          id: "QQQ:1d",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT,
          source: "yahoo",
          sourceSha256: hex("2"),
          symbol: "QQQ",
          timeframe: "1d",
        },
      },
    });
    const oldHistory = Array.from({ length: 200 }, (_, index) => ({
      close: 400 + index,
      date: new Date(Date.UTC(2025, 10, 1) + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
      high: 402 + index,
      isPartial: false,
      low: 398 + index,
      volume: 1000,
    }));
    const repository = fakeRepository({
      getDataset: (reportId, dataRevision, dataset) => {
        if (dataset === "market") {
          const body = JSON.stringify({
            collectedAt: "2026-06-01T21:00:00Z",
            history: oldHistory,
          });
          return Promise.resolve({
            body,
            byteLength: body.length,
            dataRevision,
            dataset,
            reportId,
            sha256: hex("c"),
          });
        }
        const body = JSON.stringify({ asOf: "2026-05-19", latestClose: 599 });
        return Promise.resolve({
          body,
          byteLength: body.length,
          dataRevision,
          dataset,
          reportId,
          sha256: hex("d"),
        });
      },
      getReport: (id) =>
        Promise.resolve(
          id === "QQQ"
            ? report({
                assetType: "etf",
                id: "QQQ",
                providerSymbol: "QQQ",
                symbol: "QQQ",
              })
            : id === "ES"
              ? report({
                  assetType: "future",
                  id: "ES",
                  providerSymbol: "ES=F",
                  symbol: "ES",
                })
              : null
        ),
    });

    const client = clientFor(operator, repository, marketBars);
    const liveQqq = await client.researchReports.technicals({
      reportId: "QQQ",
    });
    expect(liveQqq.bars?.source).toBe("market_bars");
    expect(liveQqq.bars?.lastDate).toBe(expectedLastDate);
    expect(liveQqq.dataDate).toBe(expectedLastDate);
    expect(liveQqq.freshness.status).toBe("fresh");
    expect(liveQqq.weinstein?.isStale).toBe(false);

    // Pinned revision stays on stored bars and is marked stale.
    const pinnedQqq = await client.researchReports.technicals({
      reportId: "QQQ",
      revision: hex("a"),
    });
    expect(pinnedQqq.bars?.source).toBe("revision");
    expect(pinnedQqq.freshness.isStale).toBe(true);

    // Provider symbol fallback for ES -> ES=F.
    const liveEs = await client.researchReports.technicals({ reportId: "ES" });
    expect(liveEs.bars?.source).toBe("market_bars");
    expect(liveEs.bars?.lastDate).toBe(expectedLastDate);
  });

  it("serves bar-backed IWM technicals and all 6 datasets, validates revision, and rejects companyResearch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
    const cols = makeDailyColumns(260, Date.UTC(2025, 10, 24));
    const lastT = cols.t.at(-1) as number;
    const expectedLastDate = new Date(lastT).toISOString().slice(0, 10);
    const rev = hex("3");
    const marketBars = fakeMarketBars({
      "IWM:1d": {
        columns: cols,
        series: {
          barCount: 260,
          firstT: cols.t[0] as number,
          id: "IWM:1d",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT,
          source: "yahoo",
          sourceSha256: rev,
          symbol: "IWM",
          timeframe: "1d",
        },
      },
    });
    const client = clientFor(operator, fakeRepository(), marketBars);

    const tech = await client.researchReports.technicals({ reportId: "IWM" });
    expect(tech.reportId).toBe("IWM");
    expect(tech.dataRevision).toBe(rev);
    expect(tech.bars?.source).toBe("market_bars");
    expect(tech.bars?.lastDate).toBe(expectedLastDate);
    expect(tech.current?.asOf).toBe(expectedLastDate);
    expect(tech.weinstein?.isStale).toBe(false);

    // Matching revision succeeds; wrong revision returns NOT_FOUND.
    const techPinned = await client.researchReports.technicals({
      reportId: "IWM",
      revision: rev,
    });
    expect(techPinned.dataRevision).toBe(rev);
    await expectCode(
      client.researchReports.technicals({
        reportId: "IWM",
        revision: hex("9"),
      }),
      "NOT_FOUND"
    );

    // Missing bar series for DIA returns NOT_FOUND.
    await expectCode(
      client.researchReports.technicals({ reportId: "DIA" }),
      "NOT_FOUND"
    );
    await expectCode(
      client.researchReports.dataset({
        dataset: "technicals",
        reportId: "DIA",
      }),
      "NOT_FOUND"
    );

    // All 6 public datasets render for bar-backed IWM.
    for (const dataset of [
      "technicals",
      "market",
      "fundamentals",
      "news",
      "options-analysis",
      "committee",
    ] as const) {
      const ds = await client.researchReports.dataset({
        dataset,
        reportId: "IWM",
      });
      expect(ds.reportId).toBe("IWM");
      expect(ds.dataRevision).toBe(rev);
      expect(ds.revisions).toEqual([rev]);
      expect(ds.byteLength).toBeGreaterThan(0);
      expect(ds.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    const dsPinned = await client.researchReports.dataset({
      dataset: "market",
      reportId: "IWM",
      revision: rev,
    });
    expect(dsPinned.dataRevision).toBe(rev);
    await expectCode(
      client.researchReports.dataset({
        dataset: "market",
        reportId: "IWM",
        revision: hex("9"),
      }),
      "NOT_FOUND"
    );
    await expectCode(
      client.researchReports.companyResearch({ reportId: "IWM" }),
      "NOT_FOUND"
    );
  });

  it("handles empty bar columns for bar-backed datasets and skips invalid bar symbols", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
    const emptyCols: MarketBarColumns = {
      c: new Float64Array([]),
      h: new Float64Array([]),
      l: new Float64Array([]),
      o: new Float64Array([]),
      t: new Float64Array([]),
      v: new Float64Array([]),
    };
    const rev = hex("5");
    const marketBars = fakeMarketBars({
      "DIA:1d": {
        columns: emptyCols,
        series: {
          barCount: 0,
          firstT: Date.UTC(2026, 10, 19),
          id: "DIA:1d",
          importedAt: new Date("2026-11-23T05:00:00Z"),
          lastT: Date.UTC(2026, 10, 20),
          source: "yahoo",
          sourceSha256: rev,
          symbol: "DIA",
          timeframe: "1d",
        },
      },
    });
    const repo = fakeRepository({
      getReport: (id) =>
        Promise.resolve(
          id === "ODD"
            ? report({
                id: "ODD",
                providerSymbol: "bad symbol",
                symbol: "bad symbol",
              })
            : null
        ),
    });
    const client = clientFor(operator, repo, marketBars);
    const techDs = await client.researchReports.dataset({
      dataset: "technicals",
      reportId: "DIA",
    });
    expect(techDs.data).toMatchObject({
      asOf: "2026-11-20",
      title: "DIA technicals",
    });
    const marketDs = await client.researchReports.dataset({
      dataset: "market",
      reportId: "DIA",
    });
    expect(marketDs.data).toMatchObject({
      asOf: "2026-11-20",
      title: "DIA market data",
    });
    const oddTech = await client.researchReports.technicals({
      reportId: "ODD",
    });
    expect(oddTech.bars).toBeNull();
  });
});
