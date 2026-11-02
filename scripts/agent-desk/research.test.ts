import { describe, expect, it } from "vitest";
import {
  CommitteeDataset,
  type Fundamentals,
  FundamentalsDataset,
  fundamentalAgent,
  type News,
  NewsDataset,
  newsSentimentAgent,
  SentimentFile,
} from "./research.ts";

const fundamentals: Fundamentals = FundamentalsDataset.parse({
  asOf: "2026-07-30",
  financialFacts: [
    { asOf: "2026-06-27" },
    { asOf: "2026-10-01" },
    { asOf: 5 },
    "bad",
  ],
  valuation: {
    scenarios: [
      { id: "base", upsidePct: 12.345 },
      { id: "bear", upsidePct: -20 },
      { upsidePct: 1 },
    ],
  },
});
const news: News = NewsDataset.parse({
  asOf: "2026-09-10",
  catalysts: [
    { date: "2026-10-20", title: "Dev day" },
    { date: null, title: "AI adoption" },
    { date: "2026-08-01", title: "Past" },
  ],
  items: [
    { category: "earnings", date: "2026-07-30", title: "Q3 results" },
    { category: "product", date: "2026-09-01", title: "Later" },
    { category: "earnings", date: "2026-10-29", title: "Q4 results" },
    { date: "2026-09-02" },
  ],
  risks: [{ title: "Concentration" }],
});
const committee = CommitteeDataset.parse({
  asOf: "2026-07-30",
  finalRecommendation: { headline: "watch", status: "wait" },
});
const equity = { assetType: "equity", committee, fundamentals, news } as const;

describe("dataset schemas", () => {
  it("turn malformed optional fields into explicit gaps", () => {
    expect(
      FundamentalsDataset.parse({ asOf: 5, financialFacts: "x", valuation: 5 })
    ).toEqual({ asOf: null, financialFacts: [], valuation: null });
    expect(CommitteeDataset.parse({ finalRecommendation: "x" })).toEqual({
      finalRecommendation: null,
    });
    expect(NewsDataset.parse({})).toEqual({ catalysts: [], risks: [] });
  });
});

describe("fundamentalAgent", () => {
  it("reports earnings age, base-case valuation and the committee view", () => {
    const fresh = fundamentalAgent(equity, { asOf: "2026-09-10" });
    expect(fresh).toMatchObject({
      baseCaseUpsidePct: 12.35,
      blocking: false,
      committee: { headline: "watch", horizon: null, status: "wait" },
      evidenceAgeDays: 42,
      lastEarnings: { date: "2026-07-30", title: "Q3 results" },
      latestPeriodEnd: "2026-06-27",
      status: "evaluated",
      valuationView: "base-case-upside",
    });
    expect(fresh.gaps).toHaveLength(2);
  });

  it("blocks stale evidence and an insufficient-data committee", () => {
    const stale = fundamentalAgent(equity, { asOf: "2027-03-01" });
    expect(stale.blocking).toBe(true);
    expect(stale.reasons).toEqual([
      "Latest earnings evidence is 123 days old (limit 100).",
    ]);
    const blocked = fundamentalAgent(
      {
        ...equity,
        committee: CommitteeDataset.parse({
          asOf: "2026-07-30",
          finalRecommendation: { status: "insufficient-data" },
        }),
      },
      { asOf: "2026-09-10" }
    );
    expect(blocked.reasons).toEqual(["Committee status is insufficient-data."]);
  });

  it("ignores evidence dated after the run date", () => {
    const early = fundamentalAgent(equity, { asOf: "2026-06-01" });
    expect(early).toMatchObject({
      baseCaseUpsidePct: null,
      blocking: true,
      committee: null,
      evidenceAgeDays: null,
      lastEarnings: null,
      latestPeriodEnd: null,
      valuationView: "unknown",
    });
    expect(early.reasons).toEqual([
      "Fundamentals dataset is dated after the run date or undated; its valuation view is excluded.",
      "No dated earnings or fundamentals evidence at or before the run date.",
    ]);
  });

  it("falls back to the dataset date and reads downside or missing scenarios", () => {
    const downside = FundamentalsDataset.parse({
      asOf: "2026-09-01",
      financialFacts: [],
      valuation: { scenarios: [{ id: "base", upsidePct: -5 }] },
    });
    expect(
      fundamentalAgent(
        {
          assetType: null,
          committee: null,
          fundamentals: downside,
          news: null,
        },
        { asOf: "2026-09-10" }
      )
    ).toMatchObject({
      committee: null,
      evidenceAgeDays: 9,
      valuationView: "base-case-downside",
    });
    const missing = FundamentalsDataset.parse({
      asOf: "2026-09-01",
      valuation: { scenarios: [{ id: "base", upsidePct: null }] },
    });
    const articles = NewsDataset.parse({
      articles: [{ category: "earnings", date: "2026-08-01", title: "Q" }],
    });
    expect(
      fundamentalAgent(
        {
          assetType: "equity",
          committee: null,
          fundamentals: missing,
          news: articles,
        },
        { asOf: "2026-09-10" }
      )
    ).toMatchObject({
      baseCaseUpsidePct: null,
      lastEarnings: { date: "2026-08-01" },
    });
  });

  it("reads an absent valuation and empty committee fields as unknown", () => {
    const result = fundamentalAgent(
      {
        assetType: "equity",
        committee: CommitteeDataset.parse({
          asOf: "2026-09-01",
          finalRecommendation: {},
        }),
        fundamentals: FundamentalsDataset.parse({ asOf: "2026-09-01" }),
        news: null,
      },
      { asOf: "2026-09-10" }
    );
    expect(result).toMatchObject({
      committee: { headline: null, horizon: null, status: null },
      valuationView: "unknown",
    });
  });

  it("does not apply to funds, indexes and futures and blocks a missing dataset", () => {
    expect(
      fundamentalAgent({ ...equity, assetType: "etf" }, { asOf: "2026-09-10" })
    ).toMatchObject({ blocking: false, gaps: [], status: "not-applicable" });
    expect(
      fundamentalAgent(
        { ...equity, fundamentals: null },
        { asOf: "2026-09-10" }
      )
    ).toMatchObject({
      blocking: true,
      reasons: ["Fundamentals dataset is missing."],
      status: "unavailable",
    });
  });
});

describe("newsSentimentAgent", () => {
  it("separates recent news, upcoming catalysts and undated watch items", () => {
    const result = newsSentimentAgent(
      { news, reportId: "AAPL", sentiment: null },
      { asOf: "2026-09-10" }
    );
    expect(result).toMatchObject({
      gaps: [],
      latestNewsDate: "2026-09-01",
      newsAgeDays: 9,
      riskCount: 1,
      status: "evaluated",
      undatedWatchItems: [{ title: "AI adoption" }],
      upcomingCatalysts: [{ date: "2026-10-20", title: "Dev day" }],
    });
    expect(result.recentItems.map((item) => item.title)).toEqual(["Later"]);
    expect(result.sentiment).toEqual({
      reason: expect.stringContaining("private/agent-desk/sentiment/AAPL.json"),
      status: "unavailable",
    });
  });

  it("reports a missing news category as null", () => {
    const plain = NewsDataset.parse({
      asOf: "2026-09-10",
      items: [{ date: "2026-09-05", title: "Plain" }],
    });
    expect(
      newsSentimentAgent(
        { news: plain, reportId: "AAPL", sentiment: null },
        { asOf: "2026-09-10" }
      ).recentItems
    ).toEqual([{ category: null, date: "2026-09-05", title: "Plain" }]);
  });

  it("excludes catalysts and risks from a dataset captured after the run date", () => {
    const result = newsSentimentAgent(
      { news, reportId: "AAPL", sentiment: null },
      { asOf: "2026-08-15" }
    );
    expect(result).toMatchObject({
      riskCount: 0,
      undatedWatchItems: [],
      upcomingCatalysts: [],
    });
    expect(result.gaps).toEqual([
      "News dataset is dated after the run date or undated; catalysts and risks are excluded.",
    ]);
    expect(
      newsSentimentAgent(
        { news: null, reportId: "AAPL", sentiment: null },
        { asOf: "2026-09-10" }
      )
    ).toMatchObject({
      gaps: [
        "No dated news in the last 30 days; the news dataset needs a refresh.",
      ],
      newsAgeDays: null,
      status: "unavailable",
    });
  });

  it("counts supplied labels without inventing sentiment", () => {
    const sentiment = SentimentFile.parse({
      asOf: "2026-09-09",
      posts: [
        { date: "2026-09-08", stance: "bull" },
        { date: "2026-09-08", stance: "bull" },
        { date: "2026-09-09", stance: "bear" },
        { date: "2026-09-11", stance: "bear" },
      ],
      source: " manual X review ",
    });
    const view = (asOf: string) =>
      newsSentimentAgent({ news, reportId: "AAPL", sentiment }, { asOf })
        .sentiment;
    expect(view("2026-09-10")).toMatchObject({
      counts: { bear: 1, bull: 2, neutral: 0 },
      netBullPct: 33.33,
      posts: 3,
      source: "manual X review",
      status: "supplied",
    });
    expect(view("2026-09-20").status).toBe("stale");
    expect(view("2026-09-01")).toEqual({
      reason:
        "Sentiment file is dated 2026-09-09, after the run date; it is excluded.",
      status: "after-run-date",
    });
    const empty = SentimentFile.parse({
      asOf: "2026-09-09",
      posts: [],
      source: "x",
    });
    expect(
      newsSentimentAgent(
        { news, reportId: "AAPL", sentiment: empty },
        { asOf: "2026-09-10" }
      ).sentiment
    ).toMatchObject({ netBullPct: null, posts: 0 });
  });

  it("rejects malformed sentiment files", () => {
    expect(
      SentimentFile.safeParse({
        asOf: "2026-09-09",
        posts: [{ date: "2026-09-09", stance: "moon" }],
        source: "x",
      }).success
    ).toBe(false);
    expect(
      SentimentFile.safeParse({ asOf: "2026-09-09", posts: [], source: " " })
        .success
    ).toBe(false);
    expect(
      SentimentFile.safeParse({ asOf: "soon", posts: [], source: "x" }).success
    ).toBe(false);
    expect(
      SentimentFile.safeParse({
        asOf: "2026-09-09",
        posts: [{ date: "x", stance: "bull" }],
        source: "x",
      }).success
    ).toBe(false);
    expect(
      SentimentFile.safeParse({
        asOf: "2026-09-09",
        extra: 1,
        posts: [],
        source: "x",
      }).success
    ).toBe(false);
  });
});
