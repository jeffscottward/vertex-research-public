import { describe, expect, it } from "vitest";

import { describeWatchlistFailure } from "./watchlist-client.ts";

describe("describeWatchlistFailure", () => {
  it("shows the server's storage message when it has one", () => {
    expect(
      describeWatchlistFailure({
        code: "STORAGE_ERROR",
        message:
          "Watchlist data could not be read: the database returned an error at 14:05 UTC. Nothing was changed. Try again.",
      })
    ).toBe(
      "Watchlist data could not be read: the database returned an error at 14:05 UTC. Nothing was changed. Try again."
    );
  });

  it("names the 503 outage with its time and outcome", () => {
    const at = new Date(2026, 10, 15, 9, 30).getTime();
    expect(describeWatchlistFailure({ code: "STORAGE_ERROR" }, at)).toBe(
      "Watchlist storage error (503) at 09:30. Reload to check whether the change was saved."
    );
  });
});
