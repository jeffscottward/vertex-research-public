import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationGrant, NotificationMessage } from "./contracts.ts";
import {
  createNtfyNotificationAdapter,
  type NtfyNotificationConfiguration,
} from "./ntfy.ts";

const grant: NotificationGrant = {
  authenticated: true,
  tenantKey: "tenant-a",
  recipientKey: "recipient-a",
  recipientRef: "member-a",
  channel: "phone",
  purpose: "market-alert",
  configurationRef: "config-a",
  enabled: true,
  expiresAt: 1_700_000_060_000,
  cooldownMs: 30_000,
};
const config: NtfyNotificationConfiguration = {
  enabled: true,
  tenantKey: "tenant-a",
  recipientKey: "recipient-a",
  origin: "https://ntfy.example.test",
  topic: "private-test-topic",
  bearerToken: "test-token-only",
};
const message: NotificationMessage = {
  title: "Advisory update",
  body: "Informational only",
  providerIdempotencyKey: "a".repeat(64),
};
const response = () =>
  new Response(
    JSON.stringify({
      id: "provider-id",
      event: "message",
      topic: config.topic,
    }),
    { status: 200 }
  );
const signal = () => new AbortController().signal;
const fixture = (value: NtfyNotificationConfiguration = config) => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response());
  const resolveConfiguration = vi.fn(async () => value);
  const adapter = createNtfyNotificationAdapter({
    enabled: true,
    resolveConfiguration,
    fetcher,
  });
  return { fetcher, resolveConfiguration, adapter };
};
const deliver = async (h: ReturnType<typeof fixture>) => {
  const prepared = await h.adapter.prepare(grant, signal());
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture unavailable");
  return prepared.send(message, signal());
};

afterEach(() => {
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("opt-in ntfy phone boundary", () => {
  it("does no lookup or publish unless explicitly enabled and configured", async () => {
    const h = fixture();
    const disabled = createNtfyNotificationAdapter({
      resolveConfiguration: h.resolveConfiguration,
      fetcher: h.fetcher,
    });
    expect(await disabled.prepare(grant, signal())).toEqual({
      status: "disabled",
    });
    const missingTransport = createNtfyNotificationAdapter({
      enabled: true,
      resolveConfiguration: h.resolveConfiguration,
    });
    expect(await missingTransport.prepare(grant, signal())).toEqual({
      status: "unavailable",
    });
    expect(h.resolveConfiguration).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("keeps configuration lookup local and publishes only through the prepared transport", async () => {
    const h = fixture();
    const prepared = await h.adapter.prepare(grant, signal());
    expect(h.resolveConfiguration).toHaveBeenCalledWith(
      "config-a",
      expect.any(AbortSignal)
    );
    expect(h.fetcher).not.toHaveBeenCalled();
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    expect(await prepared.send(message, signal())).toEqual({
      acceptance: "accepted",
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledWith(
      `${config.origin}/`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-only",
        },
      })
    );
    return expect(
      JSON.parse(h.fetcher.mock.calls[0]![1].body as string)
    ).toEqual({
      topic: config.topic,
      title: message.title,
      message: message.body,
    });
  });

  it("rejects invalid transport targets and credentials before any publish", async () => {
    for (const change of [
      { origin: "http://ntfy.example.test" },
      { origin: "https://ntfy.example.test/path" },
      { origin: "https://username:password@ntfy.example.test" },
      { origin: "https://ntfy.example.test?topic=secret" },
      { topic: "escape/topic" },
      { bearerToken: "bad\r\nheader" },
    ]) {
      const h = fixture({ ...config, ...change });
      expect(await h.adapter.prepare(grant, signal())).toEqual({
        status: "unavailable",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
    }
  });

  it("rejects another tenant or recipient configuration and respects opt-out", async () => {
    for (const change of [{ tenantKey: "other" }, { recipientKey: "other" }]) {
      const h = fixture({ ...config, ...change });
      expect(await h.adapter.prepare(grant, signal())).toEqual({
        status: "unavailable",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
    }
    const h = fixture({ ...config, enabled: false });
    return expect(await h.adapter.prepare(grant, signal())).toEqual({
      status: "disabled",
    });
  });

  it("maps definite provider rejections without forwarding response bodies", async () => {
    const h = fixture();
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      h.fetcher.mockResolvedValueOnce(
        new Response("secret-provider-error", { status })
      );

      expect(await deliver(h)).toEqual({ acceptance: "rejected" });
    }
  });

  it("treats ambiguous status, malformed JSON and mismatched topic as unknown", async () => {
    const h = fixture();
    for (const next of [
      new Response("server-failure", { status: 500 }),
      new Response(null, { status: 302 }),
      new Response("not-json", { status: 200 }),
      new Response(null, { status: 204 }),
      Response.json({ id: "provider-id", event: "message", topic: "wrong" }),
    ]) {
      h.fetcher.mockResolvedValueOnce(next);

      expect(await deliver(h)).toEqual({ acceptance: "unknown" });
    }
  });

  it("bounds both declared and streamed response bytes", async () => {
    const h = fixture();
    h.fetcher.mockResolvedValueOnce(
      new Response("{}", { headers: { "content-length": "1000000" } })
    );
    expect(await deliver(h)).toEqual({ acceptance: "unknown" });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(8193)),
      cancel,
    });
    h.fetcher.mockResolvedValueOnce(new Response(body));
    expect(await deliver(h)).toEqual({ acceptance: "unknown" });
    return expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("has no fallback or retry when transport fails after possible acceptance", async () => {
    const h = fixture();
    h.fetcher.mockRejectedValue(
      new Error("private-test-topic credential details")
    );
    expect(await deliver(h)).toEqual({ acceptance: "unknown" });
    return expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging response and keeps the outcome unknown", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () => new Response(new ReadableStream<Uint8Array>({ cancel }))
    );
    const adapter = createNtfyNotificationAdapter({
      enabled: true,
      resolveConfiguration: async () => config,
      fetcher,
      timeoutMs: 25,
    });
    const prepared = await adapter.prepare(grant, signal());
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    const promise = prepared.send(message, signal());
    await vi.advanceTimersByTimeAsync(25);
    expect(await promise).toEqual({ acceptance: "unknown" });
    expect(cancel).toHaveBeenCalledTimes(1);
    return expect(fetcher).toHaveBeenCalledTimes(1);
  });

  return it("does not publish pre-aborted or unbounded messages", async () => {
    const h = fixture();
    const prepared = await h.adapter.prepare(grant, signal());
    if (prepared.status !== "ready") throw new Error("fixture unavailable");
    const controller = new AbortController();
    controller.abort();
    expect(await prepared.send(message, controller.signal)).toEqual({
      acceptance: "not-sent",
    });
    expect(
      await prepared.send({ ...message, body: "x".repeat(4097) }, signal())
    ).toEqual({ acceptance: "not-sent" });
    return expect(h.fetcher).not.toHaveBeenCalled();
  });
});
