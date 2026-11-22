import { describe, expect, it } from "vitest";

import { type PriceFreshnessTickIo, runPriceFreshnessTick } from "./tick.ts";

const KEY = "dfk_price_freshness_secret";
const ORIGIN = "https://vertex.domain.test";
const CHAT_URL = "http://127.0.0.1:47821/post";

const baseCheckReply = (overrides: Record<string, unknown> = {}) => ({
  action: "noop",
  activeAlertKeys: [],
  dailyBarsCount: 14,
  dailySeriesCount: 31,
  delivery: null,
  dryRun: false,
  expectedSession: "2026-11-20",
  ntfyConfigured: true,
  pendingChat: null,
  plannedAlert: null,
  stale: [],
  ...overrides,
});

const harness = (options: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  post?: PriceFreshnessTickIo["post"];
}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: {
    body: unknown;
    headers: HeadersInit | undefined;
    url: string;
  }[] = [];
  const io: PriceFreshnessTickIo = {
    argv: options.argv ?? [],
    env: options.env ?? {
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ALERT_CHANNEL: "omp-alerts",
      VERTEX_ALERT_POST_URL: CHAT_URL,
      VERTEX_ORIGIN: `${ORIGIN}/extra`,
    },
    post:
      options.post ??
      (async (url, init) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url,
        });
        if (url === CHAT_URL)
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: true, delivery: "sent", eventId: "evt-1" },
            }),
            { status: 200 }
          );
        return new Response(JSON.stringify({ json: baseCheckReply() }), {
          status: 200,
        });
      }),
    stderr: { write: (text) => stderr.push(text) },
    stdout: { write: (text) => stdout.push(text) },
  };
  return { calls, io, stderr, stdout };
};

describe("runPriceFreshnessTick", () => {
  it("exits 2 on unknown CLI arguments without calling the API", async () => {
    const h = harness({ argv: ["--bogus"] });
    expect(await runPriceFreshnessTick(h.io)).toBe(2);
    expect(h.stderr.join("")).toContain("unknown argument: --bogus");
    expect(h.calls).toHaveLength(0);
  });

  it("exits 0 on steady fresh state and sends required oRPC headers", async () => {
    const h = harness({});
    expect(await runPriceFreshnessTick(h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(
      `${ORIGIN}/api/orpc/openbb/checkPriceFreshness`
    );
    expect(h.calls[0]?.body).toEqual({ json: { dryRun: false } });
    expect(h.calls[0]?.headers).toEqual({
      "content-type": "application/json",
      origin: ORIGIN,
      "x-api-key": KEY,
    });
    expect(h.stdout.join("")).toContain(
      "price-freshness: expected=2026-11-20 stale=0/45 action=noop delivery=none"
    );
  });

  it("prints planned alert in --dry-run and never posts chat or acks", async () => {
    const h = harness({
      argv: ["--dry-run"],
      post: async (url, init) => {
        h.calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url,
        });
        return new Response(
          JSON.stringify({
            json: baseCheckReply({
              action: "alert",
              delivery: "dry-run",
              dryRun: true,
              ntfyConfigured: false,
              pendingChat: null,
              plannedAlert: {
                body: "SPY (3d, last 2026-11-17)",
                kind: "alert",
                title: "Vertex: 1 daily price/bar series stale (2026-11-20)",
              },
              stale: [
                {
                  id: "SPY",
                  lastDate: "2026-11-17",
                  sessionsBehind: 3,
                  table: "daily_series",
                },
              ],
            }),
          }),
          { status: 200 }
        );
      },
    });
    expect(await runPriceFreshnessTick(h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.stdout.join("")).toContain("price-freshness (dry-run):");
    expect(h.stdout.join("")).toContain("server ntfy is not configured");
    expect(h.stdout.join("")).toContain("planned alert:");
  });

  it("posts pendingChat to #omp-alerts and commits via recordPriceFreshnessChat", async () => {
    const h = harness({
      post: async (url, init) => {
        h.calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url,
        });
        if (url.endsWith("/checkPriceFreshness"))
          return new Response(
            JSON.stringify({
              json: baseCheckReply({
                action: "alert",
                delivery: "not-configured",
                ntfyConfigured: false,
                pendingChat: {
                  body: "SPY (3d, last 2026-11-17)",
                  eventId: "evt-1",
                  kind: "alert",
                  title: "Vertex: 1 daily price/bar series stale (2026-11-20)",
                },
              }),
            }),
            { status: 200 }
          );
        if (url === CHAT_URL)
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(
          JSON.stringify({
            json: { committed: true, delivery: "sent", eventId: "evt-1" },
          }),
          { status: 200 }
        );
      },
    });
    expect(await runPriceFreshnessTick(h.io)).toBe(0);
    expect(h.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/api/orpc/openbb/checkPriceFreshness`,
      CHAT_URL,
      `${ORIGIN}/api/orpc/openbb/recordPriceFreshnessChat`,
    ]);
    expect(h.calls[1]?.body).toEqual({
      channel: "omp-alerts",
      text: "**Vertex: 1 daily price/bar series stale (2026-11-20)**\nSPY (3d, last 2026-11-17)",
    });
    expect(h.calls[2]?.body).toEqual({
      json: { delivery: "sent", eventId: "evt-1" },
    });
    expect(h.stdout.join("")).toContain("posted alert to omp-alerts");
  });

  it("exits 1 and preserves not-configured when chat env is missing; records failed when server delivery was failed", async () => {
    // Case 1: delivery === "not-configured" -> do NOT overwrite with failed
    const h1 = harness({
      env: { VERTEX_AGENT_API_KEY: KEY, VERTEX_ORIGIN: ORIGIN },
      post: async (url, init) => {
        h1.calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url,
        });
        return new Response(
          JSON.stringify({
            json: baseCheckReply({
              action: "alert",
              delivery: "not-configured",
              ntfyConfigured: false,
              pendingChat: {
                body: "B",
                eventId: "evt-nc",
                kind: "alert",
                title: "T",
              },
            }),
          }),
          { status: 200 }
        );
      },
    });
    expect(await runPriceFreshnessTick(h1.io)).toBe(1);
    expect(h1.calls).toHaveLength(1);
    expect(h1.stderr.join("")).toContain("VERTEX_ALERT_POST_URL");

    // Case 2: delivery === "failed" -> record failed chat attempt
    const h2 = harness({
      env: { VERTEX_AGENT_API_KEY: KEY, VERTEX_ORIGIN: ORIGIN },
      post: async (url, init) => {
        h2.calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url,
        });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: true, delivery: "failed", eventId: "evt-f" },
            }),
            { status: 200 }
          );
        return new Response(
          JSON.stringify({
            json: baseCheckReply({
              action: "alert",
              delivery: "failed",
              ntfyConfigured: true,
              pendingChat: {
                body: "B",
                eventId: "evt-f",
                kind: "alert",
                title: "T",
              },
            }),
          }),
          { status: 200 }
        );
      },
    });
    expect(await runPriceFreshnessTick(h2.io)).toBe(1);
    expect(h2.calls).toHaveLength(2);
    expect(h2.calls[1]?.body).toEqual({
      json: { delivery: "failed", eventId: "evt-f" },
    });
  });

  it("handles chat network error, HTTP error, non-ok body, and ack failures with exit 1", async () => {
    const checkWithPending = () =>
      new Response(
        JSON.stringify({
          json: baseCheckReply({
            action: "recovery",
            delivery: "not-configured",
            ntfyConfigured: false,
            pendingChat: {
              body: "All fresh",
              eventId: "evt-r",
              kind: "recovery",
              title: "Fresh again",
            },
          }),
        }),
        { status: 200 }
      );

    // Network throw on chat POST
    const hNet = harness({
      post: async (url) => {
        if (url === CHAT_URL) throw new Error("ECONNREFUSED");
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: true, delivery: "failed", eventId: "evt-r" },
            }),
            { status: 200 }
          );
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(hNet.io)).toBe(1);
    expect(hNet.stderr.join("")).toContain("ECONNREFUSED");

    // Non-2xx on chat POST
    const h503 = harness({
      post: async (url) => {
        if (url === CHAT_URL) return new Response("down", { status: 503 });
        if (url.endsWith("/recordPriceFreshnessChat")) throw "ack-down";
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(h503.io)).toBe(1);
    expect(h503.stderr.join("")).toContain("HTTP 503");

    // 200 but chat reply is non-JSON (hits .catch(() => null))
    const hBadChatJson = harness({
      post: async (url) => {
        if (url === CHAT_URL) return new Response("not-json", { status: 200 });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: true, delivery: "failed", eventId: "evt-r" },
            }),
            { status: 200 }
          );
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(hBadChatJson.io)).toBe(1);
    expect(hBadChatJson.stderr.join("")).toContain('reply was not {"ok":true}');

    // 200 but reply not {"ok":true}
    const hBadOk = harness({
      post: async (url) => {
        if (url === CHAT_URL)
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
          });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: true, delivery: "failed", eventId: "evt-r" },
            }),
            { status: 200 }
          );
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(hBadOk.io)).toBe(1);
    expect(hBadOk.stderr.join("")).toContain('reply was not {"ok":true}');

    // Chat POST succeeded, ack HTTP failed
    const hAckErr = harness({
      post: async (url) => {
        if (url === CHAT_URL)
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response("err", { status: 500 });
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(hAckErr.io)).toBe(1);
    expect(hAckErr.stderr.join("")).toContain("could not record chat delivery");

    // Chat POST succeeded, ack returned committed: false (superseded)
    const hNotCommitted = harness({
      post: async (url) => {
        if (url === CHAT_URL)
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.endsWith("/recordPriceFreshnessChat"))
          return new Response(
            JSON.stringify({
              json: { committed: false, delivery: "sent", eventId: "evt-r" },
            }),
            { status: 200 }
          );
        return checkWithPending();
      },
    });
    expect(await runPriceFreshnessTick(hNotCommitted.io)).toBe(1);
    expect(hNotCommitted.stderr.join("")).toContain("was not committed");
  });

  it("exits 1 on missing env, API HTTP error, non-JSON, and bad schema shapes", async () => {
    const hNoEnv = harness({ env: {} });
    expect(await runPriceFreshnessTick(hNoEnv.io)).toBe(1);
    expect(hNoEnv.stderr.join("")).toContain(
      "VERTEX_AGENT_API_KEY is required"
    );

    const h403 = harness({
      post: async () => new Response("forbidden", { status: 403 }),
    });
    expect(await runPriceFreshnessTick(h403.io)).toBe(1);
    expect(h403.stderr.join("")).toContain("HTTP 403");

    const hNonJson = harness({
      post: async () => new Response("<html>oops", { status: 200 }),
    });
    expect(await runPriceFreshnessTick(hNonJson.io)).toBe(1);
    expect(hNonJson.stderr.join("")).toContain("non-JSON");

    const hBadEnv = harness({
      post: async () =>
        new Response(JSON.stringify("not-obj"), { status: 200 }),
    });
    expect(await runPriceFreshnessTick(hBadEnv.io)).toBe(1);
    expect(hBadEnv.stderr.join("")).toContain("unexpected shape");

    const hBadPayload = harness({
      post: async () =>
        new Response(JSON.stringify({ json: { action: "invalid" } }), {
          status: 200,
        }),
    });
    expect(await runPriceFreshnessTick(hBadPayload.io)).toBe(1);
    expect(hBadPayload.stderr.join("")).toContain("unexpected shape");
  });
});
