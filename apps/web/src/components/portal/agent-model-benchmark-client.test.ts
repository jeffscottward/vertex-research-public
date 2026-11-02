// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  agreementBand,
  benchmarkFilters,
  benchmarkInput,
  createBrowserAgentModelBenchmarkGateway,
  DEFAULT_BENCHMARK_SETTINGS,
  formatDistance,
  formatDuration,
  formatPValue,
  withArmBy,
} from "./agent-model-benchmark-client.ts";

const { calls, createApiClient } = vi.hoisted(() => {
  const calls: Readonly<{ name: string; input: unknown }>[] = [];
  const createApiClient = vi.fn((_options: unknown) => ({
    agentModelRuns: {
      benchmark: async (input: unknown) => {
        calls.push({ input, name: "benchmark" });
        return { name: "benchmark" };
      },
      list: async (input: unknown) => {
        calls.push({ input, name: "list" });
        return { facets: { name: "facets" } };
      },
    },
  }));
  return { calls, createApiClient };
});

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient,
}));

describe("browser model benchmark gateway", () => {
  it("reads facets and the benchmark through one lazily created client", async () => {
    const gateway = createBrowserAgentModelBenchmarkGateway();
    expect(createApiClient).not.toHaveBeenCalled();
    expect(await gateway.facets({ batch: "grid-1" })).toEqual({
      name: "facets",
    });
    expect(await gateway.benchmark({ armBy: "model" })).toEqual({
      name: "benchmark",
    });
    expect(createApiClient).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      {
        input: { batch: "grid-1", includeFacets: true, limit: 1 },
        name: "list",
      },
      { input: { armBy: "model" }, name: "benchmark" },
    ]);
  });
});

describe("benchmark settings", () => {
  it("builds the filters and the input; the pair needs two different arms", () => {
    expect(benchmarkInput(DEFAULT_BENCHMARK_SETTINGS)).toEqual({
      armBy: "model",
    });
    const settings = {
      ...DEFAULT_BENCHMARK_SETTINGS,
      baselineArm: "A",
      batch: "grid-1",
      control: "A",
      filters: {
        decisionFrom: "2026-09-01",
        decisionTo: "",
        facets: { ticker: ["AAPL"] },
      },
      treatment: "B",
    };
    expect(benchmarkFilters(settings)).toEqual({
      batch: "grid-1",
      decisionFrom: "2026-09-01",
      ticker: ["AAPL"],
    });
    expect(benchmarkInput(settings)).toEqual({
      armBy: "model",
      baselineArm: "A",
      batch: "grid-1",
      decisionFrom: "2026-09-01",
      pair: { control: "A", treatment: "B" },
      ticker: ["AAPL"],
    });
    expect(benchmarkInput({ ...settings, treatment: "A" })).not.toHaveProperty(
      "pair"
    );
    expect(benchmarkInput({ ...settings, control: "" })).not.toHaveProperty(
      "pair"
    );
    expect(benchmarkInput({ ...settings, treatment: "" })).not.toHaveProperty(
      "pair"
    );
    expect(withArmBy(settings, "framework")).toEqual({
      ...settings,
      armBy: "framework",
      baselineArm: "",
      control: "",
      treatment: "",
    });
  });

  it("formats bands, durations, p-values and distances", () => {
    expect(agreementBand(null)).toContain("muted");
    expect(agreementBand(0.9)).toBe("bg-emerald-500/40");
    expect(agreementBand(0.6)).toBe("bg-emerald-500/25");
    expect(agreementBand(0.5)).toBe("bg-amber-500/25");
    expect(agreementBand(0.2)).toBe("bg-orange-500/25");
    expect(agreementBand(0.1)).toBe("bg-red-500/25");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(42_400)).toBe("42 s");
    expect(formatDuration(468_000)).toBe("7.8 min");
    expect(formatPValue(0.021_484_375)).toBe("0.0215");
    expect(formatPValue(1e-9)).toBe("< 0.0001");
    expect(formatDistance(null)).toBe("—");
    expect(formatDistance(4 / 3)).toBe("1.33");
  });
});
