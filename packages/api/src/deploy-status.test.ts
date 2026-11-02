import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  DeployUpstreamStatusSchema,
  DeployUpstreamStatusV2Schema,
} from "./contracts/agent-ops.ts";
import v2Fixture from "./contracts/fixtures/deploy-status-v2-stopped-session.json";
import { setDeployStatusFetchOptionsForTesting } from "./server/agent-ops.ts";
import { createApiContext } from "./server/context.ts";
import {
  DeployStatusNotConfiguredError,
  DeployStatusUpstreamError,
  deployAgeSeconds,
  fetchDeploymentSnapshot,
  fetchDeploymentStatus,
  toDeploymentStatusV2,
  isDeployStatusStale,
  resolveDeployStatusConfig,
  toDeploymentStatus,
  type DeployStatusConfig,
} from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-09-29T12:00:00.000Z");
const TOKEN = "t".repeat(40);
const config: DeployStatusConfig = {
  url: "https://status.domain.test/vertex-status/v1",
  token: TOKEN,
};

const document = (overrides: Record<string, unknown> = {}) => ({
  schema: "vertex-deploy-status-v1",
  host: "quantvps",
  generatedAt: "2026-09-29T11:59:30Z",
  readOnly: true,
  services: [
    {
      service: "nautilus-trader",
      present: true,
      status: "created",
      running: false,
      health: null,
      startedAt: "0001-01-01T00:00:00Z",
      finishedAt: "0001-01-01T00:00:00Z",
      exitCode: 0,
      restartCount: 0,
      oomKilled: false,
      image: "vertex/nautilus:latest",
    },
    {
      service: "ib-gateway",
      present: true,
      status: "running",
      running: true,
      health: "healthy",
      startedAt: "2026-09-29T08:00:00Z",
      finishedAt: "0001-01-01T00:00:00Z",
      exitCode: 0,
      restartCount: 2,
      oomKilled: false,
      image: "ghcr.io/gnzsnz/ib-gateway:stable",
      log: {
        lastLineAt: "2026-09-29T11:59:00Z",
        lines: 500,
        errorLines: 3,
        warnLines: 7,
      },
    },
    { service: "watchdog", present: false },
  ],
  ...overrides,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
};

afterEach(() => setDeployStatusFetchOptionsForTesting({}));

describe("deploy status schema", () => {
  it("parses the upstream document and maps docker zero time to never", () => {
    const output = toDeploymentStatus(document(), at);
    const nautilus = output.services[0]!;
    expect(nautilus).toMatchObject({
      service: "nautilus-trader",
      present: true,
      status: "created",
      running: false,
      startedAt: null,
      finishedAt: null,
      log: null,
    });
    expect(output.services[1]).toMatchObject({
      startedAt: "2026-09-29T08:00:00Z",
      finishedAt: null,
      restartCount: 2,
      log: { errorLines: 3, warnLines: 7 },
    });
    expect(output.services[2]).toMatchObject({
      service: "watchdog",
      present: false,
      running: false,
      status: null,
      log: null,
    });
    expect(output.source).toEqual({
      host: "quantvps",
      generatedAt: "2026-09-29T11:59:30Z",
      ageSeconds: 30,
      stale: false,
    });
    return expect(output.fetchedAt).toBe(at.toISOString());
  });

  it("rejects unknown fields, wrong schema tags, non-read-only documents and bad timestamps", () => {
    expect(DeployUpstreamStatusSchema.safeParse(document()).success).toBe(true);
    expect(
      DeployUpstreamStatusSchema.safeParse(
        document({ schema: "vertex-deploy-status-v2" })
      ).success
    ).toBe(false);
    expect(
      DeployUpstreamStatusSchema.safeParse(document({ readOnly: false }))
        .success
    ).toBe(false);
    expect(
      DeployUpstreamStatusSchema.safeParse(document({ extra: 1 })).success
    ).toBe(false);
    expect(
      DeployUpstreamStatusSchema.safeParse(
        document({ generatedAt: "yesterday" })
      ).success
    ).toBe(false);
    expect(
      DeployUpstreamStatusSchema.safeParse(
        document({
          services: [{ service: "x", present: false, status: "running" }],
        })
      ).success
    ).toBe(false);
    return expect(() => toDeploymentStatus({ nope: true }, at)).toThrow(
      DeployStatusUpstreamError
    );
  });
});

describe("deploy status staleness", () =>
  it("marks snapshots older than 120 s as stale", () => {
    expect(deployAgeSeconds("2026-09-29T11:58:00Z", at)).toBe(120);
    expect(isDeployStatusStale(120)).toBe(false);
    expect(isDeployStatusStale(121)).toBe(true);
    expect(
      toDeploymentStatus(document({ generatedAt: "2026-09-29T11:57:00Z" }), at)
        .source
    ).toMatchObject({ ageSeconds: 180, stale: true });
    // Clock skew never yields a negative age.
    return expect(deployAgeSeconds("2026-09-29T12:01:00Z", at)).toBe(0);
  }));

describe("deploy status config: loopback http", () =>
  it("accepts loopback http only when allowed", () => {
    expect(
      resolveDeployStatusConfig(
        "http://127.0.0.1:8791/vertex-history/v1",
        TOKEN
      )
    ).toBeNull();
    expect(
      resolveDeployStatusConfig(
        "http://127.0.0.1:8791/vertex-history/v1",
        TOKEN,
        { allowLoopbackHttp: true }
      )
    ).toEqual({ url: "http://127.0.0.1:8791/vertex-history/v1", token: TOKEN });
    expect(
      resolveDeployStatusConfig("http://[::1]:8792/v1", TOKEN, {
        allowLoopbackHttp: true,
      })
    ).not.toBeNull();
    expect(
      resolveDeployStatusConfig("http://quantvps.tailnet.test/v1", TOKEN, {
        allowLoopbackHttp: true,
      })
    ).toBeNull();
    return expect(
      resolveDeployStatusConfig("https://status.domain.test/v1", TOKEN, {
        allowLoopbackHttp: true,
      })
    ).not.toBeNull();
  }));

describe("deploy status config", () =>
  it("requires both an https URL and a token of at least 32 characters", () => {
    expect(resolveDeployStatusConfig(undefined, undefined)).toBeNull();
    expect(resolveDeployStatusConfig(config.url, undefined)).toBeNull();
    expect(resolveDeployStatusConfig(undefined, TOKEN)).toBeNull();
    expect(
      resolveDeployStatusConfig("http://status.domain.test/v1", TOKEN)
    ).toBeNull();
    expect(
      resolveDeployStatusConfig(
        "https://user:pass@status.domain.test/v1",
        TOKEN
      )
    ).toBeNull();
    expect(resolveDeployStatusConfig(config.url, "short")).toBeNull();
    return expect(resolveDeployStatusConfig(config.url, TOKEN)).toEqual(config);
  }));

describe("deploy status fetch", () => {
  it("sends a bearer GET with manual redirects and parses the document", async () => {
    const doFetch = vi.fn(async () => jsonResponse(document()));
    const output = await fetchDeploymentStatus(config, {
      fetch: doFetch,
      now: () => at,
    });
    expect(output.services).toHaveLength(3);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(config.url);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    return expect(
      (init.headers as Record<string, string>)["authorization"]
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses redirects, non-JSON, oversize and malformed bodies without leaking the token", async () => {
    const cases: Array<() => Response> = [
      () => Response.redirect("https://elsewhere.test/", 302),
      () =>
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      () =>
        new Response("x".repeat(70_000), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => jsonResponse({ ...document(), readOnly: false }),
      () => new Response("unauthorized", { status: 401 }),
    ];

    for (const make of cases) {
      const failure = await fetchDeploymentStatus(config, {
        fetch: async () => make(),
        now: () => at,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployStatusUpstreamError);
      expect(String((failure as Error).message)).not.toContain(TOKEN);
    }
  });

  it("times out after the configured deadline", async () => {
    const hang = (_input: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        return init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    };
    return await expect(
      fetchDeploymentStatus(config, { fetch: hang, timeoutMs: 5 })
    ).rejects.toThrow("Status request timed out");
  });

  it("throws not-configured without any network call", async () => {
    const doFetch = vi.fn();
    await expect(
      fetchDeploymentStatus(null, { fetch: doFetch })
    ).rejects.toBeInstanceOf(DeployStatusNotConfiguredError);
    return expect(doFetch).not.toHaveBeenCalled();
  });
});

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-09-30T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  deployStatus: DeployStatusConfig | null,
  deployStatusV2: DeployStatusConfig | null = null
) => {
  const repositories = {
    profiles: {},
    addresses: {},
    userPreferences: {},
    featureItems: {},
    adminUsers: {},
    dashboard: {},
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
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
      deployStatus,
      deployStatusV2,
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

describe("agentOps.deployment.status procedure", () => {
  it("is gated by requireOperator and never calls upstream for denied callers", async () => {
    const doFetch = vi.fn(async () => jsonResponse(document()));
    setDeployStatusFetchOptionsForTesting({ fetch: doFetch, now: () => at });
    await expectCode(
      clientFor(null, config).agentOps.deployment.status({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), config).agentOps.deployment.status({}),
      "FORBIDDEN",
      403
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns parsed state for operators and typed errors otherwise", async () => {
    setDeployStatusFetchOptionsForTesting({
      fetch: async () => jsonResponse(document()),
      now: () => at,
    });
    const output = await clientFor(
      session("operator"),
      config
    ).agentOps.deployment.status({});
    expect(output).toMatchObject({
      configured: true,
      source: { host: "quantvps", stale: false },
    });
    expect(JSON.stringify(output)).not.toContain(TOKEN);
    await expectCode(
      clientFor(session("operator"), null).agentOps.deployment.status({}),
      "NOT_CONFIGURED",
      503
    );
    setDeployStatusFetchOptionsForTesting({
      fetch: async () => new Response("bad", { status: 500 }),
      now: () => at,
    });
    return await expectCode(
      clientFor(session("operator"), config).agentOps.deployment.status({}),
      "UPSTREAM_ERROR",
      502
    );
  });
});

const v2Config: DeployStatusConfig = {
  url: "https://quantvps.tailnet.test:8443/vertex-status/v2",
  token: TOKEN,
};
const v2Document = (overrides: Record<string, unknown> = {}) => ({
  ...structuredClone(v2Fixture),
  ...overrides,
});
const v2At = new Date("2026-10-03T11:19:00.000Z");

// Routes v1/v2 URLs to separate fakes so fallback ordering is observable.
const routedFetch = (
  v2: () => Response | Promise<Response>,
  v1: () => Response = () => jsonResponse(document())
) => {
  return vi.fn(async (input: string, _init: RequestInit) =>
    input === v2Config.url ? v2() : v1()
  );
};

describe("deploy status v2 schema", () => {
  it("parses the collector's stopped-session document", () => {
    const parsed = DeployUpstreamStatusV2Schema.safeParse(v2Document());
    expect(parsed.success).toBe(true);
    // v1 parser stays strict: a v2 document is never accepted as v1.
    return expect(
      DeployUpstreamStatusSchema.safeParse(v2Document()).success
    ).toBe(false);
  });

  it("maps v2 into the procedure output with session, risk and list blocks", () => {
    const output = toDeploymentStatusV2(v2Document(), v2At);
    expect(output.source).toMatchObject({
      host: "quantvps",
      ageSeconds: 30,
      stale: false,
    });
    expect(output.services).toHaveLength(7);
    expect(output.session).toMatchObject({
      available: true,
      state: "stopped",
      account_masked: "****0042",
    });
    expect(output.risk).toMatchObject({
      available: true,
      kill_switch: "clear",
    });
    expect(output.positions).toMatchObject({
      available: true,
      stale: true,
      count: 2,
    });
    expect(output.orders).toMatchObject({ available: true, count: 2 });
    expect(output.fills).toMatchObject({ available: true, count: 2 });
    expect(output.equity).toMatchObject({
      available: true,
      net_liq: 150_000.25,
    });
    expect(output.logs).toMatchObject({ available: true, count: 9 });
    return expect(output.snapshotError).toBeUndefined();
  });

  it("accepts unavailable blocks with a reason and rejects drift", () => {
    const withheld = {
      available: false,
      source: "guard",
      reason: "withheld: leak pattern",
    };
    const output = toDeploymentStatusV2(
      v2Document({ positions: withheld, risk: withheld, session: withheld }),
      v2At
    );
    expect(output.positions).toEqual(withheld);
    expect(output.risk).toEqual(withheld);
    expect(
      DeployUpstreamStatusV2Schema.safeParse(v2Document({ extra: 1 })).success
    ).toBe(false);
    expect(
      DeployUpstreamStatusV2Schema.safeParse(
        v2Document({ positions: { available: false } })
      ).success
    ).toBe(false);
    const badState = v2Document();
    badState.session = { ...badState.session, state: "launching" };
    expect(DeployUpstreamStatusV2Schema.safeParse(badState).success).toBe(
      false
    );
    const badKill = v2Document();
    badKill.risk = { ...badKill.risk, kill_switch: "maybe" };
    expect(DeployUpstreamStatusV2Schema.safeParse(badKill).success).toBe(false);
    expect(
      DeployUpstreamStatusV2Schema.safeParse(v2Document({ readOnly: false }))
        .success
    ).toBe(false);
    return expect(() => toDeploymentStatusV2(document(), v2At)).toThrow(
      DeployStatusUpstreamError
    );
  });
});

describe("deploy status v2 fetch and fallback", () => {
  it("fetches v2 only when configured, with the bearer GET and no redirects", async () => {
    const doFetch = routedFetch(() => jsonResponse(v2Document()));
    const output = await fetchDeploymentSnapshot(config, v2Config, {
      fetch: doFetch,
      now: () => v2At,
    });
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(v2Config.url);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(output.session).toMatchObject({ state: "stopped" });
    const v1Only = await fetchDeploymentSnapshot(config, null, {
      fetch: doFetch,
      now: () => at,
    });
    expect(v1Only.session).toBeUndefined();
    return expect(v1Only.snapshotError).toBeUndefined();
  });

  it("allows v2 bodies up to 256 KiB but not beyond", async () => {
    const padded = v2Document();
    padded.logs = { ...padded.logs, source: "x".repeat(1900) };
    const big = JSON.stringify(padded) + " ".repeat(100_000);
    const ok = await fetchDeploymentSnapshot(config, v2Config, {
      fetch: routedFetch(
        () =>
          new Response(big, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      ),
      now: () => v2At,
    });
    expect(ok.snapshotError).toBeUndefined();
    const huge = JSON.stringify(padded) + " ".repeat(300_000);
    const fallback = await fetchDeploymentSnapshot(config, v2Config, {
      fetch: routedFetch(
        () =>
          new Response(huge, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      ),
      now: () => at,
    });
    return expect(fallback.snapshotError).toBe(
      "Tailnet snapshot unavailable: Status response exceeds the size cap"
    );
  });

  it("falls back to v1 with a snapshotError reason when v2 fails", async () => {
    const cases: [() => Response, string][] = [
      [() => new Response("no", { status: 403 }), "HTTP 403"],
      [() => Response.redirect("https://elsewhere.test/", 302), "HTTP 302"],
      [
        () => jsonResponse({ ...v2Document(), session: { available: true } }),
        "schema validation",
      ],
      [
        () => {
          throw new Error(`boom ${TOKEN}`);
        },
        "request failed",
      ],
    ];

    for (const [make, reason] of cases) {
      const output = await fetchDeploymentSnapshot(config, v2Config, {
        fetch: routedFetch(make),
        now: () => at,
      });
      expect(output.services).toHaveLength(3);
      expect(output.session).toBeUndefined();
      expect(output.snapshotError).toContain(reason);
      expect(JSON.stringify(output)).not.toContain(TOKEN);
    }
  });

  it("reports the v2 reason as an upstream error when v1 is not configured", async () =>
    await expect(
      fetchDeploymentSnapshot(null, v2Config, {
        fetch: routedFetch(() => new Response("no", { status: 401 })),
      })
    ).rejects.toThrow(
      "Tailnet snapshot unavailable: Status endpoint returned HTTP 401"
    ));
});

describe("agentOps.deployment.status with v2", () =>
  it("returns v2 blocks to operators, never the token, and falls back to v1", async () => {
    setDeployStatusFetchOptionsForTesting({
      fetch: routedFetch(() => jsonResponse(v2Document())),
      now: () => v2At,
    });
    const output = await clientFor(
      session("operator"),
      config,
      v2Config
    ).agentOps.deployment.status({});
    expect(output.session).toMatchObject({ state: "stopped" });
    expect(output.risk).toMatchObject({ kill_switch: "clear" });
    expect(JSON.stringify(output)).not.toContain(TOKEN);
    setDeployStatusFetchOptionsForTesting({
      fetch: routedFetch(() => new Response("no", { status: 403 })),
      now: () => at,
    });
    const fallback = await clientFor(
      session("operator"),
      config,
      v2Config
    ).agentOps.deployment.status({});
    expect(fallback.session).toBeUndefined();
    return expect(fallback.snapshotError).toBe(
      "Tailnet snapshot unavailable: Status endpoint returned HTTP 403"
    );
  }));
