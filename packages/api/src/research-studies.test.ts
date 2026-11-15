import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type Repositories,
  type ResearchStudyRecord,
  type ResearchStudyRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { createApiClient } from "./client.ts";
import {
  type FilterStudy,
  FilterStudySchema,
  isQcPortStudy,
  QC_PORT_EQUITY_MAX,
  type QcPortStudy,
  QcPortStudySchema,
  qcPortVerdict,
  RESEARCH_STUDY_ID_PATTERN,
  ResearchStudyDocumentSchema,
  ResearchStudyGetInputSchema,
} from "./contracts/research-studies.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import {
  ResearchStudyShapeError,
  toResearchStudy,
} from "./server/research-studies.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const metrics = {
  cagr: 0.05,
  maxDrawdown: -0.2,
  sharpe: 0.5,
  sharpeHalves: [0.4, null] as [number | null, number | null],
  trades: 120,
  tradesPerYear: 40,
};
const STUDY: FilterStudy = {
  daily: {
    costBpsPerSide: 5,
    trials: 2,
    universe: ["SPY"],
    variants: [
      {
        ...metrics,
        deflatedProbability: null,
        filter: "none",
        strategy: "breakout_20",
        verdict: null,
      },
    ],
    window: {
      days: 500,
      end: "2026-10-30",
      secondHalfStart: "2016-01-04",
      start: "2005-01-03",
    },
  },
  id: "adx-rvol-filters",
  intraday: {
    barMinutes: 5,
    costBpsPerSide: 1,
    sensitivity: { costBpsPerSide: 5, verdict: "DROP" },
    spearman: { firstHalf: 0.1, secondHalf: null },
    symbol: "SPY",
    variants: [{ ...metrics, filter: "rvol_above_1" }],
    verdict: "KEEP",
    window: {
      end: "2021-05-06",
      secondHalfStart: "2014-09-30",
      sessions: 3325,
      start: "2008-02-20",
    },
  },
  ran: "2026-10-31",
  spec: "docs/specs/research/adx-filter.md",
};
const record = (
  summary: Record<string, unknown> = STUDY
): ResearchStudyRecord => ({
  createdAt: NOW,
  id: "adx-rvol-filters",
  ranOn: "2026-10-31",
  specRef: "docs/specs/research/adx-filter.md",
  summary,
  updatedAt: NOW,
});
const RUN: QcPortStudy["runs"][number] = {
  cagr: 0.041,
  deflatedSharpe: 0.62,
  exposure: 0.31,
  maxDrawdown: -0.12,
  name: "SPY put credit vertical",
  sharpe: 0.7,
  skipped: 2,
  symbols: ["SPY"],
  trades: 84,
  winRate: 0.71,
  worstMonth: { month: "2020-03", ret: -0.06 },
};
const CRITERIA: QcPortStudy["criteria"] = {
  beatBaseline: false,
  maxDrawdown: 0.25,
  minDeflatedSharpe: 0.5,
  minSharpe: 0.5,
};
const QC_STUDY: QcPortStudy = {
  criteria: CRITERIA,
  equity: [
    { t: "2020-01", v: 100_000 },
    { t: "2020-02", v: 101_000 },
  ],
  gates: [
    {
      after: { maxDrawdown: -0.08, sharpe: 0.8, trades: 40 },
      before: { maxDrawdown: -0.12, sharpe: 0.6, trades: 84 },
      gate: "IV rank >= 50",
      host: "qc-regime-put-vrp",
    },
  ],
  id: "qc-iv-rank-gate",
  kind: "qc-port",
  notes: "Option prices MODELED.",
  provenance: {
    codeRevision: "0123456789abcdef0123456789abcdef01234567",
    dataSha256: "ab".repeat(32),
    engine: "nautilus_trader 1.221.0",
    runId: "qc-ports-2026-11-08",
  },
  ran: "2026-11-08",
  runs: [RUN],
  spec: "docs/specs/strategies/qc-iv-rank-gate.md",
  title: "IV-Rank Gate for Credit Spreads",
  verdict: "PASS",
};

describe("qc-port study contract", () => {
  it("accepts a qc-port document with or without gates and null statistics", () => {
    expect(QcPortStudySchema.parse(QC_STUDY)).toEqual(QC_STUDY);
    const { gates: _gates, ...noGates } = QC_STUDY;
    const nullRun = {
      ...RUN,
      cagr: null,
      deflatedSharpe: null,
      sharpe: null,
      winRate: null,
      worstMonth: null,
    };
    expect(
      QcPortStudySchema.safeParse({
        ...noGates,
        equity: [],
        runs: [nullRun],
        verdict: "FAIL",
      }).success
    ).toBe(true);
  });

  it("recomputes the verdict from runs[0] and the stored criteria and rejects a mismatch", () => {
    const verdictOf = (patch: Partial<QcPortStudy["runs"][number]>) =>
      qcPortVerdict([{ ...RUN, ...patch }], CRITERIA);
    expect(verdictOf({})).toBe("PASS");
    // Every bound is strict.
    expect(verdictOf({ sharpe: 0.5 })).toBe("FAIL");
    expect(verdictOf({ sharpe: null })).toBe("FAIL");
    expect(verdictOf({ deflatedSharpe: 0.5 })).toBe("FAIL");
    expect(verdictOf({ deflatedSharpe: null })).toBe("FAIL");
    expect(verdictOf({ maxDrawdown: -0.25 })).toBe("FAIL");
    expect(verdictOf({ maxDrawdown: 0.25 })).toBe("FAIL");
    expect(verdictOf({ maxDrawdown: 0.2 })).toBe("PASS");
    expect(qcPortVerdict([], CRITERIA)).toBe("FAIL");
    const beat = { ...CRITERIA, beatBaseline: true };
    expect(qcPortVerdict([RUN, { ...RUN, sharpe: 0.69 }], beat)).toBe("PASS");
    expect(qcPortVerdict([RUN, { ...RUN, sharpe: 0.7 }], beat)).toBe("FAIL");
    expect(qcPortVerdict([RUN, { ...RUN, sharpe: null }], beat)).toBe("PASS");
    expect(qcPortVerdict([RUN], beat)).toBe("FAIL");

    const issues = (patch: Record<string, unknown>) =>
      QcPortStudySchema.safeParse({ ...QC_STUDY, ...patch }).error?.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      );
    expect(issues({ verdict: "FAIL" })).toEqual([
      "verdict: Expected verdict PASS: runs[0] against the stored criteria",
    ]);
    expect(issues({ criteria: { ...CRITERIA, minSharpe: 0.8 } })).toEqual([
      "verdict: Expected verdict FAIL: runs[0] against the stored criteria",
    ]);
    expect(issues({ criteria: { ...CRITERIA, beatBaseline: true } })).toEqual([
      "runs: beatBaseline needs a baseline run (runs[1])",
    ]);
    expect(
      issues({
        criteria: { ...CRITERIA, beatBaseline: true },
        runs: [RUN, { ...RUN, sharpe: 0.9 }],
        verdict: "FAIL",
      })
    ).toBeUndefined();
  });

  it("requires provenance, criteria and a qc spec path whose slug is the id", () => {
    const valid = (patch: Record<string, unknown>) =>
      QcPortStudySchema.safeParse({ ...QC_STUDY, ...patch }).success;
    const { provenance: _p, ...noProvenance } = QC_STUDY;
    const { criteria: _c, ...noCriteria } = QC_STUDY;
    expect(QcPortStudySchema.safeParse(noProvenance).success).toBe(false);
    expect(QcPortStudySchema.safeParse(noCriteria).success).toBe(false);
    for (const provenance of [
      { ...QC_STUDY.provenance, codeRevision: "0123abc" },
      { ...QC_STUDY.provenance, codeRevision: "G".repeat(40) },
      { ...QC_STUDY.provenance, dataSha256: "ab" },
      { ...QC_STUDY.provenance, engine: "" },
      { ...QC_STUDY.provenance, runId: "run id" },
      { ...QC_STUDY.provenance, extra: 1 },
    ])
      expect(valid({ provenance })).toBe(false);
    expect(valid({ criteria: { ...CRITERIA, maxDrawdown: 0 } })).toBe(false);
    expect(valid({ criteria: { ...CRITERIA, minDeflatedSharpe: 1.1 } })).toBe(
      false
    );
    expect(valid({ spec: "docs/specs/research/adx-filter.md" })).toBe(false);
    expect(valid({ spec: "docs/specs/strategies/qc-iv-rank-gate.txt" })).toBe(
      false
    );
    expect(
      QcPortStudySchema.safeParse({
        ...QC_STUDY,
        spec: "docs/specs/strategies/qc-opex-week.md",
      }).error?.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    ).toEqual(["id: Expected id to equal the spec slug qc-opex-week"]);
  });

  it("rejects bad months, unordered or oversized equity, bad verdicts and extra keys", () => {
    const bad = (patch: Record<string, unknown>) =>
      QcPortStudySchema.safeParse({ ...QC_STUDY, ...patch }).success;
    expect(bad({ verdict: "KEEP" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ runs: [] })).toBe(false);
    expect(bad({ runs: [{ ...RUN, exposure: 1.5 }] })).toBe(false);
    expect(
      bad({ runs: [{ ...RUN, worstMonth: { month: "2020-13", ret: 0 } }] })
    ).toBe(false);
    expect(
      bad({
        equity: [
          { t: "2020-02", v: 1 },
          { t: "2020-01", v: 1 },
        ],
      })
    ).toBe(false);
    expect(
      bad({
        equity: [
          { t: "2020-01", v: 1 },
          { t: "2020-01", v: 1 },
        ],
      })
    ).toBe(false);
    expect(bad({ equity: [{ t: "2020-01", v: 0 }] })).toBe(false);
    const months = Array.from({ length: QC_PORT_EQUITY_MAX + 1 }, (_, i) => ({
      t: `${1900 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      v: 1,
    }));
    expect(bad({ equity: months.slice(0, QC_PORT_EQUITY_MAX) })).toBe(true);
    expect(bad({ equity: months })).toBe(false);
  });

  it("selects the schema by kind; a document without kind is a filter study", () => {
    expect(ResearchStudyDocumentSchema.parse(STUDY)).toEqual(STUDY);
    expect(
      ResearchStudyDocumentSchema.parse({ ...STUDY, kind: "filter" })
    ).toEqual({ ...STUDY, kind: "filter" });
    expect(ResearchStudyDocumentSchema.parse(QC_STUDY)).toEqual(QC_STUDY);
    expect(
      ResearchStudyDocumentSchema.safeParse({ ...QC_STUDY, kind: "other" })
        .success
    ).toBe(false);
    expect(
      ResearchStudyDocumentSchema.safeParse({ ...STUDY, kind: "qc-port" })
        .success
    ).toBe(false);
    expect(isQcPortStudy(QC_STUDY)).toBe(true);
    expect(isQcPortStudy(STUDY)).toBe(false);
  });
});

describe("research study contract", () => {
  it("accepts a study document and rejects extra keys, bad ids and bad dates", () => {
    expect(FilterStudySchema.parse(STUDY)).toEqual(STUDY);
    expect(FilterStudySchema.safeParse({ ...STUDY, extra: 1 }).success).toBe(
      false
    );
    expect(
      FilterStudySchema.safeParse({ ...STUDY, id: "ADX filters" }).success
    ).toBe(false);
    expect(
      FilterStudySchema.safeParse({ ...STUDY, ran: "31/10/2026" }).success
    ).toBe(false);
    for (const ran of ["2026-02-30", "2026-13-01", "2026-04-31"])
      expect(FilterStudySchema.safeParse({ ...STUDY, ran }).success).toBe(
        false
      );
    expect(
      FilterStudySchema.safeParse({ ...STUDY, ran: "2024-02-29" }).success
    ).toBe(true);
    expect(RESEARCH_STUDY_ID_PATTERN.test("adx-rvol-filters")).toBe(true);
    expect(RESEARCH_STUDY_ID_PATTERN.test("adx--rvol")).toBe(false);
    expect(
      ResearchStudyGetInputSchema.safeParse({ id: "x".repeat(65) }).success
    ).toBe(false);
  });

  it("maps a stored record and names the path of a shape problem", () => {
    expect(toResearchStudy(record())).toEqual({
      id: "adx-rvol-filters",
      study: STUDY,
      updatedAt: NOW,
    });
    expect(toResearchStudy({ ...record(QC_STUDY), id: QC_STUDY.id })).toEqual({
      id: QC_STUDY.id,
      study: QC_STUDY,
      updatedAt: NOW,
    });
    expect(() => toResearchStudy(record({ ...STUDY, ran: 7 }))).toThrow(
      new ResearchStudyShapeError(
        "Research study adx-rvol-filters has an unexpected shape at study.ran"
      )
    );
    expect(() =>
      toResearchStudy(record({ ...QC_STUDY, runs: [{ ...RUN, trades: -1 }] }))
    ).toThrow(
      new ResearchStudyShapeError(
        "Research study adx-rvol-filters has an unexpected shape at study.runs.0.trades"
      )
    );
  });
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
  researchStudies: ResearchStudyRepository | undefined
) => {
  const repositories = (researchStudies === undefined
    ? {}
    : { researchStudies }) as unknown as Repositories;
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
    expect(error).toMatchObject({
      code,
      message: expect.stringMatching(message),
    });
  }
};

const repositoryOf = (get: ResearchStudyRepository["get"]) => {
  const ids: string[] = [];
  const repository: ResearchStudyRepository = {
    get: (id) => {
      ids.push(id);
      return get(id);
    },
    upsert: () => Promise.reject(new Error("read-only procedure")),
    upsertMany: () => Promise.reject(new Error("read-only procedure")),
    verdicts: () => Promise.resolve([]),
  };
  return { ids, repository };
};

describe("researchStudies.get procedure", () => {
  it("is operator-only like quantLab.list", async () => {
    const reads = repositoryOf(async () => record());
    await expectCode(
      clientFor(null, reads.repository).researchStudies.get({
        id: "adx-rvol-filters",
      }),
      "UNAUTHORIZED"
    );
    await expectCode(
      clientFor(session("outsider"), reads.repository).researchStudies.get({
        id: "adx-rvol-filters",
      }),
      "FORBIDDEN"
    );
    expect(reads.ids).toEqual([]);
    const output = await clientFor(
      session("operator"),
      reads.repository
    ).researchStudies.get({ id: "adx-rvol-filters" });
    expect(output).toEqual({
      id: "adx-rvol-filters",
      study: STUDY,
      updatedAt: NOW,
    });
    expect(reads.ids).toEqual(["adx-rvol-filters"]);
  });

  it("returns a qc-port study by the strategy slug", async () => {
    const reads = repositoryOf(async (id) => ({
      ...record(QC_STUDY),
      id,
      ranOn: QC_STUDY.ran,
      specRef: QC_STUDY.spec,
    }));
    const output = await clientFor(
      session("operator"),
      reads.repository
    ).researchStudies.get({ id: "qc-iv-rank-gate" });
    expect(output).toEqual({
      id: "qc-iv-rank-gate",
      study: QC_STUDY,
      updatedAt: NOW,
    });
  });

  it("answers NOT_FOUND for an unknown id and rejects a malformed id", async () => {
    const operator = session("operator");
    await expectCode(
      clientFor(
        operator,
        repositoryOf(async () => null).repository
      ).researchStudies.get({ id: "unknown-study" }),
      "NOT_FOUND",
      /Research study not found/u
    );
    await expectCode(
      clientFor(
        operator,
        repositoryOf(async () => record()).repository
      ).researchStudies.get({ id: "Not A Slug" }),
      "BAD_REQUEST"
    );
  });

  it("maps storage and shape failures to STORAGE_ERROR", async () => {
    const operator = session("operator");
    const get = (repository: ResearchStudyRepository | undefined) =>
      clientFor(operator, repository).researchStudies.get({
        id: "adx-rvol-filters",
      });
    await expectCode(get(undefined), "STORAGE_ERROR");
    await expectCode(
      get(
        repositoryOf(async () => {
          throw new DatabasePersistenceError("research study read");
        }).repository
      ),
      "STORAGE_ERROR",
      /Research study storage unavailable/u
    );
    await expectCode(
      get(
        repositoryOf(async () => record({ id: "adx-rvol-filters" })).repository
      ),
      "STORAGE_ERROR",
      /unexpected shape at study\.daily/u
    );
    await expectCode(
      get(
        repositoryOf(async () => {
          throw new Error("bug");
        }).repository
      ),
      "INTERNAL_SERVER_ERROR"
    );
  });

  it("is published as GET /research-studies/{id} and not reachable with agent API keys or MCP tools", async () => {
    const document = await buildOpenApiDocument();
    const operation = document.paths?.["/research-studies/{id}"]?.get;
    expect(operation?.operationId).toBe("researchStudies.get");
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "401", "403", "404", "503"])
    );
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("researchStudies");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("researchStudies"))
    ).toBe(false);
  });
});
