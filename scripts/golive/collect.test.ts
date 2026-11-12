import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoLiveCollectInputSchema } from "../../packages/api/src/contracts/golive-drafts.ts";
import {
  type CollectIo,
  GOLIVE_COLLECT_USAGE,
  GOLIVE_EXIT_NOT_TRADING_DAY,
  GOLIVE_RESEARCH_DIR,
  type ProcessResult,
  parseCollectArguments,
  runGoLiveCollect,
  runProcess,
  systemCollectIo,
} from "./collect.ts";

const ORIGIN = "https://vertex.example";
const KEY = "operator-write-key";
const DAY = "2026-12-01";

// The plan as goLiveDrafts.queue sends it through the RPC transport: dates are text.
const PLAN = {
  approvalBasis: "owner_delegation",
  approvedAt: "2026-11-12T11:00:00.000Z",
  approvedBy: "owner",
  createdAt: "2026-11-12T03:00:00.000Z",
  evidenceUrl: "https://reports.example/plan",
  exitRule: "owner_standing_rule_v1",
  id: "funded-lower-bar-pie",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 4,
    positionRiskPct: 1,
  },
  name: "Funded lower-bar pie",
  ownerMessageUrl: "https://discord.com/channels/1/2/3",
  retiredAt: null,
  sleeves: [
    {
      anchorDelta: 0.5,
      budgetPct: 2,
      definitionNote: "Always-on entry.",
      definitionVariant: "always_on_entry",
      dteMin: 45,
      dteTarget: 60,
      key: "long-index",
      name: "Long index",
      runKey: "oil-predicts-equity/B",
      structure: "callDebitVertical",
      symbols: ["SPY", "QQQ"],
      widthSigma: 1,
    },
  ],
  status: "approved",
  updatedAt: "2026-11-12T11:00:00.000Z",
  version: 3,
};

const candidate = (overrides: Record<string, unknown> = {}) => ({
  entryBasis: "signal_today",
  expiry: "20270115",
  longStrike: 762,
  quote: {
    asOf: "2026-11-30T20:30:00Z",
    longAsk: 17.78,
    longBid: 17.63,
    shortAsk: 0.78,
    shortBid: 0.76,
    source: "yahoo_delayed_snapshot",
  },
  shortStrike: 813,
  signalFacts: ["Data last day 2026-11-30."],
  sleeveKey: "long-index",
  structure: "callDebitVertical",
  symbol: "SPY",
  ...overrides,
});

// What `python -m golive` prints for the plan above.
const DOCUMENT = {
  candidates: [
    candidate(),
    candidate({
      entryBasis: "model_holds_account_does_not",
      expiry: "20261218",
      quote: null,
      symbol: "QQQ",
    }),
  ],
  generatedAt: "2026-12-01T12:15:00Z",
  planId: PLAN.id,
  planVersion: PLAN.version,
  tradingDay: DAY,
};

type Fetched = Readonly<{ init: RequestInit; url: string }>;
type Ran = Readonly<{
  args: readonly string[];
  command: string;
  options: Parameters<CollectIo["run"]>[2];
}>;
type Setup = Readonly<{
  argv?: readonly string[];
  collect?: () => Response | Promise<Response>;
  env?: Record<string, string | undefined>;
  python?: Partial<ProcessResult>;
  queue?: () => Response | Promise<Response>;
}>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const queueOf = (plan: unknown, tradingDay = DAY): Response =>
  json({ json: { drafts: [], plan, sendsOrders: false, tradingDay } });

/** Runs one collection against fakes and returns what it called and wrote. */
const collectWith = async (setup: Setup = {}) => {
  const fetched: Fetched[] = [];
  const ran: Ran[] = [];
  let stdout = "";
  let stderr = "";
  const io: CollectIo = {
    argv: setup.argv ?? ["--data", "/rig/data", "--chain-store", "/rig/chains"],
    env: {
      HOME: "/home/rig",
      PATH: "/usr/bin",
      VERTEX_AGENT_API_KEY: KEY,
      VERTEX_ORIGIN: ORIGIN,
      ...setup.env,
    },
    fetch: async (url, init) => {
      fetched.push({ init, url });
      return await (init.method === "GET"
        ? (setup.queue ?? (() => queueOf(PLAN)))()
        : (
            setup.collect ??
            (() => json({ json: { created: 2, expired: 0, unchanged: 0 } }))
          )());
    },
    run: (command, args, options) => {
      ran.push({ args, command, options });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify(DOCUMENT)}\n`,
        ...setup.python,
      });
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
  };
  const code = await runGoLiveCollect(io);
  const posts = fetched.filter((call) => call.init.method !== "GET");
  return { code, fetched, posts, ran, stderr, stdout };
};

describe("golive collect: the run", () => {
  it("posts exactly the checked document, with the origin and key headers", async () => {
    const result = await collectWith();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.fetched).toHaveLength(2);

    const [queue, collect] = result.fetched as [Fetched, Fetched];
    expect(queue.url).toBe(
      `${ORIGIN}/api/orpc/goLiveDrafts/queue?data=${encodeURIComponent('{"json":{}}')}`
    );
    expect(queue.init.method).toBe("GET");
    expect(queue.init.headers).toEqual({ origin: ORIGIN, "x-api-key": KEY });
    expect(queue.init.body).toBeUndefined();
    expect(queue.init.signal).toBeInstanceOf(AbortSignal);

    expect(collect.url).toBe(`${ORIGIN}/api/orpc/goLiveDrafts/collect`);
    expect(collect.init.method).toBe("POST");
    expect(collect.init.headers).toEqual({
      "content-type": "application/json",
      origin: ORIGIN,
      "x-api-key": KEY,
    });
    expect(collect.init.signal).toBeInstanceOf(AbortSignal);
    const checked = GoLiveCollectInputSchema.parse(DOCUMENT);
    expect(collect.init.body).toBe(JSON.stringify({ json: checked }));
    // The body is the generator's document and nothing else, and the server schema accepts it.
    const posted = JSON.parse(collect.init.body as string) as {
      json: typeof DOCUMENT;
    };
    expect(Object.keys(posted)).toEqual(["json"]);
    expect(posted.json).toEqual({
      ...DOCUMENT,
      candidates: [
        {
          ...DOCUMENT.candidates[0],
          quote: {
            ...DOCUMENT.candidates[0]?.quote,
            asOf: "2026-11-30T20:30:00.000Z",
          },
        },
        DOCUMENT.candidates[1],
      ],
      generatedAt: "2026-12-01T12:15:00.000Z",
    });
    expect(GoLiveCollectInputSchema.parse(posted.json)).toEqual(checked);
    expect(result.stdout).toBe(
      `${DAY} plan funded-lower-bar-pie v3 (approved): 1 signal_today, 1 model_holds_account_does_not; collect: {"json":{"created":2,"expired":0,"unchanged":0}}\n`
    );
  });

  it("runs the generator in services/research with the plan on stdin and without the key", async () => {
    const result = await collectWith();
    expect(result.ran).toEqual([
      {
        args: [
          "-m",
          "golive",
          "--data",
          "/rig/data",
          "--chain-store",
          "/rig/chains",
          "--trading-day",
          DAY,
        ],
        command: "python3",
        options: {
          cwd: GOLIVE_RESEARCH_DIR,
          env: { HOME: "/home/rig", PATH: "/usr/bin" },
          stdin: expect.any(String),
        },
      },
    ]);
    // The whole plan record, the fields this script does not read included.
    expect(JSON.parse(result.ran[0]?.options.stdin as string)).toEqual(PLAN);
    expect(GOLIVE_RESEARCH_DIR).toBe(
      fileURLToPath(new URL("../../services/research", import.meta.url))
    );
    expect(JSON.stringify(result.ran)).not.toContain(KEY);
    // A variable the caller does not have is left out, not passed as text.
    const bare = await collectWith({ env: { HOME: undefined } });
    expect(bare.ran[0]?.options.env).toEqual({ PATH: "/usr/bin" });
  });

  it("asks for the given trading day and runs the generator for the day the queue names", async () => {
    const result = await collectWith({
      argv: [
        "--trading-day",
        "2026-11-30",
        "--data",
        "/rig/data",
        "--chain-store",
        "/rig/chains",
      ],
    });
    expect(result.fetched[0]?.url).toBe(
      `${ORIGIN}/api/orpc/goLiveDrafts/queue?data=${encodeURIComponent('{"json":{"tradingDay":"2026-11-30"}}')}`
    );
    expect(result.ran[0]?.args.slice(-2)).toEqual(["--trading-day", DAY]);
    expect(result.code).toBe(0);
  });

  it("stops with a message and exit 0 when there is no plan: no generator run, no post", async () => {
    const result = await collectWith({ queue: () => queueOf(null) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `no plan in force for ${DAY}: the generator was not run and nothing was posted\n`
    );
    expect(result.stderr).toBe("");
    expect(result.ran).toEqual([]);
    expect(result.posts).toEqual([]);
    expect(result.fetched).toHaveLength(1);
  });

  it("with --dry-run prints the checked document and posts nothing", async () => {
    const result = await collectWith({
      argv: [
        "--dry-run",
        "--data",
        "/rig/data",
        "--chain-store",
        "/rig/chains",
      ],
    });
    expect(result.code).toBe(0);
    expect(result.posts).toEqual([]);
    expect(result.ran).toHaveLength(1);
    expect(result.stdout).toBe(
      `${JSON.stringify(GoLiveCollectInputSchema.parse(DOCUMENT), null, 2)}\n`
    );
    expect(JSON.parse(result.stdout).candidates).toHaveLength(2);
  });

  it("posts a document with zero candidates", async () => {
    const empty = { ...DOCUMENT, candidates: [] };
    const result = await collectWith({
      python: { stdout: JSON.stringify(empty) },
    });
    expect(result.code).toBe(0);
    expect(
      JSON.parse(result.posts[0]?.init.body as string).json.candidates
    ).toEqual([]);
    expect(result.stdout).toContain(
      "0 signal_today, 0 model_holds_account_does_not"
    );
  });

  it("passes on what the generator wrote to stderr when it succeeded", async () => {
    const result = await collectWith({ python: { stderr: "a warning\n" } });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("a warning\n");
    expect(result.posts).toHaveLength(1);
  });
});

describe("golive collect: refusals", () => {
  it("a generator failure posts nothing and exits 1 with the generator's reason", async () => {
    const result = await collectWith({
      python: {
        code: 1,
        stderr:
          "golive: The data ends on 2026-11-10. Trading day 2026-11-12 needs data through 2026-11-11: no signal is drawn from older data.\n",
        stdout: "",
      },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "golive collect failed: the generator failed (exit 1); nothing was posted:\ngolive: The data ends on 2026-11-10. Trading day 2026-11-12 needs data through 2026-11-11: no signal is drawn from older data.\n"
    );
  });

  it("a generator that cannot start posts nothing and exits 1", async () => {
    const result = await collectWith({
      python: { code: 127, stderr: "spawn python3 ENOENT", stdout: "" },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stderr).toContain("the generator failed (exit 127)");
  });

  it("a closed market day is skipped: nothing posted, exit 0", async () => {
    const result = await collectWith({
      python: {
        code: GOLIVE_EXIT_NOT_TRADING_DAY,
        stderr: "golive: 2026-11-26 is not an NYSE trading day\n",
        stdout: "",
      },
    });
    expect(result.code).toBe(0);
    expect(result.posts).toEqual([]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "skipped: golive: 2026-11-26 is not an NYSE trading day; nothing was posted\n"
    );
  });

  it.each([
    [
      "text that is not JSON",
      "Traceback (most recent call last)",
      "The generator output is not JSON: Traceback",
    ],
    ["an empty output", "", "The generator output is not JSON: "],
    [
      "a quote labelled live",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [
          candidate({
            quote: { ...candidate().quote, source: "live" },
          }),
        ],
      }),
      "does not match GoLiveCollectInputSchema",
    ],
    [
      "a candidate with a field the contract does not have",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ limitPrice: 1.2 })],
      }),
      "does not match GoLiveCollectInputSchema",
    ],
    [
      "equal strikes",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ shortStrike: 762 })],
      }),
      "A vertical needs two different strikes",
    ],
    [
      "another plan",
      JSON.stringify({ ...DOCUMENT, planId: "other-plan" }),
      `the generator answered for plan other-plan v3 on ${DAY}, not funded-lower-bar-pie v3 on ${DAY}`,
    ],
    [
      "another plan version",
      JSON.stringify({ ...DOCUMENT, planVersion: 2 }),
      "the generator answered for plan funded-lower-bar-pie v2",
    ],
    [
      "another trading day",
      JSON.stringify({ ...DOCUMENT, tradingDay: "2026-11-30" }),
      `on 2026-11-30, not funded-lower-bar-pie v3 on ${DAY}`,
    ],
  ])(
    "generator output with %s posts nothing and exits 1",
    async (_name, stdout, message) => {
      const result = await collectWith({ python: { stdout } });
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("golive collect failed: ");
    }
  );

  it.each([
    [
      "an HTTP error",
      () => json({ json: { code: "FORBIDDEN" } }, 403),
      'goLiveDrafts.queue returned HTTP 403: {"json":{"code":"FORBIDDEN"}}',
    ],
    [
      "a body that is not JSON",
      () => new Response("<html>"),
      "The goLiveDrafts.queue answer is not JSON: <html>",
    ],
    [
      "no plan field",
      () => json({ json: { tradingDay: DAY } }),
      "goLiveDrafts.queue returned an unexpected shape; the generator was not run",
    ],
    [
      "a plan without sleeves",
      () => queueOf({ ...PLAN, sleeves: [] }),
      "goLiveDrafts.queue returned an unexpected shape",
    ],
    [
      "a network error",
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      "golive collect failed: connect ECONNREFUSED",
    ],
    [
      "a failure that is not an Error",
      () => Promise.reject("timed out"),
      "golive collect failed: timed out",
    ],
  ])(
    "a queue answer with %s runs no generator and exits 1",
    async (_name, queue, message) => {
      const result = await collectWith({ queue });
      expect(result.code).toBe(1);
      expect(result.ran).toEqual([]);
      expect(result.posts).toEqual([]);
      expect(result.stderr).toContain(message);
    }
  );

  it("a refused collect exits 1 with the server's answer", async () => {
    const result = await collectWith({
      collect: () =>
        json({ json: { code: "CONFLICT", message: "plan changed" } }, 409),
    });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'golive collect failed: goLiveDrafts.collect returned HTTP 409: {"json":{"code":"CONFLICT","message":"plan changed"}}\n'
    );
  });
});

describe("golive collect: arguments and environment", () => {
  it("reads the flags, then the environment, then the default interpreter", () => {
    expect(
      parseCollectArguments(
        [
          "--data",
          "/d",
          "--chain-store",
          "/c",
          "--python",
          "/venv/bin/python",
          "--trading-day",
          DAY,
          "--dry-run",
        ],
        {
          GOLIVE_CHAIN_STORE: "/env-c",
          GOLIVE_DATA_DIR: "/env-d",
          GOLIVE_PYTHON: "/env/python",
        }
      )
    ).toEqual({
      chainStore: "/c",
      data: "/d",
      dryRun: true,
      python: "/venv/bin/python",
      tradingDay: DAY,
    });
    expect(
      parseCollectArguments([], {
        GOLIVE_CHAIN_STORE: "/env-c",
        GOLIVE_DATA_DIR: "/env-d",
        GOLIVE_PYTHON: "/env/python",
      })
    ).toEqual({
      chainStore: "/env-c",
      data: "/env-d",
      dryRun: false,
      python: "/env/python",
      tradingDay: undefined,
    });
    for (const python of [undefined, ""]) {
      expect(
        parseCollectArguments(["--data", "/d", "--chain-store", "/c"], {
          GOLIVE_PYTHON: python,
        }).python
      ).toBe("python3");
    }
  });

  it.each([
    [
      ["--data", "/d", "--chain-store", "/c", "--push"],
      `Unknown argument --push.\n${GOLIVE_COLLECT_USAGE}\n`,
    ],
    [["--data"], "--data needs a value\n"],
    [["--data", "", "--chain-store", "/c"], "--data needs a value\n"],
    [["--data", "--chain-store", "/c"], "--data needs a value\n"],
    [
      ["--chain-store", "/c"],
      `--data and --chain-store are required.\n${GOLIVE_COLLECT_USAGE}\n`,
    ],
    [
      ["--data", "/d"],
      `--data and --chain-store are required.\n${GOLIVE_COLLECT_USAGE}\n`,
    ],
    [
      ["--data", "/d", "--chain-store", "/c", "--trading-day", "12/01/2026"],
      "--trading-day must be a date written YYYY-MM-DD\n",
    ],
    [
      ["--data", "/d", "--chain-store", "/c", "--trading-day", "2026-02-30"],
      "--trading-day must be a date written YYYY-MM-DD\n",
    ],
  ])(
    "refuses the arguments %j with exit 2 and no request",
    async (argv, message) => {
      const result = await collectWith({ argv });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(message);
      expect(result.stdout).toBe("");
      expect(result.fetched).toEqual([]);
      expect(result.ran).toEqual([]);
    }
  );

  it.each([
    [
      { VERTEX_ORIGIN: undefined },
      "VERTEX_ORIGIN and VERTEX_AGENT_API_KEY are required\n",
    ],
    [
      { VERTEX_AGENT_API_KEY: "" },
      "VERTEX_ORIGIN and VERTEX_AGENT_API_KEY are required\n",
    ],
    [{ VERTEX_ORIGIN: "vertex" }, "VERTEX_ORIGIN must be a URL\n"],
  ])(
    "refuses the environment %j with exit 2 and no request",
    async (env, message) => {
      const result = await collectWith({ env });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(message);
      expect(result.fetched).toEqual([]);
    }
  );

  it("uses the origin of VERTEX_ORIGIN for the address and the origin header", async () => {
    const result = await collectWith({
      env: { VERTEX_ORIGIN: `${ORIGIN}/drafts/` },
    });
    expect(result.code).toBe(0);
    expect(result.fetched.map((call) => new URL(call.url).origin)).toEqual([
      ORIGIN,
      ORIGIN,
    ]);
    expect(
      result.fetched.map(
        (call) => (call.init.headers as Record<string, string>)["origin"]
      )
    ).toEqual([ORIGIN, ORIGIN]);
  });

  it("prints the usage with --help and does nothing else", async () => {
    const result = await collectWith({ argv: ["--help"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${GOLIVE_COLLECT_USAGE}\n`);
    expect(result.fetched).toEqual([]);
  });
});

describe("golive collect: system access", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
    vi.unstubAllGlobals();
  });

  it("runs a command in its directory with its environment and stdin, and returns both outputs", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "golive-collect-")));
    roots.push(root);
    const result = await runProcess(
      "sh",
      [
        "-c",
        'printf "%s|%s|%s|" "$PWD" "$MARK" "${VERTEX_AGENT_API_KEY:-no key}"; cat; echo warn >&2; exit "$1"',
        "sh",
        "4",
      ],
      {
        cwd: root,
        env: { MARK: "é", PATH: process.env["PATH"] ?? "" },
        stdin: "plan",
      }
    );
    expect(result).toEqual({
      code: 4,
      stderr: "warn\n",
      stdout: `${root}|é|no key|plan`,
    });
  });

  it("returns the command's result when the command never reads stdin", async () => {
    // More than a pipe holds, so the write is still pending when the command exits.
    const result = await runProcess("true", [], {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "x".repeat(4 * 1024 * 1024),
    });
    expect(result).toEqual({ code: 0, stderr: "", stdout: "" });
  });

  it("reports a signal kill as exit code 1 and a command that cannot start as 127", async () => {
    const options = {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "",
    };
    expect(await runProcess("sh", ["-c", "kill -9 $$"], options)).toEqual({
      code: 1,
      stderr: "",
      stdout: "",
    });
    const missing = await runProcess(
      join(tmpdir(), "golive-no-such-python"),
      [],
      options
    );
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("ENOENT");
    expect(missing.stdout).toBe("");
  });

  it("gives the run the process arguments, streams, command runner and network", async () => {
    const answer = new Response("ok");
    const fetchMock = vi.fn(() => Promise.resolve(answer));
    vi.stubGlobal("fetch", fetchMock);
    const host = {
      argv: ["bun", "scripts/vertex-golive-collect.ts", "--dry-run"],
      env: { VERTEX_ORIGIN: ORIGIN },
      stderr: process.stderr,
      stdout: process.stdout,
    };
    const io = systemCollectIo(host);
    expect(io.argv).toEqual(["--dry-run"]);
    expect(io.env).toBe(host.env);
    expect(io.run).toBe(runProcess);
    expect(io.stdout).toBe(process.stdout);
    expect(io.stderr).toBe(process.stderr);
    const init = { method: "GET" };
    expect(await io.fetch(`${ORIGIN}/x`, init)).toBe(answer);
    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/x`, init);
  });
});
