import {
  dataRecord,
  isOpaqueKey,
  snapshotNotificationRequest,
} from "../validation.ts";
import type {
  NotificationAdapter,
  NotificationGrant,
  NotificationMessage,
  NotificationPreparation,
  NotificationProviderOutcome,
} from "./contracts.ts";
import {
  boundedCall,
  readBoundedJson,
  snapshotGrant,
  validTimeout,
} from "./safety.ts";

// This type and all destinations/credentials are server-only. No environment or
// OMP notification configuration is discovered; the application owns the lookup.
export type NtfyNotificationConfiguration = Readonly<{
  enabled: boolean;
  tenantKey: string;
  recipientKey: string;
  origin: string;
  topic: string;
  bearerToken: string | null;
}>;

export type NotificationFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export type NtfyNotificationAdapterOptions = Readonly<{
  enabled?: boolean | undefined;
  resolveConfiguration: (
    reference: string,
    signal: AbortSignal
  ) => Promise<NtfyNotificationConfiguration | null>;
  fetcher?: NotificationFetch | undefined;
  timeoutMs?: number | undefined;
}>;

const snapshotConfiguration = (
  value: unknown
): NtfyNotificationConfiguration | undefined => {
  const record = dataRecord(value, [
    "enabled",
    "tenantKey",
    "recipientKey",
    "origin",
    "topic",
    "bearerToken",
  ]);
  if (!record) return undefined;
  const { enabled, tenantKey, recipientKey, origin, topic, bearerToken } =
    record;
  if (
    typeof enabled !== "boolean" ||
    !isOpaqueKey(tenantKey) ||
    !isOpaqueKey(recipientKey) ||
    typeof origin !== "string" ||
    origin.length > 512 ||
    typeof topic !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(topic) ||
    (bearerToken !== null &&
      (typeof bearerToken !== "string" ||
        !/^[A-Za-z0-9._~-]{1,2048}$/.test(bearerToken)))
  )
    return undefined;
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return Object.freeze({
    enabled,
    tenantKey,
    recipientKey,
    origin,
    topic,
    bearerToken,
  });
};

const snapshotMessage = (
  message: NotificationMessage
): NotificationMessage | undefined => {
  const record = dataRecord(message, [
    "title",
    "body",
    "providerIdempotencyKey",
  ]);
  if (
    !record ||
    typeof record["providerIdempotencyKey"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(record["providerIdempotencyKey"])
  ) {
    return undefined;
  }
  const request = snapshotNotificationRequest({
    recipientRef: "internal",
    channel: "phone",
    purpose: "operational-alert",
    idempotencyKey: "internal",
    expiresAt: 1,
    title: record["title"],
    body: record["body"],
    dryRun: false,
  });
  if (!request) return undefined;
  return Object.freeze({
    title: request.title,
    body: request.body,
    providerIdempotencyKey: record["providerIdempotencyKey"],
  });
};

export const createNtfyNotificationAdapter = (
  options: NtfyNotificationAdapterOptions
): NotificationAdapter => {
  const enabled = options.enabled === true;
  const fetcher = options.fetcher;
  const resolveConfiguration = options.resolveConfiguration;
  const timeoutMs = options.timeoutMs ?? 5000;
  return Object.freeze({
    prepare: async (
      rawGrant: NotificationGrant,
      signal: AbortSignal
    ): Promise<NotificationPreparation> => {
      if (!enabled) return { status: "disabled" };
      const grant = snapshotGrant(rawGrant);
      if (!grant) return { status: "unavailable" };
      if (!grant.enabled) return { status: "disabled" };
      if (
        !(fetcher && validTimeout(timeoutMs)) ||
        signal.aborted ||
        grant.channel !== "phone"
      ) {
        return { status: "unavailable" };
      }
      const resolved = await boundedCall(
        (inner) => resolveConfiguration(grant.configurationRef, inner),
        timeoutMs,
        signal
      );
      const config = resolved.ok
        ? snapshotConfiguration(resolved.value)
        : undefined;
      if (
        !config ||
        config.tenantKey !== grant.tenantKey ||
        config.recipientKey !== grant.recipientKey
      ) {
        return { status: "unavailable" };
      }
      if (!config.enabled) return { status: "disabled" };
      return Object.freeze({
        status: "ready",
        send: async (
          input: NotificationMessage,
          parent: AbortSignal
        ): Promise<NotificationProviderOutcome> => {
          const message = snapshotMessage(input);
          if (parent.aborted || !message) return { acceptance: "not-sent" };
          const result = await boundedCall(
            async (requestSignal): Promise<NotificationProviderOutcome> => {
              const response = await fetcher(`${config.origin}/`, {
                method: "POST",
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                signal: requestSignal,
                headers: {
                  "Content-Type": "application/json",
                  ...(config.bearerToken === null
                    ? {}
                    : { Authorization: `Bearer ${config.bearerToken}` }),
                },
                body: JSON.stringify({
                  topic: config.topic,
                  title: message.title,
                  message: message.body,
                }),
              });
              // No reliance on ntfy supporting idempotency: durable admission owns it.
              // A 5xx/redirect/timeout can follow a publish; never turn it into retry.
              if (
                [400, 401, 403, 404, 413, 422, 429].includes(response.status)
              ) {
                void response.body?.cancel().catch(() => undefined);
                return { acceptance: "rejected" };
              }
              if (response.status < 200 || response.status >= 300) {
                void response.body?.cancel().catch(() => undefined);
                return { acceptance: "unknown" };
              }
              const raw = await readBoundedJson(response, requestSignal);
              if (
                typeof raw !== "object" ||
                raw === null ||
                Array.isArray(raw)
              ) {
                return { acceptance: "unknown" };
              }
              const payload = raw as Record<string, unknown>;
              if (
                payload["event"] !== "message" ||
                payload["topic"] !== config.topic ||
                typeof payload["id"] !== "string" ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(payload["id"])
              )
                return { acceptance: "unknown" };
              return { acceptance: "accepted" };
            },
            timeoutMs,
            parent
          );
          return result.ok ? result.value : { acceptance: "unknown" };
        },
      });
    },
  });
};
