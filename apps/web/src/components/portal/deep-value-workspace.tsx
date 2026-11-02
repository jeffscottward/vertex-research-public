"use client";

import type {
  DeepValueCriterion,
  DeepValueOutput,
  DeepValueRow,
  DeepValueScoreOutput,
} from "@darkfactory/api";
import { Button, Input } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  createBrowserResearchLensesGateway,
  describeResearchLensFailure,
  type ResearchLensesGateway,
} from "./research-lenses-client.ts";

// Deep value screen (port of the vertex-research ?view=deep-value lens): TRUE SLAP scorecard from IG reel
// Dew5OAejyOH (@willbchou). 8 criteria, 0-2 points each, with written evidence. Every proxy and cutoff is
// ours, not the reel's; the creator's claims are unverified. Research only; no orders.

// Shown until the stored ranking loads (and for an on-demand score without it).
const FALLBACK_CRITERIA: readonly DeepValueCriterion[] = [
  { id: "timeHorizon", lens: "TRUE", label: "Time horizon", proxy: "" },
  { id: "risk", lens: "TRUE", label: "Risk", proxy: "" },
  { id: "upside", lens: "TRUE", label: "Upside", proxy: "" },
  { id: "entry", lens: "TRUE", label: "Entry", proxy: "" },
  { id: "substance", lens: "SLAP", label: "Substance", proxy: "" },
  { id: "longevity", lens: "SLAP", label: "Longevity", proxy: "" },
  { id: "alignment", lens: "SLAP", label: "Alignment", proxy: "" },
  { id: "price", lens: "SLAP", label: "Price", proxy: "" },
];

const DEEP_VALUE_ROLE_FILTERS = [
  "all",
  "ours",
  "wish list",
  "re-entry",
  "rotation leader",
  "low-price universe",
] as const;

const UNIVERSE_ROLE = "low-price universe";
// Flags that hide a row when "Hide penny / illiquid / dilution" is on.
const HIDDEN_FLAGS: Readonly<Record<string, true>> = {
  penny: true,
  illiquid: true,
  dilution: true,
};
const MAX_TABLE_ROWS = 300;

export type DeepValueFilter = Readonly<{
  role: string;
  text: string;
  hideFlagged: boolean;
  minTotal: number;
}>;

/** Filter rows by role, text, flags and minimum total. "ours" = every role except the optional universe. */
export const filterDeepValueRows = (
  rows: readonly DeepValueRow[],
  { role, text, hideFlagged, minTotal }: DeepValueFilter
): DeepValueRow[] => {
  const needle = text.trim().toLowerCase();
  return rows.filter((row) => {
    const roleMatch =
      role === "all" ||
      (role === "ours"
        ? row.roles.some((entry) => entry !== UNIVERSE_ROLE)
        : row.roles.includes(role));
    const haystack =
      `${row.symbol} ${row.name ?? ""} ${row.industry ?? ""}`.toLowerCase();
    const flagged = row.flags.some((flag) => HIDDEN_FLAGS[flag.id] === true);
    return (
      roleMatch &&
      (needle === "" || haystack.includes(needle)) &&
      !(hideFlagged && flagged) &&
      row.total >= minTotal
    );
  });
};

export const formatMoney = (value: number | null): string => {
  if (value === null) return "–";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${Math.round(value / 1e3)}k`;
};

const SCORE_TONES: Readonly<Record<string, string>> = {
  "0": "bg-red-500/15",
  "1": "bg-amber-500/15",
  "2": "bg-green-600/20",
};

const scoreTone = (score: number | null | undefined): string =>
  SCORE_TONES[String(score)] ?? "text-muted-foreground";

const Scorecard = ({
  row,
  criteria,
}: {
  readonly row: DeepValueRow | DeepValueScoreOutput;
  readonly criteria: readonly DeepValueCriterion[];
}) => (
  <section
    aria-label={`${row.symbol} scorecard`}
    className="space-y-2 rounded-md border border-border p-3"
  >
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-medium">
        {row.rank === undefined ? "" : `#${row.rank} `}
        <span className="font-mono">{row.symbol}</span>{" "}
        <span className="text-muted-foreground text-sm">{row.name ?? ""}</span>
      </h3>
      <span className="font-semibold">
        {row.total}/16{" "}
        <span className="font-normal text-muted-foreground text-xs">
          ({row.coverage}/8 criteria with data)
        </span>
      </span>
    </div>
    <p className="text-muted-foreground text-xs">
      {row.price === null ? "–" : `$${row.price.toFixed(2)}`} · cap{" "}
      {formatMoney(row.marketCap)} · {row.industry ?? "industry unknown"} ·{" "}
      {row.roles.join(", ") || "requested"} · prices as of {row.asOf ?? "–"}
    </p>
    {row.flags.length === 0 ? null : (
      <ul aria-label="Risk flags" className="space-y-0.5 text-sm">
        {row.flags.map((flag) => (
          <li key={flag.id}>⚠️ {flag.label}</li>
        ))}
      </ul>
    )}
    <table className="w-full text-sm">
      <caption className="sr-only">{row.symbol} criteria</caption>
      <thead>
        <tr className="border-border border-b text-left text-muted-foreground text-xs">
          <th scope="col">Lens</th>
          <th scope="col">Criterion</th>
          <th scope="col">Score</th>
          <th scope="col">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {criteria.map((criterion) => {
          const result = row.criteria[criterion.id];
          return (
            <tr className="border-border border-b align-top" key={criterion.id}>
              <td className="pr-2 text-xs">{criterion.lens}</td>
              <th
                className="pr-2 text-left font-normal"
                scope="row"
                title={criterion.proxy}
              >
                {criterion.label}
              </th>
              <td
                className={`px-2 text-center font-mono ${scoreTone(result?.score)}`}
              >
                {result?.score ?? "–"}
              </td>
              <td className="pl-2">{result?.evidence ?? "–"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {row.errors === undefined || row.errors.length === 0 ? null : (
      <p className="text-muted-foreground text-xs">
        Source gaps: {row.errors.join("; ")}
      </p>
    )}
    <p className="flex gap-3 text-xs">
      <a
        className="underline-offset-2 hover:underline"
        href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(row.symbol)}&type=10-K`}
        rel="noreferrer noopener"
        target="_blank"
      >
        SEC filings ↗
      </a>
      <a
        className="underline-offset-2 hover:underline"
        href={`https://finviz.com/quote.ashx?t=${encodeURIComponent(row.symbol)}`}
        rel="noreferrer noopener"
        target="_blank"
      >
        Finviz ↗
      </a>
    </p>
  </section>
);

type RankingState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; scorecard: DeepValueOutput }>;

type AdhocState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "done"; row: DeepValueScoreOutput }>;

export interface DeepValueWorkspaceProps {
  readonly gateway?: ResearchLensesGateway;
}

export const DeepValueWorkspace = ({
  gateway: suppliedGateway,
}: DeepValueWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserResearchLensesGateway()
  );
  const [ranking, setRanking] = useState<RankingState>({ type: "loading" });
  const [role, setRole] = useState<string>("all");
  const [text, setText] = useState("");
  const [hideFlagged, setHideFlagged] = useState(false);
  const [minTotal, setMinTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [ticker, setTicker] = useState("");
  const [adhoc, setAdhoc] = useState<AdhocState>({ type: "idle" });

  const load = useCallback(async () => {
    setRanking({ type: "loading" });
    try {
      return setRanking({
        type: "ready",
        scorecard: await gateway.deepValue(),
      });
    } catch (error) {
      return setRanking({
        type: "error",
        message: describeResearchLensFailure(error),
      });
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const scorecard = ranking.type === "ready" ? ranking.scorecard : null;
  const criteria =
    scorecard === null || scorecard.criteria.length === 0
      ? FALLBACK_CRITERIA
      : scorecard.criteria;
  const rows = useMemo(
    () =>
      filterDeepValueRows(scorecard?.rows ?? [], {
        role,
        text,
        hideFlagged,
        minTotal,
      }),
    [scorecard, role, text, hideFlagged, minTotal]
  );

  const scoreOne = async (): Promise<void> => {
    const symbol = ticker.trim().toUpperCase();
    if (symbol === "") return;
    setAdhoc({ type: "loading" });
    try {
      setAdhoc({ type: "done", row: await gateway.score(symbol) });
    } catch (error) {
      setAdhoc({ type: "error", message: describeResearchLensFailure(error) });
    }
  };

  return (
    <div className="space-y-6">
      <p className="max-w-4xl text-muted-foreground text-sm">
        Method from IG reel Dew5OAejyOH (@willbchou). <b>TRUE</b> = timing lens
        (Time horizon, Risk, Upside, Entry). <b>SLAP</b> = strategic lens
        (Substance, Longevity, Alignment, Price). Each criterion scores 0–2 with
        written evidence. The reel gives no numbers: every proxy and cutoff here
        is ours, not the reel's, and the creator's claims are unverified.
        Research only; no orders.
      </p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void scoreOne();
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="block">Score any ticker</span>
          <Input
            maxLength={8}
            onChange={(event) => setTicker(event.target.value)}
            placeholder="e.g. SIRI"
            value={ticker}
          />
        </label>
        <Button disabled={adhoc.type === "loading"} type="submit">
          {adhoc.type === "loading" ? "Scoring…" : "Score"}
        </Button>
      </form>
      {adhoc.type === "error" ? (
        <p className="text-sm" role="alert">
          Could not score: {adhoc.message}
        </p>
      ) : null}
      {adhoc.type === "done" ? (
        <div className="space-y-1">
          {adhoc.row.peerMedian === null ? (
            <p className="text-muted-foreground text-xs">
              No stored industry median for this ticker: Upside uses the 52-week
              high fallback.
            </p>
          ) : null}
          <Scorecard criteria={criteria} row={adhoc.row} />
        </div>
      ) : null}

      {ranking.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading ranking…
        </p>
      ) : null}
      {ranking.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">
            Stored ranking unavailable: {ranking.message}
          </p>
          <Button onClick={() => void load()} size="sm" variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Try again
          </Button>
        </div>
      ) : null}

      {scorecard === null ? null : (
        <section aria-label="Stored ranking" className="space-y-3">
          <p className="text-muted-foreground text-xs">
            {scorecard.counts.scored} names scored{" "}
            {scorecard.generatedAt.slice(0, 16).replace("T", " ")} UTC (
            {scorecard.counts.ours} of ours, {scorecard.counts.universe} from
            the optional low-price universe: price ≤ $
            {scorecard.cutoffs.universe.maxPrice}, cap{" "}
            {formatMoney(scorecard.cutoffs.universe.minMarketCap)}–
            {formatMoney(scorecard.cutoffs.universe.maxMarketCap)}, ≥{" "}
            {formatMoney(scorecard.cutoffs.universe.minDollarVolume)}/day; our
            cutoffs, not the reel's). Ranked by total score; names with fewer
            than 6 scored criteria rank last.
          </p>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="space-y-1">
              <span className="block">Show</span>
              <select
                className="h-9 rounded-md border border-border bg-background px-2"
                onChange={(event) => setRole(event.target.value)}
                value={role}
              >
                {DEEP_VALUE_ROLE_FILTERS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block">Min score</span>
              <Input
                className="w-20"
                max={16}
                min={0}
                onChange={(event) =>
                  setMinTotal(Number(event.target.value) || 0)
                }
                type="number"
                value={minTotal}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                checked={hideFlagged}
                onChange={(event) => setHideFlagged(event.target.checked)}
                type="checkbox"
              />
              Hide penny / illiquid / dilution
            </label>
            <label className="space-y-1">
              <span className="block">Filter</span>
              <Input
                onChange={(event) => setText(event.target.value)}
                placeholder="Symbol, name or industry"
                type="search"
                value={text}
              />
            </label>
          </div>
          <p className="text-muted-foreground text-xs" role="status">
            {rows.length} shown
            {rows.length > MAX_TABLE_ROWS
              ? ` (first ${MAX_TABLE_ROWS} listed)`
              : ""}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <caption className="sr-only">TRUE SLAP ranking</caption>
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground text-xs">
                  <th scope="col">#</th>
                  <th scope="col">Symbol</th>
                  <th scope="col">Total</th>
                  {criteria.map((criterion) => (
                    <th key={criterion.id} scope="col" title={criterion.proxy}>
                      {criterion.label}
                    </th>
                  ))}
                  <th scope="col">Price</th>
                  <th scope="col">Cap</th>
                  <th scope="col">Flags</th>
                  <th scope="col">Why it passed</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, MAX_TABLE_ROWS).map((row) => (
                  <Fragment key={row.symbol}>
                    <tr className="border-border border-b align-top">
                      <td>{row.rank ?? "–"}</td>
                      <th className="text-left font-normal" scope="row">
                        <button
                          aria-expanded={open === row.symbol}
                          className="font-mono font-semibold underline-offset-2 hover:underline"
                          onClick={() =>
                            setOpen(open === row.symbol ? null : row.symbol)
                          }
                          type="button"
                        >
                          {row.symbol}
                        </button>{" "}
                        <span className="text-muted-foreground text-xs">
                          {row.roles
                            .filter((entry) => entry !== UNIVERSE_ROLE)
                            .join(", ")}
                        </span>
                      </th>
                      <td>
                        <b>{row.total}</b>
                        <span className="text-muted-foreground text-xs">
                          /{row.coverage * 2}
                        </span>
                      </td>
                      {criteria.map((criterion) => {
                        const result = row.criteria[criterion.id];
                        return (
                          <td
                            className={`text-center font-mono ${scoreTone(result?.score)}`}
                            key={criterion.id}
                            title={result?.evidence}
                          >
                            {result?.score ?? "–"}
                          </td>
                        );
                      })}
                      <td>
                        {row.price === null ? "–" : `$${row.price.toFixed(2)}`}
                      </td>
                      <td>{formatMoney(row.marketCap)}</td>
                      <td className="space-x-1">
                        {row.flags.map((flag) => (
                          <span
                            className="rounded bg-amber-500/15 px-1 text-xs"
                            key={flag.id}
                            title={flag.label}
                          >
                            {flag.id}
                          </span>
                        ))}
                      </td>
                      <td className="text-xs">
                        {row.reasons
                          .map((entry) => entry.split(":")[0])
                          .join(", ") || "–"}
                      </td>
                    </tr>
                    {open === row.symbol ? (
                      <tr>
                        <td colSpan={7 + criteria.length}>
                          <Scorecard criteria={criteria} row={row} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-xs">
            Sources: {Object.values(scorecard.sources).join("; ")}.{" "}
            {scorecard.cutoffs.note}
          </p>
        </section>
      )}
    </div>
  );
};
