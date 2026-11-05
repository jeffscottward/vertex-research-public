import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type ResearchReportRecord,
  type ResearchReportsRepository,
  type Repositories,
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
      "STORAGE_ERROR"
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
      /Research report storage unavailable/u
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
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("researchReports");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("researchReports"))
    ).toBe(false);
  });
});
