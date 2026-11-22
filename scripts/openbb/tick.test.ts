import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  fetcherTimeLimitMs,
  insideOpenbbWindow,
  type OpenbbSpawnResult,
  type OpenbbTickIo,
  openbbChildEnv,
  runOpenbbTick,
  truncateText,
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
    // undefined: the default reply (ingest writes every row, recordRun returns an id).
    replies?: (url: string, input: unknown) => Reply | undefined;
    now?: Date;
  }>
) => {
  const out: string[] = [];
  const err: string[] = [];
  const posts: { url: string; init: RequestInit; input: unknown }[] = [];
  const spawn = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options: Readonly<{
        cwd: string;
        env: Readonly<Record<string, string | undefined>>;
        stdin?: string;
        timeoutMs: number;
      }>
    ) => options.spawn ?? { exitCode: 0, stderr: "", stdout: "" }
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
            : url.endsWith("/status")
              ? { json: { runs: [] } }
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

describe("truncateText", () => {
  it("cuts at the limit without splitting a surrogate pair", () => {
    expect(truncateText("abcdef", 4)).toBe("abcd");
    expect(truncateText("abc", 4)).toBe("abc");
    // "😀" is two UTF-16 units; a cut between them drops the whole character.
    expect(truncateText("ab😀cd", 3)).toBe("ab");
    expect(truncateText("ab😀cd", 4)).toBe("ab😀");
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
      ["congress-house", "--until"],
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
        "--until",
        "2026-11-15",
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
        "--until",
        "2026-11-15",
        "--filers",
        "1067983",
      ],
      {
        cwd: expect.stringMatching(/services\/openbb$/u),
        env: { HOME: "/home/test" },
        timeoutMs: 250_000,
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
      timeoutMs: 250_000,
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
    expect(ingests[0]?.init.signal).toBeInstanceOf(AbortSignal);
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

  it("passes the stored 13F accessions to sec-13f and fails the run when the read fails", async () => {
    const holdings = JSON.parse(fixture("sec_13f_holdings")) as {
      tables: { table: string; rows: unknown[] }[];
    };
    const document = documentOf("sec-13f", holdings.tables);
    const accessionsReply = (accessions: string[]) => (url: string) =>
      url.endsWith("/sec13fAccessions")
        ? { body: { json: { accessions } }, status: 200 }
        : undefined;
    const stored = harness({
      argv: ["sec-13f", "--filers", "1067983"],
      replies: (url, input) =>
        accessionsReply(["0001193125-26-000001", "0001193125-26-000002"])(
          url
        ) ?? {
          body: url.endsWith("/ingest")
            ? {
                json: {
                  written: (input as { batch: { rows: unknown[] } }).batch.rows
                    .length,
                },
              }
            : { json: { id: "run-1" } },
          status: 200,
        },
      spawn: { exitCode: 0, stderr: "", stdout: document },
    });
    expect(await runOpenbbTick(stored.io)).toBe(0);
    expect(stored.posts[0]?.url).toBe(
      `${ORIGIN}/api/orpc/openbb/sec13fAccessions`
    );
    expect(stored.posts[0]?.input).toEqual({});
    expect(stored.spawn.mock.calls[0]).toEqual([
      "python3",
      [
        "-I",
        "-m",
        "vertex_openbb",
        "sec-13f",
        "--filers",
        "1067983",
        "--skip-accessions",
        "0001193125-26-000001,0001193125-26-000002",
      ],
      expect.anything(),
    ]);
    // Nothing stored yet: no flag.
    const empty = harness({
      argv: ["sec-13f"],
      replies: (url, input) =>
        accessionsReply([])(url) ?? {
          body: url.endsWith("/ingest")
            ? {
                json: {
                  written: (input as { batch: { rows: unknown[] } }).batch.rows
                    .length,
                },
              }
            : { json: { id: "run-1" } },
          status: 200,
        },
      spawn: { exitCode: 0, stderr: "", stdout: document },
    });
    expect(await runOpenbbTick(empty.io)).toBe(0);
    expect((empty.spawn.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual([
      "-I",
      "-m",
      "vertex_openbb",
      "sec-13f",
    ]);
    // A failed read: no fetcher, a failed run, exit 1.
    const failed = harness({
      argv: ["sec-13f"],
      replies: (url) =>
        url.endsWith("/sec13fAccessions")
          ? { body: "down", status: 503 }
          : { body: { json: { id: "run-1" } }, status: 200 },
    });
    expect(await runOpenbbTick(failed.io)).toBe(1);
    expect(failed.spawn).not.toHaveBeenCalled();
    expect(recorded(failed.posts)).toMatchObject({
      status: "failed",
    });
    expect(String(recorded(failed.posts)["error"])).toContain(
      "13F skip list read failed: openbb.sec13fAccessions returned HTTP 503"
    );
    // Dry run: no API, no skip list.
    const dry = harness({
      argv: ["sec-13f", "--dry-run"],
      env: {},
      spawn: { exitCode: 0, stderr: "", stdout: document },
    });
    expect(await runOpenbbTick(dry.io)).toBe(0);
    expect(dry.posts).toEqual([]);
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

  it("posts congress trades before filings and never posts filings after a failed trades chunk", async () => {
    const rowsOf = (table: string): unknown[] =>
      (JSON.parse(fixture(table)) as { tables: { rows: unknown[] }[] })
        .tables[0]?.rows ?? [];
    // Filings come first in the document; the tick still posts trades first.
    const stdout = documentOf("congress-house", [
      { rows: rowsOf("congress_filings"), table: "congress_filings" },
      { rows: rowsOf("congress_trades"), table: "congress_trades" },
    ]);
    const tablesPosted = (posts: { url: string; input: unknown }[]) =>
      posts
        .filter((post) => post.url.endsWith("/ingest"))
        .map(
          (post) => (post.input as { batch: { table: string } }).batch.table
        );
    const stored = harness({
      argv: ["congress-house"],
      spawn: { exitCode: 0, stderr: "", stdout },
    });
    expect(await runOpenbbTick(stored.io)).toBe(0);
    expect(tablesPosted(stored.posts)).toEqual([
      "congress_trades",
      "congress_filings",
    ]);
    expect(recorded(stored.posts)).toMatchObject({
      rowsWritten: 6,
      status: "ok",
    });

    const failing = harness({
      argv: ["congress-house"],
      replies: (url) =>
        url.endsWith("/recordRun")
          ? { body: { json: { id: "r" } }, status: 200 }
          : { body: "boom", status: 500 },
      spawn: { exitCode: 0, stderr: "", stdout },
    });
    expect(await runOpenbbTick(failing.io)).toBe(1);
    expect(tablesPosted(failing.posts)).toEqual(["congress_trades"]);
    expect(recorded(failing.posts)).toMatchObject({
      error:
        "congress_trades@0: openbb.ingest returned HTTP 500: boom; congress_filings: not posted because congress_trades failed",
      rowsReceived: 6,
      rowsWritten: 0,
      status: "failed",
    });
    expect(failing.err).toContain(
      "congress_filings: not posted because congress_trades failed\n"
    );
  });

  it("reads the sec-form4 state first and passes it on stdin", async () => {
    const form4 = JSON.parse(
      readFileSync(
        new URL(
          "../../services/openbb/tests/fixtures/sec-form4.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { tables: { table: string; rows: unknown[] }[] };
    const state = {
      completeDays: ["2026-11-04"],
      doneAccessions: [],
      layoutUnknown: [],
    };
    const replies = (url: string, input: unknown): Reply =>
      url.endsWith("/form4State")
        ? { body: { json: state }, status: 200 }
        : {
            body: url.endsWith("/ingest")
              ? {
                  json: {
                    written: (input as { batch: { rows: unknown[] } }).batch
                      .rows.length,
                  },
                }
              : { json: { id: "run-1" } },
            status: 200,
          };
    const run = harness({
      argv: ["sec-form4", "--since", "2026-11-01"],
      replies,
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("sec-form4", form4.tables),
      },
    });
    expect(await runOpenbbTick(run.io)).toBe(0);
    expect(run.posts[0]).toMatchObject({
      input: { from: "2026-11-01", to: "2026-11-06" },
    });
    expect(run.posts[0]?.url).toBe(`${ORIGIN}/api/orpc/openbb/form4State`);
    const [, args, options] = run.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { stdin?: string },
    ];
    expect(args.slice(-1)).toEqual(["--state-stdin"]);
    expect(JSON.parse(options.stdin ?? "")).toEqual(state);
    expect(
      run.posts
        .filter((post) => post.url.endsWith("/ingest"))
        .map((post) => (post.input as { batch: { table: string } }).batch.table)
    ).toEqual([
      "sec_form4_transactions",
      "sec_form4_owners",
      "sec_form4_filings",
      "sec_form4_index_days",
    ]);

    // A failed state read records a failed run and spawns nothing.
    const failing = harness({
      argv: ["sec-form4"],
      replies: (url, input) =>
        url.endsWith("/form4State")
          ? { body: "down", status: 503 }
          : replies(url, input),
    });
    expect(await runOpenbbTick(failing.io)).toBe(1);
    expect(failing.spawn).not.toHaveBeenCalled();
    expect(recorded(failing.posts)).toMatchObject({
      error: "form4State failed: openbb.form4State returned HTTP 503: down",
      status: "failed",
    });

    // A dry run reads no state and sends no stdin.
    const dry = harness({
      argv: ["sec-form4", "--dry-run"],
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("sec-form4", form4.tables),
      },
    });
    expect(await runOpenbbTick(dry.io)).toBe(0);
    expect(dry.posts).toEqual([]);
    expect(
      (dry.spawn.mock.calls[0] as unknown as [string, string[]])[1]
    ).not.toContain("--state-stdin");
  });

  it("skips Form 4 index days when the filings ledger failed", async () => {
    const stdout = documentOf("sec-form4", [
      { rows: [], table: "sec_form4_transactions" },
      { rows: [], table: "sec_form4_owners" },
      {
        rows: [
          {
            acceptedAt: null,
            accessionNumber: "0000900003-26-000003",
            formType: "4",
            indexDay: "2026-11-05",
            issuerCik: null,
            issuerName: null,
            issuerSymbol: null,
            parserVersion: "form4.v1",
            periodOfReport: null,
            plan10b51: null,
            reason: "no_xml",
            rowCount: 0,
            status: "unparsed",
            url: "https://www.sec.gov/x",
          },
        ],
        table: "sec_form4_filings",
      },
      {
        rows: [
          {
            complete: true,
            entriesDone: 1,
            entriesListed: 1,
            indexDay: "2026-11-05",
          },
        ],
        table: "sec_form4_index_days",
      },
    ]);
    const run = harness({
      argv: ["sec-form4", "--dry-run"],
      spawn: { exitCode: 0, stderr: "", stdout },
    });
    expect(await runOpenbbTick(run.io)).toBe(0);
    const failing = harness({
      argv: ["sec-form4", "--until", "2026-11-05"],
      replies: (url) =>
        url.endsWith("/form4State")
          ? {
              body: {
                json: {
                  completeDays: [],
                  doneAccessions: [],
                  layoutUnknown: [],
                },
              },
              status: 200,
            }
          : url.endsWith("/recordRun")
            ? { body: { json: { id: "r" } }, status: 200 }
            : { body: "boom", status: 500 },
      spawn: { exitCode: 0, stderr: "", stdout },
    });
    expect(await runOpenbbTick(failing.io)).toBe(1);
    expect(failing.posts[0]?.input).toEqual({
      from: "2026-09-26",
      to: "2026-11-05",
    });
    expect(failing.err).toContain(
      "sec_form4_index_days: not posted because sec_form4_filings failed\n"
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
      error: "fetcher failed to run: spawn refused",
      rowsReceived: 0,
      status: "failed",
    });
    expect(run.err).toEqual([
      "openbb tick failed: fetcher failed to run: spawn refused\n",
    ]);
  });

  it("limits a fetcher run to its deadline plus 10 s", () => {
    expect(fetcherTimeLimitMs({})).toBe(250_000);
    expect(fetcherTimeLimitMs({ OPENBB_DEADLINE_S: " 900 " })).toBe(910_000);
    expect(fetcherTimeLimitMs({ OPENBB_DEADLINE_S: "86400" })).toBe(86_410_000);
    for (const text of ["", "0", "-5", "86401", "soon"])
      expect(fetcherTimeLimitMs({ OPENBB_DEADLINE_S: text })).toBe(250_000);
  });

  it("passes only allowlisted variables to the Python child", () => {
    const env = openbbChildEnv({
      AWS_SECRET_ACCESS_KEY: "x",
      HOME: "/home/test",
      HTTPS_PROXY: "http://proxy",
      http_proxy: "http://proxy",
      https_proxy: "http://proxy",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      OPENBB_DEADLINE_S: "240",
      OPENBB_PYTHON: "/opt/python",
      OPENBB_STOCK_UNIVERSE: "AAPL",
      PATH: "/usr/bin",
      REQUESTS_CA_BUNDLE: "/etc/ca.pem",
      SSL_CERT_DIR: "/etc/ssl",
      SSL_CERT_FILE: "/etc/ssl/ca.pem",
      TZ: "UTC",
      UNSET: undefined,
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ORIGIN: ORIGIN,
      VERTEX_RESEARCH_CONTACT_EMAIL: "me@domain.test",
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

describe("openbb tick with a blocked upstream source", () => {
  const HOUR = 3_600_000;
  const blockedDocument = JSON.stringify({
    blocked: { host: "cdn-api.cboe.com", httpStatus: 403 },
    job: "cboe-option-iv",
    openbbVersion: "1.4.0",
    schemaVersion: "openbb-batch.v1",
    tables: [
      { rows: [], table: "option_iv_daily" },
      { rows: [], table: "option_iv_term" },
    ],
    warnings: ["cboe chain SPY: ContentTypeError: 403"],
  });
  const blockedSpawn = { exitCode: 0, stderr: "", stdout: blockedDocument };
  const TIMER_ENV = {
    VERTEX_AGENT_API_KEY: KEY,
    VERTEX_OPENBB_TIMER: "1",
    VERTEX_ORIGIN: ORIGIN,
  };
  /** The openbb.status reply for one cboe-option-iv run that started `startedAgo` ms ago. */
  const statusReply =
    (
      blocked: { sinceAgo: number; retryIn: number } | null,
      startedAgo = HOUR,
      error: string | null = "HTTP 403 from cdn-api.cboe.com"
    ) =>
    (url: string): Reply | undefined =>
      url.endsWith("/status")
        ? {
            body: {
              json: {
                runs: [
                  { error: null, job: "cftc-cot", startedAt: "2026-11-06" },
                  {
                    blocked:
                      blocked === null
                        ? null
                        : {
                            attempts: 2,
                            nextRetryAt: new Date(
                              FRIDAY_1720.getTime() + blocked.retryIn
                            ).toISOString(),
                            since: new Date(
                              FRIDAY_1720.getTime() - blocked.sinceAgo
                            ).toISOString(),
                          },
                    error,
                    job: "cboe-option-iv",
                    startedAt: new Date(
                      FRIDAY_1720.getTime() - startedAgo
                    ).toISOString(),
                  },
                ],
              },
            },
            status: 200,
          }
        : undefined;

  it("records blocked_upstream and exits 0", async () => {
    const run = harness({ argv: ["cboe-option-iv"], spawn: blockedSpawn });
    expect(await runOpenbbTick(run.io)).toBe(0);
    // A manual run (no VERTEX_OPENBB_TIMER) does not read the status.
    expect(run.posts.map((post) => post.url.split("/").at(-1))).toEqual([
      "recordRun",
    ]);
    expect(recorded(run.posts)).toEqual({
      error: "HTTP 403 from cdn-api.cboe.com",
      finishedAt: FRIDAY_1720.toISOString(),
      job: "cboe-option-iv",
      openbbVersion: "1.4.0",
      rowsReceived: 0,
      rowsWritten: 0,
      startedAt: FRIDAY_1720.toISOString(),
      status: "blocked_upstream",
      warnings: ["cboe chain SPY: ContentTypeError: 403"],
    });
    expect(run.out.join("")).toBe(
      "cboe-option-iv: blocked_upstream, HTTP 403 from cdn-api.cboe.com\n"
    );
    expect(run.err).toEqual([]);
  });

  it("prints the block in a dry run and ignores the key when the document has rows", async () => {
    const dry = harness({
      argv: ["cboe-option-iv", "--dry-run"],
      env: {},
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(dry.io)).toBe(0);
    expect(dry.out.join("")).toBe(
      "option_iv_daily: 0 rows\noption_iv_term: 0 rows\nwarnings: 1\nblocked: HTTP 403 from cdn-api.cboe.com\n"
    );
    const withRows = harness({
      argv: ["cboe-vx-curve"],
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          blocked: { host: "cdn-api.cboe.com", httpStatus: 403 },
          job: "cboe-vx-curve",
          openbbVersion: "1.4.0",
          schemaVersion: "openbb-batch.v1",
          tables: [{ rows: vxRows(2), table: "vx_curve" }],
          warnings: [],
        }),
      },
    });
    expect(await runOpenbbTick(withRows.io)).toBe(0);
    expect(recorded(withRows.posts)).toMatchObject({
      rowsWritten: 2,
      status: "ok",
    });
  });

  it("passes the newest run summary to a timer run of cboe-option-iv (session guard state)", async () => {
    const partial = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: (url) =>
        url.endsWith("/status")
          ? {
              body: {
                json: {
                  runs: [
                    {
                      error: null,
                      job: "cboe-option-iv",
                      rowsReceived: 12,
                      rowsWritten: 12,
                      startedAt: FRIDAY_1720.toISOString(),
                      status: "partial",
                      warnings: [
                        "cboe chain SPY: ContentTypeError: 403; used the Yahoo option chain (IV: Yahoo column)",
                      ],
                    },
                  ],
                },
              },
              status: 200,
            }
          : undefined,
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(partial.io)).toBe(0);
    const args = partial.spawn.mock.calls[0]?.[1];
    expect(args).toContain("--state-stdin");
    const spawnOptions = partial.spawn.mock.calls[0]?.[2];
    expect(JSON.parse(spawnOptions?.stdin ?? "null")).toEqual({
      rowsReceived: 12,
      rowsWritten: 12,
      startedAt: FRIDAY_1720.toISOString(),
      status: "partial",
      warnings: [
        "cboe chain SPY: ContentTypeError: 403; used the Yahoo option chain (IV: Yahoo column)",
      ],
    });
    // A failed status read passes no state; the run fetches without the guard.
    const failing = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: (url) =>
        url.endsWith("/status") ? { body: "down", status: 503 } : undefined,
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(failing.io)).toBe(0);
    const failArgs = failing.spawn.mock.calls[0]?.[1];
    expect(failArgs).not.toContain("--state-stdin");
    expect(failing.err.join("")).toContain(
      "the run fetches without the session guard"
    );
    // A valid status reply with no run of this job (first timer run ever) passes no state.
    const empty = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: (url) =>
        url.endsWith("/status")
          ? { body: { json: { runs: [] } }, status: 200 }
          : undefined,
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(empty.io)).toBe(0);
    expect(empty.spawn.mock.calls[0]?.[1]).not.toContain("--state-stdin");
    expect(empty.err).toEqual([]);
  });

  it("skips a timer run before the retry time and tries inside the tolerance", async () => {
    const early = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 5 * 60_000 + 1000, sinceAgo: 7 * HOUR }),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(early.io)).toBe(0);
    expect(early.spawn).not.toHaveBeenCalled();
    expect(early.posts.map((post) => post.url.split("/").at(-1))).toEqual([
      "status",
    ]);
    expect(early.posts[0]?.input).toEqual({});
    expect(early.posts[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(early.out.join("")).toBe(
      "skip: blocked upstream (HTTP 403 from cdn-api.cboe.com) since 2026-11-06T15:20:00.000Z; next retry not before 2026-11-06T22:25:01.000Z\n"
    );
    const noReason = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: HOUR, sinceAgo: HOUR }, HOUR, null),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(noReason.io)).toBe(0);
    expect(noReason.out.join("")).toContain(
      "skip: blocked upstream (no reason recorded) since "
    );
    const due = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 5 * 60_000, sinceAgo: 7 * HOUR }),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(due.io)).toBe(0);
    expect(due.spawn).toHaveBeenCalledTimes(1);
    expect(recorded(due.posts)).toMatchObject({ status: "blocked_upstream" });
  });

  it("tries when the job has no blocked streak or the status read fails", async () => {
    const none = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply(null),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(none.io)).toBe(0);
    expect(none.spawn).toHaveBeenCalledTimes(1);
    const unknownJob = harness({
      argv: ["cboe-vx-curve"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 6 * HOUR, sinceAgo: HOUR }),
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("cboe-vx-curve", [
          { rows: vxRows(1), table: "vx_curve" },
        ]),
      },
    });
    expect(await runOpenbbTick(unknownJob.io)).toBe(0);
    expect(unknownJob.spawn).toHaveBeenCalledTimes(1);
    for (const reply of [
      { body: "down", status: 502 },
      { body: { json: { runs: "none" } }, status: 200 },
    ] satisfies Reply[]) {
      const failed = harness({
        argv: ["cboe-option-iv"],
        env: TIMER_ENV,
        replies: (url) => (url.endsWith("/status") ? reply : undefined),
        spawn: blockedSpawn,
      });
      expect(await runOpenbbTick(failed.io)).toBe(0);
      expect(failed.err.join("")).toMatch(
        /^openbb tick: status read failed, the run tries without backoff: /u
      );
      expect(recorded(failed.posts)).toMatchObject({
        status: "blocked_upstream",
      });
    }
  });

  it("exits 1 one time when the streak passes 7 days", async () => {
    const DAY = 24 * HOUR;
    // The newest blocked run started 6 hours ago, when the streak was 6 days 19 hours old.
    const passing = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 0, sinceAgo: 7 * DAY + HOUR }, 6 * HOUR),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(passing.io)).toBe(1);
    expect(recorded(passing.posts)).toMatchObject({
      status: "blocked_upstream",
    });
    expect(passing.err.join("")).toBe(
      "openbb tick failed: cboe-option-iv is blocked upstream for more than 7 days (HTTP 403 from cdn-api.cboe.com since 2026-10-30T21:20:00.000Z)\n"
    );
    // The next attempt: the newest blocked run started after the 7 days had passed.
    const later = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 0, sinceAgo: 8 * DAY }, 6 * HOUR),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(later.io)).toBe(0);
    // A manual run crossed the limit (it never exits 1): the next period still gives one exit 1.
    const secondPeriod = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply({ retryIn: 0, sinceAgo: 14 * DAY + HOUR }, 6 * HOUR),
      spawn: blockedSpawn,
    });
    expect(await runOpenbbTick(secondPeriod.io)).toBe(1);
    // Boundaries: a streak of one run (the earlier start equals `since`), and a run that starts
    // exactly 7 days after `since`.
    for (const reply of [
      statusReply({ retryIn: 0, sinceAgo: 7 * DAY + HOUR }, 7 * DAY + HOUR),
      statusReply({ retryIn: 0, sinceAgo: 7 * DAY }, 6 * HOUR),
    ]) {
      const boundary = harness({
        argv: ["cboe-option-iv"],
        env: TIMER_ENV,
        replies: reply,
        spawn: blockedSpawn,
      });
      expect(await runOpenbbTick(boundary.io)).toBe(1);
    }
    // The rule compares start times: a run that starts before the limit and ends after it does
    // not exit 1 (the next run does), so the unit fails one time only.
    let clock = FRIDAY_1720.getTime();
    const slow = harness({
      argv: ["cboe-option-iv"],
      env: TIMER_ENV,
      replies: statusReply(
        { retryIn: 0, sinceAgo: 7 * DAY - 5 * 60_000 },
        6 * HOUR
      ),
      spawn: blockedSpawn,
    });
    const slowIo = {
      ...slow.io,
      now: () => {
        const at = new Date(clock);
        clock += 3 * 60_000;
        return at;
      },
    };
    expect(await runOpenbbTick(slowIo)).toBe(0);
    const slowRun = recorded(slow.posts);
    expect(slowRun).toMatchObject({ status: "blocked_upstream" });
    // The run started 2 minutes before the limit and finished 1 minute after it.
    const since = FRIDAY_1720.getTime() - (7 * DAY - 5 * 60_000);
    expect(Date.parse(String(slowRun["startedAt"])) - since).toBeLessThan(
      7 * DAY
    );
    expect(
      Date.parse(String(slowRun["finishedAt"])) - since
    ).toBeGreaterThanOrEqual(7 * DAY);
  });
});

describe("openbb tick daily-prices", () => {
  const state = {
    bars: [{ close: 735.29, lastDate: "2026-11-03", symbol: "SPY" }],
    series: [
      { adjClose: 735.29, close: 735.29, id: "SPY", lastDate: "2026-11-06" },
    ],
  };
  const tables = [
    {
      rows: [
        {
          adjClose: 689.81,
          close: 689.81,
          date: "2026-11-20",
          high: 718.29,
          low: 686.75,
          open: 713.56,
          seriesId: "SPY",
        },
      ],
      table: "daily_series",
    },
    {
      rows: [
        {
          close: 689.81,
          date: "2026-11-20",
          high: 718.29,
          low: 686.75,
          open: 713.56,
          symbol: "SPY",
          volume: 1000,
        },
      ],
      table: "daily_bars",
    },
  ];
  const spawn = {
    exitCode: 0,
    stderr: "",
    stdout: documentOf("daily-prices", tables),
  };
  const env = {
    OPENBB_SERVICE_DIR: "/srv/checkout/services/openbb",
    VERTEX_AGENT_API_KEY: KEY,
    VERTEX_DEPLOY_STATUS_TOKEN: "history-token",
    VERTEX_HISTORY_URL: "https://history.domain.test/vertex-history/v1",
    VERTEX_ORIGIN: ORIGIN,
  };

  it("reads the stored state, passes it on stdin with the history variables and posts both tables", async () => {
    const run = harness({
      argv: ["daily-prices"],
      env,
      replies: (url) =>
        url.endsWith("/dailyPricesState")
          ? { body: { json: state }, status: 200 }
          : undefined,
      spawn,
    });
    expect(await runOpenbbTick(run.io)).toBe(0);
    expect(run.posts[0]?.url).toBe(
      `${ORIGIN}/api/orpc/openbb/dailyPricesState`
    );
    expect(run.posts[0]?.input).toEqual({});
    const [, args, options] = run.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; stdin?: string },
    ];
    expect(args).toEqual([
      "-I",
      "-m",
      "vertex_openbb",
      "daily-prices",
      "--state-stdin",
    ]);
    expect(JSON.parse(options.stdin ?? "")).toEqual(state);
    expect(options.cwd).toBe("/srv/checkout/services/openbb");
    expect(options.env).toEqual({
      OPENBB_RESEARCH_DIR: "/srv/checkout/services/research",
      VERTEX_DEPLOY_STATUS_TOKEN: "history-token",
      VERTEX_HISTORY_URL: "https://history.domain.test/vertex-history/v1",
    });
    expect(
      run.posts
        .filter((post) => post.url.endsWith("/ingest"))
        .map((post) => (post.input as { batch: { table: string } }).batch.table)
    ).toEqual(["daily_series", "daily_bars"]);
    expect(recorded(run.posts)).toMatchObject({
      rowsWritten: 2,
      status: "ok",
    });
  });

  it("fails the run without a fetch when the state read fails", async () => {
    const failing = harness({
      argv: ["daily-prices"],
      env,
      replies: (url) =>
        url.endsWith("/dailyPricesState")
          ? { body: "down", status: 503 }
          : undefined,
    });
    expect(await runOpenbbTick(failing.io)).toBe(1);
    expect(failing.spawn).not.toHaveBeenCalled();
    expect(recorded(failing.posts)).toMatchObject({
      error:
        "dailyPricesState failed: openbb.dailyPricesState returned HTTP 503: down",
      status: "failed",
    });
  });

  it("reads no state in a dry run and gives the history variables to no other job", async () => {
    const dry = harness({ argv: ["daily-prices", "--dry-run"], env, spawn });
    expect(await runOpenbbTick(dry.io)).toBe(0);
    expect(dry.posts).toEqual([]);
    const [, args, options] = dry.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdin?: string },
    ];
    expect(args.at(-1)).toBe("daily-prices");
    expect(options.stdin).toBeUndefined();
    expect(Object.keys(options.env).sort()).toEqual([
      "OPENBB_RESEARCH_DIR",
      "VERTEX_DEPLOY_STATUS_TOKEN",
      "VERTEX_HISTORY_URL",
    ]);
    expect(openbbChildEnv(env, "cboe-vol-indices")).toEqual({});
    expect(openbbChildEnv(env)).toEqual({});
  });

  it("posts no later chunk of an append-only table after a failed chunk", async () => {
    // 4,001 rows: three chunks. The first one fails, so the other two are not posted (a later
    // chunk that succeeds would move the stored last date past the failed rows).
    const start = Date.UTC(2010, 0, 1);
    const rows = Array.from({ length: 4001 }, (_, index) => ({
      ...tables[0]?.rows[0],
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    }));
    const run = harness({
      argv: ["daily-prices"],
      env,
      replies: (url, input) =>
        url.endsWith("/dailyPricesState")
          ? { body: { json: state }, status: 200 }
          : url.endsWith("/ingest") &&
              (input as { batch: { table: string } }).batch.table ===
                "daily_series"
            ? { body: "down", status: 503 }
            : undefined,
      spawn: {
        exitCode: 0,
        stderr: "",
        stdout: documentOf("daily-prices", [
          { rows, table: "daily_series" },
          tables[1] as { rows: unknown[]; table: string },
        ]),
      },
    });
    expect(await runOpenbbTick(run.io)).toBe(1);
    const ingests = run.posts
      .filter((post) => post.url.endsWith("/ingest"))
      .map((post) => (post.input as { batch: { table: string } }).batch.table);
    expect(ingests).toEqual(["daily_series", "daily_bars"]);
    expect(recorded(run.posts)).toMatchObject({
      rowsReceived: 4002,
      rowsWritten: 1,
      status: "partial",
    });
    expect(String(recorded(run.posts)["error"])).toContain(
      "daily_series: 2001 later rows not posted (no holes)"
    );
    expect(run.err.join("")).toContain(
      "daily_series: 2001 later rows not posted"
    );
  });

  it("accepts several windows joined with a plus sign", () => {
    const spec = "mon-fri@16:45-24:00+tue-sat@00:00-06:00";
    // Friday 17:20, Saturday 01:00 and Saturday 07:00 in New York.
    expect(insideOpenbbWindow(spec, FRIDAY_1720)).toBe(true);
    expect(insideOpenbbWindow(spec, new Date("2026-11-07T06:00:00.000Z"))).toBe(
      true
    );
    expect(insideOpenbbWindow(spec, new Date("2026-11-07T12:00:00.000Z"))).toBe(
      false
    );
    expect(() =>
      insideOpenbbWindow("mon-fri@16:45-24:00+bad", FRIDAY_1720)
    ).toThrow(/--window/u);
  });
});
