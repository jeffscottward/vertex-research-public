"use client";

import {
  WATCHLIST_MAX_SYMBOLS_PER_ADD,
  splitWatchlistPaste,
  type WatchlistItemOutput,
} from "@darkfactory/api";
import { Button, Input } from "@darkfactory/ui";
import { DataTable } from "@darkfactory/ui/client/data-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  createBrowserWatchlistGateway,
  describeWatchlistFailure,
  upsertWatchlistRow,
  type WatchlistGateway,
} from "./watchlist-client.ts";

export interface WatchlistWorkspaceProps {
  readonly gateway?: WatchlistGateway;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; items: WatchlistItemOutput[] }>
  | Readonly<{ type: "error"; message: string }>;

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
}: WatchlistWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserWatchlistGateway()
  );
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
      return setState({ type: "ready", items: await gateway.list() });
    } catch (error) {
      return setState({
        type: "error",
        message: describeWatchlistFailure(error),
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
      setState({ type: "ready", items: result.items });
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

  const save = async (): Promise<void> => {
    if (draft === null) return;
    const problem = buyZoneDraftProblem(draft.low, draft.high);
    if (problem !== null) {
      setRowError(problem);
      return;
    }
    setRowError(null);
    setBusyId(draft.id);
    try {
      const item = await gateway.update(draft.id, {
        note: blankToNull(draft.note),
        buyZone: { low: blankToNull(draft.low), high: blankToNull(draft.high) },
      });
      setState((current) =>
        current.type === "ready"
          ? { type: "ready", items: upsertWatchlistRow(current.items, item) }
          : current
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
        current.type === "ready"
          ? {
              type: "ready",
              items: current.items.filter((row) => row.id !== item.id),
            }
          : current
      );
      if (draft?.id === item.id) setDraft(null);
      setFeedback(`Removed ${item.symbol}`);
    } catch (error) {
      setFeedback(describeWatchlistFailure(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="watchlist-add-heading" className="space-y-2">
        <h2 className="font-medium text-sm" id="watchlist-add-heading">
          Add symbols
        </h2>
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
      </section>
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading watchlist…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
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
              id: "symbol",
              header: "Symbol",
              value: (item) => item.symbol,
              cell: (item) => <span className="font-mono">{item.symbol}</span>,
              rowHeader: true,
            },
            {
              id: "zone",
              header: "Buy zone (low – high)",
              value: (item) => item.buyZoneLow,
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
            },
            {
              id: "note",
              header: "Note",
              value: (item) => item.note,
              clamp: true,
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
            },
            {
              id: "updated",
              header: "Updated",
              value: (item) => item.updatedAt,
              cell: (item) => (
                <span className="font-mono text-muted-foreground text-xs">
                  {item.updatedAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              ),
            },
            {
              id: "actions",
              header: <span className="sr-only">Actions</span>,
              align: "right",
              cell: (item) => {
                const editingDraft =
                  draft !== null && draft.id === item.id ? draft : null;
                return editingDraft ? (
                  <span className="inline-flex gap-1">
                    <Button
                      disabled={busyId === item.id}
                      onClick={() => void save()}
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
                          id: item.id,
                          low: item.buyZoneLow ?? "",
                          high: item.buyZoneHigh ?? "",
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
            },
          ]}
          rowKey={(item) => item.id}
          rowProps={(item) => ({ "data-symbol": item.symbol })}
          rows={state.items}
        />
      )}
    </div>
  );
};
