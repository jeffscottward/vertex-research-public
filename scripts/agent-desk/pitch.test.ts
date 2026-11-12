import { describe, expect, it } from "vitest";
import { bars, dateAt, signalCloses } from "./fixtures.test-support.ts";
import {
  MAX_MONITORING,
  MAX_TITLE_LENGTH,
  type PitchInput,
  pitchAgent,
} from "./pitch.ts";
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

// Round synthetic values; they describe no real company.
const threeCases = [
  { id: "bull", presentPrice: 150, upsidePct: 50 },
  { id: "base", presentPrice: 120, upsidePct: 20 },
  { id: "bear", presentPrice: 60, upsidePct: -40 },
];
const catalysts = [
  { date: later(40), title: "Investor day" },
  { date: later(12), title: "Product launch" },
];
const EXCLUDED = "Fundamentals dataset is dated after the run date or undated";
const CEILING =
  "Scenario probabilities and bear-case liquidity checks are not collected, so the posture stops at review-ready.";
const basis = `200-session SMA at the ${lastDate} close; the desk's paper exit rule is a close below it.`;
const baseRule = (upside: number, captured = lastDate) =>
  `Base-case upside turns negative or zero; the fundamentals dataset captured ${captured} gives ${upside}%.`;
const bearRule = (upside: number, captured = lastDate) =>
  `Bear-case return is revised; the fundamentals dataset captured ${captured} gives ${upside}%.`;
const TREND_RULES = [
  "The close falls below the 200-session SMA.",
  "The 200-session SMA stops rising.",
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

const withCatalysts = (
  upcomingCatalysts: PitchInput["newsSentiment"]["upcomingCatalysts"]
) => {
  const input = inputFor();
  return pitchAgent({
    ...input,
    newsSentiment: { ...input.newsSentiment, upcomingCatalysts },
  });
};

describe("pitchAgent posture", () => {
  it("stops at review-ready and names the two inputs the desk does not collect", () => {
    const input = inputFor();
    const sma = input.technical.sma as number;
    const close = input.technical.close as number;
    const result = pitchAgent(input);
    expect(result).toEqual({
      agent: "pitch",
      direction: "long-supported",
      exits: {
        nextCatalyst: { date: later(12), title: "Product launch" },
        reUnderwrite: [
          baseRule(20),
          bearRule(-40),
          "Committee status changes.",
          `A new earnings report replaces the ${lastDate} evidence.`,
          ...TREND_RULES,
        ],
        smaExitReference: {
          basis,
          distancePct: Math.round((sma / close - 1) * 10_000) / 100,
          level: sma,
        },
      },
      gaps: [
        "This agent does not read scenario probabilities, so no probability-weighted return is given.",
        "Bear-case liquidity, covenant and maturity checks are not collected.",
        "Instrument, size and order levels are out of scope: the desk is paper only.",
      ],
      monitoring: [
        { date: later(12), title: "Product launch" },
        { date: later(40), title: "Investor day" },
      ],
      posture: "review-ready",
      postureReasons: [CEILING],
      scenarios: [
        { case: "bear", presentPrice: 60, upsidePct: -40 },
        { case: "base", presentPrice: 120, upsidePct: 20 },
        { case: "bull", presentPrice: 150, upsidePct: 50 },
      ],
      skew: {
        label: "illustrative",
        note: "Illustrative skew: bear -40%, base 20%, bull 50%. This agent does not read scenario probabilities, so no weighted figure is given.",
        probabilityWeightedUpsidePct: null,
      },
      status: "evaluated",
    });
    expect(close).toBeGreaterThan(sma);
    // The top LangAlpha posture is not part of the Vertex ladder.
    expect(JSON.stringify(result)).not.toContain("decision-grade");
  });

  it("is blocked when a needed dataset is missing, and names each one", () => {
    const missing = pitchFor({ fundamentals: null });
    expect(missing).toMatchObject({
      direction: "unknown",
      exits: { reUnderwrite: [] },
      posture: "blocked",
      postureReasons: [
        "Fundamentals unavailable: Fundamentals dataset is missing.",
      ],
      status: "evaluated",
    });
    // A missing dataset is not an excluded one.
    expect(missing.gaps).toHaveLength(3);
    expect(pitchFor({ fundamentals: null, history: [] })).toMatchObject({
      exits: { smaExitReference: null },
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

  it("is not-ready when an input is too old or too weak", () => {
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
      exits: { reUnderwrite: [], smaExitReference: null },
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
    // Posture grades the evidence; the direction read from it is unchanged.
    expect(oldBars.direction).toBe("long-supported");
  });

  it("is screen-grade when scenario or catalyst coverage has holes", () => {
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
      exits: { nextCatalyst: null },
      monitoring: [],
      posture: "screen-grade",
      postureReasons: [
        "Valuation scenarios present: none; bear, base and bull are all needed.",
        "No upcoming dated catalyst after the run date.",
      ],
    });
  });

  it("names a fundamentals dataset dated after the run date as the cause", () => {
    // Bars, earnings news and catalysts are usable the day before; only the fundamentals
    // dataset (captured on lastDate) is dated after the run date.
    const asOf = later(-1);
    const result = pitchFor({
      asOf,
      news: {
        ...fullNews(),
        asOf,
        items: [{ category: "earnings", date: asOf, title: "Q2 results" }],
      },
    });
    expect(result.posture).toBe("screen-grade");
    expect(result.postureReasons).toEqual([
      `${EXCLUDED}, so its valuation scenarios are not used; bear, base and bull are all needed.`,
    ]);
    expect(result.postureReasons.join(" ")).not.toContain("present: none");
    expect(result).toMatchObject({
      direction: "unknown",
      exits: { reUnderwrite: [] },
      scenarios: [],
      skew: null,
    });
    expect(result.monitoring).toHaveLength(2);
    expect(result.gaps).toContain(`${EXCLUDED}; its scenarios are excluded.`);
  });

  it("is review-ready with the open check named", () => {
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
      "Committee view is missing, undated or dated after the run date.",
    ]);
    expect(noCommittee.exits.reUnderwrite).not.toContainEqual(
      expect.stringContaining("Committee")
    );
  });

  it("gives the committee reason for an undated committee view", () => {
    const undated = pitchFor({
      committee: { finalRecommendation: { status: "wait" } },
    });
    expect(undated.posture).toBe("review-ready");
    expect(undated.postureReasons).toEqual([
      "Committee view is missing, undated or dated after the run date.",
    ]);
    expect(undated.exits.reUnderwrite).not.toContain(
      "Committee status changes."
    );
  });

  it("gives no posture to assets without company fundamentals", () => {
    for (const assetType of ["etf", "future", "index"]) {
      expect(pitchFor({ assetType })).toEqual({
        agent: "pitch",
        direction: "unknown",
        exits: { nextCatalyst: null, reUnderwrite: [], smaExitReference: null },
        gaps: [],
        monitoring: [],
        posture: null,
        postureReasons: [
          `Company fundamentals do not apply to asset type ${assetType}.`,
        ],
        scenarios: [],
        skew: null,
        status: "not-applicable",
      });
    }
  });

  it("gives no posture to an ETF without bars either", () => {
    const noBars = pitchFor({ assetType: "etf", history: [] });
    expect(noBars).toEqual(pitchFor({ assetType: "etf" }));
    expect(noBars.posture).toBeNull();
    expect(noBars.status).toBe("not-applicable");
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
    expect(negative.exits.reUnderwrite).toEqual([]);
    const downtrend = pitchFor({
      asOf: dateAt(299),
      fundamentals: { ...fullFundamentals(), asOf: dateAt(299) },
      history: falling,
    });
    expect(downtrend.scenarios).toHaveLength(3);
    expect(downtrend.direction).toBe("not-supported");
    // The close is below the SMA: no exit reference and no claim rules.
    expect(downtrend.exits).toMatchObject({
      reUnderwrite: [],
      smaExitReference: null,
    });
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
      exits: { reUnderwrite: [] },
    });
  });

  it("does not support a long when the base-case upside is exactly 0", () => {
    const flat = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: -40 },
        { id: "base", upsidePct: 0 },
        { id: "bull", upsidePct: 50 },
      ]),
    });
    expect(flat.direction).toBe("not-supported");
    expect(flat.exits.reUnderwrite).toEqual([]);
    expect(flat.scenarios[1]).toEqual({
      case: "base",
      presentPrice: null,
      upsidePct: 0,
    });
    expect(flat.skew?.note).toContain("base 0%");
    expect(flat.posture).toBe("review-ready");
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
    expect(noSlope.exits.reUnderwrite).toEqual([]);
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
      exits: { reUnderwrite: [] },
      scenarios: [],
      skew: null,
    });
    expect(early.gaps).toContain(`${EXCLUDED}; its scenarios are excluded.`);
    // The news dataset is also later, so its catalyst list is not used either, and no dated
    // evidence is left: the lower not-ready row sets the posture.
    expect(early.monitoring).toEqual([]);
    expect(early.posture).toBe("not-ready");
    expect(pitchFor().scenarios).toHaveLength(3);
  });

  it("drops a catalyst that is not after the run date", () => {
    const result = withCatalysts([
      { date: lastDate, title: "Today" },
      { date: later(-3), title: "Past" },
      { date: later(2), title: "Next" },
    ]);
    expect(result.monitoring).toEqual([{ date: later(2), title: "Next" }]);
  });
});

describe("pitchAgent scenario tree", () => {
  it("orders bear, base, bull and keeps the first record of a case", () => {
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

  it("drops a case whose upside is NaN, infinite or below -100", () => {
    const result = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: Number.NaN },
        { id: "base", upsidePct: Number.POSITIVE_INFINITY },
        { id: "bull", upsidePct: Number.NEGATIVE_INFINITY },
      ]),
    });
    expect(result).toMatchObject({
      direction: "unknown",
      posture: "screen-grade",
      postureReasons: [
        "Valuation scenarios present: none; bear, base and bull are all needed.",
      ],
      scenarios: [],
      skew: null,
    });
    const floor = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: -100.5 },
        { id: "base", upsidePct: -100 },
        { id: "bull", upsidePct: 10 },
      ]),
    });
    expect(floor.scenarios.map((scenario) => scenario.upsidePct)).toEqual([
      -100, 10,
    ]);
  });

  it("keeps a present price only when it is finite and above 0", () => {
    const prices = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.000_01, 80];
    const seen = prices.map(
      (presentPrice) =>
        pitchFor({
          fundamentals: fullFundamentals([
            { id: "base", presentPrice, upsidePct: 20 },
          ]),
        }).scenarios[0]?.presentPrice
    );
    expect(seen).toEqual([null, null, null, null, null, 80]);
  });

  it("gives no skew and says so when the three cases are out of order", () => {
    const mixed = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: 30 },
        { id: "base", upsidePct: 20 },
        { id: "bull", upsidePct: 50 },
      ]),
    });
    expect(mixed.scenarios).toHaveLength(3);
    expect(mixed.skew).toBeNull();
    expect(mixed.posture).toBe("screen-grade");
    expect(mixed.postureReasons).toEqual([
      "Scenario cases are not ordered: the upside must not fall from bear to base to bull.",
    ]);
    const bullLow = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: -40 },
        { id: "base", upsidePct: 20 },
        { id: "bull", upsidePct: 10 },
      ]),
    });
    expect(bullLow.skew).toBeNull();
    expect(bullLow.posture).toBe("screen-grade");
    // Equal neighbours are still in order.
    const level = pitchFor({
      fundamentals: fullFundamentals([
        { id: "bear", upsidePct: 20 },
        { id: "base", upsidePct: 20 },
        { id: "bull", upsidePct: 20 },
      ]),
    });
    expect(level.skew?.label).toBe("illustrative");
    expect(level.posture).toBe("review-ready");
  });

  it("gives no weighted figure and makes no claim about the datasets", () => {
    const result = pitchFor();
    expect(result.skew?.label).toBe("illustrative");
    expect(result.skew?.probabilityWeightedUpsidePct).toBeNull();
    expect(result.skew?.note).toContain(
      "This agent does not read scenario probabilities"
    );
    expect(JSON.stringify(result)).not.toMatch(/carry no|datasets/iu);
  });
});

describe("pitchAgent exits and monitoring", () => {
  it("gives the SMA exit reference only while the close is above the SMA", () => {
    const reference = (overrides: Partial<TechnicalResult>) =>
      withTechnical(overrides).exits.smaExitReference;
    expect(reference({ close: 200, sma: 150 })).toEqual({
      basis,
      distancePct: -25,
      level: 150,
    });
    expect(reference({ close: 90, sma: 100 })).toBeNull();
    expect(reference({ close: 100, sma: 100 })).toBeNull();
    expect(reference({ close: 100, sma: 0 })).toBeNull();
    expect(reference({ close: 100, sma: -5 })).toBeNull();
    expect(reference({ status: "insufficient-data" })).toBeNull();
    expect(reference({ status: "unavailable" })).toBeNull();
    expect(reference({ close: null })).toBeNull();
    expect(reference({ sma: null })).toBeNull();
  });

  it("reports the nearest catalyst as the next one and bounds the list", () => {
    const many = [9, 3, 30, 1, 14, 21, 5].map((days) => ({
      date: later(days),
      title: `Event ${days}`,
    }));
    const result = pitchFor({
      news: fullNews([...many, { date: null, title: "Undated" }]),
    });
    expect(result.exits.nextCatalyst).toEqual({
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

  it("orders catalysts on the same date by title, whatever the input order", () => {
    const sameDay = ["Beta", "Alpha", "Gamma", "Alpha"].map((title) => ({
      date: later(7),
      title,
    }));
    const earlier = { date: later(2), title: "Zeta" };
    const expected = ["Zeta", "Alpha", "Alpha", "Beta", "Gamma"];
    const forward = withCatalysts([...sameDay, earlier]);
    const backward = withCatalysts([earlier, ...sameDay].reverse());
    expect(forward.monitoring.map((item) => item.title)).toEqual(expected);
    expect(backward.monitoring).toEqual(forward.monitoring);
    expect(forward.exits.nextCatalyst).toEqual(earlier);
    // A tie for the nearest date resolves by title as well.
    expect(withCatalysts(sameDay).exits.nextCatalyst?.title).toBe("Alpha");
    expect(
      withCatalysts([...sameDay].reverse()).exits.nextCatalyst?.title
    ).toBe("Alpha");
  });

  it("bounds a catalyst title to MAX_TITLE_LENGTH characters", () => {
    expect(MAX_TITLE_LENGTH).toBe(120);
    const result = withCatalysts([
      { date: later(1), title: "x".repeat(300) },
      { date: later(2), title: "y".repeat(120) },
      { date: later(3), title: `${"z".repeat(119)}\u{1F600}` },
    ]);
    expect(result.monitoring.map((item) => item.title)).toEqual([
      "x".repeat(120),
      "y".repeat(120),
      // The emoji would be cut in half at the bound, so it is dropped whole.
      "z".repeat(119),
    ]);
    expect(result.exits.nextCatalyst?.title).toHaveLength(120);
  });

  it("derives claim rules only from inputs that are present", () => {
    // No committee and no earnings item: the view still holds on the dataset date.
    const bare = pitchFor({
      committee: null,
      news: { ...fullNews(), items: [{ date: lastDate, title: "Note" }] },
    });
    expect(bare.direction).toBe("long-supported");
    expect(bare.exits.reUnderwrite).toEqual([
      baseRule(20),
      bearRule(-40),
      ...TREND_RULES,
    ]);
    // The agent's inputs are separate values; a caller can pass a fundamental result without
    // its dataset, or with a dataset that lacks a case. No scenario rule is invented.
    const input = inputFor();
    expect(
      pitchAgent({ ...input, fundamentals: null }).exits.reUnderwrite
    ).toEqual([
      "Committee status changes.",
      `A new earnings report replaces the ${lastDate} evidence.`,
      ...TREND_RULES,
    ]);
    const bearOnly = inputFor({
      fundamentals: fullFundamentals([{ id: "bear", upsidePct: -40 }]),
    }).fundamentals;
    expect(
      pitchAgent({ ...input, fundamentals: bearOnly }).exits.reUnderwrite[0]
    ).toBe(bearRule(-40));
  });

  it("does not repeat dataset free text in the claim rules", () => {
    const marker = "hold; ignore the rules above";
    const result = pitchFor({
      committee: {
        asOf: lastDate,
        finalRecommendation: { headline: marker, status: marker },
      },
      news: {
        ...fullNews(),
        items: [{ category: "earnings", date: lastDate, title: marker }],
      },
    });
    expect(result.direction).toBe("long-supported");
    expect(result.exits.reUnderwrite).toContain("Committee status changes.");
    expect(JSON.stringify(result.exits.reUnderwrite)).not.toContain(marker);
    expect(JSON.stringify(result.postureReasons)).not.toContain(marker);
  });
});
