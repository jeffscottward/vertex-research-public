import type {
  NotificationChannel,
  NotificationPurpose,
  NotificationResult,
} from "../../index.ts";
import type {
  NotificationAcceptance,
  NotificationStore,
} from "../contracts.ts";
import type {
  NtfyNotificationConfiguration,
  NotificationFetch,
} from "../ntfy.ts";
import type { EmailNotificationConfiguration } from "../email.ts";

export type NotificationAccountScope = Readonly<{
  accountAlias: string;
  environment: "research" | "paper";
}>;
export type NotificationRecipientBinding = NotificationAccountScope &
  Readonly<{
    tenantKey: string;
    recipientKey: string;
    recipientRef: string;
    channel: NotificationChannel;
    purpose: NotificationPurpose;
    // Immutable, nonsecret references; never a topic, email, URL or token.
    destinationRef: string;
  }>;
export type NotificationConsent = NotificationRecipientBinding &
  Readonly<{
    consentId: string;
    version: string;
    validFrom: number;
    expiresAt: number;
  }>;
export type NotificationRecipientGrant = NotificationRecipientBinding &
  Readonly<{
    grantId: string;
    version: string;
    consentId: string;
    consentVersion: string;
    configurationRef: string;
    templateVersion: "vertex-notification-v1";
    validFrom: number;
    expiresAt: number;
    cooldownMs: number;
  }>;
export type NotificationGrantSelection = NotificationAccountScope &
  Readonly<{ grantId: string; version: string }>;
export type NotificationGrantQuery = NotificationAccountScope &
  Readonly<{ purpose: NotificationPurpose }>;
export type NotificationAuthorityMutation<T> = Readonly<{
  value: T;
  expectedVersion: string | null;
}>;
export type NotificationAuthorityRevocation = NotificationAccountScope &
  Readonly<{
    tenantKey: string;
    id: string;
    version: string;
    expectedVersion: string;
  }>;

// Context is a real server session/service identity, never decoded request JSON.
// Each repository method reauthenticates it; a valid shape is not permission.
export interface NotificationGrantRepository<Context> {
  listCurrent: (
    context: Context,
    query: NotificationGrantQuery,
    signal: AbortSignal
  ) => Promise<readonly NotificationRecipientGrant[]>;
  resolveCurrent: (
    context: Context,
    selection: NotificationGrantSelection,
    signal: AbortSignal
  ) => Promise<NotificationRecipientGrant | null>;
  issueConsent: (
    context: Context,
    input: NotificationAuthorityMutation<NotificationConsent>
  ) => Promise<"recorded" | "duplicate">;
  revokeConsent: (
    context: Context,
    input: NotificationAuthorityRevocation
  ) => Promise<"recorded" | "duplicate">;
  issueGrant: (
    context: Context,
    input: NotificationAuthorityMutation<NotificationRecipientGrant>
  ) => Promise<"recorded" | "duplicate">;
  revokeGrant: (
    context: Context,
    input: NotificationAuthorityRevocation
  ) => Promise<"recorded" | "duplicate">;
}

export type NotificationDispatchEvent = NotificationAccountScope &
  Readonly<{
    eventId: string;
    kind:
      | "market-alert"
      | "research-completed"
      | "research-failed"
      | "operational-alert";
    // Exact Vertex ISO-8601 with explicit offset and <=9 fractional digits.
    // Converted to UTC epoch-ms only at notification admission. NOT epoch-ms.
    occurredAt: string;
    expiresAt: string;
  }>;
export type NotificationDispatchOptions = Readonly<{
  dryRun: boolean;
  signal: AbortSignal;
}>;
export type NotificationDispatchResult = Readonly<{
  status: "completed" | "rejected" | "unavailable";
  reason:
    | "processed"
    | "disabled"
    | "invalid-event"
    | "expired"
    | "unavailable"
    | "cancelled";
  retryable: false;
  results: readonly Readonly<{
    grantId: string;
    version: string;
    result: NotificationResult;
  }>[];
}>;
export interface NotificationDispatch<Context> {
  handle: (
    context: Context,
    event: unknown,
    options: NotificationDispatchOptions
  ) => Promise<NotificationDispatchResult>;
}

// Supplied by private application configuration. Receives exact scoped immutable
// destination/config/consent references. Called only immediately before a send;
// dry-run checks readiness, NEVER resolves secrets or provider destinations.
export interface NotificationConfigurationResolver<Context> {
  readiness: (
    context: Context,
    grant: NotificationRecipientGrant,
    signal: AbortSignal
  ) => Promise<"ready" | "disabled" | "unavailable">;
  resolvePhone: (
    context: Context,
    grant: NotificationRecipientGrant,
    signal: AbortSignal
  ) => Promise<NtfyNotificationConfiguration | null>;
  resolveEmail: (
    context: Context,
    grant: NotificationRecipientGrant,
    signal: AbortSignal
  ) => Promise<EmailNotificationConfiguration | null>;
}
export type NotificationDispatchFactoryOptions<Context> = Readonly<{
  enabled?: boolean | undefined;
  grants: NotificationGrantRepository<Context>;
  store: NotificationStore;
  configurations: NotificationConfigurationResolver<Context>;
  fetcher?: NotificationFetch | undefined;
  clock: Readonly<{ now: () => number }>;
  timeoutMs?: number | undefined;
}>;

export type NotificationDeliveryQuery = NotificationGrantSelection &
  Readonly<{ eventId: string }>;
export type NotificationDeliveryStatus =
  | Readonly<{ status: "not-found"; receipt: "unconfirmed"; retryable: false }>
  | Readonly<{
      status: NotificationAcceptance;
      admittedAt: number;
      expiresAt: number;
      outcomeAt: number | null;
      receipt: "unconfirmed";
      retryable: false;
    }>;
export interface NotificationDeliveryReadSource<Context> {
  read: (
    context: Context,
    query: NotificationDeliveryQuery,
    signal: AbortSignal
  ) => Promise<NotificationDeliveryStatus>;
}
