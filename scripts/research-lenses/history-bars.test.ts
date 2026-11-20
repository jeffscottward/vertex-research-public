import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  afterClose,
  cacheName,
  createHistoryReader,
  fillBeforeDay,
  type HistoryBar,
  historyBarsUrl,
  historyConfig,
  IBKR_BUDGET_ENV,
  IBKR_BUDGET_MINUTES,
  IBKR_GAP_MS,
  IBKR_MAX_FAILURES,
  IBKR_PACED_TRIES,
  ibkrBudgetMinutes,
  ibkrSymbol,
  lensDay,
  type MergedBarsPlan,
  mergeBars,
  parseHistoryBars,
  requestHistoryBars,
  type SeriesSource,
  seriesSource,
  sourceCounts,
  sourceLabel,
} from "./history-bars.ts";
import {
  EVENING,
  HISTORY_ENV,
  historyAnswer,
  isHistoryUrl,
  jsonResponse,
  testIo,
} from "./lens.test-support.ts";
import { dig, field, type LensFetch } from "./lens-io.ts";

const TOKEN = HISTORY_ENV.VERTEX_DEPLOY_STATUS_TOKEN;
const CONFIG = { token: TOKEN, url: "https://history.test" };
const BARS_URL =
  "https://history.test/bars?barSize=1+day&currency=USD&duration=7+M&secType=STK&symbol=AAPL&useRTH=1&whatToShow=ADJUSTED_LAST";

type Close = Readonly<{ date: string; close: number }>;

const day = (date: string, close = 1): Close => ({ close, date });

/** A plan whose Yahoo read returns `yahoo` (or throws it) and counts its calls. */
const planFor = (
  symbol: string,
  yahoo: readonly Close[] | Error = [day("2026-11-09", 9)],
  fillBefore = "2026-11-08"
): Readonly<{ plan: MergedBarsPlan<Close>; yahooCalls: () => number }> => {
  let calls = 0;
  return {
    plan: {
      duration: "7 M",
      fillBefore,
      fromIbkr: (bar: HistoryBar) => ({ close: bar.close, date: bar.date }),
      symbol,
      yahoo: async () => {
        calls += 1;
        if (yahoo instanceof Error) throw yahoo;
        return yahoo;
      },
    },
    yahooCalls: () => calls,
  };
};

/** IBKR answers per symbol: closes (bars ending 2026-11-09), an HTTP status, or an error to throw. */
const historyFetch =
  (
    answers: Readonly<
      Record<string, readonly number[] | number | Error | (() => Response)>
    >
  ): LensFetch =>
  async (url) => {
    const symbol = new URL(url).searchParams.get("symbol") ?? "";
    const answer = answers[symbol] ?? 500;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    if (typeof answer === "number") return jsonResponse({}, answer);
    return jsonResponse(historyAnswer(url, answer));
  };

describe("historyConfig", () => {
  it("accepts an https address or http on a loopback host, trimmed", () => {
    expect(
      historyConfig({
        VERTEX_DEPLOY_STATUS_TOKEN: ` ${TOKEN} `,
        VERTEX_HISTORY_URL: " https://history.test/ ",
      })
    ).toEqual({ token: TOKEN, url: "https://history.test/" });
    for (const url of [
      "http://127.0.0.1:8791",
      "http://localhost:8791",
      "http://[::1]:8791",
    ])
      expect(
        historyConfig({
          VERTEX_DEPLOY_STATUS_TOKEN: TOKEN,
          VERTEX_HISTORY_URL: url,
        })
      ).toEqual({ token: TOKEN, url });
  });

  it("is not configured when a value is missing or not acceptable", () => {
    expect(historyConfig({})).toBeNull();
    expect(historyConfig({ VERTEX_DEPLOY_STATUS_TOKEN: TOKEN })).toBeNull();
    expect(
      historyConfig({ VERTEX_HISTORY_URL: "https://history.test" })
    ).toBeNull();
    expect(
      historyConfig({
        VERTEX_DEPLOY_STATUS_TOKEN: "short",
        VERTEX_HISTORY_URL: "https://history.test",
      })
    ).toBeNull();
    for (const url of [
      " ",
      "not a url",
      "http://history.test",
      "ftp://127.0.0.1",
      "https://user@history.test",
      "https://user:pass@history.test",
      "https://:pass@history.test",
    ])
      expect(
        historyConfig({
          VERTEX_DEPLOY_STATUS_TOKEN: TOKEN,
          VERTEX_HISTORY_URL: url,
        }),
        url
      ).toBeNull();
  });
});

describe("ibkrSymbol", () => {
  it("keeps plain tickers and writes class shares with a space", () => {
    expect(ibkrSymbol(" aapl ")).toBe("AAPL");
    for (const symbol of ["BRK.B", "BRK-B", "BRK/B", "brk b"])
      expect(ibkrSymbol(symbol)).toBe("BRK B");
  });

  it("has no IBKR form for indices, crypto pairs, futures and odd text", () => {
    for (const symbol of ["^GSPC", "BTC-USD", "ES=F", "BRK.BB", "1A", ""])
      expect(ibkrSymbol(symbol), symbol).toBeNull();
  });
});

describe("historyBarsUrl", () => {
  it("asks for adjusted regular-hours daily bars of a US stock", () => {
    expect(historyBarsUrl("https://history.test//", "AAPL", "7 M")).toBe(
      BARS_URL
    );
    expect(historyBarsUrl("http://127.0.0.1:8791", "BRK B", "1 Y")).toBe(
      "http://127.0.0.1:8791/bars?barSize=1+day&currency=USD&duration=1+Y&secType=STK&symbol=BRK+B&useRTH=1&whatToShow=ADJUSTED_LAST"
    );
  });
});

describe("parseHistoryBars", () => {
  it("returns bars ascending by date with volume in shares", () => {
    const document = historyAnswer(BARS_URL, [10, 11, 12]);
    (document["bars"] as unknown[]).reverse();
    expect(parseHistoryBars(document, "AAPL", "7 M")).toEqual({
      bars: [
        { close: 10, date: "2026-11-07", volume: 1_000_000 },
        { close: 11, date: "2026-11-08", volume: 1_000_000 },
        { close: 12, date: "2026-11-09", volume: 1_000_000 },
      ],
      cached: false,
      stale: false,
    });
  });

  it("keeps a missing volume and drops bars without a positive close", () => {
    expect(
      parseHistoryBars(
        historyAnswer(BARS_URL, [10, 0, -1, 12], {
          endDay: "2026-11-06",
          volume: null,
        }),
        "AAPL",
        "7 M"
      ).bars
    ).toEqual([
      { close: 10, date: "2026-11-03", volume: null },
      { close: 12, date: "2026-11-06", volume: null },
    ]);
  });

  it("rejects a vertex-history-bars-v1 answer (Yahoo serves the symbol)", () => {
    const document = historyAnswer(BARS_URL, [10, 11]);
    document["schema"] = "vertex-history-bars-v1";
    delete document["volume_unit"];
    expect(() => parseHistoryBars(document, "AAPL", "7 M")).toThrow(
      "IBKR history answered vertex-history-bars-v1 (old service): not used"
    );
  });

  it("keeps volume only for the units shares and contracts", () => {
    const volumes = (unit: unknown): (number | null)[] => {
      const document = historyAnswer(BARS_URL, [10]);
      document["volume_unit"] = unit;
      return parseHistoryBars(document, "AAPL", "7 M").bars.map(
        (bar) => bar.volume
      );
    };
    expect(volumes("shares")).toEqual([1_000_000]);
    expect(volumes("contracts")).toEqual([1_000_000]);
    expect(volumes("unqualified")).toEqual([null]);
    expect(volumes(null)).toEqual([null]);
  });

  it("rejects a document that is not the answer to the request", () => {
    const broken: [string, (document: Record<string, unknown>) => void][] = [
      [
        "schema",
        (d) => {
          d["schema"] = "vertex-history-ticks-v1";
        },
      ],
      [
        "volume unit missing",
        (d) => {
          delete d["volume_unit"];
        },
      ],
      [
        "volume unit unknown",
        (d) => {
          d["volume_unit"] = "lots";
        },
      ],
      [
        "later schema",
        (d) => {
          d["schema"] = "vertex-history-bars-v3";
        },
      ],
      [
        "source",
        (d) => {
          d["source"] = "yahoo";
        },
      ],
      [
        "cache",
        (d) => {
          d["cache"] = {};
        },
      ],
      [
        "cache hit",
        (d) => {
          d["cache"] = { hit: "no", stale: false };
        },
      ],
      [
        "echo symbol",
        (d) => {
          (d["request"] as Record<string, unknown>)["symbol"] = "MSFT";
        },
      ],
      [
        "echo whatToShow",
        (d) => {
          (d["request"] as Record<string, unknown>)["whatToShow"] = "TRADES";
        },
      ],
      [
        "bars",
        (d) => {
          d["bars"] = "none";
        },
      ],
      [
        "too many bars",
        (d) => {
          d["bars"] = Array.from({ length: 20_001 }, (_, t) => ({
            c: 1,
            t,
            v: 1,
          }));
          d["count"] = 20_001;
        },
      ],
      [
        "count",
        (d) => {
          d["count"] = 9;
        },
      ],
      ...[
        { c: 1, t: 1.5, v: 1 },
        { c: "1", t: 1, v: 1 },
        { c: Number.NaN, t: 1, v: 1 },
        { c: 1, t: 1, v: -1 },
        { c: 1, t: 1, v: "1" },
        { c: 1, t: 1 },
        null,
      ].map((bar, i): [string, (d: Record<string, unknown>) => void] => [
        `bar ${i}`,
        (d) => {
          d["bars"] = [bar];
          d["count"] = 1;
        },
      ]),
    ];
    for (const [name, change] of broken) {
      const document = historyAnswer(BARS_URL, [10, 11]);
      change(document);
      expect(() => parseHistoryBars(document, "AAPL", "7 M"), name).toThrow(
        "IBKR history response failed validation"
      );
    }
    for (const document of [null, "text", []])
      expect(() => parseHistoryBars(document, "AAPL", "7 M")).toThrow(
        "IBKR history response failed validation"
      );
    expect(() =>
      parseHistoryBars(historyAnswer(BARS_URL, [10]), "AAPL", "1 Y")
    ).toThrow("IBKR history response failed validation");
  });

  it("reports the service's cache hit and stale copy", () => {
    expect(
      parseHistoryBars(
        historyAnswer(BARS_URL, [10], { hit: true, stale: true }),
        "AAPL",
        "7 M"
      )
    ).toMatchObject({ cached: true, stale: true });
  });
});

// The sample answers shared with the web and Python readers; "v2only" is this reader's rule.
const ANSWERS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../packages/api/src/fixtures/history-answers"
);

const EXPECTED: unknown = JSON.parse(
  readFileSync(join(ANSWERS_DIR, "expected.json"), "utf8")
);

/** The expected "v2only" read of one sample: null when rejected, else its volumes. */
const expectedVolumes = (name: string): unknown[] | null => {
  const read = dig(EXPECTED, "cases", name, "v2only");
  const accepted = field(read, "accepted");
  const volumes = field(read, "volumes");
  if (accepted === false) return null;
  if (accepted !== true || !Array.isArray(volumes))
    throw new Error(`expected.json has no v2only case for ${name}`);
  return volumes;
};

describe("parseHistoryBars with the shared sample answers", () => {
  const names = readdirSync(ANSWERS_DIR)
    .filter((file) => file.startsWith("bars-") && file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();

  it("finds every sample answer", () => {
    expect(names.length).toBe(8);
  });

  it.each(names)("%s: accepted and volumes as expected.json v2only", (name) => {
    const sample: unknown = JSON.parse(
      readFileSync(join(ANSWERS_DIR, `${name}.json`), "utf8")
    );
    // This reader asks only for adjusted US stock bars: the request echo is set to that request,
    // so the sample's schema, unit and bars decide the result.
    const document = {
      ...(typeof sample === "object" && sample !== null ? sample : {}),
      request: {
        barSize: "1 day",
        currency: "USD",
        duration: "7 M",
        secType: "STK",
        symbol: "AAPL",
        useRTH: true,
        whatToShow: "ADJUSTED_LAST",
      },
    };
    const expected = expectedVolumes(name);
    if (expected === null) {
      expect(() => parseHistoryBars(document, "AAPL", "7 M")).toThrow();
      return;
    }
    expect(
      parseHistoryBars(document, "AAPL", "7 M").bars.map((bar) => bar.volume)
    ).toEqual(expected);
  });
});

describe("requestHistoryBars", () => {
  it("sends one GET with the bearer token and never follows a redirect", async () => {
    const inits: RequestInit[] = [];
    const { io, requests } = testIo({
      fetch: async (url, init) => {
        inits.push(init);
        return jsonResponse(historyAnswer(url, [10, 11]));
      },
    });
    expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
      bars: [
        { close: 10, date: "2026-11-08", volume: 1_000_000 },
        { close: 11, date: "2026-11-09", volume: 1_000_000 },
      ],
      cached: false,
      kind: "bars",
    });
    expect(requests).toEqual([BARS_URL]);
    expect(inits[0]).toMatchObject({
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      method: "GET",
      redirect: "manual",
    });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("counts a vertex-history-bars-v1 answer as an IBKR failure", async () => {
    const { io } = testIo({
      fetch: async (url) => {
        const document = historyAnswer(url, [10, 11]);
        document["schema"] = "vertex-history-bars-v1";
        delete document["volume_unit"];
        return jsonResponse(document);
      },
    });
    expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
      kind: "fail",
      message:
        "IBKR history answered vertex-history-bars-v1 (old service): not used",
    });
  });

  it("reports the service's cache hit", async () => {
    const { io } = testIo({
      fetch: async (url) =>
        jsonResponse(historyAnswer(url, [10], { hit: true })),
    });
    expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toMatchObject({
      cached: true,
      kind: "bars",
    });
  });

  it("answers wait for paced, busy and a stale copy, with the service's retry time", async () => {
    const cases: [() => Response, unknown][] = [
      [
        () => jsonResponse({ error: "paced", retry_after_seconds: 71 }, 429),
        {
          kind: "wait",
          message: "IBKR history HTTP 429 (paced), retry in 71 s",
          seconds: 71,
        },
      ],
      [
        () =>
          new Response(JSON.stringify({ error: "busy" }), {
            headers: { "retry-after": "9.2" },
            status: 429,
          }),
        {
          kind: "wait",
          message: "IBKR history HTTP 429 (busy), retry in 10 s",
          seconds: 10,
        },
      ],
      [
        () => jsonResponse({ error: "paced", retry_after_seconds: 0 }, 429),
        {
          kind: "wait",
          message: "IBKR history HTTP 429 (paced)",
          seconds: null,
        },
      ],
      [
        () =>
          jsonResponse(
            historyAnswer(BARS_URL, [10], { hit: true, stale: true })
          ),
        {
          kind: "wait",
          message: "IBKR history answered with a stale copy (service paced)",
          seconds: null,
        },
      ],
    ];
    for (const [response, expected] of cases) {
      const { io, requests, sleeps } = testIo({
        fetch: async () => response(),
      });
      expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual(
        expected
      );
      expect(requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("answers stop for a pacing violation, an unknown 429 and a refused token", async () => {
    const cases: [Response, string][] = [
      [
        jsonResponse(
          { error: "pacing_violation", retry_after_seconds: 600 },
          429
        ),
        "IBKR history HTTP 429 (pacing_violation), retry in 600 s",
      ],
      [new Response("<html>", { status: 429 }), "IBKR history HTTP 429"],
      [
        jsonResponse({ error: "paced", retry_after_seconds: 600 }, 429),
        "IBKR history HTTP 429 (paced), retry in 600 s",
      ],
      [
        jsonResponse({ error: "unauthorized" }, 401),
        "IBKR history HTTP 401 (unauthorized)",
      ],
      [new Response("forbidden", { status: 403 }), "IBKR history HTTP 403"],
    ];
    for (const [response, message] of cases) {
      const { io } = testIo({ fetch: async () => response });
      expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
        kind: "stop",
        message,
      });
    }
  });

  it("answers reject for a 4xx about the symbol itself", async () => {
    const cases: [Response, string][] = [
      [
        jsonResponse(
          { error: "no_contract", ibkr_code: 200, message: "free text" },
          422
        ),
        "IBKR history HTTP 422 (no_contract)",
      ],
      [
        jsonResponse({ error: "bad_request" }, 400),
        "IBKR history HTTP 400 (bad_request)",
      ],
    ];
    for (const [response, message] of cases) {
      const { io } = testIo({ fetch: async () => response });
      expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
        kind: "reject",
        message,
      });
    }
  });

  it("answers fail for other statuses, by status and error kind only", async () => {
    const answers: [Response, string][] = [
      [
        jsonResponse({ error: "unavailable", retry_after_seconds: 30 }, 503),
        "IBKR history HTTP 503 (unavailable)",
      ],
      [
        jsonResponse({ error: "Free text, not a kind" }, 502),
        "IBKR history HTTP 502",
      ],
      [jsonResponse({ error: 7 }, 500), "IBKR history HTTP 500"],
      [new Response("<html>", { status: 302 }), "IBKR history HTTP 302"],
    ];
    for (const [response, message] of answers) {
      const { io } = testIo({ fetch: async () => response });
      expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
        kind: "fail",
        message,
      });
    }
  });

  it("answers fail for a failed or timed out request without the runtime's message", async () => {
    const failed = testIo({
      fetch: async (url) => {
        throw new Error(`cannot reach ${url} with ${TOKEN}`);
      },
    });
    expect(await requestHistoryBars(failed.io, CONFIG, "AAPL", "7 M")).toEqual({
      kind: "fail",
      message: "IBKR history request failed",
    });
    const timedOut = testIo({
      fetch: async () => {
        throw Object.assign(new Error("signal timed out"), {
          name: "TimeoutError",
        });
      },
    });
    expect(
      await requestHistoryBars(timedOut.io, CONFIG, "AAPL", "7 M")
    ).toEqual({ kind: "fail", message: "IBKR history request timed out" });
  });

  it("answers fail for a 200 answer that is not JSON or not the answer", async () => {
    for (const response of [
      new Response("<html>"),
      jsonResponse({ schema: "other" }),
    ]) {
      const { io } = testIo({ fetch: async () => response });
      expect(await requestHistoryBars(io, CONFIG, "AAPL", "7 M")).toEqual({
        kind: "fail",
        message: "IBKR history response failed validation",
      });
    }
  });

  it("never puts the token in a message, even when the service echoes it", async () => {
    const token = "secret_token_that_looks_like_a_kind";
    const { io } = testIo({
      fetch: async () => jsonResponse({ error: token }, 500),
    });
    expect(
      await requestHistoryBars(
        io,
        { token, url: "https://history.test" },
        "AAPL",
        "7 M"
      )
    ).toEqual({ kind: "fail", message: "IBKR history HTTP 500 ([redacted])" });
  });
});

describe("mergeBars", () => {
  it("tags IBKR bars when IBKR serves the series", () => {
    expect(mergeBars([day("2026-11-06"), day("2026-11-09")], [])).toEqual([
      { close: 1, date: "2026-11-06", source: "ibkr" },
      { close: 1, date: "2026-11-09", source: "ibkr" },
    ]);
  });

  it("tags the Yahoo series when IBKR has no bars", () => {
    expect(mergeBars([], [day("2026-11-06", 5), day("2026-11-09", 6)])).toEqual(
      [
        { close: 5, date: "2026-11-06", source: "yahoo" },
        { close: 6, date: "2026-11-09", source: "yahoo" },
      ]
    );
    expect(mergeBars([], [])).toEqual([]);
  });

  it("takes only the days before IBKR's oldest bar from Yahoo, never interleaved", () => {
    const ibkr = [day("2026-11-04", 1), day("2026-11-09", 2)];
    const yahoo = [
      day("2026-11-02", 50),
      day("2026-11-03", 51),
      // The same day as IBKR's oldest bar, a day inside IBKR's range that IBKR lacks, and a newer day.
      day("2026-11-04", 52),
      day("2026-11-05", 53),
      day("2026-11-10", 54),
    ];
    const merged = mergeBars(ibkr, yahoo);
    expect(merged).toEqual([
      { close: 50, date: "2026-11-02", source: "yahoo" },
      { close: 51, date: "2026-11-03", source: "yahoo" },
      { close: 1, date: "2026-11-04", source: "ibkr" },
      { close: 2, date: "2026-11-09", source: "ibkr" },
    ]);
    expect(merged.map((bar) => bar.source).join(",")).toMatch(
      /^(yahoo,)*(ibkr,?)+$/
    );
  });
});

describe("fillBeforeDay", () => {
  it("is the window start plus five days of weekend and holiday slack", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    expect(fillBeforeDay(now, 365)).toBe("2025-11-15");
    expect(fillBeforeDay(now, 210)).toBe("2026-04-19");
  });
});

describe("lensDay", () => {
  it("is the New York date, also after the UTC day rolls over", () => {
    expect(lensDay(new Date("2026-11-16T23:59:00Z"))).toBe("2026-11-16");
    expect(lensDay(new Date("2026-11-17T00:01:00Z"))).toBe("2026-11-16");
    expect(lensDay(new Date("2026-11-17T04:59:00Z"))).toBe("2026-11-16");
    expect(lensDay(new Date("2026-11-17T05:00:00Z"))).toBe("2026-11-17");
    // Summer: UTC-4.
    expect(lensDay(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
  });
});

describe("afterClose", () => {
  it("is true from 16:15 New York time to midnight", () => {
    expect(afterClose(new Date("2026-11-16T21:14:00Z"))).toBe(false);
    expect(afterClose(new Date("2026-11-16T21:15:00Z"))).toBe(true);
    expect(afterClose(new Date("2026-11-17T04:59:00Z"))).toBe(true);
    expect(afterClose(new Date("2026-11-17T05:00:00Z"))).toBe(false);
    expect(afterClose(new Date("2026-07-01T20:15:00Z"))).toBe(true);
  });
});

describe("ibkrBudgetMinutes", () => {
  it("reads a whole number of minutes from 0 to 75, else the default when unset", () => {
    expect(IBKR_BUDGET_MINUTES).toBe(75);
    expect(ibkrBudgetMinutes({})).toBe(75);
    expect(ibkrBudgetMinutes({ [IBKR_BUDGET_ENV]: " " })).toBe(75);
    expect(ibkrBudgetMinutes({ [IBKR_BUDGET_ENV]: "0" })).toBe(0);
    expect(ibkrBudgetMinutes({ [IBKR_BUDGET_ENV]: " 30 " })).toBe(30);
    expect(ibkrBudgetMinutes({ [IBKR_BUDGET_ENV]: "75" })).toBe(75);
    for (const raw of ["76", "-1", "1.5", "x", "1000"])
      expect(ibkrBudgetMinutes({ [IBKR_BUDGET_ENV]: raw }), raw).toBeNull();
  });
});

/** Symbols of the IBKR requests, in order. */
const asked = (requests: readonly string[]): (string | null)[] =>
  requests.map((url) => new URL(url).searchParams.get("symbol"));

describe("createHistoryReader", () => {
  it("makes no IBKR request without the service address and token", async () => {
    for (const env of [
      {},
      { VERTEX_HISTORY_URL: "https://history.test" },
      { VERTEX_DEPLOY_STATUS_TOKEN: TOKEN },
      { VERTEX_DEPLOY_STATUS_TOKEN: "", VERTEX_HISTORY_URL: "" },
    ]) {
      const { io, requests, stderr } = testIo({ env });
      const reader = createHistoryReader(io, ["AAPL"]);
      const { plan, yahooCalls } = planFor("AAPL");
      expect(reader.configured).toBe(false);
      expect(await reader.load(plan)).toEqual([
        { close: 9, date: "2026-11-09", source: "yahoo" },
      ]);
      expect(yahooCalls()).toBe(1);
      expect(requests).toEqual([]);
      expect(stderr).toEqual([]);
    }
  });

  it("says so once when both values are set but not acceptable", async () => {
    const { io, requests, stderr } = testIo({
      env: {
        VERTEX_DEPLOY_STATUS_TOKEN: TOKEN,
        VERTEX_HISTORY_URL: "http://history.test",
      },
    });
    const reader = createHistoryReader(io, ["AAPL", "MSFT"]);
    expect(reader.configured).toBe(false);
    await reader.load(planFor("AAPL").plan);
    await reader.load(planFor("MSFT").plan);
    expect(requests).toEqual([]);
    expect(stderr).toEqual([
      "2026-11-10T12:00:00.000Z IBKR history not used: VERTEX_HISTORY_URL must be https (or http on 127.0.0.1, localhost or [::1]) without credentials, and VERTEX_DEPLOY_STATUS_TOKEN at least 32 characters; Yahoo only\n",
    ]);
  });

  it("reads Yahoo only when the run budget is 0 or not acceptable, and says so", async () => {
    const cases: [string, string][] = [
      ["0", "IBKR history off: LENS_IBKR_BUDGET_MINUTES is 0; Yahoo only"],
      [
        "x",
        "IBKR history not used: LENS_IBKR_BUDGET_MINUTES must be a whole number of minutes from 0 to 75; Yahoo only",
      ],
    ];
    for (const [budget, line] of cases) {
      const { io, requests, stderr } = testIo({
        env: { ...HISTORY_ENV, [IBKR_BUDGET_ENV]: budget },
        fetch: historyFetch({ AAPL: [10, 11] }),
      });
      const reader = createHistoryReader(io, ["AAPL"]);
      expect(reader.configured).toBe(false);
      expect(seriesSource(await reader.load(planFor("AAPL").plan))).toBe(
        "yahoo"
      );
      expect(requests).toEqual([]);
      expect(stderr).toEqual([`2026-11-10T12:00:00.000Z ${line}\n`]);
    }
  });

  it("tags IBKR bars and does not read Yahoo when IBKR covers the window", async () => {
    const { io, requests, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11, 12] }),
    });
    const reader = createHistoryReader(io, ["AAPL"]);
    const { plan, yahooCalls } = planFor("AAPL");
    expect(reader.configured).toBe(true);
    expect(await reader.load(plan)).toEqual([
      { close: 10, date: "2026-11-07", source: "ibkr" },
      { close: 11, date: "2026-11-08", source: "ibkr" },
      { close: 12, date: "2026-11-09", source: "ibkr" },
    ]);
    expect(requests).toEqual([BARS_URL]);
    expect(yahooCalls()).toBe(0);
    expect(stderr).toEqual([]);
  });

  it("asks IBKR only for the listed names, in any case and spacing", async () => {
    const { io, requests } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11], MSFT: [10, 11] }),
    });
    const reader = createHistoryReader(io, [" aapl "]);
    expect(seriesSource(await reader.load(planFor("AAPL").plan))).toBe("ibkr");
    const { plan, yahooCalls } = planFor("MSFT");
    expect(seriesSource(await reader.load(plan))).toBe("yahoo");
    expect(yahooCalls()).toBe(1);
    expect(asked(requests)).toEqual(["AAPL"]);
    expect(createHistoryReader(io).configured).toBe(true);
  });

  it("asks IBKR for a class share with a space", async () => {
    const { io, requests } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ "BRK B": [10, 11] }),
    });
    const bars = await createHistoryReader(io, ["BRK.B"]).load(
      planFor("BRK.B").plan
    );
    expect(bars.map((bar) => bar.source)).toEqual(["ibkr", "ibkr"]);
    expect(asked(requests)).toEqual(["BRK B"]);
  });

  it("serves the whole series from Yahoo when IBKR fails, and logs why", async () => {
    const { io, requests, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: 503 }),
    });
    const { plan, yahooCalls } = planFor("AAPL", [
      day("2026-11-06", 5),
      day("2026-11-09", 6),
    ]);
    expect(await createHistoryReader(io, ["AAPL"]).load(plan)).toEqual([
      { close: 5, date: "2026-11-06", source: "yahoo" },
      { close: 6, date: "2026-11-09", source: "yahoo" },
    ]);
    expect(requests).toHaveLength(1);
    expect(yahooCalls()).toBe(1);
    expect(stderr).toEqual([
      "2026-11-10T12:00:00.000Z AAPL: IBKR history HTTP 503; Yahoo serves this symbol\n",
    ]);
  });

  it("serves the whole series from Yahoo when IBKR sends no bars", async () => {
    const { io, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [] }),
    });
    expect(
      await createHistoryReader(io, ["AAPL"]).load(planFor("AAPL").plan)
    ).toEqual([{ close: 9, date: "2026-11-09", source: "yahoo" }]);
    expect(stderr).toEqual([]);
  });

  it("fills only the days before IBKR's first bar when IBKR starts late", async () => {
    const { io } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11] }),
    });
    const { plan, yahooCalls } = planFor(
      "AAPL",
      [
        day("2026-11-05", 50),
        day("2026-11-06", 51),
        day("2026-11-08", 52),
        day("2026-11-09", 53),
      ],
      "2026-11-05"
    );
    expect(await createHistoryReader(io, ["AAPL"]).load(plan)).toEqual([
      { close: 50, date: "2026-11-05", source: "yahoo" },
      { close: 51, date: "2026-11-06", source: "yahoo" },
      { close: 10, date: "2026-11-08", source: "ibkr" },
      { close: 11, date: "2026-11-09", source: "ibkr" },
    ]);
    expect(yahooCalls()).toBe(1);
  });

  it("keeps the IBKR bars when the read of the older days fails", async () => {
    const { io } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11] }),
    });
    const { plan } = planFor("AAPL", new Error("Yahoo HTTP 500"), "2026-11-05");
    expect(await createHistoryReader(io, ["AAPL"]).load(plan)).toEqual([
      { close: 10, date: "2026-11-08", source: "ibkr" },
      { close: 11, date: "2026-11-09", source: "ibkr" },
    ]);
  });

  it("throws the job's Yahoo error when neither source has the series", async () => {
    const { io } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: 500 }),
    });
    const { plan } = planFor("AAPL", new Error("Yahoo HTTP 500"));
    await expect(createHistoryReader(io, ["AAPL"]).load(plan)).rejects.toThrow(
      "Yahoo HTTP 500"
    );
  });

  it("reads Yahoo only for a listed symbol IBKR cannot serve", async () => {
    const { io, requests, stderr } = testIo({ env: HISTORY_ENV });
    const bars = await createHistoryReader(io, ["^GSPC"]).load(
      planFor("^GSPC").plan
    );
    expect(bars).toEqual([{ close: 9, date: "2026-11-09", source: "yahoo" }]);
    expect(requests).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("waits IBKR_GAP_MS after an answer fetched from IBKR, and not after a cache hit", async () => {
    expect(IBKR_GAP_MS).toBe(40_000);
    const { io, requests, sleeps } = testIo({
      clock: true,
      env: HISTORY_ENV,
      fetch: async (url) => {
        const symbol = new URL(url).searchParams.get("symbol");
        return jsonResponse(
          historyAnswer(url, [10, 11], { hit: symbol === "B" })
        );
      },
    });
    const reader = createHistoryReader(io, ["A", "B", "C", "D"]);
    for (const symbol of ["A", "B", "C", "D"])
      expect(seriesSource(await reader.load(planFor(symbol).plan))).toBe(
        "ibkr"
      );
    // A fetched: B waits. B was a cache hit: C does not wait. C fetched: D waits.
    expect(asked(requests)).toEqual(["A", "B", "C", "D"]);
    expect(sleeps).toEqual([40_000, 40_000]);
  });

  it("waits the service's retry time on paced and busy answers and asks again", async () => {
    let calls = 0;
    const { io, requests, sleeps, stderr } = testIo({
      clock: true,
      env: HISTORY_ENV,
      fetch: async (url) => {
        calls += 1;
        if (calls === 1)
          return jsonResponse({ error: "paced", retry_after_seconds: 71 }, 429);
        if (calls === 2) return jsonResponse({ error: "busy" }, 429);
        return jsonResponse(historyAnswer(url, [10, 11]));
      },
    });
    const { plan, yahooCalls } = planFor("AAPL");
    const bars = await createHistoryReader(io, ["AAPL"]).load(plan);
    expect(seriesSource(bars)).toBe("ibkr");
    expect(yahooCalls()).toBe(0);
    expect(requests).toHaveLength(3);
    // 71 s from the service, then the gap when the service names no time.
    expect(sleeps).toEqual([71_000, 40_000]);
    expect(stderr).toEqual([]);
  });

  it("serves a symbol from Yahoo after IBKR_PACED_TRIES answers to wait", async () => {
    expect(IBKR_PACED_TRIES).toBe(3);
    const { io, requests, sleeps, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({
        A: () => jsonResponse({ error: "paced", retry_after_seconds: 5 }, 429),
        B: [10, 11],
      }),
    });
    const reader = createHistoryReader(io, ["A", "B"]);
    expect(seriesSource(await reader.load(planFor("A").plan))).toBe("yahoo");
    expect(seriesSource(await reader.load(planFor("B").plan))).toBe("ibkr");
    expect(asked(requests)).toEqual(["A", "A", "A", "B"]);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(stderr).toEqual([
      "2026-11-10T12:00:00.000Z A: IBKR history HTTP 429 (paced), retry in 5 s; 3 answers to wait; Yahoo serves this symbol\n",
    ]);
  });

  it("waits the gap after a failed request too", async () => {
    const { io, sleeps } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ A: 500, B: [10, 11] }),
    });
    const reader = createHistoryReader(io, ["A", "B"]);
    await reader.load(planFor("A").plan);
    await reader.load(planFor("B").plan);
    expect(sleeps).toEqual([40_000]);
  });

  it("stops IBKR for the run on a pacing violation or a refused token", async () => {
    for (const [answer, line] of [
      [
        () =>
          jsonResponse(
            { error: "pacing_violation", retry_after_seconds: 600 },
            429
          ),
        "A: IBKR history HTTP 429 (pacing_violation), retry in 600 s",
      ],
      [() => jsonResponse({}, 401), "A: IBKR history HTTP 401"],
    ] as const) {
      const { io, requests, stderr } = testIo({
        env: HISTORY_ENV,
        fetch: historyFetch({ A: answer, B: [10, 11] }),
      });
      const reader = createHistoryReader(io, ["A", "B"]);
      expect(seriesSource(await reader.load(planFor("A").plan))).toBe("yahoo");
      expect(seriesSource(await reader.load(planFor("B").plan))).toBe("yahoo");
      expect(asked(requests)).toEqual(["A"]);
      expect(stderr).toEqual([
        `2026-11-10T12:00:00.000Z IBKR history: ${line}; not asked again in this run, Yahoo serves the remaining symbols\n`,
      ]);
    }
  });

  it("stops asking IBKR after three failures in a row and says so", async () => {
    expect(IBKR_MAX_FAILURES).toBe(3);
    const symbols = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const { io, requests, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({
        A: 500,
        B: 502,
        C: [10, 11],
        D: new Error("offline"),
        E: 503,
        F: 502,
        G: [10, 11],
        H: [10, 11],
      }),
    });
    const reader = createHistoryReader(io, symbols);
    const sources: (SeriesSource | null)[] = [];
    for (const symbol of symbols)
      sources.push(seriesSource(await reader.load(planFor(symbol).plan)));
    // A success between failures starts the count again; after D, E and F nothing more is asked.
    expect(sources).toEqual([
      "yahoo",
      "yahoo",
      "ibkr",
      "yahoo",
      "yahoo",
      "yahoo",
      "yahoo",
      "yahoo",
    ]);
    expect(asked(requests)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(stderr).toEqual([
      "2026-11-10T12:00:00.000Z A: IBKR history HTTP 500; Yahoo serves this symbol\n",
      "2026-11-10T12:00:00.000Z B: IBKR history HTTP 502; Yahoo serves this symbol\n",
      "2026-11-10T12:00:00.000Z D: IBKR history request failed; Yahoo serves this symbol\n",
      "2026-11-10T12:00:00.000Z E: IBKR history HTTP 503; Yahoo serves this symbol\n",
      "2026-11-10T12:00:00.000Z F: IBKR history HTTP 502; Yahoo serves this symbol\n",
      "2026-11-10T12:00:00.000Z IBKR history: 3 failures in a row; not asked again in this run, Yahoo serves the remaining symbols\n",
    ]);
  });

  it("does not count a rejected symbol as a failure in a row", async () => {
    const symbols = ["A", "B", "C", "D", "E"];
    const { io, requests, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({
        A: 500,
        B: () => jsonResponse({ error: "no_contract" }, 422),
        C: 500,
        D: () => jsonResponse({ error: "no_contract" }, 422),
        E: [10, 11],
      }),
    });
    const reader = createHistoryReader(io, symbols);
    const sources: (SeriesSource | null)[] = [];
    for (const symbol of symbols)
      sources.push(seriesSource(await reader.load(planFor(symbol).plan)));
    expect(sources).toEqual(["yahoo", "yahoo", "yahoo", "yahoo", "ibkr"]);
    expect(asked(requests)).toEqual(symbols);
    expect(stderr[1]).toBe(
      "2026-11-10T12:00:00.000Z B: IBKR history HTTP 422 (no_contract); Yahoo serves this symbol\n"
    );
  });

  it("reads today's cached IBKR bars without a request, and stores new ones", async () => {
    expect(cacheName("BRK B", "1 Y")).toBe("BRK_B.1Y.json");
    const stored = [
      { close: 7, date: "2026-11-08", volume: 100 },
      { close: 8, date: "2026-11-09", volume: null },
    ];
    const { io, files, requests } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ MSFT: [10, 11] }),
      files: { "/day/AAPL.7M.json": JSON.stringify(stored) },
      start: EVENING,
    });
    const reader = createHistoryReader(io, ["AAPL", "MSFT"], "/day");
    const { plan, yahooCalls } = planFor("AAPL");
    expect(await reader.load(plan)).toEqual([
      { close: 7, date: "2026-11-08", source: "ibkr" },
      { close: 8, date: "2026-11-09", source: "ibkr" },
    ]);
    expect(yahooCalls()).toBe(0);
    expect(seriesSource(await reader.load(planFor("MSFT").plan))).toBe("ibkr");
    expect(asked(requests)).toEqual(["MSFT"]);
    expect(JSON.parse(files.get("/day/MSFT.7M.json") ?? "")).toEqual([
      { close: 10, date: "2026-11-08", volume: 1_000_000 },
      { close: 11, date: "2026-11-09", volume: 1_000_000 },
    ]);
  });

  it("keeps the IBKR bars when the day cache cannot be written", async () => {
    const { io, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11] }),
      start: EVENING,
    });
    const failing = {
      ...io,
      fs: {
        ...io.fs,
        writeFile: async () => {
          throw new Error("disk full");
        },
      },
    };
    const reader = createHistoryReader(failing, ["AAPL"], "/day");
    expect(seriesSource(await reader.load(planFor("AAPL").plan))).toBe("ibkr");
    expect(stderr).toEqual([
      "2026-11-10T22:00:00.000Z AAPL: IBKR day cache not written\n",
    ]);
  });

  it("stores no answer from the service's cache: it can predate the close", async () => {
    const { io, files } = testIo({
      env: HISTORY_ENV,
      fetch: async (url) =>
        jsonResponse(historyAnswer(url, [10, 11], { hit: true })),
      start: EVENING,
    });
    const reader = createHistoryReader(io, ["AAPL"], "/day");
    expect(seriesSource(await reader.load(planFor("AAPL").plan))).toBe("ibkr");
    expect(files.has("/day/AAPL.7M.json")).toBe(false);
  });

  it("stores nothing in the day cache before the close", async () => {
    const { io, files } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: [10, 11] }),
    });
    const reader = createHistoryReader(io, ["AAPL"], "/day");
    expect(seriesSource(await reader.load(planFor("AAPL").plan))).toBe("ibkr");
    expect(files.has("/day/AAPL.7M.json")).toBe(false);
  });

  it("counts a proxy 404 as a failure, and an answer without bars does not reset the count", async () => {
    const symbols = ["A", "B", "C", "D", "E"];
    const { io, requests } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ A: 404, B: [], C: 404, D: 404, E: [10, 11] }),
    });
    const reader = createHistoryReader(io, symbols);
    for (const symbol of symbols) await reader.load(planFor(symbol).plan);
    expect(asked(requests)).toEqual(["A", "B", "C", "D"]);
  });

  it("asks IBKR when the cached file is not usable, and stores nothing without bars", async () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify([{ close: 0, date: "2026-11-09", volume: 1 }]),
      JSON.stringify([{ close: 1, date: 5, volume: 1 }]),
      JSON.stringify([{ close: 1, date: "2026-11-09", volume: -1 }]),
      JSON.stringify({ bars: [] }),
    ]) {
      const { io, requests } = testIo({
        env: HISTORY_ENV,
        fetch: historyFetch({ AAPL: [10, 11] }),
        files: { "/day/AAPL.7M.json": text },
      });
      const reader = createHistoryReader(io, ["AAPL"], "/day");
      expect(seriesSource(await reader.load(planFor("AAPL").plan)), text).toBe(
        "ibkr"
      );
      expect(requests, text).toHaveLength(1);
    }
    const { io, files } = testIo({
      env: HISTORY_ENV,
      fetch: historyFetch({ AAPL: 500 }),
      start: EVENING,
    });
    await createHistoryReader(io, ["AAPL"], "/day").load(planFor("AAPL").plan);
    expect(files.has("/day/AAPL.7M.json")).toBe(false);
  });

  it("asks IBKR only within the run budget, counted from the first request", async () => {
    const { io, requests, sleeps, stderr } = testIo({
      clock: true,
      env: { ...HISTORY_ENV, [IBKR_BUDGET_ENV]: "1" },
      fetch: async (url) => jsonResponse(historyAnswer(url, [10, 11])),
    });
    const reader = createHistoryReader(io, ["A", "B", "C", "D"]);
    const sources: (SeriesSource | null)[] = [];
    for (const symbol of ["A", "B", "C", "D"])
      sources.push(seriesSource(await reader.load(planFor(symbol).plan)));
    // 1 min: A at 0 s, B at 40 s; C would start at 80 s.
    expect(sources).toEqual(["ibkr", "ibkr", "yahoo", "yahoo"]);
    expect(asked(requests)).toEqual(["A", "B"]);
    expect(sleeps).toEqual([40_000]);
    expect(stderr).toEqual([
      "2026-11-10T12:00:40.000Z IBKR history: run budget of 1 min used; not asked again in this run, Yahoo serves the remaining symbols\n",
    ]);
  });

  it("sends one IBKR request at a time, in the order asked", async () => {
    let open = 0;
    let widest = 0;
    const { io, requests } = testIo({
      env: HISTORY_ENV,
      fetch: async (url) => {
        open += 1;
        widest = Math.max(widest, open);
        // Yield without a timer: requests started together would all be open here.
        await Promise.resolve();
        await Promise.resolve();
        open -= 1;
        return jsonResponse(historyAnswer(url, [10, 11]));
      },
    });
    const symbols = ["A", "B", "C", "D", "E"];
    const reader = createHistoryReader(io, symbols);
    await Promise.all(
      symbols.map((symbol) => reader.load(planFor(symbol).plan))
    );
    expect(widest).toBe(1);
    expect(asked(requests)).toEqual(symbols);
    expect(requests.every(isHistoryUrl)).toBe(true);
  });

  it("never writes the token or the address to the log", async () => {
    const symbols = ["A", "B", "C", "D"];
    const { io, stderr } = testIo({
      env: HISTORY_ENV,
      fetch: async (url) => {
        const symbol = new URL(url).searchParams.get("symbol");
        if (symbol === "A")
          throw new Error(`connect failed: ${url} Bearer ${TOKEN}`);
        if (symbol === "B")
          return jsonResponse({ error: TOKEN, message: TOKEN }, 500);
        return new Response(TOKEN, { status: 429 });
      },
    });
    const reader = createHistoryReader(io, symbols);
    for (const symbol of symbols) await reader.load(planFor(symbol).plan);
    expect(stderr).toHaveLength(3);
    const log = stderr.join("");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("history.test");
    expect(log).not.toContain("Bearer");
  });
});

describe("seriesSource and sourceCounts", () => {
  it("names the sources of a series", () => {
    expect(seriesSource([])).toBeNull();
    expect(seriesSource([{ source: "ibkr" }, { source: "ibkr" }])).toBe("ibkr");
    expect(seriesSource([{ source: "yahoo" }])).toBe("yahoo");
    expect(seriesSource([{ source: "yahoo" }, { source: "ibkr" }])).toBe(
      "mixed"
    );
  });

  it("counts series per source and skips empty series", () => {
    expect(sourceCounts([])).toEqual({ ibkr: 0, mixed: 0, yahoo: 0 });
    expect(
      sourceCounts(["ibkr", "yahoo", null, "mixed", "yahoo", "yahoo"])
    ).toEqual({ ibkr: 1, mixed: 1, yahoo: 3 });
  });
});

describe("sourceLabel", () => {
  const labels = { merged: "IBKR first, Yahoo for gaps", yahoo: "Yahoo" };

  it("keeps the Yahoo text when IBKR is not configured and served nothing", () => {
    expect(sourceLabel(labels, { ibkr: 0, mixed: 0, yahoo: 7 }, false)).toBe(
      "Yahoo"
    );
  });

  it("states the names per source when IBKR is configured or was used", () => {
    expect(sourceLabel(labels, { ibkr: 0, mixed: 0, yahoo: 7 }, true)).toBe(
      "IBKR first, Yahoo for gaps; names: 0 IBKR, 0 IBKR with older days from Yahoo, 7 Yahoo"
    );
    expect(sourceLabel(labels, { ibkr: 2, mixed: 0, yahoo: 5 }, false)).toBe(
      "IBKR first, Yahoo for gaps; names: 2 IBKR, 0 IBKR with older days from Yahoo, 5 Yahoo"
    );
    expect(sourceLabel(labels, { ibkr: 0, mixed: 1, yahoo: 0 }, false)).toBe(
      "IBKR first, Yahoo for gaps; names: 0 IBKR, 1 IBKR with older days from Yahoo, 0 Yahoo"
    );
  });

  it("fits the lens contracts' 300 characters for a 150 character label", () => {
    const counts = { ibkr: 99_999, mixed: 99_999, yahoo: 99_999 };
    expect(
      sourceLabel({ merged: "m".repeat(150), yahoo: "y" }, counts, true).length
    ).toBeLessThanOrEqual(300);
  });
});
