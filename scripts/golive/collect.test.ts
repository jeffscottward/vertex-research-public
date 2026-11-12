import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoLiveCollectInputSchema } from "../../packages/api/src/contracts/golive-drafts.ts";
import {
  type CollectIo,
  GOLIVE_COLLECT_USAGE,
  GOLIVE_EXIT_NOT_TRADING_DAY,
  GOLIVE_GENERATOR_TIMEOUT_MS,
  GOLIVE_RESEARCH_DIR,
  GOLIVE_RIG_QUOTE_SOURCES,
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
  fetch?: CollectIo["fetch"];
  python?: Partial<ProcessResult>;
  run?: () => Promise<ProcessResult>;
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
      if (setup.fetch !== undefined) {
        return await setup.fetch(url, init);
      }
      return await (init.method === "GET"
        ? (setup.queue ?? (() => queueOf(PLAN)))()
        : (
            setup.collect ??
            (() => json({ json: { created: 2, expired: 0, unchanged: 0 } }))
          )());
    },
    run: (command, args, options) => {
      ran.push({ args, command, options });
      if (setup.run !== undefined) {
        return setup.run();
      }
      return Promise.resolve({
        code: 0,
        signal: null,
        stderr: "",
        stdout: `${JSON.stringify(DOCUMENT)}\n`,
        timedOut: false,
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
    // No request follows a redirect: the key reaches the configured origin only.
    expect(queue.init.redirect).toBe("error");
    expect(collect.init.redirect).toBe("error");
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
      `${DAY} plan funded-lower-bar-pie v3 (approved): 1 signal_today, 1 model_holds_account_does_not; stored: 2 created, 0 unchanged, 0 expired\n`
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
          timeoutMs: GOLIVE_GENERATOR_TIMEOUT_MS,
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

  it("posts a document with zero candidates when the generator ended cleanly and wrote no stderr", async () => {
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

  it("passes on what the generator wrote to stderr when it succeeded with candidates", async () => {
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

  it("a generator that calls the server's trading day a closed market day ends the run with exit 1 and its own message", async () => {
    const python = {
      code: GOLIVE_EXIT_NOT_TRADING_DAY,
      stderr: "golive: 2026-12-01 is not an NYSE trading day\n",
      stdout: "",
    };
    const result = await collectWith({ python });
    expect(GOLIVE_EXIT_NOT_TRADING_DAY).toBe(3);
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "golive collect failed: calendar disagreement: the server named 2026-12-01 as the trading day and the generator's calendar says it is not one (exit 3); nothing was posted:\ngolive: 2026-12-01 is not an NYSE trading day\n"
    );
    // A day the operator named is reported as such.
    const named = await collectWith({
      argv: ["--data", "/d", "--chain-store", "/c", "--trading-day", DAY],
      python,
    });
    expect(named.code).toBe(1);
    expect(named.posts).toEqual([]);
    expect(named.stderr).toContain(
      "calendar disagreement: --trading-day named 2026-12-01"
    );
  });

  it("a generator killed by a signal posts nothing and exits 1", async () => {
    const result = await collectWith({
      python: { code: 1, signal: "SIGKILL", stderr: "", stdout: "" },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "the generator was ended by SIGKILL; nothing was posted"
    );
  });

  it("a generator killed after printing a whole document with zero candidates still posts nothing", async () => {
    const result = await collectWith({
      python: {
        code: 1,
        signal: "SIGTERM",
        stdout: JSON.stringify({ ...DOCUMENT, candidates: [] }),
      },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
  });

  it("a generator that passes its time limit posts nothing and exits 1", async () => {
    const result = await collectWith({
      env: { GOLIVE_GENERATOR_TIMEOUT_MS: "1500" },
      python: { code: 1, signal: "SIGKILL", stdout: "", timedOut: true },
    });
    expect(result.ran[0]?.options.timeoutMs).toBe(1500);
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stderr).toBe(
      "golive collect failed: the generator did not finish within 1500 ms and was killed; nothing was posted\n"
    );
  });

  it.each([
    ["a traceback", "Traceback (most recent call last):\n  KeyError: 'SPY'\n"],
    ["a warning", "RuntimeWarning: invalid value encountered\n"],
  ])(
    "an empty candidate list together with %s on stderr posts nothing and exits 1",
    async (_name, stderr) => {
      const result = await collectWith({
        python: {
          stderr,
          stdout: JSON.stringify({ ...DOCUMENT, candidates: [] }),
        },
      });
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `${stderr.trim()}\ngolive collect failed: the generator gave no candidates and wrote the text above to stderr; an error is not read as a day without candidates; nothing was posted\n`
      );
    }
  );

  it("a traceback with a non-zero exit and an empty candidate list posts nothing", async () => {
    const result = await collectWith({
      python: {
        code: 1,
        stderr: "Traceback (most recent call last):\n",
        stdout: JSON.stringify({ ...DOCUMENT, candidates: [] }),
      },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stderr).toContain("the generator failed (exit 1)");
  });

  it("a failure of the command runner that is not an Error posts nothing and exits 1", async () => {
    const result = await collectWith({
      run: () => Promise.reject("runner broke"),
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.stderr).toBe("golive collect failed: runner broke\n");
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
      "a quote labelled ibkr_live",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [
          candidate(),
          candidate({
            quote: { ...candidate().quote, source: "ibkr_live" },
          }),
        ],
      }),
      "a source the rig cannot produce (it reads yahoo_delayed_snapshot only); nothing was posted:\ncandidates[1].quote.source is ibkr_live",
    ],
    [
      "a quote labelled model, which the generator never emits",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [
          candidate({ quote: { ...candidate().quote, source: "model" } }),
        ],
      }),
      "candidates[0].quote.source is model",
    ],
    [
      "a call debit vertical whose long strike is above the short strike",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ longStrike: 813, shortStrike: 762 })],
      }),
      "wrong way round for this structure",
    ],
    [
      "a put credit vertical whose short strike is below the long strike",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [
          candidate(),
          candidate({
            longStrike: 813,
            shortStrike: 762,
            structure: "putCreditVertical",
          }),
        ],
      }),
      "candidates[1]",
    ],
    [
      "a put debit vertical whose long strike is below the short strike",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ structure: "putDebitVertical" })],
      }),
      "wrong way round for this structure",
    ],
    [
      "a call credit vertical whose short strike is above the long strike",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ structure: "callCreditVertical" })],
      }),
      "wrong way round for this structure",
    ],
    [
      "an expiry that is not a calendar day",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ expiry: "20270230" })],
      }),
      "candidates[0].expiry",
    ],
    [
      "an expiry on the trading day",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ expiry: "20261201" })],
      }),
      "The expiry must be after the trading day",
    ],
    [
      "an expiry before the trading day",
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ expiry: "20261120" })],
      }),
      "The expiry must be after the trading day",
    ],
    [
      "a strike that is not finite",
      JSON.stringify({ ...DOCUMENT, candidates: [candidate()] }).replace(
        '"shortStrike":813',
        '"shortStrike":1e999'
      ),
      "candidates[0].shortStrike",
    ],
    [
      "a NaN quote price",
      JSON.stringify({ ...DOCUMENT, candidates: [candidate()] }).replace(
        '"longAsk":17.78',
        '"longAsk":NaN'
      ),
      "The generator output is not JSON",
    ],
    [
      "two documents",
      `${JSON.stringify(DOCUMENT)}\n${JSON.stringify(DOCUMENT)}\n`,
      "The generator output is not JSON",
    ],
    [
      "an error object in place of the document",
      JSON.stringify({ candidates: [], error: "stale data" }),
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
      "an error envelope with HTTP 200",
      () => json({ json: { code: "UNAUTHORIZED", message: "no key" } }),
      "goLiveDrafts.queue returned an unexpected shape; the generator was not run",
    ],
    [
      "sendsOrders that is not false",
      () => json({ json: { plan: PLAN, sendsOrders: true, tradingDay: DAY } }),
      "goLiveDrafts.queue returned an unexpected shape",
    ],
    [
      "a plan without sleeves",
      () => queueOf({ ...PLAN, sleeves: [] }),
      "goLiveDrafts.queue returned an unexpected shape",
    ],
    [
      "a network error",
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      "golive collect failed: goLiveDrafts.queue: the request failed (no answer, a time limit, or a redirect, which is refused so that the key reaches https://vertex.example only): connect ECONNREFUSED",
    ],
    [
      "a failure that is not an Error",
      () => Promise.reject("timed out"),
      "which is refused so that the key reaches https://vertex.example only): timed out",
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

describe("golive collect: the collect answer", () => {
  it.each([
    [
      "an HTML page with HTTP 200",
      () => new Response("<html><body>Sign in</body></html>"),
      "The request was sent and whether the candidates were stored is unknown: the goLiveDrafts.collect answer is not JSON: <html>",
    ],
    [
      "an error envelope with HTTP 200",
      () => json({ json: { code: "CONFLICT", message: "plan changed" } }),
      "goLiveDrafts.collect answered with a body that is not a collect result; the request was sent and whether the candidates were stored is unknown",
    ],
    [
      "counts that are not whole numbers",
      () => json({ json: { created: "2", expired: 0, unchanged: 0 } }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "a field the contract does not have",
      () => json({ json: { created: 2, expired: 0, stored: 2, unchanged: 0 } }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "no envelope",
      () => json({ created: 2, expired: 0, unchanged: 0 }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
  ])(
    "%s exits 1 and reports nothing as stored",
    async (_name, collect, message) => {
      const result = await collectWith({ collect });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("golive collect failed: ");
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("created,");
    }
  );
});

describe("golive collect: the key", () => {
  it("replaces the key in every line it writes, also when the server or the generator repeats it", async () => {
    const refused = await collectWith({
      collect: () => json({ json: { message: `bad key ${KEY}` } }, 403),
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("bad key [key hidden]");
    expect(refused.stderr + refused.stdout).not.toContain(KEY);

    const failed = await collectWith({
      queue: () => Promise.reject(new Error(`x-api-key: ${KEY}`)),
    });
    expect(failed.stderr).toContain("x-api-key: [key hidden]");
    expect(failed.stderr + failed.stdout).not.toContain(KEY);

    const echoed = await collectWith({
      argv: ["--dry-run", "--data", "/d", "--chain-store", "/c"],
      python: {
        stderr: `note ${KEY}\n`,
        stdout: JSON.stringify({
          ...DOCUMENT,
          candidates: [candidate({ signalFacts: [`fact ${KEY}`] })],
        }),
      },
    });
    expect(echoed.code).toBe(0);
    expect(echoed.stderr).toBe("note [key hidden]\n");
    expect(echoed.stdout).toContain("fact [key hidden]");
    expect(echoed.stderr + echoed.stdout).not.toContain(KEY);
  });

  it("writes no key in any ordinary outcome", async () => {
    const outcomes = await Promise.all([
      collectWith(),
      collectWith({ queue: () => queueOf(null) }),
      collectWith({ python: { code: 1, stderr: "golive: refused\n" } }),
      collectWith({ env: { VERTEX_ORIGIN: "http://vertex.example" } }),
      collectWith({ argv: ["--help"] }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.stderr + outcome.stdout).not.toContain(KEY);
    }
  });
});

type Seen = Readonly<{ key: string | undefined; method: string; url: string }>;

describe("golive collect: redirects", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })
      )
    );
  });

  /** A loopback server that records each request and answers with `answer`. */
  const listen = async (
    answer: (request: IncomingMessage) => {
      body?: string;
      location?: string;
      status: number;
    }
  ) => {
    const seen: Seen[] = [];
    const server = createServer((request, response) => {
      const key = request.headers["x-api-key"];
      seen.push({
        key: Array.isArray(key) ? key.join(",") : key,
        method: request.method ?? "",
        url: request.url ?? "",
      });
      request.resume();
      const { body, location, status } = answer(request);
      response.writeHead(status, location ? { location } : {});
      response.end(body ?? "");
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, seen };
  };

  const realFetch: CollectIo["fetch"] = (url, init) =>
    globalThis.fetch(url, init);

  it.each([301, 302, 303, 307, 308])(
    "a %i answer to the plan read ends the run with exit 1: the second server gets no request and no key",
    async (status) => {
      const second = await listen(() => ({ body: "{}", status: 200 }));
      const first = await listen((request) => ({
        location: `${second.origin}${request.url}`,
        status,
      }));
      const result = await collectWith({
        env: { VERTEX_ORIGIN: first.origin },
        fetch: realFetch,
      });
      expect(result.code).toBe(1);
      expect(first.seen).toHaveLength(1);
      expect(first.seen[0]?.key).toBe(KEY);
      expect(second.seen).toEqual([]);
      expect(result.ran).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `goLiveDrafts.queue: the request failed (no answer, a time limit, or a redirect, which is refused so that the key reaches ${first.origin} only)`
      );
      expect(result.stderr).not.toContain(KEY);
    }
  );

  it("a 307 answer to the collect post ends the run with exit 1: the second server gets no request and no key", async () => {
    const second = await listen(() => ({
      body: JSON.stringify({ json: { created: 2, expired: 0, unchanged: 0 } }),
      status: 200,
    }));
    const first = await listen((request) =>
      request.method === "GET"
        ? {
            body: JSON.stringify({
              json: { plan: PLAN, sendsOrders: false, tradingDay: DAY },
            }),
            status: 200,
          }
        : { location: `${second.origin}${request.url}`, status: 307 }
    );
    const result = await collectWith({
      env: { VERTEX_ORIGIN: first.origin },
      fetch: realFetch,
    });
    expect(result.code).toBe(1);
    expect(first.seen.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
    expect(second.seen).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("goLiveDrafts.collect: the request failed");
    expect(result.stderr).not.toContain(KEY);
  });

  it("a loopback origin over http is accepted and a whole run works against it", async () => {
    const server = await listen((request) => ({
      body: JSON.stringify({
        json:
          request.method === "GET"
            ? { plan: PLAN, sendsOrders: false, tradingDay: DAY }
            : { created: 1, expired: 1, unchanged: 1 },
      }),
      status: 200,
    }));
    const result = await collectWith({
      env: { VERTEX_ORIGIN: server.origin },
      fetch: realFetch,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "stored: 1 created, 1 unchanged, 1 expired"
    );
    expect(server.seen.map((request) => request.key)).toEqual([KEY, KEY]);
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
    ...[
      "http://vertex.example",
      "http://192.168.1.20:3000",
      "http://127.0.0.1.example.com",
      "http://localhost.example.com",
      "http://0.0.0.0:3000",
      "ftp://127.0.0.1",
      "ws://localhost:3000",
      "file:///etc/passwd",
    ].map((origin): [Record<string, string>, string] => [
      { VERTEX_ORIGIN: origin },
      "VERTEX_ORIGIN must be an https URL (http is accepted for 127.0.0.1, ::1 and localhost only); no request was made\n",
    ]),
    ...["0", "-5", "1.5", "300s", "abc", "9999999999"].map(
      (timeout): [Record<string, string>, string] => [
        { GOLIVE_GENERATOR_TIMEOUT_MS: timeout },
        "GOLIVE_GENERATOR_TIMEOUT_MS must be a whole number of milliseconds above 0\n",
      ]
    ),
  ])(
    "refuses the environment %j with exit 2 and no request",
    async (env, message) => {
      const result = await collectWith({ env });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(message);
      expect(result.fetched).toEqual([]);
    }
  );

  it.each([
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/x", "http://[::1]:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://vertex.example:8443", "https://vertex.example:8443"],
  ])("accepts the origin %s", async (origin, expected) => {
    const result = await collectWith({ env: { VERTEX_ORIGIN: origin } });
    expect(result.code).toBe(0);
    expect(new URL(result.fetched[0]?.url as string).origin).toBe(expected);
  });

  it("uses the default generator time limit when the variable is empty", async () => {
    const result = await collectWith({
      env: { GOLIVE_GENERATOR_TIMEOUT_MS: "" },
    });
    expect(result.ran[0]?.options.timeoutMs).toBe(300_000);
    expect(GOLIVE_RIG_QUOTE_SOURCES).toEqual(["yahoo_delayed_snapshot"]);
  });

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
        timeoutMs: 30_000,
      }
    );
    expect(result).toEqual({
      code: 4,
      signal: null,
      stderr: "warn\n",
      stdout: `${root}|é|no key|plan`,
      timedOut: false,
    });
  });

  it("returns the command's result when the command never reads stdin", async () => {
    // More than a pipe holds, so the write is still pending when the command exits.
    const result = await runProcess("true", [], {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "x".repeat(4 * 1024 * 1024),
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      code: 0,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
    });
  });

  it("reports a signal kill as exit code 1 and a command that cannot start as 127", async () => {
    const options = {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "",
      timeoutMs: 30_000,
    };
    expect(await runProcess("sh", ["-c", "kill -9 $$"], options)).toEqual({
      code: 1,
      signal: "SIGKILL",
      stderr: "",
      stdout: "",
      timedOut: false,
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

  it("kills a command that passes its time limit and reports it as timed out", async () => {
    const started = Date.now();
    // The command starts a second process that keeps the pipes open after the kill.
    const result = await runProcess(
      "sh",
      ["-c", "echo partial; sleep 5 & sleep 5"],
      {
        cwd: tmpdir(),
        env: { PATH: process.env["PATH"] ?? "" },
        stdin: "",
        timeoutMs: 300,
      }
    );
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
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
