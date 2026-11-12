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
  GOLIVE_GENERATOR_OUTPUT_MAX_BYTES,
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
            (() =>
              json({
                json: { created: 2, expired: 0, unchanged: 0, updated: 0 },
              }))
          )());
    },
    run: (command, args, options) => {
      ran.push({ args, command, options });
      if (setup.run !== undefined) {
        return setup.run();
      }
      return Promise.resolve({
        code: 0,
        overflow: null,
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
      `${DAY} plan funded-lower-bar-pie v3 (approved): 1 signal_today, 1 model_holds_account_does_not; stored: 2 created, 0 updated, 0 unchanged, 0 expired\n`
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
          maxOutputBytes: GOLIVE_GENERATOR_OUTPUT_MAX_BYTES,
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

  it.each([
    ["2026-11-30T20:30:00Z", "2026-12-01T12:15:00Z"],
    ["2026-11-30T15:30:00-05:00", "2026-12-01T07:15:00-05:00"],
    ["2026-11-30T20:30:00.000+00:00", "2026-12-01T12:15:00.000+00:00"],
  ])(
    "posts asOf %s and generatedAt %s as text for the generator's instants",
    async (asOf, generatedAt) => {
      const result = await collectWith({
        python: {
          stdout: JSON.stringify({
            ...DOCUMENT,
            candidates: [candidate({ quote: { ...candidate().quote, asOf } })],
            generatedAt,
          }),
        },
      });
      expect(result.code).toBe(0);
      const posted = JSON.parse(result.posts[0]?.init.body as string).json;
      const postedAsOf: unknown = posted.candidates[0].quote.asOf;
      // Text with "Z", which the server's schema reads, and the same instant as the generator's.
      expect(postedAsOf).toBe("2026-11-30T20:30:00.000Z");
      expect(new Date(postedAsOf as string).getTime()).toBe(
        new Date(asOf).getTime()
      );
      expect(posted.generatedAt).toBe("2026-12-01T12:15:00.000Z");
      expect(new Date(posted.generatedAt).getTime()).toBe(
        new Date(generatedAt).getTime()
      );
      expect(GoLiveCollectInputSchema.safeParse(posted).success).toBe(true);
    }
  );

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

  it.each(["stdout", "stderr"] as const)(
    "a generator that writes more than the limit to %s posts nothing and exits 1 without printing what it wrote",
    async (overflow) => {
      const result = await collectWith({
        python: {
          code: 1,
          overflow,
          signal: "SIGKILL",
          stderr: "runaway text\n",
          // A whole document with zero candidates was read before the limit.
          stdout: JSON.stringify({ ...DOCUMENT, candidates: [] }),
        },
      });
      expect(GOLIVE_GENERATOR_OUTPUT_MAX_BYTES).toBe(5 * 1024 * 1024);
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `golive collect failed: the generator wrote more than 5242880 bytes to ${overflow} and was killed; nothing was posted\n`
      );
    }
  );

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
    ...[
      ["a quote time without an offset", "2026-11-30T20:30:00"],
      ["a quote time that is a date only", "2026-11-30"],
      ["a quote time that is a number", 1_796_070_600_000],
      ["a quote time that is null", null],
    ].map(([name, asOf]): [string, string, string] => [
      name as string,
      JSON.stringify({
        ...DOCUMENT,
        candidates: [candidate({ quote: { ...candidate().quote, asOf } })],
      }),
      "candidates[0].quote.asOf",
    ]),
    [
      "a generatedAt without an offset",
      JSON.stringify({ ...DOCUMENT, generatedAt: "2026-12-01T12:15:00" }),
      "generatedAt",
    ],
    [
      "a generatedAt that is a number",
      JSON.stringify({ ...DOCUMENT, generatedAt: 0 }),
      "generatedAt",
    ],
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
      () =>
        json({ json: { created: "2", expired: 0, unchanged: 0, updated: 0 } }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "an answer without the updated counter",
      () => json({ json: { created: 2, expired: 0, unchanged: 0 } }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "a negative counter",
      () =>
        json({ json: { created: 2, expired: 0, unchanged: 0, updated: -1 } }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "a field the contract does not have",
      () =>
        json({
          json: { created: 2, expired: 0, stored: 2, unchanged: 0, updated: 0 },
        }),
      "goLiveDrafts.collect answered with a body that is not a collect result",
    ],
    [
      "no envelope",
      () => json({ created: 2, expired: 0, unchanged: 0, updated: 0 }),
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

  // A dummy of 32 characters, the length of a real key; no part of it is a word of a message. It
  // is joined from pieces so that a secret scanner does not take this test value for a key.
  const SECRET = ["Zq7Jx2Vb", "9Lm4Tn8R", "w3Yc6Hd1", "Kf5Pg0Sa"].join("");
  const env = { VERTEX_AGENT_API_KEY: SECRET };
  /** `filler` characters, then the key, then a tail: the key starts at offset `filler`. */
  const echo = (filler: number, key = SECRET): string =>
    `${"x".repeat(filler)}${key} tail`;
  // The texts are cut at 300 characters: the key before the cut, ending exactly at it, across it
  // (the reviewer's offset 280), one character before it, and after it.
  const OFFSETS = [0, 150, 267, 268, 269, 280, 290, 299, 300, 400];
  const SHORTENED: [string, (text: string) => Setup][] = [
    [
      "the plan read answers with an HTTP error",
      (text) => ({ queue: () => new Response(text, { status: 500 }) }),
    ],
    [
      "the plan read answers with text that is not JSON",
      (text) => ({ queue: () => new Response(text) }),
    ],
    [
      "the collect answers with an HTTP error",
      (text) => ({ collect: () => new Response(text, { status: 403 }) }),
    ],
    [
      "the collect answers with text that is not JSON",
      (text) => ({ collect: () => new Response(text) }),
    ],
    [
      "the collect answers with JSON that is not a collect result",
      (text) => ({ collect: () => json({ json: { message: text } }) }),
    ],
    [
      "the generator prints text that is not JSON",
      (text) => ({ python: { stdout: text } }),
    ],
  ];
  it.each(SHORTENED)(
    "prints no part of the key when %s, wherever the key stands in the text",
    async (_name, setup) => {
      for (const offset of OFFSETS) {
        const result = await collectWith({ env, ...setup(echo(offset)) });
        const written = result.stderr + result.stdout;
        expect(result.code).toBe(1);
        // Not the key and not a piece of it: four characters of its start are enough to fail.
        expect(written).not.toContain(SECRET.slice(0, 4));
        expect(written).not.toContain(SECRET.slice(-4));
        if (offset <= 150) {
          expect(written).toContain("[key hidden]");
        }
      }
    }
  );

  it("prints no part of a key that ends the text", async () => {
    for (const filler of [0, 100, 268, 280, 299]) {
      const result = await collectWith({
        collect: () =>
          new Response(`${"x".repeat(filler)}${SECRET}`, { status: 403 }),
        env,
      });
      expect(result.stderr).not.toContain(SECRET.slice(0, 4));
    }
  });

  it("replaces the URL-encoded and the JSON-escaped form of the key", async () => {
    // Every part of this key changes in one of the two forms.
    const key = 'a/b+c d&e=f?"g"\\h\u00e9';
    const encoded = encodeURIComponent(key);
    const escaped = JSON.stringify(key).slice(1, -1);
    expect(new Set([key, encoded, escaped]).size).toBe(3);
    for (const offset of [0, 150, 280, 299]) {
      for (const form of [key, encoded, escaped]) {
        const result = await collectWith({
          collect: () => new Response(echo(offset, form), { status: 403 }),
          env: { VERTEX_AGENT_API_KEY: key },
        });
        expect(result.code).toBe(1);
        // The filler has no letter of the key, so any piece of a form would show here.
        expect(result.stderr).not.toMatch(/a\/b|a%2Fb|%20d|c d|\\"g|"g"|%22g/u);
        if (offset === 0) {
          expect(result.stderr).toBe(
            "golive collect failed: goLiveDrafts.collect returned HTTP 403: [key hidden] tail\n"
          );
        }
      }
    }
    // The server repeats the key inside JSON: the escaped form is in the answer text.
    const answered = await collectWith({
      collect: () => json({ json: { code: "FORBIDDEN", key } }, 403),
      env: { VERTEX_AGENT_API_KEY: key },
    });
    expect(answered.stderr).toBe(
      'golive collect failed: goLiveDrafts.collect returned HTTP 403: {"json":{"code":"FORBIDDEN","key":"[key hidden]"}}\n'
    );
    // The key in a redirect address or a query, as an error text can carry it.
    const failed = await collectWith({
      env: { VERTEX_AGENT_API_KEY: key },
      queue: () => Promise.reject(new Error(`GET /x?key=${encoded} failed`)),
    });
    expect(failed.stderr).toContain("GET /x?key=[key hidden] failed");
  });

  it("hides a key that has no URL-encoded form", async () => {
    // Half a surrogate pair cannot be URL-encoded; the run must not fail on it.
    const key = "lone-\ud800-surrogate-key";
    const result = await collectWith({
      env: { VERTEX_AGENT_API_KEY: key },
      queue: () => Promise.reject(new Error(`bad key ${key}`)),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("): bad key [key hidden]\n");
    expect(result.stderr).not.toContain("surrogate");
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
      body: JSON.stringify({
        json: { created: 2, expired: 0, unchanged: 0, updated: 0 },
      }),
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
            : { created: 1, expired: 4, unchanged: 3, updated: 2 },
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
      "stored: 1 created, 2 updated, 3 unchanged, 4 expired"
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
    ...[
      "https://x@evil.example",
      "https://vertex.example@evil.example",
      "https://user:pw-0f-user@vertex.example",
      "https://:pw-0f-user@vertex.example",
      "http://user@127.0.0.1:3000",
    ].map((origin): [Record<string, string>, string] => [
      { VERTEX_ORIGIN: origin },
      "VERTEX_ORIGIN must not carry a user name or a password; no request was made\n",
    ]),
    ...[
      "https://vertex.example/drafts",
      "https://vertex.example/drafts/",
      "https://vertex.example//",
      "https://vertex.example/api/orpc",
      "https://vertex.example?x=1",
      "https://vertex.example/?x=1",
      "https://vertex.example#drafts",
      "https://vertex.example/#drafts",
      "http://localhost:3000/x",
      "http://[::1]:3000/x",
    ].map((origin): [Record<string, string>, string] => [
      { VERTEX_ORIGIN: origin },
      "VERTEX_ORIGIN must be an origin (scheme://host[:port]) without a path, a query or a fragment; no request was made\n",
    ]),
    // A text the URL parser rewrites: the request would go to another address than the one read.
    ...(
      [
        ["http://127.1", "http://127.0.0.1"],
        ["http://2130706433", "http://127.0.0.1"],
        ["http://0x7f.1", "http://127.0.0.1"],
        ["http://0177.0.0.1", "http://127.0.0.1"],
        ["http://127.0.0.1.", "http://127.0.0.1"],
        ["http://[0:0:0:0:0:0:0:1]", "http://[::1]"],
        ["http://[::0001]:3000", "http://[::1]:3000"],
        ["http://LOCALHOST:3000", "http://localhost:3000"],
        ["http://localhost:80", "http://localhost"],
        ["https://Vertex.Example", "https://vertex.example"],
        ["HTTPS://vertex.example", "https://vertex.example"],
        ["https://vertex.example:443", "https://vertex.example"],
        ["https://%76ertex.example", "https://vertex.example"],
        ["https://ver\ttex.example", "https://vertex.example"],
        [" https://vertex.example", "https://vertex.example"],
        ["https:vertex.example", "https://vertex.example"],
        ["https:/vertex.example", "https://vertex.example"],
        ["https://vertex.example/.", "https://vertex.example"],
        ["https://vertex.example/?", "https://vertex.example"],
        ["https://vertex.example/#", "https://vertex.example"],
        ["https://@vertex.example", "https://vertex.example"],
        ["https://:@vertex.example", "https://vertex.example"],
      ] as const
    ).map(([origin, read]): [Record<string, string>, string] => [
      { VERTEX_ORIGIN: origin },
      `VERTEX_ORIGIN is not written in its plain form: the URL parser reads it as ${read}. Write exactly that if it is the address you mean; no request was made\n`,
    ]),
    ...["http://localhost.", "http://localhost.:3000", "http://[::2]"].map(
      (origin): [Record<string, string>, string] => [
        { VERTEX_ORIGIN: origin },
        "VERTEX_ORIGIN must be an https URL (http is accepted for 127.0.0.1, ::1 and localhost only); no request was made\n",
      ]
    ),
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
      expect(result.stderr).not.toContain("pw-0f-user");
      expect(result.fetched).toEqual([]);
      expect(result.ran).toEqual([]);
    }
  );

  it.each([
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://vertex.example", "https://vertex.example"],
    ["https://vertex.example/", "https://vertex.example"],
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
      env: { VERTEX_ORIGIN: `${ORIGIN}/` },
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
        maxOutputBytes: 1_000_000,
        stdin: "plan",
        timeoutMs: 30_000,
      }
    );
    expect(result).toEqual({
      code: 4,
      overflow: null,
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
      maxOutputBytes: 1_000_000,
      stdin: "x".repeat(4 * 1024 * 1024),
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      code: 0,
      overflow: null,
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
      maxOutputBytes: 1_000_000,
      stdin: "",
      timeoutMs: 30_000,
    };
    expect(await runProcess("sh", ["-c", "kill -9 $$"], options)).toEqual({
      code: 1,
      overflow: null,
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
        maxOutputBytes: 1_000_000,
        stdin: "",
        timeoutMs: 300,
      }
    );
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.each([
    ["stdout", "yes 0123456789"],
    ["stderr", "yes 0123456789 >&2"],
    // The command starts a second process that keeps writing after the kill.
    ["stdout", "yes 0123456789 & yes 0123456789"],
  ] as const)(
    "kills a command that never stops writing to %s once it passes the output limit (%s)",
    async (stream, script) => {
      const started = Date.now();
      const result = await runProcess("sh", ["-c", script], {
        cwd: tmpdir(),
        env: { PATH: process.env["PATH"] ?? "" },
        maxOutputBytes: 200_000,
        stdin: "",
        timeoutMs: 30_000,
      });
      expect(result.overflow).toBe(stream);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      expect(result.code).toBe(1);
      // What was kept is never more than the limit.
      expect(Buffer.byteLength(result[stream])).toBeLessThanOrEqual(200_000);
      expect(Date.now() - started).toBeLessThan(10_000);
    }
  );

  it("stops a command that prints more than the limit of a real run and then exits", async () => {
    const options = {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "" },
      maxOutputBytes: GOLIVE_GENERATOR_OUTPUT_MAX_BYTES,
      stdin: "",
      timeoutMs: 30_000,
    };
    const over = await runProcess(
      "sh",
      ["-c", `head -c ${GOLIVE_GENERATOR_OUTPUT_MAX_BYTES + 1} /dev/zero`],
      options
    );
    expect(over.overflow).toBe("stdout");
    expect(Buffer.byteLength(over.stdout)).toBeLessThanOrEqual(
      GOLIVE_GENERATOR_OUTPUT_MAX_BYTES
    );
    // Exactly the limit is not over it.
    const full = await runProcess(
      "sh",
      ["-c", `head -c ${GOLIVE_GENERATOR_OUTPUT_MAX_BYTES} /dev/zero`],
      options
    );
    expect(full.overflow).toBeNull();
    expect(full.code).toBe(0);
    expect(full.stdout).toHaveLength(GOLIVE_GENERATOR_OUTPUT_MAX_BYTES);
  });

  it("counts the output limit in bytes, each stream by itself", async () => {
    const run = (maxOutputBytes: number) =>
      runProcess("sh", ["-c", "printf 'ééé'; printf 'abcdef' >&2"], {
        cwd: tmpdir(),
        env: { PATH: process.env["PATH"] ?? "" },
        maxOutputBytes,
        stdin: "",
        timeoutMs: 30_000,
      });
    // Three letters of two bytes each on stdout, six bytes on stderr.
    expect(await run(6)).toMatchObject({
      code: 0,
      overflow: null,
      stderr: "abcdef",
      stdout: "ééé",
    });
    expect((await run(5)).overflow).not.toBeNull();
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
