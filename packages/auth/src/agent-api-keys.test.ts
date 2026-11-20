import {
  betterAuth,
  type BetterAuthOptions,
  type DBAdapter,
} from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { Database } from "@darkfactory/db/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_API_KEY_PERMISSIONS,
  AGENT_API_KEY_READ_PERMISSIONS,
  AgentApiKeyRateLimitedError,
  AuthAuthorizationError,
  createAgentApiKeyPlugin,
  createAgentApiKeyService,
  createAuthHandler,
  isApiKeyPluginRequest,
  requireSession,
  toAgentApiKeyRecord,
  type DarkFactoryAuth,
} from "./server.ts";
import type { AgentApiKeyService } from "./types.ts";

// Real @better-auth/api-key plugin (production options) over Better Auth's
// in-memory adapter. Only the owner-status lookup uses a drizzle double.

type MemoryRows = Record<string, Record<string, unknown>[]>;

type MemoryAdapterFactory = (
  options: BetterAuthOptions
) => DBAdapter<BetterAuthOptions>;
type MemoryAdapterWrapper = (
  factory: MemoryAdapterFactory
) => MemoryAdapterFactory;

const createMemoryAuth = (
  wrapAdapter: MemoryAdapterWrapper = (factory) => factory
) => {
  const rows: MemoryRows = {
    user: [],
    session: [],
    account: [],
    verification: [],
    apiKeys: [],
  };
  const auth = betterAuth({
    baseURL: "https://darkfactory.localhost",
    secret: "agent-api-key-unit-test-secret-9f3c1a7e5b2d4f60",
    database: wrapAdapter(memoryAdapter(rows)),
    emailAndPassword: { enabled: true, autoSignIn: true },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          input: false,
          defaultValue: "member",
        },
        status: {
          type: "string",
          required: false,
          input: false,
          defaultValue: "active",
        },
      },
    },
    plugins: [createAgentApiKeyPlugin()],
  });
  return { auth, rows, typedAuth: auth as unknown as DarkFactoryAuth };
};

interface OwnerRow {
  role: string;
  status: string;
  email?: string;
  emailVerified?: boolean;
}

const ownerDatabase = (owner: OwnerRow | null): Database => {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return owner === null
                    ? []
                    : [
                        {
                          email: "operator@domain.test",
                          emailVerified: true,
                          ...owner,
                        },
                      ];
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
};

const signUp = async (auth: ReturnType<typeof createMemoryAuth>["auth"]) => {
  const result = await auth.api.signUpEmail({
    body: {
      email: "operator@domain.test",
      password: "correct-horse-battery",
      name: "Operator",
    },
    returnHeaders: true,
  });
  const setCookie = result.headers.get("set-cookie") ?? "";
  // https baseURL => secure cookies: the name carries the __Secure- prefix, keep it whole.
  const cookie = setCookie.match(
    /(?:^|[,\s])((?:__Secure-)?better-auth\.session_token=[^;]+)/
  )?.[1];
  if (cookie === undefined)
    throw new Error("sign-up did not issue a session cookie");
  return {
    userId: result.response.user.id,
    sessionHeaders: new Headers({ cookie }),
  };
};

const keyHeaders = (key: string): Headers => new Headers({ "x-api-key": key });

const expectAuthError = async (
  promise: Promise<unknown>,
  status: number,
  code: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected an authorization failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthAuthorizationError);
    expect(error).toMatchObject({ status, code });
  }
};

describe("agent API key plugin configuration", () => {
  it("never turns an API key into a Better Auth session", async () => {
    const plugin = createAgentApiKeyPlugin();
    expect(plugin.id).toBe("api-key");
    const matcher = plugin.hooks.before[0]!.matcher as (context: {
      headers: Headers;
    }) => boolean;
    expect(matcher({ headers: keyHeaders(`vrk_${"A".repeat(64)}`) })).toBe(
      false
    );

    const { auth, typedAuth } = createMemoryAuth();
    const { userId } = await signUp(auth);
    const created = await auth.api.createApiKey({
      body: { name: "omp", userId, permissions: { agentLedger: ["write"] } },
    });
    return await expectAuthError(
      requireSession(typedAuth, keyHeaders(created.key)),
      401,
      "AUTH_REQUIRED"
    );
  });

  return it("hides the plugin's own HTTP endpoints", async () => {
    expect(
      isApiKeyPluginRequest(
        new Request("https://darkfactory.localhost/api/auth/api-key/create", {
          method: "POST",
        })
      )
    ).toBe(true);
    expect(
      isApiKeyPluginRequest(
        new Request("https://darkfactory.localhost/api/auth/api-key/list")
      )
    ).toBe(true);
    expect(
      isApiKeyPluginRequest(
        new Request("https://darkfactory.localhost/api/auth/sign-in/email", {
          method: "POST",
        })
      )
    ).toBe(false);
    const { typedAuth } = createMemoryAuth();
    const response = await createAuthHandler(typedAuth)(
      new Request("https://darkfactory.localhost/api/auth/api-key/list")
    );
    return expect(response.status).toBe(404);
  });
});

describe("createAgentApiKeyService", () => {
  it("issues a prefixed key once, stores only its hash and the ledger permission, and lists display-safe fields", async () => {
    const { auth, rows, typedAuth } = createMemoryAuth();
    const { userId, sessionHeaders } = await signUp(auth);
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    );

    const created = await service.create(sessionHeaders, {
      name: "  omp-rig  ",
    });
    expect(created.key).toMatch(/^vrk_[A-Za-z]{64}$/);
    expect(created.record).toMatchObject({
      name: "omp-rig",
      prefix: "vrk_",
      start: created.key.slice(0, 6),
      lastUsedAt: null,
    });
    expect(Object.keys(created.record).sort()).toEqual([
      "access",
      "createdAt",
      "enabled",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
      "start",
    ]);
    expect(created.record.access).toBe("read");

    const stored = rows["apiKeys"]!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!["key"]).not.toBe(created.key);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(stored[0]!["referenceId"]).toBe(userId);
    expect(JSON.parse(String(stored[0]!["permissions"]))).toEqual(
      AGENT_API_KEY_READ_PERMISSIONS
    );
    const writer = await service.create(sessionHeaders, {
      name: "writer",
      access: "write",
    });
    expect(writer.record.access).toBe("write");
    expect(JSON.parse(String(rows["apiKeys"]!.at(-1)!["permissions"]))).toEqual(
      AGENT_API_KEY_PERMISSIONS
    );
    await service.revoke(sessionHeaders, writer.record.id);

    const listed = await service.list(sessionHeaders);
    expect(listed.map((row) => row.id)).toEqual([created.record.id]);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    return expect(JSON.stringify(listed)).not.toContain(
      String(stored[0]!["key"])
    );
  });

  it("authenticates a valid key to its active owner and records last use", async () => {
    const { auth, typedAuth } = createMemoryAuth();
    const { userId, sessionHeaders } = await signUp(auth);
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "admin", status: "active" })
    );
    const created = await service.create(sessionHeaders, { name: "omp" });

    const principal = await service.authenticate(keyHeaders(created.key));
    expect(principal).toEqual({
      userId,
      role: "admin",
      status: "active",
      apiKeyId: created.record.id,
      email: "operator@domain.test",
      emailVerified: true,
      access: "read",
    });
    const writer = await service.create(sessionHeaders, {
      name: "writer",
      access: "write",
    });
    expect((await service.authenticate(keyHeaders(writer.key))).access).toBe(
      "write"
    );
    // Keys issued before access levels carry only ["write"] and stay write keys.
    const legacy = await auth.api.createApiKey({
      body: { name: "legacy", userId, permissions: { agentLedger: ["write"] } },
    });
    expect((await service.authenticate(keyHeaders(legacy.key))).access).toBe(
      "write"
    );
    const [row] = await service.list(sessionHeaders);
    return expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects missing, unknown, non-ledger and revoked keys", async () => {
    const { auth, typedAuth } = createMemoryAuth();
    const { userId, sessionHeaders } = await signUp(auth);
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    );
    await expectAuthError(
      service.authenticate(new Headers()),
      401,
      "AUTH_REQUIRED"
    );
    await expectAuthError(
      service.authenticate(keyHeaders("vrk_unknown")),
      401,
      "AUTH_REQUIRED"
    );

    const foreign = await auth.api.createApiKey({
      body: { name: "no-ledger-permission", userId },
    });
    await expectAuthError(
      service.authenticate(keyHeaders(foreign.key)),
      401,
      "AUTH_REQUIRED"
    );

    const created = await service.create(sessionHeaders, { name: "omp" });
    expect(await service.revoke(sessionHeaders, created.record.id)).toBe(true);
    expect(await service.revoke(sessionHeaders, created.record.id)).toBe(false);
    return await expectAuthError(
      service.authenticate(keyHeaders(created.key)),
      401,
      "AUTH_REQUIRED"
    );
  });

  it("rejects keys whose owner is missing or inactive", async () => {
    const { auth, typedAuth } = createMemoryAuth();
    const { sessionHeaders } = await signUp(auth);
    const created = await createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    ).create(sessionHeaders, { name: "omp" });
    await expectAuthError(
      createAgentApiKeyService(
        typedAuth,
        ownerDatabase({ role: "member", status: "suspended" })
      ).authenticate(keyHeaders(created.key)),
      403,
      "ACCOUNT_SUSPENDED"
    );
    await expectAuthError(
      createAgentApiKeyService(
        typedAuth,
        ownerDatabase({ role: "member", status: "deactivated" })
      ).authenticate(keyHeaders(created.key)),
      403,
      "ACCOUNT_DEACTIVATED"
    );
    return await expectAuthError(
      createAgentApiKeyService(typedAuth, ownerDatabase(null)).authenticate(
        keyHeaders(created.key)
      ),
      401,
      "AUTH_REQUIRED"
    );
  });

  it("returns the owner's current email and verification for the request-time operator check", async () => {
    const { auth, typedAuth } = createMemoryAuth();
    const { sessionHeaders } = await signUp(auth);
    const created = await createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    ).create(sessionHeaders, { name: "omp" });
    const unverified = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({
        role: "member",
        status: "active",
        email: "Renamed@Domain.test",
        emailVerified: false,
      })
    );
    return expect(
      await unverified.authenticate(keyHeaders(created.key))
    ).toMatchObject({
      email: "Renamed@Domain.test",
      emailVerified: false,
    });
  });

  it("maps the plugin's per-key rate limit to AgentApiKeyRateLimitedError", async () => {
    const { auth, typedAuth } = createMemoryAuth();
    const { userId } = await signUp(auth);
    const limited = await auth.api.createApiKey({
      body: {
        name: "limited",
        userId,
        permissions: { agentLedger: ["write"] },
        rateLimitMax: 1,
        rateLimitTimeWindow: 60_000,
      },
    });
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    );
    await service.authenticate(keyHeaders(limited.key));
    return await expect(
      service.authenticate(keyHeaders(limited.key))
    ).rejects.toBeInstanceOf(AgentApiKeyRateLimitedError);
  });

  it("requires an active session to create, list or revoke", async () => {
    const { typedAuth } = createMemoryAuth();
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    );
    await expectAuthError(
      service.create(new Headers(), { name: "omp" }),
      401,
      "AUTH_REQUIRED"
    );
    await expectAuthError(service.list(new Headers()), 401, "AUTH_REQUIRED");
    return await expectAuthError(
      service.revoke(new Headers(), "key-1"),
      401,
      "AUTH_REQUIRED"
    );
  });

  return it("drops the stored hash when mapping plugin rows", () => {
    const record = toAgentApiKeyRecord({
      id: "k",
      key: "hashed",
      name: "n",
      prefix: "vrk_",
      start: "vrk_ab",
      enabled: true,
      createdAt: new Date(0),
      lastRequest: null,
      expiresAt: null,
      referenceId: "u",
    });
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain("hashed");
    return expect(toAgentApiKeyRecord({ id: "k" })).toBeNull();
  });
});

// @better-auth/api-key (1.7.14 to 1.8.0-beta.10) starts its expired-key
// DELETE without await in list/create/delete. In the app that DELETE outlived
// the request and hit a closed connection ("Connection terminated"). Each
// deleteMany here waits 25 ms of real time, so a DELETE that the service did
// not await is still pending when the service call resolves. Fake timers
// cannot replace this wait: the awaited cleanup must finish on its own while
// the service call runs. Under heavy load the unawaited case can finish early
// (a missed failure), never the reverse, so the wait cannot fail correct code.
const trackDeletes = () => {
  const state = { pending: 0 };
  const wrap: MemoryAdapterWrapper = (factory) => (options) => {
    const adapter = factory(options);
    return {
      ...adapter,
      deleteMany: async (args) => {
        state.pending += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return await adapter.deleteMany(args);
        } finally {
          state.pending -= 1;
        }
      },
    };
  };
  return { state, wrap };
};

// The plugin skips its cleanup for 10 s after the previous run (module-level
// timestamp). Move only Date forward, so every case starts outside that window.
let fakeNow = Date.now() + 3_600_000;
const leaveCleanupWindow = (): void => {
  fakeNow += 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fakeNow);
};

describe("createAgentApiKeyService expired key cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setUp = async () => {
    const tracked = trackDeletes();
    const { auth, rows, typedAuth } = createMemoryAuth(tracked.wrap);
    const { sessionHeaders } = await signUp(auth);
    const service = createAgentApiKeyService(
      typedAuth,
      ownerDatabase({ role: "member", status: "active" })
    );
    return { rows, service, sessionHeaders, tracked: tracked.state };
  };

  const operations = [
    {
      name: "create",
      run: async (service: AgentApiKeyService, headers: Headers) => {
        await service.create(headers, { name: "second" });
      },
    },
    {
      name: "list",
      run: async (service: AgentApiKeyService, headers: Headers) => {
        await service.list(headers);
      },
    },
    {
      name: "revoke",
      run: async (
        service: AgentApiKeyService,
        headers: Headers,
        keyId: string
      ) => {
        await service.revoke(headers, keyId);
      },
    },
  ];

  it.each(operations)(
    "leaves no expired-key DELETE running after $name returns",
    async ({ run }) => {
      const { service, sessionHeaders, tracked } = await setUp();
      const existing = await service.create(sessionHeaders, { name: "omp" });
      await vi.waitFor(() => expect(tracked.pending).toBe(0));

      leaveCleanupWindow();
      await run(service, sessionHeaders, existing.record.id);
      return expect(tracked.pending).toBe(0);
    }
  );

  return it("deletes expired keys before the request ends and keeps keys without expiry", async () => {
    leaveCleanupWindow();
    const { rows, service, sessionHeaders } = await setUp();
    const expired = await service.create(sessionHeaders, { name: "old" });
    const kept = await service.create(sessionHeaders, { name: "kept" });
    const expiredRow = rows["apiKeys"]!.find(
      (row) => row["id"] === expired.record.id
    );
    expect(expiredRow).toBeDefined();
    expiredRow!["expiresAt"] = new Date(fakeNow - 1000);

    leaveCleanupWindow();
    const listed = await service.list(sessionHeaders);
    expect(listed.map((row) => row.id)).toEqual([kept.record.id]);
    return expect(rows["apiKeys"]!.map((row) => row["id"])).toEqual([
      kept.record.id,
    ]);
  });
});
