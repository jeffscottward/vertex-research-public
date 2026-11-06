import { describe, expect, it } from "vitest";

import { describeOrderFlowFailure } from "./order-flow-client.ts";

const error = (code: string, message = `${code} from server`) => ({
  code,
  message,
});
const context = {
  exchange: "SMART",
  symbol: "SPY",
  view: "depth",
} as const;

describe("describeOrderFlowFailure", () => {
  it("says the account has no L2 depth for the venue on a depth ENTITLEMENT", () => {
    const failure = describeOrderFlowFailure(error("ENTITLEMENT"), context);
    expect(failure.code).toBe("ENTITLEMENT");
    expect(failure.message).toContain(
      "The IBKR account has no L2 market depth permission for SPY on SMART"
    );
    expect(failure.message).toContain("subscriptions are not active");
    expect(failure.message).toContain("no prices are inferred");
    expect(failure.detail).toBe("ENTITLEMENT from server");
  });

  it("words ENTITLEMENT for ticks and bars without mentioning L2", () => {
    const ticks = describeOrderFlowFailure(error("ENTITLEMENT"), {
      ...context,
      exchange: "CME",
      symbol: "ES",
      view: "ticks",
    });
    expect(ticks.message).toContain("historical trade prints for ES on CME");
    expect(ticks.message).not.toContain("L2");
    const bars = describeOrderFlowFailure(error("ENTITLEMENT"), {
      ...context,
      view: "bars",
    });
    expect(bars.message).toContain("no TPO profile is shown");
  });

  it("maps PACED, UNAVAILABLE, NOT_CONFIGURED and NOT_FOUND to operator text", () => {
    expect(
      describeOrderFlowFailure(error("PACED"), { ...context, view: "ticks" })
        .message
    ).toMatch(/IBKR pacing.*trade prints were not fetched.*refresh/);
    expect(
      describeOrderFlowFailure(error("UNAVAILABLE"), context).message
    ).toContain("history service (QuantVPS IB Gateway) is unavailable");
    expect(
      describeOrderFlowFailure(error("NOT_CONFIGURED"), context).message
    ).toContain("not configured on this server");
    expect(describeOrderFlowFailure(error("NOT_FOUND"), context).message).toBe(
      "No IBKR contract matched SPY on SMART; check the symbol, exchange and contract month."
    );
  });

  it("keeps the server text for other codes and unknown errors", () => {
    expect(
      describeOrderFlowFailure(error("UPSTREAM_ERROR", "boom"), context)
    ).toEqual({ code: "UPSTREAM_ERROR", detail: "boom", message: "boom" });
    expect(describeOrderFlowFailure(new Error("network"), context)).toEqual({
      code: "ERROR",
      detail: "network",
      message: "network",
    });
  });
});
