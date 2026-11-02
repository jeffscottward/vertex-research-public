import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NotificationEmailPort,
  NotificationEmailResult,
} from "@darkfactory/email/server";
import {
  createEmailNotificationAdapter,
  type EmailNotificationConfiguration,
} from "./email.ts";
import type { NotificationGrant, NotificationMessage } from "./contracts.ts";

const grant: NotificationGrant = {
  authenticated: true,
  tenantKey: "tenant-a",
  recipientKey: "recipient-a",
  recipientRef: "member-a",
  channel: "email",
  purpose: "research-update",
  configurationRef: "email-config",
  enabled: true,
  expiresAt: 1_700_000_060_000,
  cooldownMs: 30_000,
};
const message: NotificationMessage = {
  title: "Advisory update",
  body: "Informational only",
  providerIdempotencyKey: "a".repeat(64),
};
const signal = () => new AbortController().signal;
const fixture = () => {
  const send = vi.fn(
    async (): Promise<NotificationEmailResult> => ({ acceptance: "accepted" })
  );
  const port: NotificationEmailPort = { availability: "ready", send };
  const config: EmailNotificationConfiguration = {
    enabled: true,
    tenantKey: "tenant-a",
    recipientKey: "recipient-a",
    to: "Member@EXAMPLE.TEST",
    port,
  };
  const resolveConfiguration = vi.fn(async () => config);
  const adapter = createEmailNotificationAdapter({
    enabled: true,
    resolveConfiguration,
  });
  return { send, port, config, resolveConfiguration, adapter };
};

afterEach(() => {
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("provider-neutral email notification adapter", () => {
  it("stays disabled and does not look up configuration by default", async () => {
    const h = fixture();
    const disabled = createEmailNotificationAdapter({
      resolveConfiguration: h.resolveConfiguration,
    });
    expect(await disabled.prepare(grant, signal())).toEqual({
      status: "disabled",
    });
    expect(h.resolveConfiguration).not.toHaveBeenCalled();
    return expect(h.send).not.toHaveBeenCalled();
  });

  it("prepares without publishing and sends only to the server-resolved recipient", async () => {
    const h = fixture();
    const prepared = await h.adapter.prepare(grant, signal());
    expect(h.send).not.toHaveBeenCalled();
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    expect(await prepared.send(message, signal())).toEqual({
      acceptance: "accepted",
    });
    return expect(h.send).toHaveBeenCalledWith(
      {
        to: "Member@example.test",
        subject: message.title,
        text: message.body,
        idempotencyKey: message.providerIdempotencyKey,
      },
      expect.any(AbortSignal)
    );
  });

  it("rejects mismatched configuration scope and invalid destinations", async () => {
    for (const change of [
      { recipientKey: "other" },
      { tenantKey: "other" },
      { to: "invalid" },
      { to: "member@example.test\r\nBcc:a@example.test" },
    ]) {
      const h = fixture();
      h.resolveConfiguration.mockResolvedValue({ ...h.config, ...change });
      expect(await h.adapter.prepare(grant, signal())).toEqual({
        status: "unavailable",
      });
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  it("honors configuration and provider readiness without preview fallbacks", async () => {
    const h = fixture();
    h.resolveConfiguration.mockResolvedValueOnce({
      ...h.config,
      enabled: false,
    });
    expect(await h.adapter.prepare(grant, signal())).toEqual({
      status: "disabled",
    });
    h.resolveConfiguration.mockResolvedValueOnce({
      ...h.config,
      port: { ...h.port, availability: "unavailable" },
    });
    expect(await h.adapter.prepare(grant, signal())).toEqual({
      status: "unavailable",
    });
    h.resolveConfiguration.mockResolvedValueOnce({
      ...h.config,
      port: { ...h.port, availability: "disabled" },
    });
    expect(await h.adapter.prepare(grant, signal())).toEqual({
      status: "disabled",
    });
    return expect(h.send).not.toHaveBeenCalled();
  });

  it("never forwards provider fields or exceptions into public outcomes", async () => {
    const h = fixture();
    const prepared = await h.adapter.prepare(grant, signal());
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    h.send.mockResolvedValueOnce({
      acceptance: "accepted",
      address: "private@example.test",
    } as unknown as NotificationEmailResult);
    expect(await prepared.send(message, signal())).toEqual({
      acceptance: "unknown",
    });
    h.send.mockRejectedValueOnce(
      new Error("private@example.test provider-secret")
    );
    expect(await prepared.send(message, signal())).toEqual({
      acceptance: "unknown",
    });
    return expect(h.send).toHaveBeenCalledTimes(2);
  });

  return it("bounds arbitrary injected provider ports with no retry", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.send.mockImplementation(() => new Promise(() => undefined));
    const adapter = createEmailNotificationAdapter({
      enabled: true,
      resolveConfiguration: h.resolveConfiguration,
      timeoutMs: 20,
    });
    const prepared = await adapter.prepare(grant, signal());
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    const result = prepared.send(message, signal());
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toEqual({ acceptance: "unknown" });
    return expect(h.send).toHaveBeenCalledTimes(1);
  });
});
