// Pitch agent for the paper agent desk: one readiness posture, a scenario tree, exit references
// and a monitoring list for one ticker as of the run date.
//
// The structure adapts ideas of LangAlpha (https://github.com/ginlix-ai/LangAlpha, commit
// e102a7838225157f7b3beca3fc274b26be852154, Apache License 2.0, Copyright 2025 Ginlix AI; see
// NOTICE): the readiness posture ladder of
// plugins/langalpha_research/skills/research-conventions/SKILL.md and the scenario tree, exit
// levels and monitoring steps of plugins/langalpha_research/skills/trade-pitch/SKILL.md.
// Modified: short terms of art (posture names) are kept; no code or passages are copied. Those
// skills are instructions for a language model; this file is a deterministic TypeScript function
// over the results of the other desk agents and the accepted fundamentals dataset. It calls no
// model and no network, and it gives no order, size, instrument or probability.
//
// The Vertex ladder stops at `review-ready`. LangAlpha's top posture, `decision-grade`, is
// deliberately not used: the desk does not collect scenario probabilities or bear-case
// liquidity checks, so no state of its inputs can earn that name.
//
// The agent describes what the inputs support. It is not an instruction to trade, and the paper
// book does not read it. Evidence dated after the run date is never used: the scenarios follow
// the same capture-date rule as the fundamental agent (`usableOn`).
import { z } from "zod";
import {
  type FundamentalResult,
  type Fundamentals,
  type NewsSentimentResult,
  parseAll,
  usableOn,
} from "./research.ts";
import {
  dayOf,
  isFiniteNumber,
  roundTo,
  type TechnicalResult,
} from "./technical.ts";

export type Posture = "review-ready" | "screen-grade" | "not-ready" | "blocked";

type ScenarioCase = "bear" | "base" | "bull";
type DatedTitle = Readonly<{ date: string; title: string }>;
type PitchScenario = Readonly<{
  case: ScenarioCase;
  upsidePct: number;
  presentPrice: number | null;
}>;

export type PitchResult = Readonly<{
  agent: "pitch";
  /** `not-applicable` when company fundamentals do not apply (ETF, future, index). */
  status: "not-applicable" | "evaluated";
  /** What the analysis supports. Never an instruction; the desk is long-only, so no short. */
  direction: "long-supported" | "not-supported" | "unknown";
  /** One posture for the evidence, not for the strength of the view. Null when not applicable. */
  posture: Posture | null;
  /** Why the posture is what it is, or why none is given. Never empty. */
  postureReasons: readonly string[];
  /** Ordered bear, base, bull; only cases with a finite upsidePct of -100 or more. */
  scenarios: readonly PitchScenario[];
  /**
   * Null unless bear, base and bull all exist with bear <= base <= bull by upsidePct. This
   * agent does not read scenario probabilities, so the weighted figure is always null.
   */
  skew: Readonly<{
    label: "illustrative";
    probabilityWeightedUpsidePct: null;
    note: string;
  }> | null;
  exits: Readonly<{
    /**
     * The rule's SMA at the latest bar, only while the close is above it; distancePct is
     * (level / close - 1) * 100, so it is negative or, after rounding, 0. A reference level, not a
     * stop order.
     */
    smaExitReference: Readonly<{
      level: number;
      basis: string;
      distancePct: number;
    }> | null;
    /** The changes that break a `long-supported` view; empty for any other direction. */
    reUnderwrite: readonly string[];
    /** The nearest upcoming dated catalyst after the run date. An event, not a deadline. */
    nextCatalyst: DatedTitle | null;
  }>;
  /** Upcoming dated catalysts, ascending, at most MAX_MONITORING; titles are bounded. */
  monitoring: readonly DatedTitle[];
  gaps: readonly string[];
}>;

export type PitchInput = Readonly<{
  asOf: string;
  fundamental: FundamentalResult;
  newsSentiment: NewsSentimentResult;
  technical: TechnicalResult;
  /** The raw fundamentals dataset; only `asOf` and `valuation.scenarios` are read. */
  fundamentals: Fundamentals | null;
}>;

export const MAX_MONITORING = 5;
export const MAX_TITLE_LENGTH = 120;
// Sanity bounds for dataset figures: a value beyond them is a data error, not a scenario.
const MAX_UPSIDE_PCT = 100_000;
const MAX_PRESENT_PRICE = 1_000_000_000;

const CASES = ["bear", "base", "bull"] as const;
const ScenarioRecord = z.looseObject({
  id: z.string(),
  presentPrice: z.unknown().optional(),
  upsidePct: z.unknown(),
});

const DATASET_EXCLUDED =
  "Fundamentals dataset is dated after the run date or undated";
const CEILING_REASON =
  "Scenario probabilities and bear-case liquidity checks are not collected, so the posture stops at review-ready.";
const PITCH_GAPS = Object.freeze([
  "This agent does not read scenario probabilities, so no probability-weighted return is given.",
  "Bear-case liquidity, covenant and maturity checks are not collected.",
  "Instrument, size and order levels are out of scope: the desk is paper only.",
]);

type ScenarioView = Readonly<{
  capturedOn: string;
  cases: readonly PitchScenario[];
}>;

/**
 * The first record of each case from a dataset captured at or before the run date; null when
 * the dataset is missing, undated or captured later. A case is dropped when its upside is not
 * a finite number, is below -100 (a price cannot fall further) or is above MAX_UPSIDE_PCT; a
 * present price becomes null unless it is finite, at most MAX_PRESENT_PRICE and still above 0
 * after rounding to four decimals.
 */
const scenarioViewOn = (
  fundamentals: Fundamentals | null,
  asOf: string
): ScenarioView | null => {
  const capturedOn =
    fundamentals !== null && usableOn(fundamentals.asOf, asOf)
      ? dayOf(fundamentals.asOf)
      : null;
  if (fundamentals === null || capturedOn === null) return null;
  const records = parseAll(
    ScenarioRecord,
    fundamentals.valuation?.scenarios ?? []
  );
  const cases = CASES.flatMap((name) => {
    const record = records.find((entry) => entry.id === name);
    if (
      record === undefined ||
      !isFiniteNumber(record.upsidePct) ||
      record.upsidePct < -100 ||
      record.upsidePct > MAX_UPSIDE_PCT
    )
      return [];
    const price =
      isFiniteNumber(record.presentPrice) &&
      record.presentPrice <= MAX_PRESENT_PRICE
        ? roundTo(record.presentPrice)
        : null;
    return [
      {
        case: name,
        presentPrice: price !== null && price > 0 ? price : null,
        upsidePct: roundTo(record.upsidePct, 2) as number,
      },
    ];
  });
  return { capturedOn, cases };
};

/** True when each upside is at least the one before it (bear, base, bull order). */
const isOrdered = (scenarios: readonly PitchScenario[]): boolean => {
  const values = scenarios.map((scenario) => scenario.upsidePct);
  return values.every((value, index) => value >= (values[index - 1] ?? value));
};

type PostureState = Readonly<{
  fundamental: FundamentalResult;
  newsSentiment: NewsSentimentResult;
  technical: TechnicalResult;
  scenarios: readonly PitchScenario[];
  /** A fundamentals dataset exists but its capture date rules it out for this run. */
  datasetExcluded: boolean;
  monitoring: readonly DatedTitle[];
}>;
type PostureRule = Readonly<{
  posture: Posture;
  /** The reason this row holds for the state, or null when it does not. */
  when: (state: PostureState) => string | null;
}>;

// The one posture table, lowest posture first. The first row that holds sets the posture, and
// every held row of that same posture adds its reason. No row holds: review-ready with
// CEILING_REASON, the top of the Vertex ladder. Each run evaluates the table afresh; no earlier
// result is consulted.
const POSTURE_RULES: readonly PostureRule[] = [
  // blocked: a dataset the pitch depends on is missing.
  {
    posture: "blocked",
    when: ({ fundamental }) =>
      fundamental.status === "evaluated"
        ? null
        : `Fundamentals ${fundamental.status}: ${fundamental.reasons.join(" ")}`,
  },
  {
    posture: "blocked",
    when: ({ technical }) =>
      technical.status === "unavailable"
        ? `Technical unavailable: ${technical.reason}`
        : null,
  },
  // not-ready: an input the view rests on is too old or too weak.
  {
    posture: "not-ready",
    when: ({ fundamental }) => {
      if (!fundamental.stale) return null;
      return fundamental.evidenceAgeDays === null
        ? "Fundamentals stale: no dated earnings or fundamentals evidence at or before the run date."
        : `Fundamentals stale: latest earnings evidence is ${fundamental.evidenceAgeDays} days old.`;
    },
  },
  // A Vertex row: a view the committee itself marks insufficient-data must not pass as
  // review-ready.
  {
    posture: "not-ready",
    when: ({ fundamental }) =>
      fundamental.committee?.status === "insufficient-data"
        ? "Committee status is insufficient-data."
        : null,
  },
  {
    posture: "not-ready",
    when: ({ technical }) =>
      technical.status === "insufficient-data"
        ? `Technical insufficient data: ${technical.reason}`
        : null,
  },
  {
    posture: "not-ready",
    when: ({ technical }) =>
      technical.stale
        ? `Technical stale: latest bar ${technical.barDate} is ${technical.staleDays} days old.`
        : null,
  },
  // screen-grade: the scenario or catalyst coverage has holes.
  {
    posture: "screen-grade",
    when: ({ scenarios, datasetExcluded }) => {
      if (scenarios.length === CASES.length) return null;
      return datasetExcluded
        ? `${DATASET_EXCLUDED}, so its valuation scenarios are not used; bear, base and bull are all needed.`
        : `Valuation scenarios present: ${scenarios.map((scenario) => scenario.case).join(", ") || "none"}; bear, base and bull are all needed.`;
    },
  },
  {
    posture: "screen-grade",
    when: ({ scenarios }) =>
      scenarios.length === CASES.length && !isOrdered(scenarios)
        ? "Scenario cases are not ordered: the upside must not fall from bear to base to bull."
        : null,
  },
  {
    posture: "screen-grade",
    when: ({ monitoring }) =>
      monitoring.length === 0
        ? "No upcoming dated catalyst after the run date."
        : null,
  },
  // review-ready: every input is usable and a named check remains.
  {
    posture: "review-ready",
    when: ({ newsSentiment }) =>
      newsSentiment.sentiment.status === "supplied"
        ? null
        : `Sentiment check is open: ${newsSentiment.sentiment.status}.`,
  },
  {
    posture: "review-ready",
    when: ({ fundamental }) =>
      fundamental.committee === null
        ? "Committee view is missing, undated or dated after the run date."
        : null,
  },
];

const readPosture = (
  state: PostureState
): Readonly<{ posture: Posture; postureReasons: readonly string[] }> => {
  const held = POSTURE_RULES.flatMap((rule) => {
    const reason = rule.when(state);
    return reason === null ? [] : [{ posture: rule.posture, reason }];
  });
  const first = held[0];
  if (first === undefined)
    return { posture: "review-ready", postureReasons: [CEILING_REASON] };
  return {
    posture: first.posture,
    postureReasons: held
      .filter((entry) => entry.posture === first.posture)
      .map((entry) => entry.reason),
  };
};

/**
 * Long-supported needs both a base case with upside and an evaluated uptrend (close above the
 * SMA and the SMA rising). A missing input gives unknown, also when the other one fails. The
 * base case must also be in this agent's own scenario tree: a base case that the tree dropped
 * as a data error cannot support a direction.
 */
const directionOf = (
  fundamental: FundamentalResult,
  technical: TechnicalResult,
  scenarios: readonly PitchScenario[]
): PitchResult["direction"] => {
  const { checks } = technical;
  if (
    fundamental.valuationView === "unknown" ||
    !scenarios.some((scenario) => scenario.case === "base") ||
    technical.status !== "evaluated" ||
    checks === null ||
    checks.closeAboveSma === null ||
    checks.smaRising === null
  )
    return "unknown";
  return fundamental.valuationView === "base-case-upside" &&
    checks.closeAboveSma &&
    checks.smaRising
    ? "long-supported"
    : "not-supported";
};

/** Null unless the technical agent evaluated the rule and the close is above a positive SMA. */
const smaExitReferenceOf = (
  technical: TechnicalResult
): PitchResult["exits"]["smaExitReference"] => {
  const { close, sma } = technical;
  if (
    technical.status !== "evaluated" ||
    close === null ||
    sma === null ||
    sma <= 0 ||
    close <= sma
  )
    return null;
  return {
    basis: `${technical.rule.smaPeriod}-session SMA at the ${technical.barDate} close; one of the desk's paper exit rules is a close below it.`,
    distancePct: roundTo((sma / close - 1) * 100, 2) as number,
    level: sma,
  };
};

const SCENARIO_CLAIMS = [
  ["base", "Base-case upside turns negative or zero"],
  ["bear", "Bear-case return is revised"],
] as const;

/**
 * The changes that break a long-supported view; any other direction has no view to break, so
 * the list is empty. The rules name inputs and dates only: no free text of a dataset is
 * repeated, and a scenario figure is given with the capture date of its dataset.
 */
const scenarioClaimsOf = (view: ScenarioView): string[] =>
  SCENARIO_CLAIMS.flatMap(([name, claim]) => {
    const found = view.cases.find((scenario) => scenario.case === name);
    return found === undefined
      ? []
      : [
          `${claim}; the fundamentals dataset captured ${view.capturedOn} gives ${found.upsidePct}%.`,
        ];
  });

const reUnderwriteOf = (
  direction: PitchResult["direction"],
  fundamental: FundamentalResult,
  technical: TechnicalResult,
  scenarioClaims: readonly string[]
): string[] => {
  if (direction !== "long-supported") return [];
  const period = technical.rule.smaPeriod;
  const rules = [...scenarioClaims];
  if (fundamental.committee !== null) rules.push("Committee status changes.");
  if (fundamental.lastEarnings !== null)
    rules.push(
      `A new earnings report replaces the ${fundamental.lastEarnings.date} evidence.`
    );
  rules.push(
    `The close falls below the ${period}-session SMA.`,
    `The ${period}-session SMA stops rising.`
  );
  return rules;
};

const byText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * One line of at most MAX_TITLE_LENGTH UTF-16 units, never ending on half of a surrogate pair
 * or on a space. Each run of white space, control, format or other invisible characters becomes
 * one space, and the field separator of the desk summary becomes a slash, so dataset text can
 * neither add a line to the summary nor imitate one of its fields. The result can be empty.
 */
const boundedTitle = (title: string): string =>
  title
    .replace(/[\p{C}\p{Z}\s]+/gu, " ")
    .replaceAll("|", "/")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();

/** Pitch agent: posture, scenario tree, exit references and monitoring for one ticker as of `asOf`. */
export const pitchAgent = ({
  asOf,
  fundamental,
  newsSentiment,
  technical,
  fundamentals,
}: PitchInput): PitchResult => {
  if (fundamental.status === "not-applicable") {
    return {
      agent: "pitch",
      direction: "unknown",
      exits: { nextCatalyst: null, reUnderwrite: [], smaExitReference: null },
      gaps: [],
      monitoring: [],
      posture: null,
      postureReasons: [...fundamental.reasons],
      scenarios: [],
      skew: null,
      status: "not-applicable",
    };
  }
  const view = scenarioViewOn(fundamentals, asOf);
  const scenarios = view?.cases ?? [];
  const datasetExcluded = fundamentals !== null && view === null;
  // A catalyst with no visible title is dropped. Same-date catalysts are ordered by the shown
  // title, so the list does not depend on dataset order.
  const monitoring = newsSentiment.upcomingCatalysts
    .map(({ date, title }) => ({ date, title: boundedTitle(title) }))
    .filter((item) => item.date > asOf && item.title !== "")
    .sort((a, b) => byText(a.date, b.date) || byText(a.title, b.title))
    .slice(0, MAX_MONITORING);
  const direction = directionOf(fundamental, technical, scenarios);
  const gaps = [...PITCH_GAPS];
  if (datasetExcluded)
    gaps.push(`${DATASET_EXCLUDED}; its scenarios are excluded.`);
  return {
    agent: "pitch",
    direction,
    exits: {
      nextCatalyst: monitoring[0] ?? null,
      reUnderwrite: reUnderwriteOf(
        direction,
        fundamental,
        technical,
        view === null ? [] : scenarioClaimsOf(view)
      ),
      smaExitReference: smaExitReferenceOf(technical),
    },
    gaps,
    monitoring,
    ...readPosture({
      datasetExcluded,
      fundamental,
      monitoring,
      newsSentiment,
      scenarios,
      technical,
    }),
    scenarios,
    skew:
      scenarios.length === CASES.length && isOrdered(scenarios)
        ? {
            label: "illustrative",
            note: `Illustrative skew: ${scenarios.map((scenario) => `${scenario.case} ${scenario.upsidePct}%`).join(", ")}. This agent does not read scenario probabilities, so no weighted figure is given.`,
            probabilityWeightedUpsidePct: null,
          }
        : null,
    status: "evaluated",
  };
};
