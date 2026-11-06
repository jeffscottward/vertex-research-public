import { describe, expect, it, vi } from "vitest";

import { BACKTEST_RUN_NAUTILUS_ENGINE } from "../../packages/api/src/contracts/backtest-runs.ts";
import { NAUTILUS_GPU_NOTE } from "../../packages/api/src/contracts/engine-comparison.ts";
import {
  AGENT_KEY_LIMIT,
  AGENT_KEY_WINDOW_MS,
  API_STALE_MS,
  batchRequest,
  COMPLETE_ATTEMPTS,
  COMPLETE_RETRY_MS,
  type CommandOutcome,
  DEFAULT_IDLE_MAX_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_PROCESSES,
  deliveryChunks,
  DELIVERY_MARGIN_MS,
  DELIVERY_MAX_BYTES,
  DELIVERY_MIN_WAIT_MS,
  MAX_PROCESSES,
  NAUTILUS_RUN_TIMEOUT_MS,
  type NautilusWorkerIo,
  QUIET_PAUSE_MS,
  REJECTED_ERROR,
  REQUEST_BUDGET,
  readBatchOutput,
  retryAfterMs,
  runCommand,
  runNautilusWorker,
  sleep,
  splitRuns,
  stopSignal,
  TOO_LARGE_ERROR,
  UNDELIVERED_ERROR,
} from "./nautilus-worker.ts";

const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
const env = {
  VERTEX_AGENT_API_KEY: "secret-key",
  VERTEX_NAUTILUS_PYTHON: "/venv/bin/python",
  VERTEX_ORIGIN: "https://vertex.example.test/portal",
};
const SHA = "b".repeat(64);

const spec = {
  costBps: 5,
  from: "1970-01-01",
  initialCapital: 10_000,
  rule: { fast: 1, kind: "smaCross" as const, slow: 2 },
  stopLossPct: 0,
  symbol: "SPY",
  takeProfitPct: 0,
  timeframe: "1d" as const,
  to: "1970-01-04",
};

const batchRun = (id: string, first = 0, end = 4) => ({
  costs: null,
  end,
  first,
  id,
  sectorQuadrants: null,
  spec,
});

/** A claimed batch of `count` runs (run-1, run-2, ...). */
const claimedBatch = (count = 1) => ({
  bars: {
    c: [10, 11, 12, 13],
    h: [11, 12, 13, 14],
    l: [9, 10, 11, 12],
    o: [10, 10, 11, 12],
    t: [0, 86_400_000, 172_800_000, 259_200_000],
    v: [null, 5, 6, 7],
  },
  runs: Array.from({ length: count }, (_, index) =>
    batchRun(`run-${index + 1}`)
  ),
  seriesSha256: SHA,
});

const caseResult = {
  equity: [1, 1, 1.05, 1.1],
  stats: { bars: 4, trades: 0 },
  trades: [],
};

/** The batch output for the cases of a batch request: every case succeeds. */
const batchOutput = (
  input: string,
  overrides: Partial<{ engine: string; usage: unknown }> = {}
): string => {
  const request = JSON.parse(input) as { cases: { id: string }[] };
  return JSON.stringify({
    engine,
    results: request.cases.map((entry) => ({
      id: entry.id,
      result: caseResult,
      wallMs: 12,
    })),
    usage: { cpuMs: 80, wallMs: 150 },
    ...overrides,
  });
};

const outcome = (overrides: Partial<CommandOutcome> = {}): CommandOutcome => ({
  code: 0,
  stderr: "",
  stdout: "",
  stopped: false,
  timedOut: false,
  ...overrides,
});

type Call = Readonly<{ path: string; input: unknown; init: RequestInit }>;
type Items = { id: string; error?: string }[];

const ALERT_URL = "http://127.0.0.1:8790/post";
const alertEnv = {
  ...env,
  VERTEX_ALERT_CHANNEL: "vertex-ops",
  VERTEX_ALERT_POST_URL: ALERT_URL,
};
const unavailable = () => new Response("unavailable", { status: 503 });

/** Every item stored: a result succeeds, an error fails. */
const stored = (input: unknown) =>
  Response.json({
    json: {
      outcomes: (input as { items: Items }).items.map((item) => ({
        id: item.id,
        status: item.error === undefined ? "succeeded" : "failed",
      })),
    },
  });

/** Fake Vertex API: queued claim batches, then none; completeMany answers per test. */
const harness = (
  options: Readonly<{
    claims?: unknown[];
    complete?: (input: unknown) => Response;
    /** Engine process outcomes in call order; default: every case succeeds. */
    commands?: ((input: string) => CommandOutcome)[];
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
      return Response.json({
        json: { batch: claims.shift() ?? null, run: null },
      });
    }
    return options.complete?.(input) ?? stored(input);
  });
  const runCommandFake = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      options_: { input: string }
    ) =>
      (
        commands.shift() ??
        ((input: string) => outcome({ stdout: batchOutput(input) }))
      )(options_.input)
  );
  const sleepFake = vi.fn(
    async (_ms: number, _signal: AbortSignal): Promise<void> => undefined
  );
  const io: NautilusWorkerIo = {
    env: options.env ?? env,
    hostname: "rig-1",
    post,
    researchDir: "/repo/services/research",
    runCommand: runCommandFake,
    signal: controller.signal,
    sleep: sleepFake,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  const completes = () =>
    calls.filter((call) => call.path === "backtestRuns/engine/completeMany");
  return {
    alerts,
    calls,
    claimCount: () => claimCount,
    completes,
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
  it("refuses missing settings, bad numbers and unknown arguments, and never prints the key", async () => {
    for (const [overrides, message] of [
      [{ VERTEX_AGENT_API_KEY: " " }, "VERTEX_AGENT_API_KEY is required"],
      [{ VERTEX_ORIGIN: undefined }, "VERTEX_ORIGIN is required"],
      [{ VERTEX_NAUTILUS_PYTHON: "" }, "VERTEX_NAUTILUS_PYTHON is required"],
      [{ VERTEX_WORKER_IDLE_MS: "0" }, "VERTEX_WORKER_IDLE_MS must be"],
      [{ VERTEX_WORKER_IDLE_MS: "1.5" }, "VERTEX_WORKER_IDLE_MS must be"],
      [{ VERTEX_WORKER_PROCESSES: "0" }, "VERTEX_WORKER_PROCESSES must be"],
      [
        { VERTEX_WORKER_PROCESSES: String(MAX_PROCESSES + 1) },
        `VERTEX_WORKER_PROCESSES must be at most ${MAX_PROCESSES}`,
      ],
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
  it("claims a batch with the write key and does nothing when no run is queued", async () => {
    const run = harness();
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.post).toHaveBeenCalledWith(
      "https://vertex.example.test/api/orpc/backtestRuns/engine/claim",
      expect.objectContaining({
        body: JSON.stringify({ json: { engine, max: 50 } }),
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
    // An answer without the batch field is no work too.
    const old = harness({
      claimAnswers: { 1: () => Response.json({ json: { run: null } }) },
    });
    expect(await runNautilusWorker(["--once"], old.io)).toBe(0);
    expect(old.runCommand).not.toHaveBeenCalled();
  });

  it("splits a batch over engine processes and stores every result in one request", async () => {
    const run = harness({
      claims: [claimedBatch(5)],
      env: { ...env, VERTEX_WORKER_PROCESSES: "2" },
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.runCommand).toHaveBeenCalledTimes(2);
    const [first, second] = run.runCommand.mock.calls;
    expect(first?.[0]).toBe("/venv/bin/python");
    expect(first?.[1]).toEqual(["-m", "nautilus_backtest", "batch", "-", "-"]);
    expect(first?.[2]).toMatchObject({
      cwd: "/repo/services/research",
      signal: run.io.signal,
      timeoutMs: NAUTILUS_RUN_TIMEOUT_MS,
    });
    const caseIds = (call: typeof first) =>
      (
        JSON.parse(String(call?.[2].input)) as { cases: { id: string }[] }
      ).cases.map((entry) => entry.id);
    expect([...caseIds(first), ...caseIds(second)]).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
    expect(run.paths()).toEqual([
      "backtestRuns/engine/claim",
      "backtestRuns/engine/completeMany",
    ]);
    const [complete] = run.completes();
    const { items } = (complete?.input ?? { items: [] }) as {
      items: unknown[];
    };
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      engineRun: {
        cpuMs: 80,
        gpu: NAUTILUS_GPU_NOTE,
        host: "rig-1",
        processCases: caseIds(first).length,
        processes: 2,
        processWallMs: 150,
        wallMs: 12,
      },
      id: "run-1",
      result: caseResult,
      seriesSha256: SHA,
    });
    expect(run.out).toEqual([
      "run run-1: succeeded\n",
      "run run-2: succeeded\n",
      "run run-3: succeeded\n",
      "run run-4: succeeded\n",
      "run run-5: succeeded\n",
      "batch: 5 runs in 2 engine processes\n",
    ]);
    expect(DEFAULT_PROCESSES).toBe(8);
  });

  it("splits completeMany under the request size limit; an item over it alone fails as too large", async () => {
    // run-1: about 1.1 MB on its own; run-2 and run-3: about 0.6 MB each, so one request each.
    const equityOf = (id: string) =>
      Array.from(
        { length: id === "run-1" ? 100_000 : 55_000 },
        () => 1.234_567_89
      );
    const big = (input: string) => {
      const request = JSON.parse(input) as { cases: { id: string }[] };
      return outcome({
        stdout: JSON.stringify({
          engine,
          results: request.cases.map((entry) => ({
            id: entry.id,
            result: { ...caseResult, equity: equityOf(entry.id) },
            wallMs: 12,
          })),
          usage: { cpuMs: 80, wallMs: 150 },
        }),
      });
    };
    const run = harness({
      claims: [claimedBatch(3)],
      commands: [big],
      // The web app refuses a body over 1 MiB with 413.
      complete: (input) =>
        JSON.stringify({ json: input }).length > 1024 * 1024
          ? new Response("too large", { status: 413 })
          : stored(input),
      env: { ...env, VERTEX_WORKER_PROCESSES: "1" },
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    const bodies = run.completes().map((call) => String(call.init.body));
    // The oversized run alone (413), its fail, then one request per other run.
    expect(bodies).toHaveLength(4);
    expect(
      run.completes().map((call) => (call.input as { items: Items }).items)
    ).toEqual([
      [expect.objectContaining({ id: "run-1" })],
      [{ error: TOO_LARGE_ERROR, id: "run-1" }],
      [expect.objectContaining({ id: "run-2" })],
      [expect.objectContaining({ id: "run-3" })],
    ]);
    for (const body of bodies.slice(1))
      expect(body.length).toBeLessThanOrEqual(DELIVERY_MAX_BYTES);
    expect(run.out.slice(0, 3)).toEqual([
      "run run-1: failed\n",
      "run run-2: succeeded\n",
      "run run-3: succeeded\n",
    ]);
  });

  it("packs items into chunks under the byte limit, in order", () => {
    const item = (id: string, size: number) => ({ id, pad: "x".repeat(size) });
    const items = [item("a", 40), item("b", 40), item("c", 200), item("d", 10)];
    expect(
      deliveryChunks(items, 150).map((chunk) => chunk.map((entry) => entry.id))
    ).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(
      deliveryChunks(items, 200).map((chunk) => chunk.map((entry) => entry.id))
    ).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(deliveryChunks([])).toEqual([]);
    expect(deliveryChunks(items).map((chunk) => chunk.length)).toEqual([4]);
  });

  it("builds a process request with each run's slice, costs and only present sector points", () => {
    const batch = claimedBatch(1);
    const points = {
      "XLK:weekly": [{ date: "1970-01-02", quadrant: "leading" }],
    };
    const costs = { capital: 10_000, profile: { id: "p" } };
    const request = JSON.parse(
      batchRequest(batch.bars, [
        batchRun("a", 1, 3),
        {
          ...batchRun("b"),
          costs: costs as never,
          sectorQuadrants: points as never,
        },
      ])
    );
    expect(request.bars).toEqual(batch.bars);
    expect(request.cases[0]).toEqual({
      id: "a",
      slice: [1, 3],
      spec: { ...spec, costs: null },
    });
    expect(request.cases[1].spec).toMatchObject({
      costs,
      sectorQuadrants: points,
    });
  });

  it("splits runs into nearly equal contiguous parts", () => {
    expect(splitRuns([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
    expect(splitRuns([1, 2], 8)).toEqual([[1], [2]]);
    expect(
      splitRuns([1, 2, 3, 4, 5, 6, 7], 3).map((part) => part.length)
    ).toEqual([2, 2, 3]);
  });

  it("stores input errors as run errors and process failures for every run of the process", async () => {
    const withInputError = (input: string) => {
      const body = JSON.parse(batchOutput(input)) as { results: unknown[] };
      body.results[0] = {
        error: "At least 2 bars needed",
        id: "run-1",
        wallMs: 1,
      };
      return outcome({ stdout: JSON.stringify(body) });
    };
    const run = harness({
      claims: [claimedBatch(2), claimedBatch(2)],
      commands: [
        withInputError,
        () =>
          outcome({
            code: 3,
            stderr: "No module named nautilus_trader",
            stdout: "",
          }),
      ],
      env: { ...env, VERTEX_WORKER_PROCESSES: "1" },
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    const [first, second] = run
      .completes()
      .map((call) => (call.input as { items: Items }).items);
    expect(first?.[0]).toEqual({
      error: "At least 2 bars needed",
      id: "run-1",
    });
    expect(first?.[1]).toHaveProperty("result");
    expect(second).toEqual([
      {
        error: "Nautilus is not installed on the research worker",
        id: "run-1",
      },
      {
        error: "Nautilus is not installed on the research worker",
        id: "run-2",
      },
    ]);
    expect(run.err).toEqual([
      "engine stderr: No module named nautilus_trader\n",
    ]);
    expect(run.out).toContain("run run-1: failed: At least 2 bars needed\n");
  });

  it("fails every run as rejected when the API refuses the request, and logs a refused fail", async () => {
    let answers = 0;
    const rejected = harness({
      claims: [claimedBatch(2)],
      complete: (input) => {
        answers += 1;
        return answers === 1
          ? Response.json({ json: { code: "BAD_REQUEST" } }, { status: 400 })
          : stored(input);
      },
    });
    expect(await runNautilusWorker(["--once"], rejected.io)).toBe(0);
    expect(rejected.completes()[1]?.input).toEqual({
      engine,
      items: [
        { error: REJECTED_ERROR, id: "run-1" },
        { error: REJECTED_ERROR, id: "run-2" },
      ],
    });
    expect(rejected.err.join("")).toContain(
      "backtestRuns/engine/completeMany returned HTTP 400"
    );
    expect(rejected.sleep).not.toHaveBeenCalled();
    const refused = harness({
      claims: [claimedBatch(1)],
      complete: () => new Response("conflict", { status: 409 }),
    });
    expect(await runNautilusWorker(["--once"], refused.io)).toBe(0);
    expect(refused.completes()).toHaveLength(2);
    expect(refused.out).toContain("run run-1: not stored\n");
  });

  it("reports per-run refusals and unknown outcomes", async () => {
    const run = harness({
      claims: [claimedBatch(3)],
      complete: () =>
        Response.json({
          json: {
            outcomes: [
              { error: "CONFLICT", id: "run-1", status: null },
              { id: "run-2", status: null },
            ],
          },
        }),
    });
    expect(await runNautilusWorker(["--once"], run.io)).toBe(0);
    expect(run.out).toEqual([
      "run run-1: refused (CONFLICT)\n",
      "run run-2: refused (unknown)\n",
      "run run-3: not stored\n",
      "batch: 3 runs in 3 engine processes\n",
    ]);
  });

  it("tries completeMany again after network errors, 429 and 5xx answers", async () => {
    const answers = [
      () => new Response("unavailable", { status: 503 }),
      () => new Response("slow down", { status: 429 }),
      () => {
        throw new Error("socket hang up");
      },
    ];
    const flaky = harness({
      claims: [claimedBatch(1)],
      complete: (input) => (answers.shift() ?? (() => stored(input)))(),
    });
    expect(await runNautilusWorker(["--once"], flaky.io)).toBe(0);
    expect(flaky.completes()).toHaveLength(4);
    expect(flaky.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      COMPLETE_RETRY_MS,
      // The 429 waits for the agent key limiter instead of the short retry wait.
      QUIET_PAUSE_MS,
      4 * COMPLETE_RETRY_MS,
    ]);
    expect(flaky.out[0]).toBe("run run-1: succeeded\n");

    const down = harness({
      claims: [claimedBatch(1)],
      complete: () => new Response("bad gateway", { status: 502 }),
    });
    expect(await runNautilusWorker(["--once"], down.io)).toBe(0);
    expect(down.completes()).toHaveLength(COMPLETE_ATTEMPTS + 1);
    expect(down.completes().at(-1)?.input).toEqual({
      engine,
      items: [{ error: UNDELIVERED_ERROR, id: "run-1" }],
    });
    expect(down.err.join("")).toContain("returned HTTP 502: bad gateway");
  });

  it("waits for the limiter at most once per delivery and never past the stale limit", async () => {
    const limited = () => new Response("slow down", { status: 429 });
    const twice = harness({ claims: [claimedBatch(1)], complete: limited });
    expect(await runNautilusWorker(["--once"], twice.io)).toBe(0);
    // Two tries, then one more request that fails the run as undelivered (refused here too).
    expect(twice.completes()).toHaveLength(3);
    expect(twice.sleep.mock.calls.map(([ms]) => ms)).toEqual([QUIET_PAUSE_MS]);
    expect(twice.completes().at(-1)?.input).toEqual({
      engine,
      items: [{ error: UNDELIVERED_ERROR, id: "run-1" }],
    });
    // A batch claimed long ago waits only for the time left (and not at all once it is past).
    const now = vi.spyOn(Date, "now");
    const claimedAt = 1_000_000;
    const late = (elapsed: number) => {
      now.mockReturnValueOnce(claimedAt).mockReturnValue(claimedAt + elapsed);
      let answers = 0;
      return harness({
        claims: [claimedBatch(1)],
        complete: (input) => {
          answers += 1;
          return answers === 1 ? limited() : stored(input);
        },
      });
    };
    const cut = late(API_STALE_MS - DELIVERY_MARGIN_MS - 20_000);
    expect(await runNautilusWorker(["--once"], cut.io)).toBe(0);
    expect(cut.sleep.mock.calls.map(([ms]) => ms)).toEqual([20_000]);
    expect(cut.out[0]).toBe("run run-1: succeeded\n");
    // Less than DELIVERY_MIN_WAIT_MS left: no second try, the runs fail as undelivered.
    for (const elapsed of [
      API_STALE_MS - DELIVERY_MARGIN_MS - DELIVERY_MIN_WAIT_MS + 1,
      API_STALE_MS,
    ]) {
      const over = late(elapsed);
      expect(await runNautilusWorker(["--once"], over.io)).toBe(0);
      expect(over.sleep).not.toHaveBeenCalled();
      expect(over.completes()).toHaveLength(2);
      expect(over.completes().at(-1)?.input).toEqual({
        engine,
        items: [{ error: UNDELIVERED_ERROR, id: "run-1" }],
      });
    }
    now.mockRestore();
  });

  it("reports claim failures with exit 1 in --once mode, never with the key", async () => {
    const down = harness();
    down.post.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await runNautilusWorker(["--once"], down.io)).toBe(1);
    expect(down.err.join("")).toContain("connect ECONNREFUSED");
    const noBody = harness();
    noBody.post.mockResolvedValueOnce(Response.json({}));
    expect(await runNautilusWorker(["--once"], noBody.io)).toBe(1);
    const thrown = harness();
    thrown.post.mockRejectedValueOnce("offline");
    expect(await runNautilusWorker(["--once"], thrown.io)).toBe(1);
    expect(thrown.err.join("")).toContain("offline");
    for (const run of [down, noBody, thrown])
      expect(run.err.join("")).not.toContain("secret-key");
  });
});

describe("nautilus worker loop", () => {
  it("claims again at once after a run, sleeps when idle and stops on abort", async () => {
    const run = harness({
      claims: [claimedBatch(1)],
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
      "backtestRuns/engine/completeMany",
      "backtestRuns/engine/claim",
    ]);
    expect(run.sleep).toHaveBeenCalledTimes(2);
    expect(run.sleep).toHaveBeenCalledWith(250, run.io.signal);
    expect(run.err.join("")).toContain("API restarting");
  });

  it("doubles the idle wait after each empty claim up to the cap and resets it after work", async () => {
    const run = harness({
      claimAnswers: {
        7: () => Response.json({ json: { batch: claimedBatch(1), run: null } }),
      },
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
      "agent key rate limited; quiet for 125 s"
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
      `${REQUEST_BUDGET} requests sent; quiet for 125 s`
    );
  });

  it("keeps the shared key below half of its limit", () => {
    expect(REQUEST_BUDGET).toBeLessThanOrEqual(AGENT_KEY_LIMIT / 4);
    // With one other request inside the pause, one of the two gaps is longer than a window.
    expect(QUIET_PAUSE_MS / 2).toBeGreaterThan(AGENT_KEY_WINDOW_MS);
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

describe("readBatchOutput", () => {
  const runs = [batchRun("run-1"), batchRun("run-2")];
  const context = { host: "rig-1", processes: 3, seriesSha256: SHA };
  const request = batchRequest(claimedBatch().bars, runs);
  const everyRun = (error: string) => [
    { error, id: "run-1" },
    { error, id: "run-2" },
  ];

  it("maps each process outcome to one item per run", () => {
    expect(
      readBatchOutput(outcome({ stdout: batchOutput(request) }), runs, context)
        .items[1]
    ).toMatchObject({
      engineRun: { processCases: 2, processes: 3 },
      id: "run-2",
    });
    expect(readBatchOutput(outcome({ stopped: true }), runs, context)).toEqual({
      failure: null,
      items: everyRun("The Nautilus worker stopped before the run finished"),
    });
    expect(
      readBatchOutput(outcome({ code: null, timedOut: true }), runs, context)
    ).toEqual({
      failure: "engine timeout",
      items: everyRun("The Nautilus backtest took longer than 9 minutes"),
    });
    expect(
      readBatchOutput(outcome({ code: 1, stderr: "trace" }), runs, context)
    ).toEqual({
      detail: "trace",
      failure: "engine exit 1",
      items: everyRun("Nautilus engine failed (exit 1)"),
    });
    expect(
      readBatchOutput(outcome({ stdout: "not json" }), runs, context).failure
    ).toBe("engine exit 0");
    expect(
      readBatchOutput(
        outcome({
          stdout: batchOutput(request, { engine: "nautilus-trader-2" }),
        }),
        runs,
        context
      )
    ).toEqual({
      failure: "engine version mismatch",
      items: everyRun(
        `The worker engine nautilus-trader-2 does not match the run engine ${engine}`
      ),
    });
  });

  it("bounds case errors and fails runs the output left out", () => {
    const stdout = JSON.stringify({
      engine,
      results: [{ error: "x".repeat(600), id: "run-1", wallMs: 1 }],
      usage: { cpuMs: 1, wallMs: 1 },
    });
    expect(readBatchOutput(outcome({ stdout }), runs, context)).toEqual({
      failure: "engine output incomplete",
      items: [
        { error: "x".repeat(500), id: "run-1" },
        {
          error: "The Nautilus engine returned no result for the run",
          id: "run-2",
        },
      ],
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
      claims: [claimedBatch(1)],
      commands: [() => outcome({ code: 1, stderr: "Traceback" })],
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

  it("counts results the API rejected as failed cycles", async () => {
    const run = harness({
      claims: [claimedBatch(1), claimedBatch(1), claimedBatch(1)],
      complete: () =>
        Response.json({
          json: {
            outcomes: [
              {
                error: "BAD_REQUEST",
                id: "run-1",
                message: "stats",
                status: null,
              },
            ],
          },
        }),
      env: alertEnv,
    });
    stopAfter(run, 4);
    expect(await runNautilusWorker([], run.io)).toBe(0);
    expect(texts(run)).toEqual([
      "Vertex Nautilus backtest worker: 3 cycles failed in a row (last: result rejected). Research only; see journalctl --user -u vertex-nautilus-worker.",
      "Vertex Nautilus backtest worker recovered after 3 failed cycles.",
    ]);
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
    const inputError = () =>
      outcome({
        stdout: JSON.stringify({
          engine,
          results: [
            { error: "At least 2 bars needed", id: "run-1", wallMs: 1 },
          ],
          usage: { cpuMs: 1, wallMs: 1 },
        }),
      });
    const inputErrors = harness({
      claims: [claimedBatch(1), claimedBatch(1), claimedBatch(1)],
      commands: [inputError, inputError, inputError],
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
