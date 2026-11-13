"use client";

import type {
  PortfolioMonitorOrder,
  PortfolioMonitorPosition,
} from "@darkfactory/api";
import { cn } from "@darkfactory/ui";

import {
  CASH_SLICE,
  allocationSlices,
  donutArc,
  ladderScale,
  pct,
  pnlBars,
  positionName,
  price,
  qty,
  signed,
  stopLadder,
  usd,
  type LadderScale,
  type StopLadder,
} from "./portfolio-monitor-model.ts";
import { EmptyOrWithheld, PanelTitle } from "./portfolio-monitor-tables.tsx";

// Plain SVG and CSS charts (no chart dependency). Each mark has a native title tooltip
// and every chart has a text equivalent (legend or list) for screen readers and touch.

const SLICE_COLORS = [
  { fill: "fill-sky-500", swatch: "bg-sky-500" },
  { fill: "fill-emerald-500", swatch: "bg-emerald-500" },
  { fill: "fill-amber-500", swatch: "bg-amber-500" },
  { fill: "fill-rose-500", swatch: "bg-rose-500" },
  { fill: "fill-indigo-500", swatch: "bg-indigo-500" },
  { fill: "fill-teal-500", swatch: "bg-teal-500" },
  { fill: "fill-orange-500", swatch: "bg-orange-500" },
  { fill: "fill-lime-600", swatch: "bg-lime-600" },
  { fill: "fill-pink-500", swatch: "bg-pink-500" },
  { fill: "fill-blue-700", swatch: "bg-blue-700" },
] as const;
// Cycles through the palette; the trailing default only satisfies the type checker.
const sliceColor = (index: number) => {
  const [color] = [
    ...SLICE_COLORS.filter(
      (_color, position) => position === index % SLICE_COLORS.length
    ),
    SLICE_COLORS[0],
  ];
  return color;
};
const CASH_COLOR = { fill: "fill-stone-400", swatch: "bg-stone-400" } as const;

const CARD = "space-y-3 rounded-md border border-border bg-surface p-4";

export const AllocationChart = ({
  nlv,
  positions,
  withheld,
}: {
  readonly withheld: string | null;
  readonly nlv: number | null;
  readonly positions: readonly PortfolioMonitorPosition[];
}) => {
  const slices = allocationSlices(positions, nlv);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let angle = 0;
  const arcs = slices.map((slice, index) => {
    const start = angle;
    // Slices are only built for positive values, so total > 0 here.
    angle += (slice.value / total) * Math.PI * 2;
    const color = slice.name === CASH_SLICE ? CASH_COLOR : sliceColor(index);
    return { slice, color, path: donutArc(100, 100, 90, 52, start, angle) };
  });
  return (
    <section aria-labelledby="pm-allocation-title" className={CARD}>
      <PanelTitle id="pm-allocation-title">
        {"Allocation (% of NLV)"}
      </PanelTitle>
      {arcs.length === 0 ? (
        <EmptyOrWithheld
          empty="No allocation data."
          what="Allocation"
          withheld={withheld}
        />
      ) : (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <svg
            aria-label="Allocation donut chart. The list next to it has the same values."
            className="size-48 shrink-0"
            role="img"
            viewBox="0 0 200 200"
          >
            {arcs.map(({ color, path, slice }) => {
              return (
                <path
                  className={cn(color.fill, "stroke-background")}
                  d={path}
                  data-slice={slice.name}
                  key={slice.name}
                  strokeWidth={1.5}
                >
                  <title>
                    {`${slice.name}: ${usd(slice.value)} (${pct(slice.pctOfNlv, 1)})`}
                  </title>
                </path>
              );
            })}
          </svg>
          <ul
            className="w-full space-y-1 text-sm tabular-nums"
            data-allocation-legend="true"
          >
            {arcs.map(({ color, slice }) => {
              return (
                <li className="flex items-center gap-2" key={slice.name}>
                  <span
                    aria-hidden="true"
                    className={cn("size-3 shrink-0 rounded-sm", color.swatch)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={slice.name}>
                    {slice.name}
                  </span>
                  <span className="text-muted-foreground">
                    {usd(slice.value)}
                  </span>
                  <span className="w-14 text-right">
                    {pct(slice.pctOfNlv, 1)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
};

const BAR_ROW = 30;
const LABEL_WIDTH = 88;
const CHART_WIDTH = 640;

export const PnlChart = ({
  positions,
  withheld,
}: {
  readonly withheld: string | null;
  readonly positions: readonly PortfolioMonitorPosition[];
}) => {
  const bars = pnlBars(positions);
  const scaleMax = Math.max(
    1,
    ...bars.flatMap((bar) => [Math.abs(bar.unrealized), Math.abs(bar.daily)])
  );
  const plot = CHART_WIDTH - LABEL_WIDTH - 8;
  const zero = LABEL_WIDTH + plot / 2;
  const width = (value: number) => (Math.abs(value) / scaleMax) * (plot / 2);
  const x = (value: number) => (value >= 0 ? zero : zero - width(value));
  const height = Math.max(BAR_ROW, bars.length * BAR_ROW);
  return (
    <section aria-labelledby="pm-pnl-title" className={CARD}>
      <PanelTitle id="pm-pnl-title">P&L by position</PanelTitle>
      {bars.length === 0 ? (
        <EmptyOrWithheld
          empty="No positions to chart."
          what="Positions"
          withheld={withheld}
        />
      ) : (
        <>
          <svg
            aria-label="Bar chart of unrealized and daily P&L per position."
            className="h-auto w-full"
            role="img"
            viewBox={`0 0 ${CHART_WIDTH} ${height}`}
          >
            <line
              className="stroke-border"
              x1={zero}
              x2={zero}
              y1={0}
              y2={height}
            />
            {bars.map((bar, index) => {
              const top = index * BAR_ROW;
              const title = `${bar.name}: unrealized ${signed(bar.unrealized)}, today ${signed(bar.daily)}`;
              return (
                <g data-bar={bar.name} key={bar.name}>
                  <title>{title}</title>
                  <text
                    className="fill-muted-foreground text-[11px]"
                    dominantBaseline="middle"
                    x={LABEL_WIDTH - 6}
                    y={top + BAR_ROW / 2}
                    textAnchor="end"
                  >
                    {bar.name}
                  </text>
                  <rect
                    className={
                      bar.unrealized >= 0 ? "fill-emerald-500" : "fill-red-500"
                    }
                    height={12}
                    width={Math.max(1, width(bar.unrealized))}
                    x={x(bar.unrealized)}
                    y={top + 5}
                  />
                  <rect
                    className={
                      bar.daily >= 0 ? "fill-emerald-500" : "fill-red-500"
                    }
                    height={5}
                    opacity={0.6}
                    width={Math.max(1, width(bar.daily))}
                    x={x(bar.daily)}
                    y={top + 19}
                  />
                </g>
              );
            })}
          </svg>
          <p className="text-muted-foreground text-xs">
            Thick bars: unrealized P&L. Thin bars: today's P&L. Green is a gain,
            red is a loss. Hover a bar for values.
          </p>
          <ul className="sr-only">
            {bars.map((bar) => {
              return (
                <li key={bar.name}>
                  {`${bar.name}: unrealized ${signed(bar.unrealized)}, today ${signed(bar.daily)}`}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
};

const LadderBar = ({
  ladder,
  scale,
}: {
  readonly ladder: StopLadder;
  readonly scale: LadderScale;
}) => {
  const { position } = ladder;
  const at = (value: number) => `${scale.at(value)}%`;
  return (
    <div className="relative h-10 rounded-md bg-muted" data-ladder-bar="true">
      {position.avgPrice === null ? null : (
        <div
          className="absolute top-0 h-full border-muted-foreground border-l-2 border-dashed"
          data-mark="avg"
          style={{ left: at(position.avgPrice) }}
          title={`Average cost ${price(position.avgPrice)}`}
        />
      )}
      {ladder.stops.map(({ order, stop }) => {
        return (
          <div
            className="absolute inset-y-1 w-1 -translate-x-1/2 rounded-sm bg-red-500"
            data-mark="stop"
            key={order.key}
            style={{ left: at(stop) }}
            title={rungTitle(order)}
          />
        );
      })}
      {position.last === null ? null : (
        <div
          className="absolute top-0 h-full w-0.5 -translate-x-1/2 bg-sky-500"
          data-mark="last"
          style={{ left: at(position.last) }}
          title={`Last ${price(position.last)}`}
        />
      )}
      <span className="absolute bottom-0 left-1 text-[10px] text-muted-foreground tabular-nums">
        {price(scale.low)}
      </span>
      <span className="absolute right-1 bottom-0 text-[10px] text-muted-foreground tabular-nums">
        {price(scale.high)}
      </span>
    </div>
  );
};

const rungTitle = (order: PortfolioMonitorOrder): string => {
  return `${order.orderType} ${qty(order.remaining ?? order.qty)} @ ${price(order.stopPrice)}${order.limitPrice === null ? "" : ` limit ${price(order.limitPrice)}`}`;
};

const ladderSummary = (ladder: StopLadder): string => {
  const { position, rungs, coveredQty, nearest } = ladder;
  const parts = [
    `last ${price(position.last)}`,
    `${rungs.length} ${rungs.length === 1 ? "rung" : "rungs"}`,
    `${qty(coveredQty)}/${qty(Math.abs(position.position))} covered`,
  ];
  if (nearest !== null)
    parts.push(`nearest stop ${nearest.pct.toFixed(1)}% ${nearest.side}`);
  return parts.join(" · ");
};

export const StopLadders = ({
  withheld,
  orders,
  positions,
}: {
  readonly withheld: string | null;
  readonly orders: readonly PortfolioMonitorOrder[];
  readonly positions: readonly PortfolioMonitorPosition[];
}) => {
  const ladders = positions.map((position) => stopLadder(position, orders));
  return (
    <section aria-labelledby="pm-ladders-title" className={CARD}>
      <PanelTitle id="pm-ladders-title">Stop ladders vs last price</PanelTitle>
      {ladders.length === 0 ? (
        <EmptyOrWithheld
          empty="No open positions, so there are no stop ladders."
          what="Positions"
          withheld={withheld}
        />
      ) : (
        <ul className="space-y-4">
          {ladders.map((ladder) => {
            const scale = ladderScale(ladder);
            return (
              <li
                className="space-y-1"
                data-ladder={ladder.position.id}
                key={ladder.position.id}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  <span className="font-semibold text-sm">
                    {positionName(ladder.position)}
                  </span>
                  <span
                    className="text-muted-foreground tabular-nums"
                    data-ladder-summary="true"
                  >
                    {ladderSummary(ladder)}
                  </span>
                </div>
                {ladder.rungs.length === 0 || scale === null ? (
                  <p
                    className="rounded-md border border-warning-border bg-warning-subtle px-2 py-1 text-warning-foreground text-xs"
                    data-no-stops="true"
                  >
                    No stop orders for this position.
                  </p>
                ) : (
                  <>
                    <LadderBar ladder={ladder} scale={scale} />
                    <p className="text-muted-foreground text-xs tabular-nums">
                      Stops: {ladder.rungs.map(rungTitle).join("; ")}
                    </p>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">
        Blue line: last price. Red marks: stop orders (hover for size and price;
        the list under each bar has the same values). Dashed line: average cost.
      </p>
    </section>
  );
};
