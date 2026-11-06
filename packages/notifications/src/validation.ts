import type {
  NotificationChannel,
  NotificationPurpose,
  NotificationRequest,
  NotificationResult,
  NotificationNotSentReason,
} from "./types.ts";

export const MAX_NOTIFICATION_TTL_MS = 86_400_000;
export const MAX_NOTIFICATION_COOLDOWN_MS = 604_800_000;
export const MAX_NOTIFICATION_TIMEOUT_MS = 30_000;

// Reject accessors, prototypes, symbols and surplus fields without reading getters.
export const dataRecord = (
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== "string" || !keys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!(descriptor?.enumerable && "value" in descriptor)) {
        return undefined;
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
};

export const isOpaqueKey = (value: unknown): value is string => {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  );
};

export const isTimestamp = (value: unknown): value is number => {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 253_402_300_799_999
  );
};

export const isChannel = (value: unknown): value is NotificationChannel => {
  return value === "phone" || value === "email";
};

export const isPurpose = (value: unknown): value is NotificationPurpose => {
  return (
    value === "market-alert" ||
    value === "research-update" ||
    value === "operational-alert"
  );
};

const isText = (
  value: unknown,
  maxBytes: number,
  multiline: boolean
): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxBytes
  ) {
    return false;
  }
  if (value.trim().length === 0) return false;
  if (new TextEncoder().encode(value).byteLength > maxBytes) return false;
  return !(
    multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/
  ).test(value);
};

export const snapshotNotificationRequest = (
  input: unknown
): NotificationRequest | undefined => {
  const record = dataRecord(input, [
    "recipientRef",
    "channel",
    "purpose",
    "idempotencyKey",
    "expiresAt",
    "title",
    "body",
    "dryRun",
  ]);
  if (!record) return undefined;
  const {
    recipientRef,
    channel,
    purpose,
    idempotencyKey,
    expiresAt,
    title,
    body,
    dryRun,
  } = record;
  if (
    !(
      isOpaqueKey(recipientRef) &&
      isOpaqueKey(idempotencyKey) &&
      isChannel(channel) &&
      isPurpose(purpose) &&
      isTimestamp(expiresAt) &&
      isText(title, 160, false) &&
      isText(body, 4096, true)
    ) ||
    typeof dryRun !== "boolean"
  )
    return undefined;
  return Object.freeze({
    recipientRef,
    channel,
    purpose,
    idempotencyKey,
    expiresAt,
    title,
    body,
    dryRun,
  });
};

const reasons: readonly NotificationNotSentReason[] = [
  "invalid-request",
  "disabled",
  "denied",
  "unavailable",
  "expired",
  "duplicate",
  "idempotency-conflict",
  "cooldown",
];

export const snapshotNotificationResult = (
  input: unknown
): NotificationResult | undefined => {
  const skipped = dataRecord(input, [
    "status",
    "reason",
    "receipt",
    "retryable",
  ]);
  if (
    skipped &&
    skipped["status"] === "not-sent" &&
    reasons.includes(skipped["reason"] as NotificationNotSentReason) &&
    skipped["receipt"] === "unconfirmed" &&
    skipped["retryable"] === false
  )
    return Object.freeze({
      status: "not-sent",
      reason: skipped["reason"] as NotificationNotSentReason,
      receipt: "unconfirmed",
      retryable: false,
    });
  const dryRun = dataRecord(input, ["status", "receipt", "retryable"]);
  if (
    dryRun &&
    dryRun["status"] === "dry-run" &&
    dryRun["receipt"] === "unconfirmed" &&
    dryRun["retryable"] === false
  ) {
    return Object.freeze({
      status: "dry-run",
      receipt: "unconfirmed",
      retryable: false,
    });
  }
  const delivered = dataRecord(input, [
    "status",
    "persistence",
    "receipt",
    "retryable",
  ]);
  if (!delivered) return undefined;
  const { status, persistence, receipt, retryable } = delivered;
  if (
    (status !== "accepted" && status !== "rejected" && status !== "unknown") ||
    (persistence !== "recorded" && persistence !== "uncertain") ||
    receipt !== "unconfirmed" ||
    retryable !== false
  )
    return undefined;
  return Object.freeze({ status, persistence, receipt, retryable });
};
