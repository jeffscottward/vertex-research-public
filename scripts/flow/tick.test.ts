import { describe, expect, it, vi } from "vitest";

import { type FlowTickIo, runFlowTick } from "./tick.ts";

const RESULT = {
  at: "2026-11-09T15:00:00.000Z",
  busy: false,
  dryRun: false,
  pruned: 3,
  runs: [
    {
      events: 2,
      items: 4,
      message: "1000 prints, cache",
      source: "ticks",
      status: "ok",
      symbol: "SPY",
    },
    {
      events: 0,
      items: 1,
      message: null,
      source: "depth",
      status: "ok",
      symbol: "ES",
    },
    {
      events: 0,
      items: 0,
      message: "market closed",
      source: "options",
      status: "skipped",
      symbol: "ES",
    },
  ],
};

const harnessFor = (
  env: Record<string, string | undefined>,
  response: Response = Response.json({ json: RESULT }),
  argv: readonly string[] = []
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async (_url: string, _init: RequestInit) => response);
  const io: FlowTickIo = {
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

describe("runFlowTick", () => {
  it("posts flow.collect with the key and prints one line per run, hiding closed-market skips", async () => {
    const harness = harnessFor(env);
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    const [url, init] = harness.post.mock.calls[0] ?? [];
    expect(url).toBe("https://vertex.test/api/orpc/flow/collect");
    expect(init?.body).toBe(
      JSON.stringify({ json: { dryRun: false, seed: false } })
    );
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      origin: "https://vertex.test",
      "x-api-key": "test-key",
    });
    expect(harness.out).toEqual([
      "flow collect 2026-11-09T15:00:00.000Z: 3 run(s), pruned 3\n",
      "SPY ticks ok items=4 events=2 1000 prints, cache\n",
      "ES depth ok items=1 events=0\n",
    ]);
    expect(harness.err).toEqual([]);
  });

  it("sends dryRun and seed from --dry-run and --seed", async () => {
    const harness = harnessFor(env, undefined, ["--dry-run", "--seed"]);
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    expect(harness.post.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ json: { dryRun: true, seed: true } })
    );
  });

  it.each([
    [{}, [], "VERTEX_AGENT_API_KEY is required"],
    [
      { VERTEX_AGENT_API_KEY: " ", VERTEX_ORIGIN: "https://x.test" },
      [],
      "VERTEX_AGENT_API_KEY is required",
    ],
    [{ VERTEX_AGENT_API_KEY: "k" }, [], "VERTEX_ORIGIN is required"],
    [env, ["--now"], "unknown argument: --now"],
  ])("fails before posting on bad setup %#", async (setup, argv, message) => {
    const harness = harnessFor(setup, undefined, argv);
    await expect(runFlowTick(harness.io)).resolves.toBe(1);
    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.err).toEqual([`flow tick failed: ${message}\n`]);
  });

  it.each([
    [
      new Response("nope", { status: 401 }),
      "flow.collect returned HTTP 401: nope",
    ],
    [
      new Response("<html>", { status: 200 }),
      "flow.collect returned a body that is not JSON: <html>",
    ],
    [
      Response.json({ json: { at: "x", pruned: 0 } }),
      "flow.collect returned an unexpected shape: json.busy:",
    ],
  ])("reports a failed or malformed response %#", async (response, message) => {
    const harness = harnessFor(env, response);
    await expect(runFlowTick(harness.io)).resolves.toBe(1);
    expect(harness.err[0]).toContain(`flow tick failed: ${message}`);
  });

  it("reports a busy server without failing", async () => {
    const harness = harnessFor(
      env,
      Response.json({ json: { ...RESULT, busy: true, runs: [] } })
    );
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    expect(harness.out).toEqual([
      "flow collect 2026-11-09T15:00:00.000Z: another run is still active; skipped\n",
    ]);
  });

  it.each([
    ["socket closed", "flow.collect unreachable: socket closed"],
    [new Error("ECONNREFUSED"), "flow.collect unreachable: ECONNREFUSED"],
  ])(
    "skips without failing when the server is unreachable %#",
    async (failure, message) => {
      const harness = harnessFor(env);
      harness.post.mockRejectedValueOnce(failure);
      await expect(runFlowTick(harness.io)).resolves.toBe(0);
      expect(harness.err).toEqual([
        `flow tick skipped (retries next run): ${message}\n`,
      ]);
    }
  );

  it("skips without failing on a gateway error while the web app restarts", async () => {
    const harness = harnessFor(
      env,
      new Response("bad gateway", { status: 502 })
    );
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    expect(harness.err).toEqual([
      "flow tick skipped (retries next run): flow.collect returned HTTP 502: bad gateway\n",
    ]);
  });

  it("reports a non-Error failure", async () => {
    const harness = harnessFor(env, {
      ok: true,
      status: 200,
      text: () => Promise.reject("body lost"),
    } as unknown as Response);
    await expect(runFlowTick(harness.io)).resolves.toBe(1);
    expect(harness.err).toEqual(["flow tick failed: body lost\n"]);
  });
});
