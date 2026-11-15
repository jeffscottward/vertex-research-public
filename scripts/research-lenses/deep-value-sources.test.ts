import { describe, expect, it } from "vitest";
import { riskFlags, scoreTicker } from "./deep-value.ts";
import {
  type CompanyFacts,
  createDeepValueSources,
  factsFromBars,
  factsFromCompanyFacts,
  parseYahooChart,
  type SecFactRow,
  secUserAgent,
} from "./deep-value-sources.ts";
import { jsonResponse, NOW, testIo, yahooChart } from "./lens.test-support.ts";
import type { LensFetch } from "./lens-io.ts";

const fy = (end: string, val: number): SecFactRow => ({
  end,
  filed: end,
  form: "10-K",
  fp: "FY",
  fy: Number(end.slice(0, 4)),
  start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`.replace(
    /-\d\d$/,
    "-01"
  ),
  val,
});
const at = (end: string, val: number) => ({ units: { USD: [{ end, val }] } });
const usGaap = (facts: Record<string, unknown>): CompanyFacts =>
  ({ facts: { "us-gaap": facts } }) as CompanyFacts;

describe("SEC companyfacts extraction (ported from vertex-research)", () => {
  it("extracts revenue, balance sheet, cash flow, shares and longevity", () => {
    const cf = {
      facts: {
        dei: {
          EntityCommonStockSharesOutstanding: {
            units: {
              shares: [
                { accn: "a1", end: "2025-08-01", val: 90 },
                { accn: "a2", end: "2026-08-01", val: 60 },
                { accn: "a2", end: "2026-08-01", val: 40 },
              ],
            },
          },
        },
        "us-gaap": {
          CashAndCashEquivalentsAtCarryingValue: {
            units: { USD: [{ end: "2026-06-30", fy: 2026, val: 30 }] },
          },
          LongTermDebt: {
            units: { USD: [{ end: "2026-06-30", fy: 2026, val: 10 }] },
          },
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: [fy("2025-12-31", -6)] },
          },
          Old: { units: { USD: [{ end: "2012-12-31", fy: 2012, val: 1 }] } },
          Revenues: {
            units: { USD: [fy("2024-12-31", 90), fy("2025-12-31", 100)] },
          },
          StockholdersEquity: {
            units: { USD: [{ end: "2026-06-30", fy: 2026, val: 80 }] },
          },
        },
      },
    } as CompanyFacts;
    const f = factsFromCompanyFacts(cf, NOW);
    expect(f).toEqual({
      balanceDate: "2026-06-30",
      cash: 30,
      debtDate: "2026-06-30",
      equity: 80,
      firstYear: 2012,
      operatingCashFlow: -6,
      revenue: 100,
      revenuePrior: 90,
      revenueYear: 2025,
      sharesDate: "2026-08-01",
      sharesOutstanding: 100, // two share classes summed
      sharesYearAgo: 90,
      totalDebt: 10,
      yearsReporting: 14,
    });
  });

  it("drops fundamentals for non-USD filers and flags a missing debt tag", () => {
    const cf = usGaap({
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [
            {
              end: "2025-12-31",
              form: "20-F",
              fp: "FY",
              start: "2025-01-01",
              val: 7,
            },
          ],
        },
      },
      Revenues: {
        units: {
          CNY: [
            {
              end: "2025-12-31",
              form: "20-F",
              fp: "FY",
              fy: 2025,
              start: "2025-01-01",
              val: 6e9,
            },
            {
              end: "2024-12-31",
              form: "20-F",
              fp: "FY",
              fy: 2024,
              start: "2024-01-01",
              val: 5e9,
            },
          ],
          USD: [
            {
              end: "2025-12-31",
              form: "20-F",
              fp: "FY",
              fy: 2025,
              start: "2025-01-01",
              val: 8e8,
            },
          ],
        },
      },
      StockholdersEquity: {
        units: { CNY: [{ end: "2025-12-31", fy: 2025, val: 9e9 }] },
      },
    });
    const f = factsFromCompanyFacts(cf, NOW);
    expect(f.nonUsdFiler).toBe(true);
    expect(f.revenue).toBeUndefined();
    expect("debtTagMissing" in f).toBe(false);
    // As upstream: operating cash flow is read after the drop.
    expect(f.operatingCashFlow).toBe(7);
    expect(riskFlags({ ...f, cik: 1 }).some((x) => x.id === "non-usd")).toBe(
      true
    );
    const g = factsFromCompanyFacts(
      usGaap({
        StockholdersEquity: {
          units: { USD: [{ end: "2025-12-31", val: 10 }] },
        },
      })
    );
    expect(g.debtTagMissing).toBe(true);
    expect(
      scoreTicker({ ...g, cik: 1, symbol: "Z" }).criteria.risk.evidence
    ).toMatch(/not tagged/);
  });

  it("debt: newest balance date wins; on a tie the larger tag set (convertible notes) is used", () => {
    const f = factsFromCompanyFacts(
      usGaap({
        ConvertibleLongTermNotesPayable: at("2026-06-30", 194e6),
        LongTermDebt: at("2026-06-30", 24e6),
        NotesPayable: at("2024-12-31", 999e6),
      })
    );
    expect(f.totalDebt).toBe(194e6);
    // Parts must share the newest balance date; a newer set replaces an older larger one.
    const parts = factsFromCompanyFacts(
      usGaap({
        DebtCurrent: at("2026-06-30", 5),
        LongTermDebtCurrent: at("2025-12-31", 100),
        LongTermDebtNoncurrent: {
          units: {
            USD: [
              { end: "2026-03-31", val: 50 },
              { end: "2026-06-30", val: 7 },
            ],
          },
        },
        SeniorNotes: at("2026-09-30", 1),
      })
    );
    expect(parts).toMatchObject({ debtDate: "2026-09-30", totalDebt: 1 });
    const pair = factsFromCompanyFacts(
      usGaap({
        DebtCurrent: at("2026-06-30", 5),
        LongTermDebtNoncurrent: at("2026-06-30", 7),
      })
    );
    expect(pair.totalDebt).toBe(12);
  });

  it("revenue: newest tag wins, prior year needs 300 days, year falls back to the end date", () => {
    const row = (
      end: string,
      val: number,
      extra: Record<string, unknown> = {}
    ): SecFactRow => ({ ...fy(end, val), ...extra }) as SecFactRow;
    const f = factsFromCompanyFacts(
      usGaap({
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [row("2025-06-30", 50, { fy: undefined })] },
        },
        Revenues: {
          units: { USD: [row("2024-12-31", 40), row("2025-03-31", 45)] },
        },
        SalesRevenueNet: {
          units: {
            USD: [
              row("2025-06-30", 99, { filed: "2025-01-01" }),
              // Not annual: wrong period type, form, missing start, or too short.
              row("2026-06-30", 1, { fp: "Q2" }),
              row("2026-06-30", 1, { form: "10-Q" }),
              row("2026-06-30", 1, { form: undefined }),
              row("2026-06-30", 1, { start: undefined }),
              row("2026-06-30", 1, { start: "2026-01-01" }),
            ],
          },
        },
      })
    );
    expect(f.revenue).toBe(50);
    expect(f.revenueYear).toBe("2025");
    expect(f.revenuePrior).toBeUndefined();
    // Same end date: the later filing first.
    const refiled = factsFromCompanyFacts(
      usGaap({
        Revenues: {
          units: {
            USD: [
              row("2025-12-31", 1, { filed: "2026-02-01" }),
              row("2025-12-31", 2, { filed: "2026-03-01" }),
              row("2025-12-31", 3, { filed: undefined }),
            ],
          },
        },
      })
    );
    expect(refiled.revenue).toBe(2);
  });

  it("cash: newest instant across tags, first tag on a tie, rows without an end sort last", () => {
    const f = factsFromCompanyFacts(
      usGaap({
        Cash: at("2026-06-30", 3),
        CashAndCashEquivalentsAtCarryingValue: {
          units: {
            USD: [{ val: 9 }, { end: "2026-06-30", val: 1 }, { val: 8 }],
          },
        },
        CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: {
          units: { USD: [{ end: "2026-09-30", start: "2026-01-01", val: 2 }] },
        },
      })
    );
    expect(f).toMatchObject({ balanceDate: "2026-06-30", cash: 1 });
    expect(
      factsFromCompanyFacts(
        usGaap({
          Cash: at("2026-06-30", 3),
          CashAndCashEquivalentsAtCarryingValue: at("2025-06-30", 1),
        })
      ).cash
    ).toBe(3);
  });

  it("operating cash flow falls back to continuing operations", () => {
    const f = factsFromCompanyFacts(
      usGaap({
        NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
          units: { USD: [fy("2025-12-31", 12)] },
        },
      })
    );
    expect(f.operatingCashFlow).toBe(12);
  });

  it("shares: a newer filing replaces the date's rows; other filings without an accession are ignored", () => {
    const shares = (rows: unknown[]) =>
      factsFromCompanyFacts({
        facts: {
          dei: {
            EntityCommonStockSharesOutstanding: { units: { shares: rows } },
          },
        },
      } as CompanyFacts);
    expect(
      shares([
        { accn: "a1", end: "2026-08-01", val: 10 },
        { accn: "a2", end: "2026-08-01", val: 70 },
        { accn: "a0", end: "2026-08-01", val: 5 },
        { end: "2026-08-01", val: 1000 },
        { end: "2025-01-01", val: 3 },
      ])
    ).toEqual({
      debtTagMissing: true,
      sharesDate: "2026-08-01",
      sharesOutstanding: 70,
    });
    expect(
      shares([
        { end: "2026-08-01", val: 4 },
        { end: "2026-08-01", val: 6 },
      ]).sharesOutstanding
    ).toBe(10);
  });

  it("shares: weighted-average basic replaces a much smaller cover-page count", () => {
    const weighted = (rows: SecFactRow[], dei: SecFactRow[] = []) =>
      factsFromCompanyFacts({
        facts: {
          dei: {
            EntityCommonStockSharesOutstanding: { units: { shares: dei } },
          },
          "us-gaap": {
            WeightedAverageNumberOfSharesOutstandingBasic: {
              units: { shares: rows },
            },
          },
        },
      } as CompanyFacts);
    const q = (start: string, end: string, val: number): SecFactRow => ({
      end,
      start,
      val,
    });
    expect(
      weighted(
        [
          q("2026-04-01", "2026-06-30", 300),
          q("2025-01-01", "2025-06-30", 1),
          q("2025-04-01", "2025-06-30", 250),
        ],
        [
          { accn: "a", end: "2026-08-01", val: 100 },
          { accn: "b", end: "2025-08-01", val: 90 },
        ]
      )
    ).toMatchObject({
      sharesOutstanding: 300,
      sharesSource: "weighted-average basic",
      sharesYearAgo: 250,
    });
    // No comparable period a year back: the cover-page year-ago count is cleared.
    const cleared = weighted(
      [q("2026-04-01", "2026-06-30", 300)],
      [
        { accn: "a", end: "2026-08-01", val: 100 },
        { accn: "b", end: "2025-08-01", val: 90 },
      ]
    );
    expect(cleared.sharesYearAgo).toBeUndefined();
    expect("sharesYearAgo" in cleared).toBe(true);
    // Not 1.5x larger: the cover page stands.
    expect(
      weighted(
        [q("2026-04-01", "2026-06-30", 120)],
        [{ accn: "a", end: "2026-08-01", val: 100 }]
      ).sharesOutstanding
    ).toBe(100);
    // No cover page: weighted shares are used.
    expect(
      weighted([q("2026-04-01", "2026-06-30", 120)]).sharesOutstanding
    ).toBe(120);
    // Rows without a start never match the period length.
    expect(
      weighted([
        { end: "2026-06-30", val: 120 },
        { end: "2025-06-30", val: 100 },
      ]).sharesYearAgo
    ).toBeUndefined();
  });

  it("handles an empty or missing document", () => {
    expect(factsFromCompanyFacts(null)).toEqual({ debtTagMissing: true });
    expect(
      factsFromCompanyFacts({ facts: { "us-gaap": { X: {} } } } as CompanyFacts)
    ).toEqual({ debtTagMissing: true });
    const now = factsFromCompanyFacts(usGaap({ A: at("2020-12-31", 1) }));
    expect(now.firstYear).toBeUndefined();
    const years = factsFromCompanyFacts(
      usGaap({
        A: {
          units: {
            USD: [
              { end: "2020-12-31", fy: 2020, val: 1 },
              { end: "2021-12-31", fy: 2021, val: 1 },
            ],
          },
        },
      })
    );
    expect(years.yearsReporting).toBe(new Date().getUTCFullYear() - 2020);
  });
});

describe("price facts", () => {
  it("reads price facts from bars", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      close: i + 1,
      volume: 1000,
    }));
    const f = factsFromBars(bars);
    expect(f).toEqual({
      avgVolume: 1000,
      high52: 60,
      low52: 1,
      price: 60,
      priceAdjusted: 60,
      sma50: (11 + 60) / 2,
    });
  });

  it("uses adjusted closes for the 52-week range; the raw close is the price", () => {
    const bars = [
      ...Array.from({ length: 59 }, () => ({ adj: 2, close: 20, volume: 1 })),
      { adj: 2, close: 2, volume: 1 },
    ];
    const f = factsFromBars(bars);
    expect(f.high52).toBe(2);
    expect(f.price).toBe(2); // a special distribution does not create fake upside
  });

  it("handles short, empty and partial series", () => {
    expect(factsFromBars([])).toEqual({});
    expect(factsFromBars([{ close: null }])).toEqual({});
    expect(
      factsFromBars([
        { adj: 5, close: 4 },
        { adj: 6, close: null, volume: null },
      ])
    ).toEqual({
      avgVolume: null,
      high52: 6,
      low52: 5,
      price: 6,
      priceAdjusted: 6,
      sma50: null,
    });
    const long = factsFromBars(
      Array.from({ length: 300 }, (_, i) => ({ close: i }))
    );
    expect(long).toMatchObject({ high52: 299, low52: 48 });
  });

  it("parses the Yahoo chart document", () => {
    const chart = parseYahooChart(
      yahooChart([1, null, 3], {
        meta: { longName: "Long", shortName: "Short" },
      })
    );
    expect(chart.asOf).toBe("2026-11-09");
    expect(chart.name).toBe("Long");
    expect(chart.bars).toEqual([
      { adj: 1, close: 1, volume: 1_000_000 },
      { adj: 3, close: 3, volume: 1_000_000 },
    ]);
    expect(
      parseYahooChart(
        yahooChart([2], { adjusted: false, meta: { shortName: "Short" } })
      )
    ).toEqual({
      asOf: "2026-11-09",
      bars: [{ adj: undefined, close: 2, volume: 1_000_000 }],
      name: "Short",
    });
    expect(parseYahooChart({})).toEqual({ asOf: null, bars: [], name: null });
  });
});

describe("secUserAgent", () => {
  it("prefers SEC_USER_AGENT, then the contact address, then a placeholder", () => {
    expect(secUserAgent({ SEC_USER_AGENT: "custom" })).toBe("custom");
    expect(
      secUserAgent({ VERTEX_RESEARCH_CONTACT_EMAIL: " me@example.org " })
    ).toBe("vertex-research deep-value (personal research; me@example.org)");
    expect(secUserAgent({ VERTEX_RESEARCH_CONTACT_EMAIL: " " })).toBe(
      "vertex-research deep-value (personal research; owner@example.com)"
    );
    expect(secUserAgent({})).toBe(
      "vertex-research deep-value (personal research; owner@example.com)"
    );
  });
});

const TICKERS = {
  "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1_067_983, ticker: "BRK-B", title: "Berkshire" },
  "2": { cik_str: 42, ticker: "nofacts", title: "No Facts Co" },
  "3": { cik_str: 43, ticker: "BOOM", title: "Boom Co" },
};

const scriptedFetch =
  (overrides: Record<string, Response | (() => Response)> = {}): LensFetch =>
  async (url) => {
    for (const [part, response] of Object.entries(overrides))
      if (url.includes(part))
        return typeof response === "function" ? response() : response;
    if (url.includes("company_tickers.json")) return jsonResponse(TICKERS);
    if (url.includes("CIK0000320193"))
      return jsonResponse({
        facts: {
          "us-gaap": { Revenues: { units: { USD: [fy("2025-09-30", 4e11)] } } },
        },
      });
    if (url.includes("CIK0001067983")) return jsonResponse({ facts: {} });
    if (url.includes("CIK0000000042")) return jsonResponse({}, 404);
    if (url.includes("CIK0000000043")) return jsonResponse({}, 500);
    if (new URL(url).hostname.endsWith(".finance.yahoo.com"))
      return jsonResponse(
        yahooChart([10, 11, 12], { meta: { longName: "From Yahoo" } })
      );
    return jsonResponse({}, 404);
  };

describe("createDeepValueSources", () => {
  it("gathers prices and SEC facts with a serialized SEC gate and a cached ticker map", async () => {
    const { io, requests, sleeps } = testIo({
      env: { VERTEX_RESEARCH_CONTACT_EMAIL: "me@example.org" },
      fetch: scriptedFetch(),
    });
    const seen: RequestInit[] = [];
    const sources = createDeepValueSources({
      ...io,
      fetch: (url, init) => {
        seen.push(init);
        return io.fetch(url, init);
      },
    });
    const facts = await sources.gatherFacts(" aapl ", { roles: ["wish list"] });
    expect(facts).toMatchObject({
      asOf: "2026-11-09",
      cik: 320_193,
      errors: [],
      name: "From Yahoo",
      price: 12,
      revenue: 4e11,
      roles: ["wish list"],
      symbol: "AAPL",
    });
    expect(requests).toEqual([
      "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1y&interval=1d",
      "https://www.sec.gov/files/company_tickers.json",
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    ]);
    expect(seen[1]?.headers).toEqual({
      accept: "application/json",
      "user-agent":
        "vertex-research deep-value (personal research; me@example.org)",
    });
    expect(sleeps).toEqual([125, 125]);
    await sources.gatherFacts("BRK.B");
    expect(
      requests.filter((url) => url.includes("company_tickers"))
    ).toHaveLength(1);
    expect(await sources.secTickerMap()).toBe(await sources.secTickerMap());
  });

  it("maps class tickers, keeps the given name and records each source error", async () => {
    const { io } = testIo({ fetch: scriptedFetch() });
    const sources = createDeepValueSources(io);
    const brk = await sources.gatherFacts("BRK.B", { name: "Given" });
    expect(brk).toMatchObject({
      cik: 1_067_983,
      debtTagMissing: true,
      errors: [],
      name: "Given",
    });
    const none = await sources.gatherFacts("NOFACTS");
    expect(none).toMatchObject({ cik: 42, errors: [], name: "From Yahoo" });
    expect("revenue" in none).toBe(false);
    const boom = await sources.gatherFacts("BOOM");
    expect(boom.errors).toEqual(["sec: SEC HTTP 500"]);
    const unknown = await sources.gatherFacts("ZZZZ");
    expect(unknown.errors).toEqual([]);
    expect(unknown.cik).toBeUndefined();
  });

  it("records a Yahoo failure and falls back to the SEC title", async () => {
    const { io } = testIo({
      fetch: scriptedFetch({
        "finance.yahoo.com": () => jsonResponse({}, 503),
      }),
    });
    const facts = await createDeepValueSources(io).gatherFacts("AAPL");
    expect(facts.errors).toEqual(["prices: Yahoo HTTP 503"]);
    expect(facts.name).toBe("Apple Inc.");
    expect(facts.price).toBeUndefined();
  });

  it("treats a missing ticker file as an empty map and a network failure as an error", async () => {
    const missing = testIo({
      fetch: scriptedFetch({ company_tickers: () => jsonResponse({}, 404) }),
    });
    const sources = createDeepValueSources(missing.io);
    expect((await sources.secTickerMap()).size).toBe(0);
    const failing = testIo({
      fetch: async (url) => {
        if (/(^|\.)sec\.gov$/.test(new URL(url).hostname))
          throw new Error("offline");
        throw "yahoo down";
      },
    });
    const facts = await createDeepValueSources(failing.io).gatherFacts("AAPL");
    expect(facts.errors).toEqual(["prices: yahoo down", "sec: offline"]);
  });

  it("asks Yahoo for the dashed class symbol", async () => {
    const { io, requests } = testIo({ fetch: scriptedFetch() });
    await createDeepValueSources(io).yahooBars("BRK.B");
    expect(requests).toEqual([
      "https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?range=1y&interval=1d",
    ]);
  });
});
