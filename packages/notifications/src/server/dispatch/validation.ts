import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import {
  dataRecord,
  isOpaqueKey,
  isChannel,
  isPurpose,
  isTimestamp,
} from "../../validation.ts";
import { digest } from "../safety.ts";
import type {
  NotificationAccountScope,
  NotificationConsent,
  NotificationDispatchEvent,
  NotificationRecipientBinding,
  NotificationRecipientGrant,
} from "./contracts.ts";

export class NotificationAuthorityError extends Error {
  readonly code:
    | "invalid"
    | "denied"
    | "unavailable"
    | "conflict"
    | "integrity";
  constructor(code: NotificationAuthorityError["code"]) {
    super(`Notification authority ${code}`);
    this.name = "NotificationAuthorityError";
    this.code = code;
  }
}
export const notificationFail = (
  code: NotificationAuthorityError["code"]
): never => {
  throw new NotificationAuthorityError(code);
};
export const notificationKey = (value: unknown): string =>
  isOpaqueKey(value) ? value : notificationFail("invalid");
// Vertex event/account/actor identities use the existing public identifier
// domain. Notification recipient/configuration references remain opaque128.
export const notificationVertexIdentifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    return notificationFail("invalid");
  return value;
};
export const notificationMilliseconds = (value: unknown): number =>
  isTimestamp(value) && !Object.is(value, -0)
    ? value
    : notificationFail("invalid");
export const notificationVersion = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/.test(value))
    return notificationFail("invalid");
  return value;
};
export const notificationFields = (
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> =>
  dataRecord(value, keys) ?? notificationFail("invalid");
export const notificationAccount = (
  accountAlias: unknown,
  environment: unknown
): NotificationAccountScope => {
  if (environment !== "research" && environment !== "paper")
    return notificationFail("invalid");
  return Object.freeze({
    accountAlias: notificationVertexIdentifier(accountAlias),
    environment,
  });
};
const recipientKeys = [
  "tenantKey",
  "accountAlias",
  "environment",
  "recipientKey",
  "recipientRef",
  "channel",
  "purpose",
  "destinationRef",
] as const;
const bound = (
  value: Readonly<Record<string, unknown>>
): NotificationRecipientBinding => {
  if (!(isChannel(value["channel"]) && isPurpose(value["purpose"])))
    return notificationFail("invalid");
  return Object.freeze({
    ...notificationAccount(value["accountAlias"], value["environment"]),
    tenantKey: notificationKey(value["tenantKey"]),
    recipientKey: notificationKey(value["recipientKey"]),
    recipientRef: notificationKey(value["recipientRef"]),
    channel: value["channel"],
    purpose: value["purpose"],
    destinationRef: notificationKey(value["destinationRef"]),
  });
};
export const notificationBinding = (
  value: NotificationRecipientBinding
): NotificationRecipientBinding => bound(value);
const interval = (
  value: Readonly<Record<string, unknown>>
): Readonly<{ validFrom: number; expiresAt: number }> => {
  const validFrom = notificationMilliseconds(value["validFrom"]);
  const expiresAt = notificationMilliseconds(value["expiresAt"]);
  if (expiresAt <= validFrom) return notificationFail("invalid");
  return { validFrom, expiresAt };
};
export const snapshotNotificationConsent = (
  raw: unknown
): NotificationConsent => {
  const value = notificationFields(raw, [
    ...recipientKeys,
    "consentId",
    "version",
    "validFrom",
    "expiresAt",
  ]);
  return Object.freeze({
    ...bound(value),
    consentId: notificationKey(value["consentId"]),
    version: notificationVersion(value["version"]),
    ...interval(value),
  });
};
export const snapshotNotificationRecipientGrant = (
  raw: unknown
): NotificationRecipientGrant => {
  const value = notificationFields(raw, [
    ...recipientKeys,
    "grantId",
    "version",
    "consentId",
    "consentVersion",
    "configurationRef",
    "templateVersion",
    "validFrom",
    "expiresAt",
    "cooldownMs",
  ]);
  if (
    value["templateVersion"] !== "vertex-notification-v1" ||
    typeof value["cooldownMs"] !== "number" ||
    !Number.isSafeInteger(value["cooldownMs"]) ||
    value["cooldownMs"] < 1000 ||
    value["cooldownMs"] > 604_800_000
  )
    return notificationFail("invalid");
  return Object.freeze({
    ...bound(value),
    grantId: notificationKey(value["grantId"]),
    version: notificationVersion(value["version"]),
    consentId: notificationKey(value["consentId"]),
    consentVersion: notificationVersion(value["consentVersion"]),
    configurationRef: notificationKey(value["configurationRef"]),
    templateVersion: value["templateVersion"],
    ...interval(value),
    cooldownMs: value["cooldownMs"],
  });
};

// Reuse the authoritative exact Gregorian/offset parser. Only the notification
// boundary adds the nonnegative, year9999 UTC epoch-ms range restriction.
export const notificationEpochNanoseconds = (value: unknown): bigint => {
  if (typeof value !== "string") return notificationFail("invalid");
  try {
    const ns = timestampToEpochNanoseconds(value);
    if (ns < 0n || ns > 253_402_300_799_999_999_999n)
      return notificationFail("invalid");
    return ns;
  } catch {
    return notificationFail("invalid");
  }
};
// Floor at the notification boundary is conservative: never extend a deadline.
// The exact ns ordering is still checked before any conversion.
export const notificationEpochMilliseconds = (value: unknown): number =>
  notificationMilliseconds(
    Number(notificationEpochNanoseconds(value) / 1_000_000n)
  );
export const snapshotNotificationDispatchEvent = (
  raw: unknown
): NotificationDispatchEvent => {
  const value = notificationFields(raw, [
    "eventId",
    "accountAlias",
    "environment",
    "kind",
    "occurredAt",
    "expiresAt",
  ]);
  if (
    value["kind"] !== "market-alert" &&
    value["kind"] !== "research-completed" &&
    value["kind"] !== "research-failed" &&
    value["kind"] !== "operational-alert"
  )
    return notificationFail("invalid");
  const occurred = notificationEpochNanoseconds(value["occurredAt"]);
  const expires = notificationEpochNanoseconds(value["expiresAt"]);
  if (occurred >= expires || expires - occurred > 86_400_000_000_000n)
    return notificationFail("invalid");
  return Object.freeze({
    ...notificationAccount(value["accountAlias"], value["environment"]),
    eventId: notificationVertexIdentifier(value["eventId"]),
    kind: value["kind"],
    occurredAt: value["occurredAt"] as string,
    expiresAt: value["expiresAt"] as string,
  });
};
export const notificationEventKey = (
  scope: NotificationAccountScope,
  eventId: string
): Promise<string> => {
  const valid = notificationAccount(scope.accountAlias, scope.environment);
  return digest(
    JSON.stringify([
      "vertex-notification-v1",
      valid.accountAlias,
      valid.environment,
      notificationVertexIdentifier(eventId),
    ])
  );
};
