import { describe, expect, it } from "vitest";

import { buyZoneText } from "./watchlist-research.tsx";

describe("buyZoneText", () => {
  it("names a missing bound instead of a dash", () => {
    expect(buyZoneText("100", "120")).toBe("100 – 120");
    expect(buyZoneText("100", null)).toBe("from 100 (no upper bound set)");
    expect(buyZoneText(null, "120")).toBe("up to 120 (no lower bound set)");
    expect(buyZoneText(null, null)).toBe("Not set");
  });
});
