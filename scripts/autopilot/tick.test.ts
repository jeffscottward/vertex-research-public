import { describe, expect, it, vi } from "vitest";

import { runAutopilotTick } from "./tick.ts";

const io = (
  env: Record<string, string | undefined>,
  response: Response = Response.json({ json: { results: [] } })
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async () => response);
  return {
    err,
    io: {
      env,
      post,
      stderr: { write: (text: string) => err.push(text) },
      stdout: { write: (text: string) => out.push(text) },
    },
    out,
    post,
  };
};

const env = {
  VERTEX_AGENT_API_KEY: "secret-key",
  VERTEX_ORIGIN: "http://vertex.localhost/x",
};

describe("autopilot tick client", () => {
  it("posts one tick request with the write key and prints the result", async () => {
    const run = io(env);
    expect(await runAutopilotTick([], run.io)).toBe(0);
    expect(run.post).toHaveBeenCalledWith(
      "http://vertex.localhost/api/orpc/autopilot/campaigns/tick",
      expect.objectContaining({
        body: JSON.stringify({ json: {} }),
        method: "POST",
      })
    );
    expect(run.out).toEqual(['{"results":[]}\n']);
    const one = io(env, new Response("{}"));
    expect(await runAutopilotTick(["camp-1"], one.io)).toBe(0);
    expect(one.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ json: { id: "camp-1" } }),
      })
    );
    expect(one.out).toEqual(["null\n"]);
  });

  it("fails without configuration or on an HTTP error and never prints the key", async () => {
    const missing = io({ VERTEX_ORIGIN: "http://vertex.localhost" });
    expect(await runAutopilotTick([], missing.io)).toBe(1);
    expect(missing.err.join("")).toContain("VERTEX_AGENT_API_KEY is required");
    const blank = io({ ...env, VERTEX_ORIGIN: " " });
    expect(await runAutopilotTick([], blank.io)).toBe(1);
    const denied = io(env, new Response("forbidden", { status: 403 }));
    expect(await runAutopilotTick([], denied.io)).toBe(1);
    expect(denied.err.join("")).toContain("HTTP 403: forbidden");
    expect(denied.err.join("")).not.toContain("secret-key");
    const thrown = io(env);
    thrown.post.mockRejectedValueOnce("offline");
    expect(await runAutopilotTick([], thrown.io)).toBe(1);
    expect(thrown.err.join("")).toContain("offline");
  });
});
