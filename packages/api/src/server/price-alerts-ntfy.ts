import {
  createNtfyNotificationAdapter,
  type NotificationFetch,
} from "@darkfactory/notifications/server";

import type { PriceAlertsNtfyConfig } from "./service-config.ts";

// The price alert ntfy destination: one fixed-text push per call. priceAlerts.*, priceAlerts.signals.*
// and sectorRotation.collect all send through here. The topic and token go only to the ntfy adapter
// and are never logged.

const NTFY_TIMEOUT_MS = 10_000;
const NOTIFICATION_TENANT = "vertex";
const NOTIFICATION_RECIPIENT = "price-alerts";
const NOTIFICATION_CONFIGURATION = "price-alerts-ntfy";

export type PriceAlertsNtfyDelivery = "sent" | "not-configured" | "failed";

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * One ntfy message through the notifications package, sent to the price alert ntfy destination.
 * The idempotency key is the SHA-256 of `idempotencySource`.
 */
export const sendPriceAlertsNtfy = async (
  config: PriceAlertsNtfyConfig | null,
  message: Readonly<{ title: string; body: string }>,
  idempotencySource: string,
  at: Date,
  notify?: NotificationFetch
): Promise<PriceAlertsNtfyDelivery> => {
  if (config === null) return "not-configured";
  const fetcher =
    notify ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const adapter = createNtfyNotificationAdapter({
    enabled: true,
    fetcher,
    resolveConfiguration: async () => ({
      bearerToken: config.token,
      enabled: true,
      origin: config.origin,
      recipientKey: NOTIFICATION_RECIPIENT,
      tenantKey: NOTIFICATION_TENANT,
      topic: config.topic,
    }),
    timeoutMs: NTFY_TIMEOUT_MS,
  });
  const signal = new AbortController().signal;
  const preparation = await adapter.prepare(
    {
      authenticated: true,
      channel: "phone",
      configurationRef: NOTIFICATION_CONFIGURATION,
      cooldownMs: 1000,
      enabled: true,
      expiresAt: at.getTime() + 10 * 60_000,
      purpose: "market-alert",
      recipientKey: NOTIFICATION_RECIPIENT,
      recipientRef: NOTIFICATION_RECIPIENT,
      tenantKey: NOTIFICATION_TENANT,
    },
    signal
  );
  if (preparation.status !== "ready") return "failed";
  const outcome = await preparation.send(
    {
      body: message.body,
      providerIdempotencyKey: await sha256Hex(idempotencySource),
      title: message.title,
    },
    signal
  );
  return outcome.acceptance === "accepted" ? "sent" : "failed";
};
