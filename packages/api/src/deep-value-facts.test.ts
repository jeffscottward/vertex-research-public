import { describe, expect, it } from "vitest";

import {
  barsFromYahooChart,
  type CompanyFacts,
  CompanyFactsSchema,
  type DailyBar,
  factsFromBars,
  factsFromCompanyFacts,
  type XbrlRow,
  YahooChartSchema,
} from "./deep-value-facts.ts";

// Synthetic SEC XBRL and Yahoo chart documents only.

const now = new Date("2026-10-21T12:00:00.000Z");

const fy = (
  end: string,
  val: number,
  extra: Partial<XbrlRow> = {}
): XbrlRow => ({
  val,
  end,
  start: `${String(Number(end.slice(0, 4)) - 1)}${end.slice(4)}`,
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form: "10-K",
  filed: `${end.slice(0, 4)}-12-31`,
  ...extra,
});

const instant = (end: string, val: number, accn = "a"): XbrlRow => ({
  val,
  end,
  accn,
  filed: end,
});

type Units = Record<string, XbrlRow[]>;
const doc = (
  gaap: Record<string, Units>,
  dei: Record<string, Units> = {}
): CompanyFacts => ({
  facts: {
    "us-gaap": Object.fromEntries(
      Object.entries(gaap).map(([tag, units]) => [tag, { units }])
    ),
    dei: Object.fromEntries(
      Object.entries(dei).map(([tag, units]) => [tag, { units }])
    ),
  },
});

describe("SEC companyfacts extraction", () => {
  it("reads revenue, prior year, cash, equity, debt, cash flow, shares and longevity", () => {
    const facts = factsFromCompanyFacts(
      doc(
        {
          Revenues: { USD: [fy("2023-12-31", 80), fy("2024-12-31", 90)] },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            USD: [
              fy("2025-12-31", 100),
              // A quarter and a 10-Q never count as a fiscal year.
              fy("2025-09-30", 30, { start: "2025-07-01" }),
              fy("2025-06-30", 50, { form: "10-Q" }),
              // A fiscal-year row with no form is not an annual report.
              {
                val: 500,
                end: "2026-06-30",
                start: "2025-06-30",
                fy: 2026,
                fp: "FY",
                filed: "2026-08-01",
              },
              fy("2024-12-31", 95),
              // Same period, later filing: the newer filing wins.
              fy("2024-12-31", 96, { filed: "2026-02-01" }),
            ],
          },
          CashAndCashEquivalentsAtCarryingValue: {
            USD: [instant("2025-12-31", 40), instant("2024-12-31", 30)],
          },
          Cash: { USD: [instant("2023-12-31", 5)] },
          StockholdersEquity: { USD: [instant("2025-12-31", 200)] },
          LongTermDebt: { USD: [instant("2025-12-31", 70)] },
          LongTermDebtNoncurrent: { USD: [instant("2025-12-31", 60)] },
          LongTermDebtCurrent: { USD: [instant("2025-12-31", 20)] },
          // Parts with an older balance date do not add to the newest total.
          DebtCurrent: { USD: [instant("2024-12-31", 999)] },
          NetCashProvidedByUsedInOperatingActivities: {
            USD: [fy("2025-12-31", -12)],
          },
          WeightedAverageNumberOfSharesOutstandingBasic: {
            shares: [fy("2025-12-31", 1000)],
          },
          Assets: { USD: [fy("2009-12-31", 1)], pure: [fy("2008-12-31", 1)] },
        },
        {
          EntityCommonStockSharesOutstanding: {
            shares: [
              instant("2026-02-01", 900),
              instant("2025-02-01", 850),
              instant("2023-02-01", 500),
            ],
          },
        }
      ),
      now
    );
    return expect(facts).toEqual({
      revenue: 100,
      revenueYear: "2025",
      revenuePrior: 96,
      cash: 40,
      equity: 200,
      // LongTermDebtNoncurrent + LongTermDebtCurrent (80) beats LongTermDebt (70) on the same date.
      totalDebt: 80,
      operatingCashFlow: -12,
      sharesOutstanding: 900,
      sharesYearAgo: 850,
      firstYear: 2008,
      yearsReporting: 18,
    });
  });

  it("marks missing debt and prefers the newest balance date", () => {
    expect(
      factsFromCompanyFacts(
        doc({ Assets: { USD: [instant("2025-12-31", 1)] } })
      )
    ).toEqual({ debtTagMissing: true });
    return expect(
      factsFromCompanyFacts(
        doc({
          LongTermDebt: { USD: [instant("2025-12-31", 50)] },
          NotesPayable: { USD: [instant("2025-12-31", 50)] },
          SeniorNotes: { USD: [instant("2025-12-31", 10)] },
          LongTermLineOfCredit: { USD: [instant("2026-03-31", 5)] },
        })
      ).totalDebt
    ).toBe(5);
  });

  it("uses the period end year when the fiscal year is missing and skips a missing prior year", () => {
    const facts = factsFromCompanyFacts(
      doc({
        SalesRevenueNet: {
          USD: [
            fy("2025-06-30", 12, { fy: null }),
            // Same period without a filing date: the dated filing wins.
            {
              val: 11,
              end: "2025-06-30",
              start: "2024-06-30",
              fp: "FY",
              form: "10-K",
            },
            {
              val: 10,
              end: "2025-06-30",
              start: "2024-06-30",
              fp: "FY",
              form: "10-K",
            },
          ],
        },
      })
    );
    expect([facts.revenue, facts.revenueYear]).toEqual([12, "2025"]);
    return expect(facts).not.toHaveProperty("revenuePrior");
  });

  it("drops USD fundamentals for filers that report mainly in another currency", () => {
    const facts = factsFromCompanyFacts(
      doc({
        Revenues: {
          USD: [fy("2025-03-31", 10)],
          CNY: [
            fy("2025-03-31", 70),
            fy("2024-03-31", 60),
            fy("2023-03-31", 50),
          ],
        },
        NetCashProvidedByUsedInOperatingActivities: {
          USD: [fy("2025-03-31", 3)],
        },
      }),
      now
    );
    return expect(facts).toEqual({
      nonUsdFiler: true,
      firstYear: 2023,
      yearsReporting: 3,
    });
  });

  it("sums share classes from one filing and prefers the newest filing per date", () => {
    const facts = factsFromCompanyFacts(
      doc(
        {},
        {
          EntityCommonStockSharesOutstanding: {
            shares: [
              instant("2026-02-01", 600, "0001"),
              instant("2026-02-01", 400, "0001"),
              instant("2026-02-01", 50, "0000"),
              { val: 7, end: "2025-11-01" },
            ],
          },
        }
      )
    );
    expect(facts.sharesOutstanding).toBe(1000);
    return expect(facts).not.toHaveProperty("sharesYearAgo");
  });

  it("uses weighted basic shares when the cover page shows one class or nothing", () => {
    const weighted = (rows: XbrlRow[]) =>
      factsFromCompanyFacts(
        doc(
          { WeightedAverageNumberOfSharesOutstandingBasic: { shares: rows } },
          {
            EntityCommonStockSharesOutstanding: {
              shares: [instant("2026-02-01", 100), instant("2025-02-01", 90)],
            },
          }
        )
      );
    expect(
      weighted([fy("2025-12-31", 400), fy("2024-12-31", 380)])
    ).toMatchObject({ sharesOutstanding: 400, sharesYearAgo: 380 });
    // A quarter-length row a year earlier is not comparable with an annual row.
    const noMatch = weighted([
      fy("2025-12-31", 400),
      fy("2024-12-31", 100, { start: "2024-10-01" }),
    ]);
    expect(noMatch.sharesOutstanding).toBe(400);
    expect(noMatch).not.toHaveProperty("sharesYearAgo");
    const onlyWeighted = factsFromCompanyFacts(
      doc({
        WeightedAverageNumberOfSharesOutstandingBasic: {
          shares: [
            { val: 50, end: "2025-12-31" },
            { val: 40, end: "2024-12-31" },
          ],
        },
      })
    );
    return expect(onlyWeighted).toMatchObject({
      sharesOutstanding: 50,
      sharesYearAgo: 40,
    });
  });

  return it("parses documents without a facts block", () => {
    const parsed = CompanyFactsSchema.parse({ cik: 1 });
    expect(parsed.facts).toEqual({});
    return expect(factsFromCompanyFacts(parsed)).toEqual({
      debtTagMissing: true,
    });
  });
});

describe("daily bar facts", () => {
  it("returns nothing for no bars", () => {
    return expect(factsFromBars([])).toEqual({});
  });

  it("uses adjusted closes for range and average and the raw last close for price", () => {
    const bars: DailyBar[] = Array.from({ length: 300 }, (_, index) => ({
      close: index < 100 ? 1000 : 10 + (index % 10),
      adj: index === 299 ? null : 10 + (index % 10),
      volume: index % 2 === 0 ? 100 : null,
    }));
    const facts = factsFromBars(bars);
    expect(facts).toMatchObject({
      price: 19,
      priceAdjusted: 19,
      high52: 19,
      low52: 10,
      avgVolume: 100,
    });
    return expect(facts.sma50).toBeCloseTo(14.5, 6);
  });

  return it("leaves the 50-day average and volume empty for short histories", () => {
    return expect(factsFromBars([{ close: 5, adj: 4, volume: null }])).toEqual({
      price: 5,
      priceAdjusted: 4,
      high52: 4,
      low52: 4,
      sma50: null,
      avgVolume: null,
    });
  });
});

describe("Yahoo chart parsing", () => {
  it("reads bars, the last bar date and the long name", () => {
    const chart = YahooChartSchema.parse({
      chart: {
        result: [
          {
            meta: { longName: "Alpha Industries", shortName: "ALPHA" },
            timestamp: [1_761_000_000, 1_761_086_400, 1_761_172_800],
            indicators: {
              quote: [{ close: [10, null, 12], volume: [100, 200, null] }],
              adjclose: [{ adjclose: [9.5, null, 11.5] }],
            },
          },
        ],
      },
    });
    return expect(barsFromYahooChart(chart)).toEqual({
      asOf: "2025-10-22",
      name: "Alpha Industries",
      bars: [
        { close: 10, adj: 9.5, volume: 100 },
        { close: 12, adj: 11.5, volume: null },
      ],
    });
  });

  it("falls back to the short name and raw closes", () => {
    const chart = YahooChartSchema.parse({
      chart: {
        result: [
          {
            meta: { shortName: "BETA" },
            timestamp: [1_761_000_000],
            indicators: { quote: [{ close: [7] }] },
          },
        ],
      },
    });
    return expect(barsFromYahooChart(chart)).toEqual({
      asOf: "2025-10-20",
      name: "BETA",
      bars: [{ close: 7, adj: null, volume: null }],
    });
  });

  return it("returns no bars for an empty or unknown result", () => {
    const empty = { asOf: null, name: null, bars: [] };
    expect(
      barsFromYahooChart(YahooChartSchema.parse({ chart: { result: null } }))
    ).toEqual(empty);
    expect(
      barsFromYahooChart(
        YahooChartSchema.parse({
          chart: { result: [{ timestamp: [1], indicators: {} }] },
        })
      ).bars
    ).toEqual([]);
    return expect(
      barsFromYahooChart(
        YahooChartSchema.parse({ chart: { result: [{ indicators: {} }] } })
      )
    ).toEqual(empty);
  });
});
