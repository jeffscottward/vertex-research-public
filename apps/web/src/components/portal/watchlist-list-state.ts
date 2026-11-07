// What: the watchlist list state (loading / ready / error) and the one way a finished row
// edit or removal changes it: only a ready list changes; any other state is kept as it is.
// Used by: watchlist-workspace.tsx.

import type { WatchlistItemOutput } from "@darkfactory/api";

export type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; items: WatchlistItemOutput[] }>
  | Readonly<{ type: "error"; message: string }>;

export const mapReadyItems = (
  state: ListState,
  change: (items: WatchlistItemOutput[]) => WatchlistItemOutput[]
): ListState =>
  state.type === "ready"
    ? { items: change(state.items), type: "ready" }
    : state;
