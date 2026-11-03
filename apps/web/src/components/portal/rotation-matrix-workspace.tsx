"use client";

import {
  ROTATION_CAPS,
  ROTATION_PERIODS,
  type RotationCap,
  type RotationIndustry,
  type RotationMatrixOutput,
  type RotationPeriod,
} from "@darkfactory/api";
import {
  Button,
  Input,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import {
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TickerLink } from "../ticker-link.tsx";

import { writeQuery } from "./backtest-lab-query.ts";
import {
  createBrowserResearchLensesGateway,
  describeResearchLensFailure,
  type ResearchLensesGateway,
} from "./research-lenses-client.ts";
import {
  DEFAULT_PERIOD,
  type RotationMatrixSettings,
  URL_DEFAULTS,
} from "./rotation-matrix-params.ts";

// Rotation matrix (port of the vertex-research ?view=rotation lens): sector -> industry -> cap bucket
// median returns for 1D/1M/3M/6M, standouts and our names in leading/lagging industries. Read only.

// Color scale limit per period, in percent: a cell at +/- the limit gets full color.
const HEAT_SCALE: Readonly<Record<RotationPeriod, number>> = {
  "1D": 3,
  "1M": 10,
  "3M": 20,
  "6M": 30,
};

/** Green for gains, red for losses; opacity grows with the size of the move. */
export const heatColor = (
  ret: number | null | undefined,
  period: RotationPeriod
): string => {
  if (typeof ret !== "number" || !Number.isFinite(ret)) return "transparent";
  const t = Math.max(-1, Math.min(1, ret / HEAT_SCALE[period]));
  const alpha = (0.15 + Math.abs(t) * 0.7).toFixed(2);
  return t >= 0 ? `rgba(22, 163, 74, ${alpha})` : `rgba(220, 38, 38, ${alpha})`;
};

export const formatReturn = (value: number | null | undefined): string => {
  if (typeof value !== "number") return "–";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
};

const formatCap = (value: number | null): string => {
  if (value === null) return "";
  return value >= 1e9
    ? `$${(value / 1e9).toFixed(1)}B`
    : `$${(value / 1e6).toFixed(0)}M`;
};

type Selection = Readonly<{
  industry: RotationIndustry;
  cap: RotationCap | "all";
}>;

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; matrix: RotationMatrixOutput }>;

const CellDetail = ({
  selection,
  period,
  onClose,
}: {
  readonly selection: Selection;
  readonly period: RotationPeriod;
  readonly onClose: () => void;
}) => {
  const { industry, cap } = selection;
  const cell = cap === "all" ? undefined : industry.cells[cap];
  const stats = cell ?? industry;
  const symbols =
    cell?.symbols ??
    ROTATION_CAPS.flatMap((key) => industry.cells[key]?.symbols ?? []).sort(
      (a, b) => (b.ret ?? 0) - (a.ret ?? 0)
    );
  const rank =
    industry.rank === undefined
      ? ""
      : ` Industry rank ${industry.rank} (quintile ${industry.quintile}).`;
  return (
    <Panel
      actions={
        <Button onClick={onClose} size="sm" variant="secondary">
          Close
        </Button>
      }
      aria-label="Selected cell"
      contentClassName="space-y-2"
      title={`${industry.industry} · ${cap === "all" ? "All caps" : cap} · ${period}`}
    >
      <p className="text-muted-foreground text-sm">
        {industry.sector}. Median {formatReturn(stats.retMedian)}, cap-weighted{" "}
        {formatReturn(stats.retCapWeighted)}, {stats.breadth ?? "–"}% of{" "}
        {stats.n} names up.{rank}
      </p>
      <ul className="flex flex-wrap gap-2 text-xs">
        {symbols.map((entry) => (
          <li
            className="rounded px-2 py-1"
            key={entry.symbol}
            style={{ background: heatColor(entry.ret, period) }}
          >
            <TickerLink symbol={entry.symbol} /> {formatReturn(entry.ret)}{" "}
            <span className="text-muted-foreground">
              {formatCap(entry.marketCap)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
};

const RankedList = ({
  title,
  rows,
  tone,
}: {
  readonly title: string;
  readonly rows: RotationMatrixOutput["top"];
  readonly tone: string;
}) => (
  <div className="space-y-1">
    <h3 className="font-medium text-sm">{title}</h3>
    <ol className="list-decimal space-y-0.5 pl-5 text-sm">
      {rows.map((entry) => (
        <li key={`${entry.sector}|${entry.industry}`}>
          {entry.industry}{" "}
          <b className={tone}>{formatReturn(entry.retMedian)}</b>{" "}
          <span className="text-muted-foreground text-xs">n={entry.n}</span>
        </li>
      ))}
    </ol>
  </div>
);

const OurNames = ({ matrix }: { readonly matrix: RotationMatrixOutput }) => {
  const opportunities = matrix.ours.filter((name) => name.opportunity === true);
  const covered = matrix.ours.filter((name) => name.covered);
  return (
    <div className="space-y-1">
      <h3 className="font-medium text-sm">Our names</h3>
      <p className="text-sm">
        {opportunities.length === 0 ? (
          "No wish-list or re-entry name is a leader inside a top-quintile industry on both 1M and 3M."
        ) : (
          <>
            Leaders in leading industries (1M and 3M top quintile):{" "}
            {opportunities.map((name, index) => (
              <span key={name.symbol}>
                {index === 0 ? "" : ", "}
                <TickerLink symbol={name.symbol} />
              </span>
            ))}
          </>
        )}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          {covered.length} tracked names by cell
        </summary>
        <TableScroll
          className="mt-2"
          label="Our names by rotation cell"
          minWidth="24rem"
        >
          <Table className="w-full text-xs">
            <TableCaption className="sr-only">
              Our names by rotation cell
            </TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground">
                <TableHead className="text-muted-foreground" scope="col">
                  Symbol
                </TableHead>
                <TableHead className="text-muted-foreground" scope="col">
                  Role
                </TableHead>
                <TableHead className="text-muted-foreground" scope="col">
                  Industry
                </TableHead>
                <TableHead className="text-muted-foreground" scope="col">
                  1M
                </TableHead>
                <TableHead className="text-muted-foreground" scope="col">
                  3M
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {covered.map((name) => (
                <TableRow className="border-border border-b" key={name.symbol}>
                  <TableHead className="h-auto whitespace-normal" scope="row">
                    <TickerLink symbol={name.symbol} />
                  </TableHead>
                  <TableCell className="whitespace-normal">
                    {name.roles.join(", ")}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {name.industry ?? "–"}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {name.cell1M ?? "–"}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {name.cell3M ?? "–"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </details>
    </div>
  );
};

const HeatButton = ({
  label,
  ret,
  n,
  period,
  onSelect,
}: {
  readonly label: string;
  readonly ret: number | null;
  readonly n: number;
  readonly period: RotationPeriod;
  readonly onSelect: () => void;
}) => (
  <button
    aria-label={label}
    className="flex w-full items-baseline justify-between gap-1 rounded px-2 py-1 text-left font-mono text-xs"
    onClick={onSelect}
    style={{ background: heatColor(ret, period) }}
    type="button"
  >
    {formatReturn(ret)}
    <span className="text-[10px] text-muted-foreground">{n}</span>
  </button>
);

const RotationKpis = ({
  matrix,
  period,
}: {
  readonly matrix: RotationMatrixOutput;
  readonly period: RotationPeriod;
}) => {
  const leading = matrix.top[0];
  const lagging = matrix.bottom[0];
  const standout = matrix.standouts[0];
  return (
    <KpiRow label={`Rotation summary for ${period}`}>
      <KpiCard
        data-kpi="leading"
        hint={leading?.industry ?? "No ranked industry"}
        icon={<TrendingUp />}
        label={`Leading industry (${period})`}
        value={formatReturn(leading?.retMedian)}
      />
      <KpiCard
        data-kpi="lagging"
        hint={lagging?.industry ?? "No ranked industry"}
        icon={<TrendingDown />}
        label={`Lagging industry (${period})`}
        value={formatReturn(lagging?.retMedian)}
      />
      <KpiCard
        data-kpi="standouts"
        hint={
          standout === undefined
            ? "None above 2σ"
            : `Top: ${standout.symbol} ${formatReturn(standout.ret)}`
        }
        icon={<Sparkles />}
        label="Standouts (> 2σ vs industry)"
        value={matrix.standouts.length.toLocaleString("en-US")}
      />
    </KpiRow>
  );
};

export interface RotationMatrixWorkspaceProps {
  readonly gateway?: ResearchLensesGateway;
  /** Settings restored from the URL (`?period=`); the workspace keeps the URL in sync. */
  readonly initial?: RotationMatrixSettings;
}

export const RotationMatrixWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: RotationMatrixWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserResearchLensesGateway()
  );
  const [period, setPeriod] = useState<RotationPeriod>(
    initial?.period ?? DEFAULT_PERIOD
  );
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (next: RotationPeriod) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const loaded: LoadState = await gateway.rotationMatrix(next).then(
        (loadedMatrix) => ({ matrix: loadedMatrix, type: "ready" }),
        (error: unknown) => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer period choice wins over a slower, older response.
      if (request === latest.current) setState(loaded);
    },
    [gateway]
  );

  useEffect(() => {
    void load(period);
    return;
  }, [load, period]);

  // Only `period` is ours: other parameters in the address bar (e.g. `?theme=`) are kept.
  useEffect(() => writeQuery({ period }, URL_DEFAULTS), [period]);

  const matrix = state.type === "ready" ? state.matrix : null;
  const groups = useMemo(() => {
    if (matrix === null) return [];
    const needle = filter.trim().toLowerCase();
    const bySector = new Map<string, RotationIndustry[]>();
    for (const industry of matrix.industries) {
      const text = `${industry.sector} ${industry.industry}`.toLowerCase();
      const holds = ROTATION_CAPS.some((cap) =>
        industry.cells[cap]?.symbols?.some(
          (entry) => entry.symbol.toLowerCase() === needle
        )
      );
      if (needle !== "" && !text.includes(needle) && !holds) continue;
      bySector.set(industry.sector, [
        ...(bySector.get(industry.sector) ?? []),
        industry,
      ]);
    }
    return matrix.sectors.flatMap((sector) => {
      const industries = bySector.get(sector.sector);
      return industries === undefined ? [] : [{ industries, sector }];
    });
  }, [matrix, filter]);

  const status =
    state.type === "loading" ? (
      <StatusBadge status="info">Loading</StatusBadge>
    ) : state.type === "error" ? (
      <StatusBadge status="destructive">Unavailable</StatusBadge>
    ) : (
      <StatusBadge status="neutral">
        As of {state.matrix.asOf ?? "unknown"}
      </StatusBadge>
    );

  const controls = (
    <>
      <div aria-label="Period" className="flex gap-1" role="group">
        {ROTATION_PERIODS.map((key) => (
          <Button
            aria-pressed={key === period}
            key={key}
            onClick={() => {
              setSelection(null);
              setPeriod(key);
            }}
            size="sm"
            variant={key === period ? "primary" : "outline"}
          >
            {key}
          </Button>
        ))}
      </div>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Filter</span>
        <Input
          className="h-11 min-w-0 flex-1 sm:w-48 sm:flex-none"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Industry, sector or symbol"
          type="search"
          value={filter}
        />
      </label>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={state.type === "loading"}
            onClick={() => void load(period)}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Median returns by sector, industry and cap bucket, with your watchlist names. Research only."
        status={status}
        title="Rotation matrix"
      />

      {matrix === null ? null : (
        <RotationKpis matrix={matrix} period={period} />
      )}

      {matrix === null ? null : (
        <Panel
          contentClassName="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
          headingId="rotation-summary-heading"
          title="Leaders, laggards and our names"
        >
          <RankedList
            rows={matrix.top}
            title={`Leading industries (${period})`}
            tone="text-green-600"
          />
          <RankedList
            rows={matrix.bottom}
            title={`Lagging industries (${period})`}
            tone="text-red-600"
          />
          <div className="space-y-1">
            <h3 className="font-medium text-sm">
              Standouts (&gt; 2σ vs industry)
            </h3>
            <ul className="space-y-0.5 text-sm">
              {matrix.standouts.slice(0, 8).map((entry) => (
                <li key={entry.symbol}>
                  <TickerLink symbol={entry.symbol} /> {formatReturn(entry.ret)}{" "}
                  <span className="text-muted-foreground text-xs">
                    z={entry.z} · {entry.industry}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <OurNames matrix={matrix} />
        </Panel>
      )}

      {selection === null ? null : (
        <CellDetail
          onClose={() => setSelection(null)}
          period={period}
          selection={selection}
        />
      )}

      <Panel
        actions={controls}
        // Panel actions do not shrink; let the filter row wrap to the panel width on phones.
        className="[&>header>div:last-child]:min-w-0 [&>header>div:last-child]:shrink"
        description={
          matrix === null
            ? undefined
            : `Median returns for ${matrix.universeSize.toLocaleString("en-US")} US-listed stocks by sector, industry and cap bucket. Color scale ±${HEAT_SCALE[period]}%.`
        }
        flush
        headingId="rotation-matrix-heading"
        title="Matrix"
      >
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading rotation matrix…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">
              Rotation matrix unavailable: {state.message}
            </p>
            <Button
              onClick={() => void load(period)}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Try again
            </Button>
          </div>
        ) : null}

        {matrix === null ? null : groups.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <p>No industry, sector or symbol matches “{filter.trim()}”.</p>
            <Button onClick={() => setFilter("")} size="sm" variant="outline">
              Clear filter
            </Button>
          </div>
        ) : (
          <TableScroll label={`Rotation matrix for ${period}`} minWidth="40rem">
            <Table className="w-full text-sm">
              <TableCaption className="sr-only">
                Rotation matrix for {period}
              </TableCaption>
              <TableHeader>
                <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                  <TableHead className="text-muted-foreground" scope="col">
                    Industry
                  </TableHead>
                  {ROTATION_CAPS.map((cap) => (
                    <TableHead
                      className="text-muted-foreground"
                      key={cap}
                      scope="col"
                    >
                      {matrix.capLabels[cap]}
                    </TableHead>
                  ))}
                  <TableHead className="text-muted-foreground" scope="col">
                    All
                  </TableHead>
                </TableRow>
              </TableHeader>
              {groups.map(({ sector, industries }) => (
                <TableBody key={sector.sector}>
                  <TableRow className="border-border border-b bg-muted/40">
                    <TableHead
                      className="py-1 text-left font-semibold"
                      colSpan={5}
                      scope="rowgroup"
                    >
                      {sector.sector}{" "}
                      <span
                        className="rounded px-1 font-mono text-xs"
                        style={{
                          background: heatColor(sector.retMedian, period),
                        }}
                      >
                        {formatReturn(sector.retMedian)}
                      </span>{" "}
                      <span className="font-normal text-muted-foreground text-xs">
                        {sector.n} names
                      </span>
                    </TableHead>
                  </TableRow>
                  {industries.map((industry) => (
                    <TableRow
                      className="border-border border-b"
                      key={industry.industry}
                    >
                      <TableHead
                        className="h-auto whitespace-normal py-1 pr-2 text-left font-normal"
                        scope="row"
                      >
                        {industry.industry}
                        {industry.quintile === 1 ? " ▲" : ""}
                        {industry.quintile === 5 ? " ▼" : ""}
                      </TableHead>
                      {ROTATION_CAPS.map((cap) => {
                        const cell = industry.cells[cap];
                        return (
                          <TableCell
                            className="whitespace-normal p-0.5"
                            key={cap}
                          >
                            {cell === undefined ? null : (
                              <HeatButton
                                label={`${industry.industry} ${cap}: ${formatReturn(cell.retMedian)}, ${cell.n} names`}
                                n={cell.n}
                                onSelect={() => setSelection({ cap, industry })}
                                period={period}
                                ret={cell.retMedian}
                              />
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="whitespace-normal p-0.5">
                        <HeatButton
                          label={`${industry.industry} all caps: ${formatReturn(industry.retMedian)}, ${industry.n} names`}
                          n={industry.n}
                          onSelect={() =>
                            setSelection({ cap: "all", industry })
                          }
                          period={period}
                          ret={industry.retMedian}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              ))}
            </Table>
          </TableScroll>
        )}
        {matrix === null ? null : (
          <p className="border-t px-4 py-3 text-muted-foreground text-xs">
            Sources: {matrix.source?.metadata ?? "unknown"};{" "}
            {matrix.source?.bars ?? "unknown"}. Generated {matrix.generatedAt}.
            Read-only research view; no orders.{" "}
            <a
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              href={
                matrix.source?.finvizMap ??
                "https://finviz.com/map.ashx?t=sec_all"
              }
              rel="noreferrer noopener"
              target="_blank"
            >
              Open the Finviz map
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </p>
        )}
      </Panel>
    </div>
  );
};
