import type {
  NotificationChannel,
  NotificationPurpose,
  NotificationRequest,
  NotificationResult,
} from "../index.ts";

export type NotificationScope = Readonly<{
  tenantKey: string;
  recipientKey: string;
  channel: NotificationChannel;
  purpose: NotificationPurpose;
}>;

export type NotificationAcceptance =
  | "pending"
  | "accepted"
  | "rejected"
  | "unknown"
  | "not-sent";

export type NotificationAdmissionInput = Readonly<{
  scope: NotificationScope;
  idempotencyKey: string;
  fingerprint: string;
  attemptId: string;
  now: number;
  expiresAt: number;
  cooldownMs: number;
  mode: "observe" | "commit";
}>;

export type NotificationAdmission =
  | Readonly<{ status: "admitted"; attemptId: string }>
  | Readonly<{ status: "eligible" }>
  | Readonly<{ status: "duplicate"; acceptance: NotificationAcceptance }>
  | Readonly<{ status: "conflict" | "cooldown" | "expired" }>;

export type NotificationOutcomeInput = Readonly<{
  scope: NotificationScope;
  idempotencyKey: string;
  attemptId: string;
  acceptance: Exclude<NotificationAcceptance, "pending">;
  now: number;
}>;

// Implement in the shared durable DB, not a second notification ledger.
// admit MUST be one atomic transaction across BOTH unique keys:
// 1. (tenantKey,recipientKey,channel,purpose,idempotencyKey) for idempotency;
// 2. (tenantKey,recipientKey,channel) for cooldown, including different purposes.
// Compare fingerprint BEFORE cooldown: same key/content -> duplicate; changed -> conflict.
// "commit" inserts pending + reserves cooldown BEFORE returning admitted. Concurrent
// calls can yield only one admitted result. Return the caller's exact attemptId.
// Use the trusted input clock or a transaction clock not earlier than input.now.
// Reject expiresAt <= transaction time. "observe" runs the same checks, returning
// eligible instead of admitted, WITHOUT rows, locks with lasting effects, or updates.
// This preview is advisory, not a reservation or guarantee of later admission.
// Never release cooldown on errors/rejection; it is deliberately attempt-based.
// Never expire/reap/re-admit pending or unknown rows. A process death after admission
// is indistinguishable from a publish; those rows need explicit reconciliation.
// Retain terminal idempotency tombstones too: expiry of a request is NOT permission
// to recycle its key with a fresh deadline. Archival must preserve uniqueness.
// Persist only keys, digest, timestamps and neutral outcomes, NOT content/config/PII.
// recordOutcome MUST compare scope + key + attemptId and CAS pending -> outcome.
// An identical already-recorded outcome is idempotent; different outcomes are stale.
// Never overwrite another attempt or turn unknown into pending/retry automatically.
export interface NotificationStore {
  admit: (input: NotificationAdmissionInput) => Promise<NotificationAdmission>;
  recordOutcome: (input: NotificationOutcomeInput) => Promise<
    Readonly<{
      status: "recorded" | "stale";
    }>
  >;
}

// Minted ONLY by an authenticated server resolver from current stored permissions.
// The resolver must authenticate context and authorize the exact recipient/channel/
// purpose; a request's text, model output or a boolean in HTTP input is no grant.
export type NotificationGrant = Readonly<{
  authenticated: true;
  tenantKey: string;
  recipientKey: string;
  recipientRef: string;
  channel: NotificationChannel;
  purpose: NotificationPurpose;
  configurationRef: string;
  enabled: boolean;
  expiresAt: number;
  cooldownMs: number;
}>;

export type NotificationSelector = Pick<
  NotificationRequest,
  "recipientRef" | "channel" | "purpose"
>;

export interface NotificationRecipientResolver<Context> {
  resolve: (
    context: Context,
    selector: NotificationSelector,
    signal: AbortSignal
  ) => Promise<NotificationGrant | null>;
}

export type NotificationMessage = Readonly<{
  title: string;
  body: string;
  providerIdempotencyKey: string;
}>;

export type NotificationProviderOutcome = Readonly<{
  acceptance: "accepted" | "rejected" | "unknown" | "not-sent";
}>;

export type NotificationPreparation =
  | Readonly<{ status: "disabled" | "unavailable" }>
  | Readonly<{
      status: "ready";
      send: (
        message: NotificationMessage,
        signal: AbortSignal
      ) => Promise<NotificationProviderOutcome>;
    }>;

export interface NotificationAdapter {
  // Local configuration lookup only: MUST NOT publish or probe a provider.
  // Config references are server-only and scoped to this recipient grant.
  prepare: (
    grant: NotificationGrant,
    signal: AbortSignal
  ) => Promise<NotificationPreparation>;
}

export interface NotificationService<Context> {
  notify: (context: Context, request: unknown) => Promise<NotificationResult>;
}

export type NotificationServiceOptions<Context> = Readonly<{
  enabled?: boolean | undefined;
  resolver: NotificationRecipientResolver<Context>;
  store: NotificationStore;
  adapters?:
    | Readonly<Partial<Record<NotificationChannel, NotificationAdapter>>>
    | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
}>;
