import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  type PlayRecord,
  type PlaysRepository,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { appContract } from "./contract.ts";
import {
  PLAY_STATUSES,
  PlaysListOutputSchema,
  playsContract,
} from "./contracts/plays.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
  handleOpenApiRequest,
  ORPC_OPENAPI_PREFIX,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { toPlayOutput } from "./server/plays.ts";

const at = new Date("2026-11-01T12:00:00.000Z");

// Fictional fixture: MOCKX is not a real ticker and this is not a real idea.
const record = (overrides: Partial<PlayRecord> = {}): PlayRecord => ({
  id: "play-1",
  ticker: "MOCKX",
  structure: "call debit spread",
  legs: [
    {
      side: "buy",
      right: "call",
      strike: 100,
      expiry: "2099-01-16",
      quantity: 1,
    },
    {
      side: "sell",
      right: "call",
      strike: 110,
      expiry: "2099-01-16",
      quantity: 1,
    },
  ],
  maxLossUsd: "250.50",
  definedRisk: true,
  thesis: "Fake thesis",
  trigger: "Fake trigger",
  exitRule: "Fake exit",
  status: "idea",
  notes: null,
  sourceUrl: "https://example.com/fake",
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-03T12:00:00.000Z"),
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

type Handle = typeof handleApiRequest;

const handlerFor = (
  requestSession: SafeAuthSession | null,
  plays: PlaysRepository | undefined,
  handle: Handle = handleApiRequest
) => {
  const repositories = { plays } as unknown as Repositories;
  return async (request: Request): Promise<Response> => {
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
    return handle(request, context);
  };
};

const clientFor = (
  requestSession: SafeAuthSession | null,
  plays: PlaysRepository | undefined
) =>
  createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: handlerFor(requestSession, plays),
  });

const repositoryOf = (list: PlaysRepository["list"]): PlaysRepository => ({
  list,
  upsert: vi.fn(),
});

const expectCode = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code });
  }
};

describe("plays contract", () => {
  it("is a single read-only GET route", () => {
    expect(Object.keys(playsContract)).toEqual(["list"]);
    expect(appContract.plays).toBe(playsContract);
    expect(PLAY_STATUSES).toEqual(["idea", "armed", "taken", "dropped"]);
  });

  it("requires defined risk in the output", () => {
    const output = { plays: [toPlayOutput(record())] };
    expect(PlaysListOutputSchema.parse(output)).toEqual(output);
    const bad = { plays: [{ ...output.plays[0], definedRisk: false }] };
    expect(PlaysListOutputSchema.safeParse(bad).success).toBe(false);
    const noLoss = { plays: [{ ...output.plays[0], maxLossUsd: 0 }] };
    expect(PlaysListOutputSchema.safeParse(noLoss).success).toBe(false);
  });
});

describe("toPlayOutput", () => {
  it("maps numeric strings, dates and copies legs", () => {
    const output = toPlayOutput(record({ notes: "n" }));
    expect(output).toMatchObject({
      maxLossUsd: 250.5,
      definedRisk: true,
      structure: "call debit spread",
      notes: "n",
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    });
    expect(output.legs).toHaveLength(2);
    expect(output.legs[0]).toEqual(record().legs[0]);
  });
});

describe("plays.list procedure", () => {
  it("lists from the repository for an operator", async () => {
    const list = vi.fn(async () => [record()]);
    const output = await clientFor(
      session("operator"),
      repositoryOf(list)
    ).plays.list({});
    expect(output).toEqual({ plays: [toPlayOutput(record())] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refuses non-operators and anonymous callers", async () => {
    const list = vi.fn(async () => [record()]);
    await expectCode(
      clientFor(session("member"), repositoryOf(list)).plays.list({}),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor(null, repositoryOf(list)).plays.list({}),
      "UNAUTHORIZED"
    );
    expect(list).not.toHaveBeenCalled();
    const handle = handlerFor(
      session("member"),
      repositoryOf(list),
      handleOpenApiRequest
    );
    const response = await handle(
      new Request(`https://darkfactory.localhost${ORPC_OPENAPI_PREFIX}/plays`)
    );
    expect(response.status).toBe(403);
  });

  it("maps a missing repository and storage failures to STORAGE_ERROR", async () => {
    await expectCode(
      clientFor(session("operator"), undefined).plays.list({}),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor(
        session("operator"),
        repositoryOf(async () => {
          throw new DatabasePersistenceError("plays operation");
        })
      ).plays.list({}),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor(
        session("operator"),
        repositoryOf(async () => {
          throw new Error("boom");
        })
      ).plays.list({}),
      "INTERNAL_SERVER_ERROR"
    );
  });

  it("has no write route and is not reachable with agent API keys or MCP tools", async () => {
    const list = vi.fn(async () => [record()]);
    const handle = handlerFor(
      session("operator"),
      repositoryOf(list),
      handleOpenApiRequest
    );
    const url = `https://darkfactory.localhost${ORPC_OPENAPI_PREFIX}/plays`;
    expect((await handle(new Request(url))).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await handle(
        new Request(url, {
          body: "{}",
          headers: { "content-type": "application/json" },
          method,
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(list).toHaveBeenCalledTimes(1);
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("plays");
    expect(MCP_TOOLS.some((tool) => tool.procedure.startsWith("plays"))).toBe(
      false
    );
  });
});
