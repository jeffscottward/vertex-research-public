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
  RESEARCH_STUDY_ID_PATTERN,
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
    expect(() => toResearchStudy(record({ ...STUDY, ran: 7 }))).toThrow(
      new ResearchStudyShapeError(
        "Research study adx-rvol-filters has an unexpected shape at study.ran"
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
