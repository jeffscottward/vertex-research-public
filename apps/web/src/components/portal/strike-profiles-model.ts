import type {
  OptionsAnalyticsOutput,
  StrikeProfileRow,
} from "@darkfactory/api";

import {
  formatCount,
  formatMoney,
  formatSignedMoney,
} from "../../features/flow/format.ts";

// The view of one strike profile (open interest, flow volume, net premium or max pain) of the
// options analytics snapshot: one strike ladder from the highest strike to the lowest, bar
// fractions, the spot line and the captions that state each source and its limits. Pure; the
// panel (strike-profiles-panel.tsx) only renders it. Research only.

export const STRIKE_PROFILE_METRICS = [
  "openInterest",
  "flowVolume",
  "netPremium",
  "maxPain",
] as const;
export type StrikeProfileMetric = (typeof STRIKE_PROFILE_METRICS)[number];

export const STRIKE_PROFILE_LABELS: Readonly<
  Record<StrikeProfileMetric, string>
> = {
  flowVolume: "Flow volume",
  maxPain: "Max pain",
  netPremium: "Net premium",
  openInterest: "Open interest",
};

const METRIC_CAPTIONS: Readonly<Record<StrikeProfileMetric, string>> = {
  flowVolume:
    "Contracts in option-flow prints, all expiries. Puts left, calls right. Flow prints only, not total exchange volume.",
  maxPain:
    "Holder payout if the price settles at each strike (open interest, all expiries). Bar: payout above the max-pain strike.",
  netPremium:
    "Bullish minus bearish premium per strike (QuantData sentiment). Neutral prints are not counted.",
  openInterest:
    "Open contracts per strike, all expiries (QuantData; can be the previous session). Puts left, calls right.",
};

export type StrikeProfileSnapshot = Pick<
  OptionsAnalyticsOutput,
  "exposure" | "flow" | "spot" | "strikeProfiles"
>;

/**
 * One ladder row: bar fractions (0 to 1) left and right of the axis, their texts, exact title,
 * and the text of the bar itself for screen readers when the bar shows a value no cell shows
 * (the signed net of the Net premium profile).
 */
export type StrikeProfileBarRow = Readonly<{
  strike: number;
  left: number;
  right: number;
  leftText: string;
  rightText: string;
  barText: string | null;
  title: string;
  maxPain: boolean;
}>;

export type StrikeProfileView =
  | Readonly<{
      kind: "message";
      message: string;
      captions: readonly string[];
    }>
  | Readonly<{
      kind: "ladder";
      // "split": a bar each side of a centre axis; "single": one bar from the left edge
      // (`right` holds its fraction, `leftText` its value).
      layout: "split" | "single";
      columns: readonly string[];
      rows: readonly StrikeProfileBarRow[];
      // Index of the last row above spot (-1: spot is above every row); null without spot.
      spotAfter: number | null;
      spotLabel: string | null;
      captions: readonly string[];
    }>;

type Side = Readonly<{ left: number; right: number }>;

const exact = (value: number): string => value.toLocaleString("en-US");
const exactMoney = (value: number): string =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const utcTime = (iso: string): string =>
  `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;

// The two values of a row for a metric: left and right magnitudes, then their texts and title.
const sidesOf = (
  metric: StrikeProfileMetric,
  row: StrikeProfileRow,
  minPayout: number
): Side &
  Readonly<{
    leftText: string;
    rightText: string;
    barText: string | null;
    title: string;
  }> => {
  switch (metric) {
    case "openInterest":
      return {
        barText: null,
        left: row.putOpenInterest,
        leftText: formatCount(row.putOpenInterest),
        right: row.callOpenInterest,
        rightText: formatCount(row.callOpenInterest),
        title: `Strike ${row.strike}: put OI ${exact(row.putOpenInterest)}, call OI ${exact(row.callOpenInterest)}`,
      };
    case "flowVolume":
      return {
        barText: null,
        left: row.putVolume,
        leftText: formatCount(row.putVolume),
        right: row.callVolume,
        rightText: formatCount(row.callVolume),
        title: `Strike ${row.strike}: put contracts ${exact(row.putVolume)}, call contracts ${exact(row.callVolume)}, ${exact(row.trades)} prints`,
      };
    case "netPremium": {
      const net = row.bullishPremium - row.bearishPremium;
      return {
        barText: `Net ${formatSignedMoney(net)}`,
        left: Math.max(0, -net),
        leftText: formatMoney(row.bearishPremium),
        right: Math.max(0, net),
        rightText: formatMoney(row.bullishPremium),
        title: `Strike ${row.strike}: bearish ${exactMoney(row.bearishPremium)}, bullish ${exactMoney(row.bullishPremium)}, net ${net < 0 ? "−" : ""}${exactMoney(Math.abs(net))}`,
      };
    }
    case "maxPain":
      return {
        barText: null,
        left: 0,
        leftText: formatMoney(row.holderPayout),
        right: row.holderPayout - minPayout,
        rightText: "",
        title: `Strike ${row.strike}: holder payout ${exactMoney(row.holderPayout)}`,
      };
  }
};

const COLUMNS: Readonly<Record<StrikeProfileMetric, readonly string[]>> = {
  flowVolume: ["Strike", "Puts", "Calls"],
  maxPain: ["Strike", "Payout"],
  netPremium: ["Strike", "Bearish", "Bullish"],
  openInterest: ["Strike", "Puts", "Calls"],
};

// The coverage line of the flow profiles: which prints, which time span, and what is missing.
const flowCoverage = (snapshot: StrikeProfileSnapshot): string[] => {
  const { flow } = snapshot.strikeProfiles;
  const hours = snapshot.flow.hours;
  const span =
    flow.oldestTradeAt === null || flow.newestTradeAt === null
      ? null
      : `${utcTime(flow.oldestTradeAt)} to ${utcTime(flow.newestTradeAt)} UTC`;
  const lines: string[] = [];
  if (flow.source === "stored_prints") {
    lines.push(
      span === null
        ? `No stored prints in the last ${hours} h.`
        : `All stored prints of the last ${hours} h (${span}).`
    );
    if (!flow.complete)
      lines.push(
        "Stored prints can be incomplete: the collector has gaps or is behind in this window."
      );
  } else {
    lines.push(
      span === null
        ? `No counted prints in the last ${hours} h.`
        : `Newest ${exact(flow.trades)} prints, ${span}, of the last ${hours} h window.`
    );
    if (!flow.complete) lines.push("First provider page only.");
  }
  if (flow.offLadderTrades > 0)
    lines.push(`${exact(flow.offLadderTrades)} prints at strikes not shown.`);
  return lines;
};

const isFlowMetric = (metric: StrikeProfileMetric): boolean =>
  metric === "flowVolume" || metric === "netPremium";

// Null when the profile can draw; otherwise the reason from its source section.
const blockedMessage = (
  metric: StrikeProfileMetric,
  snapshot: StrikeProfileSnapshot
): string | null => {
  if (isFlowMetric(metric)) {
    const stored = snapshot.strikeProfiles.flow.source === "stored_prints";
    if (!stored && snapshot.flow.status !== "ok")
      return snapshot.flow.message ?? "No option-flow prints.";
  } else if (snapshot.exposure.status !== "ok") {
    return (
      snapshot.exposure.message ??
      "QuantData sent no open interest for this symbol."
    );
  }
  return snapshot.strikeProfiles.strikes.length === 0
    ? "No strikes: QuantData sent no open interest for this symbol."
    : null;
};

/** The view of one profile of the snapshot. */
export const buildStrikeProfile = (
  metric: StrikeProfileMetric,
  snapshot: StrikeProfileSnapshot
): StrikeProfileView => {
  const { spot } = snapshot;
  const captions = [METRIC_CAPTIONS[metric]];
  if (isFlowMetric(metric)) captions.push(...flowCoverage(snapshot));
  captions.push(
    spot === null
      ? "Strikes: the 40 lowest and the 25 largest by open interest, plus the max-pain strike."
      : "Strikes: the 55 nearest spot and the 25 largest by open interest (at most 80), plus the max-pain strike."
  );
  const blocked = blockedMessage(metric, snapshot);
  if (blocked !== null) return { captions, kind: "message", message: blocked };
  const strikes = [...snapshot.strikeProfiles.strikes].sort(
    (a, b) => b.strike - a.strike
  );
  const minPayout = Math.min(...strikes.map((row) => row.holderPayout));
  const measured = strikes.map((row) => ({
    row,
    side: sidesOf(metric, row, minPayout),
  }));
  const scale = Math.max(
    ...measured.map(({ side }) => Math.max(side.left, side.right))
  );
  if (scale === 0) captions.push("No values for this profile.");
  const fraction = (value: number): number => (scale > 0 ? value / scale : 0);
  const rows = measured.map(({ row, side }): StrikeProfileBarRow => {
    return {
      barText: side.barText,
      left: fraction(side.left),
      leftText: side.leftText,
      // Marked on the Max pain profile only.
      maxPain: metric === "maxPain" && row.strike === snapshot.exposure.maxPain,
      right: fraction(side.right),
      rightText: side.rightText,
      strike: row.strike,
      title: side.title,
    };
  });
  return {
    captions,
    columns: COLUMNS[metric],
    kind: "ladder",
    layout: metric === "maxPain" ? "single" : "split",
    rows,
    spotAfter:
      spot === null
        ? null
        : rows.reduce(
            (last, row, index) => (row.strike > spot ? index : last),
            -1
          ),
    spotLabel: spot === null ? null : `Spot ${spot.toFixed(2)}`,
  };
};
