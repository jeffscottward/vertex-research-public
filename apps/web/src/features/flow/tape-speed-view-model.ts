// What: pure view-model of the Tape speed panel of /flow (flow.tapeSpeed, flow-tape-speed.v1): the
// future that a page symbol shows, the title, the tape line and the fault line, the geometry of the
// two bar charts (mean bar, tick at the busiest second, shades, burst marks) on a logarithmic
// scale, the caption, the legend, the rule sentence and the burst table. The component draws what
// these functions return.
// Research only: a bar and a burst describe how fast the tape traded, never a trade signal.
// Used by: apps/web/src/components/portal/flow-tape-speed-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/flow-pipeline.md ("Tape speed (ES, NQ)").
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowTapeSpeed,
  type FlowTapeSpeedBarState,
  type FlowTapeSpeedRules,
  type FlowTapeSymbol,
} from "@darkfactory/api";

import { formatEtSeconds, formatNyDateTime, formatNyTime } from "./format.ts";
import {
  CHART_HEIGHT,
  CHART_SLOT_WIDTH,
  type FlowSymbol,
  type FlowWindowMinutes,
} from "./view-model.ts";

/** What the page asks flow.tapeSpeed for: one streamed future and one of the window choices. */
export type TapeSpeedRequest = Readonly<{
  symbol: FlowTapeSymbol;
  minutes: FlowWindowMinutes;
}>;

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/** The future of the symbol's index group: the tape that the panel shows for the symbol. */
export const tapeSymbolOf = (symbol: FlowSymbol): FlowTapeSymbol =>
  // Every group's future is ES or NQ (the flow registry test of packages/api pins it).
  FLOW_GROUPS[FLOW_INSTRUMENTS[symbol].group].future as FlowTapeSymbol;

/** "Tape speed (ES)", or "Tape speed (ES, the future of the S&P 500 group)" for SPY and QQQ. */
export const tapeSpeedTitle = (symbol: FlowSymbol): string => {
  const future = tapeSymbolOf(symbol);
  if (future === symbol) return `Tape speed (${future})`;
  const group = FLOW_GROUPS[FLOW_INSTRUMENTS[symbol].group].label;
  return `Tape speed (${future}, the future of the ${group} group)`;
};

export const TAPE_SPEED_LOADING = "Loading tape speed…";
export const TAPE_SPEED_EMPTY = "No per-second counts in this window.";
const TAPE_SPEED_NO_BURST = "No burst in this window.";

const TAPE_STATE_WORDS: Readonly<
  Record<FlowTapeSpeed["tape"]["state"], string>
> = {
  closed: "market closed",
  fresh: "fresh",
  never: "never collected",
  stale: "stale",
};

/**
 * "Tape ESZ6: fresh · newest stored minute Nov 20, 4:58 PM EST · stored per complete minute, …".
 * The minute is the start of the newest minute with per-second counts. A stale or never collected
 * tape adds the message of its last read.
 */
export const tapeLine = (document: FlowTapeSpeed): string => {
  const { state, message } = document.tape;
  const parts = [
    `Tape ${document.contract ?? document.symbol}: ${TAPE_STATE_WORDS[state]}`,
    document.storedUntil === null
      ? "no per-second counts in this window"
      : `newest stored minute ${formatNyDateTime(
          new Date(Date.parse(document.storedUntil) - 60_000).toISOString()
        )}`,
    "stored per complete minute, 1 to 2 minutes behind the market; the newest minute can still change",
  ];
  if ((state === "stale" || state === "never") && message !== null)
    parts.push(`last read: ${message}`);
  return parts.join(" · ");
};

/** The note that a failed per-second write of the collector leaves in the tape sample message. */
const FAULT_NOTE = /per-second counts not stored (\([^)]*\))/;

/**
 * "Per-second counts are not being stored: (PostgresError 42501)" when the newest tape message
 * holds the note of a failed per-second write, in every tape state; else null.
 */
export const tapeFaultLine = (document: FlowTapeSpeed): string | null => {
  const detail = FAULT_NOTE.exec(document.tape.message ?? "")?.[1];
  return detail === undefined
    ? null
    : `Per-second counts are not being stored: ${detail}`;
};

// --- Charts ----------------------------------------------------------------------------------

/** Space above the largest value, in chart units. */
export const TAPE_SPEED_PAD = 4;

export type TapeSpeedBar = Readonly<{
  start: string;
  x: number;
  width: number;
  /** Mean per second over the covered seconds of the bar, on the logarithmic scale. */
  y: number;
  height: number;
  /** The y of the tick at the busiest second of the bar. */
  tickY: number;
  /** true: fewer covered seconds than the bucket holds. */
  partial: boolean;
}>;

export type TapeSpeedShade = Readonly<{
  x: number;
  width: number;
  state: Exclude<FlowTapeSpeedBarState, "counted">;
}>;

export type TapeSpeedMark = Readonly<{ start: string; leftPercent: number }>;

export type TapeSpeedChart = Readonly<{
  width: number;
  height: number;
  bucketSeconds: number;
  /** Number of counted bars; 0 draws shades only. */
  counted: number;
  trades: readonly TapeSpeedBar[];
  contracts: readonly TapeSpeedBar[];
  /** The largest second of the counted bars (the top of each scale; at least 1). */
  topTrades: number;
  topContracts: number;
  shades: readonly TapeSpeedShade[];
  /** One mark per bar that holds a burst second. */
  marks: readonly TapeSpeedMark[];
  bursts: number;
  /** Shaded seconds per state. */
  shadedSeconds: Readonly<Record<TapeSpeedShade["state"], number>>;
  startLabel: string;
  endLabel: string;
}>;

/**
 * The geometry of both charts. One slot per bar; the y scale is logarithmic, ln(1 + value) over
 * ln(1 + the largest second of the window), because that second is far above the means (measured:
 * a mean of 36 and a maximum of 2,740 trades per second; on a linear scale every bar is flat, and
 * on a square-root scale a mean bar has a tenth of the height). A window without a counted bar
 * draws shades only.
 */
export const buildTapeSpeedChart = (
  document: FlowTapeSpeed
): TapeSpeedChart => {
  const { bars, bucketSeconds } = document;
  const counted = bars.filter((bar) => bar.state === "counted");
  const topTrades = Math.max(1, ...counted.map((bar) => bar.peakTrades));
  const topContracts = Math.max(1, ...counted.map((bar) => bar.peakContracts));
  const usable = CHART_HEIGHT - TAPE_SPEED_PAD;
  const scaled = (value: number, top: number): number =>
    (Math.log1p(value) / Math.log1p(top)) * usable;
  const series = (
    top: number,
    sum: (bar: FlowTapeSpeed["bars"][number]) => number,
    peak: (bar: FlowTapeSpeed["bars"][number]) => number
  ): TapeSpeedBar[] =>
    bars.flatMap((bar, index) => {
      if (bar.state !== "counted") return [];
      const height = scaled(sum(bar) / bar.coveredSeconds, top);
      return [
        {
          height,
          partial: bar.coveredSeconds < bucketSeconds,
          start: bar.start,
          tickY: CHART_HEIGHT - scaled(peak(bar), top),
          width: CHART_SLOT_WIDTH - 1,
          x: index * CHART_SLOT_WIDTH + 0.5,
          y: CHART_HEIGHT - height,
        },
      ];
    });

  const shades: TapeSpeedShade[] = [];
  const shadedSeconds = { no_data: 0, not_recorded: 0 };
  bars.forEach((bar, index) => {
    if (bar.state === "counted") return;
    shadedSeconds[bar.state] += bucketSeconds;
    const previous = shades.at(-1);
    const x = index * CHART_SLOT_WIDTH;
    // A neighbouring bar of the same state widens the shade.
    if (
      previous !== undefined &&
      previous.state === bar.state &&
      previous.x + previous.width === x
    )
      shades[shades.length - 1] = {
        ...previous,
        width: previous.width + CHART_SLOT_WIDTH,
      };
    else shades.push({ state: bar.state, width: CHART_SLOT_WIDTH, x });
  });

  const axisStart = Date.parse(document.axisStart);
  return {
    bucketSeconds,
    bursts: document.totals.bursts,
    contracts: series(
      topContracts,
      (bar) => bar.contracts,
      (bar) => bar.peakContracts
    ),
    counted: counted.length,
    endLabel: formatNyTime(
      new Date(axisStart + bars.length * bucketSeconds * 1000).toISOString()
    ),
    height: CHART_HEIGHT,
    marks: bars.flatMap((bar, index) =>
      bar.burstSeconds > 0
        ? [
            {
              leftPercent: ((index + 0.5) / bars.length) * 100,
              start: bar.start,
            },
          ]
        : []
    ),
    shadedSeconds,
    shades,
    startLabel: formatNyTime(document.axisStart),
    topContracts,
    topTrades,
    trades: series(
      topTrades,
      (bar) => bar.trades,
      (bar) => bar.peakTrades
    ),
    width: bars.length * CHART_SLOT_WIDTH,
  };
};

/** The text alternative of one chart. */
export const tapeSpeedAriaLabel = (
  chart: TapeSpeedChart,
  series: "trades" | "contracts"
): string => {
  const span = `from ${chart.startLabel} to ${chart.endLabel}, one bar per ${chart.bucketSeconds} s`;
  if (series === "contracts")
    return `Contracts per second ${span}, largest second ${whole.format(chart.topContracts)}`;
  return `Trades per second ${span}, largest second ${whole.format(chart.topTrades)}, ${chart.bursts} bursts`;
};

export const tapeSpeedCaption = (chart: TapeSpeedChart): string =>
  `Each bar: ${chart.bucketSeconds} s. Bar: mean per second over the covered seconds of the bar. Tick: the busiest second of the bar. Logarithmic scale. Largest second: ${whole.format(chart.topTrades)} trades, ${whole.format(chart.topContracts)} contracts. A lighter bar had only part of its seconds covered.`;

export type TapeSpeedLegendEntry = Readonly<{
  state: TapeSpeedShade["state"];
  text: string;
}>;

const LEGEND_TEXT: Readonly<
  Record<TapeSpeedShade["state"], (minutes: number) => string>
> = {
  no_data: (minutes) =>
    `No data: ${minutes} min (the stream was not live, or it had no trade for more than 60 s)`,
  not_recorded: (minutes) =>
    `Collected, but no per-second counts: ${minutes} min (before this panel was deployed, or the per-second write failed)`,
};

/** One entry per shade state that occurs, with its minutes rounded up. */
export const tapeSpeedLegend = (
  chart: TapeSpeedChart
): readonly TapeSpeedLegendEntry[] =>
  (["not_recorded", "no_data"] as const).flatMap((state) => {
    const seconds = chart.shadedSeconds[state];
    return seconds === 0
      ? []
      : [{ state, text: LEGEND_TEXT[state](Math.ceil(seconds / 60)) }];
  });

/** The rule in one sentence, with its numbers and version, and what a burst is not. */
export const ruleSentence = (rules: FlowTapeSpeedRules): string =>
  `◆ Burst: a second with at least ${rules.multiple} times the mean rate of the ${rules.baselineSeconds / 60} minutes before it and at least ${rules.floorTrades} trades (rule ${rules.version}). A burst describes the tape. It is not a trade signal, and it is not a large trade.`;

/** Null when the rule could evaluate every covered second. */
export const evaluatedSentence = (document: FlowTapeSpeed): string | null => {
  const { coveredSeconds, evaluatedSeconds } = document.totals;
  if (evaluatedSeconds === coveredSeconds) return null;
  const { baselineSeconds, minBaselineCoveredSeconds } = document.rules;
  return `Rule evaluated on ${whole.format(evaluatedSeconds)} of ${whole.format(coveredSeconds)} covered seconds; it needs ${minBaselineCoveredSeconds} covered seconds in the ${baselineSeconds / 60} minutes before a second.`;
};

export const TAPE_SPEED_BURST_HEADERS = [
  "Time (ET)",
  "Seconds",
  "Peak trades/s",
  "Contracts",
  "Baseline",
  "Multiple",
] as const;

export type TapeSpeedBurstRow = Readonly<{
  key: string;
  time: string;
  seconds: string;
  peakTrades: string;
  contracts: string;
  baseline: string;
  multiple: string;
}>;

export const burstRows = (
  document: FlowTapeSpeed
): readonly TapeSpeedBurstRow[] =>
  document.bursts.map((burst) => ({
    baseline: oneDecimal.format(burst.baseline),
    contracts: whole.format(burst.contracts),
    key: burst.start,
    multiple:
      burst.multiple === null ? "n/a" : `${oneDecimal.format(burst.multiple)}x`,
    peakTrades: whole.format(burst.peakTrades),
    seconds: String(burst.seconds),
    time: formatEtSeconds(burst.start),
  }));

/** "No burst in this window.", "Showing the newest 50 of 143 bursts.", or null. */
export const burstCountLine = (document: FlowTapeSpeed): string | null => {
  const { bursts } = document.totals;
  if (bursts === 0) return TAPE_SPEED_NO_BURST;
  if (bursts > document.bursts.length)
    return `Showing the newest ${document.bursts.length} of ${whole.format(bursts)} bursts.`;
  return null;
};
