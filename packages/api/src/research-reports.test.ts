import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type Repositories,
  type ResearchReportRecord,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

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
  researchReports: ResearchReportsRepository | undefined
) => {
  const repositories = (researchReports === undefined
    ? {}
    : { researchReports }) as unknown as Repositories;
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
