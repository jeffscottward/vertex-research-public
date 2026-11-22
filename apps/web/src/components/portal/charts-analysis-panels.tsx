import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import type {
  HistogramBin,
  ReturnStats,
  SessionRow,
} from "../../features/charts/bar-analysis.ts";

const cell = "py-1 pr-3";
const numCell = "py-1 pr-3 text-right font-mono";
const headCell = "py-1 pr-3 font-normal";

/** Cell text of a number that is not finite (a bin edge, a session mean or a statistic). */
const NOT_FINITE = "not finite";

// `reason` is the cell text for a number that is not finite: a cell never shows a dash. A null
// statistic does not come here; StatCell names its cause.
const formatReturn = (value: number, digits: number, reason: string): string =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`
    : reason;

type MissingStat = Readonly<{ text: string; title: string }>;

const returnsInRange = (count: number) =>
  `${count} ${count === 1 ? "return" : "returns"} in range`;

/**
 * Why a statistic of the returns table has no value. `minimum` is the number of returns the
 * statistic needs. With enough returns, a null skew has one cause (zero variance: the stdev
 * is 0). Any other statistic that is null with enough returns has no cause in scope, so its
 * text states only that: the count and that the value was not computed.
 */
const missingStat = (
  count: number,
  statistic: string,
  minimum: 1 | 2 | 3
): MissingStat => {
  if (count >= minimum) {
    return minimum === 3
      ? { text: "zero variance", title: `all ${count} returns are equal` }
      : {
          text: "not computed",
          title: `${returnsInRange(count)}; ${statistic} was not computed`,
        };
  }
  return {
    text: minimum === 1 ? "no returns" : "too few bars",
    title: `${returnsInRange(count)}; ${statistic} needs at least ${minimum}`,
  };
};

const StatCell = ({
  count,
  format,
  minimum,
  statistic,
  value,
}: {
  readonly count: number;
  readonly format: (value: number) => string;
  readonly minimum: 1 | 2 | 3;
  readonly statistic: string;
  readonly value: number | null;
}) => {
  if (value !== null) {
    return (
      <TableCell className={`${numCell} whitespace-normal`}>
        {format(value)}
      </TableCell>
    );
  }
  const missing = missingStat(count, statistic, minimum);
  return (
    <TableCell className={`${numCell} whitespace-normal`} title={missing.title}>
      {missing.text}
    </TableCell>
  );
};

const formatStatReturn = (value: number): string =>
  formatReturn(value, 3, NOT_FINITE);

const formatShare = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const ReturnStatsTable = ({
  stats,
}: {
  readonly stats: ReturnStats;
}) => (
  <section
    aria-labelledby="charts-stats-heading"
    className="space-y-1"
    data-return-stats
  >
    <h3 className="font-medium text-sm" id="charts-stats-heading">
      Close-to-close returns
    </h3>
    <div className="overflow-x-auto">
      <Table className="w-full text-xs">
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground">
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Count
            </TableHead>
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Mean
            </TableHead>
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Stdev (sample)
            </TableHead>
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Skew
            </TableHead>
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Min
            </TableHead>
            <TableHead
              className={`${headCell} text-right text-muted-foreground`}
              scope="col"
            >
              Max
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="border-border border-b">
            <TableCell className={`${numCell} whitespace-normal`}>
              {stats.count}
            </TableCell>
            <StatCell
              count={stats.count}
              format={formatStatReturn}
              minimum={1}
              statistic="mean"
              value={stats.mean}
            />
            <StatCell
              count={stats.count}
              format={formatStatReturn}
              minimum={2}
              statistic="stdev"
              value={stats.stdev}
            />
            <StatCell
              count={stats.count}
              format={(value) =>
                Number.isFinite(value) ? value.toFixed(3) : NOT_FINITE
              }
              minimum={3}
              statistic="skew"
              value={stats.skew}
            />
            <StatCell
              count={stats.count}
              format={formatStatReturn}
              minimum={1}
              statistic="min"
              value={stats.min}
            />
            <StatCell
              count={stats.count}
              format={formatStatReturn}
              minimum={1}
              statistic="max"
              value={stats.max}
            />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </section>
);

export const ReturnHistogram = ({
  bins,
}: {
  readonly bins: readonly HistogramBin[];
}) => {
  const peak = bins.reduce((most, bin) => Math.max(most, bin.count), 1);
  return (
    <section
      aria-labelledby="charts-histogram-heading"
      className="space-y-1"
      data-return-histogram
    >
      <h3 className="font-medium text-sm" id="charts-histogram-heading">
        Return distribution
      </h3>
      {bins.length === 0 ? (
        <p className="text-muted-foreground text-xs">No returns.</p>
      ) : (
        <Table className="w-full text-xs">
          <TableCaption className="sr-only">
            Return distribution: range and count per bin
          </TableCaption>
          <TableHeader className="sr-only">
            <TableRow>
              <TableHead scope="col">Range</TableHead>
              <TableHead scope="col">Share of maximum bin</TableHead>
              <TableHead scope="col">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bins.map((bin, index) => {
              return (
                <TableRow
                  className="grid grid-cols-[11rem_1fr_3rem] items-center gap-2"
                  key={index}
                >
                  <TableHead
                    className="h-auto whitespace-normal text-left font-mono font-normal text-muted-foreground"
                    scope="row"
                  >
                    {formatReturn(bin.from, 2, NOT_FINITE)} to{" "}
                    {formatReturn(bin.to, 2, NOT_FINITE)}
                  </TableHead>
                  <TableCell className="whitespace-normal">
                    <span
                      aria-hidden="true"
                      className="block h-3 rounded-sm bg-primary/70"
                      style={{ width: `${(bin.count / peak) * 100}%` }}
                    />
                  </TableCell>
                  <TableCell className="whitespace-normal text-right font-mono">
                    {bin.count}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
};

export const SessionTable = ({
  rows,
  title,
  keyLabel,
  kind,
}: {
  readonly rows: readonly SessionRow[];
  readonly title: string;
  readonly keyLabel: string;
  readonly kind: "weekday" | "hour";
}) => (
  <section
    aria-label={title}
    className="space-y-1"
    data-hour-stats={kind === "hour" ? "" : undefined}
    data-weekday-stats={kind === "weekday" ? "" : undefined}
  >
    <h3 className="font-medium text-sm">{title}</h3>
    {rows.length === 0 ? (
      <p className="text-muted-foreground text-xs">No returns.</p>
    ) : (
      <div className="overflow-x-auto">
        <Table className="w-full text-xs">
          <TableHeader>
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead
                className={`${headCell} text-muted-foreground`}
                scope="col"
              >
                {keyLabel}
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Count
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Mean return
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Positive
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              return (
                <TableRow className="border-border border-b" key={row.key}>
                  <TableHead
                    className={`h-auto ${cell} whitespace-normal font-mono font-normal`}
                    scope="row"
                  >
                    {row.label}
                  </TableHead>
                  <TableCell className={`${numCell} whitespace-normal`}>
                    {row.count}
                  </TableCell>
                  <TableCell className={`${numCell} whitespace-normal`}>
                    {formatReturn(row.meanReturn, 3, NOT_FINITE)}
                  </TableCell>
                  <TableCell className={`${numCell} whitespace-normal`}>
                    {formatShare(row.positiveShare)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    )}
  </section>
);
