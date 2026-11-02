import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { Database } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

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

// Real @better-auth/api-key plugin (production options) over Better Auth's
// in-memory adapter. Only the owner-status lookup uses a drizzle double.

type MemoryRows = Record<string, Record<string, unknown>[]>;

const createMemoryAuth = () => {
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
    database: memoryAdapter(rows),
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
