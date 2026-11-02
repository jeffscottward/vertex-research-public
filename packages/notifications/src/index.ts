export type NotificationChannel = "phone" | "email";
export type NotificationPurpose =
  | "market-alert"
  | "research-update"
  | "operational-alert";

// References are opaque application identifiers, never destinations or credentials.
// Authorization and provider configuration cannot be supplied through this request.
export type NotificationRequest = Readonly<{
  recipientRef: string;
  channel: NotificationChannel;
  purpose: NotificationPurpose;
  idempotencyKey: string;
  expiresAt: number;
  title: string;
  body: string;
  dryRun: boolean;
}>;

export type NotificationNotSentReason =
  | "invalid-request"
  | "disabled"
  | "denied"
  | "unavailable"
  | "expired"
  | "duplicate"
  | "idempotency-conflict"
  | "cooldown";

// Acceptance is NOT device receipt, inbox delivery, or a read receipt.
// No identifiers, destinations, content, provider errors, or config refs escape here.
export type NotificationResult =
  | Readonly<{
      status: "not-sent";
      reason: NotificationNotSentReason;
      receipt: "unconfirmed";
      retryable: false;
    }>
  | Readonly<{
      status: "dry-run";
      receipt: "unconfirmed";
      retryable: false;
    }>
  | Readonly<{
      status: "accepted" | "rejected" | "unknown";
      persistence: "recorded" | "uncertain";
      receipt: "unconfirmed";
      retryable: false;
    }>;

// biome-ignore lint/performance/noBarrelFile: package root re-exports the shared request/result validators.
export {
  snapshotNotificationRequest,
  snapshotNotificationResult,
} from "./validation.ts";
