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

const BUDGET = {
  ibkrLimit: 6,
  ibkrRecent: 2,
  quantDataFree: 17,
  quantDataReserve: 6,
  runSeconds: 41,
};

describe("runFlowTick", () => {
  it("prints one budget line after the run lines", async () => {
    const harness = harnessFor(
      env,
      Response.json({ json: { ...RESULT, budget: BUDGET } })
    );
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    expect(harness.out.slice(-2)).toEqual([
      "ES depth ok items=1 events=0\n",
      "budget quantdata_free=17 reserve=6 ibkr=2/6 run=41s\n",
    ]);
  });

  it("prints unread for an IBKR window that was not read", async () => {
    const harness = harnessFor(
      env,
      Response.json({
        json: {
          ...RESULT,
          budget: { ...BUDGET, ibkrRecent: null, quantDataFree: null },
        },
      })
    );
    await runFlowTick(harness.io);
    expect(harness.out.at(-1)).toBe(
      "budget quantdata_free=unread reserve=6 ibkr=unread/6 run=41s\n"
    );
  });

  it("prints no budget line for an answer without a budget", async () => {
    const harness = harnessFor(env);
    await runFlowTick(harness.io);
    expect(harness.out.some((line) => line.startsWith("budget"))).toBe(false);
  });

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

  it("triggers connectivity.checkAlerts on unavailable runs and fails closed if an auth failure cannot be alerted", async () => {
    const authResult = {
      ...RESULT,
      runs: [
        {
          events: 0,
          items: 0,
          message:
            "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
          source: "options",
          status: "unavailable",
          symbol: "SPY",
        },
      ],
    };
    // 1. Server ntfy delivers -> alerts sent, exits 0 (deduplicated alert already reached owner)
    const deliveredHarness = harnessFor(env);
    deliveredHarness.post
      .mockResolvedValueOnce(Response.json({ json: authResult }))
      .mockResolvedValueOnce(
        Response.json({
          json: {
            action: "alert",
            activeAlertKeys: ["flow:SPY:options:auth_failed"],
            alertableIssues: [{}],
            delivery: "sent",
            dryRun: false,
            issues: [{}],
            needsOwnerAsk: true,
            newlyAlerted: [{}],
            ntfyConfigured: true,
            overallStatus: "auth_failed",
            pendingChat: null,
            plannedAlert: null,
          },
        })
      );
    await expect(runFlowTick(deliveredHarness.io)).resolves.toBe(0);
    expect(deliveredHarness.err[0]).toContain(
      "flow tick auth failure: SPY options"
    );
    expect(deliveredHarness.post).toHaveBeenCalledTimes(2);

    // 1b. Already-handled actions ("in-flight" and "prune-active" with active keys) exit 0
    for (const action of ["in-flight", "prune-active"] as const) {
      const handledHarness = harnessFor(env);
      handledHarness.post
        .mockResolvedValueOnce(Response.json({ json: authResult }))
        .mockResolvedValueOnce(
          Response.json({
            json: {
              action,
              activeAlertKeys: ["flow:SPY:options:auth_failed"],
              alertableIssues: [{}],
              delivery: null,
              dryRun: false,
              issues: [{}],
              needsOwnerAsk: true,
              newlyAlerted: [],
              ntfyConfigured: true,
              overallStatus: "auth_failed",
              pendingChat: null,
              plannedAlert: null,
            },
          })
        );
      await expect(runFlowTick(handledHarness.io)).resolves.toBe(0);
    }

    // 2. Alert check fails -> auth failure is NOT swallowed, exits 1
    const undeliveredHarness = harnessFor(env);
    undeliveredHarness.post
      .mockResolvedValueOnce(Response.json({ json: authResult }))
      .mockRejectedValueOnce(new Error("alert endpoint down"));
    await expect(runFlowTick(undeliveredHarness.io)).resolves.toBe(1);
    expect(undeliveredHarness.err.join("")).toContain(
      "flow tick alert check failed: connectivity.checkAlerts unreachable: alert endpoint down"
    );

    // 3. Non-Error rejection in alert check on non-auth unavailable run -> logs and exits 0
    const nonAuthResult = {
      ...RESULT,
      runs: [
        {
          events: 0,
          items: 0,
          message: "History endpoint returned HTTP 503",
          source: "ticks",
          status: "unavailable",
          symbol: "ES",
        },
      ],
    };
    const nonAuthHarness = harnessFor(env);
    nonAuthHarness.post
      .mockResolvedValueOnce(Response.json({ json: nonAuthResult }))
      .mockRejectedValueOnce("raw-err");
    await expect(runFlowTick(nonAuthHarness.io)).resolves.toBe(0);
    expect(nonAuthHarness.err.join("")).toContain(
      "flow tick alert check failed: connectivity.checkAlerts unreachable: raw-err"
    );
  });

  it("prints widened option-print symbols (QQQ, NQ, IWM, NVDA) cleanly", async () => {
    const harness = harnessFor(
      env,
      new Response(
        JSON.stringify({
          json: {
            at: "2026-11-23T15:01:00.000Z",
            budget: {
              ibkrLimit: 6,
              ibkrRecent: 0,
              quantDataFree: 40,
              quantDataReserve: 6,
              runSeconds: 4,
            },
            busy: false,
            pruned: 0,
            runs: [
              {
                events: 1,
                items: 12,
                message: "12 prints",
                source: "options",
                status: "ok",
                symbol: "QQQ",
              },
              {
                events: 0,
                items: 8,
                message: "8 prints",
                source: "options",
                status: "ok",
                symbol: "NQ",
              },
              {
                events: 0,
                items: 0,
                message: "staggered: IWM options runs on even minutes",
                source: "options",
                status: "skipped",
                symbol: "IWM",
              },
              {
                events: 2,
                items: 25,
                message: "25 prints",
                source: "options",
                status: "ok",
                symbol: "NVDA",
              },
            ],
          },
        }),
        { status: 200 }
      )
    );
    await expect(runFlowTick(harness.io)).resolves.toBe(0);
    expect(harness.out.join("")).toContain(
      "QQQ options ok items=12 events=1 12 prints"
    );
    expect(harness.out.join("")).toContain(
      "NQ options ok items=8 events=0 8 prints"
    );
    expect(harness.out.join("")).toContain(
      "NVDA options ok items=25 events=2 25 prints"
    );
  });
});
