import type {
  AgentApiKeyPrincipal,
  AgentApiKeyRecord,
  AgentApiKeyService,
  CreatedAgentApiKey,
  SafeAuthSession,
  UserRole,
} from "@darkfactory/auth/types";
import {
  AGENT_API_KEY_HEADER,
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
} from "@darkfactory/auth/types";
import type { Repositories } from "@darkfactory/db/server";
import type {
  SemanticEventPort,
  SpanHandle,
  WaitUntil,
} from "@darkfactory/observability/port";
import type { CapabilityProjection } from "../contract.ts";
import { DEFAULT_HOST_LABEL } from "../contracts/engine-comparison.ts";
import {
  type AssistantDependencies,
  type AssistantRuntime,
  createAssistantRuntime,
} from "./assistant-runtime.ts";
import type {
  ContactDeliveryPort,
  ContactThrottlePort,
} from "./contact-service.ts";
import type { JevConfig } from "./jev-client.ts";
import type { QuantDataConfig } from "./quantdata-client.ts";
import type {
  DeployStatusConfig,
  PriceAlertsNtfyConfig,
  VertexOrdersConfig,
} from "./service-config.ts";
import type { VertexChartReadDependencies } from "./vertex-chart-service.ts";
import type { VertexExperienceDependencies } from "./vertex-experience-core.ts";
import type { VertexLocalSetupService } from "./vertex-local-setup.ts";
import type { VertexNotificationReadService } from "./vertex-notification-read-service.ts";
import type { VertexResearchChatConversationService } from "./vertex-research-chat-conversation-runtime.ts";
import type { ResearchChatModelPrivacyOperations } from "./vertex-research-chat-model-privacy.ts";
import type { VertexReadDependencies } from "./vertex-service.ts";
import type { VertexWorkerRequestContext } from "./vertex-worker-auth.ts";
import type { VertexWorkerServiceDependencies } from "./vertex-worker-service.ts";

export type VertexModelPrivacyReviewer = Pick<
  ResearchChatModelPrivacyOperations,
  | "readModelPrivacyReviewRequest"
  | "recordModelPrivacyReview"
  | "readNativeModelPrivacyReviewRequest"
  | "recordNativeModelPrivacyReview"
>;

/** Engine of new backtest runs (VERTEX_BACKTEST_RUNS_ENGINE). */
export type BacktestRunsEngineSetting = "typescript" | "nautilus";

// Request-bound agent API key operations (see @darkfactory/auth createAgentApiKeyService).
export type ApiAgentApiKeys = Readonly<{
  authenticate: () => Promise<AgentApiKeyPrincipal>;
  list: () => Promise<AgentApiKeyRecord[]>;
  create: (
    input: Readonly<{ name: string; access?: "read" | "write" }>
  ) => Promise<CreatedAgentApiKey>;
  revoke: (id: string) => Promise<boolean>;
}>;

export type ApiContext = Readonly<{
  requestId: string;
  repositories: Repositories;
  capabilities: CapabilityProjection;
  requireSession: () => Promise<SafeAuthSession>;
  requireRole: (role: UserRole) => Promise<SafeAuthSession>;
  // True when the request carries the x-api-key header. Such requests may call
  // only agentOps.*, papers.*, strategyLibrary.*, marketData.*, backtestRuns.*, todos.* and
  // agentModelRuns.* (enforced by
  // the handler interceptor) and are authenticated by the key alone; any session
  // cookie is ignored for them.
  agentApiKeyPresented?: boolean;
  agentApiKeys?: ApiAgentApiKeys;
  // Set by requireOperator: true for an operator session or a write-access agent key, false for a
  // read-access key or a read-only agent viewer. Read procedures with a side effect (the engine
  // comparison queue of backtestRuns.sweep) run it only when this is true.
  callerCanWrite?: boolean;
  // Set by requireOperator: true for a read-only agent viewer session. Academy backtests (owner
  // decision 2026-11-10) let a viewer queue their Nautilus comparison run; nothing else does.
  callerIsAgentViewer?: boolean;
  // Lower-cased operator allow-list (VERTEX_OPERATOR_EMAILS). Absent/empty => no
  // operators; agentOps.*, papers.* and agentApiKeys.* then deny everyone.
  operatorEmails?: readonly string[];
  // Lower-cased read-only agent viewer list (VERTEX_AGENT_VIEWER_EMAILS). These sessions pass the
  // operator gate but may call only read procedures (agent-viewer.ts).
  agentViewerEmails?: readonly string[];
  // Read-only QuantVPS status endpoint (VERTEX_DEPLOY_STATUS_URL/TOKEN). Server-only; null => not configured.
  deployStatus?: DeployStatusConfig | null;
  // Tailnet-only v2 snapshot (VERTEX_DEPLOY_STATUS_V2_URL, same token). Server-only; null => v1 only.
  deployStatusV2?: DeployStatusConfig | null;
  // Tailnet-only IBKR history service (VERTEX_HISTORY_URL, same token). Server-only; null => not configured.
  marketHistory?: DeployStatusConfig | null;
  // QuantData options analytics (QUANTDATA_API_BASE_URL/KEY). Server-only; null => not configured.
  quantData?: QuantDataConfig | null;
  // JEV decisions model over OpenRouter (OPENROUTER_API_KEY). Server-only; null => not configured.
  jev?: JevConfig | null;
  // Tailnet-only research lens documents (VERTEX_RESEARCH_LENSES_URL, same token). Server-only; null => not configured.
  researchLenses?: DeployStatusConfig | null;
  // Price alert ntfy destination (VERTEX_PRICE_ALERTS_NTFY_*). Server-only, never logged; null => not configured.
  priceAlertsNtfy?: PriceAlertsNtfyConfig | null;
  // Tailnet-only IBKR portfolio service (VERTEX_PORTFOLIO_URL, same token). Server-only; null => not configured.
  portfolioMonitor?: DeployStatusConfig | null;
  // Read-only vertex_semantic_reader login (SEMANTIC_DATABASE_URL). Server-only; null => not configured.
  semanticDatabaseUrl?: string | null;
  // ibkr-monitor base URL on loopback (IBKR_MONITOR_URL, e.g. http://127.0.0.1:3461). null => not configured.
  ibkrMonitor?: string | null;
  // Rig status file server on loopback (ENGINE_STATUS_URL, e.g. http://127.0.0.1:3462): status.json for
  // engines.status, markets.json for marketContext.get. null => not configured.
  engineStatus?: string | null;
  // Engine of new backtest runs (VERTEX_BACKTEST_RUNS_ENGINE). "nautilus" queues them for the
  // Nautilus research worker; "typescript" (the default) runs them in this server.
  backtestRunsEngine?: BacktestRunsEngineSetting;
  // Engine comparison (VERTEX_ENGINE_COMPARISON): "on" also queues instant backtests, sweep cells
  // and Autopilot gate runs on Nautilus. "off" (the default) changes nothing.
  engineComparison?: "off" | "on";
  // Where this server runs (VERTEX_HOST_LABEL), shown next to TypeScript engine times.
  hostLabel?: string;
  // Tailnet-only human 2FA recovery service (VERTEX_IBKR_RECOVERY_URL, own token
  // VERTEX_IBKR_RECOVERY_TOKEN). Server-only; null => not configured.
  ibkrRecovery?: DeployStatusConfig | null;
  // Step-up check of the signed-in user's own password (Better Auth verify-password with this request's
  // session). Absent => no step-up available, so password-gated actions are refused.
  verifyPassword?: (password: string) => Promise<boolean>;
  // Owner order screen (VERTEX_ORDERS_ENABLED, VERTEX_ORDER_BRIDGE_URL). Absent => disabled, mock only.
  vertexOrders?: VertexOrdersConfig;
  // Research assistant (OpenRouter client + session-bound tool caller). Server-only; absent => not wired.
  assistant?: AssistantRuntime;
  semanticEvents?: SemanticEventPort;
  span?: SpanHandle;
  waitUntil?: WaitUntil;
  // Tracked background scheduler for database work: the request connection stays open until the
  // task settles. Absent => callers run the work before responding.
  scheduleDatabaseTask?: WaitUntil;
  contactDelivery?: ContactDeliveryPort;
  contactThrottle?: ContactThrottlePort;
  contactThrottleKey?: string;
  vertexRead?: VertexReadDependencies;
  vertexExperience?: VertexExperienceDependencies;
  vertexResearchChatConversation?: VertexResearchChatConversationService;
  vertexModelPrivacyReviewer?: VertexModelPrivacyReviewer;
  vertexChartRead?: VertexChartReadDependencies;
  vertexWorker?: VertexWorkerServiceDependencies;
  vertexNotificationRead?: VertexNotificationReadService;
  vertexLocalSetup?: VertexLocalSetupService;
  workerRequest?: VertexWorkerRequestContext;
  signal?: AbortSignal;
}>;

export type ApiRequestIdOptions = Readonly<{
  requestId?: string;
  generateRequestId?: () => string;
}>;

export type ApiContextDependencies = Readonly<{
  repositories: Repositories;
  capabilities: CapabilityProjection;
  requireSession: (headers: Headers) => Promise<SafeAuthSession>;
  requireRole: (headers: Headers, role: UserRole) => Promise<SafeAuthSession>;
  agentApiKeys?: AgentApiKeyService;
  operatorEmails?: readonly string[];
  agentViewerEmails?: readonly string[];
  deployStatus?: DeployStatusConfig | null;
  deployStatusV2?: DeployStatusConfig | null;
  marketHistory?: DeployStatusConfig | null;
  quantData?: QuantDataConfig | null;
  jev?: JevConfig | null;
  researchLenses?: DeployStatusConfig | null;
  priceAlertsNtfy?: PriceAlertsNtfyConfig | null;
  portfolioMonitor?: DeployStatusConfig | null;
  semanticDatabaseUrl?: string | null;
  // ibkr-monitor base URL on loopback (IBKR_MONITOR_URL, e.g. http://127.0.0.1:3461). null => not configured.
  ibkrMonitor?: string | null;
  // Rig status file server on loopback (ENGINE_STATUS_URL, e.g. http://127.0.0.1:3462): status.json for
  // engines.status, markets.json for marketContext.get. null => not configured.
  engineStatus?: string | null;
  backtestRunsEngine?: BacktestRunsEngineSetting;
  engineComparison?: "off" | "on";
  hostLabel?: string;
  // Tailnet-only human 2FA recovery service (VERTEX_IBKR_RECOVERY_URL, own token
  // VERTEX_IBKR_RECOVERY_TOKEN). Server-only; null => not configured.
  ibkrRecovery?: DeployStatusConfig | null;
  // Step-up password check bound to the request headers (session); see ApiContext.verifyPassword.
  verifyPassword?: (headers: Headers, password: string) => Promise<boolean>;
  // Owner order screen (VERTEX_ORDERS_ENABLED, VERTEX_ORDER_BRIDGE_URL). Absent => disabled, mock only.
  vertexOrders?: VertexOrdersConfig;
  assistant?: AssistantDependencies;
  requestId?: string;
  generateRequestId?: () => string;
  semanticEvents?: SemanticEventPort;
  span?: SpanHandle;
  waitUntil?: WaitUntil;
  scheduleDatabaseTask?: WaitUntil;
  contactDelivery?: ContactDeliveryPort;
  contactThrottle?: ContactThrottlePort;
  contactThrottleKey?: string;
  vertexRead?: VertexReadDependencies;
  vertexExperience?: VertexExperienceDependencies;
  vertexResearchChatConversation?: VertexResearchChatConversationService;
  vertexModelPrivacyReviewer?: VertexModelPrivacyReviewer;
  // Explicit chart binding must retain the dedicated 1MiB content allocation cap.
  vertexChartRead?: VertexChartReadDependencies;
  vertexWorker?: VertexWorkerServiceDependencies;
  // Concrete request-bound service hides the private branded authority context.
  vertexNotificationRead?: VertexNotificationReadService;
  vertexLocalSetup?: VertexLocalSetupService;
}>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Cloudflare ray ids: 16 lowercase hex digits, optionally suffixed with the colo code.
const CF_RAY_PATTERN = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/;

/**
 * Correlation id for one request, shared by evlog, the OTel span and audit rows.
 * Order: an injected id (in-process dispatch passes its parent's, see
 * apps/web/src/lib/server-internal-dispatch.ts), then a pattern-checked
 * edge-set `cf-ray`, then a fresh UUID. A public `x-request-id` is never
 * read: it would let a client choose its own `audit_records.request_id`.
 */
export const resolveApiRequestId = (
  request: Readonly<{ headers: Pick<Headers, "get"> }>,
  options: ApiRequestIdOptions = {}
): string => {
  if (options.requestId !== undefined) {
    if (!REQUEST_ID_PATTERN.test(options.requestId)) {
      throw new TypeError(
        "requestId must be 1-128 safe correlation characters"
      );
    }
    return options.requestId;
  }

  const ray = request.headers.get("cf-ray");
  if (ray !== null && CF_RAY_PATTERN.test(ray)) return ray;

  const generated = options.generateRequestId?.() ?? crypto.randomUUID();
  if (!REQUEST_ID_PATTERN.test(generated)) {
    throw new TypeError(
      "generated requestId must be 1-128 safe correlation characters"
    );
  }
  return generated;
};

export const createApiContext = (
  request: Request,
  dependencies: ApiContextDependencies
): ApiContext => {
  const agentApiKeys = dependencies.agentApiKeys;
  const verifyPassword = dependencies.verifyPassword;
  return {
    agentApiKeyPresented: request.headers.has(AGENT_API_KEY_HEADER),
    agentViewerEmails: Object.freeze(
      (dependencies.agentViewerEmails ?? []).map((email) =>
        email.trim().toLowerCase()
      )
    ),
    backtestRunsEngine: dependencies.backtestRunsEngine ?? "typescript",
    deployStatus: dependencies.deployStatus ?? null,
    deployStatusV2: dependencies.deployStatusV2 ?? null,
    engineComparison: dependencies.engineComparison ?? "off",
    engineStatus: dependencies.engineStatus ?? null,
    hostLabel: dependencies.hostLabel ?? DEFAULT_HOST_LABEL,
    ibkrMonitor: dependencies.ibkrMonitor ?? null,
    ibkrRecovery: dependencies.ibkrRecovery ?? null,
    jev: dependencies.jev ?? null,
    marketHistory: dependencies.marketHistory ?? null,
    operatorEmails: Object.freeze(
      (dependencies.operatorEmails ?? []).map((email) =>
        email.trim().toLowerCase()
      )
    ),
    portfolioMonitor: dependencies.portfolioMonitor ?? null,
    priceAlertsNtfy: dependencies.priceAlertsNtfy ?? null,
    quantData: dependencies.quantData ?? null,
    requestId: resolveApiRequestId(request, dependencies),
    researchLenses: dependencies.researchLenses ?? null,
    semanticDatabaseUrl: dependencies.semanticDatabaseUrl ?? null,
    signal: request.signal,
    // Server-only request provenance. Never accept worker credentials/context from
    // RPC input or substitute the browser session principal for bearer authority.
    workerRequest: {
      headers: new Headers(request.headers),
      signal: request.signal,
    },
    ...(verifyPassword === undefined
      ? {}
      : {
          verifyPassword: (password: string) =>
            verifyPassword(request.headers, password),
        }),
    ...(dependencies.assistant === undefined
      ? {}
      : { assistant: createAssistantRuntime(request, dependencies.assistant) }),
    ...(agentApiKeys === undefined
      ? {}
      : {
          agentApiKeys: Object.freeze({
            authenticate: () => agentApiKeys.authenticate(request.headers),
            create: (
              input: Readonly<{ name: string; access?: "read" | "write" }>
            ) => agentApiKeys.create(request.headers, input),
            list: () => agentApiKeys.list(request.headers),
            revoke: (id: string) => agentApiKeys.revoke(request.headers, id),
          }),
        }),
    capabilities: dependencies.capabilities,
    repositories: dependencies.repositories,
    // A read-only agent viewer never passes a role check (no admin or owner access), even if its
    // account has the admin role in the database.
    requireRole: async (role) => {
      const session = await dependencies.requireRole(request.headers, role);
      const viewers = (dependencies.agentViewerEmails ?? []).map((email) =>
        email.trim().toLowerCase()
      );
      if (viewers.includes(session.user.email.trim().toLowerCase()))
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.FORBIDDEN,
          403
        );
      return session;
    },
    requireSession: () => dependencies.requireSession(request.headers),
    ...(dependencies.vertexOrders === undefined
      ? {}
      : { vertexOrders: dependencies.vertexOrders }),
    ...(dependencies.semanticEvents === undefined
      ? {}
      : { semanticEvents: dependencies.semanticEvents }),
    ...(dependencies.span === undefined ? {} : { span: dependencies.span }),
    ...(dependencies.waitUntil === undefined
      ? {}
      : { waitUntil: dependencies.waitUntil }),
    ...(dependencies.scheduleDatabaseTask === undefined
      ? {}
      : { scheduleDatabaseTask: dependencies.scheduleDatabaseTask }),
    ...(dependencies.contactDelivery === undefined
      ? {}
      : { contactDelivery: dependencies.contactDelivery }),
    ...(dependencies.contactThrottle === undefined
      ? {}
      : { contactThrottle: dependencies.contactThrottle }),
    ...(dependencies.contactThrottleKey === undefined
      ? {}
      : { contactThrottleKey: dependencies.contactThrottleKey }),
    ...(dependencies.vertexRead === undefined
      ? {}
      : { vertexRead: dependencies.vertexRead }),
    ...(dependencies.vertexExperience === undefined
      ? {}
      : {
          vertexExperience: {
            ...dependencies.vertexExperience,
            signal: request.signal,
          },
        }),
    ...(dependencies.vertexResearchChatConversation === undefined
      ? {}
      : {
          vertexResearchChatConversation:
            dependencies.vertexResearchChatConversation,
        }),
    ...(dependencies.vertexModelPrivacyReviewer === undefined
      ? {}
      : {
          vertexModelPrivacyReviewer: dependencies.vertexModelPrivacyReviewer,
        }),
    ...(dependencies.vertexChartRead === undefined
      ? {}
      : {
          vertexChartRead: {
            ...dependencies.vertexChartRead,
            signal: request.signal,
          },
        }),
    ...(dependencies.vertexWorker === undefined
      ? {}
      : { vertexWorker: dependencies.vertexWorker }),
    ...(dependencies.vertexNotificationRead === undefined
      ? {}
      : { vertexNotificationRead: dependencies.vertexNotificationRead }),
    ...(dependencies.vertexLocalSetup === undefined
      ? {}
      : { vertexLocalSetup: dependencies.vertexLocalSetup }),
  };
};
