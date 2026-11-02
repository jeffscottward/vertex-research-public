import type { NotificationEmailPort } from "@darkfactory/email/server";
import { normalizeRecipient } from "@darkfactory/email/recipient";
import { dataRecord } from "../validation.ts";
import type {
  NotificationAdapter,
  NotificationGrant,
  NotificationMessage,
  NotificationPreparation,
  NotificationProviderOutcome,
} from "./contracts.ts";
import {
  boundedCall,
  snapshotGrant,
  snapshotProviderOutcome,
  validTimeout,
} from "./safety.ts";

export type EmailNotificationConfiguration = Readonly<{
  enabled: boolean;
  tenantKey: string;
  recipientKey: string;
  to: string;
  port: NotificationEmailPort;
}>;

export type EmailNotificationAdapterOptions = Readonly<{
  enabled?: boolean | undefined;
  resolveConfiguration: (
    reference: string,
    signal: AbortSignal
  ) => Promise<EmailNotificationConfiguration | null>;
  timeoutMs?: number | undefined;
}>;

export const createEmailNotificationAdapter = (
  options: EmailNotificationAdapterOptions
): NotificationAdapter => {
  const enabled = options.enabled === true;
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
        !validTimeout(timeoutMs) ||
        signal.aborted ||
        grant.channel !== "email"
      ) {
        return { status: "unavailable" };
      }
      const resolved = await boundedCall(
        (inner) => resolveConfiguration(grant.configurationRef, inner),
        timeoutMs,
        signal
      );
      const config = resolved.ok
        ? dataRecord(resolved.value, [
            "enabled",
            "tenantKey",
            "recipientKey",
            "to",
            "port",
          ])
        : undefined;
      if (
        !config ||
        config["tenantKey"] !== grant.tenantKey ||
        config["recipientKey"] !== grant.recipientKey
      ) {
        return { status: "unavailable" };
      }
      if (config["enabled"] !== true) return { status: "disabled" };
      const to = config["to"];
      const recipient =
        typeof to === "string" && to.length <= 254
          ? normalizeRecipient(to)
          : null;
      const port = dataRecord(config["port"], ["availability", "send"]);
      if (!(recipient && port) || typeof port["send"] !== "function")
        return { status: "unavailable" };
      if (port["availability"] === "disabled") return { status: "disabled" };
      if (port["availability"] !== "ready") return { status: "unavailable" };
      const deliver = port["send"] as NotificationEmailPort["send"];
      return Object.freeze({
        status: "ready",
        send: async (
          message: NotificationMessage,
          parent: AbortSignal
        ): Promise<NotificationProviderOutcome> => {
          if (parent.aborted) return { acceptance: "not-sent" };
          const result = await boundedCall(
            (inner) =>
              deliver(
                Object.freeze({
                  to: recipient,
                  subject: message.title,
                  text: message.body,
                  idempotencyKey: message.providerIdempotencyKey,
                }),
                inner
              ),
            timeoutMs,
            parent
          );
          return result.ok
            ? (snapshotProviderOutcome(result.value) ?? {
                acceptance: "unknown",
              })
            : { acceptance: "unknown" };
        },
      });
    },
  });
};
