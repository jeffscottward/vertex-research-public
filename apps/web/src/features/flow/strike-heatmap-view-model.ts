// What: pure view-model of the Options flow heatmap panel on /flow (flow.strikeHeatmap,
// flow-strike-heatmap.v1): symbols, titles, header/totals/omitted/rule/error copy, contrast-safe
// oklab diverging cell tint, descending strike grid with latest spot placement, default cell
// selection, roving-tabindex keyboard movement, and cell inspector readout.
// Research only: the heatmap describes stored option prints, never a trade signal.
// Used by: apps/web/src/components/portal/flow-strike-heatmap-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/designs/vertex-viz-flow-strike-time-heatmap/design.md.
import {
  FLOW_INSTRUMENTS,
  FLOW_STRIKE_HEATMAP_BUCKETS,
  FLOW_STRIKE_HEATMAP_SYMBOLS,
  type FlowStrikeHeatmap,
  type FlowStrikeHeatmapBucketMinutes,
  type FlowStrikeHeatmapCell,
  type FlowStrikeHeatmapRules,
  type FlowStrikeHeatmapSlot,
  type FlowStrikeHeatmapStrike,
  type FlowStrikeHeatmapSymbol,
} from "@darkfactory/api";

import type { FlowControlFailure } from "./control-view-model.ts";
import {
  formatCount,
  formatMoney,
  formatPrice,
  formatSignedMoney,
} from "./format.ts";
import type { FlowSymbol } from "./view-model.ts";

/** What the page asks flow.strikeHeatmap for: one symbol with stored option prints and bucket width. */
export type StrikeHeatmapRequest = Readonly<{
  symbol: FlowStrikeHeatmapSymbol;
  bucketMinutes?: FlowStrikeHeatmapBucketMinutes;
}>;

/** A failed flow.strikeHeatmap call: error code, message, and timestamp. */
export type FlowStrikeHeatmapFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

export type HeatmapMoveDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end";

export type StrikeHeatmapSpotPlacement =
  | Readonly<{ kind: "above-all" }>
  | Readonly<{ kind: "below-all" }>
  | Readonly<{ kind: "at"; strike: number }>
  | Readonly<{ kind: "between"; aboveStrike: number; belowStrike: number }>;

export type StrikeHeatmapSpot = Readonly<{
  placement: StrikeHeatmapSpotPlacement;
  label: string;
}>;

export type StrikeHeatmapGridEntry = Readonly<{
  slot: FlowStrikeHeatmapSlot;
  cell: FlowStrikeHeatmapCell | null;
}>;

export type StrikeHeatmapGridRow = Readonly<{
  strike: FlowStrikeHeatmapStrike;
  entries: readonly StrikeHeatmapGridEntry[];
  spotAt: boolean;
  spotBelow: boolean;
}>;

export type StrikeHeatmapGridView = Readonly<{
  rows: readonly StrikeHeatmapGridRow[];
  maxAbsCellNetPremium: number;
  defaultSelectedKey: string | null;
  spot: StrikeHeatmapSpot | null;
  hasUnreadSlots: boolean;
}>;

export type SelectedCellReadout = Readonly<{
  headline: string;
  netLine: string;
  breakdownLine: string;
  metaLine: string;
}>;

const MINUTE_MS = 60_000;
const LEVEL_EPS = 1e-6;

const etClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const etClockOf = (iso: string): string => etClock.format(new Date(iso));

export const STRIKE_HEATMAP_LOADING = "Loading options flow heatmap…";
export const STRIKE_HEATMAP_NO_CELLS =
  "No regular-session option print stored for this session.";
export const STRIKE_HEATMAP_BUCKET_OPTIONS: readonly FlowStrikeHeatmapBucketMinutes[] =
  FLOW_STRIKE_HEATMAP_BUCKETS;

/** The symbol when the heatmap exists for it (stored option prints), else null. */
export const strikeHeatmapSymbolOf = (
  symbol: FlowSymbol
): FlowStrikeHeatmapSymbol | null =>
  FLOW_STRIKE_HEATMAP_SYMBOLS.find((candidate) => candidate === symbol) ?? null;

/** "Options flow heatmap · SPY options" or "Options flow heatmap · SPX options (ES)". */
export const strikeHeatmapTitle = (symbol: FlowStrikeHeatmapSymbol): string => {
  const ticker = FLOW_INSTRUMENTS[symbol].optionsTicker;
  return ticker === symbol
    ? `Options flow heatmap · ${ticker} options`
    : `Options flow heatmap · ${ticker} options (${symbol})`;
};

/** Stable cell lookup key shared between grid state and DOM data attributes. */
export const heatmapCellKey = (strike: number, slotIndex: number): string =>
  `${strike}:${slotIndex}`;

/** Compact strike price label without trailing zeros (e.g. "600", "600.5", "5950"). */
export const formatStrikeLabel = (strike: number): string =>
  Number.isInteger(strike)
    ? String(strike)
    : strike.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

/** "09:30": short New York wall time for column headers. */
export const formatSlotShortTime = (iso: string): string => etClockOf(iso);

/** "09:30–09:45 ET", or "16:00–16:15 ET (15m close)" for the final 30m bucket. */
export const formatSlotRange = (
  slot: Pick<FlowStrikeHeatmapSlot, "start" | "end">,
  bucketMinutes: FlowStrikeHeatmapBucketMinutes
): string => {
  const startLabel = etClockOf(slot.start);
  const endLabel = etClockOf(slot.end);
  const durationMinutes = Math.round(
    (Date.parse(slot.end) - Date.parse(slot.start)) / MINUTE_MS
  );
  const shortClose =
    bucketMinutes === 30 && durationMinutes < 30 ? " (15m close)" : "";
  return `${startLabel}–${endLabel} ET${shortClose}`;
};

/** Empty state when no option print is stored in the retention window. */
export const strikeHeatmapEmptyLine = (
  symbol: FlowStrikeHeatmapSymbol
): string => `No option prints stored for ${symbol} in the last 14 days.`;

/** Error banner copy, noting when an older bucket width remains on screen. */
export const strikeHeatmapFailureLine = (
  failure: FlowStrikeHeatmapFailure,
  refreshMs: number,
  displayedBucketMinutes: FlowStrikeHeatmapBucketMinutes | null,
  requestedBucketMinutes: FlowStrikeHeatmapBucketMinutes
): string => {
  const nextAt = etClock.format(new Date(failure.failedAt + refreshMs));
  const keptNote =
    displayedBucketMinutes !== null &&
    displayedBucketMinutes !== requestedBucketMinutes
      ? ` Showing previous ${displayedBucketMinutes}m grid.`
      : "";
  return `Options flow heatmap failed (${failure.code}): ${failure.message}.${keptNote} Retry now or wait for ${nextAt} ET.`;
};

/** Header metadata line: session date, bucket width, latest print time, freshness, and open gap notice. */
export const strikeHeatmapHeaderLine = (
  response: FlowStrikeHeatmap
): string => {
  const parts: string[] = [
    `Session ${response.session ?? "none"}`,
    `${response.bucketMinutes}m slots`,
  ];
  if (response.storedUntil !== null)
    parts.push(`prints through ${etClockOf(response.storedUntil)} ET`);
  parts.push(`options ${response.options.state}`);
  if (response.unread !== null) {
    parts.push(
      `Incomplete: prints of ${etClockOf(response.unread.from)}–${etClockOf(response.unread.to)} ET not read yet (${response.unread.ranges} open ${response.unread.ranges === 1 ? "gap" : "gaps"})`
    );
  }
  return parts.join(" · ");
};

/** Session-wide summary line across all strikes. */
export const strikeHeatmapTotalsLine = (
  response: FlowStrikeHeatmap
): string => {
  const { totals } = response;
  const unsignedNote =
    totals.unsignedPrints > 0
      ? ` (${whole.format(totals.unsignedPrints)} unsigned)`
      : "";
  return `Session net ${formatSignedMoney(totals.netPremium)} · Bull ${formatMoney(totals.bullishPremium)} · Bear ${formatMoney(totals.bearishPremium)} · Gross ${formatMoney(totals.grossPremium)} · ${whole.format(totals.prints)} prints${unsignedNote} · ${formatCount(totals.volume)} contracts`;
};

/** Omitted strikes disclosure line, or null when every session strike is displayed. */
export const strikeHeatmapOmittedLine = (
  response: FlowStrikeHeatmap
): string | null => {
  const { totals } = response;
  if (totals.omittedStrikes === 0) return null;
  const strikeWord = totals.omittedStrikes === 1 ? "strike" : "strikes";
  return `Showing top ${totals.shownStrikes} of ${totals.totalStrikes} strikes by gross premium · ${totals.omittedStrikes} minor ${strikeWord} (${formatMoney(totals.omittedGrossPremium)} gross, ${formatSignedMoney(totals.omittedNetPremium)} net, ${whole.format(totals.omittedPrints)} prints) omitted.`;
};

/** Rule disclosure line matching the server rules object. */
export const strikeHeatmapRuleText = (rules: FlowStrikeHeatmapRules): string =>
  `Rules ${rules.version}: stored option prints >= ${formatMoney(rules.minPremiumUsd)} over the last ${rules.retentionDays} days, top ${rules.maxStrikes} strikes by gross premium. Net premium = bullish (call at ask, put at bid) minus bearish (put at ask, call at bid); mid and unclassified fills are unsigned. Research view only.`;

/**
 * Diverging semantic CSS background using theme tokens (--color-success / --color-destructive)
 * capped to 10%-42% oklab mix so foreground text stays WCAG AA legible in light, dark, and all
 * ten theme palettes. Returns undefined for flat/zero cells.
 */
export const heatmapCellBackground = (
  netPremium: number,
  maxAbsNetPremium: number
): string | undefined => {
  if (netPremium === 0 || maxAbsNetPremium <= 0) return undefined;
  const ratio = Math.min(1, Math.abs(netPremium) / maxAbsNetPremium);
  const mix = Math.round(10 + ratio ** 0.65 * 32);
  const token =
    netPremium > 0 ? "var(--color-success)" : "var(--color-destructive)";
  return `color-mix(in oklab, ${token} ${mix}%, transparent)`;
};

const computeSpotPlacement = (
  latestPrice: number | null,
  strikes: readonly FlowStrikeHeatmapStrike[]
): StrikeHeatmapSpotPlacement | null => {
  const first = strikes[0];
  const last = strikes.at(-1);
  if (latestPrice === null || first === undefined || last === undefined)
    return null;
  if (latestPrice > first.strike + LEVEL_EPS) return { kind: "above-all" };
  if (latestPrice < last.strike - LEVEL_EPS) return { kind: "below-all" };
  const exact = strikes.find(
    (row) => Math.abs(latestPrice - row.strike) <= LEVEL_EPS
  );
  if (exact !== undefined) return { kind: "at", strike: exact.strike };
  let above = first;
  for (const row of strikes.slice(1, -1)) {
    if (row.strike < latestPrice) {
      return {
        aboveStrike: above.strike,
        belowStrike: row.strike,
        kind: "between",
      };
    }
    above = row;
  }
  return {
    aboveStrike: above.strike,
    belowStrike: last.strike,
    kind: "between",
  };
};

const isBetterDefaultCell = (
  candidate: FlowStrikeHeatmapCell,
  current: FlowStrikeHeatmapCell
): boolean => {
  const absDiff = Math.abs(candidate.netPremium) - Math.abs(current.netPremium);
  if (absDiff !== 0) return absDiff > 0;
  if (candidate.grossPremium !== current.grossPremium)
    return candidate.grossPremium > current.grossPremium;
  if (candidate.strike !== current.strike)
    return candidate.strike > current.strike;
  return candidate.slotIndex < current.slotIndex;
};

const pickDefaultSelectedKey = (
  cells: readonly FlowStrikeHeatmapCell[]
): string | null => {
  let best: FlowStrikeHeatmapCell | null = null;
  for (const cell of cells) {
    if (best === null || isBetterDefaultCell(cell, best)) best = cell;
  }
  return best === null ? null : heatmapCellKey(best.strike, best.slotIndex);
};

/** Builds the complete grid view, color scale reference, spot divider placement, and default selection. */
export const buildStrikeHeatmapGrid = (
  response: FlowStrikeHeatmap
): StrikeHeatmapGridView => {
  const cellMap = new Map<string, FlowStrikeHeatmapCell>();
  let maxAbsCellNetPremium = 0;
  for (const cell of response.cells) {
    cellMap.set(heatmapCellKey(cell.strike, cell.slotIndex), cell);
    const absNet = Math.abs(cell.netPremium);
    if (absNet > maxAbsCellNetPremium) maxAbsCellNetPremium = absNet;
  }

  const latestPrice = response.totals.latestPrice;
  const placement = computeSpotPlacement(latestPrice, response.strikes);
  const spot: StrikeHeatmapSpot | null =
    placement === null || latestPrice === null
      ? null
      : {
          label:
            response.storedUntil === null
              ? `${response.ticker} spot ${formatPrice(latestPrice)}`
              : `${response.ticker} spot ${formatPrice(latestPrice)} · ${etClockOf(response.storedUntil)} ET`,
          placement,
        };

  const rows: StrikeHeatmapGridRow[] = response.strikes.map((strike) => ({
    entries: response.slots.map((slot) => ({
      cell: cellMap.get(heatmapCellKey(strike.strike, slot.index)) ?? null,
      slot,
    })),
    spotAt: placement?.kind === "at" && placement.strike === strike.strike,
    spotBelow:
      placement?.kind === "between" && placement.aboveStrike === strike.strike,
    strike,
  }));

  return {
    defaultSelectedKey: pickDefaultSelectedKey(response.cells),
    hasUnreadSlots: response.slots.some((slot) => slot.unread),
    maxAbsCellNetPremium,
    rows,
    spot,
  };
};

const findCellPosition = (
  rows: readonly StrikeHeatmapGridRow[],
  targetKey: string
): Readonly<{
  row: StrikeHeatmapGridRow;
  rowIndex: number;
  colIndex: number;
}> | null => {
  for (const [rowIndex, row] of rows.entries()) {
    for (const [colIndex, entry] of row.entries.entries()) {
      if (
        entry.cell !== null &&
        heatmapCellKey(entry.cell.strike, entry.cell.slotIndex) === targetKey
      ) {
        return { colIndex, row, rowIndex };
      }
    }
  }
  return null;
};

const firstActiveCell = (
  entries: readonly StrikeHeatmapGridEntry[]
): FlowStrikeHeatmapCell | null =>
  entries.find((entry) => entry.cell !== null)?.cell ?? null;

const lastActiveCell = (
  entries: readonly StrikeHeatmapGridEntry[]
): FlowStrikeHeatmapCell | null =>
  [...entries].reverse().find((entry) => entry.cell !== null)?.cell ?? null;

const nearestActiveCell = (
  entries: readonly StrikeHeatmapGridEntry[],
  colIndex: number
): FlowStrikeHeatmapCell | null => {
  let nearest: FlowStrikeHeatmapCell | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [c, entry] of entries.entries()) {
    if (entry.cell === null) continue;
    const dist = Math.abs(c - colIndex);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = entry.cell;
    }
  }
  return nearest;
};

const moveWithinRow = (
  entries: readonly StrikeHeatmapGridEntry[],
  colIndex: number,
  direction: "left" | "right" | "home" | "end"
): FlowStrikeHeatmapCell | null => {
  if (direction === "left") return lastActiveCell(entries.slice(0, colIndex));
  if (direction === "right")
    return firstActiveCell(entries.slice(colIndex + 1));
  if (direction === "home") return firstActiveCell(entries);
  return lastActiveCell(entries);
};

/**
 * Moves roving-tabindex focus to the next non-empty cell in the requested direction.
 * Returns the target cell key, or currentKey if no active cell exists in that direction.
 */
export const moveHeatmapSelection = (
  rows: readonly StrikeHeatmapGridRow[],
  currentKey: string,
  direction: HeatmapMoveDirection
): string => {
  const pos = findCellPosition(rows, currentKey);
  if (pos === null) return currentKey;

  if (direction !== "up" && direction !== "down") {
    const target = moveWithinRow(pos.row.entries, pos.colIndex, direction);
    return target === null
      ? currentKey
      : heatmapCellKey(target.strike, target.slotIndex);
  }

  const candidateRows =
    direction === "up"
      ? rows.slice(0, pos.rowIndex).reverse()
      : rows.slice(pos.rowIndex + 1);
  for (const candidateRow of candidateRows) {
    const target = nearestActiveCell(candidateRow.entries, pos.colIndex);
    if (target !== null) return heatmapCellKey(target.strike, target.slotIndex);
  }
  return currentKey;
};

/** Accessible button label for one active cell. */
export const cellAriaLabel = (
  response: FlowStrikeHeatmap,
  cell: FlowStrikeHeatmapCell,
  slot: FlowStrikeHeatmapSlot
): string => {
  const direction =
    cell.netPremium > 0
      ? "net bullish"
      : cell.netPremium < 0
        ? "net bearish"
        : "flat or unsigned";
  const unreadSuffix = slot.unread ? ", unread collector gap" : "";
  return `${response.ticker} strike ${formatStrikeLabel(cell.strike)}, ${formatSlotRange(slot, response.bucketMinutes)}, ${formatSignedMoney(cell.netPremium)} ${direction}, ${whole.format(cell.prints)} prints${unreadSuffix}`;
};

/** Detailed readout strings for the pinned/focused cell inspector bar. */
export const describeSelectedCell = (
  response: FlowStrikeHeatmap,
  cell: FlowStrikeHeatmapCell
): SelectedCellReadout => {
  const slot = response.slots[cell.slotIndex];
  const slotRange =
    slot === undefined
      ? `slot ${cell.slotIndex}`
      : formatSlotRange(slot, response.bucketMinutes);
  const priceNote =
    slot === undefined || slot.price === null
      ? `${response.ticker} price not recorded`
      : `${response.ticker} ${formatPrice(slot.price)}`;
  const gapNote = slot?.unread === true ? " · unread gap" : "";
  const unsignedNote =
    cell.unsignedPrints > 0
      ? ` (${whole.format(cell.unsignedPrints)} unsigned)`
      : "";
  return {
    breakdownLine: `Bull ${formatMoney(cell.bullishPremium)} · Bear ${formatMoney(cell.bearishPremium)} · Calls ${formatMoney(cell.callPremium)} · Puts ${formatMoney(cell.putPremium)}`,
    headline: `${response.ticker} strike ${formatStrikeLabel(cell.strike)} · ${slotRange} · ${priceNote}${gapNote}`,
    metaLine: `Gross ${formatMoney(cell.grossPremium)} · ${whole.format(cell.prints)} prints${unsignedNote} · ${whole.format(cell.volume)} contracts`,
    netLine: `Net ${formatSignedMoney(cell.netPremium)}`,
  };
};
