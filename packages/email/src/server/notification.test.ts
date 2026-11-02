import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResendNotificationEmailPort,
  type NotificationEmailInput,
} from "./notification.ts";

const input: NotificationEmailInput = {
  to: "Member@EXAMPLE.TEST",
  subject: "Research update",
  text: "A < B & C\nInformational only.",
  idempotencyKey: "a".repeat(64),
};
const signal = () => new AbortController().signal;
const fixture = () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ id: "email-accepted" })
  );
  const options = {
    enabled: true,
    apiKey: "re_test_only",
    from: "research@example.test",
    fetcher,
  };
  return { fetcher, options, port: createResendNotificationEmailPort(options) };
};

afterEach(() => {
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("additive notification email port", () => {
  it("remains disabled by default and unavailable without explicit configuration", async () => {
    const h = fixture();
    const disabled = createResendNotificationEmailPort({
      ...h.options,
      enabled: undefined,
    });
    expect(disabled.availability).toBe("disabled");
    expect(await disabled.send(input, signal())).toEqual({
      acceptance: "not-sent",
    });
    for (const change of [
      { apiKey: undefined },
      { from: undefined },
      { fetcher: undefined },
      { from: "bad\r\nBcc: injected@example.test" },
      { timeoutMs: 30_001 },
    ]) {
      const port = createResendNotificationEmailPort({
        ...h.options,
        ...change,
      });
      expect(port.availability).toBe("unavailable");
      expect(await port.send(input, signal())).toEqual({
        acceptance: "not-sent",
      });
    }
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("uses the existing Resend message shape and recipient normalization without receipt claims", async () => {
    const h = fixture();
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "accepted",
    });
    expect(h.fetcher).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: "Bearer re_test_only",
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
      })
    );
    const payload = JSON.parse(h.fetcher.mock.calls[0]![1].body as string);
    expect(payload.to).toEqual(["Member@example.test"]);
    expect(payload.subject).toBe(input.subject);
    expect(payload.text).toBe(input.text);
    expect(payload.html).toContain("A &lt; B &amp; C");
    return expect(payload.html).not.toContain("A < B");
  });

  it("accepts a single configured brand sender while preserving name and mailbox local-part", async () => {
    for (const [from, expected] of [
      ["  Research@EXAMPLE.TEST  ", "Research@example.test"],
      [
        "Vertex Research <noreply@domain.test>",
        "Vertex Research <noreply@domain.test>",
      ],
      [
        "  Vertex  Research <Research@EXAMPLE.TEST>  ",
        "Vertex  Research <Research@example.test>",
      ],
      [
        "Équipe Research <Research@EXAMPLE.TEST>",
        "Équipe Research <Research@example.test>",
      ],
    ] as const) {
      const h = fixture();
      const port = createResendNotificationEmailPort({ ...h.options, from });
      expect(port.availability).toBe("ready");
      expect(await port.send(input, signal())).toEqual({
        acceptance: "accepted",
      });
      const payload = JSON.parse(h.fetcher.mock.calls[0]![1].body as string);
      expect(payload.from).toBe(expected);
      expect(payload.to).toEqual(["Member@example.test"]);
    }
  });

  it("rejects sender header injection, lists and malformed envelopes without publishing", async () => {
    for (const from of [
      "Vertex Research <noreply@domain.test>\r\nBcc:other@example.test",
      "Vertex\nResearch <noreply@domain.test>",
      "Vertex\tResearch <noreply@domain.test>",
      "Vertex\u0000Research <noreply@domain.test>",
      "Vertex\u0085Research <noreply@domain.test>",
      "Vertex\u2028Research <noreply@domain.test>",
      "Vertex\u2029Research <noreply@domain.test>",
      "first@example.test,second@example.test",
      "Vertex <first@example.test>, Other <second@example.test>",
      "Vertex <first@example.test;second@example.test>",
      "Group: first@example.test;",
      "Bcc: Other <other@example.test>",
      "Vertex <<noreply@domain.test>>",
      "Vertex <noreply@domain.test",
      "Vertex noreply@domain.test>",
      "Vertex <noreply@domain.test> trailing",
      "Vertex <noreply@domain.test><other@example.test>",
      "<noreply@domain.test>",
      "Vertex <>",
      "Vertex <not-an-address>",
    ]) {
      const h = fixture();
      const port = createResendNotificationEmailPort({ ...h.options, from });
      expect(port.availability).toBe("unavailable");
      expect(await port.send(input, signal())).toEqual({
        acceptance: "not-sent",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
    }
  });

  it("bounds sender envelope and display-name UTF8 bytes independently", async () => {
    for (const from of [
      `${"A".repeat(161)} <noreply@domain.test>`,
      `${"界".repeat(54)} <noreply@domain.test>`,
      `${" ".repeat(513)}noreply@domain.test`,
      `${"界".repeat(171)} <noreply@domain.test>`,
    ]) {
      const h = fixture();
      const port = createResendNotificationEmailPort({ ...h.options, from });
      expect(port.availability).toBe("unavailable");
      expect(h.fetcher).not.toHaveBeenCalled();
    }
  });

  it("rejects unbounded messages, injected recipients and unexpected fields before network", async () => {
    const h = fixture();
    for (const change of [
      { to: "a@example.test\r\nBcc:b@example.test" },
      { subject: "x".repeat(161) },
      { subject: "界".repeat(54) },
      { text: "x".repeat(4097) },
      { text: "\u0000" },
      { idempotencyKey: "address@example.test" },
      { token: "forged" },
    ])
      expect(await h.port.send({ ...input, ...change }, signal())).toEqual({
        acceptance: "not-sent",
      });
    const getter = vi.fn(() => "secret");
    expect(
      await h.port.send(
        Object.defineProperty({ ...input }, "text", { get: getter }),
        signal()
      )
    ).toEqual({ acceptance: "not-sent" });
    expect(getter).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("reports rejected versus unknown without forwarding provider bodies or IDs", async () => {
    const h = fixture();
    h.fetcher.mockResolvedValueOnce(
      new Response("private rejection detail", { status: 403 })
    );
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "rejected",
    });
    h.fetcher.mockResolvedValueOnce(
      new Response("private unavailable detail", { status: 500 })
    );
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "unknown",
    });
    h.fetcher.mockResolvedValueOnce(Response.json({ id: "bad\nidentifier" }));
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "unknown",
    });
    h.fetcher.mockRejectedValueOnce(
      new Error("re_test_only Member@example.test")
    );
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "unknown",
    });
    return expect(h.fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds declared and streamed response size", async () => {
    const h = fixture();
    h.fetcher.mockResolvedValueOnce(
      new Response("{}", { headers: { "content-length": "8193" } })
    );
    expect(await h.port.send(input, signal())).toEqual({
      acceptance: "unknown",
    });
    h.fetcher.mockResolvedValueOnce(new Response(" ".repeat(8193)));
    return expect(await h.port.send(input, signal())).toEqual({
      acceptance: "unknown",
    });
  });

  it("aborts hanging response bodies but does not automatically retry", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const cancel = vi.fn();
    h.fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel }))
    );
    const port = createResendNotificationEmailPort({
      ...h.options,
      timeoutMs: 25,
    });
    const result = port.send(input, signal());
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toEqual({ acceptance: "unknown" });
    expect(cancel).toHaveBeenCalledTimes(1);
    return expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  return it("never publishes when cancelled before dispatch", async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await h.port.send(input, controller.signal)).toEqual({
      acceptance: "not-sent",
    });
    return expect(h.fetcher).not.toHaveBeenCalled();
  });
});
