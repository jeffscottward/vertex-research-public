import { describe, expect, it } from "vitest";

import type { DatabaseExecutor } from "./client.ts";
import {
  isVirtualDailySeries,
  loadVirtualDailySeries,
} from "./virtual-daily-series.ts";

describe("virtual daily series", () => {
  it("knows NYSE_UPVOL_PCT and no stored series id", () => {
    expect(isVirtualDailySeries("NYSE_UPVOL_PCT")).toBe(true);
    expect(isVirtualDailySeries("QQQ")).toBe(false);
  });

  it("reads nothing for an id that is not virtual", async () => {
    const database = {
      select: () => {
        throw new Error("no read expected");
      },
    } as unknown as DatabaseExecutor;
    await expect(loadVirtualDailySeries(database, "QQQ", {})).resolves.toEqual(
      []
    );
  });
});
