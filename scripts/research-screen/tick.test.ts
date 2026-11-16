import { describe, expect, it, vi } from "vitest";

import { type ResearchScreenTickIo, runResearchScreenTick } from "./tick.ts";

type Step = unknown | (() => Response);

const MINUTE_MS = 60_000;
const SCRIPT_URL =
  "file:///opt/vertex-research-screen/vertex-research-screen-tick.mjs";

const env = {
  HOME: "/home/tester",
  VERTEX_AGENT_API_KEY: "test-key",
  VERTEX_ORIGIN: "https://vertex.test/path",
};

const fileError = (code: string): Error =>
  Object.assign(new Error(`${code}: file`), { code });

const harnessFor = (
  options: Readonly<{
    answers?: readonly Step[];
    /** Time that each call takes on the test clock. */
    callMs?: number;
    env?: Record<string, string | undefined>;
    /** Pause file at each check: its age, null when it does not exist, or the error of stat. */
    pauseAges?: readonly (number | null | Error)[];
    /** Reader of SOURCE_SHA; the default has no such file. */
    readText?: (file: URL) => Promise<string>;
  }> = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const ages = [...(options.pauseAges ?? [])];
  let nowMs = 1_700_000_000_000;
  const post = vi.fn(async (_url: string, _init: RequestInit) => {
    nowMs += options.callMs ?? 0;
    const step = answers.shift();
    return typeof step === "function"
      ? (step as () => Response)()
      : Response.json({ json: step });
  });
  const stat = vi.fn(async (_path: string) => {
    const age = ages.shift() ?? null;
    if (age === null) throw fileError("ENOENT");
    if (age instanceof Error) throw age;
    return { mtimeMs: nowMs - age };
  });
  const readText = vi.fn(
    options.readText ??
      (async (_file: URL): Promise<string> => {
        throw fileError("ENOENT");
      })
  );
  const io: ResearchScreenTickIo = {
    env: options.env ?? env,
    now: () => nowMs,
    post,
    readText,
    scriptUrl: SCRIPT_URL,
    stat,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return { err, io, out, post, readText, stat };
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
    expect(harness.stat).toHaveBeenCalledWith(
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
      readText: async () => "abc123-dirty\n",
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(3);
    expect(harness.stat).toHaveBeenCalledTimes(3);
    expect(harness.out).toEqual([
      '{"decision":"ran","done":false,"sourceSha":"abc123-dirty"}\n',
      '{"decision":"ran","done":false,"sourceSha":"abc123-dirty"}\n',
      '{"decision":"ran","done":true,"sourceSha":"abc123-dirty"}\n',
    ]);
    // One read, of the file beside the running script.
    expect(harness.readText).toHaveBeenCalledTimes(1);
    expect(harness.readText.mock.calls[0]?.[0].href).toBe(
      "file:///opt/vertex-research-screen/SOURCE_SHA"
    );
  });

  it("adds no source commit when SOURCE_SHA is empty", async () => {
    const harness = harnessFor({
      answers: [{ done: true }],
      readText: async () => " \n",
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.out).toEqual(['{"done":true}\n']);
  });

  it("fails before any call when SOURCE_SHA cannot be read", async () => {
    const denied = harnessFor({
      readText: async () => {
        throw fileError("EACCES");
      },
    });
    await expect(runResearchScreenTick(denied.io)).resolves.toBe(1);
    expect(denied.err).toEqual(["research screen tick failed: EACCES: file\n"]);
    expect(denied.post).not.toHaveBeenCalled();
    const noCode = harnessFor({
      readText: async () => {
        throw new Error("no code");
      },
    });
    await expect(runResearchScreenTick(noCode.io)).resolves.toBe(1);
    expect(noCode.err).toEqual(["research screen tick failed: no code\n"]);
    const value = harnessFor({
      readText: async () => {
        throw "plain text";
      },
    });
    await expect(runResearchScreenTick(value.io)).resolves.toBe(1);
    expect(value.err).toEqual(["research screen tick failed: plain text\n"]);
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
      pauseAges: [90 * MINUTE_MS - 1],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.stat).toHaveBeenCalledWith("/run/pause");
    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.out).toEqual(['{"paused":true}\n']);
  });

  it("checks the pause file before each call", async () => {
    const harness = harnessFor({
      answers: [{ done: false }],
      pauseAges: [null, 1000],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.out).toEqual(['{"done":false}\n', '{"paused":true}\n']);
  });

  it("ignores a pause file older than 90 minutes", async () => {
    const harness = harnessFor({
      answers: [{ done: true }],
      pauseAges: [90 * MINUTE_MS],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(0);
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.out).toEqual(['{"done":true}\n']);
  });

  it("fails when the pause file cannot be checked", async () => {
    const harness = harnessFor({ pauseAges: [fileError("EACCES")] });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(1);
    expect(harness.err).toEqual([
      "research screen tick failed: EACCES: file\n",
    ]);
    expect(harness.post).not.toHaveBeenCalled();
  });

  it("takes the default pause path from XDG_STATE_HOME, then from HOME", async () => {
    const xdg = harnessFor({
      answers: [{ done: true }],
      env: { ...env, XDG_STATE_HOME: "/var/state" },
    });
    await runResearchScreenTick(xdg.io);
    expect(xdg.stat).toHaveBeenCalledWith(
      "/var/state/vertex-nautilus-worker.pause"
    );
    const noHome = harnessFor({
      answers: [{ done: true }],
      env: { ...env, HOME: undefined },
    });
    await runResearchScreenTick(noHome.io);
    expect(noHome.stat).toHaveBeenCalledWith(
      "/.local/state/vertex-nautilus-worker.pause"
    );
  });

  it("starts no new call after the wall limit of 28 minutes", async () => {
    const below = harnessFor({
      answers: [{ done: false }, { done: false }, { done: true }],
      callMs: 14 * MINUTE_MS - 1,
    });
    await expect(runResearchScreenTick(below.io)).resolves.toBe(0);
    expect(below.post).toHaveBeenCalledTimes(3);
    expect(below.out.at(-1)).toBe('{"done":true}\n');
    const harness = harnessFor({
      answers: [{ done: false }, { done: false }, { done: true }],
      callMs: 14 * MINUTE_MS,
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

  it("returns 1 on any other thrown error", async () => {
    const harness = harnessFor({
      answers: [
        () => {
          throw new Error("connection refused");
        },
      ],
    });
    await expect(runResearchScreenTick(harness.io)).resolves.toBe(1);
    expect(harness.err).toEqual([
      "research screen tick failed: connection refused\n",
    ]);
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
    expect(noKey.readText).not.toHaveBeenCalled();
  });
});
