import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  parseArgs,
  parseJournal,
  type ReportIo,
  runEngineComparisonReport,
  SNAPSHOT_DIR,
  WORKER_UNIT,
} from "./run.ts";
import { comparisonRow } from "./test-fixtures.ts";

const ORIGIN = "https://vertex.example";
const KEY = "agent-key-secret-value";

const listedRun = (
  id: string,
  engineVersion: string,
  comparison?: unknown
) => ({
  createdAt: "2026-11-09T13:17:06.000Z",
  engineVersion,
  error: null,
  finishedAt: "2026-11-09T13:17:26.000Z",
  id,
  spec: {
    from: "1993-10-29",
    symbol: "SPY",
    to: "2026-11-06",
    ...(comparison === undefined ? {} : { comparison }),
  },
  startedAt: "2026-11-09T13:17:09.000Z",
  status: id === "q-1" ? "queued" : id === "n-2" ? "failed" : "succeeded",
  strategySnapshot: id === "n-2" ? null : { name: "Asset-Class Trend" },
});

const inputOf = (init: RequestInit): Record<string, unknown> =>
  z
    .object({ json: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(String(init.body))).json;

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const fakeIo = (overrides: Partial<ReportIo> = {}) => {
  const written = new Map<string, string>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: { body: unknown; headers: unknown; path: string }[] = [];
  const io: ReportIo = {
    env: {
      VERTEX_AGENT_KEY_FILE: "/keys/read",
      VERTEX_ORIGIN: `${ORIGIN}/portal`,
    },
    exists: async (path) => path === `/out/${SNAPSHOT_DIR}/index.html`,
    fetch: async (url, init) => {
      const path = url.replace(`${ORIGIN}/api/orpc/`, "");
      calls.push({
        body: JSON.parse(String(init.body)),
        headers: init.headers,
        path,
      });
      if (path === "backtestRuns/comparisons/list") {
        return answer({
          json: {
            runs: inputOf(init)["feature"] === "sweep" ? [comparisonRow()] : [],
          },
        });
      }
      if (path === "backtestRuns/list")
        return answer({
          json: {
            runs: [
              listedRun("n-1", "nautilus-trader-1.227.0"),
              listedRun("n-2", "nautilus-trader-1.227.0"),
              {
                ...listedRun("q-1", "nautilus-trader-1.227.0"),
                startedAt: null,
              },
              listedRun("c-1", "nautilus-trader-1.227.0", { feature: "sweep" }),
              listedRun("t-1", "instant-2"),
            ],
          },
        });
      return answer({
        json: {
          report:
            inputOf(init)["id"] === "n-1"
              ? {
                  engineRun: {
                    cpuMs: 1,
                    gpu: "not used",
                    host: "omarchy-rig",
                    processCases: 1,
                    processes: 1,
                    processWallMs: 2,
                    wallMs: 1,
                  },
                }
              : null,
        },
      });
    },
    now: () => new Date("2026-11-10T20:00:00.000Z"),
    readJournal: async (unit, since) => {
      expect(unit).toBe(WORKER_UNIT);
      expect(since).toBe("2026-11-05T06:25:00.000Z");
      return [
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(
            Date.parse("2026-11-10T19:00:00Z") * 1000
          ),
          MESSAGE: "Stopped Vertex Nautilus backtest worker.",
        }),
        JSON.stringify({ __REALTIME_TIMESTAMP: "1", MESSAGE: [104, 105] }),
        "",
      ].join("\n");
    },
    readText: async (path) => {
      expect(path).toBe("/keys/read");
      return `${KEY}\n`;
    },
    stderr: { write: (text) => stderr.push(text) },
    stdout: { write: (text) => stdout.push(text) },
    writeText: async (path, text) => {
      written.set(path, text);
    },
    ...overrides,
  };
  return { calls, io, stderr, stdout, written };
};

describe("parseArgs", () => {
  it("reads the output folder, the limit and the journal switch", () => {
    expect(parseArgs(["--", "--out", "/out"])).toEqual({
      journal: true,
      limit: 500,
      out: "/out",
    });
    expect(
      parseArgs(["--out", "/out", "--limit", "20", "--no-journal"])
    ).toEqual({ journal: false, limit: 20, out: "/out" });
  });

  it("refuses bad arguments", () => {
    expect(() => parseArgs([])).toThrow("--out <dir> is required");
    expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
    expect(() => parseArgs(["--out", "/out", "--limit", "501"])).toThrow(
      "--limit must be 1 to 500"
    );
    expect(() => parseArgs(["--out", "/out", "--limit", "x"])).toThrow(
      "--limit must be"
    );
    expect(() => parseArgs(["--html"])).toThrow("unknown argument --html");
  });
});

describe("parseJournal", () => {
  it("keeps text messages with their time in ms", () => {
    expect(
      parseJournal(
        [
          JSON.stringify({
            __REALTIME_TIMESTAMP: "1762556934000000",
            MESSAGE: "getaddrinfo ENOTFOUND host",
          }),
          JSON.stringify({ MESSAGE: "no time" }),
          "  ",
          "not json {",
          JSON.stringify({ __REALTIME_TIMESTAMP: "soon", MESSAGE: "bad time" }),
        ].join("\n")
      )
    ).toEqual([
      { at: 1_762_556_934_000, message: "getaddrinfo ENOTFOUND host" },
    ]);
  });
});

describe("runEngineComparisonReport", () => {
  it("builds the page from the read procedures and the journal", async () => {
    const { calls, io, stderr, stdout, written } = fakeIo();
    expect(await runEngineComparisonReport(["--out", "/out"], io)).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "wrote /out/index.html: 1 comparison runs, 3 Nautilus runs, 2 outage(s)\n",
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      ...Array.from({ length: 6 }, () => "backtestRuns/comparisons/list"),
      "backtestRuns/list",
      "backtestRuns/get",
      "backtestRuns/get",
    ]);
    // The queued run q-1 is never read with get (get can fail or start an unfinished run).
    expect(calls.slice(7).map((call) => call.body)).toEqual([
      { json: { id: "n-1" } },
      { json: { id: "n-2" } },
    ]);
    expect(calls[0]).toMatchObject({
      body: { json: { feature: "instant", limit: 500 } },
      headers: { origin: ORIGIN, "x-api-key": KEY },
    });
    const html = written.get("/out/index.html") ?? "";
    expect(html).toContain("worker outage 15.3 h");
    expect(html).toContain('href="snapshot-2026-11-06/"');
    expect(html).toContain("Asset-Class Trend");
    expect(html).not.toContain(KEY);
  });

  it("uses the key from the environment and goes on without a journal", async () => {
    const readText = vi.fn(async () => "unused");
    const { io, stderr, written } = fakeIo({
      env: { VERTEX_AGENT_API_KEY: ` ${KEY} `, VERTEX_ORIGIN: ORIGIN },
      exists: async () => false,
      readJournal: async () => {
        throw new Error("journalctl: not found");
      },
      readText,
    });
    expect(await runEngineComparisonReport(["--out", "/out"], io)).toBe(0);
    expect(readText).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain(
      "worker journal not read (journalctl: not found)"
    );
    expect(written.get("/out/index.html")).not.toContain(
      "snapshot-2026-11-06/"
    );
    const quiet = fakeIo({ readJournal: () => Promise.reject("no journal") });
    expect(await runEngineComparisonReport(["--out", "/out"], quiet.io)).toBe(
      0
    );
    expect(quiet.stderr.join("")).toContain("(no journal)");
    const skipped = fakeIo({
      readJournal: () => Promise.reject(new Error("must not run")),
    });
    expect(
      await runEngineComparisonReport(
        ["--out", "/out", "--no-journal"],
        skipped.io
      )
    ).toBe(0);
    expect(skipped.stderr).toEqual([]);
  });

  it("fails with a clear message and never prints the key", async () => {
    const cases: [Partial<ReportIo>, string][] = [
      [{ env: {} }, "set VERTEX_ORIGIN"],
      [
        {
          env: {
            VERTEX_AGENT_API_KEY: KEY,
            VERTEX_ORIGIN: "http://vertex.example",
          },
        },
        "VERTEX_ORIGIN must use https",
      ],
      [
        { env: { VERTEX_AGENT_API_KEY: "", VERTEX_ORIGIN: ORIGIN } },
        "set VERTEX_AGENT_KEY_FILE",
      ],
      [{ readText: async () => " \n" }, "the agent key file is empty"],
      [
        { fetch: async () => answer({ message: "Rate limited" }, 429) },
        'backtestRuns/comparisons/list returned HTTP 429: {"message":"Rate limited"}',
      ],
      [{ readText: () => Promise.reject("unreadable") }, "failed: unreadable"],
    ];
    for (const [overrides, message] of cases) {
      const { io, stderr } = fakeIo(overrides);
      expect(await runEngineComparisonReport(["--out", "/out"], io)).toBe(1);
      expect(stderr.join("")).toContain(message);
      expect(stderr.join("")).not.toContain(KEY);
    }
    const { io, stderr } = fakeIo();
    expect(await runEngineComparisonReport([], io)).toBe(1);
    expect(stderr.join("")).toContain("--out <dir> is required");
  });

  it("warns when the run list is full and allows plain http on loopback", async () => {
    const base = fakeIo();
    const io: ReportIo = {
      ...base.io,
      fetch: async (url, init) =>
        url.endsWith("backtestRuns/list")
          ? answer({
              json: {
                runs: Array.from({ length: 100 }, (_, index) =>
                  listedRun(`t-${index}`, "instant-2")
                ),
              },
            })
          : base.io.fetch(url, init),
    };
    expect(await runEngineComparisonReport(["--out", "/out"], io)).toBe(0);
    expect(base.written.get("/out/index.html")).toContain(
      "older Nautilus runs are not shown"
    );
    const loopback = fakeIo({
      env: {
        VERTEX_AGENT_API_KEY: KEY,
        VERTEX_ORIGIN: "http://127.0.0.1:3451",
      },
      fetch: () => Promise.reject(new Error("offline")),
    });
    expect(
      await runEngineComparisonReport(["--out", "/out"], loopback.io)
    ).toBe(1);
    expect(loopback.stderr.join("")).toContain("offline");
  });

  it("refuses rows that do not match the contract", async () => {
    const { io, stderr } = fakeIo({
      fetch: async () =>
        answer({
          json: { runs: [{ ...comparisonRow(), createdAt: "yesterday" }] },
        }),
    });
    expect(await runEngineComparisonReport(["--out", "/out"], io)).toBe(1);
    expect(stderr.join("")).toContain("createdAt");
  });
});
