import { describe, expect, it } from "vitest";

import { describeWatchlistFailure } from "./watchlist-client.ts";

describe("describeWatchlistFailure", () => {
  it("names the 503 outage with its time and outcome", () => {
    const at = new Date(2026, 10, 15, 9, 30).getTime();
    expect(describeWatchlistFailure({ code: "STORAGE_ERROR" }, at)).toBe(
      "Watchlist database did not answer at 09:30 (503). Nothing was saved."
    );
  });
});
