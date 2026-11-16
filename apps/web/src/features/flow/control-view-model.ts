// What: pure view-model of the /flow control panel (flow.control): group of a symbol, title, the
// options line and the one futures line, the age notice, net drift metrics and chart, the
// cross-check and study sentences and the freshness rows. The server sentences arrive as data.
// Research only: a state describes recent flow, never a trade signal.
// Used by: apps/web/src/components/portal/flow-control-panel.tsx.
// See: docs/vertex-rebuild/flow-pipeline.md.
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowControl,
  type FlowControlState,
  type FlowGroupId,
  type FlowNetDriftSeries,
} from "@darkfactory/api";

import { formatAge, formatMoney, formatNyTime } from "./format.ts";
import {
  FRESHNESS_TONE,
  type FlowSymbol,
  type Metric,
  type Tone,
} from "./view-model.ts";

export type { FlowControl } from "@darkfactory/api";
export type FlowControlFailure = Readonly<{ code: string; message: string }>;
export type NetDriftView = "total" | "zero_dte" | "longer";

export const NET_DRIFT_VIEWS: readonly Readonly<{
  view: NetDriftView;
  label: string;
}>[] = Object.freeze([
  { label: "All expiries", view: "total" },
  { label: "Same day (0DTE)", view: "zero_dte" },
  { label: "Longer", view: "longer" },
]);

export const groupOfSymbol = (symbol: FlowSymbol): FlowGroupId =>
  FLOW_INSTRUMENTS[symbol].group;

export const controlTitle = (control: FlowControl): string =>
  `Who is in control: ${FLOW_GROUPS[control.group].label}`;

export const STATE_TONE: Readonly<Record<FlowControlState, Tone>> = {
  balanced: "neutral",
  buyers: "success",
  mixed: "warning",
  no_data: "info",
  sellers: "destructive",
};

export type ControlLine = Readonly<{
  key: "options" | "futures";
  state: string;
  tone: Tone;
  text: string;
  since: string | null;
  asOf: string | null;
  ratio: string | null;
}>;

/** "Data is <k> min old, refreshing" when the document is older than two refresh periods. */
export const controlAgeNotice = (
  control: FlowControl,
  now: Date,
  refreshMs: number
): string | null => {
  const age = now.getTime() - new Date(control.generatedAt).getTime();
  if (age <= 2 * refreshMs) return null;
  return `Data is ${Math.round(age / 60_000)} min old, refreshing`;
};

const asOfText = (asOf: string | null, now: Date): string | null =>
  asOf === null
    ? null
    : `as of ${formatNyTime(asOf)}, ${formatAge(Math.max(0, Math.round((now.getTime() - new Date(asOf).getTime()) / 1000)))} ago`;

/** Two lines: options, then the one futures line (no separate agreement line). */
export const controlLines = (
  control: FlowControl,
  now: Date,
  refreshMs: number
): readonly ControlLine[] => {
  const old = controlAgeNotice(control, now, refreshMs) !== null;
  const { futures, options, study } = control;
  return [
    {
      asOf: asOfText(options.asOf, now),
      key: "options",
      ratio:
        options.ratio === null
          ? null
          : `Ratio ${options.ratio.toFixed(2)} (enter ratio ${options.enterRatio.toFixed(2)})`,
      since:
        options.since === null ? null : `since ${formatNyTime(options.since)}`,
      state: options.state,
      text:
        options.state === "no_data"
          ? `${options.label}: ${options.detail}`
          : options.label,
      tone: old ? "neutral" : STATE_TONE[options.state],
    },
    {
      asOf: asOfText(futures.asOf, now),
      key: "futures",
      ratio: null,
      since: null,
      state: futures.state,
      text: `${futures.label}; ${study.agreementDetail}`,
      tone: old ? "neutral" : STATE_TONE[futures.state],
    },
  ];
};

const lineOf = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): FlowNetDriftSeries["totals"]["total"] => {
  if (view === "total") return series.totals.total;
  return view === "zero_dte" ? series.totals.zeroDte : series.totals.longer;
};

export const netDriftSummary = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): readonly Metric[] => {
  const totals = lineOf(series, view);
  const value = (pick: (line: NonNullable<typeof totals>) => number) =>
    totals === null ? "no bucket yet" : formatMoney(pick(totals));
  return [
    {
      label: "Net call premium",
      value: value((line) => line.netCallPremiumUsd),
    },
    { label: "Net put premium", value: value((line) => line.netPutPremiumUsd) },
    { label: "Call minus put", value: value((line) => line.callMinusPutUsd) },
    ...(view === "total"
      ? [
          {
            label: "Slope per minute (15 min)",
            value: formatMoney(series.slopeUsdPerMinute),
          },
        ]
      : []),
    ...(series.partsDetail !== null && view !== "total"
      ? [{ label: "Expiry split", value: series.partsDetail }]
      : []),
  ];
};

export type NetDriftChart = Readonly<{
  width: 320;
  height: 96;
  call: string;
  put: string;
  difference: string;
  zeroY: number;
  min: number;
  max: number;
}>;

export const buildNetDriftChart = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): NetDriftChart => {
  const lines = series.points.flatMap((point) => {
    const line =
      view === "total"
        ? point.total
        : view === "zero_dte"
          ? point.zeroDte
          : point.longer;
    return line === null
      ? []
      : [
          {
            call: line.netCallPremiumUsd,
            difference: line.netCallPremiumUsd - line.netPutPremiumUsd,
            put: line.netPutPremiumUsd,
          },
        ];
  });
  if (lines.length === 0)
    return {
      call: "",
      difference: "",
      height: 96,
      max: 0,
      min: 0,
      put: "",
      width: 320,
      zeroY: 48,
    };
  const values = lines.flatMap((line) => [
    line.call,
    line.put,
    line.difference,
  ]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const y = (value: number) =>
    max === min ? 48 : 4 + ((max - value) / (max - min)) * 88;
  const x = (index: number) => (index / Math.max(1, lines.length - 1)) * 320;
  const path = (pick: (line: (typeof lines)[number]) => number) =>
    lines
      .map(
        (line, index) => `${x(index).toFixed(1)},${y(pick(line)).toFixed(1)}`
      )
      .join(" ");
  return {
    call: path((line) => line.call),
    difference: path((line) => line.difference),
    height: 96,
    max,
    min,
    put: path((line) => line.put),
    width: 320,
    zeroY: y(0),
  };
};

export const crossCheckLine = (control: FlowControl): string =>
  control.crossCheck.detail;

export const studyLine = (control: FlowControl): string => control.study.detail;

export const controlFreshnessRows = (
  control: FlowControl
): readonly Readonly<{ key: string; text: string; tone: Tone }>[] =>
  control.freshness.map((row) => ({
    key: `${row.instrument}:${row.source}`,
    text:
      row.lastOkAt === null
        ? `${row.instrument} net drift: never collected`
        : `${row.instrument} net drift: ${row.state}, last answer ${formatNyTime(row.lastOkAt)}`,
    tone: FRESHNESS_TONE[row.state],
  }));
