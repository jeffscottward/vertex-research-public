import type { WatchlistItemOutput } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import { type ListState, mapReadyItems } from "./watchlist-list-state.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const row = (symbol: string): WatchlistItemOutput => ({
  buyZoneHigh: null,
  buyZoneLow: null,
  createdAt: at,
  id: `id-${symbol}`,
  note: null,
  symbol,
  updatedAt: at,
});

describe("mapReadyItems", () => {
  it("changes only a ready list", () => {
    const ready: ListState = { items: [row("AAA"), row("BBB")], type: "ready" };
    expect(
      mapReadyItems(ready, (items) =>
        items.filter((item) => item.symbol !== "AAA")
      )
    ).toEqual({ items: [row("BBB")], type: "ready" });
    const loading: ListState = { type: "loading" };
    expect(mapReadyItems(loading, () => [])).toBe(loading);
    const error: ListState = { message: "down", type: "error" };
    expect(mapReadyItems(error, () => [])).toBe(error);
  });
});
