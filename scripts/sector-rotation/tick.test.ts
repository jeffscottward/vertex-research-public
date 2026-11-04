import { describe, expect, it, vi } from "vitest";

import { runSectorRotationTick, type SectorRotationTickIo } from "./tick.ts";

const RESULT = {
  alerts: [
    {
      delivery: "sent",
      line: "Sector rotation: XLK (Technology) entered Leading on 2026-11-02 (ratio 101.2, momentum 100.4). Research only.",
    },
  ],
  asOf: "2026-11-02",
};

const harnessFor = (
  env: Record<string, string | undefined>,
  response: Response = Response.json({ json: RESULT }),
  argv: readonly string[] = []
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async (_url: string, _init: RequestInit) => response);
  const io: SectorRotationTickIo = {
    argv,
    env,
    post,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return { err, io, out, post };
};

const env = {
  VERTEX_AGENT_API_KEY: "test-key",
  VERTEX_ORIGIN: "https://vertex.test/path",
};

describe("runSectorRotationTick", () => {
  it("posts one sectorRotation.collect request and prints the result and each alert line", async () => {
    const harness = harnessFor(env);
    await expect(runSectorRotationTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledWith(
      "https://vertex.test/api/orpc/sectorRotation/collect",
      {
        body: JSON.stringify({ json: { dryRun: false } }),
        headers: {
          "content-type": "application/json",
          origin: "https://vertex.test",
          "x-api-key": "test-key",
        },
        method: "POST",
      }
    );
    expect(harness.out).toEqual([
      `${JSON.stringify(RESULT)}\n`,
      `${RESULT.alerts[0]?.line} [sent]\n`,
    ]);
  });

  it("sends dryRun with --dry-run and prints null for an empty body", async () => {
    const harness = harnessFor(env, new Response("{}"), ["--dry-run"]);
    await expect(runSectorRotationTick(harness.io)).resolves.toBe(0);
    expect(harness.post.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ json: { dryRun: true } })
    );
    expect(harness.out).toEqual(["null\n"]);
    const noAlerts = harnessFor(env, Response.json({ json: { alerts: 3 } }));
    await runSectorRotationTick(noAlerts.io);
    expect(noAlerts.out).toEqual(['{"alerts":3}\n']);
  });

  it("fails on bad arguments, missing configuration or an error and never prints the key", async () => {
    const extra = harnessFor(env, undefined, ["--force"]);
    await expect(runSectorRotationTick(extra.io)).resolves.toBe(1);
    expect(extra.err.join("")).toContain("unknown argument: --force");
    expect(extra.post).not.toHaveBeenCalled();
    const missing = harnessFor({ VERTEX_ORIGIN: "https://vertex.test" });
    await expect(runSectorRotationTick(missing.io)).resolves.toBe(1);
    expect(missing.err.join("")).toContain("VERTEX_AGENT_API_KEY is required");
    const blank = harnessFor({ VERTEX_AGENT_API_KEY: "k", VERTEX_ORIGIN: " " });
    await expect(runSectorRotationTick(blank.io)).resolves.toBe(1);
    expect(blank.err.join("")).toContain("VERTEX_ORIGIN is required");
    const failed = harnessFor(env, new Response("nope", { status: 503 }));
    await expect(runSectorRotationTick(failed.io)).resolves.toBe(1);
    expect(failed.err.join("")).toContain("HTTP 503: nope");
    expect(failed.err.join("")).not.toContain("test-key");
    const thrown = harnessFor(env);
    const offline: SectorRotationTickIo = {
      ...thrown.io,
      post: async () => Promise.reject("offline"),
    };
    await expect(runSectorRotationTick(offline)).resolves.toBe(1);
    expect(thrown.err.join("")).toContain("offline");
  });

  it("posts each undelivered alert line to the chat endpoint once and skips sent ones", async () => {
    const result = {
      alerts: [
        { delivery: "sent", line: "A entered Leading. Research only." },
        {
          delivery: "not-configured",
          line: "B entered Lagging. Research only.",
        },
        { delivery: "failed", line: "C entered Leading. Research only." },
        { delivery: "dry-run", line: "D entered Leading. Research only." },
      ],
    };
    const out: string[] = [];
    const err: string[] = [];
    const post = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith("/collect")
        ? Response.json({ json: result })
        : Response.json({ ok: true })
    );
    const code = await runSectorRotationTick({
      argv: [],
      env: {
        ...env,
        VERTEX_ALERT_CHANNEL: " trading-alerts ",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
      },
      post,
      stderr: { write: (text: string) => err.push(text) },
      stdout: { write: (text: string) => out.push(text) },
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const chat = post.mock.calls.filter(([url]) => url.endsWith("/post"));
    expect(chat.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { channel: "trading-alerts", text: "B entered Lagging. Research only." },
      { channel: "trading-alerts", text: "C entered Leading. Research only." },
    ]);
    expect(out.filter((line) => line.startsWith("posted"))).toHaveLength(2);
  });

  it("fails the run when a chat post fails or throws, after trying every line", async () => {
    const result = {
      alerts: [
        {
          delivery: "not-configured",
          line: "B entered Lagging. Research only.",
        },
        { delivery: "failed", line: "C entered Leading. Research only." },
      ],
    };
    const err: string[] = [];
    let chatCalls = 0;
    const post = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith("/collect")) return Response.json({ json: result });
      chatCalls += 1;
      if (chatCalls === 1) throw new Error("connection refused");
      return new Response("down", { status: 502 });
    });
    const code = await runSectorRotationTick({
      argv: [],
      env: {
        ...env,
        VERTEX_ALERT_CHANNEL: "trading-alerts",
        VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
      },
      post,
      stderr: { write: (text: string) => err.push(text) },
      stdout: { write: () => undefined },
    });
    expect(code).toBe(1);
    expect(chatCalls).toBe(2);
    expect(err).toEqual([
      "sector rotation tick failed: 2 alert line(s) could not be posted to chat\n",
    ]);
  });

  it("posts nothing to chat when only one of the two chat settings is set", async () => {
    const result = {
      alerts: [{ delivery: "not-configured", line: "B. Research only." }],
    };
    const post = vi.fn(async () => Response.json({ json: result }));
    const code = await runSectorRotationTick({
      argv: [],
      env: { ...env, VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post" },
      post,
      stderr: { write: () => undefined },
      stdout: { write: () => undefined },
    });
    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
