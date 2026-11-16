import { describe, expect, it } from "vitest";

import { sinceClock } from "../../components/portal/portfolio-monitor-model.ts";
import {
  createHistoryServiceWatch,
  PACED_RETRY_DEFAULT_SECONDS,
  PACED_RETRY_MAX_SECONDS,
  pacedRetryDelayMs,
} from "./order-flow-client.ts";

const error = (code: string, message = `${code} from server`) => ({
  code,
  message,
});
const context = {
  exchange: "SMART",
  symbol: "SPY",
  view: "depth",
} as const;
const NOW = Date.UTC(2026, 10, 2, 19, 2, 0);
/** The text of one failure for a panel with no earlier request. */
const describeOrderFlowFailure = (
  failure: unknown,
  at: Parameters<ReturnType<typeof createHistoryServiceWatch>["describe"]>[1]
) => createHistoryServiceWatch(() => NOW).describe(failure, at);

describe("createHistoryServiceWatch describe", () => {
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

  it("maps PACED, NOT_CONFIGURED and NOT_FOUND to operator text", () => {
    expect(
      describeOrderFlowFailure(error("PACED"), { ...context, view: "ticks" })
        .message
    ).toMatch(/IBKR pacing.*trade prints were not fetched.*refresh/);
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

describe("createHistoryServiceWatch", () => {
  const ticks = { ...context, view: "ticks" } as const;

  it("names since when the panel's requests fail and that none succeeded yet", () => {
    const failure = createHistoryServiceWatch(() => NOW).describe(
      error("UNAVAILABLE"),
      ticks
    );
    expect(failure).toEqual({
      code: "UNAVAILABLE",
      detail: "UNAVAILABLE from server",
      message: `IBKR history service (QuantVPS IB Gateway), as of ${sinceClock(NOW, NOW)}: every request of this panel has failed since ${sinceClock(NOW, NOW)} · no successful request in this panel yet · trade prints not fetched, nothing shown here is estimated · press Refresh to try again`,
    });
  });

  it("keeps the first failure time until a request succeeds, then names the last success", async () => {
    let at = NOW;
    const service = createHistoryServiceWatch(() => at);
    service.describe(error("UNAVAILABLE"), ticks);
    at = NOW + 120_000;
    // A failure with another code is no proof that the service works: the run goes on.
    service.describe(error("PACED"), ticks);
    expect(service.describe(error("UNAVAILABLE"), ticks).message).toContain(
      `as of ${sinceClock(at, at)}: every request of this panel has failed since ${sinceClock(NOW, at)} · no successful request in this panel yet`
    );
    at = NOW + 180_000;
    await expect(service.watch(async (n: number) => n + 1)(1)).resolves.toBe(2);
    at = NOW + 300_000;
    expect(service.describe(error("UNAVAILABLE"), context).message).toContain(
      `has failed since ${sinceClock(NOW + 300_000, at)} · last successful request ${sinceClock(NOW + 180_000, at)} · the order book not fetched`
    );
  });

  it("passes a failed request through and records no success for it", async () => {
    const service = createHistoryServiceWatch(() => NOW);
    const boom = new Error("boom");
    await expect(
      service.watch(async () => {
        throw boom;
      })(0)
    ).rejects.toBe(boom);
    expect(service.describe(error("UNAVAILABLE"), context).message).toContain(
      "no successful request in this panel yet"
    );
  });
});

describe("pacedRetryDelayMs", () => {
  const paced = (detail: string, code = "PACED") => ({
    code,
    detail,
    message: "m",
  });

  it("waits the seconds the history service names", () => {
    expect(pacedRetryDelayMs(paced("IBKR history pacing: retry in 11 s"))).toBe(
      11_000
    );
    expect(pacedRetryDelayMs(paced("IBKR history pacing: retry in 0 s"))).toBe(
      1000
    );
  });

  it("waits the default spacing when the service names no wait", () => {
    expect(pacedRetryDelayMs(paced("IBKR history pacing: retry later"))).toBe(
      PACED_RETRY_DEFAULT_SECONDS * 1000
    );
  });

  it("does not retry past the cap or for other failures", () => {
    expect(
      pacedRetryDelayMs(paced(`retry in ${PACED_RETRY_MAX_SECONDS + 1} s`))
    ).toBeNull();
    expect(
      pacedRetryDelayMs(paced(`retry in ${PACED_RETRY_MAX_SECONDS} s`))
    ).toBe(PACED_RETRY_MAX_SECONDS * 1000);
    expect(pacedRetryDelayMs(paced("retry in 3 s", "UNAVAILABLE"))).toBeNull();
  });
});
