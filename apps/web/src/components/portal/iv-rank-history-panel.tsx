"use client";

import {
  OPENBB_IV_HISTORY_HORIZONS,
  type OpenbbIvHistoryHorizon,
  type OpenbbIvHistoryOutput,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  type PanelHeadingLevel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { useEffect, useId, useRef, useState } from "react";

import {
  createBrowserOpenbbGateway,
  type IvHistoryGateway,
  OPENBB_REQUEST_TIMEOUT_MS,
} from "../../features/openbb/gateway.ts";
import {
  basisBadgeText,
  basisCaveatText,
  buildIvHistoryTableRows,
  buildIvRankChart,
  classifyIvRegime,
  formatIvScore,
  formatIvValue,
  IV_CHART_HEIGHT,
  IV_CHART_WIDTH,
  IV_HISTORY_HORIZON_LABELS,
  ivHistoryAriaLabel,
} from "./iv-rank-history-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";
import { localClock } from "./portfolio-monitor-model.ts";

// O20 IV rank / percentile history chart panel (openbb.ivHistory).
// Mounted on /stock/[symbol]?tab=analytics, /charts, and /markets.
// Research view only: describes historical implied-volatility standing, never a trade signal.

export interface IvRankHistoryPanelProps {
  readonly className?: string;
  readonly gateway?: IvHistoryGateway | undefined;
  readonly headingLevel?: PanelHeadingLevel;
  readonly onSymbolChange?: (symbol: string) => void;
  readonly symbol: string;
  readonly symbols?: readonly string[];
}

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "no-answer"; startedAt: number }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: OpenbbIvHistoryOutput }>;

const REGIME_TONE = {
  high: "border-destructive/40 bg-destructive/10 text-destructive",
  low: "border-success/40 bg-success/10 text-success",
  mid: "border-border bg-muted text-foreground",
} as const;

const LegendBar = () => (
  <ul
    aria-label="Chart legend"
    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs"
  >
    <li className="flex items-center gap-1.5">
      <svg
        aria-hidden="true"
        className="shrink-0"
        height="12"
        viewBox="0 0 24 12"
        width="24"
      >
        <line
          stroke="var(--color-primary)"
          strokeWidth="2"
          x1="0"
          x2="24"
          y1="6"
          y2="6"
        />
      </svg>
      <span>IV Rank</span>
    </li>
    <li className="flex items-center gap-1.5">
      <svg
        aria-hidden="true"
        className="shrink-0"
        height="12"
        viewBox="0 0 24 12"
        width="24"
      >
        <line
          stroke="var(--color-info)"
          strokeDasharray="6 3"
          strokeWidth="1.75"
          x1="0"
          x2="24"
          y1="6"
          y2="6"
        />
      </svg>
      <span>IV Percentile</span>
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-5 rounded-sm border border-destructive/40 bg-destructive/15"
      />
      <span>High IV (≥ 80)</span>
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-5 rounded-sm border border-success/40 bg-success/15"
      />
      <span>Low IV (≤ 20)</span>
    </li>
  </ul>
);

const IvHistoryChart = ({
  data,
  showPercentile,
  showRank,
}: Readonly<{
  data: OpenbbIvHistoryOutput;
  showPercentile: boolean;
  showRank: boolean;
}>) => {
  const chart = buildIvRankChart(data);
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-border bg-background/60 p-2">
        <svg
          aria-label={ivHistoryAriaLabel(data)}
          className="block h-auto w-full"
          data-iv-history-chart=""
          role="img"
          viewBox={`0 0 ${IV_CHART_WIDTH} ${IV_CHART_HEIGHT}`}
        >
          <rect
            data-iv-band="high"
            fill="var(--color-destructive)"
            fillOpacity={0.12}
            height={chart.highBand.height}
            width={chart.plotWidth}
            x={chart.plotLeft}
            y={chart.highBand.y}
          />
          <rect
            data-iv-band="low"
            fill="var(--color-success)"
            fillOpacity={0.12}
            height={chart.lowBand.height}
            width={chart.plotWidth}
            x={chart.plotLeft}
            y={chart.lowBand.y}
          />
          {chart.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                stroke="currentColor"
                strokeDasharray={tick.value === 50 ? "4 4" : undefined}
                strokeOpacity={tick.value === 50 ? 0.35 : 0.14}
                strokeWidth={1}
                x1={chart.plotLeft}
                x2={chart.plotRight}
                y1={tick.y}
                y2={tick.y}
              />
              <text
                className="fill-muted-foreground font-mono text-[11px]"
                dominantBaseline="middle"
                textAnchor="end"
                x={chart.plotLeft - 8}
                y={tick.y}
              >
                {tick.label}
              </text>
            </g>
          ))}
          <text
            className="fill-destructive font-medium text-[11px]"
            textAnchor="end"
            x={chart.plotRight - 6}
            y={chart.highBand.y + 13}
          >
            High IV ≥ 80
          </text>
          <text
            className="fill-success font-medium text-[11px]"
            textAnchor="end"
            x={chart.plotRight - 6}
            y={chart.lowBand.y + chart.lowBand.height - 5}
          >
            Low IV ≤ 20
          </text>
          {showPercentile && chart.percentilePolyline !== "" ? (
            <polyline
              data-series="iv-percentile"
              fill="none"
              points={chart.percentilePolyline}
              stroke="var(--color-info)"
              strokeDasharray="6 3"
              strokeWidth={1.75}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {showPercentile && chart.latestPercentileDot !== null ? (
            <circle
              cx={chart.latestPercentileDot.x}
              cy={chart.latestPercentileDot.y}
              data-dot="iv-percentile-latest"
              fill="var(--color-info)"
              r={3.5}
            />
          ) : null}
          {showRank
            ? chart.rankSegments.map((pointsAttr, index) => (
                <polyline
                  data-series="iv-rank"
                  fill="none"
                  key={`${index}-${pointsAttr.slice(0, 12)}`}
                  points={pointsAttr}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ))
            : null}
          {showRank
            ? chart.rankIsolatedDots.map((dot) => (
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  data-dot="iv-rank-isolated"
                  fill="var(--color-primary)"
                  key={dot.date}
                  r={3.5}
                />
              ))
            : null}
          {showRank && chart.latestRankDot !== null ? (
            <circle
              cx={chart.latestRankDot.x}
              cy={chart.latestRankDot.y}
              data-dot="iv-rank-latest"
              fill="var(--color-primary)"
              r={4}
            />
          ) : null}
          {chart.xTicks.map((tick, index) => {
            const anchor =
              chart.xTicks.length === 1
                ? "middle"
                : index === 0
                  ? "start"
                  : index === chart.xTicks.length - 1
                    ? "end"
                    : "middle";
            return (
              <text
                className="fill-muted-foreground font-mono text-[11px]"
                key={`${tick.x}-${tick.label}`}
                textAnchor={anchor}
                x={tick.x}
                y={IV_CHART_HEIGHT - 8}
              >
                {tick.label}
              </text>
            );
          })}
        </svg>
      </div>
      {chart.partialNotice === null ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-iv-partial-notice=""
          role="status"
        >
          {chart.partialNotice}
        </p>
      )}
      {chart.singlePointNote === null ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-iv-single-point=""
          role="status"
        >
          {chart.singlePointNote}
        </p>
      )}
    </div>
  );
};

const IvHistoryReadyBody = ({
  data,
  showPercentile,
  showRank,
}: Readonly<{
  data: OpenbbIvHistoryOutput;
  showPercentile: boolean;
  showRank: boolean;
}>) => {
  if (data.basis === null || data.points.length === 0 || data.latest === null) {
    return (
      <div
        className="space-y-2 rounded-md border border-border bg-muted/30 p-4 text-sm"
        data-iv-history-state="unavailable"
        role="status"
      >
        <p className="font-medium text-foreground">
          No 1-year IV rank / percentile history for {data.symbol}
        </p>
        {data.reason === null ? null : (
          <p className="text-muted-foreground text-xs">{data.reason}</p>
        )}
        <p className="font-mono text-muted-foreground text-xs">
          {data.own.sessions} / {data.own.minSessions} own ATM IV sessions
          stored
        </p>
        <p className="text-muted-foreground text-xs">
          Research view only · no orders or trade signals.
        </p>
      </div>
    );
  }

  const regime = classifyIvRegime(data.latest);
  const caveat = basisCaveatText(data);
  const rows = buildIvHistoryTableRows(data);

  return (
    <div className="space-y-4" data-iv-history-state="ready">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className="inline-flex items-center rounded-full border border-border bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground"
          data-iv-basis={data.basis}
        >
          {basisBadgeText(data)}
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-medium ${REGIME_TONE[regime.kind]}`}
          data-iv-regime={regime.kind}
        >
          {regime.label}
        </span>
        <span className="font-mono text-muted-foreground">
          As of {data.latest.date}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-border/70 p-2.5">
          <dt className="text-muted-foreground text-xs">IV Rank (1y)</dt>
          <dd
            className="font-mono font-semibold text-base tabular-nums"
            data-iv-kpi="rank"
          >
            {formatIvScore(data.latest.ivRank)}
          </dd>
        </div>
        <div className="rounded-md border border-border/70 p-2.5">
          <dt className="text-muted-foreground text-xs">IV Percentile (1y)</dt>
          <dd
            className="font-mono font-semibold text-base tabular-nums"
            data-iv-kpi="percentile"
          >
            {formatIvScore(data.latest.ivPercentile)}
          </dd>
        </div>
        <div className="rounded-md border border-border/70 p-2.5">
          <dt className="text-muted-foreground text-xs">
            Latest IV ({data.unit === "decimal" ? "30d ATM" : data.proxyIndex})
          </dt>
          <dd
            className="font-mono font-semibold text-base tabular-nums"
            data-iv-kpi="latest-iv"
          >
            {formatIvValue(data.latest.iv, data.unit)}
          </dd>
        </div>
        <div className="rounded-md border border-border/70 p-2.5">
          <dt className="text-muted-foreground text-xs">52w IV range</dt>
          <dd
            className="font-mono font-semibold text-sm tabular-nums"
            data-iv-kpi="range-52w"
          >
            {`${formatIvValue(data.latest.low52w, data.unit)} to ${formatIvValue(data.latest.high52w, data.unit)}`}
          </dd>
        </div>
      </dl>

      <LegendBar />

      <IvHistoryChart
        data={data}
        showPercentile={showPercentile}
        showRank={showRank}
      />

      <p className="text-muted-foreground text-xs" data-iv-caveat="">
        {caveat === null ? "" : `${caveat} `}Research view only, not a trade
        signal.
      </p>

      <details className="rounded-md border border-border/70 px-3 py-1">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-sm">
          Recent sessions and horizon extremes ({rows.length})
        </summary>
        <div className="pt-2 pb-3">
          <TableScroll label={`${data.symbol} IV rank history`}>
            <Table className="min-w-[34rem] text-xs" data-iv-history-table="">
              <TableCaption>
                Newest sessions and horizon extremes for {data.symbol}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Date</TableHead>
                  <TableHead className="text-right" scope="col">
                    IV
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    IV Rank
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    IV Pctl
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    52w Range
                  </TableHead>
                  <TableHead scope="col">Milestone</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.date}>
                    <TableCell className="font-mono">{row.date}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.ivText}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.ivRankText}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.ivPercentileText}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.range52wText}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.note}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </div>
      </details>
    </div>
  );
};

export const IvRankHistoryPanel = ({
  className,
  gateway: suppliedGateway,
  headingLevel = 2,
  onSymbolChange,
  symbol,
  symbols,
}: IvRankHistoryPanelProps) => {
  const headingId = useId();
  const horizonGroupId = useId();
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserOpenbbGateway()
  );
  const [horizon, setHorizon] = useState<OpenbbIvHistoryHorizon>(252);
  const [showRank, setShowRank] = useState(true);
  const [showPercentile, setShowPercentile] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    const startedAt = Date.now();
    setState({ type: "loading" });
    const timer = setTimeout(() => {
      setState({ startedAt, type: "no-answer" });
    }, OPENBB_REQUEST_TIMEOUT_MS);

    gateway
      .ivHistory(symbol, horizon)
      .then((data) => {
        clearTimeout(timer);
        if (mine === generation.current) setState({ data, type: "ready" });
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        if (mine === generation.current) {
          setState({
            message: describePortfolioMonitorFailure(error).message,
            type: "error",
          });
        }
      });

    return () => {
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [attempt, gateway, horizon, symbol]);

  const toggleRank = () => setShowRank((prev) => !prev);
  const togglePercentile = () => setShowPercentile((prev) => !prev);

  return (
    <Panel
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="inline-flex flex-wrap items-center gap-1 rounded-md border border-border p-0.5">
            <legend className="sr-only">History horizon</legend>
            {OPENBB_IV_HISTORY_HORIZONS.map((option) => (
              <label
                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded px-2.5 font-medium text-xs has-[:checked]:bg-secondary has-[:checked]:text-secondary-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                key={option}
              >
                <input
                  checked={horizon === option}
                  className="sr-only"
                  name={horizonGroupId}
                  onChange={() => setHorizon(option)}
                  type="radio"
                  value={option}
                />
                {IV_HISTORY_HORIZON_LABELS[option]}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              aria-pressed={showRank}
              className="min-h-11"
              disabled={showRank && !showPercentile}
              onClick={toggleRank}
              size="sm"
              type="button"
              variant={showRank ? "secondary" : "outline"}
            >
              IV Rank
            </Button>
            <Button
              aria-pressed={showPercentile}
              className="min-h-11"
              disabled={showPercentile && !showRank}
              onClick={togglePercentile}
              size="sm"
              type="button"
              variant={showPercentile ? "secondary" : "outline"}
            >
              IV Percentile
            </Button>
          </div>
        </div>
      }
      className={className}
      data-iv-history={symbol}
      description="Rolling 252-session IV rank and IV percentile standing · research only"
      headingId={headingId}
      headingLevel={headingLevel}
      title={`IV rank / percentile history · ${symbol}`}
    >
      <div className="space-y-4">
        {symbols !== undefined && onSymbolChange !== undefined ? (
          <div
            aria-label="Core 7 ticker selector"
            className="flex flex-wrap items-center gap-1.5"
            role="group"
          >
            {symbols.map((ticker) => (
              <Button
                aria-pressed={ticker === symbol}
                className="min-h-11 min-w-11 font-mono text-xs"
                key={ticker}
                onClick={() => onSymbolChange(ticker)}
                size="sm"
                type="button"
                variant={ticker === symbol ? "secondary" : "outline"}
              >
                {ticker}
              </Button>
            ))}
          </div>
        ) : null}

        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="min-h-56 text-muted-foreground text-sm"
            data-iv-history-state="loading"
          >
            Loading {symbol} IV rank history…
          </p>
        ) : state.type === "no-answer" ? (
          <div
            className="space-y-2"
            data-iv-history-no-answer=""
            data-iv-history-state="no-answer"
            role="alert"
          >
            <p className="text-sm">
              IV history requested at {localClock(new Date(state.startedAt))} ·
              no answer after {OPENBB_REQUEST_TIMEOUT_MS / 1000} s
            </p>
            <Button
              className="min-h-11"
              onClick={() => setAttempt((count) => count + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : state.type === "error" ? (
          <div
            className="space-y-2"
            data-iv-history-error=""
            data-iv-history-state="error"
            role="alert"
          >
            <p className="text-sm">
              IV history failed to load. {state.message}
            </p>
            <Button
              className="min-h-11"
              onClick={() => setAttempt((count) => count + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : (
          <IvHistoryReadyBody
            data={state.data}
            showPercentile={showPercentile}
            showRank={showRank}
          />
        )}
      </div>
    </Panel>
  );
};
