import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Repositories,
  StrategyDefinitionRevisionInput,
  StrategyDefinitionRevisionRecord,
  StrategyDefinitionsRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { createApiClient } from "./client.ts";
import {
  STRATEGY_DEFINITION_HISTORY_MAX,
  StrategyDefinitionSaveInputSchema,
  StrategyDefinitionValidateOutputSchema,
} from "./contracts/strategy-definitions.ts";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import {
  STRATEGY_DEFINITION_SAVE_SESSION_MESSAGE,
  strategyDefinitionSha256,
} from "./server/strategy-definitions.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";

const at = new Date("2026-10-23T12:00:00.000Z");

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-24T12:00:00.000Z"),
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

const memoryDefinitions = (): StrategyDefinitionsRepository & {
  rows: StrategyDefinitionRevisionRecord[];
  /** When set, the next insert reports a taken revision. */
  conflictNext: boolean;
} => {
  const rows: StrategyDefinitionRevisionRecord[] = [];
  let sequence = 0;
  const repository = {
    rows,
    conflictNext: false,
    insert: async (input: StrategyDefinitionRevisionInput) => {
      if (repository.conflictNext) {
        repository.conflictNext = false;
        return null;
      }
      sequence += 1;
      const row = { ...input, createdAt: at, id: `row-${sequence}` };
      rows.push(row);
      return row;
    },
    latest: async (definitionId: string) =>
      rows
        .filter((row) => row.definitionId === definitionId)
        .sort((left, right) => right.revision - left.revision)[0] ?? null,
    get: async (definitionId: string, revision: number) =>
      rows.find(
        (row) => row.definitionId === definitionId && row.revision === revision
      ) ?? null,
    history: async (definitionId: string, limit: number) =>
      rows
        .filter((row) => row.definitionId === definitionId)
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit)
        .map(({ revision, sha256, name, note, createdAt }) => ({
          createdAt,
          name,
          note,
          revision,
          sha256,
        })),
    listLatest: async (limit: number) => {
      const latest = new Map<string, StrategyDefinitionRevisionRecord>();
      for (const row of rows) {
        const current = latest.get(row.definitionId);
        if (current === undefined || current.revision < row.revision)
          latest.set(row.definitionId, row);
      }
      return [...latest.values()].slice(0, limit);
    },
  };
  return repository;
};

type Harness = Readonly<{
  session?: SafeAuthSession | null;
  definitions?: StrategyDefinitionsRepository | undefined;
  /** Authenticate with an operator's write-access agent API key instead of a session. */
  writeKey?: boolean;
}>;

const writeKeys = () =>
  ({
    authenticate: async () => ({
      access: "write",
      apiKeyId: "key-1",
      email: "operator@domain.test",
      emailVerified: true,
      role: "member",
      status: "active",
      userId: "operator",
    }),
  }) as unknown as NonNullable<
    Parameters<typeof createApiContext>[1]["agentApiKeys"]
  >;

const clientFor = (harness: Harness) => {
  const repositories = {
    addresses: {},
    adminUsers: {},
    dashboard: {},
    featureItems: {},
    profiles: {},
    strategyDefinitions: harness.definitions,
    userPreferences: {},
  } as unknown as Repositories;
  const requestSession =
    harness.session === undefined ? session("operator") : harness.session;
  const dispatch = async (request: Request): Promise<Response> => {
    if (harness.writeKey === true)
      request.headers.set("x-api-key", `vrk_${"C".repeat(64)}`);
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
      ...(harness.writeKey === true ? { agentApiKeys: writeKeys() } : {}),
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
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: dispatch,
  }).backtestRuns.definitions;
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const sma = STRATEGY_TEMPLATES.smaCross;

describe("strategy definition contract", () => {
  it("requires a valid definition and a bounded note to save", () => {
    expect(
      StrategyDefinitionSaveInputSchema.safeParse({ definition: sma }).success
    ).toBe(true);
    expect(
      StrategyDefinitionSaveInputSchema.safeParse({
        definition: { ...sma, entry: { all: [] } },
      }).success
    ).toBe(false);
    expect(
      StrategyDefinitionSaveInputSchema.safeParse({
        definition: sma,
        note: "x".repeat(501),
      }).success
    ).toBe(false);
  });

  it("lets read keys validate, list and get, but not save", () => {
    for (const name of ["validate", "list", "get"])
      expect(
        AGENT_API_KEY_READ_PROCEDURES.has(`backtestRuns.definitions.${name}`)
      ).toBe(true);
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.definitions.save")
    ).toBe(false);
  });
});

describe("backtestRuns.definitions procedures", () => {
  it("validates without storing and returns the content hash", async () => {
    const definitions = memoryDefinitions();
    const client = clientFor({ definitions });
    const ok = await client.validate({ definition: sma });
    expect(StrategyDefinitionValidateOutputSchema.parse(ok)).toEqual(ok);
    const parsed = StrategyDefinitionSchema.parse(sma);
    expect(ok).toEqual({
      definition: parsed,
      ok: true,
      sha256: await sha256Hex(canonicalJson(parsed)),
    });
    await expect(strategyDefinitionSha256(parsed)).resolves.toBe(
      ok.ok ? ok.sha256 : ""
    );
    const bad = await client.validate({
      definition: { ...sma, sizing: { mode: "riskPct", riskPct: 1 } },
    });
    expect(bad).toEqual({
      issues: [
        { message: "Risk-percent sizing needs a stop loss", path: "sizing" },
      ],
      ok: false,
    });
    expect(definitions.rows).toHaveLength(0);
  });

  it("saves a new definition, appends revisions and skips unchanged content", async () => {
    const definitions = memoryDefinitions();
    const client = clientFor({ definitions });
    const first = await client.save({ definition: sma, note: "  first  " });
    expect(first.created).toBe(true);
    expect(first.revision).toMatchObject({
      name: sma.name,
      note: "first",
      revision: 1,
    });
    expect(definitions.rows[0]?.createdBy).toBe("operator");

    const same = await client.save({ definition: sma, id: first.revision.id });
    expect(same).toEqual({ created: false, revision: first.revision });

    const changed = { ...sma, name: "SMA cross 20/60" };
    const second = await client.save({
      definition: changed,
      id: first.revision.id,
      note: "",
    });
    expect(second.created).toBe(true);
    expect(second.revision).toMatchObject({
      id: first.revision.id,
      name: "SMA cross 20/60",
      note: null,
      revision: 2,
    });
    expect(second.revision.sha256).not.toBe(first.revision.sha256);
    expect(definitions.rows).toHaveLength(2);
  });

  it("refuses an unknown id and reports a concurrent save as a conflict", async () => {
    const definitions = memoryDefinitions();
    const client = clientFor({ definitions });
    await expectCode(
      client.save({ definition: sma, id: "missing" }),
      "NOT_FOUND",
      404
    );
    definitions.conflictNext = true;
    await expectCode(client.save({ definition: sma }), "CONFLICT", 409);
  });

  it("lists latest revisions and gets one revision with its history", async () => {
    const definitions = memoryDefinitions();
    const client = clientFor({ definitions });
    const first = await client.save({ definition: sma });
    await client.save({
      definition: { ...sma, name: "Second name" },
      id: first.revision.id,
    });
    const listed = await client.list({});
    expect(listed.definitions).toEqual([
      {
        id: first.revision.id,
        name: "Second name",
        revision: 2,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        updatedAt: at,
      },
    ]);
    const latest = await client.get({ id: first.revision.id });
    expect(latest.revision.revision).toBe(2);
    expect(latest.history.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(latest.history.length).toBeLessThanOrEqual(
      STRATEGY_DEFINITION_HISTORY_MAX
    );
    const older = await client.get({ id: first.revision.id, revision: 1 });
    expect(older.revision).toEqual(first.revision);
    await expectCode(
      client.get({ id: first.revision.id, revision: 9 }),
      "NOT_FOUND",
      404
    );
    await expectCode(client.get({ id: "missing" }), "NOT_FOUND", 404);
  });

  it("refuses agent API keys on save, so only an operator session or an approved card saves", async () => {
    const definitions = memoryDefinitions();
    const client = clientFor({ definitions, writeKey: true });
    await expect(client.list({})).resolves.toEqual({ definitions: [] });
    await expect(client.validate({ definition: sma })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.save({ definition: sma })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: STRATEGY_DEFINITION_SAVE_SESSION_MESSAGE,
      status: 403,
    });
    expect(definitions.rows).toHaveLength(0);
  });

  it("requires an operator and storage", async () => {
    await expectCode(
      clientFor({ session: null }).list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({ session: session("outsider") }).list({}),
      "FORBIDDEN",
      403
    );
    const client = clientFor({ definitions: undefined });
    await expectCode(client.list({}), "STORAGE_ERROR", 503);
    await expectCode(client.save({ definition: sma }), "STORAGE_ERROR", 503);
    await expectCode(client.get({ id: "x" }), "STORAGE_ERROR", 503);
    const failing = async () => {
      throw new Error("relation does not exist");
    };
    const down = clientFor({
      definitions: {
        get: failing,
        history: failing,
        insert: failing,
        latest: failing,
        listLatest: failing,
      },
    });
    await expectCode(down.list({}), "STORAGE_ERROR", 503);
    await expectCode(down.save({ definition: sma }), "STORAGE_ERROR", 503);
    await expectCode(
      down.save({ definition: sma, id: "def-1" }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(down.get({ id: "x" }), "STORAGE_ERROR", 503);
    await expectCode(down.get({ id: "x", revision: 1 }), "STORAGE_ERROR", 503);
  });
});
