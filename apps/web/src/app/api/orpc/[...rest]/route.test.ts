import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const env = {
    APP_ENV: "test",
    APP_URL: "https://darkfactory.localhost",
    BETTER_AUTH_SECRET: "configured-secret".repeat(2),
    BETTER_AUTH_URL: "https://darkfactory.localhost",
    CONTACT_EMAIL_TO: "support@domain.test",
    CONTACT_THROTTLE_SECRET: "contact-throttle-secret".repeat(2),
    EMAIL_FROM: "DarkFactory <noreply@domain.test>",
    EMAIL_TRANSPORT: "preview",
    OTEL_ENABLED: true,
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.configured.test:4318/base",
    OTEL_SERVICE_NAME: "darkfactory-web",
    POSTHOG_HOST: "https://analytics.configured.test",
    POSTHOG_KEY: "configured-posthog-key",
    RESEND_API_KEY: undefined,
  } as Record<string, unknown>;
  const scope = {
    auth: { auth: true },
    db: { request: true },
    env,
    requestId: "request-stable",
    schedule: vi.fn(),
    sink: { emit: vi.fn() },
  };
  const span = { addEvent: vi.fn(), correlation: {}, recordMetric: vi.fn() };
  const withSpan = vi.fn(
    async (_input: unknown, run: (s: unknown) => unknown) => run(span)
  );
  const forceFlush = vi.fn(async () => undefined);
  const consumeContactThrottle = vi.fn();
  return {
    consumeContactThrottle,
    createApiContext: vi.fn((_request: Request, dependencies: object) => ({
      ...dependencies,
    })),
    createContactThrottleRepository: vi.fn(() => ({
      consume: consumeContactThrottle,
    })),
    createPostHogAnalyticsPort: vi.fn(() => ({ capture: vi.fn() })),
    createRepositories: vi.fn(() => ({ featureItems: {} })),
    createSemanticEventFanout: vi.fn(
      (_options: { resolveConsent: () => string }) => ({ emit: vi.fn() })
    ),
    env,
    forceFlush,
    handleOrpcRequest: vi.fn(
      async (_request: Request, _context: unknown) =>
        new Response("handled", { status: 202 })
    ),
    initializeTelemetry: vi.fn(() => ({ forceFlush, withSpan })),
    parseServerEnv: vi.fn(() => env),
    requireRole: vi.fn(),
    requireSession: vi.fn(),
    scope,
    selectContactEmailPort: vi.fn(() => ({ sendContact: vi.fn() })),
    span,
    waitUntil: vi.fn((task: Promise<unknown>) => {
      task.catch(() => undefined);
    }),
    withRequestScope: vi.fn(
      async (
        _request: Request,
        _waitUntil: unknown,
        run: (value: typeof scope) => Promise<Response>,
        _internalParentRequestId?: string
      ) => run(scope)
    ),
    withSpan,
  };
});

// route.ts reads optional Worker bindings (runtime config, local setup plan,
// notification destinations, artifacts); none are configured in these tests.
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: mocks.waitUntil }));
vi.mock("../../../../server/request-scope.ts", () => ({
  withRequestScope: mocks.withRequestScope,
}));
// Inert Vertex stubs shaped as route.ts consumes them: no runtime options, no
// extra context dependencies and no local setup service.
vi.mock("@darkfactory/api/server", () => ({
  createApiContext: mocks.createApiContext,
  createVertexLocalSetupService: vi.fn(() => undefined),
  createVertexPlatformRequestDependencies: vi.fn(() => ({
    contextDependencies: {},
  })),
  createVertexRuntimeConfiguredOptions: vi.fn(() => ({ options: {} })),
  resolveDeployStatusConfig: vi.fn(() => null),
  resolvePriceAlertsNtfyConfig: vi.fn(() => null),
  resolveJevConfig: vi.fn(() => null),
  resolveMarketHistoryConfig: vi.fn(() => null),
  resolveQuantDataConfig: vi.fn(() => null),
  setResearchContactEmail: vi.fn(),
}));
vi.mock("@darkfactory/analytics/server/posthog", () => ({
  createPostHogAnalyticsPort: mocks.createPostHogAnalyticsPort,
}));
vi.mock("@darkfactory/auth/server", () => ({
  createAgentApiKeyService: vi.fn(() => ({})),
  requireRole: mocks.requireRole,
  requireSession: mocks.requireSession,
}));
vi.mock("@darkfactory/config/server", () => ({
  getProviderCapabilities: () => ({ ai: false }),
  parseServerEnv: mocks.parseServerEnv,
}));
vi.mock("@darkfactory/db/server", () => ({
  createContactThrottleRepository: mocks.createContactThrottleRepository,
  createRepositories: mocks.createRepositories,
}));
vi.mock("@darkfactory/email/server", () => ({
  createResendNotificationEmailPort: vi.fn(() => ({})),
  selectContactEmailPort: mocks.selectContactEmailPort,
}));
vi.mock("@darkfactory/observability/server/fanout", () => ({
  createSemanticEventFanout: mocks.createSemanticEventFanout,
}));
vi.mock("@darkfactory/observability/server/otel", () => ({
  initializeTelemetry: mocks.initializeTelemetry,
}));
vi.mock("./handler.ts", () => ({ handleOrpcRequest: mocks.handleOrpcRequest }));
const verifyOwnPassword = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../../lib/verify-own-password.ts", () => ({
  verifyOwnPassword,
}));

import { CONTACT_REQUEST_MAX_BYTES } from "./contact-runtime.ts";
import {
  DELETE,
  GET,
  handleOrpcRuntimeRequest,
  ORPC_REQUEST_MAX_BYTES,
  PATCH,
  POST,
} from "./route.ts";

const ORIGIN = "https://darkfactory.localhost";
const contactRequest = (init: RequestInit = {}) =>
  new Request(`${ORIGIN}/api/orpc/contact/submit`, {
    body: "{}",
    method: "POST",
    ...init,
    headers: { origin: ORIGIN, ...init.headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("E2E_FIXTURES", "0");
  mocks.handleOrpcRequest.mockImplementation(
    async () => new Response("handled", { status: 202 })
  );
  mocks.consumeContactThrottle.mockResolvedValue({
    allowed: true,
    remaining: 4,
    retryAfterSeconds: 0,
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("oRPC Worker route composition", () => {
  it("runs one correlated span, lazy runtimes and the API context inside the scope", async () => {
    const first = new Request(`${ORIGIN}/api/orpc/featureItems/create`, {
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-analytics-consent": "granted",
      },
      method: "POST",
    });
    const second = new Request(`${ORIGIN}/api/orpc/featureItems/update`, {
      headers: { origin: ORIGIN },
      method: "POST",
    });

    expect((await POST(first)).status).toBe(202);
    expect((await POST(second)).status).toBe(202);

    expect(mocks.withRequestScope).toHaveBeenCalledTimes(2);
    expect(mocks.withRequestScope.mock.calls[0]![1]).toBe(mocks.waitUntil);
    // Route exports never forward an internal parent id.
    expect(mocks.withRequestScope.mock.calls[0]![3]).toBeUndefined();
    expect(mocks.initializeTelemetry).toHaveBeenCalledOnce();
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith({
      enabled: true,
      otlpAllowedHosts: ["collector.configured.test"],
      otlpEndpoint: "https://collector.configured.test:4318/base",
      serviceName: "darkfactory-web",
    });
    expect(mocks.createPostHogAnalyticsPort).toHaveBeenCalledOnce();
    expect(mocks.withSpan.mock.calls[0]![0]).toEqual({
      attributes: { "rpc.system": "orpc" },
      correlation: { requestId: "request-stable", route: "/api/orpc" },
      name: "orpc.request",
    });
    expect(mocks.forceFlush).toHaveBeenCalledTimes(2);

    const dependencies = mocks.createApiContext.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(dependencies).toMatchObject({
      capabilities: { ai: false },
      repositories: { featureItems: {} },
      requestId: "request-stable",
      span: mocks.span,
      waitUntil: mocks.waitUntil,
    });
    expect(dependencies).not.toHaveProperty("contactThrottleKey");
    expect(mocks.createRepositories).toHaveBeenCalledWith(mocks.scope.db);
    const fanout = mocks.createSemanticEventFanout.mock.calls.map(
      ([options]) => options
    );
    expect(fanout[0]).toMatchObject({ sink: mocks.scope.sink });
    expect(fanout[0]!.resolveConsent()).toBe("granted");
    expect(fanout[1]!.resolveConsent()).toBe("unknown");

    const headers = new Headers({ authorization: "Bearer opaque" });
    await (dependencies["requireSession"] as (h: Headers) => unknown)(headers);
    await (dependencies["requireRole"] as (h: Headers, r: string) => unknown)(
      headers,
      "admin"
    );
    expect(mocks.requireSession).toHaveBeenCalledWith(
      mocks.scope.auth,
      headers
    );
    expect(mocks.requireRole).toHaveBeenCalledWith(
      mocks.scope.auth,
      headers,
      "admin"
    );
    await expect(
      (dependencies["verifyPassword"] as (h: Headers, p: string) => unknown)(
        headers,
        "pw-test"
      )
    ).resolves.toBe(true);
    expect(verifyOwnPassword).toHaveBeenCalledWith(
      undefined,
      headers,
      "pw-test"
    );
  });

  it("rejects unsupported methods and unsafe origins before opening a scope", async () => {
    const put = await handleOrpcRuntimeRequest(
      new Request(`${ORIGIN}/api/orpc/dashboard/summary`, { method: "PUT" }),
      mocks.waitUntil
    );
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST, PATCH, DELETE");

    for (const headers of [
      {},
      { origin: "https://attacker.invalid" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
    ]) {
      const response = await POST(
        new Request(`${ORIGIN}/api/orpc/preferences/update`, {
          headers,
          method: "POST",
        })
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.withRequestScope).not.toHaveBeenCalled();
  });

  it("rejects declared, lying, and lengthless oversized bodies before opening a scope", async () => {
    const oversizedStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(ORPC_REQUEST_MAX_BYTES));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
    const url = `${ORIGIN}/api/orpc/featureItems/create`;
    const declared = new Request(url, {
      body: "small",
      headers: {
        "content-length": String(ORPC_REQUEST_MAX_BYTES + 1),
        origin: ORIGIN,
      },
      method: "POST",
    });
    const lying = new Request(url, {
      body: oversizedStream(),
      duplex: "half",
      headers: { "content-length": "1", origin: ORIGIN },
      method: "POST",
    } as RequestInit);
    const lengthless = new Request(url, {
      body: oversizedStream(),
      duplex: "half",
      headers: { origin: ORIGIN },
      method: "POST",
    } as RequestInit);
    lengthless.headers.delete("content-length");

    const responses = await Promise.all([
      POST(declared),
      POST(lying),
      POST(lengthless),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([413, 413, 413]);
    expect(mocks.withRequestScope).not.toHaveBeenCalled();
  });

  it("hands the scope an exact-boundary body with its request metadata", async () => {
    const request = new Request(
      `${ORIGIN}/api/orpc/featureItems/update?source=operator`,
      {
        body: new Uint8Array(ORPC_REQUEST_MAX_BYTES),
        headers: {
          "content-type": "application/octet-stream",
          origin: ORIGIN,
          "x-request-marker": "preserved",
        },
        method: "PATCH",
      }
    );
    request.headers.delete("content-length");

    expect((await PATCH(request)).status).toBe(202);
    const forwarded = mocks.handleOrpcRequest.mock.calls[0]![0];
    expect(mocks.withRequestScope.mock.calls[0]![0]).toBe(forwarded);
    expect(forwarded).not.toBe(request);
    expect(forwarded.url).toBe(request.url);
    expect(forwarded.headers.get("x-request-marker")).toBe("preserved");
    expect((await forwarded.arrayBuffer()).byteLength).toBe(
      ORPC_REQUEST_MAX_BYTES
    );
  });

  it("serves every exported HTTP method through the same scope", async () => {
    await expect(
      GET(new Request(`${ORIGIN}/api/orpc/dashboard/summary`))
    ).resolves.toMatchObject({ status: 202 });
    for (const [handler, method] of [
      [PATCH, "PATCH"],
      [DELETE, "DELETE"],
    ] as const) {
      await expect(
        handler(
          new Request(`${ORIGIN}/api/orpc/featureItems/archive`, {
            headers: { origin: ORIGIN },
            method,
          })
        )
      ).resolves.toMatchObject({ status: 202 });
    }
    expect(mocks.withRequestScope).toHaveBeenCalledTimes(3);
  });

  it("omits optional telemetry and analytics configuration when absent", async () => {
    mocks.parseServerEnv.mockReturnValueOnce({
      ...mocks.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      POSTHOG_HOST: undefined,
      POSTHOG_KEY: undefined,
    });
    const scopeEnv = mocks.scope.env;
    mocks.scope.env = {
      ...mocks.env,
      POSTHOG_HOST: undefined,
      POSTHOG_KEY: undefined,
    };
    vi.resetModules();
    // A fresh module instance is the only way to observe the lazy, module-level runtimes being built.
    const freshRoute = await import("./route.ts");

    try {
      await expect(
        freshRoute.GET(new Request(`${ORIGIN}/api/orpc/dashboard/summary`))
      ).resolves.toMatchObject({ status: 202 });
    } finally {
      mocks.scope.env = scopeEnv;
    }
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith({
      enabled: true,
      serviceName: "darkfactory-web",
    });
    expect(mocks.createPostHogAnalyticsPort).toHaveBeenCalledWith({});
  });
});

describe("oRPC contact submission admission", () => {
  it("adds the contact ports after the edge throttle admits the request", async () => {
    expect((await POST(contactRequest())).status).toBe(202);

    expect(mocks.createContactThrottleRepository).toHaveBeenCalledWith(
      mocks.scope.db,
      { maxRequests: 30 }
    );
    expect(mocks.createContactThrottleRepository).toHaveBeenCalledWith(
      mocks.scope.db
    );
    const [edgeKey] = mocks.consumeContactThrottle.mock.calls[0]!;
    const dependencies = mocks.createApiContext.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(dependencies["contactThrottleKey"]).toEqual(expect.any(String));
    expect(dependencies["contactThrottleKey"]).not.toBe(edgeKey);
    expect(dependencies["contactDelivery"]).toEqual({
      sendContact: expect.any(Function),
    });
    expect(mocks.selectContactEmailPort).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "test",
        previewDirectory: undefined,
        recipient: "support@domain.test",
      })
    );
  });

  it("counts malformed contact requests in the pre-parse edge bucket", async () => {
    mocks.handleOrpcRequest.mockResolvedValue(
      new Response("invalid", { status: 400 })
    );
    mocks.consumeContactThrottle
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 600,
      });

    const accepted = await POST(contactRequest({ body: "{" }));
    const denied = await POST(contactRequest({ body: "{" }));

    expect(accepted.status).toBe(400);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("600");
    await expect(denied.json()).resolves.toMatchObject({
      json: { code: "TOO_MANY_REQUESTS", defined: true, status: 429 },
    });
    expect(mocks.handleOrpcRequest).toHaveBeenCalledOnce();
  });

  it("returns 413 for an oversized declared or chunked payload only after edge throttling", async () => {
    const declared = await POST(
      contactRequest({
        body: "small",
        headers: { "content-length": String(CONTACT_REQUEST_MAX_BYTES + 1) },
      })
    );
    const chunked = await POST(
      contactRequest({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(CONTACT_REQUEST_MAX_BYTES));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );

    expect([declared.status, chunked.status]).toEqual([413, 413]);
    await expect(declared.json()).resolves.toMatchObject({
      json: { code: "PAYLOAD_TOO_LARGE", defined: true, status: 413 },
    });
    expect(mocks.consumeContactThrottle).toHaveBeenCalledTimes(2);
    expect(mocks.withRequestScope).toHaveBeenCalledTimes(2);
    expect(mocks.handleOrpcRequest).not.toHaveBeenCalled();
  });

  it("gives an edge denial precedence over an oversized payload", async () => {
    mocks.consumeContactThrottle.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 45,
    });

    const response = await POST(
      contactRequest({
        body: "small",
        headers: { "content-length": String(CONTACT_REQUEST_MAX_BYTES + 1) },
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(mocks.handleOrpcRequest).not.toHaveBeenCalled();
  });

  it("returns a typed 503 when edge throttle storage fails", async () => {
    mocks.consumeContactThrottle.mockRejectedValueOnce(
      new Error("private database detail")
    );

    const response = await POST(contactRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      json: { code: "SERVICE_UNAVAILABLE", defined: true, status: 503 },
    });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(mocks.handleOrpcRequest).not.toHaveBeenCalled();
  });

  it("isolates the contact preview inside a proven E2E run", async () => {
    const runId = "route_run";
    vi.stubEnv("E2E_FIXTURES", "1");
    vi.stubEnv("E2E_RUN_ID", runId);
    vi.stubEnv("E2E_EMAIL_PREVIEW_HMAC_KEY", "a".repeat(43));
    vi.stubEnv(
      "E2E_EMAIL_PREVIEW_ENDPOINT",
      "http://127.0.0.1:43123/v1/capture"
    );
    vi.stubEnv(
      "E2E_EMAIL_PREVIEW_DIRECTORY",
      `/repo/test-results/e2e-runs/${runId}/previews/auth`
    );

    expect((await POST(contactRequest())).status).toBe(202);
    expect(mocks.selectContactEmailPort).toHaveBeenCalledWith(
      expect.objectContaining({
        previewBinding: { hmacKey: "a".repeat(43), runId },
        previewCaptureEndpoint: "http://127.0.0.1:43123/v1/capture",
        previewDirectory: `/repo/test-results/e2e-runs/${runId}/previews/contact`,
      })
    );
  });
});
