import { describe, expect, it } from "vitest";
import {
  dailyBars,
  getJson,
  readOurs,
  rotationJobOptions,
  rotationUniverse,
  runRotationMatrix,
} from "./collect-rotation-matrix.ts";
import {
  jsonResponse,
  screenerDocument,
  testIo,
  yahooChart,
} from "./lens.test-support.ts";
import type { LensFetch } from "./lens-io.ts";
import type {
  RotationMatrix,
  RotationMonitorSummary,
} from "./rotation-matrix.ts";

/** Letters-only ticker suffix (screener tickers have no digits): 0 -> A, 26 -> BA. */
const letters = (i: number): string =>
  (i >= 26 ? letters(Math.floor(i / 26)) : "") +
  String.fromCharCode(65 + (i % 26));

const ramp = (endPct: number, len = 140): number[] =>
  Array.from(
    { length: len },
    (_, i) => 100 * (1 + (endPct / 100) * (i / (len - 1)))
  );

const statusSequence = (
  statuses: readonly (number | Error)[],
  body: unknown = { ok: 1 }
): LensFetch => {
  let call = 0;
  return async () => {
    // The last status repeats.
    const next = statuses[Math.min(call, statuses.length - 1)] as
      | number
      | Error;
    call += 1;
    if (next instanceof Error) throw next;
    return jsonResponse(body, next);
  };
};

describe("getJson", () => {
  it("returns the first good response", async () => {
    const { io, sleeps } = testIo({ fetch: statusSequence([200]) });
    expect(await getJson(io, "https://x.test")).toEqual({ ok: 1 });
    expect(sleeps).toEqual([]);
  });

  it("waits 5 s x try after HTTP 429 and 1 s x try after other failures", async () => {
    const limited = testIo({ fetch: statusSequence([429, 200]) });
    expect(await getJson(limited.io, "https://x.test")).toEqual({ ok: 1 });
    expect(limited.sleeps).toEqual([5000]);
    const flaky = testIo({
      fetch: statusSequence([500, new Error("reset"), 200]),
    });
    expect(await getJson(flaky.io, "https://x.test")).toEqual({ ok: 1 });
    expect(flaky.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after the last try", async () => {
    const limited = testIo({ fetch: statusSequence([429, 429, 429]) });
    await expect(getJson(limited.io, "https://x.test")).rejects.toThrow(
      "HTTP 429"
    );
    expect(limited.sleeps).toEqual([5000, 10_000]);
    const down = testIo({ fetch: statusSequence([new Error("offline")]) });
    await expect(getJson(down.io, "https://x.test", 1)).rejects.toThrow(
      "offline"
    );
  });

  it("sends the job's headers and a timeout", async () => {
    const inits: RequestInit[] = [];
    const { io } = testIo({
      fetch: async (_url, init) => {
        inits.push(init);
        return jsonResponse({});
      },
    });
    await getJson(io, "https://x.test");
    expect(inits[0]?.headers).toEqual({
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) vertex-research/rotation-matrix",
    });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("rotationJobOptions", () => {
  it("defaults like vertex-research, relative to the repository root", () => {
    expect(rotationJobOptions(testIo().io)).toEqual({
      cacheDir: "/repo/data/rotation-matrix/cache/2026-11-10",
      concurrency: 8,
      limit: 0,
      minCap: 3e8,
      minVolume: 100_000,
      out: "/repo/data/rotation-matrix",
      summaryOut: "none",
      today: "2026-11-10",
    });
  });

  it("reads overrides", () => {
    const { io } = testIo({
      argv: [
        "--out",
        "/tmp/rot",
        "--summary-out",
        "s.json",
        "--min-cap",
        "1e9",
        "--min-volume",
        "5",
        "--concurrency",
        "2",
        "--limit",
        "20",
      ],
    });
    expect(rotationJobOptions(io)).toMatchObject({
      cacheDir: "/tmp/rot/cache/2026-11-10",
      concurrency: 2,
      limit: 20,
      minCap: 1e9,
      minVolume: 5,
      out: "/tmp/rot",
      summaryOut: "s.json",
    });
  });
});

describe("readOurs", () => {
  it("reads the wish list, re-entry watch and pre-exit ledger", async () => {
    const { io } = testIo({
      files: {
        "/state/reentry_ledger.json": JSON.stringify({
          pre_exit: { "RE1:2026-10-01": {}, "RE2:x": {} },
        }),
        "/state/reentry_watch.json": JSON.stringify({
          candidates: { RE1: {} },
        }),
        "/state/wishlist_watch.json": JSON.stringify({
          symbols: ["WIN", { symbol: "OURTINY" }],
        }),
      },
    });
    expect(await readOurs(io)).toEqual({
      reentry: ["RE1", "RE2"],
      wish: ["WIN", "OURTINY"],
    });
  });

  it("is empty without state files or with an odd ledger", async () => {
    expect(await readOurs(testIo().io)).toEqual({ reentry: [], wish: [] });
    const { io } = testIo({
      files: {
        "/state/reentry_ledger.json": JSON.stringify({ pre_exit: "x" }),
      },
    });
    expect(await readOurs(io)).toEqual({ reentry: [], wish: [] });
  });
});

describe("rotationUniverse", () => {
  it("keeps plain and one-letter class tickers", async () => {
    const symbols = ["AAPL", "BRK.B", "BF-B", "TOOLONG", "BAD^", "A1"];
    const { io } = testIo({
      fetch: async () =>
        jsonResponse(
          screenerDocument(1000, (i) => ({ symbol: symbols[i] ?? "ZZZZZZ" }))
        ),
    });
    expect((await rotationUniverse(io)).map((row) => row.symbol)).toEqual([
      "AAPL",
      "BRK.B",
      "BF-B",
    ]);
  });
});

describe("dailyBars", () => {
  it("fetches adjusted closes, caches them and reuses today's cache", async () => {
    const { io, files, requests } = testIo({
      fetch: async () => jsonResponse(yahooChart([1, null, 3])),
    });
    const bars = await dailyBars(io, "/c", "BRK.B");
    expect(bars).toEqual([
      ["2026-11-07", 1],
      ["2026-11-09", 3],
    ]);
    expect(requests).toEqual([
      "https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?range=7mo&interval=1d",
    ]);
    expect(JSON.parse(files.get("/c/BRK.B.json") ?? "")).toEqual(bars);
    expect(await dailyBars(io, "/c", "BRK.B")).toEqual(bars);
    expect(requests).toHaveLength(1);
  });

  it("falls back to raw closes and tolerates an empty chart", async () => {
    const raw = testIo({
      fetch: async () => jsonResponse(yahooChart([5, 6], { adjusted: false })),
    });
    expect((await dailyBars(raw.io, "/c", "X")).map((bar) => bar[1])).toEqual([
      5, 6,
    ]);
    const empty = testIo({
      fetch: async () => jsonResponse({ chart: { result: [] } }),
    });
    expect(await dailyBars(empty.io, "/c", "Y")).toEqual([]);
    expect(empty.files.get("/c/Y.json")).toBe("[]");
  });
});

/** A screener download plus Yahoo charts for a small synthetic market. */
const market = (): Readonly<{
  fetch: LensFetch;
  rows: Record<string, unknown>[];
}> => {
  const rows: Record<string, unknown>[] = [];
  const closes = new Map<string, readonly (number | null)[]>();
  const stock = (
    symbol: string,
    industry: string,
    sector: string,
    pct: number,
    extra: Record<string, unknown> = {}
  ) => {
    rows.push({
      industry,
      lastsale: "$25.00",
      marketCap: "5000000000",
      name: `${symbol} Inc`,
      sector,
      symbol,
      volume: "500000",
      ...extra,
    });
    closes.set(symbol, ramp(pct));
  };
  // Leading industry with our wish-list name at the top.
  for (let i = 0; i < 9; i++) stock(`LD${letters(i)}`, "Lead", "Tech", 20 + i);
  stock("WIN", "Lead", "Tech", 60, { marketCap: "3000000000" });
  // 250 names in five other industries.
  for (let i = 0; i < 250; i++)
    stock(`M${letters(i)}`, `Ind${i % 5}`, "Other", (i % 5) - 4 + i / 100);
  stock("REX", "Ind0", "Other", -2);
  stock("OURT", "Lead", "Tech", 5, { marketCap: "1000000" });
  stock("TINY", "Lead", "Tech", 5, { marketCap: "1000000" });
  stock("CHEAP", "Lead", "Tech", 5, { lastsale: "$2.00" });
  stock("QUIET", "Lead", "Tech", 5, { volume: "10" });
  stock("CACHE", "Ind1", "Other", 1);
  rows.push({
    industry: "Lead",
    lastsale: "$25",
    marketCap: "5000000000",
    sector: "Tech",
    symbol: "FAIL",
    volume: "500000",
  });
  rows.push({
    industry: "Lead",
    lastsale: "$25",
    marketCap: "5000000000",
    sector: "Tech",
    symbol: "SHORT",
    volume: "500000",
  });
  closes.set("SHORT", [10]);
  rows.push({
    industry: "Lead",
    lastsale: "$25",
    marketCap: "5000000000",
    sector: "Tech",
    symbol: "STALE",
    volume: "500000",
  });
  while (rows.length < 1000)
    rows.push({ marketCap: "1000", symbol: `F${rows.length}` });
  const fetch: LensFetch = async (url) => {
    if (new URL(url).hostname === "api.nasdaq.com")
      return jsonResponse({ data: { rows } });
    const symbol = decodeURIComponent(
      url.split("/chart/")[1]?.split("?")[0] ?? ""
    );
    if (symbol === "FAIL") return jsonResponse({}, 500);
    if (symbol === "STALE")
      return jsonResponse(yahooChart(ramp(3), { endDay: "2026-11-06" }));
    return jsonResponse(yahooChart(closes.get(symbol) ?? []));
  };
  return { fetch, rows };
};

describe("runRotationMatrix", () => {
  it("collects, writes latest.json and the summary, and keeps only today's cache", async () => {
    const { fetch } = market();
    const { io, files, requests, stderr } = testIo({
      argv: ["--out", "/out", "--summary-out", "/out/summary.json"],
      fetch,
      files: {
        "/out/cache/2026-11-01/OLD.json": "[]",
        "/out/cache/2026-11-10/CACHE.json": JSON.stringify(
          ramp(1).map((c, i) => [i === 139 ? "2026-11-09" : "2026-01-01", c])
        ),
        "/state/reentry_watch.json": JSON.stringify({ candidates: ["REX"] }),
        "/state/wishlist_watch.json": JSON.stringify({
          symbols: ["WIN", "OURT", "GONE"],
        }),
      },
    });
    expect(await runRotationMatrix(io)).toBe(0);
    const matrix = JSON.parse(
      files.get("/out/latest.json") ?? ""
    ) as RotationMatrix;
    expect(matrix.asOf).toBe("2026-11-09");
    expect(matrix.generatedAt).toBe("2026-11-10T12:00:00.000Z");
    expect(matrix.source).toEqual({
      bars: "Yahoo Finance chart API, adjusted daily closes",
      failed: 2,
      filters: { minCap: 3e8, minPrice: 3, minVolume: 100_000 },
      finvizMap: "https://finviz.com/map.ashx?t=sec_all",
      metadata:
        "Nasdaq stock screener (api.nasdaq.com), sector/industry per Nasdaq classification",
      staleDropped: 1,
    });
    // OURT is fetched (ours) but below the matrix cap floor; TINY, CHEAP and QUIET are filtered out.
    expect(matrix.universeSize).toBe(9 + 1 + 250 + 1 + 1);
    expect(requests.some((url) => url.includes("/chart/OURT?"))).toBe(true);
    for (const symbol of ["TINY", "CHEAP", "QUIET", "CACHE"])
      expect(requests.some((url) => url.includes(`/chart/${symbol}?`))).toBe(
        false
      );
    const win = matrix.ours.find((o) => o.symbol === "WIN");
    expect(win).toMatchObject({
      cell1M: "leading",
      cell3M: "leading",
      opportunity: true,
      roles: ["wish"],
    });
    expect(matrix.ours.find((o) => o.symbol === "GONE")?.covered).toBe(false);
    expect(matrix.ours.find((o) => o.symbol === "OURT")?.covered).toBe(false);
    expect(matrix.ours.find((o) => o.symbol === "REX")?.roles).toEqual([
      "reentry",
    ]);
    const summary = JSON.parse(
      files.get("/out/summary.json") ?? ""
    ) as RotationMonitorSummary;
    expect(summary.uncovered).toEqual(["GONE", "OURT"]);
    expect(files.get("/out/summary.json")).toContain('\n "asOf"');
    expect(files.has("/out/cache/2026-11-01/OLD.json")).toBe(false);
    expect(files.has("/out/cache/2026-11-10/WIN.json")).toBe(true);
    expect(stderr[0]).toBe(
      "2026-11-10T12:00:00.000Z universe 266 (min cap 300000000, min volume 100000); ours wish=3 reentry=1\n"
    );
    expect(stderr).toContain("2026-11-10T12:00:00.000Z bars 250/266\n");
    expect(stderr.at(-1)).toBe(
      "2026-11-10T12:00:00.000Z wrote /out/latest.json asOf=2026-11-09 names=263 failed=2 opportunities=WIN\n"
    );
  });

  it("honours --limit and skips the summary by default", async () => {
    const { fetch } = market();
    const { io, files, requests } = testIo({
      argv: ["--out", "/out", "--limit", "5", "--concurrency", "2"],
      fetch,
    });
    expect(await runRotationMatrix(io)).toBe(0);
    expect(
      requests.filter((url) =>
        new URL(url).hostname.endsWith(".finance.yahoo.com")
      )
    ).toHaveLength(5);
    expect(JSON.parse(files.get("/out/latest.json") ?? "").universeSize).toBe(
      5
    );
    expect([...files.keys()].some((key) => key.includes("summary"))).toBe(
      false
    );
  });

  it("writes an empty matrix when nothing passes the filters", async () => {
    const { fetch } = market();
    const { io, files, stderr } = testIo({
      argv: ["--out", "/out", "--min-cap", "1e15"],
      fetch,
    });
    expect(await runRotationMatrix(io)).toBe(0);
    const matrix = JSON.parse(
      files.get("/out/latest.json") ?? ""
    ) as RotationMatrix;
    expect(matrix).toMatchObject({ asOf: null, universeSize: 0 });
    expect(stderr.at(-1)).toBe(
      "2026-11-10T12:00:00.000Z wrote /out/latest.json asOf=null names=0 failed=0 opportunities=none\n"
    );
  });

  it("fails with exit code 1 and one log line when the screener is short", async () => {
    const { io, files, stderr } = testIo({
      argv: ["--out", "/out"],
      fetch: async () =>
        jsonResponse(screenerDocument(10, (i) => ({ symbol: `S${i}` }))),
    });
    expect(await runRotationMatrix(io)).toBe(1);
    expect(stderr.at(-1)).toBe(
      "2026-11-10T12:00:00.000Z rotation-matrix failed: Nasdaq screener returned too few rows\n"
    );
    expect(files.has("/out/latest.json")).toBe(false);
  });
});
