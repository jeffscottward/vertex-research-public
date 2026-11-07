"use client";

// What: Exposure tab of the watchlist. A sunburst of the current portfolio (portfolioMonitor.snapshot,
// read on first open): inner ring security type, outer ring symbol by gross market value, with
// watchlist symbols marked; and a scatter of one-year return against max drawdown for each
// analysed watchlist symbol (daily bars). Each chart has a table with the same numbers.
// Used by: watchlist-workspace.tsx.

import type { PortfolioMonitorPosition } from "@darkfactory/api";
import { Button, Panel } from "@darkfactory/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailure,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import {
  annularSectorPath,
  buildSunburst,
  extentWithZero,
  formatPercent,
  linearScale,
  maxDrawdown,
  type SunburstArc,
  totalReturn,
} from "./watchlist-analytics.ts";
import { BarsStatusList, type WatchlistBars } from "./watchlist-bars.tsx";

export interface WatchlistExposureProps {
  readonly portfolio: PortfolioMonitorGateway;
  /** Every watchlist symbol, normalized (BF-B as BF.B, upper case). */
  readonly watchlistSymbols: ReadonlySet<string>;
  /** Analysed symbols (capped), in watchlist order. */
  readonly symbols: readonly string[];
  readonly totalSymbols: number;
  readonly bars: WatchlistBars;
}

type PositionsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; positions: readonly PortfolioMonitorPosition[] }>
  | Readonly<{ type: "error"; failure: PortfolioMonitorFailure }>;

const SUNBURST_SIZE = 260;
const CENTER = SUNBURST_SIZE / 2;
const TYPE_RING = [44, 80] as const;
const SYMBOL_RING = [83, 114] as const;
const WATCH_BAND = [117, 125] as const;

const SCATTER = {
  width: 420,
  height: 260,
  left: 48,
  right: 16,
  top: 16,
  bottom: 36,
};

const money = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });

const typeColor = (types: readonly string[], secType: string): string =>
  `var(--chart-${(types.indexOf(secType) % 5) + 1})`;

const arcTitle = (arc: SunburstArc): string =>
  `${arc.ring === "secType" ? arc.label : `${arc.label} (${arc.secType})`}: ${money(arc.value)} gross, ${formatPercent(arc.share)}${arc.short ? ", net short" : ""}${arc.ring === "symbol" && arc.onWatchlist ? ", on watchlist" : ""}`;

const PositionsSunburst = ({
  positions,
  watchlistSymbols,
}: Readonly<{
  positions: readonly PortfolioMonitorPosition[];
  watchlistSymbols: ReadonlySet<string>;
}>) => {
  const sunburst = buildSunburst(positions, watchlistSymbols);
  const typeArcs = sunburst.arcs.filter((arc) => arc.ring === "secType");
  const symbolArcs = sunburst.arcs.filter((arc) => arc.ring === "symbol");
  const types = typeArcs.map((arc) => arc.secType);
  const listed = symbolArcs.filter((arc) => arc.onWatchlist);
  if (symbolArcs.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No positions with a market value
        {sunburst.skipped > 0 ? ` (${sunburst.skipped} without one)` : ""}.
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-6">
        <svg
          aria-label={`Portfolio by security type and symbol: ${symbolArcs.length} symbols, ${listed.length} on the watchlist`}
          className="h-auto w-full max-w-[260px]"
          role="img"
          viewBox={`0 0 ${SUNBURST_SIZE} ${SUNBURST_SIZE}`}
        >
          {typeArcs.map((arc) => (
            <path
              d={annularSectorPath(
                CENTER,
                CENTER,
                TYPE_RING[0],
                TYPE_RING[1],
                arc.start,
                arc.end
              )}
              data-arc={arc.key}
              fill={typeColor(types, arc.secType)}
              key={arc.key}
              stroke="var(--background)"
            >
              <title>{arcTitle(arc)}</title>
            </path>
          ))}
          {symbolArcs.map((arc) => (
            <path
              d={annularSectorPath(
                CENTER,
                CENTER,
                SYMBOL_RING[0],
                SYMBOL_RING[1],
                arc.start,
                arc.end
              )}
              data-arc={arc.key}
              data-watchlist={arc.onWatchlist ? "true" : undefined}
              fill={typeColor(types, arc.secType)}
              fillOpacity={arc.onWatchlist ? 1 : 0.45}
              key={arc.key}
              stroke="var(--background)"
            >
              <title>{arcTitle(arc)}</title>
            </path>
          ))}
          {listed.map((arc) => (
            <path
              d={annularSectorPath(
                CENTER,
                CENTER,
                WATCH_BAND[0],
                WATCH_BAND[1],
                arc.start,
                arc.end
              )}
              fill="var(--foreground)"
              key={`band-${arc.key}`}
            />
          ))}
          <text
            className="fill-foreground font-mono text-xs"
            dominantBaseline="middle"
            textAnchor="middle"
            x={CENTER}
            y={CENTER}
          >
            {money(sunburst.total)}
          </text>
        </svg>
        <ul aria-label="Sunburst legend" className="space-y-1 text-sm">
          {typeArcs.map((arc) => (
            <li className="flex items-center gap-2" key={arc.key}>
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-sm"
                style={{ backgroundColor: typeColor(types, arc.secType) }}
              />
              {arc.label} · {formatPercent(arc.share)}
            </li>
          ))}
          <li className="flex items-center gap-2 text-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-1 w-3 bg-foreground"
            />
            Outer band and solid color: on the watchlist
          </li>
        </ul>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Portfolio positions by type and symbol
          </caption>
          <thead className="text-left text-muted-foreground text-xs">
            <tr>
              <th className="px-2 py-1 font-medium" scope="col">
                Type
              </th>
              <th className="px-2 py-1 font-medium" scope="col">
                Symbol
              </th>
              <th className="px-2 py-1 text-right font-medium" scope="col">
                Gross value
              </th>
              <th className="px-2 py-1 text-right font-medium" scope="col">
                Share
              </th>
              <th className="px-2 py-1 font-medium" scope="col">
                Watchlist
              </th>
            </tr>
          </thead>
          <tbody>
            {symbolArcs.map((arc) => (
              <tr
                className="border-border border-t"
                data-arc={arc.key}
                key={arc.key}
              >
                <td className="px-2 py-1 font-mono">{arc.secType}</td>
                <th
                  className="px-2 py-1 text-left font-medium font-mono"
                  scope="row"
                >
                  {arc.label}
                  {arc.short ? (
                    <span className="ml-1 text-muted-foreground text-xs">
                      short
                    </span>
                  ) : null}
                </th>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {money(arc.value)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {formatPercent(arc.share)}
                </td>
                <td className="px-2 py-1">
                  {arc.onWatchlist ? "On watchlist" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sunburst.skipped > 0 ? (
          <p className="mt-2 text-muted-foreground text-xs">
            {sunburst.skipped} position{sunburst.skipped === 1 ? "" : "s"}{" "}
            without a market value left out.
          </p>
        ) : null}
      </div>
    </div>
  );
};

type ScatterPoint = Readonly<{
  symbol: string;
  ret: number;
  drawdown: number;
  days: number;
}>;

const ReturnDrawdownScatter = ({
  points,
}: Readonly<{ points: readonly ScatterPoint[] }>) => {
  const [x0, x1] = extentWithZero(points.map((p) => p.drawdown));
  const [y0, y1] = extentWithZero(points.map((p) => p.ret));
  const x = linearScale(x0, x1, SCATTER.left, SCATTER.width - SCATTER.right);
  const y = linearScale(y0, y1, SCATTER.height - SCATTER.bottom, SCATTER.top);
  return (
    <svg
      aria-label={`One-year return against max drawdown for ${points.length} symbols`}
      className="h-auto w-full max-w-[420px]"
      role="img"
      viewBox={`0 0 ${SCATTER.width} ${SCATTER.height}`}
    >
      <line
        stroke="var(--border)"
        x1={SCATTER.left}
        x2={SCATTER.width - SCATTER.right}
        y1={y(0)}
        y2={y(0)}
      />
      <line
        stroke="var(--border)"
        x1={x(0)}
        x2={x(0)}
        y1={SCATTER.top}
        y2={SCATTER.height - SCATTER.bottom}
      />
      <text
        className="fill-muted-foreground text-[10px]"
        x={SCATTER.left}
        y={SCATTER.height - 8}
      >
        Max drawdown {formatPercent(x0, 0)} … {formatPercent(x1, 0)}
      </text>
      <text
        className="fill-muted-foreground text-[10px]"
        transform={`rotate(-90 12 ${SCATTER.height / 2})`}
        x={12}
        y={SCATTER.height / 2}
      >
        Return {formatPercent(y0, 0)} … {formatPercent(y1, 0)}
      </text>
      {points.map((p) => (
        <g data-point={p.symbol} key={p.symbol}>
          <circle cx={x(p.drawdown)} cy={y(p.ret)} fill="var(--primary)" r={4}>
            <title>
              {p.symbol}: return {formatPercent(p.ret)}, max drawdown{" "}
              {formatPercent(p.drawdown)}
            </title>
          </circle>
          <text
            className="fill-foreground font-mono text-[10px]"
            x={x(p.drawdown) + 6}
            y={y(p.ret) - 6}
          >
            {p.symbol}
          </text>
        </g>
      ))}
    </svg>
  );
};

export const WatchlistExposure = ({
  portfolio,
  watchlistSymbols,
  symbols,
  totalSymbols,
  bars,
}: WatchlistExposureProps) => {
  const [positions, setPositions] = useState<PositionsState>({
    type: "loading",
  });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setPositions({ type: "loading" });
    let next: PositionsState;
    try {
      next = {
        positions: (await portfolio.snapshot()).positions,
        type: "ready",
      };
    } catch (error) {
      next = { failure: describePortfolioMonitorFailure(error), type: "error" };
    }
    if (mine === generation.current) setPositions(next);
  }, [portfolio]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const points: ScatterPoint[] = [];
  for (const symbol of symbols) {
    const state = bars.states.get(symbol);
    if (state?.type !== "ready") continue;
    const ret = totalReturn(state.closes);
    const drawdown = maxDrawdown(state.closes);
    if (ret === null || drawdown === null) continue;
    points.push({ days: state.closes.length, drawdown, ret, symbol });
  }

  return (
    <div className="space-y-6">
      <Panel
        description="Current positions by gross market value: security type inside, symbol outside."
        headingId="watchlist-exposure-heading"
        title="Portfolio exposure"
      >
        {positions.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-sm">
            Loading positions…
          </p>
        ) : positions.type === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm">
              {positions.failure.kind === "forbidden"
                ? "Positions need operator access."
                : `Positions unavailable (${positions.failure.code}): ${positions.failure.message}`}
            </p>
            <Button
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              Retry positions
            </Button>
          </div>
        ) : (
          <PositionsSunburst
            positions={positions.positions}
            watchlistSymbols={watchlistSymbols}
          />
        )}
      </Panel>
      <Panel
        description={`One-year total return against the deepest peak-to-trough fall${totalSymbols > symbols.length ? ` · first ${symbols.length} of ${totalSymbols} symbols` : ""}.`}
        headingId="watchlist-risk-heading"
        title="Return vs max drawdown"
      >
        <div className="space-y-4">
          <BarsStatusList
            bars={bars}
            label="Daily bars for the scatter"
            symbols={symbols}
          />
          {points.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No symbol has enough daily bars yet.
            </p>
          ) : (
            <>
              <ReturnDrawdownScatter points={points} />
              <table className="text-sm">
                <caption className="sr-only">
                  Return and max drawdown by symbol
                </caption>
                <thead className="text-left text-muted-foreground text-xs">
                  <tr>
                    <th className="px-2 py-1 font-medium" scope="col">
                      Symbol
                    </th>
                    <th
                      className="px-2 py-1 text-right font-medium"
                      scope="col"
                    >
                      Return
                    </th>
                    <th
                      className="px-2 py-1 text-right font-medium"
                      scope="col"
                    >
                      Max drawdown
                    </th>
                    <th
                      className="px-2 py-1 text-right font-medium"
                      scope="col"
                    >
                      Days
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p) => (
                    <tr
                      className="border-border border-t"
                      data-symbol={p.symbol}
                      key={p.symbol}
                    >
                      <th
                        className="px-2 py-1 text-left font-medium font-mono"
                        scope="row"
                      >
                        {p.symbol}
                      </th>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">
                        {formatPercent(p.ret)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">
                        {formatPercent(p.drawdown)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">
                        {p.days}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
};
