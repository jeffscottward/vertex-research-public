"use client";

// What: "Backtest study" section of the strategy library detail for entries tagged
// quantconnect-idea. Loads the qc-port study stored under the strategy slug
// (researchStudies.get, operator-only) and shows its verdict, runs, gate effects and monthly
// equity. Read-only research: no arm, deploy or order control lives here. New studies are stored
// with `bun run vertex:research-studies:import`.
import { isQcPortStudy } from "@darkfactory/api";
import {
  Button,
  cn,
  EmptyState,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { FlaskConical, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  createBrowserResearchStudyGateway,
  getResearchStudyWithTimeout,
  RESEARCH_STUDIES_IMPORT_COMMAND,
  type ResearchStudyGateway,
} from "./filter-studies-section.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";
import {
  type QcPortStudyViewModel,
  toQcPortStudyViewModel,
} from "./strategy-backtest-study-model.ts";
import { formatSignedPercent } from "./strategy-library-model.ts";
import { lineGeometry, pnlTextClass } from "./trade-journal-model.ts";

const headCell = "px-2 py-1 text-left font-normal text-muted-foreground";
const numHead = "px-2 py-1 text-right font-normal text-muted-foreground";
const cell = "whitespace-normal px-2 py-1";
const numCell = "px-2 py-1 text-right font-mono";

/** Shown in every state of the section. */
export const NOT_APPROVAL =
  "A backtest result is not approval to trade (research only).";

const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "unauthorized" }>
  | Readonly<{ type: "not-found" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; model: QcPortStudyViewModel }>;

const EquityChart = ({ model }: { readonly model: QcPortStudyViewModel }) => {
  if (model.equity.length === 0)
    return (
      <p className="text-muted-foreground text-xs" data-chart="empty">
        {model.equitySummary}
      </p>
    );
  const { path, zeroY } = lineGeometry(model.equity, CHART_WIDTH, CHART_HEIGHT);
  // Non-empty here, so the last point exists.
  const ending = (model.equity.at(-1) as (typeof model.equity)[number]).value;
  return (
    <figure className="space-y-1" data-chart="qc-port-equity">
      <svg
        aria-label={`Monthly equity: ${formatSignedPercent(ending)} over ${model.equity.length} months`}
        className={cn("h-28 w-full", pnlTextClass(ending))}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        <line
          className="text-muted-foreground"
          data-line="start"
          stroke="currentColor"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={CHART_WIDTH}
          y1={zeroY}
          y2={zeroY}
        />
        <path
          d={path}
          data-line="equity"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        {model.equitySummary} The dashed line is the starting equity.
      </figcaption>
    </figure>
  );
};

const RUN_COLUMNS = [
  ["Run", false],
  ["Symbols", false],
  ["CAGR", true],
  ["Sharpe", true],
  ["Deflated Sharpe", true],
  ["Max DD", true],
  ["Worst month", true],
  ["Trades", true],
  ["Win rate", true],
  ["Exposure", true],
  ["Skipped", true],
] as const;

const StudyBody = ({ model }: { readonly model: QcPortStudyViewModel }) => (
  <div className="space-y-3" data-qc-port-study={model.verdict}>
    <div className="flex flex-wrap items-center gap-2">
      {/* Neutral on purpose: a PASS is a research result, never a go signal. */}
      <StatusBadge data-qc-port-verdict={model.verdict} status="neutral">
        Backtest {model.verdict}
      </StatusBadge>
      <span className="font-medium text-sm">{model.title}</span>
      <span className="text-muted-foreground text-xs">
        Ran {model.ran} · <span className="font-mono">{model.spec}</span>
      </span>
    </div>
    <p className="text-muted-foreground text-xs" data-qc-port-criteria="">
      Pre-registered pass rule (first run): {model.criteria}.
    </p>
    <p className="text-warning-foreground text-xs" data-qc-port-modeled="">
      MODELED option prices: Black-Scholes on CBOE vol-index proxies, not market
      quotes. Research only; this study places no orders.
    </p>
    <div
      aria-label="Backtest study runs"
      className="overflow-x-auto"
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
      tabIndex={0}
    >
      <Table
        className="w-full min-w-[56rem] text-xs"
        containerClassName="overflow-visible"
        data-qc-port-runs=""
      >
        <TableCaption className="sr-only">Backtest study runs</TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b">
            {RUN_COLUMNS.map(([label, numeric]) => (
              <TableHead
                className={numeric ? numHead : headCell}
                key={label}
                scope="col"
              >
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.runs.map((run) => (
            <TableRow className="border-border border-b" key={run.key}>
              <TableCell className={cell}>{run.name}</TableCell>
              <TableCell className={cell}>{run.symbols}</TableCell>
              <TableCell className={numCell}>{run.cagr}</TableCell>
              <TableCell className={numCell}>{run.sharpe}</TableCell>
              <TableCell className={numCell}>{run.deflatedSharpe}</TableCell>
              <TableCell className={numCell}>{run.maxDrawdown}</TableCell>
              <TableCell className={numCell}>{run.worstMonth}</TableCell>
              <TableCell className={numCell}>{run.trades}</TableCell>
              <TableCell className={numCell}>{run.winRate}</TableCell>
              <TableCell className={numCell}>{run.exposure}</TableCell>
              <TableCell className={numCell}>{run.skipped}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    {model.gates.length === 0 ? null : (
      <Table className="w-full text-xs" data-qc-port-gates="">
        <TableCaption className="text-left text-muted-foreground text-xs">
          Gate effect on each host strategy (before → after)
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b">
            <TableHead className={headCell} scope="col">
              Gate
            </TableHead>
            <TableHead className={headCell} scope="col">
              Host
            </TableHead>
            <TableHead className={numHead} scope="col">
              Sharpe
            </TableHead>
            <TableHead className={numHead} scope="col">
              Max DD
            </TableHead>
            <TableHead className={numHead} scope="col">
              Trades
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.gates.map((gate) => (
            <TableRow className="border-border border-b" key={gate.key}>
              <TableCell className={cell}>{gate.gate}</TableCell>
              <TableCell className={cell}>{gate.host}</TableCell>
              <TableCell className={numCell}>{gate.sharpe}</TableCell>
              <TableCell className={numCell}>{gate.maxDrawdown}</TableCell>
              <TableCell className={numCell}>{gate.trades}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )}
    <EquityChart model={model} />
    <p
      className="break-words font-mono text-muted-foreground text-xs"
      data-qc-port-provenance=""
    >
      {model.provenance}
    </p>
    {model.notes === "" ? null : (
      <p className="whitespace-pre-line text-muted-foreground text-xs">
        {model.notes}
      </p>
    )}
  </div>
);

const Pending = ({
  state,
  onRetry,
}: {
  readonly state: Exclude<State, Readonly<{ type: "ready" }>>;
  readonly onRetry: () => void;
}) => {
  if (state.type === "loading")
    return (
      <div aria-busy="true" className="space-y-2" role="status">
        <span className="sr-only">Loading backtest study</span>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (state.type === "forbidden")
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Backtest studies are limited to operators.
      </p>
    );
  if (state.type === "unauthorized")
    return (
      <p className="text-sm" role="status">
        Session expired.{" "}
        <a className="underline" href="/sign-in">
          Sign in again
        </a>
        .
      </p>
    );
  if (state.type === "not-found")
    return (
      <EmptyState
        description={
          <>
            Store one with <code>{RESEARCH_STUDIES_IMPORT_COMMAND}</code>.
          </>
        }
        headingLevel={4}
        icon={<FlaskConical />}
        title="No backtest study stored yet"
      />
    );
  return (
    <div className="space-y-2">
      <p className="text-sm" role="alert">
        Backtest study unavailable. {state.message}
      </p>
      <Button onClick={onRetry} variant="outline">
        <RotateCcw aria-hidden="true" className="size-4" />
        Retry now
      </Button>
    </div>
  );
};

export const StrategyBacktestStudy = ({
  slug,
  gateway: supplied,
}: Readonly<{
  slug: string;
  gateway?: ResearchStudyGateway | undefined;
}>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchStudyGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      const { study } = await getResearchStudyWithTimeout(gateway, slug);
      if (!isQcPortStudy(study))
        return setState({
          message: `Study ${slug} is not a qc-port backtest study.`,
          type: "error",
        });
      return setState({ model: toQcPortStudyViewModel(study), type: "ready" });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      if (failure.kind === "forbidden") return setState({ type: "forbidden" });
      if (failure.kind === "unauthorized")
        return setState({ type: "unauthorized" });
      if (failure.code === "NOT_FOUND") return setState({ type: "not-found" });
      return setState({
        message: `${failure.code}: ${failure.message}`,
        type: "error",
      });
    }
  }, [gateway, slug]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="strategy-backtest-study-heading"
      className="space-y-3 rounded-md border border-border p-3"
      data-backtest-study-state={state.type}
    >
      <h3 className="font-medium text-sm" id="strategy-backtest-study-heading">
        Backtest study
      </h3>
      <p className="font-medium text-sm" data-qc-port-not-approval="">
        {NOT_APPROVAL}
      </p>
      {state.type === "ready" ? (
        <StudyBody model={state.model} />
      ) : (
        <Pending onRetry={() => void load()} state={state} />
      )}
    </section>
  );
};
