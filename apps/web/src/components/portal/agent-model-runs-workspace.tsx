"use client";

import {
  AGENT_MODEL_RUN_GROUP_BY_VALUES,
  type AgentModelRunBreakdownRowOutput,
  type AgentModelRunFacetName,
  type AgentModelRunFacetsOutput,
  type AgentModelRunGroupByValue,
  type AgentModelRunOutput,
  type AgentModelRunSearchOutput,
} from "@darkfactory/api";
import {
  Badge,
  Button,
  Input,
  SectionHeader,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { Download, RotateCcw, Search, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  FrameworkLabel,
  RatingBadge,
  ResearchOnlyNote,
  RunStatusBadge,
} from "./agent-model-run-badges.tsx";
import {
  type AgentModelRunsGateway,
  activeFilterCount,
  createBrowserAgentModelRunsGateway,
  datesOutOfOrder,
  describeModelRunFailure,
  downloadCsv,
  EMPTY_MODEL_RUN_FILTERS,
  FACET_LABELS,
  facetValueLabel,
  filtersToInput,
  formatCount,
  formatPrice,
  formatShare,
  formatUsd,
  isModelRunForbidden,
  LIST_FACETS,
  type ModelRunFilterState,
  servedModels,
  toggleFacetValue,
  totalTokens,
} from "./agent-model-runs-client.ts";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";

export interface AgentModelRunsWorkspaceProps {
  readonly gateway?: AgentModelRunsGateway;
  readonly onDownload?: typeof downloadCsv;
}

type PageData = Readonly<{
  runs: AgentModelRunOutput[];
  facets: AgentModelRunFacetsOutput;
  nextCursor: string | null;
}>;

// The last good page stays on screen while a new filter loads, so the layout does not jump.
type ListState = Readonly<{
  phase: "loading" | "ready" | "error" | "forbidden";
  data: PageData | null;
  message: string;
}>;

type MoreState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "busy" }>
  | Readonly<{ type: "error"; message: string }>;

type BreakdownState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: AgentModelRunBreakdownRowOutput[] }>
  | Readonly<{ type: "error"; message: string }>;

// A filter change waits this long for the next one before it queries the server.
const FILTER_DEBOUNCE_MS = 300;

const GROUP_LABELS: Readonly<Record<AgentModelRunGroupByValue, string>> = {
  framework: "Framework",
  model: "Model",
  provider: "Provider",
  purpose: "Purpose",
  servedModel: "Served model",
  ticker: "Ticker",
  variant: "Variant",
};

const selectClass =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";

export const FacetGroup = ({
  facet,
  counts,
  selected,
  onToggle,
}: {
  readonly facet: AgentModelRunFacetName;
  readonly counts: readonly { value: string; count: number }[];
  readonly selected: readonly string[];
  readonly onToggle: (facet: AgentModelRunFacetName, value: string) => void;
}) => {
  // A selected value that no longer matches any run keeps its checkbox so it can be cleared.
  const values = [
    ...counts,
    ...selected
      .filter((value) => !counts.some((entry) => entry.value === value))
      .map((value) => ({ count: 0, value })),
  ];
  return (
    <fieldset className="min-w-0 space-y-1" data-facet={facet}>
      <legend className="font-medium text-muted-foreground text-xs">
        {FACET_LABELS[facet]}
      </legend>
      <ul className="max-h-60 overflow-y-auto">
        {values.map((entry) => (
          <li key={entry.value}>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                checked={selected.includes(entry.value)}
                className="size-5 accent-primary"
                onChange={() => onToggle(facet, entry.value)}
                type="checkbox"
              />
              <span className="min-w-0 flex-1 truncate">
                {facetValueLabel(facet, entry.value)}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {entry.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
};

const BreakdownTable = ({
  groupBy,
  state,
}: {
  readonly groupBy: AgentModelRunGroupByValue;
  readonly state: BreakdownState;
}) => {
  if (state.type === "loading")
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading breakdown…
      </p>
    );
  if (state.type === "error")
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );
  if (state.rows.length === 0)
    return <p className="text-muted-foreground text-sm">No runs to group.</p>;
  return (
    <div className="overflow-x-auto">
      <Table containerClassName="overflow-visible" className="w-full text-sm">
        <TableCaption className="sr-only">
          Model runs grouped by {GROUP_LABELS[groupBy]}
        </TableCaption>
        <TableHeader className="text-left text-muted-foreground text-xs">
          <TableRow>
            <TableHead className="text-muted-foreground" scope="col">
              {GROUP_LABELS[groupBy]}
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Runs
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Rated
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Hold share
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Failed
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Avg cost
            </TableHead>
            <TableHead className="text-right text-muted-foreground" scope="col">
              Total cost
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.rows.map((row) => (
            <TableRow
              className="border-border border-t"
              key={row.key ?? "(none)"}
            >
              <TableHead
                className="h-auto whitespace-normal py-1 text-left font-normal"
                scope="row"
              >
                {row.key ?? "(not set)"}
              </TableHead>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {row.runs}
              </TableCell>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {row.rated}
              </TableCell>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {formatShare(row.holdShare)}
              </TableCell>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {row.failed}
              </TableCell>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {formatUsd(row.avgCostUsd)}
              </TableCell>
              <TableCell className="whitespace-normal text-right tabular-nums">
                {formatUsd(row.totalCostUsd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const RunsTable = ({ runs }: { readonly runs: AgentModelRunOutput[] }) => (
  // `relative` keeps the sr-only "Status:" labels of the badges (absolutely positioned)
  // inside the scroll box; without it they widen the page on a phone.
  <div
    aria-label="Model runs table"
    className="relative overflow-x-auto"
    role="region"
  >
    <Table containerClassName="overflow-visible" className="w-full text-sm">
      <TableCaption className="sr-only">
        Model runs, newest decision first
      </TableCaption>
      <TableHeader className="text-left text-muted-foreground text-xs">
        <TableRow>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Date
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Ticker
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Framework
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Provider / model
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Rating
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Entry / stop / target
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Horizon
          </TableHead>
          <TableHead
            className="px-2 text-right text-muted-foreground"
            scope="col"
          >
            Tokens
          </TableHead>
          <TableHead
            className="px-2 text-right text-muted-foreground"
            scope="col"
          >
            Tool calls
          </TableHead>
          <TableHead
            className="px-2 text-right text-muted-foreground"
            scope="col"
          >
            Cost
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Status
          </TableHead>
          <TableHead className="px-2 text-muted-foreground" scope="col">
            Flags
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const served = servedModels(run);
          return (
            <TableRow
              className="border-border border-t [&>td]:align-top [&>th]:align-top"
              key={run.id}
            >
              <TableHead
                className="h-auto whitespace-normal px-2 text-left font-normal"
                scope="row"
              >
                <a
                  aria-label={`Open ${run.ticker} run of ${run.decisionDate} (${run.framework})`}
                  className="inline-flex min-h-11 items-center font-mono underline underline-offset-2"
                  href={`/agents/runs/${encodeURIComponent(run.id)}`}
                >
                  {run.decisionDate}
                </a>
              </TableHead>
              <TableCell className="whitespace-normal px-2 py-3 font-medium">
                {run.ticker}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                <FrameworkLabel
                  framework={run.framework}
                  frameworkVersion={run.frameworkVersion}
                />
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                <span className="text-muted-foreground">{run.provider}</span> /{" "}
                {run.model}
                {served.length === 0 ? null : (
                  <span className="block text-muted-foreground text-xs">
                    served: {served.join(", ")}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                <RatingBadge
                  rating={run.rating}
                  ratingSource={run.ratingSource}
                />
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3 font-mono text-xs tabular-nums">
                {formatPrice(run.entryPrice)} / {formatPrice(run.stopPrice)} /{" "}
                {formatPrice(run.targetPrice)}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                {run.horizon ?? "—"}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3 text-right tabular-nums">
                {formatCount(totalTokens(run))}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3 text-right tabular-nums">
                {run.toolCalls}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3 text-right tabular-nums">
                {formatUsd(run.costUsd)}
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                <RunStatusBadge status={run.status} />
              </TableCell>
              <TableCell className="whitespace-normal px-2 py-3">
                <span className="flex flex-wrap gap-1">
                  {run.flags.map((flag) => (
                    <Badge key={flag} variant="secondary">
                      {flag}
                    </Badge>
                  ))}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);

type SearchState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; results: AgentModelRunSearchOutput["results"] }>
  | Readonly<{ type: "error"; message: string }>;

// Snippets are model text: plain text with the matched words in <mark>, never HTML.
const SearchResults = ({
  query,
  state,
}: {
  readonly query: string;
  readonly state: SearchState;
}) => {
  if (state.type === "idle") return null;
  if (state.type === "loading")
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Searching event text…
      </p>
    );
  if (state.type === "error")
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );
  return (
    <section aria-label="Search results" className="space-y-2">
      <h3 className="font-medium text-sm">
        {state.results.length === 0
          ? `No run events mention "${query}".`
          : `${state.results.length} ${state.results.length === 1 ? "run mentions" : "runs mention"} "${query}"`}
      </h3>
      <ul className="space-y-3">
        {state.results.map((result) => (
          <li className="space-y-1" key={result.run.id}>
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-2"
              href={`/agents/runs/${encodeURIComponent(result.run.id)}`}
            >
              {result.run.ticker} · {result.run.decisionDate} ·{" "}
              {result.run.framework} · {result.run.model}
            </a>
            {result.snippets.map((snippet) => (
              <p
                className="whitespace-pre-wrap break-words text-sm"
                key={snippet.seq}
              >
                <span className="text-muted-foreground text-xs">
                  {snippet.agent} · {snippet.kind}:{" "}
                </span>
                {snippet.segments.map((segment, index) =>
                  segment.match ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered.
                    <mark key={index}>{segment.text}</mark>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered.
                    <Fragment key={index}>{segment.text}</Fragment>
                  )
                )}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
};

const RecordingHelp = () => (
  <div className="space-y-1 rounded-md border border-border p-4 text-sm">
    <p className="font-medium">No model runs yet</p>
    <p className="text-muted-foreground">
      Agents record runs with a write API key: call agentModelRuns.record (POST
      /api/openapi/agent-model-runs) or the MCP tool model_runs_record, then
      report status, rating and usage with agentModelRuns.update or
      model_runs_update. See docs/operator.md.
    </p>
  </div>
);

export const AgentModelRunsWorkspace = ({
  gateway: suppliedGateway,
  onDownload = downloadCsv,
}: AgentModelRunsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentModelRunsGateway()
  );
  const [filters, setFilters] = useState<ModelRunFilterState>(
    EMPTY_MODEL_RUN_FILTERS
  );
  const [groupBy, setGroupBy] = useState<AgentModelRunGroupByValue>("model");
  const [state, setState] = useState<ListState>({
    data: null,
    message: "",
    phase: "loading",
  });
  const [breakdown, setBreakdown] = useState<BreakdownState>({
    type: "loading",
  });
  const [more, setMore] = useState<MoreState>({ type: "idle" });
  const [exportNote, setExportNote] = useState("");
  const [exporting, setExporting] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ type: "idle" });
  // Requests follow `applied`, which trails `filters` until changes pause, so typing a
  // date (one valid value per completed year digit) sends one query, not a burst.
  const [applied, setApplied] = useState(filters);
  const request = useRef(0);
  const invalidDates = datesOutOfOrder(filters);
  const invalidApplied = datesOutOfOrder(applied);

  useEffect(() => {
    const timer = setTimeout(() => setApplied(filters), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters]);

  const load = useCallback(async () => {
    if (invalidApplied) return;
    request.current += 1;
    const ticket = request.current;
    setState((current) => ({ ...current, phase: "loading" }));
    setMore({ type: "idle" });
    try {
      const page = await gateway.list(filtersToInput(applied));
      if (ticket !== request.current) return;
      setState({
        data: {
          facets: page.facets,
          nextCursor: page.nextCursor,
          runs: page.runs,
        },
        message: "",
        phase: "ready",
      });
    } catch (error) {
      if (ticket !== request.current) return;
      // The rows on screen belong to the previous filters; never leave them under the new ones.
      setState({
        data: null,
        message: describeModelRunFailure(error),
        phase: isModelRunForbidden(error) ? "forbidden" : "error",
      });
    }
  }, [gateway, applied, invalidApplied]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (invalidApplied) return;
    let current = true;
    setBreakdown({ type: "loading" });
    gateway.breakdown(filtersToInput(applied), groupBy).then(
      (output) => {
        if (current) setBreakdown({ rows: output.rows, type: "ready" });
      },
      (error: unknown) => {
        if (current)
          setBreakdown({
            message: describeModelRunFailure(error),
            type: "error",
          });
      }
    );
    return () => {
      current = false;
    };
  }, [gateway, applied, groupBy, invalidApplied]);

  const loadMore = async (shown: PageData, next: string) => {
    const ticket = request.current;
    setMore({ type: "busy" });
    try {
      const page = await gateway.list(filtersToInput(applied), next);
      if (ticket !== request.current) return;
      setState((latest) => ({
        ...latest,
        data: {
          ...shown,
          nextCursor: page.nextCursor,
          runs: [...shown.runs, ...page.runs],
        },
      }));
      setMore({ type: "idle" });
    } catch (error) {
      setMore({ message: describeModelRunFailure(error), type: "error" });
    }
  };

  const exportRuns = async () => {
    setExporting(true);
    setExportNote("");
    try {
      const output = await gateway.exportCsv(filtersToInput(applied));
      onDownload(output);
      setExportNote(
        output.truncated
          ? `Exported the first ${output.rowCount} runs. Narrow the filters to export the rest.`
          : `Exported ${output.rowCount} ${output.rowCount === 1 ? "run" : "runs"}.`
      );
    } catch (error) {
      setExportNote(describeModelRunFailure(error));
    } finally {
      setExporting(false);
    }
  };

  // Event text search runs over the same filters and follows filter changes.
  useEffect(() => {
    if (query === "" || invalidApplied) {
      setSearch({ type: "idle" });
      return;
    }
    let current = true;
    setSearch({ type: "loading" });
    gateway.search(query, filtersToInput(applied)).then(
      (output) => {
        if (current) setSearch({ results: output.results, type: "ready" });
      },
      (error: unknown) => {
        if (current)
          setSearch({ message: describeModelRunFailure(error), type: "error" });
      }
    );
    return () => {
      current = false;
    };
  }, [gateway, query, applied, invalidApplied]);

  const toggle = (facet: AgentModelRunFacetName, value: string) =>
    setFilters((current) => toggleFacetValue(current, facet, value));
  const active = activeFilterCount(filters);

  const data = state.data;
  const cursor = data === null ? null : data.nextCursor;
  if (state.phase === "forbidden")
    return (
      <section aria-label="Model runs" className="space-y-3">
        <SectionHeader title="Model runs" />
        <OperatorAccessRequired feature="agent-runs" />
      </section>
    );

  return (
    <section aria-label="Model runs" className="space-y-4">
      <SectionHeader
        actions={
          <Button
            disabled={exporting || data === null}
            onClick={() => void exportRuns()}
            variant="secondary"
          >
            <Download aria-hidden="true" className="size-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        }
        title="Model runs"
      />
      <ResearchOnlyNote />
      {exportNote === "" ? null : (
        <p className="text-sm" role="status">
          {exportNote}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Decision from</span>
          <Input
            aria-invalid={invalidDates}
            onChange={(event) =>
              setFilters({ ...filters, decisionFrom: event.target.value })
            }
            type="date"
            value={filters.decisionFrom}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Decision to</span>
          <Input
            aria-invalid={invalidDates}
            onChange={(event) =>
              setFilters({ ...filters, decisionTo: event.target.value })
            }
            type="date"
            value={filters.decisionTo}
          />
        </label>
        {active === 0 ? null : (
          <Button
            onClick={() => setFilters(EMPTY_MODEL_RUN_FILTERS)}
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Clear {active} {active === 1 ? "filter" : "filters"}
          </Button>
        )}
        <p className="min-h-5 text-muted-foreground text-xs" role="status">
          {data !== null && (state.phase === "loading" || applied !== filters)
            ? "Updating…"
            : ""}
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(searchText.trim());
        }}
        role="search"
      >
        <label className="min-w-64 flex-1 space-y-1 text-xs">
          <span className="text-muted-foreground">Search event text</span>
          <Input
            maxLength={200}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="support level, earnings, stop loss"
            type="search"
            value={searchText}
          />
        </label>
        <Button type="submit" variant="secondary">
          <Search aria-hidden="true" className="size-4" />
          Search
        </Button>
        {query === "" ? null : (
          <Button
            onClick={() => {
              setSearchText("");
              setQuery("");
            }}
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
            Clear search
          </Button>
        )}
      </form>
      {invalidDates ? (
        <p className="text-destructive text-sm" role="alert">
          The from date is after the to date.
        </p>
      ) : null}
      {data === null && state.phase === "loading" ? (
        <div aria-busy="true" className="space-y-2" role="status">
          <span className="sr-only">Loading model runs</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      {state.phase === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-destructive text-sm">{state.message}</p>
          <Button onClick={() => void load()} variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Retry
          </Button>
        </div>
      ) : null}
      {data === null ? null : (
        <div
          aria-busy={state.phase === "loading"}
          className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
        >
          <aside aria-label="Filters" className="space-y-4">
            {LIST_FACETS.map((facet) => {
              const counts = data.facets[facet];
              const selected = filters.facets[facet] ?? [];
              return counts.length === 0 && selected.length === 0 ? null : (
                <FacetGroup
                  counts={counts}
                  facet={facet}
                  key={facet}
                  onToggle={toggle}
                  selected={selected}
                />
              );
            })}
          </aside>
          <div className="min-w-0 space-y-6">
            <SearchResults query={query} state={search} />
            {data.runs.length === 0 ? (
              active === 0 ? (
                <RecordingHelp />
              ) : (
                <div className="space-y-2" role="status">
                  <p className="text-sm">No runs match these filters.</p>
                  <Button
                    onClick={() => setFilters(EMPTY_MODEL_RUN_FILTERS)}
                    variant="secondary"
                  >
                    Clear filters
                  </Button>
                </div>
              )
            ) : (
              <>
                <section aria-label="Breakdown" className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Group by</span>
                    <select
                      className={selectClass}
                      onChange={(event) =>
                        setGroupBy(
                          event.target.value as AgentModelRunGroupByValue
                        )
                      }
                      value={groupBy}
                    >
                      {AGENT_MODEL_RUN_GROUP_BY_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {GROUP_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <BreakdownTable groupBy={groupBy} state={breakdown} />
                </section>
                <RunsTable runs={data.runs} />
                {cursor === null ? null : (
                  <div className="flex items-center gap-3">
                    <Button
                      disabled={more.type === "busy"}
                      onClick={() => void loadMore(data, cursor)}
                      variant="secondary"
                    >
                      {more.type === "busy" ? "Loading…" : "Load more"}
                    </Button>
                    {more.type === "error" ? (
                      <p className="text-destructive text-sm" role="alert">
                        {more.message}
                      </p>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
