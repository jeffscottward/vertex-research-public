import { describe, expect, it } from "vitest";

import {
  CLAIM_POLL_MS,
  CLAIM_WAIT_MAX_MS,
  CONFIG_ERROR_EXIT,
  campaignTicks,
  DEFAULT_CAMPAIGN_TICKS,
  DRIVER_INSTANT_SET,
  type DriverIo,
  driverOrigin,
  driverSweepRequest,
  INSTANT_PHASE_MAX_MS,
  REUSE_MARGIN_MS,
  REUSE_WINDOW_MS,
  runEngineComparisonDriver,
} from "./driver.ts";

const ORIGIN = "https://vertex.example.test:3451";
const KEY = "vtx_secret_key_never_printed";
const NOW = Date.parse("2026-11-10T11:00:00Z");

type Reply = Readonly<{ status?: number; json?: unknown; raw?: string }>;
type Call = Readonly<{ path: string; input: Record<string, unknown> }>;
type Handler = (input: Record<string, unknown>, call: number) => Reply;

const harness = (
  handlers: Partial<Record<string, Handler>>,
  env: Record<string, string | undefined> = {}
) => {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const sleeps: number[] = [];
  const headers: Record<string, string>[] = [];
  const signals: unknown[] = [];
  let clock = NOW;
  let out = "";
  let err = "";
  const io: DriverIo = {
    env: {
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ORIGIN: `${ORIGIN}/ignored/path`,
      ...env,
    },
    now: () => clock,
    post: async (url, init) => {
      const path = url.slice(`${ORIGIN}/api/orpc/`.length);
      const input = (JSON.parse(String(init.body)) as { json: unknown })
        .json as Record<string, unknown>;
      headers.push(init.headers as Record<string, string>);
      signals.push(init.signal);
      calls.push({ input, path });
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      const handler = handlers[path];
      if (handler === undefined) throw new Error(`unexpected call ${path}`);
      const reply = handler(input, count);
      return new Response(reply.raw ?? JSON.stringify({ json: reply.json }), {
        status: reply.status ?? 200,
      });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    stderr: { write: (text) => (err += text) },
    stdout: { write: (text) => (out += text) },
  };
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    calls,
    headers,
    io,
    output: () => ({ err, out }),
    signals,
    sleeps,
  };
};

const instantQueued: Handler = (input) => ({
  json: {
    comparison: {
      groupId: `instant-${String(input["symbol"])}-${(input["rule"] as { kind: string }).kind}`,
      host: "QuantVPS web",
      wallMs: 3,
    },
  },
});
const listClaimed: Handler = () => ({
  json: { runs: [{ createdAt: "2026-11-10T10:59:00Z", status: "running" }] },
});
const sweepQueued: Handler = () => ({
  json: {
    comparison: {
      dropped: 0,
      groupId: "sweep-abc",
      host: "QuantVPS web",
      queued: 20,
      wallMs: 9,
    },
  },
});

describe("engine comparison driver", () => {
  it("queues every instant run one at a time, the sweep and the campaign ticks", async () => {
    let polls = 0;
    let ticks = 0;
    const h = harness(
      {
        "autopilot/campaigns/tick": () => {
          ticks += 1;
          return {
            json: {
              results: [
                {
                  campaignId: "camp-1",
                  ...(ticks === 1
                    ? { comparison: { dropped: 0, queued: 6 } }
                    : {}),
                  gated: 3,
                  generation: ticks,
                  status: ticks < 2 ? "running" : "completed",
                },
              ],
            },
          };
        },
        "backtestRuns/comparisons/list": () => {
          polls += 1;
          return polls === 1
            ? {
                json: {
                  runs: [
                    { createdAt: "2026-11-10T10:59:00Z", status: "queued" },
                  ],
                },
              }
            : listClaimed({}, 0);
        },
        "backtestRuns/sweep": sweepQueued,
        "instantBacktest/run": instantQueued,
      },
      {
        VERTEX_DRIVER_CAMPAIGN_ID: " camp-1 ",
        VERTEX_DRIVER_CAMPAIGN_TICKS: "3",
      }
    );
    expect(await runEngineComparisonDriver(h.io)).toBe(0);
    const { out, err } = h.output();
    expect(err).toBe("");
    expect(out).not.toContain(KEY);
    expect(out).toContain(
      "queued instant SPY 1d smaCross 20/100: instant-SPY-smaCross"
    );
    expect(out).toContain(
      "queued instant SPY 1d breakout 55/20/200: instant-SPY-breakout"
    );
    expect(out).toContain("queued sweep: sweep-abc (20 cells, 0 left out)");
    expect(out).toContain(
      "campaign tick 1: running, generation 1, gated 3, gate runs queued 6"
    );
    expect(out).toContain(
      "campaign tick 2: completed, generation 2, gated 3, gate runs queued 0"
    );
    expect(out).not.toContain("campaign tick 3");
    expect(out).toContain(
      `summary: ${DRIVER_INSTANT_SET.length} instant groups queued, 0 failures`
    );
    // The first group was still queued once: one poll wait, then each run waits for its claim.
    expect(h.sleeps).toEqual([CLAIM_POLL_MS]);
    const order = h.calls.map((call) => call.path);
    expect(order.slice(0, 3)).toEqual([
      "instantBacktest/run",
      "backtestRuns/comparisons/list",
      "backtestRuns/comparisons/list",
    ]);
    expect(
      h.calls.find((call) => call.path === "backtestRuns/sweep")?.input
    ).toEqual(driverSweepRequest(NOW));
    expect(
      h.calls.find((call) => call.path === "autopilot/campaigns/tick")?.input
    ).toEqual({ id: "camp-1" });
    expect(h.signals.every((signal) => signal instanceof AbortSignal)).toBe(
      true
    );
    for (const header of h.headers) {
      expect(header).toEqual({
        "content-type": "application/json",
        origin: ORIGIN,
        "x-api-key": KEY,
      });
    }
  });

  it("waits out the 24-hour reuse window once, or reports the group as reused", async () => {
    const createdAt = new Date(NOW - REUSE_WINDOW_MS + 60_000).toISOString();
    const runs: Record<string, number> = {};
    const h = harness({
      "backtestRuns/comparisons/list": (input) =>
        String(input["groupId"]).startsWith("old-")
          ? {
              json: {
                runs: [
                  { createdAt, status: "succeeded" },
                  {
                    createdAt: "2026-11-01T00:00:00Z",
                    status: "succeeded",
                  },
                ],
              },
            }
          : listClaimed({}, 0),
      "backtestRuns/sweep": () => ({
        json: {
          comparison: {
            groupId: "sweep-abc",
            host: "h",
            reused: true,
            wallMs: 1,
          },
        },
      }),
      "instantBacktest/run": (input) => {
        const symbol = String(input["symbol"]);
        const kind = (input["rule"] as { kind: string }).kind;
        const key = `${symbol}-${kind}`;
        runs[key] = (runs[key] ?? 0) + 1;
        // SPY smaCross: reused, then fresh after the wait. QQQ: reused twice. Others: queued.
        if (key === "SPY-smaCross" && runs[key] === 1)
          return {
            json: {
              comparison: {
                groupId: "old-spy",
                host: "h",
                reused: true,
                wallMs: 1,
              },
            },
          };
        if (key === "QQQ-smaCross")
          return {
            json: {
              comparison: {
                groupId: "old-qqq",
                host: "h",
                reused: true,
                wallMs: 1,
              },
            },
          };
        return instantQueued(input, 0);
      },
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(0);
    const { out } = h.output();
    expect(out).toContain(
      "queued instant SPY 1d smaCross 20/100: instant-SPY-smaCross"
    );
    expect(out).toContain(
      "reused instant QQQ 1d smaCross 20/100: old-qqq (queued <24 h ago)"
    );
    expect(out).toContain("reused sweep: sweep-abc (0 cells, 0 left out)");
    expect(out).toContain("campaign: none configured");
    expect(h.sleeps[0]).toBe(60_000 + REUSE_MARGIN_MS);
    expect(runs["QQQ-smaCross"]).toBe(2);
  });

  it("does not wait for a reuse window longer than the cap", async () => {
    const createdAt = new Date(NOW - 60_000).toISOString();
    const h = harness({
      "backtestRuns/comparisons/list": () => ({
        json: { runs: [{ createdAt, status: "succeeded" }] },
      }),
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": () => ({
        json: {
          comparison: { groupId: "old", host: "h", reused: true, wallMs: 1 },
        },
      }),
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(0);
    expect(h.sleeps).toEqual([]);
    expect(h.output().out).toContain(
      "summary: 0 instant groups queued, 0 failures"
    );
  });

  it("skips series without bars and reports every other instant failure", async () => {
    let call = 0;
    const replies: Reply[] = [
      {
        json: { code: "NOT_FOUND", message: "No stored bars for this series" },
        status: 404,
      },
      { raw: "boom", status: 500 },
      { json: {} },
      {
        json: {
          comparison: {
            error: "Nautilus comparison could not be queued",
            groupId: null,
            host: "h",
            wallMs: 1,
          },
        },
      },
      { json: { comparison: { groupId: null, host: "h", wallMs: 1 } } },
      {
        json: {
          comparison: { groupId: null, host: "h", reused: true, wallMs: 1 },
        },
      },
      { raw: "{bad json" },
      { raw: "Not Found", status: 404 },
    ];
    const h = harness({
      "backtestRuns/comparisons/list": listClaimed,
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": (input) => {
        call += 1;
        return replies[call - 1] ?? instantQueued(input, 0);
      },
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(1);
    const { out } = h.output();
    expect(out).toContain(
      "skipped instant SPY 1d smaCross 20/100: no stored bars"
    );
    expect(out).toContain(
      "FAIL instant QQQ 1d smaCross 20/100: instantBacktest/run returned HTTP 500: boom"
    );
    expect(out).toContain(
      "FAIL instant IWM 1d smaCross 20/100: no comparison (engine comparison off or read-only key)"
    );
    expect(out).toContain(
      "FAIL instant GLD 1d smaCross 20/100: Nautilus comparison could not be queued"
    );
    expect(out).toContain(
      "FAIL instant ES=F 1d smaCross 20/100: no comparison group"
    );
    expect(out).toContain(
      "FAIL instant NQ=F 1d smaCross 20/100: no comparison group"
    );
    expect(out).toContain("FAIL instant GC=F 1d smaCross 20/100: ");
    // A 404 without the stored-bars error (wrong path or origin) is a failure, not a skip.
    expect(out).toContain(
      "FAIL instant CL=F 1d smaCross 20/100: instantBacktest/run returned HTTP 404: Not Found"
    );
    expect(out).toContain("summary: 1 instant groups queued, 7 failures");
  });

  it("stops the instant runs once when the key may not call instantBacktest.run", async () => {
    const h = harness({
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": () => ({
        json: { code: "FORBIDDEN", message: "API keys may call only ..." },
        status: 403,
      }),
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(1);
    const { out } = h.output();
    expect(out.match(/^FAIL instant/gmu)).toHaveLength(1);
    expect(out).toContain(
      "the key may not call instantBacktest.run, stopping instant runs"
    );
    expect(out).toContain("not requested instant SPY 1d breakout 55/20/200");
    expect(
      h.calls.filter((c) => c.path === "instantBacktest/run")
    ).toHaveLength(1);
    expect(out).toContain("summary: 0 instant groups queued, 1 failures");
  });

  it("fails a run that a newer request of the same user superseded", async () => {
    let polls = 0;
    const h = harness({
      "backtestRuns/comparisons/list": () => {
        polls += 1;
        return polls === 1
          ? {
              json: {
                runs: [
                  {
                    createdAt: "2026-11-10T10:59:00Z",
                    error: "Superseded by a newer request",
                    status: "failed",
                  },
                ],
              },
            }
          : listClaimed({}, 0);
      },
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": instantQueued,
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(1);
    const { out } = h.output();
    expect(out).toContain(
      "FAIL instant SPY 1d smaCross 20/100: superseded by a newer instant request of the same user"
    );
    expect(out).toContain(
      `summary: ${DRIVER_INSTANT_SET.length} instant groups queued, 1 failures`
    );
  });

  it("stops asking once the instant phase budget is used up", async () => {
    let calls = 0;
    const h = harness({
      "backtestRuns/comparisons/list": () => ({
        json: {
          runs: [
            {
              createdAt: "2026-11-10T10:59:00Z",
              error: null,
              status: "failed",
            },
          ],
        },
      }),
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": (input) => {
        calls += 1;
        // The second request hangs past the phase budget.
        if (calls === 2) h.advance(INSTANT_PHASE_MAX_MS);
        return instantQueued(input, 0);
      },
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(1);
    const { out } = h.output();
    expect(calls).toBe(2);
    expect(out).toContain(
      `FAIL instant IWM 1d smaCross 20/100: not requested (instant phase over ${INSTANT_PHASE_MAX_MS / 60_000} min)`
    );
    expect(out.match(/not requested \(instant phase over/gmu)).toHaveLength(
      DRIVER_INSTANT_SET.length - 2
    );
  });

  it("stops the instant runs when the research worker claims nothing", async () => {
    const h = harness({
      "backtestRuns/comparisons/list": () => ({
        json: {
          runs: [{ createdAt: "2026-11-10T10:59:00Z", status: "queued" }],
        },
      }),
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": instantQueued,
    });
    expect(await runEngineComparisonDriver(h.io)).toBe(1);
    const { out } = h.output();
    expect(out).toContain(
      "FAIL instant SPY 1d smaCross 20/100: still queued at the wait limit (research worker down or slow?); stopping instant runs"
    );
    expect(
      h.calls.filter((call) => call.path === "instantBacktest/run")
    ).toHaveLength(1);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      CLAIM_WAIT_MAX_MS
    );
    expect(out).toContain("queued sweep: sweep-abc");
  });

  it("reports sweep failures", async () => {
    for (const [reply, line] of [
      [
        { json: {} },
        "FAIL sweep: no comparison (engine comparison off or read-only key)",
      ],
      [
        {
          json: {
            comparison: {
              error: "queue down",
              groupId: null,
              host: "h",
              wallMs: 1,
            },
          },
        },
        "FAIL sweep: queue down",
      ],
      [
        { raw: "bad", status: 503 },
        "FAIL sweep: backtestRuns/sweep returned HTTP 503: bad",
      ],
      [{ raw: "{not json" }, "FAIL sweep: "],
      [
        { json: { comparison: { groupId: null, host: "h", wallMs: 1 } } },
        "FAIL sweep: no comparison group",
      ],
    ] as const) {
      const h = harness({
        "backtestRuns/comparisons/list": listClaimed,
        "backtestRuns/sweep": () => reply,
        "instantBacktest/run": instantQueued,
      });
      expect(await runEngineComparisonDriver(h.io)).toBe(1);
      expect(h.output().out).toContain(line);
    }
  });

  it("reports campaign tick failures", async () => {
    const base = {
      "backtestRuns/comparisons/list": listClaimed,
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": instantQueued,
    };
    const empty = harness(
      {
        ...base,
        "autopilot/campaigns/tick": () => ({ json: { results: [] } }),
      },
      { VERTEX_DRIVER_CAMPAIGN_ID: "camp-1" }
    );
    expect(await runEngineComparisonDriver(empty.io)).toBe(1);
    expect(empty.output().out).toContain(
      "FAIL campaign camp-1: nothing ticked"
    );

    const gateError = harness(
      {
        ...base,
        "autopilot/campaigns/tick": () => ({
          json: {
            results: [
              {
                comparison: { dropped: 0, error: "queue down", queued: 0 },
                gated: 1,
                generation: 1,
                status: "running",
              },
            ],
          },
        }),
      },
      { VERTEX_DRIVER_CAMPAIGN_ID: "camp-1" }
    );
    expect(await runEngineComparisonDriver(gateError.io)).toBe(1);
    const lines = gateError.output().out.split("\n");
    expect(
      lines.filter((line) => line.startsWith("FAIL campaign tick"))
    ).toHaveLength(DEFAULT_CAMPAIGN_TICKS);

    const thrown = harness(
      {
        ...base,
        "autopilot/campaigns/tick": () => ({ raw: "forbidden", status: 403 }),
      },
      { VERTEX_DRIVER_CAMPAIGN_ID: "camp-1", VERTEX_DRIVER_CAMPAIGN_TICKS: "" }
    );
    expect(await runEngineComparisonDriver(thrown.io)).toBe(1);
    expect(thrown.output().out).toContain(
      "FAIL campaign tick 1: autopilot/campaigns/tick returned HTTP 403: forbidden"
    );
    expect(
      thrown.calls.filter((call) => call.path === "autopilot/campaigns/tick")
    ).toHaveLength(1);

    const stopped = harness(
      {
        ...base,
        "autopilot/campaigns/tick": () => ({
          json: { code: "CONFLICT", message: "Campaign is not running" },
          status: 409,
        }),
      },
      { VERTEX_DRIVER_CAMPAIGN_ID: "camp-1" }
    );
    expect(await runEngineComparisonDriver(stopped.io)).toBe(1);
    expect(stopped.output().out).toContain(
      "FAIL campaign camp-1: not running (stopped, completed or failed)"
    );

    const none = harness(base, {
      VERTEX_DRIVER_CAMPAIGN_ID: "camp-1",
      VERTEX_DRIVER_CAMPAIGN_TICKS: "0",
    });
    expect(await runEngineComparisonDriver(none.io)).toBe(0);
  });

  it("reports a non-Error rejection", async () => {
    const h = harness({
      "backtestRuns/comparisons/list": listClaimed,
      "backtestRuns/sweep": sweepQueued,
      "instantBacktest/run": instantQueued,
    });
    const io: DriverIo = {
      ...h.io,
      post: (url, init) =>
        url.endsWith("backtestRuns/sweep")
          ? Promise.reject("socket closed")
          : h.io.post(url, init),
    };
    expect(await runEngineComparisonDriver(io)).toBe(1);
    expect(h.output().out).toContain("FAIL sweep: socket closed");
  });

  it("refuses a missing or plain-http origin, a missing key or a bad tick count", async () => {
    for (const [env, message] of [
      [{ VERTEX_ORIGIN: " " }, "VERTEX_ORIGIN is required"],
      [
        { VERTEX_ORIGIN: "http://vertex.example.test:3451" },
        "VERTEX_ORIGIN must be an https:// origin",
      ],
      [{ VERTEX_AGENT_API_KEY: undefined }, "VERTEX_AGENT_API_KEY is required"],
      [
        { VERTEX_DRIVER_CAMPAIGN_TICKS: "21" },
        "VERTEX_DRIVER_CAMPAIGN_TICKS must be",
      ],
    ] as const) {
      const h = harness({}, env);
      expect(await runEngineComparisonDriver(h.io)).toBe(CONFIG_ERROR_EXIT);
      expect(h.output().err).toContain(message);
      expect(h.calls).toEqual([]);
    }
  });
});

describe("driver settings", () => {
  it("keeps only the origin of an https portal URL", () => {
    expect(driverOrigin("https://v.example.test:3451/a/b?c")).toBe(
      "https://v.example.test:3451"
    );
    expect(() => driverOrigin("http://v.example.test")).toThrow("https://");
  });

  it("reads the campaign tick count", () => {
    expect(campaignTicks(undefined)).toBe(DEFAULT_CAMPAIGN_TICKS);
    expect(campaignTicks(" ")).toBe(DEFAULT_CAMPAIGN_TICKS);
    expect(campaignTicks("5")).toBe(5);
    expect(() => campaignTicks("1.5")).toThrow();
    expect(() => campaignTicks("-1")).toThrow();
  });

  it("ends the sweep yesterday (UTC) so each day is a new comparison group", () => {
    expect(driverSweepRequest(NOW).to).toBe("2026-11-09");
    expect(driverSweepRequest(NOW + 86_400_000).to).toBe("2026-11-10");
  });

  it("keeps the fixed set research-only: long-only rules on daily bars", () => {
    expect(DRIVER_INSTANT_SET).toHaveLength(9);
    for (const request of DRIVER_INSTANT_SET) {
      expect(request.timeframe).toBe("1d");
      expect(Object.keys(request).sort()).toEqual([
        "costBps",
        "rule",
        "stopLossPct",
        "symbol",
        "takeProfitPct",
        "timeframe",
      ]);
    }
  });
});
