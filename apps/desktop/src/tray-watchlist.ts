// What: the menu-bar (tray) watchlist. Lists the signed-in user's watchlist symbols with the last
// daily close, the change from the close before and an "in buy zone" mark, refreshed on a timer.
// A symbol opens its chart; the menu also opens workspaces, sends a test notification and quits.
// Research display only: no order, arm or risk control is reachable from the tray.
// Used by: app.ts.
import { MarketSymbolSchema } from "@darkfactory/api";

import {
  type DailyQuote,
  type DesktopApi,
  DesktopApiError,
  type WatchlistEntry,
} from "./desktop-api.ts";
import type { EveryPort, MenuItemModel, TrayPort } from "./ports.ts";
import { WORKSPACES, type WorkspaceId } from "./workspaces.ts";

/** Rows shown (and priced) in the menu; the rest are one "more" item. */
export const TRAY_MAX_ROWS = 15;
export const TRAY_REFRESH_MS = 10 * 60_000;

export type WatchlistRow = Readonly<{
  entry: WatchlistEntry;
  quote: DailyQuote | null | "pending";
}>;

export type WatchlistTrayState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "signed-out" }>
  | Readonly<{ type: "unavailable" }>
  | Readonly<{
      type: "ready";
      rows: readonly WatchlistRow[];
      total: number;
    }>;

export type TrayActions = Readonly<{
  openWorkspace: (id: WorkspaceId, path?: string) => void;
  refresh: () => void;
  sendTestNotification: () => void;
  quit: () => void;
}>;

const inBuyZone = (entry: WatchlistEntry, last: number): boolean => {
  if (entry.buyZoneLow === null || entry.buyZoneHigh === null) return false;
  return last >= Number(entry.buyZoneLow) && last <= Number(entry.buyZoneHigh);
};

/** "SPY  512.30  +0.42%  · in buy zone"; "…" while loading, "—" when there is no quote. */
export const rowLabel = (row: WatchlistRow): string => {
  const { symbol } = row.entry;
  if (row.quote === "pending") return `${symbol}  …`;
  if (row.quote === null) return `${symbol}  —`;
  const { last, previousClose } = row.quote;
  const parts = [symbol, last.toFixed(2)];
  if (previousClose !== null && previousClose !== 0) {
    const change = ((last - previousClose) / previousClose) * 100;
    parts.push(`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`);
  }
  if (inBuyZone(row.entry, last)) parts.push("· in buy zone");
  return parts.join("  ");
};

const headerItems = (
  state: WatchlistTrayState,
  actions: TrayActions
): MenuItemModel[] => {
  switch (state.type) {
    case "loading":
      return [{ enabled: false, label: "Loading watchlist…", type: "item" }];
    case "signed-out":
      return [
        {
          label: "Sign in to Vertex to see your watchlist",
          onClick: () => actions.openWorkspace("dashboard"),
          type: "item",
        },
      ];
    case "unavailable":
      return [
        {
          enabled: false,
          label: "Watchlist unavailable; retrying",
          type: "item",
        },
      ];
    case "ready": {
      if (state.total === 0)
        return [
          {
            enabled: false,
            label: "No symbols on your watchlist",
            type: "item",
          },
        ];
      const rows: MenuItemModel[] = state.rows.map((row) => ({
        label: rowLabel(row),
        onClick: () =>
          MarketSymbolSchema.safeParse(row.entry.symbol).success
            ? actions.openWorkspace(
                "charts",
                `/charts?symbol=${encodeURIComponent(row.entry.symbol)}`
              )
            : actions.openWorkspace("watchlist"),
        type: "item",
      }));
      const more = state.total - state.rows.length;
      return [
        { enabled: false, label: `Watchlist (${state.total})`, type: "item" },
        ...rows,
        ...(more > 0
          ? [
              {
                label: `${more} more in Watchlist…`,
                onClick: () => actions.openWorkspace("watchlist"),
                type: "item",
              } as const,
            ]
          : []),
      ];
    }
  }
};

/** The whole tray menu for `state`. */
export const trayMenu = (
  state: WatchlistTrayState,
  actions: TrayActions
): MenuItemModel[] => [
  ...headerItems(state, actions),
  { type: "separator" },
  {
    label: "Open Watchlist",
    onClick: () => actions.openWorkspace("watchlist"),
    type: "item",
  },
  {
    items: WORKSPACES.map((workspace) => ({
      label: workspace.label,
      onClick: () => actions.openWorkspace(workspace.id),
      type: "item",
    })),
    label: "Open workspace",
    type: "submenu",
  },
  { type: "separator" },
  { label: "Refresh watchlist", onClick: actions.refresh, type: "item" },
  {
    label: "Send test notification",
    onClick: actions.sendTestNotification,
    type: "item",
  },
  { type: "separator" },
  { label: "Quit Vertex", onClick: actions.quit, type: "item" },
];

export const trayToolTip = (state: WatchlistTrayState): string =>
  state.type === "ready"
    ? `Vertex watchlist: ${state.total} ${state.total === 1 ? "symbol" : "symbols"}`
    : "Vertex";

export interface TrayWatchlist {
  readonly refresh: () => Promise<void>;
  readonly start: () => void;
  readonly state: () => WatchlistTrayState;
  readonly stop: () => void;
}

export const createTrayWatchlist = (
  options: Readonly<{
    api: DesktopApi;
    tray: TrayPort;
    every: EveryPort;
    actions: Omit<TrayActions, "refresh">;
    refreshMs?: number;
  }>
): TrayWatchlist => {
  let state: WatchlistTrayState = { type: "loading" };
  let inflight: Promise<void> | null = null;
  let stopTimer: (() => void) | null = null;

  const render = (next: WatchlistTrayState) => {
    state = next;
    options.tray.setMenu(trayMenu(state, actions));
    options.tray.setToolTip(trayToolTip(state));
  };

  const load = async () => {
    let entries: readonly WatchlistEntry[];
    try {
      entries = await options.api.watchlist();
    } catch (error) {
      const signedOut =
        error instanceof DesktopApiError && error.failure === "signed-out";
      render({ type: signedOut ? "signed-out" : "unavailable" });
      return;
    }
    const rows: WatchlistRow[] = entries
      .slice(0, TRAY_MAX_ROWS)
      .map((entry) => ({ entry, quote: "pending" }));
    render({ rows, total: entries.length, type: "ready" });
    // One symbol at a time: the history service serialises IBKR requests behind one lock.
    for (const [index, row] of rows.entries()) {
      let quote: DailyQuote | null;
      try {
        quote = await options.api.dailyQuote(row.entry.symbol);
      } catch {
        quote = null;
      }
      rows[index] = { entry: row.entry, quote };
      render({ rows: [...rows], total: entries.length, type: "ready" });
    }
  };

  const refresh = (): Promise<void> => {
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const actions: TrayActions = {
    ...options.actions,
    refresh: () => {
      void refresh();
    },
  };

  return {
    refresh,
    start: () => {
      render(state);
      void refresh();
      stopTimer ??= options.every(options.refreshMs ?? TRAY_REFRESH_MS, () => {
        void refresh();
      });
    },
    state: () => state,
    stop: () => {
      stopTimer?.();
      stopTimer = null;
    },
  };
};
