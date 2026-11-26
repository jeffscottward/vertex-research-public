import { describe, expect, it, vi } from "vitest";

import { type OpenbbOverdueTickIo, runOpenbbOverdueTick } from "./tick.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const baseReply = {
  action: "noop" as const,
  activeAlertKeys: [],
  delivery: null,
  dryRun: false,
  monitoredCount: 23,
  ntfyConfigured: true,
  overdue: [],
  pendingChat: null,
  plannedAlert: null,
};

const makeIo = (overrides?: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  post?: OpenbbOverdueTickIo["post"];
}) => {
  const out: string[] = [];
  const err: string[] = [];
  const post =
    overrides?.post ?? vi.fn(async () => jsonResponse({ json: baseReply }));
  const io: OpenbbOverdueTickIo = {
    argv: overrides?.argv ?? [],
    env: overrides?.env ?? {
      VERTEX_AGENT_API_KEY: "test-key",
      VERTEX_ORIGIN: "https://vertex.example",
    },
    post,
    stderr: { write: (text) => err.push(text) },
    stdout: { write: (text) => out.push(text) },
  };
  return { err, io, out, post };
};

describe("runOpenbbOverdueTick", () => {
  it("exits 2 on unknown CLI argument", async () => {
    const { err, io } = makeIo({ argv: ["--bogus"] });
    expect(await runOpenbbOverdueTick(io)).toBe(2);
    expect(err.join("")).toContain("unknown argument");
  });

  it("exits 1 when required env vars are missing or invalid protocol", async () => {
    const missingKey = makeIo({
      env: { VERTEX_ORIGIN: "https://vertex.example" },
    });
    expect(await runOpenbbOverdueTick(missingKey.io)).toBe(1);
    expect(missingKey.err.join("")).toContain("VERTEX_AGENT_API_KEY");

    const badProto = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ORIGIN: "ftp://vertex.example",
      },
    });
    expect(await runOpenbbOverdueTick(badProto.io)).toBe(1);
    expect(badProto.err.join("")).toContain("http or https");
  });

  it("exits 0 on healthy noop and dry-run with planned alert", async () => {
    const healthy = makeIo();
    expect(await runOpenbbOverdueTick(healthy.io)).toBe(0);
    expect(healthy.out.join("")).toContain("overdue=0/23 action=noop");

    const dry = makeIo({
      argv: ["--dry-run"],
      post: vi.fn(async () =>
        jsonResponse({
          json: {
            ...baseReply,
            action: "alert",
            delivery: "dry-run",
            dryRun: true,
            ntfyConfigured: false,
            overdue: [{ kind: "openbb", source: "congress-house" }],
            plannedAlert: {
              body: "congress-house stale",
              kind: "alert",
              title: "Vertex: 1 data source overdue",
            },
          },
        })
      ),
    });
    expect(await runOpenbbOverdueTick(dry.io)).toBe(0);
    expect(dry.out.join("")).toContain("(dry-run)");
    expect(dry.out.join("")).toContain("planned alert:");
    expect(dry.out.join("")).toContain("#omp-alerts fallback");
  });

  it("posts pendingChat to #omp-alerts and acknowledges delivery", async () => {
    const post = vi
      .fn<OpenbbOverdueTickIo["post"]>()
      .mockResolvedValueOnce(
        jsonResponse({
          json: {
            ...baseReply,
            action: "alert",
            delivery: "not-configured",
            ntfyConfigured: false,
            overdue: [{ kind: "openbb", source: "congress-house" }],
            pendingChat: {
              body: "body",
              eventId: "evt-1",
              kind: "alert",
              title: "title",
            },
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          json: { committed: true, delivery: "sent", eventId: "evt-1" },
        })
      );
    const { io, out } = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "test-key",
        VERTEX_ALERT_CHANNEL: "123456",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post,
    });
    expect(await runOpenbbOverdueTick(io)).toBe(0);
    expect(out.join("")).toContain("posted alert to 123456");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("handles missing alert env, chat post failures, bad acks, HTTP errors, non-JSON, and bad shapes", async () => {
    const pendingReply = {
      ...baseReply,
      action: "alert" as const,
      delivery: "failed" as const,
      ntfyConfigured: true,
      pendingChat: {
        body: "body",
        eventId: "evt-2",
        kind: "alert" as const,
        title: "title",
      },
    };

    // Missing VERTEX_ALERT_POST_URL (delivery was "failed" so it also records failed ack)
    const missingAlertEnv = makeIo({
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockResolvedValueOnce(
          jsonResponse({
            json: { committed: true, delivery: "failed", eventId: "evt-2" },
          })
        ),
    });
    expect(await runOpenbbOverdueTick(missingAlertEnv.io)).toBe(1);
    expect(missingAlertEnv.err.join("")).toContain("VERTEX_ALERT_POST_URL");

    // Missing alert env with delivery "not-configured" skips failed ack
    const missingNotConf = makeIo({
      post: vi.fn<OpenbbOverdueTickIo["post"]>().mockResolvedValueOnce(
        jsonResponse({
          json: { ...pendingReply, delivery: "not-configured" },
        })
      ),
    });
    expect(await runOpenbbOverdueTick(missingNotConf.io)).toBe(1);

    // Chat post network throw
    const chatThrow = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ALERT_CHANNEL: "ch",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockRejectedValueOnce(new Error("connect refused"))
        .mockRejectedValueOnce("ack-fail"),
    });
    expect(await runOpenbbOverdueTick(chatThrow.io)).toBe(1);
    expect(chatThrow.err.join("")).toContain("connect refused");

    // Chat post HTTP 500
    const chat500 = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ALERT_CHANNEL: "ch",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockResolvedValueOnce(new Response("err", { status: 500 }))
        .mockResolvedValueOnce(
          jsonResponse({
            json: { committed: true, delivery: "failed", eventId: "evt-2" },
          })
        ),
    });
    expect(await runOpenbbOverdueTick(chat500.io)).toBe(1);
    expect(chat500.err.join("")).toContain("HTTP 500");

    // Chat post non-ok JSON reply
    const chatBadJson = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ALERT_CHANNEL: "ch",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
        .mockResolvedValueOnce(
          jsonResponse({
            json: { committed: true, delivery: "failed", eventId: "evt-2" },
          })
        ),
    });
    expect(await runOpenbbOverdueTick(chatBadJson.io)).toBe(1);
    expect(chatBadJson.err.join("")).toContain('{"ok":true}');

    // Ack error after chat posted
    const ackError = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ALERT_CHANNEL: "ch",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }))
        .mockRejectedValueOnce(new Error("ack timeout")),
    });
    expect(await runOpenbbOverdueTick(ackError.io)).toBe(1);
    expect(ackError.err.join("")).toContain("could not record chat delivery");

    // Ack not committed
    const ackNotCommitted = makeIo({
      env: {
        VERTEX_AGENT_API_KEY: "k",
        VERTEX_ALERT_CHANNEL: "ch",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        VERTEX_ORIGIN: "https://vertex.example",
      },
      post: vi
        .fn<OpenbbOverdueTickIo["post"]>()
        .mockResolvedValueOnce(jsonResponse({ json: pendingReply }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }))
        .mockResolvedValueOnce(
          jsonResponse({
            json: { committed: false, delivery: "sent", eventId: "evt-2" },
          })
        ),
    });
    expect(await runOpenbbOverdueTick(ackNotCommitted.io)).toBe(1);
    expect(ackNotCommitted.err.join("")).toContain("was not committed");

    // API HTTP error, non-JSON, bad envelope, bad json payload
    for (const resp of [
      new Response("boom", { status: 503 }),
      new Response("not-json", { status: 200 }),
      jsonResponse("not-an-object"),
      jsonResponse({ json: { action: "invalid" } }),
    ]) {
      const bad = makeIo({
        post: vi.fn<OpenbbOverdueTickIo["post"]>().mockResolvedValueOnce(resp),
      });
      expect(await runOpenbbOverdueTick(bad.io)).toBe(1);
    }
  });
});
