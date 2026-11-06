import { describe, expect, it, vi } from "vitest";

import { type PriceAlertTickIo, runPriceAlertTick } from "./tick.ts";

const harnessFor = (
  env: Record<string, string | undefined>,
  response: Response = Response.json({ json: { checked: 0 } })
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async (_url: string, _init: RequestInit) => response);
  const io: PriceAlertTickIo = {
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

describe("runPriceAlertTick", () => {
  it("posts one priceAlerts.tick request with the key header and prints the result", async () => {
    const harness = harnessFor(env);
    await expect(runPriceAlertTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledWith(
      "https://vertex.test/api/orpc/priceAlerts/tick",
      {
        body: JSON.stringify({ json: {} }),
        headers: {
          "content-type": "application/json",
          origin: "https://vertex.test",
          "x-api-key": "test-key",
        },
        method: "POST",
      }
    );
    expect(harness.out).toEqual(['{"checked":0}\n']);
  });

  it("calls priceAlerts.signals.tick for signal alerts and watches", async () => {
    const harness = harnessFor(env, new Response("denied", { status: 403 }));
    await expect(
      runPriceAlertTick({
        ...harness.io,
        procedure: "priceAlerts/signals/tick",
      })
    ).resolves.toBe(1);
    expect(harness.post.mock.calls[0]?.[0]).toBe(
      "https://vertex.test/api/orpc/priceAlerts/signals/tick"
    );
    expect(harness.err.join("")).toContain(
      "priceAlerts.signals.tick returned HTTP 403"
    );
  });

  it("prints null for an empty body", async () => {
    const harness = harnessFor(env, new Response("{}"));
    await runPriceAlertTick(harness.io);
    expect(harness.out).toEqual(["null\n"]);
  });

  it("fails without configuration or on an error and never prints the key", async () => {
    const missing = harnessFor({ VERTEX_ORIGIN: "https://vertex.test" });
    await expect(runPriceAlertTick(missing.io)).resolves.toBe(1);
    expect(missing.err.join("")).toContain("VERTEX_AGENT_API_KEY is required");
    const blank = harnessFor({ VERTEX_AGENT_API_KEY: "k", VERTEX_ORIGIN: " " });
    await expect(runPriceAlertTick(blank.io)).resolves.toBe(1);
    expect(blank.err.join("")).toContain("VERTEX_ORIGIN is required");
    const failed = harnessFor(env, new Response("nope", { status: 403 }));
    await expect(runPriceAlertTick(failed.io)).resolves.toBe(1);
    expect(failed.err.join("")).toContain("HTTP 403: nope");
    expect(failed.err.join("")).not.toContain("test-key");
    const thrown = harnessFor(env);
    const offline: PriceAlertTickIo = {
      ...thrown.io,
      post: async () => Promise.reject("offline"),
    };
    await expect(runPriceAlertTick(offline)).resolves.toBe(1);
    expect(thrown.err.join("")).toContain("offline");
  });
});
