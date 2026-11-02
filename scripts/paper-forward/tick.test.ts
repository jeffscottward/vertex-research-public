import { describe, expect, it, vi } from "vitest";

import { runPaperForwardTick, type TickIo } from "./tick.ts";

const harnessFor = (
  env: Record<string, string | undefined>,
  response: Response = Response.json({ json: { results: [] } })
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async (_url: string, _init: RequestInit) => response);
  const io: TickIo = {
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

describe("runPaperForwardTick", () => {
  it("posts one paperTick request with the key header and prints the result", async () => {
    const harness = harnessFor(env);
    await expect(runPaperForwardTick([], harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledWith(
      "https://vertex.test/api/orpc/backtestRuns/drift/paperTick",
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
    expect(harness.out).toEqual(['{"results":[]}\n']);
  });

  it("ticks one monitor when an id is given", async () => {
    const harness = harnessFor(env, new Response("{}"));
    await runPaperForwardTick(["monitor-1"], harness.io);
    expect(harness.post.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ json: { id: "monitor-1" } }),
    });
    expect(harness.out).toEqual(["null\n"]);
  });

  it("fails without configuration or on an error and never prints the key", async () => {
    const missing = harnessFor({ VERTEX_ORIGIN: "https://vertex.test" });
    await expect(runPaperForwardTick([], missing.io)).resolves.toBe(1);
    expect(missing.err.join("")).toContain("VERTEX_AGENT_API_KEY is required");
    const failed = harnessFor(env, new Response("nope", { status: 403 }));
    await expect(runPaperForwardTick([], failed.io)).resolves.toBe(1);
    expect(failed.err.join("")).toContain("HTTP 403: nope");
    expect(failed.err.join("")).not.toContain("test-key");
    const thrown = harnessFor(env);
    const offline: TickIo = {
      ...thrown.io,
      post: async () => Promise.reject("offline"),
    };
    await expect(runPaperForwardTick([], offline)).resolves.toBe(1);
    expect(thrown.err.join("")).toContain("offline");
  });
});
