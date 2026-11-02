// @vitest-environment jsdom
import type { AgentModelRunOutput } from "@darkfactory/api";
import { describe, expect, it, vi } from "vitest";

import {
  activeFilterCount,
  createBrowserAgentModelRunsGateway,
  datesOutOfOrder,
  describeModelRunFailure,
  downloadCsv,
  EMPTY_MODEL_RUN_FILTERS,
  facetValueLabel,
  filtersToInput,
  formatCount,
  formatPrice,
  formatShare,
  formatUsd,
  isAdjustedVersion,
  isModelRunForbidden,
  LIST_FACETS,
  servedModels,
  toggleFacetValue,
  totalTokens,
} from "./agent-model-runs-client.ts";

const { calls, createApiClient } = vi.hoisted(() => {
  const calls: Readonly<{ name: string; input: unknown }>[] = [];
  const record =
    (name: string) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ input, name });
      return { name };
    };
  const createApiClient = vi.fn((_options: unknown) => ({
    agentModelRuns: {
      breakdown: record("breakdown"),
      events: record("events"),
      exportCsv: record("exportCsv"),
      get: record("get"),
      list: record("list"),
      search: record("search"),
    },
  }));
  return { calls, createApiClient };
});

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient,
}));

describe("browser model runs gateway", () => {
  it("calls agentModelRuns.* through one lazily created client", async () => {
    const gateway = createBrowserAgentModelRunsGateway();
    expect(createApiClient).not.toHaveBeenCalled();
    await gateway.list({ ticker: ["AAPL"] });
    await gateway.list({}, "cursor-1");
    await gateway.breakdown({ status: ["failed"] }, "model");
    await gateway.exportCsv({ batch: "grid-1" });
    await gateway.get("run-1");
    await gateway.events("run-1", 4);
    await gateway.search("support", { ticker: ["AAPL"] });
    expect(createApiClient).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { input: { limit: 50, ticker: ["AAPL"] }, name: "list" },
      { input: { cursor: "cursor-1", limit: 50 }, name: "list" },
      { input: { groupBy: "model", status: ["failed"] }, name: "breakdown" },
      { input: { batch: "grid-1" }, name: "exportCsv" },
      { input: { id: "run-1" }, name: "get" },
      { input: { afterSeq: 4, limit: 500, runId: "run-1" }, name: "events" },
      { input: { query: "support", ticker: ["AAPL"] }, name: "search" },
    ]);
  });
});

describe("model run failures", () => {
  it("describes each typed error in plain words", () => {
    expect(isModelRunForbidden({ code: "FORBIDDEN" })).toBe(true);
    expect(isModelRunForbidden(null)).toBe(false);
    expect(describeModelRunFailure({ code: "UNAUTHORIZED" })).toContain(
      "Sign in"
    );
    expect(describeModelRunFailure({ code: "NOT_FOUND" })).toContain(
      "does not exist"
    );
    expect(
      describeModelRunFailure({ code: "VALIDATION_ERROR", message: "bad date" })
    ).toBe("Rejected: bad date");
    expect(describeModelRunFailure({ code: "BAD_REQUEST", message: "" })).toBe(
      "Rejected: invalid filters"
    );
    expect(describeModelRunFailure({ code: "STORAGE_ERROR" })).toContain("503");
    expect(describeModelRunFailure(new Error("x"))).toBe(
      "Request failed. Retry."
    );
  });
});

describe("model run filters", () => {
  it("toggles facet values and counts active filters", () => {
    const one = toggleFacetValue(EMPTY_MODEL_RUN_FILTERS, "rating", "unrated");
    const two = toggleFacetValue(one, "ticker", "AAPL");
    expect(activeFilterCount(two)).toBe(2);
    const dated = {
      ...two,
      decisionFrom: "2026-09-01",
      decisionTo: "2026-09-30",
    };
    expect(activeFilterCount(dated)).toBe(4);
    expect(toggleFacetValue(two, "rating", "unrated").facets.rating).toEqual(
      []
    );
    expect(filtersToInput(dated)).toEqual({
      decisionFrom: "2026-09-01",
      decisionTo: "2026-09-30",
      rating: ["unrated"],
      ticker: ["AAPL"],
    });
    expect(filtersToInput(EMPTY_MODEL_RUN_FILTERS)).toEqual({});
    expect(datesOutOfOrder(dated)).toBe(false);
    expect(datesOutOfOrder({ ...dated, decisionFrom: "2026-10-01" })).toBe(
      true
    );
    expect(datesOutOfOrder({ ...dated, decisionTo: "" })).toBe(false);
  });

  it("keeps the single-value batch filter out of the list facets", () => {
    expect(LIST_FACETS).not.toContain("batch");
    expect(LIST_FACETS).toContain("ticker");
  });

  it("labels facet values", () => {
    expect(facetValueLabel("rating", "unrated")).toBe("Unrated");
    expect(facetValueLabel("rating", "buy")).toBe("buy");
    expect(facetValueLabel("horizonBucket", "quarters_plus")).toBe(
      "Quarter or longer"
    );
    expect(facetValueLabel("ticker", "unknown")).toBe("unknown");
  });
});

describe("model run formatting", () => {
  it("formats money, counts, prices and shares", () => {
    expect(formatUsd(0.1234)).toBe("$0.1234");
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatCount(12_345)).toBe("12.3K");
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(190.5)).toBe("190.5");
    expect(formatShare(null)).toBe("—");
    expect(formatShare(1 / 3)).toBe("33%");
    expect(isAdjustedVersion("0.2.0+abc123")).toBe(true);
    expect(isAdjustedVersion("0.2.0")).toBe(false);
    expect(isAdjustedVersion(null)).toBe(false);
    expect(totalTokens({ inputTokens: 3, outputTokens: 4 })).toBe(7);
    const run = {
      model: "gpt",
      modelsServed: [
        { requested: "gpt", served: "gpt" },
        { requested: "gpt", served: "gpt-2024" },
        { requested: "gpt", served: "gpt-2024" },
      ],
    } as AgentModelRunOutput;
    expect(servedModels(run)).toEqual(["gpt-2024"]);
  });
});

describe("downloadCsv", () => {
  it("saves the CSV through a temporary Blob link", () => {
    const original = {
      createObjectURL: URL.createObjectURL,
      revokeObjectURL: URL.revokeObjectURL,
    };
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    downloadCsv({ csv: "a,b\r\n", filename: "runs.csv" });
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("runs.csv");
    expect(anchor.href).toBe("blob:csv");
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    click.mockRestore();
    Object.assign(URL, original);
  });
});
