// What: pure view-model formatting for the /flow 6-ticker Option Tape panel (flow.optionPrints).
// Research only: describes stored intraday option prints, never a trade signal.
import {
  FLOW_OPTION_TICKERS,
  type FlowFreshness,
  type FlowOptionPrints,
  type FlowOptionTicker,
} from "@darkfactory/api";

import {
  formatAge,
  formatCount,
  formatMoney,
  formatNyTime,
  formatPrice,
} from "./format.ts";

export const OPTION_TAPE_TICKERS: readonly FlowOptionTicker[] =
  FLOW_OPTION_TICKERS;

export const OPTION_TAPE_WINDOWS = [15, 60, 390] as const;
export type OptionTapeWindowMinutes = (typeof OPTION_TAPE_WINDOWS)[number];

export const OPTION_TAPE_HEADERS = [
  "Time (ET)",
  "Contract",
  "Side",
  "Sentiment",
  "Size",
  "Price",
  "Premium",
  "Kind",
] as const;

export type OptionTapeTone = "neutral" | "success" | "warning";

export type OptionTapeFreshnessView = Readonly<{
  label: string;
  tone: OptionTapeTone;
}>;

export type OptionTapeMetric = Readonly<{
  label: string;
  value: string;
}>;

export type OptionTapeRow = Readonly<{
  key: string;
  time: string;
  contract: string;
  side: string;
  sentiment: string;
  size: string;
  price: string;
  premium: string;
  kind: string;
}>;

const FRESHNESS_TONE: Readonly<Record<FlowFreshness["state"], OptionTapeTone>> =
  {
    closed: "neutral",
    fresh: "success",
    never: "warning",
    stale: "warning",
  };

const FRESHNESS_LABEL: Readonly<Record<FlowFreshness["state"], string>> = {
  closed: "Closed",
  fresh: "Live",
  never: "No data yet",
  stale: "Stale",
};

const SIDE_LABELS: Readonly<
  Record<FlowOptionPrints["prints"][number]["side"], string>
> = {
  above_ask: "Above ask",
  ask: "Ask",
  below_bid: "Below bid",
  bid: "Bid",
  mid: "Mid",
  not_classified: "Unclassified",
};

const SENTIMENT_LABELS: Readonly<
  Record<FlowOptionPrints["prints"][number]["sentiment"], string>
> = {
  bearish: "Bearish",
  bullish: "Bullish",
  neutral: "Neutral",
};

const KIND_LABELS: Readonly<
  Record<FlowOptionPrints["prints"][number]["consolidation"], string>
> = {
  block: "Block",
  other: "Print",
  split: "Split",
  sweep: "Sweep",
};

export const optionTapeFreshness = (
  freshness: FlowFreshness
): OptionTapeFreshnessView => {
  const base = FRESHNESS_LABEL[freshness.state];
  const age =
    freshness.ageSeconds === null
      ? ""
      : ` · ${formatAge(freshness.ageSeconds)}`;
  return {
    label: `${base}${age}`,
    tone: FRESHNESS_TONE[freshness.state],
  };
};

export const optionTapeUnreadLine = (unreadRanges: number): string =>
  unreadRanges === 0
    ? "0 unread gap ranges"
    : `${formatCount(unreadRanges)} unread gap ${unreadRanges === 1 ? "range" : "ranges"} catching up`;

export const optionTapeMetrics = (
  data: FlowOptionPrints
): readonly OptionTapeMetric[] => [
  { label: "Trades", value: formatCount(data.summary.trades) },
  { label: "Call premium", value: formatMoney(data.summary.callPremium) },
  { label: "Put premium", value: formatMoney(data.summary.putPremium) },
  { label: "Bullish", value: formatMoney(data.summary.bullishPremium) },
  { label: "Bearish", value: formatMoney(data.summary.bearishPremium) },
  {
    label: "Sweeps / Golden",
    value: `${formatCount(data.summary.sweeps)} / ${formatCount(data.summary.goldenSweeps)}`,
  },
  {
    label: "Blocks / Unusual",
    value: `${formatCount(data.summary.blocks)} / ${formatCount(data.summary.unusualCount)}`,
  },
];

export const optionTapeRows = (
  data: FlowOptionPrints
): readonly OptionTapeRow[] =>
  data.prints.map((print, index) => ({
    contract: print.contract,
    key: `${print.at}-${print.contract}-${index}`,
    kind: print.goldenSweep ? "Golden sweep" : KIND_LABELS[print.consolidation],
    premium: formatMoney(print.premium),
    price: formatPrice(print.price),
    sentiment: SENTIMENT_LABELS[print.sentiment],
    side: SIDE_LABELS[print.side],
    size: formatCount(print.size),
    time: formatNyTime(print.at),
  }));

export const optionTapeWindowLabel = (
  windowMinutes: OptionTapeWindowMinutes
): string => (windowMinutes === 390 ? "Session" : `${windowMinutes}m`);
