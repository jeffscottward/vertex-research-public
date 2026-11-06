import type { RunResult } from "@darkfactory/scripting";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScriptRunner,
  isRunResult,
  SCRIPT_RUN_SUPERSEDED,
  SCRIPT_TIMEOUT_MS,
  type ScriptWorkerLike,
  WORKER_UNAVAILABLE,
} from "./script-runner.ts";
import {
  SCRIPT_WORKER_READY,
  type ScriptRunRequest,
} from "./script-sandbox.ts";

const ok: RunResult = {
  inputs: [],
  kind: "indicator",
  ok: true,
  overlay: true,
  plots: [],
  shortTitle: "t",
  signals: [],
  title: "t",
  warnings: [],
};

// A worker that records requests; the test answers them. autoReady: it reports ready as
// it receives its first request (a real worker reports ready once its module has loaded).
const fakeWorker = (autoReady = true) => {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const posted: ScriptRunRequest[] = [];
  const emit = (type: string, event: Event) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const reply = (data: unknown) =>
    emit("message", new MessageEvent("message", { data }));
  let readied = false;
  const ready = () => {
    readied = true;
    reply({ type: SCRIPT_WORKER_READY });
  };
  const worker = {
    addEventListener: vi.fn(
      (type: string, listener: (event: Event) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      }
    ),
    postMessage: vi.fn((message: ScriptRunRequest) => {
      if (autoReady && !readied) ready();
      posted.push(message);
    }),
    terminate: vi.fn(),
  };
  return {
    emit,
    posted,
    ready,
    reply,
    worker: worker satisfies ScriptWorkerLike,
  };
};

const flush = async () => {
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isRunResult", () => {
  it("accepts results and rejects other shapes", () => {
    expect(isRunResult(ok)).toBe(true);
    expect(isRunResult({ errors: [], ok: false })).toBe(true);
    for (const value of [
      null,
      1,
      {},
      { ok: true },
      { ...ok, plots: null },
      { ...ok, signals: null },
      { ...ok, inputs: null },
      { ...ok, title: 1 },
      { ...ok, overlay: "yes" },
      { errors: null, ok: false },
    ])
      expect(isRunResult(value)).toBe(false);
    return;
  });
});

describe("createScriptRunner", () => {
  it("posts one request at a time and resolves each with its answer", async () => {
    const fake = fakeWorker();
    const runner = createScriptRunner({ createWorker: () => fake.worker });
    const first = runner.run("a", [], {});
    const second = runner.run("b", [], { length: 3 });
    await flush();
    expect(fake.posted).toEqual([{ bars: [], id: 1, inputs: {}, source: "a" }]);
    // Answers for another id, or stray messages, are ignored.
    fake.reply({ id: 99, result: ok });
    fake.reply(null);
    fake.reply({ id: 1, result: ok });
    await expect(first).resolves.toEqual(ok);
    await flush();
    expect(fake.posted[1]).toEqual({
      bars: [],
      id: 2,
      inputs: { length: 3 },
      source: "b",
    });
    fake.reply({ id: 2, result: { errors: [], ok: false } });
    await expect(second).resolves.toEqual({ errors: [], ok: false });
    fake.reply({ id: 2, result: ok });
    return expect(fake.worker.terminate).not.toHaveBeenCalled();
  });
  it("terminates a worker that does not answer in time and starts a fresh one", async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(), fakeWorker()];
    let created = 0;
    const runner = createScriptRunner({
      createWorker: () => workers[created++]?.worker ?? null,
    });
    const slow = runner.run("while true", [], {});
    await flush();
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
    const result = await slow;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]?.message).toContain("3 s");
    expect(workers[0]?.worker.terminate).toHaveBeenCalledTimes(1);
    const next = runner.run("plot(close)", [], {});
    let settled: RunResult | null = null;
    void next.then((value) => {
      settled = value;
    });
    await flush();
    expect(created).toBe(2);
    // A late answer from the stopped worker, even with the current run's id, is ignored.
    workers[0]?.reply({ id: 2, result: { errors: [], ok: false } });
    await flush();
    expect(settled).toBeNull();
    workers[1]?.reply({ id: 2, result: ok });
    return expect(next).resolves.toEqual(ok);
  });
  it("starts the time limit when the worker is ready, with a separate startup limit", async () => {
    vi.useFakeTimers();
    const slow = fakeWorker(false);
    const runner = createScriptRunner({ createWorker: () => slow.worker });
    const first = runner.run("a", [], {});
    await flush();
    // Loading takes longer than one script's limit: the run still goes on.
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS * 2);
    expect(slow.worker.terminate).not.toHaveBeenCalled();
    slow.ready();
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS - 1);
    slow.reply({ id: 1, result: ok });
    await expect(first).resolves.toEqual(ok);
    const never = fakeWorker(false);
    const stuck = createScriptRunner({
      createWorker: () => never.worker,
      startupTimeoutMs: 10_000,
    });
    const waiting = stuck.run("a", [], {});
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waiting).resolves.toMatchObject({
      errors: [{ message: expect.stringContaining("did not start") }],
    });
    return expect(never.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("runs only the newest queued run per key; older ones are superseded", async () => {
    const fake = fakeWorker();
    const runner = createScriptRunner({ createWorker: () => fake.worker });
    const running = runner.run("first", [], {}, "a");
    const older = runner.run("older", [], {}, "a");
    const other = runner.run("other", [], {}, "b");
    const newest = runner.run("newest", [], {}, "a");
    const unkeyed = runner.run("plain", [], {});
    await expect(older).resolves.toBe(SCRIPT_RUN_SUPERSEDED);
    await flush();
    for (const id of [1, 2, 3, 4]) {
      fake.reply({ id, result: ok });
      await flush();
    }
    await Promise.all([running, other, newest, unkeyed]);
    return expect(fake.posted.map((request) => request.source)).toEqual([
      "first",
      "other",
      "newest",
      "plain",
    ]);
  });
  it("fails the run when the worker errors or sends something unreadable", async () => {
    const workers = [fakeWorker(), fakeWorker(), fakeWorker()];
    let created = 0;
    const runner = createScriptRunner({
      createWorker: () => workers[created++]?.worker ?? null,
    });
    const crashed = runner.run("a", [], {});
    await flush();
    workers[0]?.emit("error", new Event("error"));
    await expect(crashed).resolves.toMatchObject({
      errors: [{ message: "The script worker stopped with an error." }],
      ok: false,
    });
    const garbled = runner.run("b", [], {});
    await flush();
    workers[1]?.emit("messageerror", new Event("messageerror"));
    await expect(garbled).resolves.toMatchObject({ ok: false });
    const odd = runner.run("c", [], {});
    await flush();
    workers[2]?.reply({ id: 3, result: { ok: "maybe" } });
    await expect(odd).resolves.toMatchObject({
      errors: [{ message: "The script worker sent an unreadable result." }],
    });
    // Events from workers already replaced are ignored.
    workers[0]?.emit("error", new Event("error"));
    workers[1]?.emit("messageerror", new Event("messageerror"));
    return expect(workers[2]?.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("reports when the request cannot be posted", async () => {
    const fake = fakeWorker();
    fake.worker.postMessage.mockImplementation(() => {
      throw new DOMException("could not clone", "DataCloneError");
    });
    const runner = createScriptRunner({ createWorker: () => fake.worker });
    return expect(runner.run("a", [], {})).resolves.toMatchObject({
      errors: [
        { message: "Chart bars could not be sent to the script worker." },
      ],
    });
  });
  it("gives a clear error without Worker support", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(createScriptRunner().run("a", [], {})).resolves.toMatchObject({
      errors: [{ column: 1, line: 1, message: WORKER_UNAVAILABLE }],
      ok: false,
    });
    const throwing = createScriptRunner({
      createWorker: () => {
        throw new Error("blocked by CSP");
      },
    });
    return expect(throwing.run("a", [], {})).resolves.toMatchObject({
      errors: [{ message: WORKER_UNAVAILABLE }],
    });
  });
  it("starts the bundled module worker by default", async () => {
    const fake = fakeWorker();
    const Worker = vi.fn(function FakeWorker(
      _url: URL,
      _options: WorkerOptions
    ) {
      return fake.worker;
    });
    vi.stubGlobal("Worker", Worker);
    const run = createScriptRunner().run("a", [], {});
    await flush();
    expect(Worker).toHaveBeenCalledWith(expect.any(URL), {
      name: "vx-script",
      type: "module",
    });
    expect(String(Worker.mock.calls[0]?.[0])).toContain("script-worker.ts");
    fake.reply({ id: 1, result: ok });
    return expect(run).resolves.toEqual(ok);
  });
  it("stops pending and later runs on dispose", async () => {
    const fake = fakeWorker();
    const runner = createScriptRunner({ createWorker: () => fake.worker });
    const pending = runner.run("a", [], {});
    await flush();
    runner.dispose();
    await expect(pending).resolves.toMatchObject({
      errors: [{ message: "Script runner stopped." }],
    });
    expect(fake.worker.terminate).toHaveBeenCalledTimes(1);
    return expect(runner.run("b", [], {})).resolves.toMatchObject({
      errors: [{ message: "Script runner stopped." }],
    });
  });
  it("ignores a late ready signal and stops queued runs on dispose", async () => {
    const fake = fakeWorker(false);
    const runner = createScriptRunner({ createWorker: () => fake.worker });
    const first = runner.run("a", [], {});
    await flush();
    fake.reply({ id: 1, result: ok });
    await expect(first).resolves.toEqual(ok);
    fake.ready();
    const second = runner.run("b", [], {});
    const queued = runner.run("c", [], {});
    await flush();
    runner.dispose();
    await expect(second).resolves.toMatchObject({
      errors: [{ message: "Script runner stopped." }],
    });
    await expect(queued).resolves.toMatchObject({
      errors: [{ message: "Script runner stopped." }],
    });
    // Disposing an idle runner settles nothing.
    const idle = createScriptRunner({
      createWorker: () => fakeWorker().worker,
    });
    expect(() => idle.dispose()).not.toThrow();
  });
});
