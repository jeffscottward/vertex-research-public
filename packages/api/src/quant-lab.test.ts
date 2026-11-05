import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type QuantLabReadModel,
  type QuantLabReadRepository,
  type QuantLabStudyRow,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { createApiClient } from "./client.ts";
import { QuantLabJsonObjectSchema } from "./contracts/quant-lab.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import {
  QuantLabRecordShapeError,
  toQuantLabListOutput,
} from "./server/quant-lab.ts";

const NOW = new Date("2026-11-03T10:00:00.000Z");

const study = (
  overrides: Partial<QuantLabStudyRow> = {}
): QuantLabStudyRow => ({
  backtest: {
    createdAt: NOW,
    id: "bt-quantlab-7eb540a22b92-aaaaaaaaaaaa",
    instruments: "SPY",
    maxDrawdown: -0.2428,
    metrics: { bh_sharpe: 0.5696, wf_sharpe: 0.6354 },
    notes: "PASS walk_forward_sharpe_gt_benchmark: above",
    periodEnd: "2026-10-16",
    periodStart: "2003-10-01",
  },
  createdAt: NOW,
  hypothesis: "A 10-month SMA cuts drawdown.",
  id: "spec-7eb540a22b92aaaa",
  name: "SMA timing",
  ourReading: {
    costs: { per_side_bps: 2, stress: true },
    gaps: ["No full text"],
    interpretation: "Faber form",
    reviewed: null,
  },
  paper: {
    id: "paper-ssrn-2242795",
    identifier: "10.2139/ssrn.2242795",
    sourceUrl: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2242795",
    stage: "backtested",
    title: "The Real-Life Performance of Market Timing",
    verdict: "inconclusive",
  },
  paperClaims: [{ locator: "abstract", quote: "highly overstated" }],
  specKey: "zakamulin-2013-sma-timing",
  specSha256: "7".repeat(64),
  strategy: {
    id: "strategy-quantlab-zakamulin-2013-sma-timing",
    slug: "quantlab-zakamulin-2013-sma-timing",
    status: "backtested",
  },
  ...overrides,
});

const model = (studies: QuantLabStudyRow[] = [study()]): QuantLabReadModel => ({
  captures: [
    {
      capturedAt: NOW,
      doi: "10.2139/ssrn.2242795",
      id: "capture-0123456789abcdef",
      pdfStatus: "metadata_only:no_open_access_copy",
      ssrnId: "2242795",
      title: "The Real-Life Performance of Market Timing",
      topic: "market timing",
      url: "https://doi.org/10.2139/ssrn.2242795",
      version: "2013-04-01T00:00:00Z",
    },
  ],
  studies,
});

describe("quant lab output mapping", () => {
  it("passes bounded JSON through and keeps joins that are absent", () => {
    expect(toQuantLabListOutput(model())).toEqual(model());
    const bare = study({ backtest: null, paper: null, strategy: null });
    expect(toQuantLabListOutput(model([bare])).studies[0]).toEqual(bare);
  });

  it("rejects JSON that is too deep, too wide or not JSON", () => {
    const tooWide = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`k${index}`, index])
    );
    for (const ourReading of [
      { nested: { deeper: { deepest: 1 } } },
      tooWide,
      { count: Number.NaN },
      ["not", "an", "object"],
    ]) {
      expect(QuantLabJsonObjectSchema.safeParse(ourReading).success).toBe(
        false
      );
    }
    expect(() =>
      toQuantLabListOutput(model([study({ ourReading: tooWide })]))
    ).toThrow(QuantLabRecordShapeError);
    expect(() =>
      toQuantLabListOutput(model([study({ paperClaims: "quote" })]))
    ).toThrow(/unexpected shape at studies\.0\.paperClaims/u);
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
  quantLab: QuantLabReadRepository | undefined
) => {
  const repositories = (quantLab === undefined
    ? {}
    : { quantLab }) as unknown as Repositories;
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

const repositoryOf = (list: QuantLabReadRepository["list"]) => {
  let calls = 0;
  const repository: QuantLabReadRepository = {
    list: () => {
      calls += 1;
      return list();
    },
  };
  return { calls: () => calls, repository };
};

describe("quantLab.list procedure", () => {
  it("is operator-only like agentOps.backtests.list", async () => {
    const reads = repositoryOf(async () => model());
    await expectCode(
      clientFor(null, reads.repository).quantLab.list({}),
      "UNAUTHORIZED"
    );
    await expectCode(
      clientFor(session("outsider"), reads.repository).quantLab.list({}),
      "FORBIDDEN"
    );
    expect(reads.calls()).toBe(0);
    const output = await clientFor(
      session("operator"),
      reads.repository
    ).quantLab.list({});
    expect(output.studies[0]?.backtest?.createdAt).toEqual(NOW);
    expect(output.captures[0]?.capturedAt).toEqual(NOW);
    expect(output).toEqual(model());
  });

  it("maps storage and shape failures to STORAGE_ERROR", async () => {
    const operator = session("operator");
    await expectCode(
      clientFor(operator, undefined).quantLab.list({}),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor(
        operator,
        repositoryOf(async () => {
          throw new DatabasePersistenceError("quant lab read");
        }).repository
      ).quantLab.list({}),
      "STORAGE_ERROR",
      /Quant Lab storage unavailable/u
    );
    await expectCode(
      clientFor(
        operator,
        repositoryOf(async () => model([study({ ourReading: [] })])).repository
      ).quantLab.list({}),
      "STORAGE_ERROR",
      /unexpected shape at studies\.0\.ourReading/u
    );
    await expectCode(
      clientFor(
        operator,
        repositoryOf(async () => {
          throw new Error("bug");
        }).repository
      ).quantLab.list({}),
      "INTERNAL_SERVER_ERROR"
    );
  });

  it("is published as GET /quant-lab and not reachable with agent API keys or MCP tools", async () => {
    const document = await buildOpenApiDocument();
    const operation = document.paths?.["/quant-lab"]?.get;
    expect(operation?.operationId).toBe("quantLab.list");
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "401", "403", "503"])
    );
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("quantLab");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("quantLab"))
    ).toBe(false);
  });
});
