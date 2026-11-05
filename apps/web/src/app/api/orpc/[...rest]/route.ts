// What: Worker entry for /api/orpc: origin checks, body limits, telemetry, contact runtime and API handler.
// Used by: Next.js route (GET/POST/PATCH/DELETE); apps/web/src/lib/server-internal-dispatch.ts#dispatchInternalOrpcRequest.
// See: docs/debugging.md#symptom--where-to-look (unsafeRequestDenied, ORPC_REQUEST_MAX_BYTES); packages/api/src/server/router.ts#appRouter.
import {
  env as workerBindings,
  waitUntil as workerWaitUntil,
} from "cloudflare:workers";
import { createPostHogAnalyticsPort } from "@darkfactory/analytics/server/posthog";
import { CONTACT_ERRORS, vertexWorkerRequestMaxBytes } from "@darkfactory/api";
import {
  type ApiContextDependencies,
  createApiContext,
  createVertexLocalSetupService,
  createVertexPlatformRequestDependencies,
  createVertexRuntimeConfiguredOptions,
  resolveDeployStatusConfig,
  resolvePriceAlertsNtfyConfig,
  resolveJevConfig,
  resolveQuantDataConfig,
} from "@darkfactory/api/server";
import {
  createAgentApiKeyService,
  requireRole,
  requireSession,
} from "@darkfactory/auth/server";
import {
  getProviderCapabilities,
  parseServerEnv,
  type ServerEnv,
} from "@darkfactory/config/server";
import {
  type BackgroundTaskScheduler,
  type ContactThrottleResult,
  createContactThrottleRepository,
  createRepositories,
} from "@darkfactory/db/server";
import {
  createResendNotificationEmailPort,
  selectContactEmailPort,
} from "@darkfactory/email/server";
import { createSemanticEventFanout } from "@darkfactory/observability/server/fanout";
import { initializeTelemetry } from "@darkfactory/observability/server/otel";

import { bufferBoundedRequest } from "../../../../lib/bounded-request-body.ts";
import { resolveE2eAssistantModelOverride } from "../../../../lib/e2e-fixtures.ts";
import { resolveEmailPreviewOptions } from "../../../../lib/email-preview-options.ts";
import { createVertexObjectsForScope } from "../../../../lib/server-vertex-objects.ts";
import { verifyOwnPassword } from "../../../../lib/verify-own-password.ts";
import {
  type WebRequestScope,
  withRequestScope,
} from "../../../../server/request-scope.ts";
import {
  bufferContactRequest,
  createContactThrottleKey,
} from "./contact-runtime.ts";
import { handleOrpcRequest } from "./handler.ts";
import {
  configuredOtlpAllowedHosts,
  resolveAnalyticsConsent,
  runWithRequestTelemetry,
} from "./runtime.ts";

let telemetryRuntime: ReturnType<typeof initializeTelemetry> | undefined;
let analyticsPort: ReturnType<typeof createPostHogAnalyticsPort> | undefined;

const telemetryFor = (env: ServerEnv) => {
  telemetryRuntime ??= initializeTelemetry({
    enabled: env.OTEL_ENABLED,
    serviceName: env.OTEL_SERVICE_NAME,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : {
          otlpAllowedHosts: configuredOtlpAllowedHosts(
            env.OTEL_EXPORTER_OTLP_ENDPOINT
          ),
          otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        }),
  });
  return telemetryRuntime;
};

const analyticsFor = (env: ServerEnv) => {
  analyticsPort ??= createPostHogAnalyticsPort({
    ...(env.POSTHOG_KEY === undefined ? {} : { apiKey: env.POSTHOG_KEY }),
    ...(env.POSTHOG_HOST === undefined ? {} : { host: env.POSTHOG_HOST }),
  });
  return analyticsPort;
};

const unsafeRequestDenied = (request: Request, appUrl: string): boolean => {
  if (!["POST", "PATCH", "DELETE"].includes(request.method.toUpperCase()))
    return false;
  const trustedOrigin = new URL(appUrl).origin;
  if (request.headers.get("origin") !== trustedOrigin) return true;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite !== null && fetchSite !== "same-origin";
};

const forbiddenOriginResponse = (): Response => {
  return Response.json({ error: "Forbidden" }, { status: 403 });
};

const SUPPORTED_ORPC_METHODS: readonly string[] = [
  "GET",
  "POST",
  "PATCH",
  "DELETE",
];
const BODY_BEARING_ORPC_METHODS: readonly string[] = [
  "POST",
  "PATCH",
  "DELETE",
];
export const ORPC_REQUEST_MAX_BYTES = 1024 * 1024;

const methodNotAllowedResponse = (): Response => {
  return new Response("Method Not Allowed", {
    headers: { allow: SUPPORTED_ORPC_METHODS.join(", ") },
    status: 405,
  });
};

const payloadTooLargeResponse = (): Response => {
  return Response.json({ error: "Payload Too Large" }, { status: 413 });
};

const CONTACT_EDGE_MAX_REQUESTS = 30;

const contactAbuseResponse = (
  code: "PAYLOAD_TOO_LARGE" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE",
  retryAfterSeconds?: number
): Response => {
  const definition = CONTACT_ERRORS[code];
  const error = {
    code,
    defined: true,
    message: definition.message,
    status: definition.status,
  };
  return Response.json(
    { json: error },
    {
      status: definition.status,
      ...(retryAfterSeconds === undefined
        ? {}
        : { headers: { "retry-after": String(retryAfterSeconds) } }),
    }
  );
};

type ContactDependencies = Required<
  Pick<
    ApiContextDependencies,
    "contactDelivery" | "contactThrottle" | "contactThrottleKey"
  >
>;

/** Edge throttle first (it also counts malformed and oversized submissions), then the submit key and delivery port. */
const admitContactSubmission = async (
  scope: WebRequestScope,
  request: Request,
  tooLarge: boolean
): Promise<ContactDependencies | Response> => {
  const edgeThrottle = createContactThrottleRepository(scope.db, {
    maxRequests: CONTACT_EDGE_MAX_REQUESTS,
  });
  const edgeKey = await createContactThrottleKey(
    request,
    scope.env.CONTACT_THROTTLE_SECRET,
    "edge"
  );
  let edgeResult: ContactThrottleResult;
  try {
    edgeResult = await edgeThrottle.consume(edgeKey);
  } catch {
    return contactAbuseResponse("SERVICE_UNAVAILABLE");
  }
  if (!edgeResult.allowed) {
    return contactAbuseResponse(
      "TOO_MANY_REQUESTS",
      edgeResult.retryAfterSeconds
    );
  }
  if (tooLarge) return contactAbuseResponse("PAYLOAD_TOO_LARGE");

  const previewOptions = resolveEmailPreviewOptions(scope.env);
  return {
    contactDelivery: selectContactEmailPort({
      environment: scope.env.APP_ENV,
      from: scope.env.EMAIL_FROM,
      previewBinding: previewOptions?.binding,
      previewCaptureEndpoint: previewOptions?.captureEndpoint,
      previewDirectory: previewOptions?.contactDirectory,
      recipient: scope.env.CONTACT_EMAIL_TO,
      resendApiKey: scope.env.RESEND_API_KEY,
      transport: scope.env.EMAIL_TRANSPORT,
      trustedAppOrigin: scope.env.APP_URL,
    }),
    contactThrottle: createContactThrottleRepository(scope.db),
    contactThrottleKey: await createContactThrottleKey(
      request,
      scope.env.CONTACT_THROTTLE_SECRET,
      "submit"
    ),
  };
};

/**
 * Vertex request dependencies: runtime configuration, research objects, local
 * setup, agent API keys, the operator allow-list, read-only deploy status and
 * the server-side research assistant. Unconfigured bindings stay disabled.
 */
const vertexContextDependencies = (
  scope: WebRequestScope,
  request: Request,
  dispatch: (internal: Request) => Promise<Response>
) => {
  const { env } = scope;
  const objectsForScope =
    env.STORAGE_ENABLED && env.STORAGE_PROVIDER === "r2"
      ? createVertexObjectsForScope(workerBindings["VERTEX_ARTIFACTS"])
      : undefined;
  const notificationEmailPort =
    env.EMAIL_TRANSPORT === "resend"
      ? createResendNotificationEmailPort({
          apiKey: env.RESEND_API_KEY,
          enabled: true,
          fetcher: fetch,
          from: env.EMAIL_FROM,
        })
      : undefined;
  const runtimeConfiguration = createVertexRuntimeConfiguredOptions({
    bindings: {
      VERTEX_NOTIFICATION_EMAIL_DESTINATION:
        workerBindings["VERTEX_NOTIFICATION_EMAIL_DESTINATION"],
      VERTEX_NOTIFICATION_PHONE_DESTINATION:
        workerBindings["VERTEX_NOTIFICATION_PHONE_DESTINATION"],
      VERTEX_NOTIFICATION_PHONE_TOKEN:
        workerBindings["VERTEX_NOTIFICATION_PHONE_TOKEN"],
      ...(notificationEmailPort === undefined
        ? {}
        : { VERTEX_NOTIFICATION_EMAIL_PORT: notificationEmailPort }),
    },
    configuration: workerBindings["VERTEX_RUNTIME_CONFIG"],
    db: scope.db,
    fetcher: fetch,
    requestHeaders: request.headers,
    requireSession: (headers) => requireSession(scope.auth, headers),
    signal: request.signal,
  });
  const vertexDependencies = createVertexPlatformRequestDependencies({
    ...runtimeConfiguration.options,
    db: scope.db,
    maximumContentBytes: 1024 * 1024,
    signal: request.signal,
    ...(objectsForScope === undefined ? {} : { objectsForScope }),
  });
  const vertexLocalSetup = createVertexLocalSetupService({
    appUrl: env.APP_URL,
    authUrl: env.BETTER_AUTH_URL,
    configuration: workerBindings["VERTEX_LOCAL_RESEARCH_SETUP_PLAN"],
    db: scope.db,
    environment: env.APP_ENV,
    request,
    requireSession: () => requireSession(scope.auth, request.headers),
  });
  return {
    ...vertexDependencies.contextDependencies,
    ...(vertexLocalSetup === undefined ? {} : { vertexLocalSetup }),
    // Agent API keys: verified only by agentOps.*/papers.*; the handler
    // interceptor rejects x-api-key requests on every other procedure.
    agentApiKeys: createAgentApiKeyService(scope.auth, scope.db),
    // Research assistant: the OpenRouter key stays server-side. Tool calls are internal oRPC
    // requests on this origin carrying only this request's session cookie.
    assistant: {
      apiKey: env.OPENROUTER_API_KEY ?? null,
      appOrigin: new URL(env.APP_URL).origin,
      dispatch,
      model: env.VERTEX_ASSISTANT_MODEL,
      // E2E runs only: the fake model endpoint; `{}` everywhere else.
      ...resolveE2eAssistantModelOverride(),
    },
    // Read-only QuantVPS status endpoint; the token stays server-side (agentOps.deployment.status).
    deployStatus: resolveDeployStatusConfig(
      env.VERTEX_DEPLOY_STATUS_URL,
      env.VERTEX_DEPLOY_STATUS_TOKEN
    ),
    deployStatusV2: resolveDeployStatusConfig(
      env.VERTEX_DEPLOY_STATUS_V2_URL,
      env.VERTEX_DEPLOY_STATUS_TOKEN
    ),
    // Portfolio tab: read-only proxy to ibkr-monitor on loopback (allow-listed GET endpoints only).
    ibkrMonitor: env.IBKR_MONITOR_URL ?? null,
    // Engines and Market context views: rig status files pushed to QuantVPS, served on loopback
    // (engines.status, marketContext.get).
    engineStatus: env.ENGINE_STATUS_URL ?? null,
    marketHistory: resolveDeployStatusConfig(
      env.VERTEX_HISTORY_URL,
      env.VERTEX_DEPLOY_STATUS_TOKEN,
      { allowLoopbackHttp: true }
    ),
    // Operator allow-list (fail closed when unset) for agentOps.*, papers.*, agentApiKeys.*.
    operatorEmails: env.VERTEX_OPERATOR_EMAILS,
    // Read-only IBKR portfolio monitor (portfolioMonitor.snapshot); operator-only, never agent keys.
    portfolioMonitor: resolveDeployStatusConfig(
      env.VERTEX_PORTFOLIO_URL,
      env.VERTEX_DEPLOY_STATUS_TOKEN,
      { allowLoopbackHttp: true }
    ),
    // Display-only JEV verdict on /charts (jevVerdict.*); the OpenRouter key stays server-side.
    jev: resolveJevConfig(env.OPENROUTER_API_KEY),
    // Read-only QuantData options analytics (optionsAnalytics.snapshot); key stays server-side.
    quantData: resolveQuantDataConfig(
      env.QUANTDATA_API_BASE_URL,
      env.QUANTDATA_API_KEY
    ),
    // Read-only research lens documents (researchLenses.*); operator-only, never agent keys.
    researchLenses: resolveDeployStatusConfig(
      env.VERTEX_RESEARCH_LENSES_URL,
      env.VERTEX_DEPLOY_STATUS_TOKEN
    ),
    // Price alert ntfy delivery (priceAlerts.*); topic and token stay server-side, never logged.
    priceAlertsNtfy: resolvePriceAlertsNtfyConfig(
      env.VERTEX_PRICE_ALERTS_NTFY_ORIGIN,
      env.VERTEX_PRICE_ALERTS_NTFY_TOPIC,
      env.VERTEX_PRICE_ALERTS_NTFY_TOKEN
    ),
    // Human IBKR 2FA recovery (ibkrRecovery.*); operator-only, never agent keys. Own token.
    ibkrRecovery: resolveDeployStatusConfig(
      env.VERTEX_IBKR_RECOVERY_URL,
      env.VERTEX_IBKR_RECOVERY_TOKEN
    ),
    // Academy rule overrides: Better Auth checks the signed-in user's own password (session-bound).
    verifyPassword: async (headers, password) =>
      await verifyOwnPassword(scope.auth.api, headers, password),
    // Owner order screen: off by default (mock gateway only). The auth secret signs confirm tokens.
    vertexOrders: {
      bridgeUrl: env.VERTEX_ORDER_BRIDGE_URL ?? null,
      bridgeToken: env.VERTEX_ORDER_BRIDGE_TOKEN ?? null,
      confirmSecret: `vertex-orders-confirm:${env.BETTER_AUTH_SECRET}`,
      enabled: env.VERTEX_ORDERS_ENABLED,
      submission: env.VERTEX_ORDER_SUBMISSION,
    },
  } satisfies Partial<ApiContextDependencies>;
};

const handleOrpcRuntimeRequestInner = async (
  request: Request,
  waitUntil: BackgroundTaskScheduler,
  internalParentRequestId?: string
): Promise<Response> => {
  const env = parseServerEnv(process.env);
  const method = request.method.toUpperCase();
  if (!SUPPORTED_ORPC_METHODS.includes(method))
    return methodNotAllowedResponse();
  if (unsafeRequestDenied(request, env.APP_URL))
    return forbiddenOriginResponse();

  // Cheap rejections and body bounding run before the scope opens a connection.
  const isContactSubmission =
    method === "POST" &&
    new URL(request.url).pathname === "/api/orpc/contact/submit";
  const maximumRequestBytes =
    vertexWorkerRequestMaxBytes(new URL(request.url).pathname) ??
    ORPC_REQUEST_MAX_BYTES;
  const boundedRequest = BODY_BEARING_ORPC_METHODS.includes(method)
    ? isContactSubmission
      ? await bufferContactRequest(request)
      : await bufferBoundedRequest(request, maximumRequestBytes)
    : { request, tooLarge: false };
  if (boundedRequest.tooLarge && !isContactSubmission)
    return payloadTooLargeResponse();
  const effectiveRequest = boundedRequest.request;

  return await withRequestScope(
    effectiveRequest,
    waitUntil,
    (scope) =>
      runWithRequestTelemetry(
        telemetryFor(env),
        {
          attributes: { "rpc.system": "orpc" },
          correlation: { requestId: scope.requestId, route: "/api/orpc" },
          name: "orpc.request",
        },
        waitUntil,
        async (span) => {
          let contact: ContactDependencies | undefined;
          if (isContactSubmission) {
            const admitted = await admitContactSubmission(
              scope,
              effectiveRequest,
              boundedRequest.tooLarge
            );
            if (admitted instanceof Response) return admitted;
            contact = admitted;
          }
          const context = createApiContext(effectiveRequest, {
            repositories: createRepositories(scope.db),
            ...vertexContextDependencies(scope, effectiveRequest, (internal) =>
              handleOrpcRuntimeRequest(internal, waitUntil, scope.requestId)
            ),
            capabilities: getProviderCapabilities(scope.env),
            requestId: scope.requestId,
            requireRole: (headers, role) =>
              requireRole(scope.auth, headers, role),
            requireSession: (headers) => requireSession(scope.auth, headers),
            // Tracked: drained before the request connection closes (backtest runs).
            scheduleDatabaseTask: scope.schedule,
            semanticEvents: createSemanticEventFanout({
              analytics: analyticsFor(scope.env),
              resolveConsent: () => resolveAnalyticsConsent(request),
              sink: scope.sink,
            }),
            span,
            // Not DB-bound, so it must not hold the connection open: use the raw waitUntil.
            waitUntil,
            ...contact,
          });
          return await handleOrpcRequest(effectiveRequest, context);
        }
      ),
    internalParentRequestId
  );
};

const PRIVATE_CHAT_PROCEDURES: readonly string[] = [
  "researchChat",
  "research-chat",
];

/**
 * Private chat material (including errors and bodyless reference history) must
 * not enter browser/CDN response caches. No response body is inspected,
 * buffered, logged or copied here; the concrete owner keeps content authorization.
 */
export const handleOrpcRuntimeRequest = async (
  request: Request,
  waitUntil: BackgroundTaskScheduler,
  internalParentRequestId?: string
): Promise<Response> => {
  const response = await handleOrpcRuntimeRequestInner(
    request,
    waitUntil,
    internalParentRequestId
  );
  const segments = new URL(request.url).pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/")
    .split("/");
  const privateChat =
    segments[1] === "api" &&
    segments[2] === "orpc" &&
    segments[3] === "vertex" &&
    PRIVATE_CHAT_PROCEDURES.includes(segments[4] ?? "");
  if (!privateChat) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Referrer-Policy", "no-referrer");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  const vary = headers.get("Vary");
  if (vary !== "*") {
    const names = new Map(
      (vary ?? "")
        .split(",")
        .map((name) => [name.trim().toLowerCase(), name.trim()] as const)
        .filter(([key]) => key.length > 0)
    );
    names.set("cookie", "Cookie");
    names.set("authorization", "Authorization");
    headers.set("Vary", [...names.values()].join(", "));
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const handleOrpc = (request: Request): Promise<Response> => {
  return handleOrpcRuntimeRequest(request, workerWaitUntil);
};

export const GET = handleOrpc;
export const POST = handleOrpc;
export const PATCH = handleOrpc;
export const DELETE = handleOrpc;
