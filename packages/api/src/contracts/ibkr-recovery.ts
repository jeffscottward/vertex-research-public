import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";
import { oc } from "@orpc/contract";
import { z } from "zod";

// Human IBKR 2FA recovery request (Mission control account card, "Send IBKR 2FA request").
// Source: the QuantVPS tailnet service vertex-ibkr-recovery (VERTEX_IBKR_RECOVERY_URL, own token
// VERTEX_IBKR_RECOVERY_TOKEN). The VPS service may start only the existing 2FA script, and only when
// the gateway reports a logged-out or stopped login state, or logged in with missing account feeds. One request at a time, 15 min cooldown.
// A request never authorizes trading and is never sent automatically.

export const IBKR_RECOVERY_COOLDOWN_SECONDS = 900;
export const IBKR_RECOVERY_LOGIN_STATES = [
  "logged-in",
  "awaiting-2fa",
  "starting",
  "logged-out",
  "stopped",
  "unknown",
] as const;
export const IBKR_RECOVERY_REQUEST_STATES = [
  "requested",
  "waiting-for-approval",
  "verifying",
  "logged-in",
  "timed-out",
  "failed",
] as const;
export const IBKR_RECOVERY_TERMINAL_STATES = [
  "logged-in",
  "timed-out",
  "failed",
] as const;

const isoTime = z.string().max(40);

export const IbkrRecoveryGatewaySchema = z
  .object({
    // The gateway reports logged in, but the vertex-portfolio account feeds are not live. A 2FA request
    // restarts the gateway login, so it can help here too. False when the feed state is unknown.
    feedsMissing: z.boolean(),
    loginState: z.enum(IBKR_RECOVERY_LOGIN_STATES),
    // True only for logged-out and stopped: the states in which a 2FA request can help.
    needsLogin: z.boolean(),
    reason: z.string().max(60),
    // Time of the gateway log event that decided the state, when known.
    since: isoTime.nullable(),
  })
  .strict();

export const IbkrRecoveryRequestSchema = z
  .object({
    detail: z.string().max(200),
    finishedAt: isoTime.nullable(),
    recheck: z
      .object({ at: isoTime, detail: z.string().max(200), ok: z.boolean() })
      .strict()
      .nullable(),
    // The VPS re-reads the real auth state at this time (request time + IBKR approval window, 900 s).
    // A good result clears the request; a bad result stays here with its reason.
    recheckAt: isoTime.nullable(),
    requestedAt: isoTime,
    requestedByYou: z.boolean(),
    requestId: z.string().max(64),
    // The VPS script still runs; a new request is refused until it exits.
    scriptRunning: z.boolean(),
    state: z.enum(IBKR_RECOVERY_REQUEST_STATES),
    updatedAt: isoTime,
  })
  .strict();

export const IbkrRecoveryStatusInputSchema = z.object({}).strict();

export const IbkrRecoveryStatusOutputSchema = z
  .object({
    // Recovery needed (needsLogin, or logged in with feedsMissing), no request in flight and no cooldown.
    canRequest: z.boolean(),
    checkedAt: isoTime,
    cooldownUntil: isoTime.nullable(),
    gateway: IbkrRecoveryGatewaySchema,
    request: IbkrRecoveryRequestSchema.nullable(),
  })
  .strict();

export const IbkrRecoveryRequestInputSchema = z
  .object({
    // The operator confirms this exact statement in the dialog before the request is sent.
    confirmation: z.literal(RECOVERY_CONFIRMATION),
  })
  .strict();

export const IbkrRecoveryRequestOutputSchema = z
  .object({
    outcome: z.enum(["started", "existing"]),
    request: IbkrRecoveryRequestSchema,
  })
  .strict();

export const IBKR_RECOVERY_ERRORS = {
  AUDIT_UNAVAILABLE: {
    message: "Audit log unavailable; the request was not sent",
    status: 503,
  },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  IN_FLIGHT: {
    message: "An IBKR 2FA request is already in progress",
    status: 409,
  },
  NOT_CONFIGURED: {
    message: "IBKR recovery endpoint not configured",
    status: 503,
  },
  NOT_NEEDED: {
    message:
      "The IBKR gateway does not report a logged-out state or missing account feeds",
    status: 409,
  },
  RATE_LIMITED: {
    message: "IBKR 2FA requests are limited to one per 15 minutes",
    status: 429,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "IBKR recovery service unavailable", status: 503 },
  UPSTREAM_ERROR: { message: "IBKR recovery request failed", status: 502 },
} as const;

const ibkrRecovery = oc.errors(IBKR_RECOVERY_ERRORS);

const status = ibkrRecovery
  .route({
    method: "GET",
    operationId: "ibkrRecovery.status",
    path: "/ibkr-recovery/status",
    summary:
      "IBKR gateway login state and the latest human 2FA recovery request",
    tags: ["IBKR recovery"],
  })
  .input(IbkrRecoveryStatusInputSchema)
  .output(IbkrRecoveryStatusOutputSchema);

const request = ibkrRecovery
  .route({
    method: "POST",
    operationId: "ibkrRecovery.request",
    path: "/ibkr-recovery/request",
    summary:
      "Send one human-confirmed IBKR 2FA login request (no trading authority)",
    tags: ["IBKR recovery"],
  })
  .input(IbkrRecoveryRequestInputSchema)
  .output(IbkrRecoveryRequestOutputSchema);

export const ibkrRecoveryContract = { request, status };

export type IbkrRecoveryLoginState =
  (typeof IBKR_RECOVERY_LOGIN_STATES)[number];
export type IbkrRecoveryRequestState =
  (typeof IBKR_RECOVERY_REQUEST_STATES)[number];
export type IbkrRecoveryRequest = z.infer<typeof IbkrRecoveryRequestSchema>;
export type IbkrRecoveryStatusOutput = z.infer<
  typeof IbkrRecoveryStatusOutputSchema
>;
export type IbkrRecoveryRequestOutput = z.infer<
  typeof IbkrRecoveryRequestOutputSchema
>;
