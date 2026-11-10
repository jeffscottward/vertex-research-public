"use client";

// What: "Backtest study" section of the strategy library detail for entries tagged backtest-study,
// for example a strategy taken from a reel. Loads the strategy-backtest study stored under the
// strategy slug (researchStudies.get, operator-only) and shows its verdict, source, rules as
// stated, gaps, the runs of each form, robustness, sensitivity, comparison, equity and drawdown.
// Read-only research: no arm, deploy, paper or order control lives here. New studies are stored
// with `bun run vertex:research-studies:import`.
import {
  isStrategyBacktestStudy,
  type ResearchStudyDocument,
} from "@darkfactory/api";
import {
  cn,
  StatusBadge,
  type StatusBadgeProps,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import type { ReactNode } from "react";

import type { ResearchStudyGateway } from "./filter-studies-section.tsx";
import {
  NOT_APPROVAL,
  StudyPending,
  useResearchStudy,
} from "./strategy-backtest-study.tsx";
import { formatSignedPercent } from "./strategy-library-model.ts";
import {
  type RobustnessStatus,
  type StrategyStudyFormView,
  type StrategyStudyViewModel,
  toStrategyStudyViewModel,
} from "./strategy-reel-study-model.ts";
import {
  type JournalPoint,
  lineGeometry,
  pnlTextClass,
} from "./trade-journal-model.ts";

const headCell = "px-2 py-1 text-left font-normal text-muted-foreground";
const numHead = "px-2 py-1 text-right font-normal text-muted-foreground";
const cell = "whitespace-normal px-2 py-1";
const numCell = "px-2 py-1 text-right font-mono";

const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;

const ROBUSTNESS_BADGES: Readonly<
  Record<RobustnessStatus, Readonly<[StatusBadgeProps["status"], string]>>
> = {
  fail: ["destructive", "Fail"],
  info: ["info", "Info"],
  pass: ["success", "Pass"],
};

/**
 * A table that scrolls sideways inside its own container, so a 375 px screen never overflows.
 * The region is focusable for keyboard scrolling (axe scrollable-region-focusable).
 */
const ScrollTable = ({
  caption,
  children,
  columns,
  data,
  minWidth,
}: Readonly<{
  caption: string;
  children: ReactNode;
  columns: readonly (readonly [string, boolean])[];
  data: string;
  minWidth: string;
}>) => (
  <div
    aria-label={caption}
    className="overflow-x-auto"
    role="region"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
    tabIndex={0}
  >
    <Table
      className={cn("w-full text-xs", minWidth)}
      containerClassName="overflow-visible"
      data-strategy-study-table={data}
    >
      <TableCaption className="text-left text-muted-foreground text-xs">
        {caption}
      </TableCaption>
      <TableHeader>
        <TableRow className="border-border border-b">
          {columns.map(([label, numeric]) => (
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
      <TableBody>{children}</TableBody>
    </Table>
  </div>
);

const LineChart = ({
  data,
  label,
  points,
  summary,
}: Readonly<{
  data: string;
  label: string;
  points: readonly JournalPoint[];
  summary: string;
}>) => {
  const { path, zeroY } = lineGeometry(points, CHART_WIDTH, CHART_HEIGHT);
  // The schema keeps at least two equity points, so the last one exists.
  const ending = (points.at(-1) as JournalPoint).value;
  return (
    <figure className="space-y-1" data-chart={data}>
      <svg
        aria-label={`${label}: ${formatSignedPercent(ending)} at the end of ${points.length} months`}
        className={cn("h-28 w-full", pnlTextClass(ending))}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        <line
          className="text-muted-foreground"
          data-line="zero"
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
          data-line={data}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        {summary} The dashed line is 0.
      </figcaption>
    </figure>
  );
};

const RUN_COLUMNS = [
  ["Symbol", false],
  ["Market", false],
  ["Period", false],
  ["Trades", true],
  ["CAGR", true],
  ["Sharpe", true],
  ["Max DD", true],
  ["PF", true],
  ["Win rate", true],
  ["Exposure", true],
  ["OOS Sharpe", true],
  ["OOS CAGR", true],
  ["B&H CAGR", true],
  ["B&H Sharpe", true],
] as const;

const FormRuns = ({ form }: { readonly form: StrategyStudyFormView }) => (
  <div className="space-y-1" data-strategy-study-form={form.key}>
    <h4 className="font-medium text-sm">{form.label}</h4>
    <p className="text-muted-foreground text-xs">{form.description}</p>
    <ScrollTable
      caption={`${form.label}: runs`}
      columns={RUN_COLUMNS}
      data={`runs-${form.key}`}
      minWidth="min-w-[64rem]"
    >
      {form.runs.map((run) => (
        <TableRow className="border-border border-b" key={run.key}>
          <TableCell className={cell}>{run.symbol}</TableCell>
          <TableCell className={cell}>{run.market}</TableCell>
          <TableCell className="whitespace-nowrap px-2 py-1 font-mono">
            {run.period}
          </TableCell>
          <TableCell className={numCell}>{run.trades}</TableCell>
          <TableCell className={numCell}>{run.cagr}</TableCell>
          <TableCell className={numCell}>{run.sharpe}</TableCell>
          <TableCell className={numCell}>{run.maxDrawdown}</TableCell>
          <TableCell className={numCell}>{run.profitFactor}</TableCell>
          <TableCell className={numCell}>{run.winRate}</TableCell>
          <TableCell className={numCell}>{run.exposure}</TableCell>
          <TableCell className={numCell}>{run.oosSharpe}</TableCell>
          <TableCell className={numCell}>{run.oosCagr}</TableCell>
          <TableCell className={numCell}>{run.buyHoldCagr}</TableCell>
          <TableCell className={numCell}>{run.buyHoldSharpe}</TableCell>
        </TableRow>
      ))}
    </ScrollTable>
  </div>
);

const StudyBody = ({ model }: { readonly model: StrategyStudyViewModel }) => (
  <div className="space-y-3" data-strategy-study={model.verdict}>
    <div className="flex flex-wrap items-center gap-2">
      {/* Neutral on purpose: an "edge" verdict is a research result, never a go signal. */}
      <StatusBadge data-strategy-study-verdict={model.verdict} status="neutral">
        {model.verdictLabel}
      </StatusBadge>
      <span className="font-medium text-sm">{model.title}</span>
      <span className="text-muted-foreground text-xs">
        Ran {model.ran} ·{" "}
        <span className="break-all font-mono">{model.spec}</span>
      </span>
    </div>
    <p className="text-sm" data-strategy-study-reason="">
      {model.verdictReason}
    </p>
    <p className="text-muted-foreground text-xs">
      Source:{" "}
      <a
        className="break-all underline"
        data-strategy-study-source=""
        href={model.source.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {model.source.label}
      </a>{" "}
      (untrusted; the rules below are as stated there).
    </p>
    <ScrollTable
      caption="Rules as stated"
      columns={[
        ["Item", false],
        ["Rule", false],
        ["Source", false],
      ]}
      data="rules"
      minWidth="min-w-[36rem]"
    >
      {model.rules.map((row) => (
        <TableRow className="border-border border-b" key={row.key}>
          <TableCell className={cell}>{row.item}</TableCell>
          <TableCell className={cell}>{row.rule}</TableCell>
          <TableCell className={cn(cell, "font-mono")}>{row.source}</TableCell>
        </TableRow>
      ))}
    </ScrollTable>
    {model.gaps.length === 0 ? (
      <p className="text-muted-foreground text-xs" data-strategy-study-gaps="">
        No gaps recorded: every rule was stated.
      </p>
    ) : (
      <ScrollTable
        caption="Gaps and the defaults chosen"
        columns={[
          ["Gap", false],
          ["Default chosen", false],
        ]}
        data="gaps"
        minWidth="min-w-[32rem]"
      >
        {model.gaps.map((row) => (
          <TableRow className="border-border border-b" key={row.key}>
            <TableCell className={cell}>{row.gap}</TableCell>
            <TableCell className={cell}>{row.choice}</TableCell>
          </TableRow>
        ))}
      </ScrollTable>
    )}
    {model.forms.map((form) => (
      <FormRuns form={form} key={form.key} />
    ))}
    {model.robustness.length === 0 ? null : (
      <ScrollTable
        caption="Robustness"
        columns={[
          ["Check", false],
          ["Result", false],
          ["Status", false],
        ]}
        data="robustness"
        minWidth="min-w-[32rem]"
      >
        {model.robustness.map((row) => {
          const [status, label] = ROBUSTNESS_BADGES[row.status];
          return (
            <TableRow className="border-border border-b" key={row.key}>
              <TableCell className={cell}>{row.check}</TableCell>
              <TableCell className={cell}>{row.result}</TableCell>
              <TableCell className={cell}>
                <StatusBadge
                  data-strategy-study-robustness={row.status}
                  status={status}
                >
                  {label}
                </StatusBadge>
              </TableCell>
            </TableRow>
          );
        })}
      </ScrollTable>
    )}
    {model.sensitivity.length === 0 ? null : (
      <ScrollTable
        caption="Parameter sensitivity"
        columns={[
          ["Parameter", false],
          ["Value", true],
          ["Sharpe", true],
          ["CAGR", true],
          ["Max DD", true],
          ["Trades", true],
        ]}
        data="sensitivity"
        minWidth="min-w-[36rem]"
      >
        {model.sensitivity.map((row) => (
          <TableRow className="border-border border-b" key={row.key}>
            <TableCell className={cell}>{row.param}</TableCell>
            <TableCell className={numCell}>{row.value}</TableCell>
            <TableCell className={numCell}>{row.sharpe}</TableCell>
            <TableCell className={numCell}>{row.cagr}</TableCell>
            <TableCell className={numCell}>{row.maxDrawdown}</TableCell>
            <TableCell className={numCell}>{row.trades}</TableCell>
          </TableRow>
        ))}
      </ScrollTable>
    )}
    {model.comparison.length === 0 ? null : (
      <ScrollTable
        caption="Comparison"
        columns={[
          ["Name", false],
          ["Kind", false],
          ["Sharpe", true],
          ["CAGR", true],
          ["Max DD", true],
        ]}
        data="comparison"
        minWidth="min-w-[32rem]"
      >
        {model.comparison.map((row) => (
          <TableRow className="border-border border-b" key={row.key}>
            <TableCell className={cell}>{row.name}</TableCell>
            <TableCell className={cell}>{row.kind}</TableCell>
            <TableCell className={numCell}>{row.sharpe}</TableCell>
            <TableCell className={numCell}>{row.cagr}</TableCell>
            <TableCell className={numCell}>{row.maxDrawdown}</TableCell>
          </TableRow>
        ))}
      </ScrollTable>
    )}
    <p className="text-muted-foreground text-xs" data-strategy-study-equity="">
      {model.equityLabel}
    </p>
    <LineChart
      data="strategy-study-equity"
      label="Monthly equity"
      points={model.equity}
      summary={model.equitySummary}
    />
    <LineChart
      data="strategy-study-drawdown"
      label="Drawdown"
      points={model.drawdown}
      summary={model.drawdownSummary}
    />
    <p
      className="break-words font-mono text-muted-foreground text-xs"
      data-strategy-study-provenance=""
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

const strategyStudyModel = (study: ResearchStudyDocument) =>
  isStrategyBacktestStudy(study) ? toStrategyStudyViewModel(study) : null;

export const StrategyReelStudy = ({
  slug,
  gateway,
}: Readonly<{
  slug: string;
  gateway?: ResearchStudyGateway | undefined;
}>) => {
  const { load, state } = useResearchStudy(
    slug,
    gateway,
    "strategy-backtest",
    strategyStudyModel
  );
  return (
    <section
      aria-labelledby="strategy-reel-study-heading"
      className="min-w-0 space-y-3 rounded-md border border-border p-3"
      data-backtest-study-state={state.type}
      data-strategy-study-section=""
    >
      <h3 className="font-medium text-sm" id="strategy-reel-study-heading">
        Backtest study
      </h3>
      <p className="font-medium text-sm" data-strategy-study-not-approval="">
        {NOT_APPROVAL}
      </p>
      {state.type === "ready" ? (
        <StudyBody model={state.model} />
      ) : (
        <StudyPending onRetry={() => void load()} state={state} />
      )}
    </section>
  );
};
