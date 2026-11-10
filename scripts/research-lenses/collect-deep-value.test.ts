import { describe, expect, it } from "vitest";
import {
  deepValueJobOptions,
  deepValueUniverse,
  ourNames,
  runDeepValue,
} from "./collect-deep-value.ts";
import {
  CRITERIA,
  CUTOFFS,
  FLAG_CUTOFFS,
  UNIVERSE_CUTOFFS,
} from "./deep-value.ts";
import { jsonResponse, testIo, yahooChart } from "./lens.test-support.ts";
import type { LensFetch } from "./lens-io.ts";

/** Letters-only ticker suffix (screener tickers have no digits): 0 -> A, 26 -> BA. */
const letters = (i: number): string =>
  (i >= 26 ? letters(Math.floor(i / 26)) : "") +
  String.fromCharCode(65 + (i % 26));

describe("deepValueJobOptions", () => {
  it("defaults like vertex-research, relative to the repository root", () => {
    expect(deepValueJobOptions(testIo().io)).toEqual({
      concurrency: 4,
      limit: 0,
      out: "/repo/data/deep-value",
      rotationFile: "/repo/data/rotation-matrix/latest.json",
      tickers: [],
      universe: true,
    });
  });

  it("reads overrides", () => {
    const { io } = testIo({
      argv: [
        "--out",
        "/dv",
        "--tickers",
        "aapl,,BRK.B",
        "--no-universe",
        "--limit",
        "3",
        "--concurrency",
        "1",
        "--rotation",
        "/rot/latest.json",
      ],
    });
    expect(deepValueJobOptions(io)).toEqual({
      concurrency: 1,
      limit: 3,
      out: "/dv",
      rotationFile: "/rot/latest.json",
      tickers: ["aapl", "BRK.B"],
      universe: false,
    });
  });
});

const rotationDocument = {
  periods: {
    "1M": {
      industries: [
        {
          industry: "Semis",
          leaders: [{ symbol: "NVDA" }, { symbol: "WISHA" }],
          sector: "Tech",
        },
        { industry: "Semis", leaders: [{ symbol: "WRONG" }], sector: "Other" },
        { industry: "Banks", sector: "Finance" },
      ],
      top: [
        { industry: "Semis", sector: "Tech" },
        { industry: "Banks", sector: "Finance" },
        { industry: "Missing", sector: "Tech" },
      ],
    },
  },
};

describe("ourNames", () => {
  it("labels wish list, re-entry, rotation leaders and requested tickers", async () => {
    const { io } = testIo({
      argv: ["--tickers", "aapl,WISHA"],
      files: {
        "/repo/data/rotation-matrix/latest.json":
          JSON.stringify(rotationDocument),
        "/state/reentry_watch.json": JSON.stringify({
          candidates: [{ symbol: "reo" }],
        }),
        "/state/wishlist_watch.json": JSON.stringify({
          symbols: { WISHA: {} },
        }),
      },
    });
    const roles = await ourNames(io, deepValueJobOptions(io));
    expect(
      Object.fromEntries([...roles].map(([symbol, set]) => [symbol, [...set]]))
    ).toEqual({
      AAPL: ["requested"],
      NVDA: ["rotation leader"],
      REO: ["re-entry"],
      WISHA: ["wish list", "rotation leader", "requested"],
    });
  });

  it("is empty without state or rotation files, or with odd rotation shapes", async () => {
    expect(
      (await ourNames(testIo().io, deepValueJobOptions(testIo().io))).size
    ).toBe(0);
    const { io } = testIo({
      files: {
        "/repo/data/rotation-matrix/latest.json": JSON.stringify({
          periods: {
            "1M": {
              industries: "x",
              top: [{ industry: "Semis", sector: "Tech" }],
            },
          },
        }),
      },
    });
    expect((await ourNames(io, deepValueJobOptions(io))).size).toBe(0);
  });
});

describe("deepValueUniverse", () => {
  it("keeps plain tickers only and sends the job's headers once, without retry", async () => {
    const inits: RequestInit[] = [];
    const symbols = ["AAPL", "BRK.B", "TOOLONG", "ABC"];
    const { io, requests } = testIo({
      fetch: async (_url, init) => {
        inits.push(init);
        return jsonResponse({
          data: {
            rows: Array.from({ length: 1000 }, (_, i) => ({
              symbol: symbols[i] ?? "1",
            })),
          },
        });
      },
    });
    expect((await deepValueUniverse(io)).map((row) => row.symbol)).toEqual([
      "AAPL",
      "ABC",
    ]);
    expect(requests).toEqual([
      "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
    ]);
    expect(inits[0]?.headers).toEqual({
      accept: "application/json",
      "user-agent": "Mozilla/5.0 vertex-research/deep-value",
    });
  });
});

type Company = Readonly<{ cik: number; revenue: number; price: number }>;

/** Screener, Yahoo and SEC responses for a small market of low-priced names. */
const market = (): Readonly<{
  fetch: LensFetch;
  companies: Map<string, Company>;
}> => {
  const companies = new Map<string, Company>();
  const rows: Record<string, unknown>[] = [];
  // 105 universe names in three industries (price $2–$9, cap $60M–$900M, $200k+/day).
  for (let i = 0; i < 105; i++) {
    const symbol = `U${letters(i)}`;
    const price = 2 + (i % 8);
    companies.set(symbol, { cik: 1000 + i, price, revenue: 50e6 + i * 1e6 });
    rows.push({
      industry: `Ind${i % 3}`,
      lastsale: `$${price}.00`,
      marketCap: String(60e6 + i * 8e6),
      name: `${symbol} Corp`,
      sector: "Tech",
      symbol,
      volume: "100000",
    });
  }
  // Ours: WISHA is also in the universe; BIG is outside it (price $50).
  companies.set("WISHA", { cik: 2, price: 3, revenue: 80e6 });
  rows.push({
    industry: "Ind0",
    lastsale: "$3.00",
    marketCap: "70000000",
    name: "Wish A",
    sector: "Tech",
    symbol: "WISHA",
    volume: "200000",
  });
  rows.push({
    industry: "Big",
    lastsale: "$50.00",
    marketCap: "9000000000",
    name: "Big Co",
    sector: "Tech",
    symbol: "BIG",
    volume: "200000",
  });
  companies.set("BIG", { cik: 3, price: 50, revenue: 9e9 });
  // A name whose prices fail.
  rows.push({
    industry: "Ind1",
    lastsale: "$4.00",
    marketCap: "80000000",
    name: "Broken",
    sector: "Tech",
    symbol: "BRKN",
    volume: "200000",
  });
  while (rows.length < 1000)
    rows.push({
      lastsale: "$1000",
      marketCap: "1",
      symbol: `Z${letters(rows.length)}`,
    });
  const tickers = Object.fromEntries(
    [...companies].map(([ticker, company], i) => [
      String(i),
      { cik_str: company.cik, ticker, title: `${ticker} SEC` },
    ])
  );
  const byCik = new Map(
    [...companies.values()].map((company) => [company.cik, company])
  );
  const fetch: LensFetch = async (url) => {
    if (url.includes("api.nasdaq.com")) return jsonResponse({ data: { rows } });
    if (url.includes("company_tickers.json")) return jsonResponse(tickers);
    if (url.includes("companyfacts")) {
      const company = byCik.get(Number(url.split("CIK")[1]?.split(".")[0]));
      if (!company) return jsonResponse({}, 404);
      return jsonResponse({
        facts: {
          dei: {
            EntityCommonStockSharesOutstanding: {
              units: { shares: [{ accn: "a", end: "2026-08-01", val: 20e6 }] },
            },
          },
          "us-gaap": {
            CashAndCashEquivalentsAtCarryingValue: {
              units: { USD: [{ end: "2026-06-30", fy: 2026, val: 5e6 }] },
            },
            Revenues: {
              units: {
                USD: [
                  {
                    end: "2025-12-31",
                    form: "10-K",
                    fp: "FY",
                    fy: 2010,
                    start: "2025-01-01",
                    val: company.revenue,
                  },
                ],
              },
            },
            StockholdersEquity: {
              units: { USD: [{ end: "2026-06-30", fy: 2026, val: 40e6 }] },
            },
          },
        },
      });
    }
    const symbol = decodeURIComponent(
      url.split("/chart/")[1]?.split("?")[0] ?? ""
    );
    const company = companies.get(symbol);
    if (!company) return jsonResponse({}, 500);
    return jsonResponse(
      yahooChart(
        Array.from({ length: 60 }, (_, i) => company.price * (0.8 + i / 250)),
        { meta: { longName: `${symbol} Y` } }
      )
    );
  };
  return { companies, fetch };
};

describe("runDeepValue", () => {
  it("scores our names and the low-price universe and writes latest.json", async () => {
    const { fetch } = market();
    const { io, files, stderr, requests } = testIo({
      argv: ["--out", "/dv", "--tickers", "BIG,NOPE"],
      fetch,
      files: {
        "/state/wishlist_watch.json": JSON.stringify({ symbols: ["WISHA"] }),
      },
    });
    expect(await runDeepValue(io)).toBe(0);
    const document = JSON.parse(files.get("/dv/latest.json") ?? "");
    expect(document).toMatchObject({
      counts: { ours: 3, scored: 109, universe: 107, withErrors: 2 },
      criteria: CRITERIA,
      cutoffs: {
        flags: FLAG_CUTOFFS,
        note: "All numeric cutoffs and proxies are ours. The reel gives no numbers; creator claims are unverified.",
        scoring: CUTOFFS,
        universe: UNIVERSE_CUTOFFS,
      },
      generatedAt: "2026-11-10T12:00:00.000Z",
      method: "TRUE SLAP (IG reel Dew5OAejyOH, @willbchou)",
      sources: {
        fundamentals: "SEC EDGAR XBRL companyfacts",
        prices: "Yahoo Finance chart API (1y daily)",
        universe: "Nasdaq stock screener (api.nasdaq.com)",
      },
    });
    expect(Object.keys(document.industryMedians).sort()).toEqual([
      "Ind0",
      "Ind1",
      "Ind2",
    ]);
    expect(document.industryBySymbol).toMatchObject({
      BIG: "Big",
      UA: "Ind0",
      WISHA: "Ind0",
    });
    expect(document.industryBySymbol.ZBA).toBeUndefined();
    const bySymbol = new Map(
      document.rows.map((row: { symbol: string }) => [row.symbol, row])
    );
    expect(bySymbol.get("WISHA")).toMatchObject({
      industry: "Ind0",
      name: "Wish A",
      roles: ["wish list", "low-price universe"],
    });
    expect(bySymbol.get("BIG")).toMatchObject({
      industry: "Big",
      name: "Big Co",
      roles: ["requested"],
    });
    expect(bySymbol.get("NOPE")).toMatchObject({
      coverage: 0,
      errors: ["prices: Yahoo HTTP 500"],
      industry: null,
      name: null,
      roles: ["requested"],
    });
    expect(bySymbol.get("BRKN")).toMatchObject({
      errors: ["prices: Yahoo HTTP 500"],
      name: "Broken",
    });
    expect(bySymbol.get("UA")).toMatchObject({ errors: [], name: "UA Corp" });
    expect(document.rows.map((row: { rank: number }) => row.rank)).toEqual(
      Array.from({ length: 109 }, (_, i) => i + 1)
    );
    expect(document.rows.at(-1).symbol).toBe("NOPE");
    expect(
      requests.filter((url) => url.includes("company_tickers"))
    ).not.toHaveLength(0);
    expect(stderr[0]).toBe(
      "2026-11-10T12:00:00.000Z scoring 109 names (ours 3, universe 107)\n"
    );
    expect(stderr).toContain("2026-11-10T12:00:00.000Z gathered 100/109\n");
    expect(stderr.at(-1)).toMatch(
      /^2026-11-10T12:00:00.000Z wrote \/dv\/latest.json scored=109 top=([A-Z]+:\d+,){4}[A-Z]+:\d+\n$/
    );
  });

  it("scores only our names with --no-universe and honours --limit", async () => {
    const { fetch } = market();
    const only = testIo({
      argv: ["--out", "/dv", "--no-universe", "--tickers", "UA,UB"],
      fetch,
    });
    expect(await runDeepValue(only.io)).toBe(0);
    const document = JSON.parse(only.files.get("/dv/latest.json") ?? "");
    expect(document.counts).toEqual({
      ours: 2,
      scored: 2,
      universe: 0,
      withErrors: 0,
    });
    expect(document.industryBySymbol).toEqual({});
    // Without the screener the name comes from Yahoo and the industry is unknown.
    expect(
      document.rows.find((row: { symbol: string }) => row.symbol === "UA")
    ).toMatchObject({ industry: null, name: "UA Y" });
    expect(only.requests.some((url) => url.includes("nasdaq"))).toBe(false);
    const limited = testIo({ argv: ["--out", "/dv", "--limit", "4"], fetch });
    expect(await runDeepValue(limited.io)).toBe(0);
    expect(
      JSON.parse(limited.files.get("/dv/latest.json") ?? "").counts
    ).toEqual({ ours: 0, scored: 4, universe: 4, withErrors: 0 });
  });

  it("fails with exit code 1 and one log line when the screener cannot be read", async () => {
    const { io, files, stderr } = testIo({
      argv: ["--out", "/dv"],
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(await runDeepValue(io)).toBe(1);
    expect(stderr).toEqual([
      "2026-11-10T12:00:00.000Z deep-value failed: offline\n",
    ]);
    expect(files.size).toBe(0);
  });
});
