// What: maps the flow page (flow.snapshot GEX + flow.control net drift) and the stock page
// (options analytics GEX + flow.control net drift) to the inputs of gradeGexWallDrift, and the read
// to the badge text. Pure.
// Pairing: the read always uses the options ticker's own levels and net drift (SPY -> SPY,
// ES -> SPX, QQQ -> QQQ, NQ -> NDX); basis-shifted symbol levels are never read.
// Research only: the read describes what was observed and is never a trade signal.
// Doc: docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md.
import {
  FLOW_OPTION_TICKERS,
  type FlowControl,
  type FlowGroupId,
  type FlowOptionTicker,
  type FlowSnapshot,
  flowSymbolForTicker,
  type GexDriftInput,
  type GexWallDriftRead,
  type GexWallDriftReadValue,
  type GexWallLevelsInput,
  gradeGexWallDrift,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";

import { groupOfSymbol } from "./control-view-model.ts";

/** The flow.control answer as the badge sees it. */
export type WallDriftControlState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; control: FlowControl }>;

export type WallDriftTone = "success" | "warning" | "neutral" | "info";

export type WallDriftView = Readonly<{
  ticker: string | null;
  read: GexWallDriftReadValue;
  code: string | null;
  label: string;
  tone: WallDriftTone;
  /** "Put wall 600 · above flip 590", "No wall in band" or "Wall not read" (no-data). */
  context: string;
  reason: string;
  /** The collector message of the ticker's net drift, shown with a no-data read. */
  collectorNote: string | null;
  /** Input times and sources for the About disclosure. */
  inputs: string;
  rulesVersion: string;
}>;

/** The study has no verdict yet; every graded read carries this marker. */
export const WALL_DRIFT_STUDY_STATUS = "Unvalidated: study accruing";

export const WALL_DRIFT_HELP =
  "Price is at a wall when it is within 0.25% of the wall strike; a side's net premium is rising when its 15-minute change is at least 30% of all premium traded in the window. Hold (A): the side against the wall (calls at the put wall, puts at the call wall) is rising while price is at or above the gamma flip; A is the only hold grade. Break risk: the side toward the wall's far side is rising. No read: price is not at a wall, both walls are near, the walls are inverted, both sides or neither side is rising, or a hold below or without a flip. No data: an input is missing, stale or does not match. The read is re-checked every minute; the study counts only first touches from inside the band.";

const LABELS: Readonly<
  Record<
    GexWallDriftReadValue,
    Readonly<{ label: string; tone: WallDriftTone }>
  >
> = {
  "break-risk": { label: "Break risk", tone: "warning" },
  "hold-A": { label: "Hold (A)", tone: "success" },
  "no-data": { label: "No data", tone: "info" },
  "no-read": { label: "No read", tone: "neutral" },
};

/** The context line of the two wall no-reads that are not "no wall in band". */
const WALL_CONTEXT: Readonly<Record<string, string>> = {
  both_walls_near: "Both walls in band",
  wall_geometry: "Call wall not above put wall",
};

const OPTION_TICKERS: ReadonlySet<string> = new Set(FLOW_OPTION_TICKERS);

/** The four tickers with net drift (SPY, SPX, QQQ, NDX). */
export const isWallDriftTicker = (symbol: string): symbol is FlowOptionTicker =>
  OPTION_TICKERS.has(symbol);

/** The flow.control group whose net drift covers the ticker. */
export const wallDriftGroupOf = (ticker: FlowOptionTicker): FlowGroupId =>
  groupOfSymbol(flowSymbolForTicker(ticker));

const driftOf = (
  state: WallDriftControlState,
  ticker: FlowOptionTicker
): Readonly<{ drift: GexDriftInput; note: string | null }> => {
  if (state.kind !== "ready")
    return {
      drift: {
        code: "drift_missing",
        detail:
          state.kind === "loading"
            ? "net drift is loading"
            : `net drift not loaded: ${state.message}`,
        kind: "missing",
      },
      note: null,
    };
  const freshness = state.control.freshness.find(
    (row) => row.source === "net_drift" && row.instrument === ticker
  );
  // A stale or never-collected feed is passed through as the reason, with its collector message.
  if (freshness?.state === "stale" || freshness?.state === "never")
    return {
      drift: {
        code: "drift_missing",
        detail: `net drift collector is ${freshness.state === "stale" ? "stale" : "without a successful sample yet"}`,
        kind: "missing",
      },
      note: freshness.message,
    };
  const note =
    freshness === undefined || freshness.state === "fresh"
      ? null
      : freshness.message;
  const series = state.control.netDrift.find((row) => row.ticker === ticker);
  return {
    drift:
      series === undefined
        ? {
            code: "drift_missing",
            detail: `no net drift series for ${ticker}`,
            kind: "missing",
          }
        : { kind: "series", points: series.points, ticker },
    note,
  };
};

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "America/New_York",
});

const clockOf = (iso: string): string =>
  `${NEW_YORK_CLOCK.format(new Date(iso))} ET`;

const viewOf = (read: GexWallDriftRead, note: string | null): WallDriftView => {
  const flip =
    read.flipSide === "above" || read.flipSide === "below"
      ? `${read.flipSide} flip ${read.flip}`
      : "no flip";
  return {
    ...LABELS[read.read],
    code: read.code,
    collectorNote: read.read === "no-data" ? note : null,
    context:
      read.wall === "none"
        ? (WALL_CONTEXT[String(read.code)] ??
          (read.read === "no-data" ? "Wall not read" : "No wall in band"))
        : `${read.wall === "call" ? "Call" : "Put"} wall ${read.wallStrike} · ${flip}`,
    inputs: [
      read.levelsAt === null
        ? "no GEX levels read"
        : `levels ${read.levelsSource} at ${clockOf(read.levelsAt)}`,
      read.priceAt === null
        ? "no drift price read"
        : `price at ${clockOf(read.priceAt)}`,
      read.rulesVersion,
    ].join(" · "),
    read: read.read,
    reason: read.reason,
    rulesVersion: read.rulesVersion,
    ticker: read.ticker,
  };
};

/** The flow page: the GEX of the snapshot and the net drift series of the same options ticker. */
export const flowWallDriftView = (
  snapshot: FlowSnapshot | null,
  snapshotFailure: string | null,
  control: WallDriftControlState,
  now: Date
): WallDriftView => {
  const gex = snapshot?.gex ?? null;
  if (gex === null) {
    const detail =
      snapshot === null
        ? snapshotFailure === null
          ? "flow snapshot is loading"
          : `flow snapshot not loaded: ${snapshotFailure}`
        : "no GEX snapshot yet for this symbol";
    return viewOf(
      gradeGexWallDrift({
        drift: { code: "drift_missing", detail, kind: "missing" },
        levels: { code: "gex_missing", detail, kind: "missing" },
        now,
      }),
      null
    );
  }
  const { drift, note } = driftOf(control, gex.ticker);
  const levels: GexWallLevelsInput = {
    at: gex.at,
    callWall: gex.levels.callWall,
    flip: gex.levels.flip,
    kind: "levels",
    putWall: gex.levels.putWall,
    source: "flow_gex",
    spot: gex.spot,
    ticker: gex.ticker,
  };
  return viewOf(gradeGexWallDrift({ drift, levels, now }), note);
};

/** The options analytics answer as the stock badge sees it. */
export type WallDriftAnalyticsState =
  | Readonly<{ kind: "ready"; analytics: OptionsAnalyticsOutput }>
  | Readonly<{ kind: "missing"; detail: string }>;

/** The stock page (operators, SPY/SPX/QQQ/NDX only): options analytics GEX and net drift. */
export const stockWallDriftView = (
  ticker: FlowOptionTicker,
  analytics: WallDriftAnalyticsState,
  control: WallDriftControlState,
  now: Date
): WallDriftView => {
  const { drift, note } = driftOf(control, ticker);
  if (analytics.kind === "missing")
    return viewOf(
      gradeGexWallDrift({
        drift,
        levels: {
          code: "gex_missing",
          detail: analytics.detail,
          kind: "missing",
        },
        now,
      }),
      null
    );
  const { context, receivedAt, spot, symbol } = analytics.analytics;
  if (symbol.toUpperCase() !== ticker)
    return viewOf(
      gradeGexWallDrift({
        drift,
        levels: {
          code: "ticker_mismatch",
          detail: `options analytics is for ${symbol}, not ${ticker}`,
          kind: "missing",
        },
        now,
      }),
      null
    );
  const levels: GexWallLevelsInput = {
    at: receivedAt,
    callWall: context.levels.callWall,
    flip: context.levels.flip,
    kind: "levels",
    putWall: context.levels.putWall,
    source: "options_analytics",
    spot,
    ticker,
  };
  const read = gradeGexWallDrift({ drift, levels, now });
  // /stock reloads only on Refresh, so an aged read names that next step.
  return viewOf(
    read.code === "gex_stale" || read.code === "drift_stale"
      ? { ...read, reason: `${read.reason}; press Refresh to reload` }
      : read,
    note
  );
};
