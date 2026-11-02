"use client";

import {
  AGENT_MODEL_BENCHMARK_ARM_BY_VALUES,
  type AgentModelBenchmarkArmByValue,
  type AgentModelBenchmarkInput,
  type AgentModelBenchmarkOutput,
  type AgentModelRunFacetsOutput,
  type AgentModelRunFiltersInput,
  type ApiClient,
  createApiClient,
} from "@darkfactory/api";

import {
  filtersToInput,
  type ListFacetName,
  type ModelRunFilterState,
} from "./agent-model-runs-client.ts";

// Operator read of the model benchmark (agentModelRuns.benchmark) and of the facet counts that feed
// its filters (agentModelRuns.list with one run). Research only: no order path.

export interface AgentModelBenchmarkGateway {
  readonly benchmark: (
    input: AgentModelBenchmarkInput
  ) => Promise<AgentModelBenchmarkOutput>;
  readonly facets: (
    filters: AgentModelRunFiltersInput
  ) => Promise<AgentModelRunFacetsOutput>;
}

const createAgentModelBenchmarkGateway = (
  client: ApiClient
): AgentModelBenchmarkGateway => ({
  benchmark: (input) => client.agentModelRuns.benchmark(input),
  facets: async (filters) =>
    (
      await client.agentModelRuns.list({
        ...filters,
        includeFacets: true,
        limit: 1,
      })
    ).facets,
});

export const createBrowserAgentModelBenchmarkGateway =
  (): AgentModelBenchmarkGateway => {
    let gateway: AgentModelBenchmarkGateway | undefined;
    const current = (): AgentModelBenchmarkGateway => {
      gateway ??= createAgentModelBenchmarkGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway;
    };
    return Object.freeze({
      benchmark: (input: AgentModelBenchmarkInput) =>
        current().benchmark(input),
      facets: (filters: AgentModelRunFiltersInput) => current().facets(filters),
    });
  };

export const ARM_BY_LABELS: Readonly<
  Record<AgentModelBenchmarkArmByValue, string>
> = Object.freeze({
  framework: "Framework",
  model: "Model",
  provider_model: "Provider and model",
  servedModel: "Served model",
  variant: "Variant",
});

export const ARM_BY_OPTIONS = AGENT_MODEL_BENCHMARK_ARM_BY_VALUES;

/** Facets shown as filters on the benchmark page (rating and horizon would bias the comparison). */
export const BENCHMARK_FACETS: readonly ListFacetName[] = Object.freeze([
  "framework",
  "provider",
  "model",
  "servedModel",
  "ticker",
  "purpose",
  "variant",
  "flags",
]);

export type BenchmarkSettings = Readonly<{
  filters: ModelRunFilterState;
  batch: string;
  armBy: AgentModelBenchmarkArmByValue;
  baselineArm: string;
  control: string;
  treatment: string;
}>;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = Object.freeze({
  armBy: "model",
  baselineArm: "",
  batch: "",
  control: "",
  filters: Object.freeze({ decisionFrom: "", decisionTo: "", facets: {} }),
  treatment: "",
});

/** The filters for agentModelRuns.list (facets): the facet selection plus the batch. */
export const benchmarkFilters = (
  settings: BenchmarkSettings
): AgentModelRunFiltersInput => ({
  ...filtersToInput(settings.filters),
  ...(settings.batch === "" ? {} : { batch: settings.batch }),
});

/** The benchmark input; the pair is sent only when both arms are chosen and differ. */
export const benchmarkInput = (
  settings: BenchmarkSettings
): AgentModelBenchmarkInput => {
  const pairReady =
    settings.control !== "" &&
    settings.treatment !== "" &&
    settings.control !== settings.treatment;
  return {
    ...benchmarkFilters(settings),
    armBy: settings.armBy,
    ...(settings.baselineArm === ""
      ? {}
      : { baselineArm: settings.baselineArm }),
    ...(pairReady
      ? { pair: { control: settings.control, treatment: settings.treatment } }
      : {}),
  };
};

/** Arm keys change with the grouping, so a new grouping clears the baseline and the pair. */
export const withArmBy = (
  settings: BenchmarkSettings,
  armBy: AgentModelBenchmarkArmByValue
): BenchmarkSettings => ({
  ...settings,
  armBy,
  baselineArm: "",
  control: "",
  treatment: "",
});

/** Five agreement bands for the matrix colour scale; the number is always printed too. */
export const agreementBand = (share: number | null): string => {
  if (share === null) return "bg-muted/30 text-muted-foreground";
  if (share >= 0.8) return "bg-emerald-500/40";
  if (share >= 0.6) return "bg-emerald-500/25";
  if (share >= 0.4) return "bg-amber-500/25";
  if (share >= 0.2) return "bg-orange-500/25";
  return "bg-red-500/25";
};

export const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
};

export const formatPValue = (value: number): string =>
  value < 0.0001 ? "< 0.0001" : value.toFixed(4);

export const formatDistance = (value: number | null): string =>
  value === null ? "—" : value.toFixed(2);
