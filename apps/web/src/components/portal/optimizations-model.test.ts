import { describe, expect, it } from "vitest";

import { formatScore, trialScoreText } from "./optimizations-model.ts";

describe("optimization score text", () => {
  it("keeps not scored, non-finite and a value distinct", () => {
    expect(formatScore(null)).toBe("Not scored");
    expect(formatScore(undefined)).toBe("Not scored");
    expect(formatScore(Number.NaN)).toBe("Non-finite score");
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe("Non-finite score");
    expect(formatScore(1.5)).toBe("1.5");
  });

  it("names a failed trial as the reason it has no score", () => {
    expect(trialScoreText("failed", null)).toBe("Not scored (trial failed)");
    expect(trialScoreText("ok", null)).toBe("Not scored");
    expect(trialScoreText("ok", 0.25)).toBe("0.25");
  });
});
