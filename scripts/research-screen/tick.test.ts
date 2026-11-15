import { describe, expect, it, vi } from "vitest";

import {
  PAUSE_FILE_MAX_AGE_MS,
  type ResearchScreenTickIo,
  runResearchScreenTick,
  WALL_LIMIT_MS,
} from "./tick.ts";

type Step = unknown | (() => Response);

const env = {
  HOME: "/home/tester",
  VERTEX_AGENT_API_KEY: "test-key",
  VERTEX_ORIGIN: "https://vertex.test/path",
};

const harnessFor = (
  options: Readonly<{
    answers?: readonly Step[];
    env?: Record<string, string | undefined>;
    fileAges?: readonly (number | null)[];
    sourceSha?: string;
    times?: readonly number[];
  }> = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const ages = [...(options.fileAges ?? [])];
  const times = [...(options.times ?? [])];
  const post = vi.fn(async (_url: string, _init: RequestInit) => {
    const step = answers.shift();
    return typeof step === "function"
      ? (step as () => Response)()
      : Response.json({ json: step });
  });
  const fileAgeMs = vi.fn(async (_path: string) => ages.shift() ?? null);
  const io: ResearchScreenTickIo = {
    env: options.env ?? env,
    fileAgeMs,
    now: () => times.shift() ?? 0,
    post,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
    ...(options.sourceSha === undefined
      ? {}
      : { sourceSha: options.sourceSha }),
  };
  return { err, fileAgeMs, io, out, post };
};

describe("runResearchScreenTick", () => {
  it("posts one researchScreen.tick request and stops on not-due", async () => {
    const harness = harnessFor({
      answers: [{ decision: "not-due", done: true }],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    const [url, init] = harness.post.mock.calls[0] ?? [];
    expect(url).toBe("https://vertex.test/api/orpc/researchScreen/tick");
    expect(init).toEqual({
      body: JSON.stringify({ json: {} }),
      headers: {
        "content-type": "application/json",
        origin: "https://vertex.test",
        "x-api-key": "test-key",
      },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    expect(harness.out).toEqual(['{"decision":"not-due","done":true}\n']);
    expect(harness.err).toEqual([]);
    expect(harness.fileAgeMs).toHaveBeenCalledWith(
      "/home/tester/.local/state/vertex-nautilus-worker.pause"
    );
  });

  it("calls again at once until the answer is done and adds the source commit", async () => {
    const harness = harnessFor({
      answers: [
        { decision: "ran", done: false },
        { decision: "ran", done: false },
        { decision: "ran", done: true },
      ],
      sourceSha: "abc123",
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(3);
    expect(harness.fileAgeMs).toHaveBeenCalledTimes(3);
    expect(harness.out).toEqual([
      '{"decision":"ran","done":false,"sourceSha":"abc123"}\n',
      '{"decision":"ran","done":false,"sourceSha":"abc123"}\n',
      '{"decision":"ran","done":true,"sourceSha":"abc123"}\n',
    ]);
  });

  it("stops after a busy answer", async () => {
    const harness = harnessFor({ answers: [{ decision: "busy" }] });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.out).toEqual(['{"decision":"busy"}\n']);
  });

  it("stops without a call while the pause file is fresh", async () => {
    const harness = harnessFor({
      env: { ...env, VERTEX_WORKER_PAUSE_FILE: "/run/pause" },
      fileAges: [PAUSE_FILE_MAX_AGE_MS - 1],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.fileAgeMs).toHaveBeenCalledWith("/run/pause");
    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.out).toEqual(['{"paused":true}\n']);
  });

  it("checks the pause file before each call", async () => {
    const harness = harnessFor({
      answers: [{ done: false }],
      fileAges: [null, 1000],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.out).toEqual(['{"done":false}\n', '{"paused":true}\n']);
  });

  it("ignores a pause file older than 90 minutes", async () => {
    const harness = harnessFor({
      answers: [{ done: true }],
      fileAges: [PAUSE_FILE_MAX_AGE_MS],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.out).toEqual(['{"done":true}\n']);
  });

  it("takes the default pause path from XDG_STATE_HOME, then from HOME", async () => {
    const xdg = harnessFor({
      answers: [{ done: true }],
      env: { ...env, XDG_STATE_HOME: "/var/state" },
    });
    await runResearchScreenTick(xdg.io);
    expect(xdg.fileAgeMs).toHaveBeenCalledWith(
      "/var/state/vertex-nautilus-worker.pause"
    );
    const noHome = harnessFor({
      answers: [{ done: true }],
      env: { ...env, HOME: undefined },
    });
    await runResearchScreenTick(noHome.io);
    expect(noHome.fileAgeMs).toHaveBeenCalledWith(
      "/.local/state/vertex-nautilus-worker.pause"
    );
  });

  it("starts no new call after the wall limit", async () => {
    const harness = harnessFor({
      answers: [{ done: false }, { done: false }],
      times: [1000, 1000, 1000 + WALL_LIMIT_MS - 1, 1000 + WALL_LIMIT_MS],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(2);
    expect(harness.out.at(-1)).toBe('{"wallLimit":true}\n');
  });

  it("fails on an HTTP error with the body cut to 300 characters", async () => {
    const harness = harnessFor({
      answers: [() => new Response("x".repeat(400), { status: 403 })],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(1);
    expect(harness.err).toEqual([
      `research screen tick failed: researchScreen.tick returned HTTP 403: ${"x".repeat(300)}\n`,
    ]);
    expect(harness.out).toEqual([]);
  });

  it("fails on a body that is not JSON or has no result object", async () => {
    const notJson = harnessFor({ answers: [() => new Response("<html>")] });
    await expect(runResearchScreenTick(notJson.io)).resolves.toBe(1);
    expect(notJson.err[0]).toContain("research screen tick failed: ");
    for (const body of ["[]", "{}", '{"json":null}', '{"json":[1]}', "7"]) {
      const harness = harnessFor({ answers: [() => new Response(body)] });
      await expect(runResearchScreenTick(harness.io)).resolves.toBe(1);
      expect(harness.err).toEqual([
        "research screen tick failed: researchScreen.tick returned no result object\n",
      ]);
    }
  });

  it("returns 2 when a call times out or is aborted", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const harness = harnessFor({
        answers: [
          () => {
            throw new DOMException("the call took too long", name);
          },
        ],
      });
      await expect(runResearchScreenTick(harness.io)).resolves.toBe(2);
      expect(harness.err).toEqual([
        "research screen tick timed out: the call took too long\n",
      ]);
    }
  });

  it("returns 1 on any other thrown error or value", async () => {
    const error = harnessFor({
      answers: [
        () => {
          throw new Error("connection refused");
        },
      ],
    });
    await expect(runResearchScreenTick(error.io)).resolves.toBe(1);
    expect(error.err).toEqual([
      "research screen tick failed: connection refused\n",
    ]);
    const value = harnessFor({
      answers: [
        () => {
          throw "plain text";
        },
      ],
    });
    await expect(runResearchScreenTick(value.io)).resolves.toBe(1);
    expect(value.err).toEqual(["research screen tick failed: plain text\n"]);
  });

  it("requires the origin and the key, and never prints the key", async () => {
    const noOrigin = harnessFor({ env: { VERTEX_AGENT_API_KEY: "test-key" } });
    await expect(runResearchScreenTick(noOrigin.io)).resolves.toBe(1);
    expect(noOrigin.err).toEqual([
      "research screen tick failed: VERTEX_ORIGIN is required\n",
    ]);
    expect(noOrigin.err.join("")).not.toContain("test-key");
    const noKey = harnessFor({
      env: { VERTEX_AGENT_API_KEY: " ", VERTEX_ORIGIN: "https://vertex.test" },
    });
    await expect(runResearchScreenTick(noKey.io)).resolves.toBe(1);
    expect(noKey.err).toEqual([
      "research screen tick failed: VERTEX_AGENT_API_KEY is required\n",
    ]);
    expect(noKey.post).not.toHaveBeenCalled();
  });
});
