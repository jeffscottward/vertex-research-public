// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiClient: vi.fn(),
  events: vi.fn(),
}));
vi.mock("@darkfactory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@darkfactory/api")>();
  return {
    ...actual,
    createApiClient: mocks.createApiClient.mockImplementation(() => ({
      flow: { events: mocks.events },
    })),
  };
});

import {
  createBrowserFlowEventsGateway,
  isFlowInstrument,
} from "./flow-events-client.ts";

describe("flow-events-client", () => {
  it("matches collected FLOW_SYMBOLS only with their matching secType", () => {
    expect(isFlowInstrument("SPY", "STK")).toBe(true);
    expect(isFlowInstrument("QQQ", "STK")).toBe(true);
    expect(isFlowInstrument("SPY", "FUT")).toBe(false);
    expect(isFlowInstrument("ES", "CONTFUT")).toBe(true);
    expect(isFlowInstrument("ES", "FUT")).toBe(true);
    expect(isFlowInstrument("NQ", "CONTFUT")).toBe(true);
    expect(isFlowInstrument("NQ", "FUT")).toBe(true);
    // NYSE stock ES (Eversource Energy) must not match CME E-mini S&P 500 futures flow_events.
    expect(isFlowInstrument("ES", "STK")).toBe(false);
    expect(isFlowInstrument("NQ", "STK")).toBe(false);
    expect(isFlowInstrument("NVDA", "STK")).toBe(false);
    expect(isFlowInstrument("toString", "STK")).toBe(false);
  });

  it("lazily creates one ApiClient and forwards flow.events calls", async () => {
    const response = {
      events: [],
      from: "2026-11-09T14:30:00.000Z",
      schemaVersion: "flow-events.v1" as const,
      symbol: "SPY" as const,
      to: "2026-11-09T16:00:00.000Z",
      truncated: false,
    };
    mocks.events.mockResolvedValue(response);
    const gateway = createBrowserFlowEventsGateway();
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    const input = {
      from: "2026-11-09T14:30:00Z",
      kinds: ["stacked_imbalance", "absorption"] as (
        | "stacked_imbalance"
        | "absorption"
      )[],
      symbol: "SPY" as const,
      to: "2026-11-09T16:00:00Z",
    };
    await expect(gateway.events(input)).resolves.toEqual(response);
    await expect(gateway.events(input)).resolves.toEqual(response);
    expect(mocks.createApiClient).toHaveBeenCalledTimes(1);
    expect(mocks.events).toHaveBeenCalledTimes(2);
    expect(mocks.events).toHaveBeenCalledWith(input);
  });
});
