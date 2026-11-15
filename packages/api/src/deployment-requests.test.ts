import { readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DEPLOYMENT_MAX_LOSS_PCT_CEILING,
  DeploymentRequestStateError,
  InvalidRepositoryInputError,
  type DeploymentRequestOptions,
  type DeploymentRequestRow,
  type DeploymentRequestsRepository,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  DEPLOYMENT_MAX_LOSS_PCT_CEILING_VALUE,
  DEPLOYMENT_NOT_DISPATCHED_REASON,
  DeploymentRequestCreateGroupInputSchema,
  DeploymentRequestCreateInputSchema,
  DeploymentRequestListOutputSchema,
  DeploymentRequestSchema,
} from "./contracts/deployment-requests.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { createApiContext } from "./server/context.ts";
import {
  DEPLOYMENT_REQUESTS_SESSION_REQUIRED_MESSAGE,
  deploymentRequestsApprove,
  deploymentRequestsRouter,
} from "./server/deployment-requests.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const PLAINTEXT = `vrk_${"C".repeat(64)}`;
const limits = {
  maxOrderSize: 1,
  maxPosition: 2,
  maxOrdersPerMinute: 5,
  dailyLossLimit: 500,
};
const LOCK = {
  executionAuthorized: false,
  brokerSubmissionAllowed: false,
  dispatch: {
    state: "not-dispatched",
    reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
  },
};

const options = {
  structure: "putCreditVertical" as const,
  dte: { target: 45, min: 30 },
  width: { unit: "sigma" as const, value: 1 },
  anchorDelta: 0.25,
  budgetPctOfAccount: 1,
  maxLossPctOfAccount: 2,
};
const storedOptions = (
  overrides: Partial<DeploymentRequestOptions> = {}
): DeploymentRequestOptions => ({
  ...options,
  legs: [
    { role: "anchor", action: "sell", right: "put" },
    { role: "wing", action: "buy", right: "put" },
  ],
  group: null,
  ...overrides,
});

const requestRow = (
  overrides: Partial<DeploymentRequestRow> = {}
): DeploymentRequestRow => ({
  id: "dr-1",
  strategyId: "s-hmm",
  presetId: null,
  params: { lookback: 20 },
  symbol: "ES",
  timeframe: "5m",
  mode: "paper",
  limits,
  options: null,
  status: "draft",
  requestedBy: "user-a",
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: at,
  updatedAt: at,
  strategySlug: "hmm",
  strategyName: "HMM forward filter",
  presetName: null,
  ...overrides,
});

// In-memory lifecycle double that follows the repository contract (statuses, slug confirmation, notes).
const memoryRequests = () => {
  const rows = new Map<string, DeploymentRequestRow>([["dr-1", requestRow()]]);
  const repository = {
    list: vi.fn(async () => [...rows.values()]),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    create: vi.fn(async (input) => {
      if (input.strategyId === "missing") return null;
      if (input.limits.maxPosition === 0.5)
        throw new InvalidRepositoryInputError(
          "limits.maxOrderSize must not exceed limits.maxPosition"
        );
      const row = requestRow({
        id: "dr-new",
        symbol: input.symbol.toUpperCase(),
        requestedBy: input.requestedBy,
        options:
          input.options === null || input.options === undefined
            ? null
            : storedOptions(input.options),
      });
      rows.set(row.id, row);
      return row;
    }),
    createGroup: vi.fn(async (input) => {
      if (input.strategyId === "missing") return null;
      return (input.symbols as string[]).map((symbol, index) => {
        const row = requestRow({
          id: `dr-group-${index}`,
          symbol,
          requestedBy: input.requestedBy,
          options: storedOptions(input.options),
        });
        rows.set(row.id, row);
        return row;
      });
    }),
    update: vi.fn(async (input) => {
      const row = rows.get(input.id);
      if (row === undefined) return null;
      if (row.status !== "draft")
        throw new DeploymentRequestStateError(
          `Only draft requests can be edited; this request is ${row.status}`
        );
      const next = {
        ...row,
        ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
      };
      rows.set(row.id, next);
      return next;
    }),
    transition: vi.fn(async (input) => {
      const row = rows.get(input.id);
      if (row === undefined) return null;
      const action = input.action as string;
      const allowed: Record<string, readonly string[]> = {
        submit: ["draft"],
        approve: ["requested"],
        reject: ["requested"],
        withdraw: ["draft", "requested", "approved"],
      };
      if (!(allowed[action] ?? []).includes(row.status))
        throw new DeploymentRequestStateError(
          `Cannot ${input.action} a request that is ${row.status}`
        );
      if (
        input.action === "approve" &&
        input.confirmSlug?.trim() !== row.strategySlug
      )
        throw new InvalidRepositoryInputError(
          `type the strategy slug ${row.strategySlug} to approve`
        );
      const targets: Record<string, DeploymentRequestRow["status"]> = {
        submit: "requested",
        approve: "approved",
        reject: "rejected",
        withdraw: "withdrawn",
      };
      const status = targets[action]!;
      const decides = input.action === "approve" || input.action === "reject";
      const next: DeploymentRequestRow = {
        ...row,
        status,
        updatedAt: at,
        ...(input.action === "submit" ? { requestedAt: at } : {}),
        ...(decides
          ? {
              decidedBy: input.actorId,
              decidedAt: at,
              decisionNote: input.note ?? null,
            }
          : {}),
      };
      rows.set(row.id, next);
      return next;
    }),
  };
  return repository as unknown as DeploymentRequestsRepository & {
    [K in keyof DeploymentRequestsRepository]: ReturnType<typeof vi.fn>;
  };
};

const session = (email = "operator@domain.test"): SafeAuthSession => ({
  user: {
    id: "user-a",
    name: "user-a",
    email,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: "session-a",
    userId: "user-a",
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "user-a", role: "member", status: "active" },
});

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const repositoriesFor = (
  deploymentRequests?: DeploymentRequestsRepository
): Repositories => ({
  profiles: {} as Repositories["profiles"],
  addresses: {} as Repositories["addresses"],
  userPreferences: {} as Repositories["userPreferences"],
  featureItems: {} as Repositories["featureItems"],
  adminUsers: {} as Repositories["adminUsers"],
  dashboard: {} as Repositories["dashboard"],
  // Plain strategies only; Academy (dyr-*) strategies are covered in academy.test.ts.
  strategyLibrary: {
    get: async (id: string) => ({
      strategy: { id, slug: "plain-strategy" },
      presets: [],
    }),
  } as unknown as NonNullable<Repositories["strategyLibrary"]>,
  ...(deploymentRequests === undefined ? {} : { deploymentRequests }),
});

const writeKeys = () => {
  return {
    authenticate: vi.fn(async () => ({
      userId: "user-a",
      role: "member" as const,
      status: "active" as const,
      apiKeyId: "key-1",
      access: "write",
      email: "operator@domain.test",
      emailVerified: true,
    })),
  } as unknown as NonNullable<
    Parameters<typeof createApiContext>[1]["agentApiKeys"]
  >;
};

const contextFor = (
  request: Request,
  deploymentRequests: DeploymentRequestsRepository | undefined,
  requestSession: SafeAuthSession | null
) => {
  return createApiContext(request, {
    repositories: repositoriesFor(deploymentRequests),
    requestId: "request-1",
    capabilities: {
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    },
    requireSession: async () => {
      if (requestSession === null) throw denied();
      return requestSession;
    },
    requireRole: async () => {
      throw denied();
    },
    operatorEmails: ["operator@domain.test"],
    agentApiKeys: writeKeys(),
  });
};

const clientFor = (
  options: Readonly<{
    requestSession?: SafeAuthSession | null;
    apiKey?: boolean;
    repository?: DeploymentRequestsRepository;
  }> = {}
) => {
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKey === true) request.headers.set("x-api-key", PLAINTEXT);
      return handleApiRequest(
        request,
        contextFor(
          request,
          options.repository,
          options.requestSession === undefined
            ? session()
            : options.requestSession
        )
      );
    },
  });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
  message?: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code,
      status,
      ...(message === undefined ? {} : { message }),
    });
  }
};

describe("deploymentRequests access", () => {
  it("requires an operator session", async () => {
    const repository = memoryRequests();
    await expectCode(
      clientFor({ requestSession: null, repository }).deploymentRequests.list(
        {}
      ),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({
        requestSession: session("outsider@domain.test"),
        repository,
      }).deploymentRequests.approve({ id: "dr-1", confirmSlug: "hmm" }),
      "FORBIDDEN",
      403
    );
    return expect(repository.transition).not.toHaveBeenCalled();
  });

  it("refuses every API key, even a write key with an operator owner, so agents cannot approve", async () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("deploymentRequests");
    const repository = memoryRequests();
    const agent = clientFor({
      requestSession: session(),
      apiKey: true,
      repository,
    });
    await expectCode(agent.deploymentRequests.list({}), "FORBIDDEN", 403);
    await expectCode(
      agent.deploymentRequests.approve({ id: "dr-1", confirmSlug: "hmm" }),
      "FORBIDDEN",
      403
    );
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.transition).not.toHaveBeenCalled();
    // Defense in depth: the procedure itself refuses a key even if the handler scope list changed.
    const request = new Request("https://darkfactory.localhost/api/orpc", {
      headers: { "x-api-key": PLAINTEXT },
    });
    const context = contextFor(request, repository, session());
    expect(context.agentApiKeyPresented).toBe(true);
    await expect(
      call(
        deploymentRequestsApprove,
        { id: "dr-1", confirmSlug: "hmm" },
        { context }
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: DEPLOYMENT_REQUESTS_SESSION_REQUIRED_MESSAGE,
    });
    return expect(repository.transition).not.toHaveBeenCalled();
  });

  it("exposes no MCP tool for deployment requests", () => {
    expect(
      MCP_TOOLS.filter(
        (tool) =>
          tool.procedure.startsWith("deploymentRequests") ||
          /deploy.*request|approve/i.test(tool.name)
      )
    ).toEqual([]);
    return expect(Object.keys(deploymentRequestsRouter).sort()).toEqual([
      "approve",
      "create",
      "createGroup",
      "get",
      "list",
      "reject",
      "submit",
      "update",
      "withdraw",
    ]);
  });
});

describe("deploymentRequests lifecycle", () => {
  it("carries the literal lock on every output and approve leaves dispatch unchanged", async () => {
    const repository = memoryRequests();
    const client = clientFor({ repository });
    const listed = await client.deploymentRequests.list({ status: "draft" });
    expect(listed).toMatchObject(LOCK);
    expect(listed.requests[0]).toMatchObject({ ...LOCK, mode: "paper" });
    const created = await client.deploymentRequests.create({
      strategyId: "s-hmm",
      symbol: "nq",
      timeframe: "5m",
      limits,
      params: { lookback: 30 },
    });
    expect(created).toMatchObject({
      ...LOCK,
      id: "dr-new",
      requestedBy: "user-a",
    });
    expect(repository.create).toHaveBeenCalledWith({
      strategyId: "s-hmm",
      params: { lookback: 30 },
      symbol: "nq",
      timeframe: "5m",
      limits,
      requestedBy: "user-a",
    });
    expect(
      await client.deploymentRequests.update({ id: "dr-1", symbol: "MES" })
    ).toMatchObject({ ...LOCK, symbol: "MES" });
    const before = await client.deploymentRequests.get({ id: "dr-1" });
    const submitted = await client.deploymentRequests.submit({ id: "dr-1" });
    expect(submitted).toMatchObject({ ...LOCK, status: "requested" });
    const approved = await client.deploymentRequests.approve({
      id: "dr-1",
      confirmSlug: "hmm",
      note: "paper only",
    });
    expect(approved).toMatchObject({
      status: "approved",
      decidedBy: "user-a",
      decisionNote: "paper only",
    });
    expect(approved.dispatch).toEqual(before.dispatch);
    expect(approved.executionAuthorized).toBe(false);
    expect(approved.brokerSubmissionAllowed).toBe(false);
    expect(
      (await client.deploymentRequests.get({ id: "dr-1" })).dispatch
    ).toEqual({
      state: "not-dispatched",
      reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
    });
    return expect(
      await client.deploymentRequests.withdraw({ id: "dr-1" })
    ).toMatchObject({ ...LOCK, status: "withdrawn" });
  });

  it("maps slug mismatch, state conflicts, validation and missing records", async () => {
    const repository = memoryRequests();
    const client = clientFor({ repository });
    await client.deploymentRequests.submit({ id: "dr-1" });
    await expectCode(
      client.deploymentRequests.approve({ id: "dr-1", confirmSlug: "jump" }),
      "VALIDATION_ERROR",
      422,
      "type the strategy slug hmm to approve"
    );
    await expectCode(
      client.deploymentRequests.update({ id: "dr-1", symbol: "NQ" }),
      "CONFLICT",
      409,
      "Only draft requests can be edited; this request is requested"
    );
    await expectCode(
      client.deploymentRequests.submit({ id: "dr-1" }),
      "CONFLICT",
      409,
      "Cannot submit a request that is requested"
    );
    expect(
      await client.deploymentRequests.reject({
        id: "dr-1",
        note: "limits too wide",
      })
    ).toMatchObject({
      ...LOCK,
      status: "rejected",
      decisionNote: "limits too wide",
    });
    await expectCode(
      client.deploymentRequests.withdraw({ id: "dr-1" }),
      "CONFLICT",
      409,
      "Cannot withdraw a request that is rejected"
    );
    await expectCode(
      client.deploymentRequests.get({ id: "nope" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.deploymentRequests.create({
        strategyId: "missing",
        symbol: "ES",
        timeframe: "5m",
        limits,
      }),
      "NOT_FOUND",
      404,
      "Strategy not found"
    );
    await expectCode(
      client.deploymentRequests.create({
        strategyId: "s-hmm",
        symbol: "ES",
        timeframe: "5m",
        limits: { ...limits, maxPosition: 0.5 },
      }),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      client.deploymentRequests.create({
        strategyId: "s-hmm",
        symbol: "ES",
        timeframe: "5m",
        limits: { ...limits, maxOrderSize: 0 },
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.deploymentRequests.create({
        strategyId: "s-hmm",
        symbol: "ES",
        timeframe: "5m",
        limits,
        mode: "live" as "paper",
      }),
      "BAD_REQUEST",
      400
    );
    return await expectCode(
      client.deploymentRequests.update({ id: "dr-1" }),
      "BAD_REQUEST",
      400
    );
  });

  it("reports missing storage as STORAGE_ERROR", async () =>
    await expectCode(
      clientFor().deploymentRequests.list({}),
      "STORAGE_ERROR",
      503
    ));
});

describe("deploymentRequests lock contract", () => {
  it("rejects any output that widens the lock or the mode", () => {
    const output = { ...requestRow(), ...LOCK };
    expect(DeploymentRequestSchema.safeParse(output).success).toBe(true);
    expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        executionAuthorized: true,
      }).success
    ).toBe(false);
    expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        brokerSubmissionAllowed: true,
      }).success
    ).toBe(false);
    expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        dispatch: {
          state: "dispatched",
          reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
        },
      }).success
    ).toBe(false);
    expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        dispatch: { ...LOCK.dispatch, target: "vps" },
      }).success
    ).toBe(false);
    expect(
      DeploymentRequestSchema.safeParse({ ...output, mode: "live" }).success
    ).toBe(false);
    return expect(
      DeploymentRequestListOutputSchema.safeParse({
        requests: [],
        ...LOCK,
        executionAuthorized: true,
      }).success
    ).toBe(false);
  });

  it("keeps order submission disabled as a config literal", () => {
    const config = readFileSync(
      new URL("../../config/src/server.ts", import.meta.url),
      "utf8"
    );
    return expect(config).toContain(
      'VERTEX_ORDER_SUBMISSION: z.enum(["disabled", "enabled"]).default("disabled")'
    );
  });
});

describe("deploymentRequests modules have no network path", () => {
  // Every module on the request path, from contract to storage. None may import a network client or
  // call one; storage goes through the database executor only.
  const modules = [
    "./contracts/deployment-requests.ts",
    "./server/deployment-requests.ts",
    "../../db/src/server/deployment-requests.ts",
    "../../db/src/server/repositories.ts",
  ];
  const source = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const importsOf = (text: string): string[] => {
    return [
      ...text.matchAll(
        /(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gu
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  };
  const NETWORK_MODULE =
    /^(node:)?(http|https|http2|net|tls|dgram|dns|child_process)$|ssh|undici|axios|node-fetch|cross-fetch|got$|^ky$|^ws$|socket|grpc|ibkr|ib-gateway|nautilus|quant-?vps|deploy-status/iu;
  const NETWORK_CALL =
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnavigator\.sendBeacon\b|\bspawn\s*\(|\bexecFile\s*\(/u;

  for (const path of modules) {
    it(`${path} imports no network client and calls none`, () => {
      const text = source(path);
      const imports = importsOf(text);
      expect(imports.length).toBeGreaterThan(0);
      expect(
        imports.filter((specifier) => NETWORK_MODULE.test(specifier))
      ).toEqual([]);
      return expect(text).not.toMatch(NETWORK_CALL);
    });
  }

  it("limits the server module to the contract, repository and operator gate", () => {
    expect(importsOf(source("./server/deployment-requests.ts")).sort()).toEqual(
      [
        "../contract.ts",
        "../contracts/deployment-requests.ts",
        "./context.ts",
        "./operator-access.ts",
        // Course registry (pure data, no imports): the Academy strategy prefixes refused here.
        "@darkfactory/academy/courses",
        "@darkfactory/db/server",
        "@orpc/server",
      ]
    );
    return expect(
      importsOf(source("./contracts/deployment-requests.ts")).sort()
    ).toEqual(["./agent-ops.ts", "@orpc/contract", "zod"]);
  });
});

describe("deploymentRequests options block", () => {
  it("keeps the ceiling of the contract equal to the rule constant", () => {
    expect(DEPLOYMENT_MAX_LOSS_PCT_CEILING).toBe(2);
    return expect(DEPLOYMENT_MAX_LOSS_PCT_CEILING_VALUE).toBe(
      DEPLOYMENT_MAX_LOSS_PCT_CEILING
    );
  });

  it("takes width as a unit and a value and refuses a bare number, another unit or an extra key", () => {
    const parse = (width: unknown) =>
      DeploymentRequestCreateInputSchema.safeParse({
        strategyId: "s-hmm",
        symbol: "SPY",
        timeframe: "1d",
        limits,
        options: { ...options, width },
      }).success;
    expect(parse({ unit: "sigma", value: 1 })).toBe(true);
    expect(parse({ unit: "price", value: 10_000 })).toBe(true);
    expect(parse(5)).toBe(false);
    expect(parse({ unit: "sigma", value: 0 })).toBe(false);
    expect(parse({ unit: "sigma", value: 10_001 })).toBe(false);
    expect(parse({ unit: "percent", value: 1 })).toBe(false);
    expect(parse({ value: 1 })).toBe(false);
    return expect(parse({ unit: "price", value: 5, strikes: 1 })).toBe(false);
  });

  it("refuses a max loss of 2.5 percent, accepts exactly 2 and still accepts the old format", () => {
    const base = {
      strategyId: "s-hmm",
      symbol: "SPY",
      timeframe: "1d",
      limits,
    };
    expect(
      DeploymentRequestCreateInputSchema.safeParse({
        ...base,
        options: { ...options, maxLossPctOfAccount: 2.5 },
      }).success
    ).toBe(false);
    expect(
      DeploymentRequestCreateInputSchema.safeParse({ ...base, options }).success
    ).toBe(true);
    expect(DeploymentRequestCreateInputSchema.safeParse(base).success).toBe(
      true
    );
    expect(
      DeploymentRequestCreateInputSchema.safeParse({ ...base, options: null })
        .success
    ).toBe(true);
    // No way to ask for anything but paper, with or without options.
    return expect(
      DeploymentRequestCreateInputSchema.safeParse({
        ...base,
        options,
        mode: "live",
      }).success
    ).toBe(false);
  });

  it("parses an old record (options null or absent) and a record with options, lock unchanged", () => {
    const { options: _absent, ...oldRecord } = requestRow();
    const output = { ...oldRecord, presetName: null, ...LOCK };
    expect(DeploymentRequestSchema.parse(output).options).toBeUndefined();
    expect(
      DeploymentRequestSchema.parse({ ...output, options: null }).options
    ).toBeNull();
    expect(
      DeploymentRequestSchema.parse({ ...output, options: storedOptions() })
    ).toMatchObject({ ...LOCK, options: { maxLossPctOfAccount: 2 } });
    expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        options: storedOptions({ maxLossPctOfAccount: 2.5 }),
      }).success
    ).toBe(false);
    return expect(
      DeploymentRequestSchema.safeParse({
        ...output,
        options: storedOptions(),
        executionAuthorized: true,
      }).success
    ).toBe(false);
  });

  it("passes options through create and update and returns them with the lock", async () => {
    const repository = memoryRequests();
    const client = clientFor({ repository });
    const created = await client.deploymentRequests.create({
      strategyId: "s-hmm",
      symbol: "spy",
      timeframe: "1d",
      limits,
      options,
    });
    expect(created).toMatchObject({
      ...LOCK,
      mode: "paper",
      status: "draft",
      options: storedOptions(),
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ options })
    );
    // Old format: no options key reaches the repository and the output carries null.
    const plain = await client.deploymentRequests.create({
      strategyId: "s-hmm",
      symbol: "ES",
      timeframe: "5m",
      limits,
    });
    expect(plain.options).toBeNull();
    expect(repository.create.mock.calls[1]?.[0]).not.toHaveProperty("options");

    await client.deploymentRequests.update({ id: "dr-1", options: null });
    expect(repository.update).toHaveBeenLastCalledWith({
      id: "dr-1",
      options: null,
    });
    await expectCode(
      client.deploymentRequests.create({
        strategyId: "s-hmm",
        symbol: "SPY",
        timeframe: "1d",
        limits,
        options: { ...options, maxLossPctOfAccount: 2.5 },
      }),
      "BAD_REQUEST",
      400
    );
    return expect(repository.create).toHaveBeenCalledTimes(2);
  });

  it("creates one draft per symbol with a server-made group and refuses duplicates", async () => {
    const repository = memoryRequests();
    const client = clientFor({ repository });
    const result = await client.deploymentRequests.createGroup({
      strategyId: "s-hmm",
      symbols: ["spy", "QQQ", "IWM"],
      timeframe: "1d",
      limits,
      options,
    });
    expect(result).toMatchObject(LOCK);
    expect(result.groupKey).toMatch(/^grp-[0-9a-f-]{36}$/u);
    expect(result.requests.map((request) => request.symbol)).toEqual([
      "SPY",
      "QQQ",
      "IWM",
    ]);
    for (const request of result.requests) {
      expect(request).toMatchObject({
        ...LOCK,
        mode: "paper",
        status: "draft",
        options: {
          maxLossPctOfAccount: 2,
          group: { key: result.groupKey, symbols: ["SPY", "QQQ", "IWM"] },
        },
      });
    }
    expect(repository.createGroup).toHaveBeenCalledTimes(1);
    expect(repository.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        symbols: ["SPY", "QQQ", "IWM"],
        requestedBy: "user-a",
      })
    );
    expect(repository.create).not.toHaveBeenCalled();

    await expectCode(
      client.deploymentRequests.createGroup({
        strategyId: "s-hmm",
        symbols: ["SPY", "spy", "QQQ"],
        timeframe: "1d",
        limits,
        options,
      }),
      "VALIDATION_ERROR",
      422,
      "options.group.symbols must not repeat a symbol"
    );
    // The client may not supply the group, a single symbol is not a group, and the ceiling holds.
    const groupInput = {
      strategyId: "s-hmm",
      symbols: ["SPY", "QQQ"],
      timeframe: "1d",
      limits,
      options,
    };
    expect(
      DeploymentRequestCreateGroupInputSchema.safeParse(groupInput).success
    ).toBe(true);
    for (const invalid of [
      { ...groupInput, symbols: ["SPY"] },
      { ...groupInput, options: undefined },
      { ...groupInput, options: { ...options, maxLossPctOfAccount: 2.5 } },
      {
        ...groupInput,
        options: {
          ...options,
          group: { key: "mine", symbols: ["SPY", "QQQ"] },
        },
      },
    ]) {
      expect(
        DeploymentRequestCreateGroupInputSchema.safeParse(invalid).success
      ).toBe(false);
    }
    await expectCode(
      client.deploymentRequests.createGroup({
        ...groupInput,
        strategyId: "missing",
      }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientFor({ apiKey: true, repository }).deploymentRequests.createGroup(
        groupInput
      ),
      "FORBIDDEN",
      403
    );
    return expect(repository.createGroup).toHaveBeenCalledTimes(2);
  });

  it("refuses to approve a stored options block that breaks the ceiling", async () => {
    const repository = memoryRequests();
    repository.get.mockResolvedValue(
      requestRow({
        status: "requested",
        requestedAt: at,
        symbol: "SPY",
        options: storedOptions({ maxLossPctOfAccount: 2.5 }),
      })
    );
    await expectCode(
      clientFor({ repository }).deploymentRequests.approve({
        id: "dr-1",
        confirmSlug: "hmm",
      }),
      "VALIDATION_ERROR",
      422,
      "options.maxLossPctOfAccount must be greater than 0 and at most 2"
    );
    expect(repository.transition).not.toHaveBeenCalled();

    // Legs that disagree with the stored structure are refused the same way.
    repository.get.mockResolvedValue(
      requestRow({
        status: "requested",
        requestedAt: at,
        symbol: "SPY",
        options: storedOptions({ structure: "callDebitVertical" }),
      })
    );
    await expectCode(
      clientFor({ repository }).deploymentRequests.approve({
        id: "dr-1",
        confirmSlug: "hmm",
      }),
      "VALIDATION_ERROR",
      422
    );
    return expect(repository.transition).not.toHaveBeenCalled();
  });

  return it("approves a request at exactly the ceiling and one in the old format", async () => {
    for (const stored of [storedOptions(), null]) {
      const repository = memoryRequests();
      const row = requestRow({
        status: "requested",
        requestedAt: at,
        symbol: "SPY",
        options: stored,
      });
      repository.get.mockResolvedValue(row);
      repository.transition.mockResolvedValue({
        ...row,
        status: "approved",
        decidedBy: "user-a",
        decidedAt: at,
      });
      expect(
        await clientFor({ repository }).deploymentRequests.approve({
          id: "dr-1",
          confirmSlug: "hmm",
        })
      ).toMatchObject({ ...LOCK, status: "approved", options: stored });
    }
  });
});
