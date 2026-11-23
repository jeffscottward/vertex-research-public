// What: Options flow heatmap panel on /flow (flow.strikeHeatmap, flow-strike-heatmap.v1):
// strike x time-slot matrix colored by signed net option premium (bullish minus bearish) with
// 5m/15m/30m bucket switching, latest spot reference marker, open collector gap shading, roving
// tabindex keyboard navigation, and a pinned cell inspector bar.
// Research only: describes stored option prints, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/strike-heatmap-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-flow-strike-time-heatmap/design.md.
"use client";

import type {
  FlowStrikeHeatmap,
  FlowStrikeHeatmapBucketMinutes,
  FlowStrikeHeatmapCell,
  FlowStrikeHeatmapSlot,
  FlowStrikeHeatmapSymbol,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { Fragment, type KeyboardEvent, useRef, useState } from "react";

import { formatPrice, formatSignedMoney } from "../../features/flow/format.ts";
import {
  buildStrikeHeatmapGrid,
  cellAriaLabel,
  describeSelectedCell,
  type FlowStrikeHeatmapFailure,
  formatSlotRange,
  formatSlotShortTime,
  formatStrikeLabel,
  type HeatmapMoveDirection,
  heatmapCellBackground,
  heatmapCellKey,
  moveHeatmapSelection,
  STRIKE_HEATMAP_BUCKET_OPTIONS,
  STRIKE_HEATMAP_LOADING,
  STRIKE_HEATMAP_NO_CELLS,
  type StrikeHeatmapGridView,
  strikeHeatmapEmptyLine,
  strikeHeatmapFailureLine,
  strikeHeatmapHeaderLine,
  strikeHeatmapOmittedLine,
  strikeHeatmapRuleText,
  strikeHeatmapTitle,
  strikeHeatmapTotalsLine,
} from "../../features/flow/strike-heatmap-view-model.ts";

export type FlowStrikeHeatmapPanelProps = Readonly<{
  symbol: FlowStrikeHeatmapSymbol;
  bucketMinutes: FlowStrikeHeatmapBucketMinutes;
  document: FlowStrikeHeatmap | null;
  failure: FlowStrikeHeatmapFailure | null;
  pending: boolean;
  refreshMs: number;
  onBucketMinutesChange: (next: FlowStrikeHeatmapBucketMinutes) => void;
  onRetry: () => void;
}>;

const KEY_TO_DIRECTION: Readonly<Record<string, HeatmapMoveDirection>> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  End: "end",
  Home: "home",
};

const UNREAD_PATTERN =
  "repeating-linear-gradient(-45deg, transparent 0 4px, color-mix(in oklab, var(--color-muted-foreground) 16%, transparent) 4px 8px)";

const netDirectionOf = (netPremium: number): "bull" | "bear" | "flat" => {
  if (netPremium > 0) return "bull";
  if (netPremium < 0) return "bear";
  return "flat";
};

const netToneClass = (netPremium: number): string => {
  if (netPremium > 0) return "text-success";
  if (netPremium < 0) return "text-destructive";
  return "text-muted-foreground";
};

const slotHeaderTitle = (
  response: FlowStrikeHeatmap,
  slot: FlowStrikeHeatmapSlot
): string => {
  const parts = [formatSlotRange(slot, response.bucketMinutes)];
  if (slot.price !== null)
    parts.push(`${response.ticker} ${formatPrice(slot.price)}`);
  if (slot.unread) parts.push("unread collector gap");
  return parts.join(" · ");
};

const BucketSelector = ({
  bucketMinutes,
  onBucketMinutesChange,
}: Readonly<{
  bucketMinutes: FlowStrikeHeatmapBucketMinutes;
  onBucketMinutesChange: (next: FlowStrikeHeatmapBucketMinutes) => void;
}>) => (
  <fieldset className="inline-flex gap-1 rounded-md border border-border p-0.5">
    <legend className="sr-only">Heatmap time bucket width</legend>
    {STRIKE_HEATMAP_BUCKET_OPTIONS.map((option) => (
      <Button
        aria-pressed={option === bucketMinutes}
        data-flow-strike-heatmap-bucket={String(option)}
        key={option}
        onClick={() => {
          if (option !== bucketMinutes) onBucketMinutesChange(option);
        }}
        size="sm"
        variant={option === bucketMinutes ? "secondary" : "ghost"}
      >
        {`${option}m`}
      </Button>
    ))}
  </fieldset>
);

const HeatmapLegend = ({
  hasUnreadSlots,
}: Readonly<{ hasUnreadSlots: boolean }>) => (
  <ul
    aria-label="Heatmap color legend"
    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs"
    data-flow-strike-heatmap-legend=""
  >
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-5 rounded-xs border border-border"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-success) 32%, transparent)",
        }}
      />
      <span>Net bullish (+)</span>
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-5 rounded-xs border border-border"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-destructive) 32%, transparent)",
        }}
      />
      <span>Net bearish (−)</span>
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-5 rounded-xs border border-muted-foreground/70 border-dashed bg-muted/40"
      />
      <span>Flat / unsigned ($0)</span>
    </li>
    {hasUnreadSlots ? (
      <li
        className="flex items-center gap-1.5"
        data-flow-strike-heatmap-legend-unread=""
      >
        <span
          aria-hidden="true"
          className="inline-block h-3 w-5 rounded-xs border border-border"
          style={{ backgroundImage: UNREAD_PATTERN }}
        />
        <span>Unread collector gap</span>
      </li>
    ) : null}
  </ul>
);

const HeatmapSpotDividerRow = ({
  colSpan,
  kind,
  label,
}: Readonly<{
  colSpan: number;
  kind: "above-all" | "between" | "below-all";
  label: string;
}>) => (
  <TableRow
    className="border-primary/70 border-y-2 bg-primary/5 hover:bg-primary/5"
    data-flow-strike-heatmap-spot={kind}
  >
    <TableCell className="px-3 py-1.5" colSpan={colSpan}>
      <div className="flex items-center gap-2 font-medium text-foreground text-xs">
        <span className="inline-block rounded-xs bg-primary px-1.5 py-0.5 font-semibold text-[11px] text-primary-foreground">
          Spot
        </span>
        <span className="tabular-nums">{label}</span>
      </div>
    </TableCell>
  </TableRow>
);

const HeatmapCellButton = ({
  cell,
  isSelected,
  maxAbsCellNetPremium,
  onKeyDown,
  onSelect,
  registerNode,
  response,
  slot,
}: Readonly<{
  cell: FlowStrikeHeatmapCell;
  isSelected: boolean;
  maxAbsCellNetPremium: number;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, key: string) => void;
  onSelect: (key: string) => void;
  registerNode: (key: string, node: HTMLButtonElement | null) => void;
  response: FlowStrikeHeatmap;
  slot: FlowStrikeHeatmapSlot;
}>) => {
  const key = heatmapCellKey(cell.strike, cell.slotIndex);
  const direction = netDirectionOf(cell.netPremium);
  const background = heatmapCellBackground(
    cell.netPremium,
    maxAbsCellNetPremium
  );
  const borderClass =
    direction === "flat"
      ? "border-dashed border-muted-foreground/70 bg-muted/35 text-muted-foreground"
      : "border-border/70 text-foreground";
  return (
    <button
      aria-label={cellAriaLabel(response, cell, slot)}
      aria-pressed={isSelected}
      className={`flex min-h-11 w-full min-w-15 items-center justify-center rounded-sm border px-1.5 py-1 font-medium text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${borderClass} ${isSelected ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""}`}
      data-flow-strike-heatmap-cell={key}
      data-flow-strike-heatmap-direction={direction}
      onClick={() => onSelect(key)}
      onFocus={() => onSelect(key)}
      onKeyDown={(event) => onKeyDown(event, key)}
      ref={(node) => registerNode(key, node)}
      style={{
        backgroundColor: background,
        backgroundImage: slot.unread ? UNREAD_PATTERN : undefined,
      }}
      tabIndex={isSelected ? 0 : -1}
      type="button"
    >
      {formatSignedMoney(cell.netPremium)}
    </button>
  );
};

const HeatmapInspector = ({
  cell,
  response,
}: Readonly<{
  cell: FlowStrikeHeatmapCell;
  response: FlowStrikeHeatmap;
}>) => {
  const readout = describeSelectedCell(response, cell);
  return (
    <div
      aria-live="polite"
      className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs tabular-nums"
      data-flow-strike-heatmap-inspector=""
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-foreground">{readout.headline}</p>
        <p className={`font-semibold ${netToneClass(cell.netPremium)}`}>
          {readout.netLine}
        </p>
      </div>
      <p className="mt-1 text-muted-foreground">{readout.breakdownLine}</p>
      <p className="mt-0.5 text-muted-foreground">{readout.metaLine}</p>
    </div>
  );
};

const HeatmapGrid = ({
  activeSelectedKey,
  grid,
  onSelect,
  response,
}: Readonly<{
  activeSelectedKey: string | null;
  grid: StrikeHeatmapGridView;
  onSelect: (key: string) => void;
  response: FlowStrikeHeatmap;
}>) => {
  const cellNodes = useRef(new Map<string, HTMLButtonElement>());
  const totalColumns = response.slots.length + 2;
  const minWidthRem = Math.max(40, response.slots.length * 4.5 + 11);

  const registerNode = (key: string, node: HTMLButtonElement | null) => {
    if (node === null) cellNodes.current.delete(key);
    else cellNodes.current.set(key, node);
  };

  const handleCellKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    key: string
  ) => {
    const direction = KEY_TO_DIRECTION[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const nextKey = moveHeatmapSelection(grid.rows, key, direction);
    if (nextKey === key) return;
    onSelect(nextKey);
    for (const [cellKey, node] of cellNodes.current) {
      if (cellKey === nextKey) node.focus();
    }
  };

  const spot = grid.spot;

  return (
    <div>
      <TableScroll
        data-flow-strike-heatmap-scroll=""
        label={`${strikeHeatmapTitle(response.symbol)} matrix`}
        minWidth={`${minWidthRem}rem`}
      >
        <Table data-flow-strike-heatmap-table="">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 border-border border-r bg-card">
                Strike
              </TableHead>
              {response.slots.map((slot) => (
                <TableHead
                  className="px-1.5 text-center"
                  data-flow-strike-heatmap-slot={String(slot.index)}
                  data-flow-strike-heatmap-unread={
                    slot.unread ? "true" : undefined
                  }
                  key={slot.index}
                  style={
                    slot.unread
                      ? { backgroundImage: UNREAD_PATTERN }
                      : undefined
                  }
                  title={slotHeaderTitle(response, slot)}
                >
                  {formatSlotShortTime(slot.start)}
                </TableHead>
              ))}
              <TableHead className="border-border border-l text-right" numeric>
                Net
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spot?.placement.kind === "above-all" ? (
              <HeatmapSpotDividerRow
                colSpan={totalColumns}
                kind="above-all"
                label={spot.label}
              />
            ) : null}
            {grid.rows.map((row) => (
              <Fragment key={row.strike.strike}>
                <TableRow
                  className={
                    row.spotAt ? "bg-primary/5 hover:bg-primary/10" : undefined
                  }
                  data-flow-strike-heatmap-row={formatStrikeLabel(
                    row.strike.strike
                  )}
                >
                  <th
                    className="sticky left-0 z-10 border-border border-r bg-card px-3 py-2.5 text-left align-middle font-semibold text-foreground tabular-nums"
                    scope="row"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span>{formatStrikeLabel(row.strike.strike)}</span>
                      {row.spotAt && spot !== null ? (
                        <span
                          className="rounded-xs bg-primary px-1 py-0.5 font-semibold text-[10px] text-primary-foreground"
                          data-flow-strike-heatmap-spot="at"
                          title={spot.label}
                        >
                          Spot
                        </span>
                      ) : null}
                    </span>
                  </th>
                  {row.entries.map(({ cell, slot }) => {
                    if (cell === null) {
                      return (
                        <TableCell
                          className="p-1 text-center text-muted-foreground/50 text-xs"
                          data-flow-strike-heatmap-cell-unread={
                            slot.unread ? "true" : undefined
                          }
                          key={slot.index}
                          style={
                            slot.unread
                              ? { backgroundImage: UNREAD_PATTERN }
                              : undefined
                          }
                        >
                          <span aria-hidden="true">·</span>
                        </TableCell>
                      );
                    }
                    const key = heatmapCellKey(cell.strike, cell.slotIndex);
                    return (
                      <TableCell className="p-1" key={slot.index}>
                        <HeatmapCellButton
                          cell={cell}
                          isSelected={activeSelectedKey === key}
                          maxAbsCellNetPremium={grid.maxAbsCellNetPremium}
                          onKeyDown={handleCellKeyDown}
                          onSelect={onSelect}
                          registerNode={registerNode}
                          response={response}
                          slot={slot}
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell
                    className={`border-border border-l font-medium ${netToneClass(row.strike.netPremium)}`}
                    numeric
                  >
                    {formatSignedMoney(row.strike.netPremium)}
                  </TableCell>
                </TableRow>
                {row.spotBelow && spot !== null ? (
                  <HeatmapSpotDividerRow
                    colSpan={totalColumns}
                    kind="between"
                    label={spot.label}
                  />
                ) : null}
              </Fragment>
            ))}
            {spot?.placement.kind === "below-all" ? (
              <HeatmapSpotDividerRow
                colSpan={totalColumns}
                kind="below-all"
                label={spot.label}
              />
            ) : null}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
};

const HeatmapResponse = ({
  response,
  symbol,
}: Readonly<{
  response: FlowStrikeHeatmap;
  symbol: FlowStrikeHeatmapSymbol;
}>) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (response.session === null) {
    return (
      <p className="text-sm" data-flow-strike-heatmap-empty="" role="status">
        {strikeHeatmapEmptyLine(symbol)}
      </p>
    );
  }

  const grid = buildStrikeHeatmapGrid(response);
  const cellByKey = new Map(
    response.cells.map((cell) => [
      heatmapCellKey(cell.strike, cell.slotIndex),
      cell,
    ])
  );
  const activeSelectedKey =
    selectedKey !== null && cellByKey.has(selectedKey)
      ? selectedKey
      : grid.defaultSelectedKey;
  const selectedCell =
    activeSelectedKey === null ? undefined : cellByKey.get(activeSelectedKey);
  const omittedLine = strikeHeatmapOmittedLine(response);

  return (
    <div className="space-y-3">
      <p
        className="text-muted-foreground text-sm"
        data-flow-strike-heatmap-header=""
      >
        {strikeHeatmapHeaderLine(response)}
      </p>
      {response.strikes.length === 0 ? (
        <p
          className="text-sm"
          data-flow-strike-heatmap-no-cells=""
          role="status"
        >
          {STRIKE_HEATMAP_NO_CELLS}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <HeatmapLegend hasUnreadSlots={grid.hasUnreadSlots} />
            {grid.spot?.placement.kind === "at" ? (
              <p
                className="text-muted-foreground text-xs tabular-nums"
                data-flow-strike-heatmap-spot-summary=""
              >
                {grid.spot.label}
              </p>
            ) : null}
          </div>
          {selectedCell === undefined ? null : (
            <HeatmapInspector cell={selectedCell} response={response} />
          )}
          <HeatmapGrid
            activeSelectedKey={activeSelectedKey}
            grid={grid}
            onSelect={setSelectedKey}
            response={response}
          />
          <p
            className="text-sm tabular-nums"
            data-flow-strike-heatmap-totals=""
          >
            {strikeHeatmapTotalsLine(response)}
          </p>
          {omittedLine === null ? null : (
            <p
              className="text-muted-foreground text-xs tabular-nums"
              data-flow-strike-heatmap-omitted=""
            >
              {omittedLine}
            </p>
          )}
        </>
      )}
      <p
        className="text-muted-foreground text-xs"
        data-flow-strike-heatmap-rule=""
      >
        {strikeHeatmapRuleText(response.rules)}
      </p>
    </div>
  );
};

/**
 * Independent panel for flow.strikeHeatmap on /flow (SPY and ES only).
 * Keeps the last valid grid visible during bucket changes or transient failures, with Retry.
 */
export const FlowStrikeHeatmapPanel = ({
  symbol,
  bucketMinutes,
  document,
  failure,
  pending,
  refreshMs,
  onBucketMinutesChange,
  onRetry,
}: FlowStrikeHeatmapPanelProps) => {
  const state = ((): "failed" | "response" | "loading" => {
    if (failure !== null) return "failed";
    return document === null ? "loading" : "response";
  })();

  return (
    <Panel title={strikeHeatmapTitle(symbol)}>
      <div
        className={document === null ? "min-h-72 space-y-4" : "space-y-4"}
        data-flow-strike-heatmap={symbol}
        data-flow-strike-heatmap-state={state}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BucketSelector
            bucketMinutes={bucketMinutes}
            onBucketMinutesChange={onBucketMinutesChange}
          />
          {pending && document !== null ? (
            <p
              className="text-muted-foreground text-xs"
              data-flow-strike-heatmap-updating=""
              role="status"
            >
              {`Updating ${bucketMinutes}m grid…`}
            </p>
          ) : null}
        </div>
        {failure === null ? null : (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            data-flow-strike-heatmap-error=""
            role="alert"
          >
            <p>
              {strikeHeatmapFailureLine(
                failure,
                refreshMs,
                document?.bucketMinutes ?? null,
                bucketMinutes
              )}
            </p>
            <Button
              data-flow-strike-heatmap-retry=""
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        )}
        {state === "loading" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {STRIKE_HEATMAP_LOADING}
          </p>
        ) : null}
        {document === null ? null : (
          <HeatmapResponse response={document} symbol={symbol} />
        )}
      </div>
    </Panel>
  );
};
