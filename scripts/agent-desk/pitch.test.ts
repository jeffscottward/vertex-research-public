import { describe, expect, it } from "vitest";
import { bars, dateAt, signalCloses } from "./fixtures.test-support.ts";
import { MAX_MONITORING, type PitchInput, pitchAgent } from "./pitch.ts";
import {
  CommitteeDataset,
  FundamentalsDataset,
  fundamentalAgent,
  NewsDataset,
  newsSentimentAgent,
  type Sentiment,
} from "./research.ts";
import {
  type Bar,
  ruleParameters,
  ruleSeries,
  type TechnicalResult,
  technicalAgent,
} from "./technical.ts";

const rule = ruleParameters();
const rising = bars(signalCloses());
const falling = bars(Array.from({ length: 300 }, (_, index) => 300 - index));
const lastDate = dateAt(rising.length - 1);
const later = (days: number) => dateAt(rising.length - 1 + days);

const threeCases = [
  { id: "bull", presentPrice: 267.697_477, upsidePct: 22.594_558 },
  { id: "base", presentPrice: 109.2, upsidePct: 8.126 },
  { id: "bear", presentPrice: 30.9, upsidePct: -85.869_542 },
];
const catalysts = [
  { date: later(40), title: "Investor day" },
  { date: later(12), title: "Product launch" },
];

type Scene = Readonly<{
  asOf?: string;
  assetType?: string;
  history?: readonly Bar[];
  fundamentals?: unknown;
  news?: unknown;
  committee?: unknown;
  sentiment?: Sentiment | null;
}>;

const fullFundamentals = (scenarios: unknown = threeCases) => ({
  asOf: lastDate,
  financialFacts: [{ asOf: lastDate }],
  valuation: { scenarios },
});
const fullNews = (list: unknown = catalysts) => ({
  asOf: lastDate,
  catalysts: list,
  items: [{ category: "earnings", date: lastDate, title: "Q2 results" }],
  risks: [],
});
const fullCommittee = {
  asOf: lastDate,
  finalRecommendation: { headline: null, horizon: null, status: "wait" },
};
const fullSentiment: Sentiment = {
  asOf: lastDate,
  posts: [{ date: lastDate, stance: "bull" }],
  source: "test labels",
};

/** Runs the three input agents the way the desk does, then returns the pitch input. */
const inputFor = (scene: Scene = {}): PitchInput => {
  const asOf = scene.asOf ?? lastDate;
  const history = (scene.history ?? rising).filter((bar) => bar.date <= asOf);
  const parse = <T>(
    schema: { parse: (value: unknown) => T },
    value: unknown
  ): T | null => (value === null ? null : schema.parse(value));
  const fundamentals = parse(
    FundamentalsDataset,
    "fundamentals" in scene ? scene.fundamentals : fullFundamentals()
  );
  const news = parse(NewsDataset, "news" in scene ? scene.news : fullNews());
  const committee = parse(
    CommitteeDataset,
    "committee" in scene ? scene.committee : fullCommittee
  );
  return {
    asOf,
    fundamental: fundamentalAgent(
      { assetType: scene.assetType ?? "equity", committee, fundamentals, news },
      { asOf }
    ),
    fundamentals,
    newsSentiment: newsSentimentAgent(
      {
        news,
        reportId: "AAA",
        sentiment: "sentiment" in scene ? scene.sentiment : fullSentiment,
      },
      { asOf }
    ),
    technical: technicalAgent(history, ruleSeries(history, rule), {
      asOf,
      rule,
    }),
  };
};
const pitchFor = (scene: Scene = {}) => pitchAgent(inputFor(scene));
const withTechnical = (overrides: Partial<TechnicalResult>) => {
  const input = inputFor();
  return pitchAgent({
    ...input,
    technical: { ...input.technical, ...overrides },
  });
};

describe("pitchAgent posture", () => {
  it("is decision-grade when every input is present and fresh", () => {
    const input = inputFor();
    const sma = input.technical.sma as number;
    const close = input.technical.close as number;
    expect(pitchAgent(input)).toEqual({
      agent: "pitch",
      direction: "long-supported",
      exits: {
        priceStop: {
          basis: `200-session SMA at the ${lastDate} close; the desk's paper exit rule is a close below it.`,
          distancePct: Math.round((sma / close - 1) * 10_000) / 100,
          level: sma,
        },
        reUnderwrite: [
          "Base-case upside (now 8.13%) turns negative.",
          "Bear-case return (now -85.87%) is revised in the fundamentals dataset.",
          "Committee status changes from wait.",
          `A new earnings report replaces the ${lastDate} evidence.`,
          "The 200-session SMA stops rising.",
        ],
        timeStop: { date: later(12), title: "Product launch" },
      },
      gaps: [
        "Scenario probabilities are not collected; the probability-weighted return is withheld.",
        "Bear-case liquidity, covenant and maturity checks are not collected.",
        "Instrument, size and order levels are out of scope: the desk is paper only.",
      ],
      monitoring: [
        { date: later(12), title: "Product launch" },
        { date: later(40), title: "Investor day" },
      ],
      posture: "decision-grade",
      postureReasons: [],
      scenarios: [
        { case: "bear", presentPrice: 30.9, upsidePct: -85.87 },
        { case: "base", presentPrice: 109.2, upsidePct: 8.13 },
        { case: "bull", presentPrice: 267.6975, upsidePct: 22.59 },
      ],
      skew: {
        label: "illustrative",
        note: "Illustrative skew: bear -85.87%, base 8.13%, bull 22.59%. The datasets carry no scenario probabilities, so no probability-weighted upside is computed.",
        probabilityWeightedUpsidePct: null,
      },
      status: "evaluated",
    });
  });

  it("is blocked when an input cannot be obtained, and names each one", () => {
    const missing = pitchFor({ fundamentals: null });
    expect(missing).toMatchObject({
      direction: "unknown",
      posture: "blocked",
      postureReasons: [
        "Fundamentals unavailable: Fundamentals dataset is missing.",
      ],
      status: "evaluated",
    });
    expect(pitchFor({ fundamentals: null, history: [] })).toMatchObject({
      exits: { priceStop: null },
      posture: "blocked",
      postureReasons: [
        "Fundamentals unavailable: Fundamentals dataset is missing.",
        "Technical unavailable: No completed daily bars at or before the run date.",
      ],
    });
    expect(pitchFor({ history: [] }).postureReasons).toEqual([
      "Technical unavailable: No completed daily bars at or before the run date.",
    ]);
  });

  it("is not-ready when a load-bearing input is stale or unsupported", () => {
    // Bars are fresh; the only earnings evidence is 150 days old.
    const oldDate = later(-150);
    const stale = pitchFor({
      fundamentals: { ...fullFundamentals(), asOf: oldDate },
      news: {
        ...fullNews(),
        items: [{ category: "earnings", date: oldDate, title: "Q1 results" }],
      },
    });
    expect(stale.posture).toBe("not-ready");
    expect(stale.postureReasons).toEqual([
      "Fundamentals stale: latest earnings evidence is 150 days old.",
    ]);

    const undated = pitchFor({
      fundamentals: { ...fullFundamentals(), asOf: null },
      news: null,
    });
    expect(undated.posture).toBe("not-ready");
    expect(undated.postureReasons).toEqual([
      "Fundamentals stale: no dated earnings or fundamentals evidence at or before the run date.",
    ]);

    expect(
      pitchFor({
        committee: {
          asOf: lastDate,
          finalRecommendation: { status: "insufficient-data" },
        },
      })
    ).toMatchObject({
      posture: "not-ready",
      postureReasons: ["Committee status is insufficient-data."],
    });

    const short = pitchFor({ history: rising.slice(-100) });
    expect(short).toMatchObject({
      direction: "unknown",
      exits: { priceStop: null },
      posture: "not-ready",
      postureReasons: [
        "Technical insufficient data: Rule needs 220 completed bars; 100 observed.",
      ],
    });

    // Ten days after the last bar: bars are stale, fundamentals are not.
    const oldBars = pitchFor({ asOf: later(10) });
    expect(oldBars.posture).toBe("not-ready");
    expect(oldBars.postureReasons).toEqual([
      `Technical stale: latest bar ${lastDate} is 10 days old.`,
    ]);
    // Posture describes the inputs, not conviction: the view itself is unchanged.
    expect(oldBars.direction).toBe("long-supported");
  });

  it("is screen-grade when coverage is thin", () => {
    const twoCases = pitchFor({
      fundamentals: fullFundamentals(threeCases.slice(0, 2)),
    });
    expect(twoCases).toMatchObject({
      posture: "screen-grade",
      postureReasons: [
        "Valuation scenarios present: base, bull; bear, base and bull are all needed.",
      ],
      skew: null,
    });
    expect(
      pitchFor({ fundamentals: fullFundamentals([]), news: fullNews([]) })
    ).toMatchObject({
      exits: { timeStop: null },
      monitoring: [],
      posture: "screen-grade",
      postureReasons: [
        "Valuation scenarios present: none; bear, base and bull are all needed.",
        "No upcoming dated catalyst after the run date.",
      ],
    });
  });

  it("is review-ready when one check is still open", () => {
    expect(pitchFor({ sentiment: null })).toMatchObject({
      direction: "long-supported",
      posture: "review-ready",
      postureReasons: ["Sentiment check is open: unavailable."],
    });
    expect(
      pitchFor({ sentiment: { ...fullSentiment, asOf: later(-9) } })
        .postureReasons
    ).toEqual(["Sentiment check is open: stale."]);
    const noCommittee = pitchFor({ committee: null, sentiment: null });
    expect(noCommittee.posture).toBe("review-ready");
    expect(noCommittee.postureReasons).toEqual([
      "Sentiment check is open: unavailable.",
      "Committee view is missing or dated after the run date.",
    ]);
    expect(noCommittee.exits.reUnderwrite).not.toContainEqual(
      expect.stringContaining("Committee")
    );
  });

  it("does not apply to assets without company fundamentals", () => {
    for (const assetType of ["etf", "future", "index"]) {
      expect(pitchFor({ assetType })).toEqual({
        agent: "pitch",
        direction: "unknown",
        exits: { priceStop: null, reUnderwrite: [], timeStop: null },
        gaps: [],
        monitoring: [],
        posture: "blocked",
        postureReasons: [
          `Fundamentals not-applicable: Company fundamentals do not apply to asset type ${assetType}.`,
        ],
        scenarios: [],
        skew: null,
        status: "not-applicable",
      });
    }
  });
});

describe("pitchAgent direction", () => {
  const downside = fullFundamentals([
    { id: "bear", upsidePct: -60 },
    { id: "base", upsidePct: -5 },
    { id: "bull", upsidePct: 20 },
  ]);

  it("supports a long only with base-case upside and a rising trend", () => {
    expect(pitchFor().direction).toBe("long-supported");
    const negative = pitchFor({ fundamentals: downside });
    expect(negative.direction).toBe("not-supported");
    expect(negative.exits.reUnderwrite[0]).toBe(
      "Base-case upside (now -5%) turns positive."
    );
    const downtrend = pitchFor({
      asOf: dateAt(299),
      fundamentals: { ...fullFundamentals(), asOf: dateAt(299) },
      history: falling,
    });
    expect(downtrend.scenarios).toHaveLength(3);
    expect(downtrend.direction).toBe("not-supported");
    expect(
      withTechnical({
        checks: {
          closeAboveSma: true,
          priorRocHigh: true,
          rocNearZero: true,
          smaRising: false,
        },
      })
    ).toMatchObject({
      direction: "not-supported",
      exits: {
        reUnderwrite: expect.arrayContaining([
          "The 200-session SMA starts rising.",
        ]),
      },
    });
  });

  it("is unknown when an input is missing and never short", () => {
    const noBase = pitchFor({
      fundamentals: fullFundamentals([{ id: "bear", upsidePct: -10 }]),
    });
    expect(noBase.direction).toBe("unknown");
    expect(withTechnical({ status: "insufficient-data" }).direction).toBe(
      "unknown"
    );
    expect(withTechnical({ checks: null }).direction).toBe("unknown");
    const checks = {
      closeAboveSma: true,
      priorRocHigh: null,
      rocNearZero: null,
      smaRising: true,
    };
    expect(
      withTechnical({ checks: { ...checks, closeAboveSma: null } }).direction
    ).toBe("unknown");
    const noSlope = withTechnical({ checks: { ...checks, smaRising: null } });
    expect(noSlope.direction).toBe("unknown");
    expect(noSlope.exits.reUnderwrite).not.toContainEqual(
      expect.stringContaining("SMA")
    );
    // Base-case downside in a downtrend is "not-supported", not a short view.
    const worst = pitchFor({
      asOf: dateAt(299),
      fundamentals: { ...downside, asOf: dateAt(299) },
      history: falling,
    });
    expect(worst.direction).toBe("not-supported");
    expect(JSON.stringify(worst)).not.toMatch(/short/iu);
  });
});

describe("pitchAgent evidence as of the run date", () => {
  it("excludes a fundamentals dataset captured after the run date", () => {
    const early = pitchFor({ asOf: later(-1) });
    expect(early).toMatchObject({
      direction: "unknown",
      scenarios: [],
      skew: null,
    });
    expect(early.gaps).toContain(
      "Fundamentals dataset is dated after the run date or undated; its scenarios are excluded."
    );
    expect(early.exits.reUnderwrite).not.toContainEqual(
      expect.stringContaining("case")
    );
    // The news dataset is also later, so its catalyst list is not used either.
    expect(early.monitoring).toEqual([]);
    expect(pitchFor().scenarios).toHaveLength(3);
  });

  it("drops a catalyst that is not after the run date", () => {
    const input = inputFor();
    const result = pitchAgent({
      ...input,
      newsSentiment: {
        ...input.newsSentiment,
        upcomingCatalysts: [
          { date: lastDate, title: "Today" },
          { date: later(-3), title: "Past" },
          { date: later(2), title: "Next" },
        ],
      },
    });
    expect(result.monitoring).toEqual([{ date: later(2), title: "Next" }]);
  });
});

describe("pitchAgent scenario tree", () => {
  it("orders bear, base, bull and keeps only finite cases", () => {
    const result = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bull", presentPrice: "n/a", upsidePct: 30.005 },
        { id: "base", upsidePct: "12" },
        "bad",
        { id: "other", upsidePct: 1 },
        { id: "bear", presentPrice: 10.123_456, upsidePct: -40 },
        { id: "bear", upsidePct: -99 },
        { id: "base", upsidePct: 50 },
      ]),
    });
    // The first record of a case counts, as in the fundamental agent: the first base record
    // has no numeric upside, so the base case is absent.
    expect(result.scenarios).toEqual([
      { case: "bear", presentPrice: 10.1235, upsidePct: -40 },
      { case: "bull", presentPrice: null, upsidePct: 30.01 },
    ]);
    expect(result.skew).toBeNull();
    expect(result.direction).toBe("unknown");
    expect(
      pitchFor({ fundamentals: { ...fullFundamentals(), valuation: null } })
        .scenarios
    ).toEqual([]);
  });

  it("withholds the probability-weighted figure", () => {
    const { skew } = pitchFor();
    expect(skew?.label).toBe("illustrative");
    expect(skew?.probabilityWeightedUpsidePct).toBeNull();
    expect(skew?.note).toContain("no scenario probabilities");
  });
});

describe("pitchAgent exits and monitoring", () => {
  it("places the price stop at the SMA and measures it from the close", () => {
    expect(withTechnical({ close: 200, sma: 150 }).exits.priceStop).toEqual({
      basis: `200-session SMA at the ${lastDate} close; the desk's paper exit rule is a close below it.`,
      distancePct: -25,
      level: 150,
    });
    expect(
      withTechnical({ close: 90, sma: 100 }).exits.priceStop?.distancePct
    ).toBe(11.11);
    expect(
      withTechnical({ status: "insufficient-data" }).exits.priceStop
    ).toBeNull();
    expect(withTechnical({ close: null }).exits.priceStop).toBeNull();
    expect(withTechnical({ sma: null }).exits.priceStop).toBeNull();
  });

  it("uses the nearest catalyst as the time stop and bounds the list", () => {
    const many = [9, 3, 30, 1, 14, 21, 5].map((days) => ({
      date: later(days),
      title: `Event ${days}`,
    }));
    const result = pitchFor({
      news: fullNews([...many, { date: null, title: "Undated" }]),
    });
    expect(result.exits.timeStop).toEqual({
      date: later(1),
      title: "Event 1",
    });
    expect(result.monitoring).toHaveLength(MAX_MONITORING);
    expect(result.monitoring.map((item) => item.title)).toEqual([
      "Event 1",
      "Event 3",
      "Event 5",
      "Event 9",
      "Event 14",
    ]);
  });

  it("derives claim rules only from inputs that are present", () => {
    const bare = pitchFor({
      committee: null,
      fundamentals: fullFundamentals([]),
      history: rising.slice(-100),
      news: { ...fullNews(), items: [{ date: lastDate, title: "Note" }] },
    });
    expect(bare.exits.reUnderwrite).toEqual([]);
    expect(
      pitchFor({ committee: { asOf: lastDate, finalRecommendation: {} } }).exits
        .reUnderwrite
    ).toContain("Committee status changes from not stated.");
  });
});
