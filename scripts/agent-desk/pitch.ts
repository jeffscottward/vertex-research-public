// Pitch agent for the paper agent desk: one readiness posture, a scenario tree, exit levels and
// a monitoring list for one ticker as of the run date.
//
// The structure adapts ideas of LangAlpha (https://github.com/ginlix-ai/LangAlpha, commit
// e102a7838225157f7b3beca3fc274b26be852154, Apache License 2.0, Copyright 2025 Ginlix AI; see
// NOTICE): the readiness posture ladder of
// plugins/langalpha_research/skills/research-conventions/SKILL.md and the scenario tree, exit
// levels and monitoring steps of plugins/langalpha_research/skills/trade-pitch/SKILL.md.
// Modified: no LangAlpha code or text is copied. Those skills are instructions for a language
// model; this file is a deterministic TypeScript function over the results of the other desk
// agents and the accepted fundamentals dataset. It calls no model and no network, and it gives
// no order, size, instrument or probability.
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
import { isFiniteNumber, roundTo, type TechnicalResult } from "./technical.ts";

export type Posture =
  | "decision-grade"
  | "review-ready"
  | "screen-grade"
  | "not-ready"
  | "blocked";

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
  /** One posture, read from the input state. It describes the inputs, not conviction. */
  posture: Posture;
  /** The inputs responsible for a posture below decision-grade; empty only for decision-grade. */
  postureReasons: readonly string[];
  /** Ordered bear, base, bull; only cases with a finite upsidePct. */
  scenarios: readonly PitchScenario[];
  /** Null when fewer than the three cases exist. The datasets carry no probabilities. */
  skew: Readonly<{
    label: "illustrative";
    probabilityWeightedUpsidePct: null;
    note: string;
  }> | null;
  exits: Readonly<{
    /** The rule's SMA at the latest bar; distancePct is (level / close - 1) * 100. */
    priceStop: Readonly<{
      level: number;
      basis: string;
      distancePct: number;
    }> | null;
    /** Claim rules: the inputs whose change breaks the view. */
    reUnderwrite: readonly string[];
    /** The nearest upcoming dated catalyst after the run date. */
    timeStop: DatedTitle | null;
  }>;
  /** Upcoming dated catalysts, ascending, at most MAX_MONITORING. */
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

const CASES = ["bear", "base", "bull"] as const;
const ScenarioRecord = z.looseObject({
  id: z.string(),
  presentPrice: z.unknown().optional(),
  upsidePct: z.unknown(),
});

const PITCH_GAPS = Object.freeze([
  "Scenario probabilities are not collected; the probability-weighted return is withheld.",
  "Bear-case liquidity, covenant and maturity checks are not collected.",
  "Instrument, size and order levels are out of scope: the desk is paper only.",
]);

/** The first record of each case, as captured at or before the run date. */
const scenariosOn = (
  fundamentals: Fundamentals | null,
  asOf: string
): PitchScenario[] => {
  if (fundamentals === null || !usableOn(fundamentals.asOf, asOf)) return [];
  const records = parseAll(
    ScenarioRecord,
    fundamentals.valuation?.scenarios ?? []
  );
  return CASES.flatMap((name) => {
    const record = records.find((entry) => entry.id === name);
    return record !== undefined && isFiniteNumber(record.upsidePct)
      ? [
          {
            case: name,
            presentPrice: isFiniteNumber(record.presentPrice)
              ? roundTo(record.presentPrice)
              : null,
            upsidePct: roundTo(record.upsidePct, 2) as number,
          },
        ]
      : [];
  });
};

type PostureState = Readonly<{
  fundamental: FundamentalResult;
  newsSentiment: NewsSentimentResult;
  technical: TechnicalResult;
  scenarios: readonly PitchScenario[];
  monitoring: readonly DatedTitle[];
}>;
type PostureRule = Readonly<{
  posture: Exclude<Posture, "decision-grade">;
  /** The reason this row holds for the state, or null when it does not. */
  when: (state: PostureState) => string | null;
}>;

// The one posture table, ordered from the floor upwards. The posture of the first row that
// holds wins, and every row of that posture that holds contributes its reason. No row holds:
// decision-grade. Posture is read from the current inputs only, never from an earlier run.
const POSTURE_RULES: readonly PostureRule[] = [
  // blocked: an input cannot be obtained at all.
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
  // not-ready: a load-bearing input is stale or unsupported.
  {
    posture: "not-ready",
    when: ({ fundamental }) => {
      if (!fundamental.stale) return null;
      return fundamental.evidenceAgeDays === null
        ? "Fundamentals stale: no dated earnings or fundamentals evidence at or before the run date."
        : `Fundamentals stale: latest earnings evidence is ${fundamental.evidenceAgeDays} days old.`;
    },
  },
  // Added to the suggested rows: without it a view the committee itself calls unsupported
  // could read as decision-grade.
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
  // screen-grade: coverage is thin.
  {
    posture: "screen-grade",
    when: ({ scenarios }) =>
      scenarios.length < CASES.length
        ? `Valuation scenarios present: ${scenarios.map((scenario) => scenario.case).join(", ") || "none"}; bear, base and bull are all needed.`
        : null,
  },
  {
    posture: "screen-grade",
    when: ({ monitoring }) =>
      monitoring.length === 0
        ? "No upcoming dated catalyst after the run date."
        : null,
  },
  // review-ready: complete and fresh, with a check still open.
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
        ? "Committee view is missing or dated after the run date."
        : null,
  },
];

const readPosture = (
  state: PostureState
): Pick<PitchResult, "posture" | "postureReasons"> => {
  const held = POSTURE_RULES.flatMap((rule) => {
    const reason = rule.when(state);
    return reason === null ? [] : [{ posture: rule.posture, reason }];
  });
  const first = held[0];
  if (first === undefined)
    return { posture: "decision-grade", postureReasons: [] };
  return {
    posture: first.posture,
    postureReasons: held
      .filter((entry) => entry.posture === first.posture)
      .map((entry) => entry.reason),
  };
};

/**
 * Long-supported needs both a base case with upside and an evaluated uptrend (close above the
 * SMA and the SMA rising). A missing input gives unknown, also when the other one fails.
 */
const directionOf = (
  fundamental: FundamentalResult,
  technical: TechnicalResult
): PitchResult["direction"] => {
  const { checks } = technical;
  if (
    fundamental.valuationView === "unknown" ||
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

const priceStopOf = (
  technical: TechnicalResult
): PitchResult["exits"]["priceStop"] => {
  const { close, sma } = technical;
  if (technical.status !== "evaluated" || close === null || sma === null)
    return null;
  return {
    basis: `${technical.rule.smaPeriod}-session SMA at the ${technical.barDate} close; the desk's paper exit rule is a close below it.`,
    distancePct: roundTo((sma / close - 1) * 100, 2) as number,
    level: sma,
  };
};

/** One claim rule for each input that is present; an absent input gives no rule. */
const reUnderwriteOf = (
  fundamental: FundamentalResult,
  technical: TechnicalResult,
  scenarios: readonly PitchScenario[]
): string[] => {
  const rules: string[] = [];
  const base = scenarios.find((scenario) => scenario.case === "base");
  const bear = scenarios.find((scenario) => scenario.case === "bear");
  if (base !== undefined)
    rules.push(
      `Base-case upside (now ${base.upsidePct}%) turns ${base.upsidePct > 0 ? "negative" : "positive"}.`
    );
  if (bear !== undefined)
    rules.push(
      `Bear-case return (now ${bear.upsidePct}%) is revised in the fundamentals dataset.`
    );
  if (fundamental.committee !== null)
    rules.push(
      `Committee status changes from ${fundamental.committee.status ?? "not stated"}.`
    );
  if (fundamental.lastEarnings !== null)
    rules.push(
      `A new earnings report replaces the ${fundamental.lastEarnings.date} evidence.`
    );
  if (
    technical.status === "evaluated" &&
    technical.checks !== null &&
    technical.checks.smaRising !== null
  )
    rules.push(
      `The ${technical.rule.smaPeriod}-session SMA ${technical.checks.smaRising ? "stops" : "starts"} rising.`
    );
  return rules;
};

/** Pitch agent: posture, scenario tree, exit levels and monitoring for one ticker as of `asOf`. */
export const pitchAgent = ({
  asOf,
  fundamental,
  newsSentiment,
  technical,
  fundamentals,
}: PitchInput): PitchResult => {
  const applicable = fundamental.status !== "not-applicable";
  const scenarios = applicable ? scenariosOn(fundamentals, asOf) : [];
  const monitoring = applicable
    ? newsSentiment.upcomingCatalysts
        .filter((item) => item.date > asOf)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, MAX_MONITORING)
        .map(({ date, title }) => ({ date, title }))
    : [];
  const posture = readPosture({
    fundamental,
    monitoring,
    newsSentiment,
    scenarios,
    technical,
  });
  if (!applicable) {
    return {
      agent: "pitch",
      direction: "unknown",
      exits: { priceStop: null, reUnderwrite: [], timeStop: null },
      gaps: [],
      monitoring,
      ...posture,
      scenarios,
      skew: null,
      status: "not-applicable",
    };
  }
  const gaps = [...PITCH_GAPS];
  if (fundamentals !== null && !usableOn(fundamentals.asOf, asOf))
    gaps.push(
      "Fundamentals dataset is dated after the run date or undated; its scenarios are excluded."
    );
  return {
    agent: "pitch",
    direction: directionOf(fundamental, technical),
    exits: {
      priceStop: priceStopOf(technical),
      reUnderwrite: reUnderwriteOf(fundamental, technical, scenarios),
      timeStop: monitoring[0] ?? null,
    },
    gaps,
    monitoring,
    ...posture,
    scenarios,
    skew:
      scenarios.length === CASES.length
        ? {
            label: "illustrative",
            note: `Illustrative skew: ${scenarios.map((scenario) => `${scenario.case} ${scenario.upsidePct}%`).join(", ")}. The datasets carry no scenario probabilities, so no probability-weighted upside is computed.`,
            probabilityWeightedUpsidePct: null,
          }
        : null,
    status: "evaluated",
  };
};
