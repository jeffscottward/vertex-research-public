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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createBrowserResearchLensesGateway,
  describeResearchLensFailure,
  type ResearchLensesGateway,
} from "./research-lenses-client.ts";

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

const finvizQuote = (symbol: string) =>
  `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}`;

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
    <section
      aria-label="Selected cell"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">
          {industry.industry} · {cap === "all" ? "All caps" : cap} · {period}
        </h3>
        <Button onClick={onClose} size="sm" variant="secondary">
          Close
        </Button>
      </div>
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
            <a
              className="font-mono font-semibold underline-offset-2 hover:underline"
              href={finvizQuote(entry.symbol)}
              rel="noreferrer noopener"
              target="_blank"
            >
              {entry.symbol}
            </a>{" "}
            {formatReturn(entry.ret)}{" "}
            <span className="text-muted-foreground">
              {formatCap(entry.marketCap)}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
            <b>{opportunities.map((name) => name.symbol).join(", ")}</b>
          </>
        )}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          {covered.length} tracked names by cell
        </summary>
        <Table className="mt-2 w-full text-xs">
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
                <TableHead className="whitespace-normal font-mono" scope="row">
                  {name.symbol}
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

export interface RotationMatrixWorkspaceProps {
  readonly gateway?: ResearchLensesGateway;
}

export const RotationMatrixWorkspace = ({
  gateway: suppliedGateway,
}: RotationMatrixWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserResearchLensesGateway()
  );
  const [period, setPeriod] = useState<RotationPeriod>("1M");
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  const load = useCallback(
    async (next: RotationPeriod) => {
      setState({ type: "loading" });
      try {
        return setState({
          type: "ready",
          matrix: await gateway.rotationMatrix(next),
        });
      } catch (error) {
        return setState({
          type: "error",
          message: describeResearchLensFailure(error),
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    void load(period);
    return;
  }, [load, period]);

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
      return industries === undefined ? [] : [{ sector, industries }];
    });
  }, [matrix, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-muted-foreground text-sm">
          {matrix === null
            ? "Sector → industry → cap bucket median returns for US-listed stocks."
            : `Sector → industry → cap bucket median returns for ${matrix.universeSize.toLocaleString("en-US")} US-listed stocks. Daily close ${matrix.asOf ?? "unknown"}. Color scale ±${HEAT_SCALE[period]}%.`}
        </p>
        <div aria-label="Period" className="flex gap-1" role="tablist">
          {ROTATION_PERIODS.map((key) => (
            <Button
              aria-selected={key === period}
              key={key}
              onClick={() => {
                setSelection(null);
                setPeriod(key);
              }}
              role="tab"
              size="sm"
              variant={key === period ? "primary" : "secondary"}
            >
              {key}
            </Button>
          ))}
        </div>
      </div>

      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading rotation matrix…
        </p>
      ) : null}
      {state.type === "error" ? (
        <div className="space-y-2" role="alert">
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

      {matrix === null ? null : (
        <>
          <section
            aria-label="Rotation summary"
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
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
                    <b className="font-mono">{entry.symbol}</b>{" "}
                    {formatReturn(entry.ret)}{" "}
                    <span className="text-muted-foreground text-xs">
                      z={entry.z} · {entry.industry}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <OurNames matrix={matrix} />
          </section>

          {selection === null ? null : (
            <CellDetail
              onClose={() => setSelection(null)}
              period={period}
              selection={selection}
            />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="block">Filter</span>
              <Input
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Industry, sector or symbol"
                type="search"
                value={filter}
              />
            </label>
            <a
              className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
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
          </div>

          <div className="overflow-x-auto">
            <Table className="w-full min-w-[640px] text-sm">
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
                        className="whitespace-normal py-1 pr-2 text-left font-normal"
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
                                onSelect={() => setSelection({ industry, cap })}
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
                            setSelection({ industry, cap: "all" })
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
          </div>
          <p className="text-muted-foreground text-xs">
            Sources: {matrix.source?.metadata ?? "unknown"};{" "}
            {matrix.source?.bars ?? "unknown"}. Generated {matrix.generatedAt}.
            Read-only research view; no orders.
          </p>
        </>
      )}
    </div>
  );
};
