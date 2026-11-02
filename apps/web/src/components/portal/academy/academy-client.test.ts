// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => {
  const academy = {
    tickers: vi.fn(async () => ({ tickers: [] })),
    backtest: vi.fn(async (input: unknown) => ({ kind: "backtest", input })),
    deployPreview: vi.fn(async (input: unknown) => ({
      kind: "preview",
      input,
    })),
    deployRequest: vi.fn(async (input: unknown) => ({
      kind: "request",
      input,
    })),
  };
  return {
    academy,
    createApiClient: vi.fn((_options: { baseUrl: string }) => ({ academy })),
  };
});

vi.mock("@darkfactory/api", () => ({
  createApiClient: apiMock.createApiClient,
}));

import { createBrowserAcademyGateway, errorMessage } from "./academy-client.ts";

describe("createBrowserAcademyGateway", () => {
  it("creates one client lazily against the page origin and forwards every procedure", async () => {
    const gateway = createBrowserAcademyGateway();
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(apiMock.createApiClient).not.toHaveBeenCalled();
    expect(await gateway.tickers()).toEqual({ tickers: [] });
    const backtestInput = {
      slug: "s",
      ticker: "SPY",
      start: "2020-01-01",
      end: "2021-01-01",
      rules: {},
      capital: 1000,
    };
    expect(await gateway.backtest(backtestInput)).toEqual({
      kind: "backtest",
      input: backtestInput,
    });
    const deployInput = {
      slug: "s",
      ticker: "SPY",
      allocationPct: 5,
      riskPerTradePct: 20,
      tranches: 2,
      rules: {},
    };
    expect(await gateway.deployPreview(deployInput)).toEqual({
      kind: "preview",
      input: deployInput,
    });
    expect(await gateway.deployRequest(deployInput)).toEqual({
      kind: "request",
      input: deployInput,
    });
    expect(apiMock.createApiClient).toHaveBeenCalledTimes(1);
    expect(apiMock.createApiClient).toHaveBeenCalledWith({
      baseUrl: window.location.origin,
    });
  });
});

describe("errorMessage", () => {
  it("uses a string message and falls back otherwise", () => {
    expect(errorMessage(new Error("Boom"))).toBe("Boom");
    expect(errorMessage({ message: "Plain" })).toBe("Plain");
    expect(errorMessage({ message: 4 })).toBe("Request failed");
    expect(errorMessage({})).toBe("Request failed");
    expect(errorMessage("text")).toBe("Request failed");
    expect(errorMessage(null)).toBe("Request failed");
  });
});
