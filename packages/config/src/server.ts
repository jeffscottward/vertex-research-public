// What: Fail-closed server env schema; parseServerEnv throws EnvironmentValidationError listing each bad key.
// Used by: apps/web/src/server/request-scope.ts, apps/web/src/app/api/orpc/[...rest]/route.ts, apps/operator/src/server/operator-auth.ts.
// See: docs/debugging.md#symptom--where-to-look; packages/config/src/database.ts.
import { AI_ADAPTERS } from "@darkfactory/ai/adapters";
import { ANALYTICS_ADAPTERS } from "@darkfactory/analytics/adapters";
import { EMAIL_ADAPTERS } from "@darkfactory/email/adapters";
import { z } from "zod";
import { PENDING_RUNTIME_STATES } from "./capabilities.ts";
import {
  CANONICAL_APP_URL,
  isDevelopmentLocalhostHttpOrigin,
} from "./client.ts";
import {
  DATABASE_PROVIDERS,
  isLocalHostname,
  parseDatabaseAllowedHosts,
  RequestDatabaseEndpointError,
  validateRequestDatabaseEndpoint,
} from "./database.ts";

const emptyStringToUndefined = (value: unknown): unknown => {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
};

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional()
);

const MAILBOX_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const optionalContactRecipient = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .refine(
      (value) => value.length <= 254 && MAILBOX_PATTERN.test(value),
      "CONTACT_EMAIL_TO must be a valid email address of at most 254 characters"
    )
    .optional()
);

const isHeaderSafeEmailFrom = (value: string): boolean => {
  if (value.length > 400 || /[\r\n]/.test(value)) return false;
  if (MAILBOX_PATTERN.test(value)) return true;
  if (!/^[^<>]+<[^<>]+>$/.test(value)) return false;
  const mailboxStart = value.indexOf("<");
  const displayName = value.slice(0, mailboxStart).trim();
  const mailbox = value.slice(mailboxStart + 1, -1).trim();
  return (
    displayName.length > 0 &&
    displayName.length <= 100 &&
    MAILBOX_PATTERN.test(mailbox)
  );
};

const emailFromSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    isHeaderSafeEmailFrom,
    "EMAIL_FROM must be a header-safe mailbox or display mailbox"
  );

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const optionalUrl = (name: string) => {
  return z.preprocess(
    emptyStringToUndefined,
    z.url({ error: `${name} must be a valid URL` }).optional()
  );
};

// Operator allow-list for the agent ledger (agentOps.*, papers.*, agentApiKeys.*).
// Comma-separated, case-insensitive. Absent or empty => no operators (fail closed).
const OPERATOR_EMAILS_MAX = 50;
export const parseOperatorEmails = (
  value: string | undefined
): readonly string[] | null => {
  if (value === undefined) return Object.freeze([]);
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length > OPERATOR_EMAILS_MAX) return null;
  for (const entry of entries) {
    if (entry.length > 254 || !MAILBOX_PATTERN.test(entry)) return null;
  }
  return Object.freeze([...new Set(entries)]);
};

export type OperatorIdentity = Readonly<{
  email: string;
  emailVerified: boolean;
  status: string;
}>;

// The one operator rule, shared by the API gate (requireOperator in
// packages/api) and the portal session (sidebar and landing tab): an active,
// email-verified user whose email is on the list. Empty list => nobody.
export const isOperatorIdentity = (
  identity: OperatorIdentity,
  operatorEmails: readonly string[] | undefined
): boolean => {
  if (identity.status !== "active" || identity.emailVerified !== true)
    return false;
  if (operatorEmails === undefined || operatorEmails.length === 0) return false;
  const email = identity.email.trim().toLowerCase();
  return (
    email.length > 0 &&
    operatorEmails.some((entry) => entry.trim().toLowerCase() === email)
  );
};

const emailListSchema = (name: string) =>
  z
    .string()
    .optional()
    .transform((value, context): readonly string[] => {
      const parsed = parseOperatorEmails(value);
      if (parsed === null) {
        context.addIssue({
          code: "custom",
          message: `${name} must be at most ${OPERATOR_EMAILS_MAX} comma-separated email addresses`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const operatorEmailsSchema = emailListSchema("VERTEX_OPERATOR_EMAILS");

const hasNoUrlSecrets = (value: string): boolean => {
  if (/[?#]/.test(value)) return false;
  const url = parseUrl(value);
  return url?.username === "" && url.password === "";
};

// Tailnet-only HTTPS service URLs: no credentials, query or fragment. The shared
// VERTEX_DEPLOY_STATUS_TOKEN authenticates all of them and is never returned to clients.
const tailnetServiceUrl = (name: string) =>
  z.preprocess(
    emptyStringToUndefined,
    z
      .url({ error: `${name} must be a valid URL` })
      .refine((value) => value.startsWith("https://"), {
        message: `${name} must use HTTPS`,
      })
      .refine(hasNoUrlSecrets, {
        message: `${name} must not carry credentials, a query or a fragment`,
      })
      .optional()
  );

const academyMediaBaseUrlSchema = tailnetServiceUrl(
  "VERTEX_ACADEMY_MEDIA_BASE_URL"
);

/**
 * The Academy media base URL alone, validated like the full server env (HTTPS, no credentials, query
 * or fragment). Null when unset or invalid, so a bad value hides the hosted media instead of
 * breaking every Academy page.
 */
export const parseAcademyMediaBaseUrl = (
  source: Readonly<Record<string, string | undefined>>
): string | null => {
  const result = academyMediaBaseUrlSchema.safeParse(
    source["VERTEX_ACADEMY_MEDIA_BASE_URL"]
  );
  return result.success ? (result.data ?? null) : null;
};

const kbChatUrlSchema = tailnetServiceUrl("VERTEX_KB_CHAT_URL");

/**
 * The kb-chat front end URL for the Knowledge page iframe (audit phase 4, kb-chat embed option a).
 * kb-chat stays on the rig and its tailnet gateway; Vertex only frames it. Null when unset or
 * invalid, so the page shows its fallback text instead of a broken frame.
 */
export const parseKbChatUrl = (
  source: Readonly<Record<string, string | undefined>>
): string | null => {
  const result = kbChatUrlSchema.safeParse(source["VERTEX_KB_CHAT_URL"]);
  return result.success ? (result.data ?? null) : null;
};

// ibkr-monitor base URL on the Vertex host's loopback (ibkrMonitor.snapshot, Portfolio tab), e.g.
// http://127.0.0.1:3461. Plain http is allowed only because the host must be loopback.
const IBKR_MONITOR_LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const loopbackHttpUrl = (name: string) =>
  z.preprocess(
    emptyStringToUndefined,
    z
      .url({ error: `${name} must be a valid URL` })
      .refine(
        (value) => {
          // Zod runs this refine even when z.url() rejected the value.
          const url = parseUrl(value);
          return (
            url !== undefined &&
            url.protocol === "http:" &&
            IBKR_MONITOR_LOOPBACK_HOSTS.includes(url.hostname)
          );
        },
        {
          message: `${name} must be an http URL on 127.0.0.1, localhost or [::1]`,
        }
      )
      .refine(hasNoUrlSecrets, {
        message: `${name} must not carry credentials, a query or a fragment`,
      })
      .optional()
  );
const ibkrMonitorUrlSchema = loopbackHttpUrl("IBKR_MONITOR_URL");
// Rig status file server on the Vertex host's loopback (engines.status, marketContext.get), e.g. http://127.0.0.1:3462.
const engineStatusUrlSchema = loopbackHttpUrl("ENGINE_STATUS_URL");

// Tailnet HTTPS or loopback http, for services that may run on the web app's own host
// (QuantVPS history and portfolio: the tailnet route admits only the rig).
const tailnetOrLoopbackServiceUrl = (name: string) =>
  z.preprocess(
    emptyStringToUndefined,
    z
      .url({ error: `${name} must be a valid URL` })
      .refine(
        (value) => {
          const url = parseUrl(value);
          return (
            url !== undefined &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                IBKR_MONITOR_LOOPBACK_HOSTS.includes(url.hostname)))
          );
        },
        {
          message: `${name} must use HTTPS, or http on 127.0.0.1, localhost or [::1]`,
        }
      )
      .refine(hasNoUrlSecrets, {
        message: `${name} must not carry credentials, a query or a fragment`,
      })
      .optional()
  );

const PRINTABLE_ASCII_TOKEN = /^[\x21-\x7e]+$/;

// Read-only QuantVPS deployment status endpoint (agentOps.deployment.status). Both optional;
// the monitor reports "not configured" unless URL and token are both set.
export const DEPLOY_STATUS_TOKEN_MIN = 32;
const serviceTokenSchema = (name: string) =>
  z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .trim()
      .min(DEPLOY_STATUS_TOKEN_MIN, {
        message: `${name} must be at least ${DEPLOY_STATUS_TOKEN_MIN} characters`,
      })
      .max(512, { message: `${name} must be at most 512 characters` })
      .refine((value) => PRINTABLE_ASCII_TOKEN.test(value), {
        message: `${name} must be printable ASCII without spaces`,
      })
      .optional()
  );

// Price alert ntfy delivery (priceAlerts.*). Origin and topic both set => configured; the token is
// optional. Server-only: the topic and token are never returned to clients or logged.
const priceAlertsNtfyOrigin = z.preprocess(
  emptyStringToUndefined,
  z
    .url({ error: "VERTEX_PRICE_ALERTS_NTFY_ORIGIN must be a valid URL" })
    .refine((value) => parseUrl(value)?.origin === value, {
      message:
        "VERTEX_PRICE_ALERTS_NTFY_ORIGIN must be a bare https origin without a path or trailing slash",
    })
    .refine((value) => value.startsWith("https://"), {
      message: "VERTEX_PRICE_ALERTS_NTFY_ORIGIN must use HTTPS",
    })
    .optional()
);
const priceAlertsNtfyTopic = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/u, {
      message:
        "VERTEX_PRICE_ALERTS_NTFY_TOPIC must be 1-128 letters, digits, _ or -",
    })
    .optional()
);
const priceAlertsNtfyToken = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._~-]{1,2048}$/u, {
      message:
        "VERTEX_PRICE_ALERTS_NTFY_TOKEN must be 1-2048 token characters (A-Z a-z 0-9 . _ ~ -)",
    })
    .optional()
);

// OpenRouter key for the operator research assistant (server-only; never sent to the browser or logged).
const openRouterApiKeySchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .min(20, { message: "OPENROUTER_API_KEY must be at least 20 characters" })
    .max(512, { message: "OPENROUTER_API_KEY must be at most 512 characters" })
    .refine((value) => PRINTABLE_ASCII_TOKEN.test(value), {
      message: "OPENROUTER_API_KEY must be printable ASCII without spaces",
    })
    .optional()
);

// OpenRouter model id for the assistant (tool-capable), e.g. anthropic/claude-sonnet-4.5.
export const DEFAULT_VERTEX_ASSISTANT_MODEL = "anthropic/claude-sonnet-4.5";
const assistantModelSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .max(100, {
      message: "VERTEX_ASSISTANT_MODEL must be at most 100 characters",
    })
    .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/, {
      message:
        "VERTEX_ASSISTANT_MODEL must be an OpenRouter model id such as anthropic/claude-sonnet-4.5",
    })
    .default(DEFAULT_VERTEX_ASSISTANT_MODEL)
);

// App origin: HTTPS, or plain HTTP only for a portless *.localhost name. The field
// refine cannot see APP_ENV, so it checks the shape with the shared rule; the
// superRefine below rejects that form unless APP_ENV=development.
export const isLocalhostNameHttpOrigin = (value: string): boolean =>
  isDevelopmentLocalhostHttpOrigin(value, "development");
const appOriginUrl = (name: string) => {
  return z
    .url({ error: `${name} must be a valid URL` })
    .refine(
      (value) =>
        value.startsWith("https://") || isLocalhostNameHttpOrigin(value),
      { message: `${name} must use HTTPS` }
    )
    .refine((value) => !value.endsWith("/"), {
      message: `${name} must not have a trailing slash`,
    })
    .refine((value) => parseUrl(value)?.origin === value, {
      message: `${name} must be a clean HTTPS origin`,
    });
};
const environmentBoolean = (name: string, defaultValue: boolean) => {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;

      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
      return value;
    },
    z.boolean({ error: `${name} must be true or false` }).default(defaultValue)
  );
};

const isPostgresUrl = (value: string): boolean => {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
    url.hostname.length > 0
  );
};

// Optional here because Hyperdrive supplies the connection; serverEnvSchema requires it for URL providers.
const databaseUrlSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string({ error: "DATABASE_URL must be a PostgreSQL URL" })
    .trim()
    .refine(isPostgresUrl, "DATABASE_URL must be a PostgreSQL URL")
    .optional()
);

const databaseAllowedHostsSchema = z
  .string()
  .default("")
  .transform((value, context): readonly string[] => {
    try {
      return parseDatabaseAllowedHosts(value);
    } catch (error) {
      if (!(error instanceof RequestDatabaseEndpointError)) throw error;
      context.addIssue({ code: "custom", message: error.diagnostic });
      return z.NEVER;
    }
  });

const secretSchema = (name: string) => {
  return z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .min(32, `${name} must contain at least 32 characters`);
};

// Public local-only defaults are never suitable production signing/HMAC keys.
// Apply the same denylist to both fields so swapping their defaults cannot bypass it.
const DEVELOPMENT_SECRETS: Readonly<Record<string, true>> = {
  "vertex-local-development-only-contact-throttle-secret": true,
  "vertex-local-development-only-not-a-production-secret": true,
};

// A development build that serves a non-local origin (the QuantVPS
// self-hosted app) is deployed too, so it must not use the public template
// secrets. Returns the diagnostic scope, or undefined for local runtimes.
const deployedSecretScope = (
  appEnv: string,
  appUrl: string
): string | undefined => {
  if (appEnv === "production") return "in production";
  const host = parseUrl(appUrl)?.hostname;
  return host !== undefined && !isLocalHostname(host)
    ? "on a non-local APP_URL"
    : undefined;
};

// Configuration cannot claim operational readiness or authorize a live order.
const pendingRuntimeState = z.enum(PENDING_RUNTIME_STATES).default("disabled");

const STORAGE_REQUIRED_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

const DEVELOPMENT_CAPTURE_APP_HOSTS: Readonly<Record<string, true>> = {
  "[::1]": true,
  "127.0.0.1": true,
  localhost: true,
};

const baseServerEnvSchema = z.object({
  AGNO_API_TOKEN: optionalString,
  AGNO_API_URL: optionalUrl("AGNO_API_URL"),
  AGNO_RUNTIME_STATE: pendingRuntimeState,

  AI_PROVIDER: z.enum(AI_ADAPTERS).default("groq"),

  ANALYTICS_PROVIDER: z.enum(ANALYTICS_ADAPTERS).default("posthog"),
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().trim().min(1).default("Vertex Research"),
  APP_URL: appOriginUrl("APP_URL").default(CANONICAL_APP_URL),

  BETTER_AUTH_SECRET: secretSchema("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: appOriginUrl("BETTER_AUTH_URL").default(CANONICAL_APP_URL),
  CHART_RENDERER: z
    .literal("tanstack-charts-alpha")
    .default("tanstack-charts-alpha"),
  CHART_RUNTIME_STATE: pendingRuntimeState,
  CONTACT_EMAIL_TO: optionalContactRecipient,
  CONTACT_THROTTLE_SECRET: secretSchema("CONTACT_THROTTLE_SECRET"),
  CROWN_CORPUS_PATH: optionalString,
  DATABASE_ALLOWED_HOSTS: databaseAllowedHostsSchema,

  DATABASE_PROVIDER: z.enum(DATABASE_PROVIDERS).default("postgres"),
  DATABASE_URL: databaseUrlSchema,
  DEFINE_YOUR_RISK_CORPUS_PATH: optionalString,
  DELTATREND_CORPUS_PATH: optionalString,
  DEV_EMAIL_PREVIEW_ENDPOINT: optionalString,
  DEV_EMAIL_PREVIEW_KEY: optionalString,
  EMAIL_FROM: emailFromSchema.default("Vertex Research <noreply@domain.test>"),

  EMAIL_PROVIDER: z.enum([...EMAIL_ADAPTERS, "disabled"]).default("resend"),
  EMAIL_TRANSPORT: z
    .enum(["preview", ...EMAIL_ADAPTERS, "disabled"])
    .default("preview"),
  ENGINE_STATUS_URL: engineStatusUrlSchema,
  FINANCIAL_DATASETS_API_BASE_URL: optionalUrl(
    "FINANCIAL_DATASETS_API_BASE_URL"
  ),
  FINANCIAL_DATASETS_API_KEY: optionalString,
  GAMMA_RESEARCH_API_TOKEN: optionalString,
  GAMMA_RESEARCH_API_URL: optionalUrl("GAMMA_RESEARCH_API_URL"),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: optionalString,
  IBKR_ACCOUNT_ID: optionalString,
  IBKR_CLIENT_ID: optionalString,
  IBKR_HOST: optionalString,
  IBKR_MONITOR_URL: ibkrMonitorUrlSchema,
  IBKR_PORT: optionalString,
  IBKR_READ_ONLY: z.literal("true").default("true"),
  IBKR_RECOVERY_POLICY: z
    .literal("human-trigger-only")
    .default("human-trigger-only"),
  IBKR_RUNTIME_STATE: pendingRuntimeState,
  IBKR_TRADING_MODE: z.literal("paper").default("paper"),
  JEV_ALLOWED_ORIGINS: optionalString,
  JEV_API_TOKEN: optionalString,
  JEV_API_URL: optionalUrl("JEV_API_URL"),
  JEV_RUNTIME_STATE: pendingRuntimeState,
  MARKET_DATA_RUNTIME_STATE: pendingRuntimeState,
  NAUTILUS_RUNTIME_STATE: pendingRuntimeState,
  NAUTILUS_TRADING_MODE: z.literal("paper").default("paper"),
  NOTIFICATION_EMAIL_TO: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().max(254).pipe(z.email()).optional()
  ),
  NOTIFICATION_PROVIDER: z
    .enum(["disabled", "ntfy", "email"])
    .default("disabled"),
  NOTIFICATION_RUNTIME_STATE: pendingRuntimeState,
  NTFY_ACCESS_TOKEN: optionalString,
  NTFY_SERVER_URL: optionalUrl("NTFY_SERVER_URL"),
  NTFY_TOPIC: optionalString,
  OPENROUTER_API_KEY: openRouterApiKeySchema,

  OTEL_ENABLED: environmentBoolean("OTEL_ENABLED", true),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl("OTEL_EXPORTER_OTLP_ENDPOINT"),
  OTEL_SERVICE_NAME: z.string().trim().min(1).default("darkfactory-web"),
  POSTHOG_HOST: optionalUrl("POSTHOG_HOST"),
  POSTHOG_KEY: optionalString,
  QUANT_RUNTIME_STATE: pendingRuntimeState,
  QUANT_VPS_API_TOKEN: optionalString,
  QUANT_VPS_API_URL: optionalUrl("QUANT_VPS_API_URL"),
  QUANTDATA_API_BASE_URL: optionalUrl("QUANTDATA_API_BASE_URL"),
  QUANTDATA_API_KEY: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_ACCOUNT_ID: optionalString,
  R2_BUCKET: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  RESEARCH_CORPUS_ROOT: optionalString,
  RESEARCH_RUNTIME_STATE: pendingRuntimeState,
  RESEND_API_KEY: optionalString,
  RUST_KERNEL_API_TOKEN: optionalString,
  RUST_KERNEL_API_URL: optionalUrl("RUST_KERNEL_API_URL"),
  RUST_KERNEL_RUNTIME_STATE: pendingRuntimeState,
  SSRN_CORPUS_PATH: optionalString,

  // Vertex restores @darkfactory/storage (R2); disabled unless every R2 key is set.
  STORAGE_ENABLED: environmentBoolean("STORAGE_ENABLED", false),
  STORAGE_PROVIDER: z.enum(["r2"]).default("r2"),
  VERRILLO_CORPUS_PATH: optionalString,
  // Tailnet-only media URL base for Academy video, caption and thumbnail files.
  VERTEX_ACADEMY_MEDIA_BASE_URL: academyMediaBaseUrlSchema,
  VERTEX_ACCESS_MODE: z.literal("read-only").default("read-only"),
  // Read-only agent viewers (owner decision 2026-11-04): see operator pages, call read procedures
  // only. Must not overlap VERTEX_OPERATOR_EMAILS.
  VERTEX_AGENT_VIEWER_EMAILS: emailListSchema("VERTEX_AGENT_VIEWER_EMAILS"),
  VERTEX_ASSISTANT_MODEL: assistantModelSchema,
  // Engine of new backtest runs (backtestRuns.submit). "typescript" runs them in the API server;
  // "nautilus" queues them for the Nautilus research worker on the rig. Stored runs keep their own
  // engine. Blank means the default.
  VERTEX_BACKTEST_RUNS_ENGINE: z.preprocess(
    emptyStringToUndefined,
    z.enum(["typescript", "nautilus"]).default("typescript")
  ),
  VERTEX_DEPLOY_STATUS_TOKEN: serviceTokenSchema("VERTEX_DEPLOY_STATUS_TOKEN"),
  VERTEX_DEPLOY_STATUS_URL: tailnetServiceUrl("VERTEX_DEPLOY_STATUS_URL"),
  // Tailnet-only v2 session snapshot (same token and URL rules).
  VERTEX_DEPLOY_STATUS_V2_URL: tailnetServiceUrl("VERTEX_DEPLOY_STATUS_V2_URL"),
  // Tailnet-only read-only IBKR history service base URL (marketData.bars).
  VERTEX_HISTORY_URL: tailnetOrLoopbackServiceUrl("VERTEX_HISTORY_URL"),
  VERTEX_IBKR_RECOVERY_TOKEN: serviceTokenSchema("VERTEX_IBKR_RECOVERY_TOKEN"),
  // Tailnet-only human IBKR 2FA recovery service (ibkrRecovery.*), e.g.
  // https://<vps>.ts.net:8443/vertex-ibkr-recovery/v1. It has its OWN token (VERTEX_IBKR_RECOVERY_TOKEN),
  // because VERTEX_DEPLOY_STATUS_TOKEN also opens the public status route.
  VERTEX_IBKR_RECOVERY_URL: tailnetServiceUrl("VERTEX_IBKR_RECOVERY_URL"),
  // Tailnet-only kb-chat front end, framed by the Knowledge page (no KB data reaches Vertex).
  VERTEX_KB_CHAT_URL: kbChatUrlSchema,

  // Vertex safety literals: research/paper only, read-only, no order submission.
  VERTEX_MODE: z.enum(["research", "paper"]).default("research"),
  VERTEX_OPERATOR_EMAILS: operatorEmailsSchema,
  // Shared secret for the order bridge (header X-Vertex-Bridge-Token). Server-only; never logged.
  VERTEX_ORDER_BRIDGE_TOKEN: serviceTokenSchema("VERTEX_ORDER_BRIDGE_TOKEN"),
  // Loopback order bridge that wraps the market-watch-bot IBKR gateway (used only when enabled).
  VERTEX_ORDER_BRIDGE_URL: loopbackHttpUrl("VERTEX_ORDER_BRIDGE_URL"),
  // Repo-wide order submission gate. "enabled" (with VERTEX_ORDERS_ENABLED=true) lets the owner order
  // screen send real orders through the bridge (owner decision 2026-11-04). Default "disabled".
  VERTEX_ORDER_SUBMISSION: z.enum(["disabled", "enabled"]).default("disabled"),
  // Owner order screen. Off by default: while false the screen uses the mock gateway only and
  // nothing reaches IBKR. Turning it on in production is the owner's decision.
  VERTEX_ORDERS_ENABLED: environmentBoolean("VERTEX_ORDERS_ENABLED", false),
  // Tailnet-only read-only IBKR portfolio service base URL (portfolioMonitor.snapshot), e.g.
  // https://<vps>.ts.net:8443/vertex-portfolio/v1. Same token and URL rules as VERTEX_DEPLOY_STATUS_URL.
  VERTEX_PORTFOLIO_URL: tailnetOrLoopbackServiceUrl("VERTEX_PORTFOLIO_URL"),
  // Price alert ntfy delivery (priceAlerts.*); unset => triggers show in the portal only.
  VERTEX_PRICE_ALERTS_NTFY_ORIGIN: priceAlertsNtfyOrigin,
  VERTEX_PRICE_ALERTS_NTFY_TOKEN: priceAlertsNtfyToken,
  VERTEX_PRICE_ALERTS_NTFY_TOPIC: priceAlertsNtfyTopic,
  // Contact address for the research fetch User-Agent (SEC asks for one); server-side only.
  VERTEX_RESEARCH_CONTACT_EMAIL: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().max(254).pipe(z.email()).optional()
  ),
  // Tailnet-only read-only research lens documents (researchLenses.*), e.g.
  // https://<vps>.ts.net:8443/vertex-research-lenses/v1. Same token and URL rules as VERTEX_DEPLOY_STATUS_URL.
  VERTEX_RESEARCH_LENSES_URL: tailnetServiceUrl("VERTEX_RESEARCH_LENSES_URL"),
  WORKFLOW_REPOSITORY_GRANTS: optionalString,
});

type BaseServerEnv = z.infer<typeof baseServerEnvSchema>;

const addDevelopmentCaptureIssues = (
  env: BaseServerEnv,
  context: z.RefinementCtx
): void => {
  const endpoint = parseUrl(env.DEV_EMAIL_PREVIEW_ENDPOINT ?? "");
  const appOrigin = parseUrl(env.APP_URL);
  if (
    env.APP_ENV !== "development" ||
    env.EMAIL_TRANSPORT !== "preview" ||
    appOrigin === undefined ||
    !(
      DEVELOPMENT_CAPTURE_APP_HOSTS[appOrigin.hostname] === true ||
      appOrigin.hostname.endsWith(".localhost")
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Development email capture requires development preview transport and a loopback app origin",
      path: ["DEV_EMAIL_PREVIEW_ENDPOINT"],
    });
  }
  if (
    endpoint === undefined ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    endpoint.pathname !== "/v1/capture" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.href !== env.DEV_EMAIL_PREVIEW_ENDPOINT
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Development email capture requires an exact loopback capture URL",
      path: ["DEV_EMAIL_PREVIEW_ENDPOINT"],
    });
  }
  if (
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(
      env.DEV_EMAIL_PREVIEW_KEY ?? ""
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Development email capture requires a canonical 32-byte base64url key",
      path: ["DEV_EMAIL_PREVIEW_KEY"],
    });
  }
};

export const serverEnvSchema = baseServerEnvSchema
  .refine(
    (env) =>
      env.DATABASE_PROVIDER === "hyperdrive" || env.DATABASE_URL !== undefined,
    {
      message: "DATABASE_URL is required",
      path: ["DATABASE_URL"],
      // Run beside other field errors so a missing DATABASE_URL is reported in the same pass.
      when: (payload) =>
        typeof payload.value === "object" && payload.value !== null,
    }
  )
  .superRefine((env, context): void => {
    const operators = new Set(
      env.VERTEX_OPERATOR_EMAILS.map((email) => email.toLowerCase())
    );
    if (
      env.VERTEX_AGENT_VIEWER_EMAILS.some((email) =>
        operators.has(email.toLowerCase())
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "VERTEX_AGENT_VIEWER_EMAILS must not overlap VERTEX_OPERATOR_EMAILS (a viewer is read-only)",
        path: ["VERTEX_AGENT_VIEWER_EMAILS"],
      });
    if (env.APP_URL !== env.BETTER_AUTH_URL) {
      context.addIssue({
        code: "custom",
        message: "BETTER_AUTH_URL must match APP_URL",
        path: ["BETTER_AUTH_URL"],
      });
    }

    if (
      env.APP_ENV !== "development" &&
      isLocalhostNameHttpOrigin(env.APP_URL)
    ) {
      context.addIssue({
        code: "custom",
        message: "APP_URL may use http://*.localhost only in development",
        path: ["APP_URL"],
      });
    }

    const secretScope = deployedSecretScope(env.APP_ENV, env.APP_URL);
    for (const name of [
      "BETTER_AUTH_SECRET",
      "CONTACT_THROTTLE_SECRET",
    ] as const) {
      if (secretScope === undefined) break;
      if (DEVELOPMENT_SECRETS[env[name].trim()] !== true) continue;
      context.addIssue({
        code: "custom",
        message: `${name} cannot use a development or public-template secret ${secretScope}`,
        path: [name],
      });
    }

    if (env.APP_ENV === "production") {
      for (const [name, value] of [
        ["APP_URL", env.APP_URL],
        ["BETTER_AUTH_URL", env.BETTER_AUTH_URL],
      ] as const) {
        const parsedUrl = parseUrl(value);
        if (parsedUrl === undefined || !isLocalHostname(parsedUrl.hostname))
          continue;
        context.addIssue({
          code: "custom",
          message: `${name} cannot use a local origin in production`,
          path: [name],
        });
      }
      if (env.DATABASE_URL !== undefined && isPostgresUrl(env.DATABASE_URL)) {
        try {
          validateRequestDatabaseEndpoint({
            allowedHosts: env.DATABASE_ALLOWED_HOSTS,
            appEnvironment: env.APP_ENV,
            connectionString: env.DATABASE_URL,
            provider: env.DATABASE_PROVIDER,
          });
        } catch (error) {
          if (!(error instanceof RequestDatabaseEndpointError)) throw error;
          context.addIssue({
            code: "custom",
            message: error.diagnostic,
            path: ["DATABASE_URL"],
          });
        }
      }
    }

    if (
      (env.EMAIL_PROVIDER === "disabled") !==
      (env.EMAIL_TRANSPORT === "disabled")
    ) {
      context.addIssue({
        code: "custom",
        message: "EMAIL_PROVIDER and EMAIL_TRANSPORT must be disabled together",
        path: ["EMAIL_TRANSPORT"],
      });
    }

    if (env.EMAIL_TRANSPORT === "resend" && !env.RESEND_API_KEY) {
      context.addIssue({
        code: "custom",
        message: "RESEND_API_KEY is required when EMAIL_TRANSPORT is resend",
        path: ["RESEND_API_KEY"],
      });
    }

    if (env.APP_ENV === "production" && env.EMAIL_TRANSPORT === "preview") {
      context.addIssue({
        code: "custom",
        message: "EMAIL_TRANSPORT cannot use preview in production",
        path: ["EMAIL_TRANSPORT"],
      });
    }

    if (
      env.DEV_EMAIL_PREVIEW_ENDPOINT !== undefined ||
      env.DEV_EMAIL_PREVIEW_KEY !== undefined
    ) {
      addDevelopmentCaptureIssues(env, context);
    }

    if (env.STORAGE_ENABLED) {
      for (const key of STORAGE_REQUIRED_KEYS) {
        if (env[key]) continue;
        context.addIssue({
          code: "custom",
          message: `${key} is required when STORAGE_ENABLED is true`,
          path: [key],
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
export type EnvironmentIssue = Readonly<{
  path: string;
  message: string;
}>;

export class EnvironmentValidationError extends Error {
  readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    super(
      [
        "Invalid server environment:",
        ...issues.map(({ path, message }) => `- ${path}: ${message}`),
      ].join("\n")
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

export const parseServerEnv = (source: EnvironmentSource): ServerEnv => {
  const result = serverEnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map(
    (issue): EnvironmentIssue => ({
      message: issue.message,
      path: issue.path.length > 0 ? issue.path.join(".") : "environment",
    })
  );
  throw new EnvironmentValidationError(issues);
};

export type ProviderCapabilities = Readonly<{
  ai: boolean;
  emailDelivery: boolean;
  analytics: boolean;
  telemetryExport: boolean;
}>;

/** Environment readiness only; capability manifests still own installation and availability. */
export const getProviderCapabilities = (
  env: ServerEnv
): ProviderCapabilities => ({
  ai: Boolean(env.GROQ_API_KEY && env.GROQ_MODEL),
  analytics: Boolean(env.POSTHOG_KEY && env.POSTHOG_HOST),
  emailDelivery: Boolean(
    env.EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY && env.EMAIL_FROM
  ),
  telemetryExport: Boolean(env.OTEL_ENABLED && env.OTEL_EXPORTER_OTLP_ENDPOINT),
});
