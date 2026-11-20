import { describe, expect, it } from "vitest";

import {
  CAUSE_NO_LOSING_PERIODS,
  notComputed,
  notDefined,
  profitFactorNullText,
} from "./metric-null-text.ts";

describe("metric null text", () => {
  it("names the cause after the kind of missing value", () => {
    expect(notDefined(CAUSE_NO_LOSING_PERIODS)).toBe(
      "Not defined: no losing periods"
    );
    expect(notComputed("run not finished")).toBe(
      "Not computed: run not finished"
    );
  });

  it("tells no closed trades apart from no losing trades for profit factor", () => {
    expect(profitFactorNullText(0)).toBe("Not defined: no closed trades");
    expect(profitFactorNullText(4)).toBe("Not defined: no losing trades");
  });
});
