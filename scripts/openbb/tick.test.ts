import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  insideOpenbbWindow,
  openbbChildEnv,
  type OpenbbSpawnResult,
  type OpenbbTickIo,
  runOpenbbTick,
} from "./tick.ts";

const KEY = "dfk_openbb_tick_secret";
const ORIGIN = "https://vertex.domain.test";
// Friday 2026-11-06 17:20 in New York (EST, UTC-5).
const FRIDAY_1720 = new Date("2026-11-06T22:20:00.000Z");

const fixture = (table: string): string =>
  readFileSync(
    new URL(
      `../../packages/api/src/fixtures/openbb/${table}.json`,
      import.meta.url
    ),
    "utf8"
  );

const documentOf = (
  job: string,
  tables: { table: string; rows: unknown[] }[],
  warnings: string[] = []
) =>
  JSON.stringify({
    job,
    openbbVersion: "1.4.0",
    schemaVersion: "openbb-batch.v1",
    tables,
    warnings,
  });

const vxRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    asOf: "2026-11-06",
    contractMonth: `${2027 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`,
    price: 18 + index / 100,
  }));

type Reply = Readonly<{ status: number; body: unknown }>;

const harness = (
  options: Readonly<{
    argv: string[];
    spawn?: OpenbbSpawnResult;
    env?: Record<string, string | undefined>;
    replies?: (url: string, input: unknown) => Reply;
    now?: Date;
  }>
) => {
  const out: string[] = [];
  const err: string[] = [];
  const posts: { url: string; init: RequestInit; input: unknown }[] = [];
  const spawn = vi.fn(
    async () => options.spawn ?? { exitCode: 0, stderr: "", stdout: "" }
  );
  const io: OpenbbTickIo = {
    argv: options.argv,
    env: options.env ?? {
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ORIGIN: `${ORIGIN}/path`,
    },
    now: () => options.now ?? FRIDAY_1720,
    post: async (url, init) => {
      const input = (JSON.parse(String(init.body)) as { json: unknown }).json;
      posts.push({ init, input, url });
      const reply =
        options.replies?.(url, input) ??
        ({
          body: url.endsWith("/ingest")
            ? {
                json: {
                  written: (input as { batch: { rows: unknown[] } }).batch.rows
                    .length,
                },
              }
            : { json: { id: "run-1" } },
          status: 200,
        } satisfies Reply);
      return new Response(
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
        { status: reply.status }
      );
    },
    spawn,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return { err, io, out, posts, spawn };
};

const recorded = (posts: { url: string; input: unknown }[]) =>
  posts.find((post) => post.url.endsWith("/recordRun"))?.input as Record<
    string,
    unknown
  >;

describe("openbb tick window", () => {
  it("matches days and times in New York, start inclusive and end exclusive", () => {
    expect(insideOpenbbWindow("mon-fri@17:00-18:00", FRIDAY_1720)).toBe(true);
    expect(insideOpenbbWindow("mon-fri@17:20-17:25", FRIDAY_1720)).toBe(true);
    expect(insideOpenbbWindow("mon-fri@17:00-17:20", FRIDAY_1720)).toBe(false);
    expect(insideOpenbbWindow("sat,sun@17:00-18:00", FRIDAY_1720)).toBe(false);
    expect(insideOpenbbWindow("fri,sat@17:00-18:00", FRIDAY_1720)).toBe(true);
    expect(insideOpenbbWindow("daily@00:00-23:59", FRIDAY_1720)).toBe(true);
    expect(insideOpenbbWindow("fri@17:00-24:00", FRIDAY_1720)).toBe(true);
    expect(
      insideOpenbbWindow(
        "fri@23:00-24:00",
        new Date("2026-11-07T04:59:00.000Z")
      )
    ).toBe(true);
    // Summer time: 2026-07-03 is a Friday; 21:20 UTC is 17:20 EDT.
    expect(
      insideOpenbbWindow(
        "fri@17:20-17:21",
        new Date("2026-07-03T21:20:00.000Z")
      )
    ).toBe(true);
    for (const spec of [
      "weekdays@17:00-18:00",
      "mon-fri@1700-1800",
      "mon-fri@24:00-24:30",
      "fri-mon@17:00-18:00",
      "mon-fri@18:00-17:00",
      "funday@17:00-18:00",
    ])
      expect(() => insideOpenbbWindow(spec, FRIDAY_1720)).toThrow(/--window/u);
  });

  it("skips outside the window without spawning or posting", async () => {
    const run = harness({ argv: ["cftc-cot", "--window", "sat@10:00-10:05"] });
    expect(await runOpenbbTick(run.io)).toBe(0);
    expect(run.out).toEqual(["skip: outside window\n"]);
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.posts).toEqual([]);
  });
});

describe("openbb tick arguments", () => {
  it("exits 2 on bad arguments", async () => {
    for (const argv of [
      [],
      ["nope"],
      ["cftc-cot", "--bogus", "x"],
      ["cftc-cot", "--since"],
      ["cftc-cot", "--since", "--dry-run"],
      ["cftc-cot", "--window", "bad"],
    ]) {
      const run = harness({ argv });
      expect(await runOpenbbTick(run.io)).toBe(2);
      expect(run.err.join("")).toMatch(/^openbb tick: /u);
      expect(run.spawn).not.toHaveBeenCalled();
    }
  });
});

describe("openbb tick dry run", () => {
  it("runs the pinned fetcher without the agent key and prints per-table counts", async () => {
    const run = harness({
      argv: [
        "cboe-option-iv",
        "--dry-run",
        "--symbols",
        "SPY,QQQ",
        "--since",
        "2026-11-01",
        "--window",
        "mon-fri@16:00-18:00",
        "--filers",
        "1067983",
      ],
      env: { HOME: "/home/test", VERTEX_AGENT_API_KEY: KEY },
      spawn: {
        exitCode: 0,
        stderr: "note: cached\n",
        stdout: fixture("option_iv_daily"),
      },
    });
    expect(await runOpenbbTick(run.io)).toBe(0);
    expect(run.spawn).toHaveBeenCalledWith(
      "python3",
      [
        "-I",
        "-m",
        "vertex_openbb",
        "cboe-option-iv",
        "--symbols",
        "SPY,QQQ",
        "--since",
        "2026-11-01",
        "--filers",
        "1067983",
      ],
      {
        cwd: expect.stringMatching(/services\/openbb$/u),
        env: { HOME: "/home/test" },
      }
    );
    expect(run.out).toEqual(["option_iv_daily: 1 rows\n", "warnings: 0\n"]);
    expect(run.err).toEqual(["note: cached\n"]);
    expect(run.posts).toEqual([]);
  });

  it("uses OPENBB_PYTHON and OPENBB_SERVICE_DIR and fails on a fetcher error", async () => {
    const run = harness({
      argv: ["fed-rates", "--dry-run"],
      env: {
        OPENBB_PYTHON: "/opt/py/bin/python",
        OPENBB_SERVICE_DIR: "/srv/openbb",
      },
      spawn: { exitCode: 3, stderr: "all upstreams failed\n", stdout: "" },
    });
    expect(await runOpenbbTick(run.io)).toBe(1);
    expect(run.spawn.mock.calls[0]?.slice(0, 1)).toEqual([
      "/opt/py/bin/python",
    ]);
    expect((run.spawn.mock.calls[0] as unknown[])[2]).toMatchObject({
      cwd: "/srv/openbb",
    });
    expect(run.err.at(-1)).toBe(
      "openbb tick failed: fetcher exited 3: all upstreams failed\n"
    );
  });
});

describe("openbb tick posting", () => {
  it("posts chunks of at most 2,000 rows, then records an ok run, never printing the key", async () => {
    const run = harness({
      argv: ["cboe-vx-curve"],
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("cboe-vx-curve", [
          { rows: vxRows(4500), table: "vx_curve" },
          { rows: [], table: "vx_curve" },
        ]),
      },
    });
    expect(await runOpenbbTick(run.io)).toBe(0);
    const ingests = run.posts.filter((post) => post.url.endsWith("/ingest"));
    expect(ingests.map((post) => post.url)).toEqual(
      new Array(3).fill(`${ORIGIN}/api/orpc/openbb/ingest`)
    );
    expect(
      ingests.map(
        (post) =>
          (post.input as { batch: { rows: unknown[] } }).batch.rows.length
      )
    ).toEqual([2000, 2000, 500]);
    expect(ingests[0]?.init.headers).toEqual({
      "content-type": "application/json",
      origin: ORIGIN,
      "x-api-key": KEY,
    });
    expect(ingests[0]?.input).toMatchObject({ job: "cboe-vx-curve" });
    expect(recorded(run.posts)).toMatchObject({
      error: null,
      finishedAt: FRIDAY_1720.toISOString(),
      job: "cboe-vx-curve",
      openbbVersion: "1.4.0",
      rowsReceived: 4500,
      rowsWritten: 4500,
      status: "ok",
      warnings: [],
    });
    expect(run.out.at(-1)).toBe(
      "cboe-vx-curve: ok, 4500 of 4500 rows written\n"
    );
    expect([...run.out, ...run.err].join("")).not.toContain(KEY);
  });

  it("records partial for warnings (exit 0) and for a failed chunk (exit 1)", async () => {
    const warned = harness({
      argv: ["fed-rates"],
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("fed-rates", [], ["SOFR: upstream timeout"]),
      },
    });
    expect(await runOpenbbTick(warned.io)).toBe(0);
    expect(recorded(warned.posts)).toMatchObject({
      rowsReceived: 0,
      status: "partial",
      warnings: ["SOFR: upstream timeout"],
    });

    let calls = 0;
    const failing = harness({
      argv: ["cboe-vx-curve"],
      replies: (url, input) => {
        if (url.endsWith("/recordRun"))
          return { body: { json: { id: "r" } }, status: 200 };
        calls += 1;
        return calls === 2
          ? { body: "boom", status: 500 }
          : {
              body: {
                json: {
                  written: (input as { batch: { rows: unknown[] } }).batch.rows
                    .length,
                },
              },
              status: 200,
            };
      },
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("cboe-vx-curve", [
          { rows: vxRows(2500), table: "vx_curve" },
        ]),
      },
    });
    expect(await runOpenbbTick(failing.io)).toBe(1);
    expect(recorded(failing.posts)).toMatchObject({
      error: "vx_curve@2000: openbb.ingest returned HTTP 500: boom",
      rowsReceived: 2500,
      rowsWritten: 2000,
      status: "partial",
    });
    expect(failing.err[0]).toBe(
      "vx_curve: chunk at row 2000 failed: openbb.ingest returned HTTP 500: boom\n"
    );
  });

  it("records failed when every chunk fails or the reply has the wrong shape", async () => {
    const run = harness({
      argv: ["cboe-vx-curve"],
      replies: (url) =>
        url.endsWith("/recordRun")
          ? { body: { json: { id: "r" } }, status: 200 }
          : { body: { json: { written: "two" } }, status: 200 },
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("cboe-vx-curve", [
          { rows: vxRows(2), table: "vx_curve" },
        ]),
      },
    });
    expect(await runOpenbbTick(run.io)).toBe(1);
    expect(recorded(run.posts)).toMatchObject({
      rowsWritten: 0,
      status: "failed",
    });
  });

  it("records a failed run when the fetcher fails or prints a bad document", async () => {
    const cases: [OpenbbSpawnResult, RegExp][] = [
      [
        { exitCode: 3, stderr: "x".repeat(600), stdout: "" },
        /^fetcher exited 3: x{500}$/u,
      ],
      [
        { exitCode: 0, stderr: "", stdout: "not json" },
        /^fetcher stdout is not JSON$/u,
      ],
      [
        {
          exitCode: 0,
          stderr: "",
          stdout: documentOf("cftc-cot", [{ rows: [{}], table: "vx_curve" }]),
        },
        /^fetcher batch failed the schema \(tables\.0\.rows\.0\.asOf: /u,
      ],
      [
        { exitCode: 0, stderr: "", stdout: documentOf("fed-rates", []) },
        /^fetcher answered job fed-rates, not cftc-cot$/u,
      ],
    ];
    for (const [spawn, error] of cases) {
      const run = harness({ argv: ["cftc-cot"], spawn });
      expect(await runOpenbbTick(run.io)).toBe(1);
      const run_ = recorded(run.posts);
      expect(run_).toMatchObject({
        openbbVersion: null,
        rowsReceived: 0,
        status: "failed",
        warnings: [],
      });
      expect(String(run_["error"])).toMatch(error);
      expect(run.posts).toHaveLength(1);
    }
  });

  it("fails before fetching without origin or key, and when recordRun fails", async () => {
    const missing = harness({
      argv: ["cftc-cot"],
      env: { VERTEX_ORIGIN: ORIGIN },
    });
    expect(await runOpenbbTick(missing.io)).toBe(1);
    expect(missing.err).toEqual([
      "openbb tick failed: VERTEX_AGENT_API_KEY is required\n",
    ]);
    expect(missing.spawn).not.toHaveBeenCalled();

    const blank = harness({
      argv: ["cftc-cot"],
      env: { VERTEX_AGENT_API_KEY: KEY, VERTEX_ORIGIN: " " },
    });
    expect(await runOpenbbTick(blank.io)).toBe(1);
    expect(blank.err).toEqual([
      "openbb tick failed: VERTEX_ORIGIN is required\n",
    ]);

    const refused = harness({
      argv: ["fed-rates"],
      replies: () => ({ body: "forbidden", status: 403 }),
      spawn: { exitCode: 0, stderr: "", stdout: documentOf("fed-rates", []) },
    });
    expect(await runOpenbbTick(refused.io)).toBe(1);
    expect(refused.err).toEqual([
      "openbb tick failed: openbb.recordRun returned HTTP 403: forbidden\n",
    ]);
  });

  it("records a failed run when the fetcher cannot start", async () => {
    const run = harness({ argv: ["fed-rates"] });
    const io: OpenbbTickIo = {
      ...run.io,
      spawn: () => Promise.reject("spawn refused"),
    };
    expect(await runOpenbbTick(io)).toBe(1);
    expect(recorded(run.posts)).toMatchObject({
      error: "fetcher could not start: spawn refused",
      rowsReceived: 0,
      status: "failed",
    });
    expect(run.err).toEqual([
      "openbb tick failed: fetcher could not start: spawn refused\n",
    ]);
  });

  it("passes only allowlisted variables to the Python child", () => {
    const env = openbbChildEnv({
      AWS_SECRET_ACCESS_KEY: "x",
      HOME: "/home/test",
      HTTPS_PROXY: "http://proxy",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_PROXY: "localhost",
      OPENBB_DEADLINE_S: "240",
      OPENBB_PYTHON: "/opt/python",
      OPENBB_STOCK_UNIVERSE: "AAPL",
      PATH: "/usr/bin",
      REQUESTS_CA_BUNDLE: "/etc/ca.pem",
      SSL_CERT_DIR: "/etc/ssl",
      SSL_CERT_FILE: "/etc/ssl/ca.pem",
      TZ: "UTC",
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ORIGIN: ORIGIN,
      VERTEX_RESEARCH_CONTACT_EMAIL: "me@domain.test",
      http_proxy: "http://proxy",
      https_proxy: "http://proxy",
      no_proxy: "localhost",
      UNSET: undefined,
    });
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "HTTPS_PROXY",
      "LANG",
      "LC_ALL",
      "NO_PROXY",
      "OPENBB_DEADLINE_S",
      "OPENBB_STOCK_UNIVERSE",
      "PATH",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "TZ",
      "VERTEX_RESEARCH_CONTACT_EMAIL",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]);
  });
});
