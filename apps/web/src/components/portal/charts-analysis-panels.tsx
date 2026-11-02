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

const DASH = "—";
const cell = "py-1 pr-3";
const numCell = "py-1 pr-3 text-right font-mono";
const headCell = "py-1 pr-3 font-normal";

const formatReturn = (value: number | null, digits = 3): string => {
  return value === null || !Number.isFinite(value)
    ? DASH
    : `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
};

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
            <TableCell className={`${numCell} whitespace-normal`}>
              {formatReturn(stats.mean)}
            </TableCell>
            <TableCell className={`${numCell} whitespace-normal`}>
              {formatReturn(stats.stdev)}
            </TableCell>
            <TableCell className={`${numCell} whitespace-normal`}>
              {stats.skew === null ? DASH : stats.skew.toFixed(3)}
            </TableCell>
            <TableCell className={`${numCell} whitespace-normal`}>
              {formatReturn(stats.min)}
            </TableCell>
            <TableCell className={`${numCell} whitespace-normal`}>
              {formatReturn(stats.max)}
            </TableCell>
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
                    className="whitespace-normal text-left font-mono font-normal text-muted-foreground"
                    scope="row"
                  >
                    {formatReturn(bin.from, 2)} to {formatReturn(bin.to, 2)}
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
                    className={`${cell} whitespace-normal font-mono font-normal`}
                    scope="row"
                  >
                    {row.label}
                  </TableHead>
                  <TableCell className={`${numCell} whitespace-normal`}>
                    {row.count}
                  </TableCell>
                  <TableCell className={`${numCell} whitespace-normal`}>
                    {formatReturn(row.meanReturn)}
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
