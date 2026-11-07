"use client";

import type {
  DeepValueCriterion,
  DeepValueOutput,
  DeepValueRow,
  DeepValueScoreOutput,
} from "@darkfactory/api";
import {
  Button,
  Input,
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
import { ChevronDown, RefreshCw, RotateCcw } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { TickerLink } from "../ticker-link.tsx";

import { writeQuery } from "./backtest-lab-query.ts";
import {
  clampMinTotal,
  DEEP_VALUE_ROLE_FILTERS,
  DEFAULT_SETTINGS,
  type DeepValueFilter,
  type DeepValueSettings,
  MAX_FILTER_TEXT,
  MAX_TOTAL,
  normalizeSymbol,
} from "./deep-value-params.ts";
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
  { id: "timeHorizon", label: "Time horizon", lens: "TRUE", proxy: "" },
  { id: "risk", label: "Risk", lens: "TRUE", proxy: "" },
  { id: "upside", label: "Upside", lens: "TRUE", proxy: "" },
  { id: "entry", label: "Entry", lens: "TRUE", proxy: "" },
  { id: "substance", label: "Substance", lens: "SLAP", proxy: "" },
  { id: "longevity", label: "Longevity", lens: "SLAP", proxy: "" },
  { id: "alignment", label: "Alignment", lens: "SLAP", proxy: "" },
  { id: "price", label: "Price", lens: "SLAP", proxy: "" },
];

const UNIVERSE_ROLE = "low-price universe";
// Flags that hide a row when "Hide penny / illiquid / dilution" is on.
const HIDDEN_FLAGS: Readonly<Record<string, true>> = {
  dilution: true,
  illiquid: true,
  penny: true,
};
const MAX_TABLE_ROWS = 300;
// Longest ticker the shared pattern accepts: five letters, a dot or dash and a class letter.
const MAX_TICKER_LENGTH = 7;

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
        <TickerLink symbol={row.symbol} />{" "}
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

const AdhocResult = ({
  adhoc,
  criteria,
  symbol,
}: {
  readonly adhoc: AdhocState;
  readonly criteria: readonly DeepValueCriterion[];
  readonly symbol: string | null;
}) => (
  <>
    {adhoc.type === "loading" ? (
      <p aria-busy="true" className="text-muted-foreground text-sm">
        Scoring {symbol}…
      </p>
    ) : null}
    {adhoc.type === "error" ? (
      <p className="text-sm" role="alert">
        Could not score: {adhoc.message}
      </p>
    ) : null}
    {adhoc.type === "done" ? (
      <>
        {adhoc.row.peerMedian === null ? (
          <p className="text-muted-foreground text-xs">
            No stored industry median for this ticker: Upside uses the 52-week
            high fallback.
          </p>
        ) : null}
        <Scorecard criteria={criteria} row={adhoc.row} />
      </>
    ) : null}
  </>
);

const selectClass =
  "h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm sm:flex-none";

export interface DeepValueWorkspaceProps {
  readonly gateway?: ResearchLensesGateway;
  /** Settings restored from the URL; the workspace keeps the URL in sync. */
  readonly initial?: DeepValueSettings;
}

export const DeepValueWorkspace = ({
  gateway: suppliedGateway,
  initial = DEFAULT_SETTINGS,
}: DeepValueWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserResearchLensesGateway()
  );
  const [ranking, setRanking] = useState<RankingState>({ type: "loading" });
  const [role, setRole] = useState<string>(initial.role);
  const [text, setText] = useState(initial.text);
  const [hideFlagged, setHideFlagged] = useState(initial.hideFlagged);
  const [minTotal, setMinTotal] = useState(initial.minTotal);
  const [open, setOpen] = useState<string | null>(null);
  const [ticker, setTicker] = useState(initial.symbol ?? "");
  const [symbol, setSymbol] = useState<string | null>(initial.symbol);
  const [tickerError, setTickerError] = useState(false);
  // Bumped on every submit, so scoring the same ticker again asks the server again.
  const [scoreRequest, setScoreRequest] = useState(0);
  const [adhoc, setAdhoc] = useState<AdhocState>({ type: "idle" });
  const showId = useId();

  const load = useCallback(async () => {
    setRanking({ type: "loading" });
    try {
      return setRanking({
        scorecard: await gateway.deepValue(),
        type: "ready",
      });
    } catch (error) {
      return setRanking({
        message: describeResearchLensFailure(error),
        type: "error",
      });
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  useEffect(() => {
    if (symbol === null) {
      setAdhoc({ type: "idle" });
      return;
    }
    let live = true;
    setAdhoc({ type: "loading" });
    void gateway
      .score(symbol)
      .then(
        (row): AdhocState => ({ row, type: "done" }),
        (error: unknown): AdhocState => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      )
      .then((next) => {
        // A newer ticker wins over a slower, older score.
        if (live) setAdhoc(next);
        return;
      });
    return () => {
      live = false;
    };
  }, [gateway, symbol, scoreRequest]);

  useEffect(() => {
    // Only this page's keys change; foreign params such as ?theme= survive.
    writeQuery(
      // Same key order as deepValueSearch, so fresh URLs read the same (entries keep the order).
      Object.fromEntries([
        ["symbol", symbol],
        ["show", role],
        ["min", minTotal],
        ["hide", hideFlagged ? "1" : null],
        ["q", text.trim() === "" ? null : text],
      ]),
      { min: DEFAULT_SETTINGS.minTotal, show: DEFAULT_SETTINGS.role }
    );
  }, [hideFlagged, minTotal, role, symbol, text]);

  const scorecard = ranking.type === "ready" ? ranking.scorecard : null;
  const criteria =
    scorecard === null || scorecard.criteria.length === 0
      ? FALLBACK_CRITERIA
      : scorecard.criteria;
  const rows = useMemo(
    () =>
      filterDeepValueRows(scorecard?.rows ?? [], {
        hideFlagged,
        minTotal,
        role,
        text,
      }),
    [scorecard, role, text, hideFlagged, minTotal]
  );

  const resetFilters = () => {
    setRole(DEFAULT_SETTINGS.role);
    setText(DEFAULT_SETTINGS.text);
    setHideFlagged(DEFAULT_SETTINGS.hideFlagged);
    setMinTotal(DEFAULT_SETTINGS.minTotal);
  };

  const status =
    ranking.type === "loading" ? (
      <StatusBadge status="info">Loading</StatusBadge>
    ) : ranking.type === "error" ? (
      <StatusBadge status="destructive">Unavailable</StatusBadge>
    ) : (
      <StatusBadge status="neutral">
        Scored {ranking.scorecard.generatedAt.slice(0, 10)}
      </StatusBadge>
    );

  const scoreForm = (
    <form
      aria-label="Score a ticker"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const next = normalizeSymbol(ticker);
        if (next === null && ticker.trim() !== "") {
          setTickerError(true);
          return;
        }
        setTickerError(false);
        setSymbol(next);
        setScoreRequest((count) => count + 1);
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <span>Score any ticker</span>
        <Input
          aria-describedby={tickerError ? "deep-value-ticker-error" : undefined}
          aria-invalid={tickerError}
          className="w-28"
          maxLength={MAX_TICKER_LENGTH}
          onChange={(event) => {
            setTicker(event.target.value);
            setTickerError(false);
          }}
          placeholder="e.g. SIRI"
          value={ticker}
        />
      </label>
      <Button disabled={adhoc.type === "loading"} size="sm" type="submit">
        {adhoc.type === "loading" ? "Scoring…" : "Score"}
      </Button>
      {symbol === null ? null : (
        <Button
          onClick={() => {
            setTicker("");
            setTickerError(false);
            setSymbol(null);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Clear
        </Button>
      )}
      {tickerError ? (
        <p
          className="w-full text-destructive text-sm"
          id="deep-value-ticker-error"
          role="alert"
        >
          Enter a ticker like AAPL or BRK.B
        </p>
      ) : null}
    </form>
  );

  const screenControls = (
    <>
      {/* A sibling label: a label wrapping the select would also hold every option's text. */}
      <div className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <label htmlFor={showId}>Show</label>
        <select
          className={selectClass}
          id={showId}
          onChange={(event) => setRole(event.target.value)}
          value={role}
        >
          {DEEP_VALUE_ROLE_FILTERS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Min score</span>
        <Input
          className="h-11 w-20"
          max={MAX_TOTAL}
          min={0}
          onChange={(event) =>
            setMinTotal(clampMinTotal(Number(event.target.value)))
          }
          type="number"
          value={minTotal}
        />
      </label>
      <label className="flex min-h-11 w-full items-center gap-2 text-sm sm:w-auto">
        <input
          checked={hideFlagged}
          onChange={(event) => setHideFlagged(event.target.checked)}
          type="checkbox"
        />
        Hide penny / illiquid / dilution
      </label>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Filter</span>
        <Input
          className="h-11 min-w-0 flex-1 sm:w-44 sm:flex-none"
          maxLength={MAX_FILTER_TEXT}
          onChange={(event) => setText(event.target.value)}
          placeholder="Symbol, name or industry"
          type="search"
          value={text}
        />
      </label>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={ranking.type === "loading"}
            onClick={() => void load()}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Small caps ranked by the TRUE timing and SLAP strategic lenses, plus a scorecard for any ticker. Research only."
        status={status}
        title="Deep value screen"
      />

      <Panel
        actions={scoreForm}
        contentClassName={symbol === null ? "hidden" : "space-y-2"}
        headingId="deep-value-score-heading"
        title="Ticker scorecard"
      >
        <AdhocResult adhoc={adhoc} criteria={criteria} symbol={symbol} />
      </Panel>

      <Panel
        actions={screenControls}
        // Panel actions do not shrink; let the filter row wrap to the panel width on phones.
        className="[&>header>div:last-child]:min-w-0 [&>header>div:last-child]:shrink"
        description={
          scorecard === null ? undefined : (
            <>
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
            </>
          )
        }
        flush
        headingId="deep-value-ranking-heading"
        title="TRUE SLAP ranking"
      >
        {ranking.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading ranking…
          </p>
        ) : null}
        {ranking.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
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
          <>
            <p
              className="border-b px-4 py-2 text-muted-foreground text-xs"
              role="status"
            >
              {rows.length} shown
              {rows.length > MAX_TABLE_ROWS
                ? ` (first ${MAX_TABLE_ROWS} listed)`
                : ""}
            </p>
            {rows.length === 0 ? (
              <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
                <p>No scored name matches these filters.</p>
                <Button onClick={resetFilters} size="sm" variant="outline">
                  Reset filters
                </Button>
              </div>
            ) : (
              <TableScroll label="TRUE SLAP ranking" minWidth="60rem">
                <Table className="w-full text-sm">
                  <TableCaption className="sr-only">
                    TRUE SLAP ranking
                  </TableCaption>
                  <TableHeader>
                    <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                      <TableHead scope="col">#</TableHead>
                      <TableHead scope="col">Symbol</TableHead>
                      <TableHead scope="col">Total</TableHead>
                      {criteria.map((criterion) => (
                        <TableHead
                          key={criterion.id}
                          scope="col"
                          title={criterion.proxy}
                        >
                          {criterion.label}
                        </TableHead>
                      ))}
                      <TableHead scope="col">Price</TableHead>
                      <TableHead scope="col">Cap</TableHead>
                      <TableHead scope="col">Flags</TableHead>
                      <TableHead scope="col">Why it passed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, MAX_TABLE_ROWS).map((row) => (
                      <Fragment key={row.symbol}>
                        <TableRow className="border-border border-b [&>td]:align-top [&>th]:align-top">
                          <TableCell>{row.rank ?? "–"}</TableCell>
                          <TableHead
                            className="text-left font-normal"
                            scope="row"
                          >
                            <span className="flex items-center gap-1">
                              <TickerLink symbol={row.symbol} />
                              <Button
                                aria-expanded={open === row.symbol}
                                aria-label={`Scorecard for ${row.symbol}`}
                                onClick={() =>
                                  setOpen(
                                    open === row.symbol ? null : row.symbol
                                  )
                                }
                                size="icon-sm"
                                variant="ghost"
                              >
                                <ChevronDown
                                  aria-hidden="true"
                                  className={
                                    open === row.symbol
                                      ? "size-4 rotate-180"
                                      : "size-4"
                                  }
                                />
                              </Button>
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {row.roles
                                .filter((entry) => entry !== UNIVERSE_ROLE)
                                .join(", ")}
                            </span>
                          </TableHead>
                          <TableCell>
                            <b>{row.total}</b>
                            <span className="text-muted-foreground text-xs">
                              /{row.coverage * 2}
                            </span>
                          </TableCell>
                          {criteria.map((criterion) => {
                            const result = row.criteria[criterion.id];
                            return (
                              <TableCell
                                className={`text-center font-mono ${scoreTone(result?.score)}`}
                                key={criterion.id}
                                title={result?.evidence}
                              >
                                {result?.score ?? "–"}
                              </TableCell>
                            );
                          })}
                          <TableCell>
                            {row.price === null
                              ? "–"
                              : `$${row.price.toFixed(2)}`}
                          </TableCell>
                          <TableCell>{formatMoney(row.marketCap)}</TableCell>
                          <TableCell className="space-x-1 whitespace-normal">
                            {row.flags.map((flag) => (
                              <span
                                className="rounded bg-amber-500/15 px-1 text-xs"
                                key={flag.id}
                                title={flag.label}
                              >
                                {flag.id}
                              </span>
                            ))}
                          </TableCell>
                          <TableCell className="whitespace-normal text-xs">
                            {row.reasons
                              .map((entry) => entry.split(":")[0])
                              .join(", ") || "–"}
                          </TableCell>
                        </TableRow>
                        {open === row.symbol ? (
                          <TableRow>
                            <TableCell
                              className="whitespace-normal"
                              colSpan={7 + criteria.length}
                            >
                              <Scorecard criteria={criteria} row={row} />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            )}
            <p className="border-t px-4 py-3 text-muted-foreground text-xs">
              Sources: {Object.values(scorecard.sources).join("; ")}.{" "}
              {scorecard.cutoffs.note}
            </p>
          </>
        )}
      </Panel>

      <p className="max-w-4xl text-muted-foreground text-xs">
        Method from IG reel Dew5OAejyOH (@willbchou). <b>TRUE</b> = timing lens
        (Time horizon, Risk, Upside, Entry). <b>SLAP</b> = strategic lens
        (Substance, Longevity, Alignment, Price). Each criterion scores 0–2 with
        written evidence. The reel gives no numbers: every proxy and cutoff here
        is ours, not the reel's, and the creator's claims are unverified.
        Research only; no orders.
      </p>
    </div>
  );
};
