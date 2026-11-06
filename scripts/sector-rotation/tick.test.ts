import { describe, expect, it, vi } from "vitest";

import { runSectorRotationTick, type SectorRotationTickIo } from "./tick.ts";

const RESULT = {
  alerts: [
    {
      date: "2026-11-02",
      delivery: "sent",
      symbol: "XLK",
      to: "leading",
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

  it("sends dryRun with --dry-run and prints a result with no alerts", async () => {
    const harness = harnessFor(env, Response.json({ json: { alerts: [] } }), [
      "--dry-run",
    ]);
    await expect(runSectorRotationTick(harness.io)).resolves.toBe(0);
    expect(harness.post.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ json: { dryRun: true } })
    );
    expect(harness.out).toEqual(['{"alerts":[]}\n']);
  });

  it.each([
    ["an empty envelope", "{}", "json: Invalid input"],
    ["a non-object envelope", "null", "(root): Invalid input"],
    [
      "a changed alerts field",
      '{"json":{"alerts":3}}',
      "json.alerts: Invalid input",
    ],
    [
      "an alert without a line",
      '{"json":{"alerts":[{"date":"2026-11-02","delivery":"sent","symbol":"XLK","to":"leading"}]}}',
      "json.alerts.0.line: Invalid input",
    ],
  ])(
    "fails and posts nothing when collect returns %s",
    async (_kind, body, issue) => {
      const harness = harnessFor(
        {
          ...env,
          VERTEX_ALERT_CHANNEL: "trading-alerts",
          VERTEX_ALERT_POST_URL: "http://127.0.0.1:47821/post",
        },
        new Response(body)
      );
      await expect(runSectorRotationTick(harness.io)).resolves.toBe(1);
      expect(harness.post).toHaveBeenCalledTimes(1);
      expect(harness.out).toEqual([]);
      const message = harness.err.join("");
      expect(message).toContain(
        "sector rotation tick failed: sectorRotation.collect returned an unexpected shape; no alert was read or posted"
      );
      expect(message).toContain(issue);
    }
  );

  it("fails with a clear message when collect returns a body that is not JSON", async () => {
    const harness = harnessFor(env, new Response("<html>proxy error</html>"));
    await expect(runSectorRotationTick(harness.io)).resolves.toBe(1);
    expect(harness.err).toEqual([
      "sector rotation tick failed: sectorRotation.collect returned a body that is not JSON: <html>proxy error</html>\n",
    ]);
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
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "sent",
          line: "A entered Leading. Research only.",
        },
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "not-configured",
          line: "B entered Lagging. Research only.",
        },
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "failed",
          line: "C entered Leading. Research only.",
        },
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "dry-run",
          line: "D entered Leading. Research only.",
        },
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
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "not-configured",
          line: "B entered Lagging. Research only.",
        },
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "failed",
          line: "C entered Leading. Research only.",
        },
      ],
    };
    const err: string[] = [];
    let chatCalls = 0;
    const post = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith("/collect")) return Response.json({ json: result });
      if (url.endsWith("/recordChatDelivery"))
        return Response.json({ json: { updated: true } });
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
      "could not post XLE lagging 2026-11-02 to chat: connection refused\n",
      "could not post XLE lagging 2026-11-02 to chat: HTTP 502\n",
      "sector rotation tick failed: 2 alert line(s) could not be posted to chat\n",
    ]);
  });

  it("posts nothing to chat when only one of the two chat settings is set", async () => {
    const result = {
      alerts: [
        {
          date: "2026-11-02",
          symbol: "XLE",
          to: "lagging",
          delivery: "not-configured",
          line: "B. Research only.",
        },
      ],
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

  it("records sent after an accepted post and failed otherwise, once per line", async () => {
    const alert = (symbol: string, delivery: string) => ({
      date: "2026-11-02",
      delivery,
      line: `${symbol} entered Lagging. Research only.`,
      symbol,
      to: "lagging",
    });
    const result = {
      alerts: [
        alert("XLE", "not-configured"),
        alert("XLU", "failed"),
        alert("XLB", "not-configured"),
      ],
    };
    const post = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/collect")) return Response.json({ json: result });
      if (url.endsWith("/recordChatDelivery"))
        return Response.json({ json: { updated: true } });
      const text = String(JSON.parse(String(init.body)).text);
      if (text.startsWith("XLE")) return Response.json({ ok: true });
      if (text.startsWith("XLU")) return Response.json({ ok: false });
      return new Response("not json");
    });
    const err: string[] = [];
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
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("/post"))
    ).toHaveLength(3);
    const writes = post.mock.calls.filter(([url]) =>
      url.endsWith("/recordChatDelivery")
    );
    expect(writes.map(([url]) => url)).toEqual(
      new Array(3).fill(
        "https://vertex.test/api/orpc/sectorRotation/recordChatDelivery"
      )
    );
    expect(writes.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      {
        json: {
          delivery: "sent",
          enteredOn: "2026-11-02",
          quadrant: "lagging",
          symbol: "XLE",
        },
      },
      {
        json: {
          delivery: "failed",
          enteredOn: "2026-11-02",
          quadrant: "lagging",
          symbol: "XLU",
        },
      },
      {
        json: {
          delivery: "failed",
          enteredOn: "2026-11-02",
          quadrant: "lagging",
          symbol: "XLB",
        },
      },
    ]);
    expect(writes[0]?.[1].headers).toMatchObject({ "x-api-key": "test-key" });
    expect(err).toEqual([
      'could not post XLU lagging 2026-11-02 to chat: reply was not {"ok":true}\n',
      'could not post XLB lagging 2026-11-02 to chat: reply was not {"ok":true}\n',
      "sector rotation tick failed: 2 alert line(s) could not be posted to chat\n",
    ]);
  });

  it("reports a failed write-back without posting the line again", async () => {
    const result = {
      alerts: [
        {
          date: "2026-11-02",
          delivery: "not-configured",
          line: "XLE. Research only.",
          symbol: "XLE",
          to: "lagging",
        },
        {
          date: "2026-11-02",
          delivery: "not-configured",
          line: "XLK. Research only.",
          symbol: "XLK",
          to: "leading",
        },
      ],
    };
    let writes = 0;
    const post = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith("/collect")) return Response.json({ json: result });
      if (url.endsWith("/recordChatDelivery")) {
        writes += 1;
        if (writes === 1) throw new Error("offline");
        return new Response("no", { status: 503 });
      }
      return Response.json({ ok: true });
    });
    const err: string[] = [];
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
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("/post"))
    ).toHaveLength(2);
    expect(err).toEqual([
      "could not record sent for XLE lagging 2026-11-02: offline\n",
      "could not record sent for XLK leading 2026-11-02 (HTTP 503)\n",
      "sector rotation tick failed: 2 chat delivery result(s) could not be recorded (lines were posted once; not reposted)\n",
    ]);
  });
});
