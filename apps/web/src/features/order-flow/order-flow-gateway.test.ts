// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => {
  const marketData = {
    depth: vi.fn(async (input: unknown) => ({ kind: "depth", input })),
    ticks: vi.fn(async (input: unknown) => ({ kind: "ticks", input })),
  };
  return {
    createApiClient: vi.fn((_options: { baseUrl: string }) => ({
      marketData,
    })),
    marketData,
  };
});

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createApiClient: apiMock.createApiClient,
}));

import { createBrowserOrderFlowGateway } from "./order-flow-client.ts";

describe("createBrowserOrderFlowGateway", () => {
  it("creates one client lazily against the page origin and forwards ticks and depth", async () => {
    const gateway = createBrowserOrderFlowGateway();
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(apiMock.createApiClient).not.toHaveBeenCalled();
    const ticksInput = { symbol: "SPY" };
    expect(await gateway.ticks(ticksInput)).toEqual({
      input: ticksInput,
      kind: "ticks",
    });
    const depthInput = {
      exchange: "CME",
      secType: "FUT" as const,
      symbol: "ES",
    };
    expect(await gateway.depth(depthInput)).toEqual({
      input: depthInput,
      kind: "depth",
    });
    expect(apiMock.createApiClient).toHaveBeenCalledTimes(1);
    expect(apiMock.createApiClient).toHaveBeenCalledWith({
      baseUrl: window.location.origin,
    });
  });
});
