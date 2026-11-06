import { describe, expect, it, vi } from "vitest";

import { BACKTEST_RUN_NAUTILUS_ENGINE } from "../../packages/api/src/contracts/backtest-runs.ts";
import {
  AGENT_KEY_LIMIT,
  AGENT_KEY_WINDOW_MS,
  API_STALE_MS,
  COMPLETE_ATTEMPTS,
  COMPLETE_RETRY_MS,
  type CommandOutcome,
  DEFAULT_IDLE_MAX_MS,
  DEFAULT_IDLE_MS,
  DELIVERY_MARGIN_MS,
  engineRequest,
  NAUTILUS_RUN_TIMEOUT_MS,
  type NautilusWorkerIo,
  QUIET_PAUSE_MS,
  REJECTED_ERROR,
  REQUEST_BUDGET,
  readEngineOutput,
  retryAfterMs,
  runCommand,
  runNautilusWorker,
  sleep,
  stopSignal,
  UNDELIVERED_ERROR,
} from "./nautilus-worker.ts";

const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
const env = {
  VERTEX_AGENT_API_KEY: "secret-key",
  VERTEX_NAUTILUS_PYTHON: "/venv/bin/python",
  VERTEX_ORIGIN: "https://vertex.example.test/portal",
};

const claimedRun = {
  bars: {
    c: [10, 11, 12],
    h: [11, 12, 13],
    l: [9, 10, 11],
    o: [10, 10, 11],
    t: [0, 86_400_000, 172_800_000],
    v: [null, 5, 6],
  },
  costs: null,
  id: "run-1",
  sectorQuadrants: null,
  seriesSha256: "b".repeat(64),
  spec: {
    costBps: 5,
    from: "1970-01-01",
    initialCapital: 10_000,
    rule: { fast: 1, kind: "smaCross" as const, slow: 2 },
    stopLossPct: 0,
    symbol: "SPY",
    takeProfitPct: 0,
    timeframe: "1d" as const,
    to: "1970-01-03",
  },
};

const engineResult = {
  capital: 1_000_000,
  engine,
  equity: [1, 1, 1.1],
  modelVersion: 1,
  stats: { bars: 3, trades: 0 },
  trades: [],
};

const outcome = (overrides: Partial<CommandOutcome> = {}): CommandOutcome => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify(engineResult),
  stopped: false,
  timedOut: false,
  ...overrides,
});

type Call = Readonly<{ path: string; input: unknown; init: RequestInit }>;

const ALERT_URL = "http://127.0.0.1:8790/post";
const alertEnv = {
  ...env,
  VERTEX_ALERT_CHANNEL: "vertex-ops",
  VERTEX_ALERT_POST_URL: ALERT_URL,
};
const unavailable = () => new Response("unavailable", { status: 503 });

/** Fake Vertex API: queued claim responses, then no run; complete and fail answer per test. */
const harness = (
  options: Readonly<{
    claims?: unknown[];
    complete?: () => Response;
    fail?: () => Response;
    commands?: CommandOutcome[];
    env?: Record<string, string | undefined>;
    controller?: AbortController;
    /** Answers by claim number (1-based) that replace the normal claim answer. */
    claimAnswers?: Readonly<Record<number, () => Response>>;
    alert?: () => Response;
  }> = {}
) => {
  const claims = [...(options.claims ?? [])];
  const alerts: unknown[] = [];
  let claimCount = 0;
  const commands = [...(options.commands ?? [])];
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const controller = options.controller ?? new AbortController();
  const post = vi.fn(async (url: string, init: RequestInit) => {
    if (url === ALERT_URL) {
      alerts.push(JSON.parse(String(init.body)));
      return options.alert?.() ?? Response.json({ ok: true });
    }
    const path = new URL(url).pathname.replace("/api/orpc/", "");
    const input = (JSON.parse(String(init.body)) as { json: unknown }).json;
    calls.push({ init, input, path });
    if (path === "backtestRuns/engine/claim") {
      claimCount += 1;
      const answer = options.claimAnswers?.[claimCount];
      if (answer !== undefined) return answer();
      return Response.json({ json: { run: claims.shift() ?? null } });
    }
    if (path === "backtestRuns/engine/complete")
      return (
        options.complete?.() ??
        Response.json({ json: { id: "run-1", status: "succeeded" } })
      );
    return (
      options.fail?.() ??
      Response.json({ json: { id: "run-1", status: "failed" } })
    );
  });
  const runCommandFake = vi.fn(async () => commands.shift() ?? outcome());
  const sleepFake = vi.fn(
    async (_ms: number, _signal: AbortSignal): Promise<void> => undefined
  );
  const io: NautilusWorkerIo = {
    env: options.env ?? env,
    post,
    researchDir: "/repo/services/research",
    runCommand: runCommandFake,
    signal: controller.signal,
    sleep: sleepFake,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return {
    alerts,
    calls,
    claimCount: () => claimCount,
    controller,
    err,
    io,
    out,
    paths: () => calls.map((call) => call.path),
    post,
    runCommand: runCommandFake,
    sleep: sleepFake,
  };
};

describe("nautilus worker configuration", () => {
  it("refuses missing settings, a bad idle time and unknown arguments, and never prints the key", async () => {
    for (const [overrides, message] of [
      [{ VERTEX_AGENT_API_KEY: " " }, "VERTEX_AGENT_API_KEY is required"],
      [{ VERTEX_ORIGIN: undefined }, "VERTEX_ORIGIN is required"],
      [{ VERTEX_NAUTILUS_PYTHON: "" }, "VERTEX_NAUTILUS_PYTHON is required"],
      [{ VERTEX_WORKER_IDLE_MS: "0" }, "VERTEX_WORKER_IDLE_MS must be"],
      [{ VERTEX_WORKER_IDLE_MS: "1.5" }, "VERTEX_WORKER_IDLE_MS must be"],
    ] as const) {
      const run = harness({ env: { ...env, ...overrides } });
      expect(await runNautilusWorker(["--once"], run.io)).toBe(1);
      expect(run.err.join("")).toContain(message);
      expect(run.post).not.toHaveBeenCalled();
    }
    const unknown = harness();
    expect(await runNautilusWorker(["--loop"], unknown.io)).toBe(1);
    expect(unknown.err.join("")).toContain("Unknown argument --loop");
    expect(unknown.err.join("")).not.toContain("secret-key");
  });
});

describe("nautilus worker cycle", () => {
  it("claims with the write key and does nothing when no run is queued", async () => {
    const run = harness();
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.post).toHaveBeenCalledWith(
      "https://vertex.example.test/api/orpc/backtestRuns/engine/claim",
      expect.objectContaining({
        body: JSON.stringify({ json: { engine } }),
        headers: {
          "content-type": "application/json",
          origin: "https://vertex.example.test",
          "x-api-key": "secret-key",
        },
        method: "POST",
      })
    );
    expect(run.runCommand).not.toHaveBeenCalled();
    expect(run.sleep).not.toHaveBeenCalled();
    expect(run.out).toEqual([]);
  });

  it("runs the engine on a claimed run and posts the result", async () => {
    const run = harness({ claims: [claimedRun] });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.runCommand).toHaveBeenCalledWith(
      "/venv/bin/python",
      ["-m", "nautilus_backtest", "run", "-"],
      {
        cwd: "/repo/services/research",
        input: engineRequest(claimedRun),
        signal: run.io.signal,
        timeoutMs: NAUTILUS_RUN_TIMEOUT_MS,
      }
    );
    expect(run.paths()).toEqual([
      "backtestRuns/engine/claim",
      "backtestRuns/engine/complete",
    ]);
    expect(run.calls[1]?.input).toEqual({
      engine,
      id: "run-1",
      result: {
        equity: engineResult.equity,
        stats: engineResult.stats,
        trades: [],
      },
      seriesSha256: "b".repeat(64),
    });
    expect(run.out).toEqual(["run run-1: succeeded\n"]);
  });

  it("builds the engine request with the costs and only present sector points", () => {
    expect(JSON.parse(engineRequest(claimedRun))).toEqual({
      bars: claimedRun.bars,
      spec: { ...claimedRun.spec, costs: null },
    });
    const points = {
      "XLK:weekly": [{ date: "1970-01-02", quadrant: "leading" }],
    };
    const costs = { capital: 10_000, profile: { id: "p" } };
    expect(
      JSON.parse(
        engineRequest({
          ...claimedRun,
          costs: costs as never,
          sectorQuadrants: points as never,
        })
      ).spec
    ).toMatchObject({ costs, sectorQuadrants: points });
  });

  it("fails the run with the engine error and logs the engine stderr", async () => {
    const run = harness({
      claims: [claimedRun, claimedRun],
      commands: [
        outcome({ code: 2, stdout: '{"error":"At least 2 bars needed"}' }),
        outcome({
          code: 3,
          stderr: "No module named nautilus_trader",
          stdout: "",
        }),
      ],
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    const fails = run.calls.filter((call) => call.path.endsWith("/fail"));
    expect(fails.map((call) => call.input)).toEqual([
      { engine, error: "At least 2 bars needed", id: "run-1" },
      {
        engine,
        error: "Nautilus is not installed on the research worker",
        id: "run-1",
      },
    ]);
    expect(run.err).toEqual([
      "run run-1: engine stderr: No module named nautilus_trader\n",
    ]);
    expect(run.out).toEqual([
      "run run-1: failed: At least 2 bars needed\n",
      "run run-1: failed: Nautilus is not installed on the research worker\n",
    ]);
  });

  it("fails the run when the API rejects the result, and ignores a refused fail", async () => {
    const rejected = harness({
      claims: [claimedRun],
      complete: () =>
        Response.json({ json: { code: "BAD_REQUEST" } }, { status: 400 }),
    });
    expect(await runNautilusWorker(["--once"], rejected.io)).toBe(0);
    expect(rejected.calls[2]?.input).toEqual({
      engine,
      error: REJECTED_ERROR,
      id: "run-1",
    });
    expect(rejected.err.join("")).toContain(
      "run run-1: backtestRuns/engine/complete returned HTTP 400"
    );
    expect(rejected.sleep).not.toHaveBeenCalled();
    const refused = harness({
      claims: [claimedRun],
      complete: () => new Response("bad", { status: 400 }),
      fail: () => new Response("conflict", { status: 409 }),
    });
    expect(await runNautilusWorker(["--once"], refused.io)).toBe(0);
    expect(refused.err.join("")).toContain(
      "backtestRuns/engine/fail returned HTTP 409: conflict"
    );
  });

  it("does not fail a run that is no longer running (409)", async () => {
    const run = harness({
      claims: [claimedRun],
      complete: () => new Response("conflict", { status: 409 }),
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.paths()).toEqual([
      "backtestRuns/engine/claim",
      "backtestRuns/engine/complete",
    ]);
    expect(run.out).toEqual([]);
  });

  it("tries complete again after network errors, 429 and 5xx answers", async () => {
    const answers = [
      () => new Response("unavailable", { status: 503 }),
      () => new Response("slow down", { status: 429 }),
      () => {
        throw new Error("socket hang up");
      },
    ];
    const flaky = harness({
      claims: [claimedRun],
      complete: () =>
        (answers.shift() ?? (() => Response.json({ json: {} })))(),
    });
    expect(await runNautilusWorker(["--once"], flaky.io)).toBe(0);
    expect(
      flaky.paths().filter((path) => path.endsWith("/complete"))
    ).toHaveLength(4);
    expect(flaky.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      COMPLETE_RETRY_MS,
      // The 429 waits for the agent key limiter instead of the short retry wait.
      QUIET_PAUSE_MS,
      4 * COMPLETE_RETRY_MS,
    ]);
    expect(flaky.out).toEqual(["run run-1: succeeded\n"]);

    const down = harness({
      claims: [claimedRun],
      complete: () => new Response("bad gateway", { status: 502 }),
    });
    expect(await runNautilusWorker(["--once"], down.io)).toBe(0);
    expect(
      down.paths().filter((path) => path.endsWith("/complete"))
    ).toHaveLength(COMPLETE_ATTEMPTS);
    expect(down.calls.at(-1)?.input).toEqual({
      engine,
      error: UNDELIVERED_ERROR,
      id: "run-1",
    });
  });

  it("waits for the limiter at most once per delivery and never past the stale limit", async () => {
    const limited = () => new Response("slow down", { status: 429 });
    const twice = harness({ claims: [claimedRun], complete: limited });
    expect(await runNautilusWorker(["--once"], twice.io)).toBe(0);
    expect(
      twice.paths().filter((path) => path.endsWith("/complete"))
    ).toHaveLength(2);
    expect(twice.sleep.mock.calls.map(([ms]) => ms)).toEqual([QUIET_PAUSE_MS]);
    expect(twice.calls.at(-1)?.input).toEqual({
      engine,
      error: UNDELIVERED_ERROR,
      id: "run-1",
    });
    // A run claimed long ago waits only for the time left (and not at all once it is past).
    const now = vi.spyOn(Date, "now");
    const claimedAt = 1_000_000;
    for (const [elapsed, wait] of [
      [API_STALE_MS - DELIVERY_MARGIN_MS - 20_000, 20_000],
      [API_STALE_MS, 0],
    ] as const) {
      now.mockReturnValueOnce(claimedAt).mockReturnValue(claimedAt + elapsed);
      let answers = 0;
      const late = harness({
        claims: [claimedRun],
        complete: () => {
          answers += 1;
          return answers === 1 ? limited() : Response.json({ json: {} });
        },
      });
      expect(await runNautilusWorker(["--once"], late.io)).toBe(0);
      expect(late.sleep.mock.calls.map(([ms]) => ms)).toEqual([wait]);
      expect(late.out).toEqual(["run run-1: succeeded\n"]);
    }
    now.mockRestore();
  });

  it("reports API failures with exit 1 in --once mode, never with the key", async () => {
    const down = harness();
    down.post.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await runNautilusWorker(["--once"], down.io)).toBe(1);
    expect(down.err.join("")).toContain("connect ECONNREFUSED");
    const failRefused = harness({
      claims: [claimedRun],
      commands: [outcome({ code: 1, stdout: "" })],
      fail: () => new Response("denied", { status: 403 }),
    });
    expect(await runNautilusWorker(["--once"], failRefused.io)).toBe(1);
    expect(failRefused.err.join("")).toContain(
      "backtestRuns/engine/fail returned HTTP 403: denied"
    );
    const noBody = harness();
    noBody.post.mockResolvedValueOnce(Response.json({}));
    expect(await runNautilusWorker(["--once"], noBody.io)).toBe(1);
    const thrown = harness();
    thrown.post.mockRejectedValueOnce("offline");
    expect(await runNautilusWorker(["--once"], thrown.io)).toBe(1);
    expect(thrown.err.join("")).toContain("offline");
    for (const run of [down, failRefused, noBody, thrown])
      expect(run.err.join("")).not.toContain("secret-key");
  });
});

describe("nautilus worker loop", () => {
  it("claims again at once after a run, sleeps when idle and stops on abort", async () => {
    const run = harness({
      claims: [claimedRun],
      env: { ...env, VERTEX_WORKER_IDLE_MS: "250" },
    });
    let sleeps = 0;
    run.sleep.mockImplementation(async () => {
      sleeps += 1;
      if (sleeps === 2) run.controller.abort();
    });
    run.post.mockImplementationOnce(async () => {
      throw new Error("API restarting");
    });
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(run.paths()).toEqual([
      "backtestRuns/engine/claim",
      "backtestRuns/engine/complete",
      "backtestRuns/engine/claim",
    ]);
    expect(run.sleep).toHaveBeenCalledTimes(2);
    expect(run.sleep).toHaveBeenCalledWith(250, run.io.signal);
    expect(run.err.join("")).toContain("API restarting");
  });

  it("doubles the idle wait after each empty claim up to the cap and resets it after work", async () => {
    const run = harness({
      claimAnswers: { 7: () => Response.json({ json: { run: claimedRun } }) },
      env: {
        ...env,
        VERTEX_WORKER_IDLE_MAX_MS: "20000",
        VERTEX_WORKER_IDLE_MS: "3000",
      },
    });
    run.sleep.mockImplementation(async () => {
      if (run.claimCount() >= 9) run.controller.abort();
    });
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(run.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      3000, 6000, 12_000, 20_000, 20_000, 20_000, 3000, 6000,
    ]);
  });

  it("uses a 45 s cap by default, and the floor when the floor is higher", async () => {
    const run = harness();
    run.sleep.mockImplementation(async () => {
      if (run.claimCount() >= 7) run.controller.abort();
    });
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(run.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      3000, 6000, 12_000, 24_000, 45_000, 45_000, 45_000,
    ]);
    const slow = harness({ env: { ...env, VERTEX_WORKER_IDLE_MS: "50000" } });
    slow.sleep.mockImplementation(async () => {
      if (slow.claimCount() >= 2) slow.controller.abort();
    });
    expect(await runNautilusWorker([], slow.io)).toBe(0);
    expect(slow.sleep.mock.calls.map(([ms]) => ms)).toEqual([50_000, 50_000]);
  });

  it("refuses a cap below the floor", async () => {
    const run = harness({
      env: {
        ...env,
        VERTEX_WORKER_IDLE_MAX_MS: "1000",
        VERTEX_WORKER_IDLE_MS: "3000",
      },
    });
    expect(await runNautilusWorker([], run.io)).toBe(1);
    expect(run.err.join("")).toContain(
      "VERTEX_WORKER_IDLE_MAX_MS must not be below VERTEX_WORKER_IDLE_MS"
    );
    const bad = harness({ env: { ...env, VERTEX_WORKER_IDLE_MAX_MS: "-5" } });
    expect(await runNautilusWorker([], bad.io)).toBe(1);
    expect(bad.err.join("")).toContain(
      "VERTEX_WORKER_IDLE_MAX_MS must be a positive whole number"
    );
  });

  it("waits for the limiter after a 429 claim: Retry-After when longer, else the quiet pause", async () => {
    const limited = (retryAfter?: string) => () =>
      new Response("Agent API key rate limit exceeded", {
        status: 429,
        ...(retryAfter === undefined
          ? {}
          : { headers: { "retry-after": retryAfter } }),
      });
    const run = harness({
      claimAnswers: { 1: limited(), 2: limited("600"), 3: limited("5") },
    });
    run.sleep.mockImplementation(async () => {
      if (run.claimCount() >= 4) run.controller.abort();
    });
    expect(await runNautilusWorker([], run.io)).toBe(0);
    // After a 429 pause the idle wait starts again at the floor.
    expect(run.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      QUIET_PAUSE_MS,
      600_000,
      QUIET_PAUSE_MS,
      DEFAULT_IDLE_MS,
    ]);
    expect(run.err.join("")).toContain(
      "agent key rate limited; quiet for 65 s"
    );
  });

  it("takes a quiet pause after the request budget and starts a new budget", async () => {
    const run = harness({ env: { ...env, VERTEX_WORKER_IDLE_MAX_MS: "3000" } });
    run.sleep.mockImplementation(async () => {
      if (run.claimCount() >= REQUEST_BUDGET + 3) run.controller.abort();
    });
    expect(await runNautilusWorker([], run.io)).toBe(0);
    const waits = run.sleep.mock.calls.map(([ms]) => ms);
    expect(waits.indexOf(QUIET_PAUSE_MS)).toBe(REQUEST_BUDGET);
    expect(waits.filter((ms) => ms === QUIET_PAUSE_MS)).toHaveLength(1);
    expect(run.out.join("")).toContain(
      `${REQUEST_BUDGET} requests sent; quiet for 65 s`
    );
  });

  it("keeps the shared key below half of its limit", () => {
    expect(REQUEST_BUDGET).toBeLessThanOrEqual(AGENT_KEY_LIMIT / 4);
    // The pause is longer than one limiter window (the limiter resets only on a gap > 60 s).
    expect(QUIET_PAUSE_MS).toBeGreaterThan(AGENT_KEY_WINDOW_MS);
    // The cap exceeds the restart script's 30 s quiet window plus one 5 s poll.
    expect(DEFAULT_IDLE_MAX_MS).toBeGreaterThan(35_000);
    // A full limiter wait after a 9-minute run would pass the API stale limit; deliver cuts it.
    expect(NAUTILUS_RUN_TIMEOUT_MS + QUIET_PAUSE_MS).toBeGreaterThan(
      API_STALE_MS - DELIVERY_MARGIN_MS
    );
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs(" ", now)).toBeNull();
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Thu, 05 Nov 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("Thu, 05 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeNull();
  });

  it("uses the default idle time and does not start after a stop", async () => {
    const run = harness();
    run.sleep.mockImplementation(async () => run.controller.abort());
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(run.sleep).toHaveBeenCalledWith(DEFAULT_IDLE_MS, run.io.signal);
    const stopped = harness();
    stopped.controller.abort();
    expect(await runNautilusWorker([], stopped.io)).toBe(0);
    expect(stopped.post).not.toHaveBeenCalled();
  });
});

describe("readEngineOutput", () => {
  it("maps each CLI outcome to a result or a run error", () => {
    expect(readEngineOutput(outcome())).toEqual({
      result: { equity: [1, 1, 1.1], stats: engineResult.stats, trades: [] },
    });
    expect(readEngineOutput(outcome({ stopped: true }))).toEqual({
      error: "The Nautilus worker stopped before the run finished",
    });
    expect(readEngineOutput(outcome({ code: null, timedOut: true }))).toEqual({
      error: "The Nautilus backtest took longer than 9 minutes",
      failure: "engine timeout",
    });
    expect(readEngineOutput(outcome({ code: 3, stdout: "" }))).toEqual({
      detail: "",
      error: "Nautilus is not installed on the research worker",
      failure: "Nautilus missing (exit 3)",
    });
    expect(
      readEngineOutput(
        outcome({ code: 2, stdout: JSON.stringify({ error: "x".repeat(600) }) })
      )
    ).toEqual({ error: "x".repeat(500) });
    expect(
      readEngineOutput(outcome({ code: 2, stderr: "trace", stdout: "{}" }))
    ).toEqual({
      detail: "trace",
      error: "Nautilus engine failed (exit 2)",
      failure: "engine exit 2",
    });
    expect(readEngineOutput(outcome({ stdout: "not json" }))).toEqual({
      detail: "",
      error: "Nautilus engine failed (exit 0)",
      failure: "engine exit 0",
    });
    expect(
      readEngineOutput(
        outcome({
          stdout: JSON.stringify({
            ...engineResult,
            engine: "nautilus-trader-2",
          }),
        })
      )
    ).toEqual({
      error: `The worker engine nautilus-trader-2 does not match the run engine ${engine}`,
      failure: "engine version mismatch",
    });
  });
});

describe("nautilus worker alerts", () => {
  /** Stops the loop once `claims` claims were made. */
  const stopAfter = (run: ReturnType<typeof harness>, claims: number) =>
    run.sleep.mockImplementation(async () => {
      if (run.claimCount() >= claims) run.controller.abort();
    });
  const texts = (run: ReturnType<typeof harness>) =>
    run.alerts.map((alert) => (alert as { text: string }).text);

  it("alerts once at the third failed cycle and once on recovery", async () => {
    const run = harness({
      claimAnswers: { 1: unavailable, 2: unavailable, 4: unavailable },
      claims: [claimedRun],
      commands: [outcome({ code: 1, stderr: "Traceback", stdout: "" })],
      env: alertEnv,
    });
    stopAfter(run, 6);
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(run.claimCount()).toBe(6);
    expect(texts(run)).toEqual([
      "Vertex Nautilus backtest worker: 3 cycles failed in a row (last: engine exit 1). Research only; see journalctl --user -u vertex-nautilus-worker.",
      "Vertex Nautilus backtest worker recovered after 4 failed cycles.",
    ]);
    expect(run.alerts[0]).toMatchObject({ channel: "vertex-ops" });
    expect(JSON.stringify(run.alerts)).not.toContain("secret-key");
    expect(run.out).toContain("alert posted to vertex-ops\n");
  });

  it("names the last error class: HTTP status, error name or unknown", async () => {
    for (const [answer, last] of [
      [unavailable, "HTTP 503"],
      [
        () => {
          throw new TypeError("fetch failed");
        },
        "TypeError",
      ],
      [
        () => {
          throw "offline";
        },
        "unknown error",
      ],
    ] as const) {
      const run = harness({
        claimAnswers: { 1: answer, 2: answer, 3: answer },
        env: alertEnv,
      });
      stopAfter(run, 3);
      expect(await runNautilusWorker([], run.io)).toBe(0);
      expect(texts(run)).toEqual([
        `Vertex Nautilus backtest worker: 3 cycles failed in a row (last: ${last}). Research only; see journalctl --user -u vertex-nautilus-worker.`,
      ]);
    }
  });

  it("does not count input errors or empty claims, and posts nothing without the settings", async () => {
    const inputErrors = harness({
      claims: [claimedRun, claimedRun, claimedRun],
      commands: [1, 2, 3].map(() =>
        outcome({ code: 2, stdout: '{"error":"At least 2 bars needed"}' })
      ),
      env: alertEnv,
    });
    stopAfter(inputErrors, 4);
    expect(await runNautilusWorker([], inputErrors.io)).toBe(0);
    expect(inputErrors.alerts).toEqual([]);

    const unset = harness({
      claimAnswers: { 1: unavailable, 2: unavailable, 3: unavailable },
    });
    stopAfter(unset, 4);
    expect(await runNautilusWorker([], unset.io)).toBe(0);
    expect(unset.alerts).toEqual([]);
    expect(unset.err.join("")).not.toContain("alert post failed");
  });

  it("survives a failing alert post", async () => {
    for (const alert of [
      () => new Response("down", { status: 500 }),
      () => {
        throw new Error("ECONNREFUSED");
      },
      () => Response.json({ ok: false }),
      () => Response.json({}),
      () => Response.json("ok"),
      () => Response.json(null),
      () => new Response("not json"),
    ]) {
      const run = harness({
        alert,
        claimAnswers: { 1: unavailable, 2: unavailable, 3: unavailable },
        env: alertEnv,
      });
      stopAfter(run, 4);
      expect(await runNautilusWorker([], run.io)).toBe(0);
      expect(run.alerts).toHaveLength(2);
      expect(
        run.err.filter((line) => line.includes("alert post failed"))
      ).toHaveLength(2);
    }
  });
});

describe("runCommand", () => {
  const node = process.execPath;
  const options = (
    overrides: Partial<Parameters<typeof runCommand>[2]> = {}
  ) => ({
    cwd: process.cwd(),
    input: "",
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    ...overrides,
  });

  it("passes stdin and returns the exit code and output", async () => {
    const echo = await runCommand(
      node,
      [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('note');process.exit(2)})",
      ],
      options({ input: "hello" })
    );
    expect(echo).toEqual({
      code: 2,
      stderr: "note",
      stdout: "HELLO",
      stopped: false,
      timedOut: false,
    });
    // A child that never reads its input still finishes.
    const early = await runCommand(
      node,
      ["-e", "process.exit(0)"],
      options({ input: "x".repeat(4_000_000) })
    );
    expect(early.code).toBe(0);
  });

  it("kills the child after the timeout or on abort", async () => {
    // A real child process needs a real clock; the timeout is kept short.
    const forever = ["-e", "setInterval(() => {}, 1000)"];
    const slow = await runCommand(node, forever, options({ timeoutMs: 20 }));
    expect(slow).toMatchObject({ stopped: false, timedOut: true });
    const controller = new AbortController();
    const running = runCommand(
      node,
      forever,
      options({ signal: controller.signal })
    );
    controller.abort();
    expect(await running).toMatchObject({ stopped: true, timedOut: false });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await runCommand(node, forever, options({ signal: aborted.signal }))
    ).toMatchObject({ stopped: true });
  });

  it("reports a command that cannot start", async () => {
    const missing = await runCommand(
      "/nonexistent/python",
      [],
      options({ input: "{}" })
    );
    expect(missing.code).toBeNull();
    expect(missing.stderr).toContain("ENOENT");
  });
});

describe("stopSignal", () => {
  it("aborts on SIGTERM and on SIGINT", () => {
    for (const name of ["SIGTERM", "SIGINT"] as const) {
      const listeners = new Map<string, () => void>();
      const signal = stopSignal({
        on: (event, listener) => listeners.set(event, listener),
      });
      expect([...listeners.keys()]).toEqual(["SIGTERM", "SIGINT"]);
      expect(signal.aborted).toBe(false);
      listeners.get(name)?.();
      expect(signal.aborted).toBe(true);
    }
  });
});

describe("sleep", () => {
  it("waits, or returns early on abort", async () => {
    vi.useFakeTimers();
    let done = false;
    const timed = sleep(1000, new AbortController().signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timed;
    expect(done).toBe(true);
    vi.useRealTimers();
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort();
    await waiting;
    const aborted = new AbortController();
    aborted.abort();
    await sleep(60_000, aborted.signal);
  });
});
