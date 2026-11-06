import { describe, expect, it } from "vitest";

import {
  type MarketSourceStatus,
  summarizeMarketStatus,
} from "./market-source-status.ts";

describe("summarizeMarketStatus", () => {
  it.each<[MarketSourceStatus[], string, string]>([
    [["loading", "loading"], "Loading", "info"],
    [["ready", "loading"], "Loading", "info"],
    [["forbidden", "loading"], "Loading", "info"],
    [["forbidden", "forbidden"], "Operator only", "neutral"],
    [["error", "forbidden"], "Unavailable", "destructive"],
    [["error", "error"], "Unavailable", "destructive"],
    [["ready", "error"], "Partial", "warning"],
    [["forbidden", "stale"], "Partial", "warning"],
    [["ready", "stale"], "Stale", "warning"],
    [["ready", "ready"], "Live", "success"],
  ])("%j → %s", (sources, label, tone) => {
    expect(summarizeMarketStatus(sources)).toEqual({ label, tone });
  });
});
