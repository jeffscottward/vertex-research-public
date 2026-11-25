import { oc } from "@orpc/contract";
import { z } from "zod";

// oRPC contracts for Vertex connectivity health diagnostics and automated feed-error alerting
// (card vertex-connectivity-audit-autofix; research diagnostics and alerting only, no orders).
// Credential-rotation failures (HTTP 401/403) classify as "auth_failed" with
// escalation "needs_you_credential_rotation" so they surface immediately instead of sitting in backlog.

const count = z.number().int().nonnegative();
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/[\r\n\0]/u.test(value),
      "must not contain line breaks or NUL bytes"
    );

export const CONNECTIVITY_OVERALL_STATUSES = [
  "healthy",
  "degraded",
  "auth_failed",
] as const;

export const CONNECTIVITY_PROVIDER_STATUSES = [
  "healthy",
  "degraded",
  "auth_failed",
  "not_configured",
] as const;

export const CONNECTIVITY_ISSUE_CATEGORIES = [
  "auth_failed",
  "upstream_5xx",
  "rate_limited",
  "unreachable",
  "feed_error",
] as const;

export const CONNECTIVITY_ESCALATIONS = [
  "needs_you_credential_rotation",
  "alert",
  "info",
] as const;

export const CONNECTIVITY_ALERT_ACTIONS = [
  "noop",
  "in-flight",
  "prune-active",
  "clear-pending",
  "alert",
  "recovery",
] as const;

export const ConnectivityIssueSchema = z.strictObject({
  category: z.enum(CONNECTIVITY_ISSUE_CATEGORIES),
  consecutiveFailures: count,
  envVars: z.array(z.string()),
  escalation: z.enum(CONNECTIVITY_ESCALATIONS),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  key: z.string(),
  lastFailureAt: z.date(),
  lastOkAt: z.date().nullable(),
  layer: z.enum(["flow", "openbb"]),
  message: z.string(),
  provider: z.string(),
  source: z.string(),
});

export const ConnectivityProviderStatusSchema = z.strictObject({
  activeIssueCount: count,
  configured: z.boolean(),
  envVars: z.array(z.string()),
  id: z.string(),
  label: z.string(),
  status: z.enum(CONNECTIVITY_PROVIDER_STATUSES),
  summary: z.string(),
});

export const ConnectivityPlannedAlertSchema = z.strictObject({
  body: z.string(),
  kind: z.enum(["alert", "recovery"]),
  needsOwnerAsk: z.boolean(),
  title: z.string(),
});

const ConnectivityPendingChatAlertSchema = z.strictObject({
  body: z.string(),
  eventId: z.string(),
  kind: z.enum(["alert", "recovery"]),
  needsOwnerAsk: z.boolean(),
  title: z.string(),
});

const ConnectivityHealthInputSchema = z.strictObject({});

export const ConnectivityHealthOutputSchema = z.strictObject({
  activeAlertKeys: z.array(z.string()),
  checkedAt: z.date(),
  issues: z.array(ConnectivityIssueSchema),
  ntfyConfigured: z.boolean(),
  overallStatus: z.enum(CONNECTIVITY_OVERALL_STATUSES),
  pendingDelivery: z.enum(["pending", "not-configured", "failed"]).nullable(),
  pendingKind: z.enum(["alert", "recovery"]).nullable(),
  providers: z.array(ConnectivityProviderStatusSchema),
});

const ConnectivityCheckAlertsInputSchema = z.strictObject({
  dryRun: z.boolean().optional(),
});

export const ConnectivityCheckAlertsOutputSchema = z.strictObject({
  action: z.enum(CONNECTIVITY_ALERT_ACTIONS),
  activeAlertKeys: z.array(z.string()),
  alertableIssues: z.array(ConnectivityIssueSchema),
  checkedAt: z.date(),
  delivery: z.enum(["sent", "not-configured", "failed", "dry-run"]).nullable(),
  dryRun: z.boolean(),
  issues: z.array(ConnectivityIssueSchema),
  needsOwnerAsk: z.boolean(),
  newlyAlerted: z.array(ConnectivityIssueSchema),
  ntfyConfigured: z.boolean(),
  overallStatus: z.enum(CONNECTIVITY_OVERALL_STATUSES),
  pendingChat: ConnectivityPendingChatAlertSchema.nullable(),
  plannedAlert: ConnectivityPlannedAlertSchema.nullable(),
});

const ConnectivityRecordAlertChatInputSchema = z.strictObject({
  delivery: z.enum(["sent", "failed"]),
  eventId: label(80),
});

const ConnectivityRecordAlertChatOutputSchema = z.strictObject({
  committed: z.boolean(),
  delivery: z.enum(["sent", "failed"]),
  eventId: z.string(),
});

export type ConnectivityIssue = z.infer<typeof ConnectivityIssueSchema>;
export type ConnectivityIssueCategory = ConnectivityIssue["category"];
export type ConnectivityEscalation = ConnectivityIssue["escalation"];
export type ConnectivityOverallStatus =
  (typeof CONNECTIVITY_OVERALL_STATUSES)[number];
export type ConnectivityProviderStatus = z.infer<
  typeof ConnectivityProviderStatusSchema
>;
export type ConnectivityPlannedAlert = z.infer<
  typeof ConnectivityPlannedAlertSchema
>;
export type ConnectivityPendingChatAlert = z.infer<
  typeof ConnectivityPendingChatAlertSchema
>;
export type ConnectivityHealthOutput = z.infer<
  typeof ConnectivityHealthOutputSchema
>;
export type ConnectivityCheckAlertsOutput = z.infer<
  typeof ConnectivityCheckAlertsOutputSchema
>;

const CONNECTIVITY_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "Connectivity storage: database request failed; request not confirmed; reload to check, then retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const connectivity = oc.errors(CONNECTIVITY_API_ERRORS);
const tags = ["Connectivity"];

export const connectivityContract = {
  checkAlerts: connectivity
    .route({
      method: "POST",
      operationId: "connectivity.checkAlerts",
      path: "/connectivity/alerts/check",
      summary:
        "Scheduler: evaluate Vertex feed connectivity health and send alerts or credential-rotation escalations",
      tags,
    })
    .input(ConnectivityCheckAlertsInputSchema)
    .output(ConnectivityCheckAlertsOutputSchema),
  health: connectivity
    .route({
      method: "GET",
      operationId: "connectivity.health",
      path: "/connectivity/health",
      summary:
        "Read-only Vertex connectivity health across QuantData, OpenBB, IBKR feeds, and runtime endpoints",
      tags,
    })
    .input(ConnectivityHealthInputSchema)
    .output(ConnectivityHealthOutputSchema),
  recordAlertChat: connectivity
    .route({
      method: "POST",
      operationId: "connectivity.recordAlertChat",
      path: "/connectivity/alerts/chat-delivery",
      summary:
        "Scheduler: acknowledge #omp-alerts chat fallback delivery for a pending connectivity alert",
      tags,
    })
    .input(ConnectivityRecordAlertChatInputSchema)
    .output(ConnectivityRecordAlertChatOutputSchema),
};
