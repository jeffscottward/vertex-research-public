import { describe, expect, it, vi } from "vitest";

import { type ConnectivityTickIo, runConnectivityTick } from "./tick.ts";

const BASE_ENV = {
  VERTEX_AGENT_API_KEY: "test-key",
  VERTEX_ALERT_CHANNEL: "1234567890",
  VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
  VERTEX_ORIGIN: "https://vertex.test/path",
};

const BASE_REPLY = {
  action: "noop",
  activeAlertKeys: [],
  alertableIssues: [],
  delivery: null,
  dryRun: false,
  issues: [],
  needsOwnerAsk: false,
  newlyAlerted: [],
  ntfyConfigured: true,
  overallStatus: "healthy",
  pendingChat: null,
  plannedAlert: null,
};

const harnessFor = (
  env: Record<string, string | undefined> = BASE_ENV,
  argv: readonly string[] = []
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn<ConnectivityTickIo["post"]>();
  const io: ConnectivityTickIo = {
    argv,
    env,
    post,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return { err, io, out, post };
};

describe("runConnectivityTick", () => {
  it("returns exit 2 on unknown CLI argument and exit 1 on missing/invalid env", async () => {
    const badArg = harnessFor(BASE_ENV, ["--bogus"]);
    await expect(runConnectivityTick(badArg.io)).resolves.toBe(2);
    expect(badArg.err[0]).toContain("unknown argument: --bogus");

    const noKey = harnessFor({ VERTEX_ORIGIN: "https://vertex.test" });
    await expect(runConnectivityTick(noKey.io)).resolves.toBe(1);
    expect(noKey.err[0]).toContain("VERTEX_AGENT_API_KEY is required");

    const badUrl = harnessFor({
      VERTEX_AGENT_API_KEY: "k",
      VERTEX_ORIGIN: "not-a-url",
    });
    await expect(runConnectivityTick(badUrl.io)).resolves.toBe(1);
    expect(badUrl.err[0]).toContain("VERTEX_ORIGIN must be a valid URL");
  });

  it("handles healthy noop and dry-run planned alert cleanly", async () => {
    const ok = harnessFor();
    ok.post.mockResolvedValueOnce(Response.json({ json: BASE_REPLY }));
    await expect(runConnectivityTick(ok.io)).resolves.toBe(0);
    expect(ok.out[0]).toContain(
      "connectivity: status=healthy issues=0 alertable=0 action=noop delivery=none owner_ask=no"
    );

    const dry = harnessFor(BASE_ENV, ["--dry-run"]);
    dry.post.mockResolvedValueOnce(
      Response.json({
        json: {
          ...BASE_REPLY,
          action: "alert",
          alertableIssues: [{}],
          delivery: "dry-run",
          dryRun: true,
          issues: [{}],
          needsOwnerAsk: true,
          overallStatus: "auth_failed",
          plannedAlert: {
            body: "Rotate QUANTDATA_API_KEY",
            kind: "alert",
            needsOwnerAsk: true,
            title:
              "Vertex connectivity: credential rotation needed (quantdata)",
          },
        },
      })
    );
    await expect(runConnectivityTick(dry.io)).resolves.toBe(0);
    expect(dry.out.join("")).toContain("planned alert: Vertex connectivity");
  });

  it("posts pendingChat with NEEDS YOU credential prefix for auth failures and acknowledges delivery", async () => {
    const h = harnessFor();
    h.post
      .mockResolvedValueOnce(
        Response.json({
          json: {
            ...BASE_REPLY,
            action: "alert",
            alertableIssues: [{}],
            delivery: "not-configured",
            issues: [{}],
            needsOwnerAsk: true,
            ntfyConfigured: false,
            overallStatus: "auth_failed",
            pendingChat: {
              body: "- SPY options (quantdata): HTTP 401",
              eventId: "conn-1",
              kind: "alert",
              needsOwnerAsk: true,
              title:
                "Vertex connectivity: credential rotation needed (quantdata)",
            },
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "sent", eventId: "conn-1" },
        })
      );
    await expect(runConnectivityTick(h.io)).resolves.toBe(0);
    const chatCall = h.post.mock.calls[1];
    expect(chatCall?.[0]).toBe(BASE_ENV.VERTEX_ALERT_POST_URL);
    expect(String(chatCall?.[1]?.body)).toContain(
      "[NEEDS YOU — CREDENTIAL ROTATION]"
    );
    expect(h.out.join("")).toContain("posted connectivity alert to 1234567890");
  });

  it("handles non-auth chat post, missing alert env, chat post failures, and ack failures", async () => {
    const pendingNonAuth = {
      ...BASE_REPLY,
      action: "alert",
      alertableIssues: [{}],
      delivery: "failed",
      issues: [{}],
      overallStatus: "degraded",
      pendingChat: {
        body: "- ES ticks: HTTP 503",
        eventId: "conn-2",
        kind: "alert",
        needsOwnerAsk: false,
        title: "Vertex connectivity: repeated feed failures (ibkr-history)",
      },
    };

    // Missing alert env records failed ack when delivery !== "not-configured"
    const missingEnv = harnessFor({
      VERTEX_AGENT_API_KEY: "test-key",
      VERTEX_ORIGIN: "https://vertex.test",
    });
    missingEnv.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "failed", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(missingEnv.io)).resolves.toBe(1);
    expect(missingEnv.err[0]).toContain(
      "VERTEX_ALERT_POST_URL and VERTEX_ALERT_CHANNEL are required"
    );

    // Missing alert env with delivery === "not-configured" skips failed ack
    const missingEnvNotCfg = harnessFor({
      VERTEX_AGENT_API_KEY: "test-key",
      VERTEX_ORIGIN: "https://vertex.test",
    });
    missingEnvNotCfg.post.mockResolvedValueOnce(
      Response.json({
        json: { ...pendingNonAuth, delivery: "not-configured" },
      })
    );
    await expect(runConnectivityTick(missingEnvNotCfg.io)).resolves.toBe(1);
    expect(missingEnvNotCfg.post).toHaveBeenCalledTimes(1);

    // Chat post HTTP 500 -> records failed and exits 1
    const chat500 = harnessFor();
    chat500.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "failed", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(chat500.io)).resolves.toBe(1);
    expect(chat500.err[0]).toContain("HTTP 500");

    // Chat post throws -> records failed and exits 1
    const chatThrow = harnessFor();
    chatThrow.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockRejectedValueOnce(new Error("conn refused"))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "failed", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(chatThrow.io)).resolves.toBe(1);
    expect(chatThrow.err[0]).toContain("conn refused");

    // Chat post returns { ok: false } -> records failed and exits 1
    const chatBadReply = harnessFor();
    chatBadReply.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(Response.json({ ok: false }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "failed", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(chatBadReply.io)).resolves.toBe(1);
    expect(chatBadReply.err[0]).toContain('reply was not {"ok":true}');

    // Chat post returns 200 non-JSON -> records failed and exits 1
    const chatNonJson = harnessFor();
    chatNonJson.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: true, delivery: "failed", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(chatNonJson.io)).resolves.toBe(1);
    expect(chatNonJson.err[0]).toContain('reply was not {"ok":true}');

    // Ack fails -> exits 1
    const ackError = harnessFor();
    ackError.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockRejectedValueOnce("ack down");
    await expect(runConnectivityTick(ackError.io)).resolves.toBe(1);
    expect(ackError.err[0]).toContain("could not record chat delivery");

    // Ack returns committed: false -> exits 1
    const ackUncommitted = harnessFor();
    ackUncommitted.post
      .mockResolvedValueOnce(Response.json({ json: pendingNonAuth }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({
          json: { committed: false, delivery: "sent", eventId: "conn-2" },
        })
      );
    await expect(runConnectivityTick(ackUncommitted.io)).resolves.toBe(1);
    expect(ackUncommitted.err[0]).toContain("was not committed");
  });

  it("handles API HTTP errors, non-JSON, bad envelope, and bad schema", async () => {
    const httpErr = harnessFor();
    httpErr.post.mockResolvedValueOnce(
      new Response("forbidden", { status: 403 })
    );
    await expect(runConnectivityTick(httpErr.io)).resolves.toBe(1);
    expect(httpErr.err[0]).toContain("HTTP 403");

    const nonJson = harnessFor();
    nonJson.post.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(runConnectivityTick(nonJson.io)).resolves.toBe(1);
    expect(nonJson.err[0]).toContain("not JSON");

    const badEnv = harnessFor();
    badEnv.post.mockResolvedValueOnce(Response.json("not-an-object"));
    await expect(runConnectivityTick(badEnv.io)).resolves.toBe(1);
    expect(badEnv.err[0]).toContain("unexpected envelope");

    const badShape = harnessFor();
    badShape.post.mockResolvedValueOnce(Response.json({ json: { bogus: 1 } }));
    await expect(runConnectivityTick(badShape.io)).resolves.toBe(1);
    expect(badShape.err[0]).toContain("unexpected shape");
  });
});
