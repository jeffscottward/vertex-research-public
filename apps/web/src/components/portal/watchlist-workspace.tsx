"use client";

import {
  splitWatchlistPaste,
  WATCHLIST_MAX_SYMBOLS_PER_ADD,
  type WatchlistItemOutput,
} from "@darkfactory/api";
import { Button, Input, KpiCard, KpiRow, Panel } from "@darkfactory/ui";
import { DataTable } from "@darkfactory/ui/client/data-table";
import {
  ListChecks,
  NotebookPen,
  Pencil,
  Plus,
  Target,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { TickerLink } from "../ticker-link.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";

import {
  createBrowserMarketDataGateway,
  type MarketDataGateway,
} from "./market-data-client.ts";
import {
  createBrowserPortfolioMonitorGateway,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import {
  createBrowserJournalLoader,
  type JournalSource,
} from "./trade-journal-client.ts";
import { capSymbols, normalizeSymbol } from "./watchlist-analytics.ts";
import { useWatchlistBars } from "./watchlist-bars.tsx";
import {
  createBrowserWatchlistGateway,
  describeWatchlistFailure,
  upsertWatchlistRow,
  type WatchlistGateway,
} from "./watchlist-client.ts";
import { WatchlistExposure } from "./watchlist-exposure.tsx";
import { type ListState, mapReadyItems } from "./watchlist-list-state.ts";
import { WatchlistRelationships } from "./watchlist-relationships.tsx";
import { WatchlistResearch } from "./watchlist-research.tsx";
import { WatchlistTabs } from "./watchlist-tabs.tsx";

export interface WatchlistWorkspaceProps {
  readonly gateway?: WatchlistGateway;
  /** Daily bars for the Relationships and Exposure tabs (read on first open). */
  readonly marketData?: MarketDataGateway;
  /** Portfolio positions for the Exposure tab (read on first open). */
  readonly portfolio?: PortfolioMonitorGateway;
  /**
   * Where the Exposure tab reads positions when `portfolio` is not supplied; resolved on the
   * server like the journal (ibkr-monitor preferred). null falls back to portfolioMonitor.
   */
  readonly portfolioSource?: JournalSource | null;
  /**
   * From the page session. Relationships and Exposure read operator-only data (bars, IBKR
   * positions); non-operators see one operator-access message there and send no requests.
   */
  readonly operator?: boolean;
}

const WATCHLIST_VIEWS = [
  "overview",
  "relationships",
  "research",
  "exposure",
] as const;
type WatchlistView = (typeof WATCHLIST_VIEWS)[number];
const VIEW_LABELS: Readonly<Record<WatchlistView, string>> = {
  exposure: "Exposure",
  overview: "Overview",
  relationships: "Relationships",
  research: "Research",
};
type ViewState = Readonly<{
  active: WatchlistView;
  opened: ReadonlySet<WatchlistView>;
}>;

type Draft = Readonly<{ id: string; low: string; high: string; note: string }>;

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const zoneText = (item: WatchlistItemOutput): string => {
  if (item.buyZoneLow === null && item.buyZoneHigh === null) return "—";
  return `${item.buyZoneLow ?? "—"} – ${item.buyZoneHigh ?? "—"}`;
};

// Returns a row-level message when the draft buy zone is invalid; null when it can be sent.
const buyZoneDraftProblem = (low: string, high: string): string | null => {
  const lo = blankToNull(low);
  const hi = blankToNull(high);
  const isNumber = (value: string) => /^\d+(\.\d+)?$/.test(value);
  if (lo !== null && !isNumber(lo)) return "Low must be a positive number.";
  if (hi !== null && !isNumber(hi)) return "High must be a positive number.";
  if (lo !== null && hi !== null && Number(lo) > Number(hi))
    return `Low (${lo}) must be less than or equal to high (${hi}).`;
  return null;
};

export const WatchlistWorkspace = ({
  gateway: suppliedGateway,
  marketData: suppliedMarketData,
  portfolio: suppliedPortfolio,
  portfolioSource = null,
  operator = false,
}: WatchlistWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserWatchlistGateway()
  );
  const [marketData] = useState(
    () => suppliedMarketData ?? createBrowserMarketDataGateway()
  );
  const [portfolio] = useState(
    (): PortfolioMonitorGateway =>
      suppliedPortfolio ??
      (portfolioSource === null
        ? createBrowserPortfolioMonitorGateway()
        : { snapshot: createBrowserJournalLoader(portfolioSource) })
  );
  const [view, setView] = useState<ViewState>({
    active: "overview",
    opened: new Set(["overview"]),
  });
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [paste, setPaste] = useState("");
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ items: await gateway.list(), type: "ready" });
    } catch (error) {
      return setState({
        message: describeWatchlistFailure(error),
        type: "error",
      });
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const add = async (): Promise<void> => {
    const tokens = splitWatchlistPaste(paste);
    if (tokens.length === 0) {
      setFeedback(
        "Nothing to add. Paste symbols separated by commas, spaces or newlines."
      );
      return;
    }
    if (tokens.length > WATCHLIST_MAX_SYMBOLS_PER_ADD) {
      setFeedback(
        `${tokens.length} tokens; limit is ${WATCHLIST_MAX_SYMBOLS_PER_ADD} per add.`
      );
      return;
    }
    setAdding(true);
    try {
      const result = await gateway.add(tokens);
      setState({ items: result.items, type: "ready" });
      const parts = [
        `Added ${result.added.length}`,
        `already listed ${result.existing.length}`,
        `rejected ${result.rejected.length}${result.rejected.length === 0 ? "" : `: ${result.rejected.join(", ")}`}`,
      ];
      setFeedback(parts.join(" · "));
      // Keep rejected tokens in the box so they can be corrected.
      setPaste(result.rejected.join("\n"));
    } catch (error) {
      setFeedback(describeWatchlistFailure(error));
    } finally {
      setAdding(false);
    }
  };

  const save = async (edit: Draft): Promise<void> => {
    const problem = buyZoneDraftProblem(edit.low, edit.high);
    if (problem !== null) {
      setRowError(problem);
      return;
    }
    setRowError(null);
    setBusyId(edit.id);
    try {
      const item = await gateway.update(edit.id, {
        buyZone: { high: blankToNull(edit.high), low: blankToNull(edit.low) },
        note: blankToNull(edit.note),
      });
      setState((current) =>
        mapReadyItems(current, (rows) => upsertWatchlistRow(rows, item))
      );
      setDraft(null);
      setFeedback(`Saved ${item.symbol}`);
    } catch (error) {
      setRowError(describeWatchlistFailure(error));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: WatchlistItemOutput): Promise<void> => {
    setConfirmRemoveId(null);
    setBusyId(item.id);
    try {
      await gateway.remove(item.id);
      setState((current) =>
        mapReadyItems(current, (rows) =>
          rows.filter((row) => row.id !== item.id)
        )
      );
      // Functional update: the row may have gone into edit mode while the removal ran.
      setDraft((current) => (current?.id === item.id ? null : current));
      setFeedback(`Removed ${item.symbol}`);
    } catch (error) {
      setFeedback(describeWatchlistFailure(error));
    } finally {
      setBusyId(null);
    }
  };

  const items = state.type === "ready" ? state.items : null;
  // Bars are read for the first symbols only (one IBKR request each), once a chart tab opens.
  const analysed = useMemo(
    () => capSymbols((items ?? []).map((item) => normalizeSymbol(item.symbol))),
    [items]
  );
  const listed = useMemo(
    () => new Set((items ?? []).map((item) => normalizeSymbol(item.symbol))),
    [items]
  );
  const bars = useWatchlistBars(
    marketData,
    analysed,
    operator &&
      (view.opened.has("relationships") || view.opened.has("exposure"))
  );

  // The analysis tabs need the list; until it is ready they say why.
  const needsList = (
    render: (rows: readonly WatchlistItemOutput[]) => ReactNode
  ): ReactNode =>
    state.type === "loading" ? (
      <p aria-busy="true" className="text-muted-foreground text-sm">
        Loading watchlist…
      </p>
    ) : state.type === "error" ? (
      <p className="text-sm" role="alert">
        {state.message} Retry from the Overview tab.
      </p>
    ) : state.items.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        No symbols. Add tickers on the Overview tab.
      </p>
    ) : (
      render(state.items)
    );

  const overview = (
    <div className="space-y-6">
      {state.type === "ready" ? (
        <KpiRow label="Watchlist summary">
          <KpiCard
            hint="Tracked tickers"
            icon={<ListChecks />}
            label="Symbols"
            value={state.items.length}
          />
          <KpiCard
            hint="Symbols with a buy zone set"
            icon={<Target />}
            label="Buy zones"
            value={
              state.items.filter(
                (item) => item.buyZoneLow !== null || item.buyZoneHigh !== null
              ).length
            }
          />
          <KpiCard
            hint="Symbols with a note"
            icon={<NotebookPen />}
            label="Notes"
            value={
              state.items.filter(
                (item) => item.note !== null && item.note.trim() !== ""
              ).length
            }
          />
        </KpiRow>
      ) : null}
      <Panel headingId="watchlist-add-heading" title="Add symbols">
        <div className="space-y-3">
          <textarea
            aria-label="Symbols to add"
            className="min-h-20 w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
            id="watchlist-paste"
            onChange={(event) => setPaste(event.target.value)}
            placeholder="AAA, BBB.X CCC"
            value={paste}
          />
          <div className="flex items-center gap-3">
            <Button disabled={adding} onClick={() => void add()} type="button">
              <Plus aria-hidden="true" className="size-4" />
              Add symbols
            </Button>
            <span className="text-muted-foreground text-xs">
              Separators: comma, space, newline. Uppercased; duplicates merged;
              invalid tokens listed, not dropped.
            </span>
          </div>
        </div>
      </Panel>
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      <Panel
        flush={state.type === "ready" && state.items.length > 0}
        title={
          state.type === "ready" ? `Symbols (${state.items.length})` : "Symbols"
        }
      >
        {state.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-sm">
            Loading watchlist…
          </p>
        ) : state.type === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm">{state.message}</p>
            <Button
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        ) : state.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No symbols. Paste tickers above to start the list.
          </p>
        ) : (
          <DataTable
            caption={<span className="sr-only">Watchlist symbols</span>}
            className="text-sm"
            columns={[
              {
                cell: (item) => <TickerLink symbol={item.symbol} />,
                header: "Symbol",
                id: "symbol",
                rowHeader: true,
                value: (item) => item.symbol,
              },
              {
                cell: (item) => {
                  const editingDraft =
                    draft !== null && draft.id === item.id ? draft : null;
                  const zoneErrorId =
                    rowError === null ? undefined : `${item.id}-zone-error`;
                  return (
                    <div className="font-mono">
                      {editingDraft ? (
                        <div className="space-y-1">
                          <div className="flex gap-1">
                            <Input
                              aria-describedby={zoneErrorId}
                              aria-invalid={rowError !== null}
                              aria-label={`${item.symbol} buy zone low`}
                              inputMode="decimal"
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  low: event.target.value,
                                })
                              }
                              value={editingDraft.low}
                            />
                            <Input
                              aria-describedby={zoneErrorId}
                              aria-invalid={rowError !== null}
                              aria-label={`${item.symbol} buy zone high`}
                              inputMode="decimal"
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  high: event.target.value,
                                })
                              }
                              value={editingDraft.high}
                            />
                          </div>
                          {rowError !== null && (
                            <p
                              className="text-destructive text-xs"
                              id={`${item.id}-zone-error`}
                              role="alert"
                            >
                              {rowError}
                            </p>
                          )}
                        </div>
                      ) : (
                        zoneText(item)
                      )}
                    </div>
                  );
                },
                header: "Buy zone (low – high)",
                id: "zone",
                value: (item) => item.buyZoneLow,
              },
              {
                cell: (item) => {
                  const editingDraft =
                    draft !== null && draft.id === item.id ? draft : null;
                  return editingDraft ? (
                    <Input
                      aria-label={`${item.symbol} note`}
                      maxLength={500}
                      onChange={(event) =>
                        setDraft({
                          ...editingDraft,
                          note: event.target.value,
                        })
                      }
                      value={editingDraft.note}
                    />
                  ) : (
                    (item.note ?? "—")
                  );
                },
                clamp: true,
                header: "Note",
                id: "note",
                value: (item) => item.note,
              },
              {
                cell: (item) => (
                  <span className="font-mono text-muted-foreground text-xs">
                    {item.updatedAt
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </span>
                ),
                header: "Updated",
                id: "updated",
                value: (item) => item.updatedAt,
              },
              {
                align: "right",
                cell: (item) => {
                  const editingDraft =
                    draft !== null && draft.id === item.id ? draft : null;
                  return editingDraft ? (
                    <span className="inline-flex gap-1">
                      <Button
                        disabled={busyId === item.id}
                        onClick={() => void save(editingDraft)}
                        type="button"
                      >
                        Save
                      </Button>
                      <Button
                        onClick={() => {
                          setDraft(null);
                          return setRowError(null);
                        }}
                        type="button"
                        variant="secondary"
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="inline-flex gap-1">
                      <Button
                        aria-label={`Edit ${item.symbol}`}
                        onClick={() => {
                          setRowError(null);
                          setConfirmRemoveId(null);
                          return setDraft({
                            high: item.buyZoneHigh ?? "",
                            id: item.id,
                            low: item.buyZoneLow ?? "",
                            note: item.note ?? "",
                          });
                        }}
                        type="button"
                        variant="secondary"
                      >
                        <Pencil aria-hidden="true" className="size-4" />
                        Edit
                      </Button>
                      {confirmRemoveId === item.id ? (
                        <>
                          <Button
                            aria-label={`Confirm remove ${item.symbol}`}
                            disabled={busyId === item.id}
                            onClick={() => void remove(item)}
                            type="button"
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                            Confirm remove
                          </Button>
                          <Button
                            aria-label={`Keep ${item.symbol}`}
                            onClick={() => setConfirmRemoveId(null)}
                            type="button"
                            variant="secondary"
                          >
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          aria-label={`Remove ${item.symbol}`}
                          disabled={busyId === item.id}
                          onClick={() => setConfirmRemoveId(item.id)}
                          type="button"
                          variant="secondary"
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          Remove
                        </Button>
                      )}
                    </span>
                  );
                },
                header: <span className="sr-only">Actions</span>,
                id: "actions",
              },
            ]}
            rowKey={(item) => item.id}
            rowProps={(item) => ({ "data-symbol": item.symbol })}
            rows={state.items}
          />
        )}
      </Panel>
    </div>
  );

  const operatorOnly = (render: () => ReactNode): ReactNode =>
    operator ? (
      render()
    ) : (
      <OperatorAccessRequired feature="watchlist-analysis" />
    );

  const content: Readonly<Record<WatchlistView, ReactNode>> = {
    exposure: operatorOnly(() =>
      needsList((rows) => (
        <WatchlistExposure
          bars={bars}
          portfolio={portfolio}
          symbols={analysed}
          totalSymbols={rows.length}
          watchlistSymbols={listed}
        />
      ))
    ),
    overview,
    relationships: operatorOnly(() =>
      needsList((rows) => (
        <WatchlistRelationships
          bars={bars}
          symbols={analysed}
          totalSymbols={rows.length}
        />
      ))
    ),
    research: needsList((rows) => <WatchlistResearch items={rows} />),
  };

  return (
    <WatchlistTabs
      active={view.active}
      label="Watchlist views"
      onSelect={(active) =>
        setView((current) => ({
          active,
          opened: new Set([...current.opened, active]),
        }))
      }
      opened={view.opened}
      tabs={WATCHLIST_VIEWS.map((value) => ({
        content: content[value],
        label: VIEW_LABELS[value],
        value,
      }))}
    />
  );
};
