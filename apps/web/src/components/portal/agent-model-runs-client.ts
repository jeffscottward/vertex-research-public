"use client";

import {
  AGENT_MODEL_RUN_FACET_VALUES,
  AGENT_MODEL_RUN_EVENTS_PAGE_MAX,
  type AgentModelRunBreakdownOutput,
  type AgentModelRunEventsOutput,
  type AgentModelRunExportOutput,
  type AgentModelRunFacetName,
  AgentModelRunFiltersSchema,
  type AgentModelRunFiltersInput,
  type AgentModelRunGetOutput,
  type AgentModelRunGroupByValue,
  type AgentModelRunListOutput,
  type AgentModelRunOutput,
  type AgentModelRunSearchOutput,
  type ApiClient,
  createApiClient,
} from "@darkfactory/api";

// Operator reads of agent model runs (agentModelRuns.*). Agents write runs through an API key or MCP;
// the portal only lists, breaks down, exports and shows them. Research only: no order path.

export interface AgentModelRunsGateway {
  readonly list: (
    filters: AgentModelRunFiltersInput,
    cursor?: string
  ) => Promise<AgentModelRunListOutput>;
  readonly breakdown: (
    filters: AgentModelRunFiltersInput,
    groupBy: AgentModelRunGroupByValue
  ) => Promise<AgentModelRunBreakdownOutput>;
  readonly exportCsv: (
    filters: AgentModelRunFiltersInput
  ) => Promise<AgentModelRunExportOutput>;
  readonly get: (id: string) => Promise<AgentModelRunGetOutput>;
  readonly events: (
    runId: string,
    afterSeq: number
  ) => Promise<AgentModelRunEventsOutput>;
  readonly search: (
    query: string,
    filters: AgentModelRunFiltersInput
  ) => Promise<AgentModelRunSearchOutput>;
}

const MODEL_RUNS_PAGE_SIZE = 50;

const createAgentModelRunsGateway = (
  client: ApiClient
): AgentModelRunsGateway => ({
  breakdown: (filters, groupBy) =>
    client.agentModelRuns.breakdown({ ...filters, groupBy }),
  exportCsv: (filters) => client.agentModelRuns.exportCsv(filters),
  events: (runId, afterSeq) =>
    client.agentModelRuns.events({
      afterSeq,
      limit: AGENT_MODEL_RUN_EVENTS_PAGE_MAX,
      runId,
    }),
  get: (id) => client.agentModelRuns.get({ id }),
  search: (query, filters) =>
    client.agentModelRuns.search({ ...filters, query }),
  list: (filters, cursor) =>
    client.agentModelRuns.list({
      ...filters,
      limit: MODEL_RUNS_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
});

export const createBrowserAgentModelRunsGateway = (): AgentModelRunsGateway => {
  let gateway: AgentModelRunsGateway | undefined;
  const current = (): AgentModelRunsGateway => {
    gateway ??= createAgentModelRunsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    breakdown: (
      filters: AgentModelRunFiltersInput,
      groupBy: AgentModelRunGroupByValue
    ) => current().breakdown(filters, groupBy),
    exportCsv: (filters: AgentModelRunFiltersInput) =>
      current().exportCsv(filters),
    events: (runId: string, afterSeq: number) =>
      current().events(runId, afterSeq),
    get: (id: string) => current().get(id),
    list: (filters: AgentModelRunFiltersInput, cursor?: string) =>
      current().list(filters, cursor),
    search: (query: string, filters: AgentModelRunFiltersInput) =>
      current().search(query, filters),
  });
};

const errorField = (error: unknown, field: string): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value: unknown = Reflect.get(error, field);
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const isModelRunForbidden = (error: unknown): boolean =>
  errorField(error, "code") === "FORBIDDEN";

export const describeModelRunFailure = (error: unknown): string => {
  switch (errorField(error, "code")) {
    case "UNAUTHORIZED":
      return "Session expired. Sign in again.";
    case "NOT_FOUND":
      return "This model run does not exist.";
    case "VALIDATION_ERROR":
    case "BAD_REQUEST":
      return `Rejected: ${errorField(error, "message") ?? "invalid filters"}`;
    case "STORAGE_ERROR":
      return "Model run storage unavailable (503). Retry.";
    default:
      return "Request failed. Retry.";
  }
};

export const FACET_LABELS: Readonly<Record<AgentModelRunFacetName, string>> =
  Object.freeze({
    batch: "Batch",
    flags: "Flags",
    framework: "Framework",
    horizonBucket: "Horizon",
    model: "Model",
    provider: "Provider",
    purpose: "Purpose",
    rating: "Rating",
    servedModel: "Served model",
    status: "Status",
    ticker: "Ticker",
    variant: "Variant",
  });

// Facets that take several values (any of). batch is a single-value filter: the benchmark page picks
// it from its facet list with a select.
export type ListFacetName = Exclude<AgentModelRunFacetName, "batch">;
export const LIST_FACETS: readonly ListFacetName[] = Object.freeze(
  AGENT_MODEL_RUN_FACET_VALUES.filter(
    (facet): facet is ListFacetName => facet !== "batch"
  )
);

const VALUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  days: "Days",
  months: "Months",
  quarters_plus: "Quarter or longer",
  unknown: "Unknown",
  unrated: "Unrated",
  weeks: "Weeks",
});

export const facetValueLabel = (
  facet: AgentModelRunFacetName,
  value: string
): string =>
  (facet === "rating" || facet === "horizonBucket"
    ? VALUE_LABELS[value]
    : undefined) ?? value;

export type FacetSelection = Readonly<
  Partial<Record<AgentModelRunFacetName, readonly string[]>>
>;

export type ModelRunFilterState = Readonly<{
  facets: FacetSelection;
  decisionFrom: string;
  decisionTo: string;
}>;

export const EMPTY_MODEL_RUN_FILTERS: ModelRunFilterState = Object.freeze({
  decisionFrom: "",
  decisionTo: "",
  facets: {},
});

export const toggleFacetValue = (
  state: ModelRunFilterState,
  facet: AgentModelRunFacetName,
  value: string
): ModelRunFilterState => {
  const current = state.facets[facet] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return { ...state, facets: { ...state.facets, [facet]: next } };
};

export const activeFilterCount = (state: ModelRunFilterState): number =>
  LIST_FACETS.reduce(
    (total, facet) => total + (state.facets[facet]?.length ?? 0),
    (state.decisionFrom === "" ? 0 : 1) + (state.decisionTo === "" ? 0 : 1)
  );

// Facet values come from the server, so they always pass the filter schema. Parsing narrows them to
// the enum types without casts; empty selections and empty dates are left out.
export const filtersToInput = (
  state: ModelRunFilterState
): AgentModelRunFiltersInput => {
  const draft: Record<string, unknown> = {};
  for (const facet of LIST_FACETS) {
    const values = state.facets[facet] ?? [];
    if (values.length > 0) draft[facet] = [...values];
  }
  if (state.decisionFrom !== "") draft["decisionFrom"] = state.decisionFrom;
  if (state.decisionTo !== "") draft["decisionTo"] = state.decisionTo;
  return AgentModelRunFiltersSchema.parse(draft);
};

export const datesOutOfOrder = (state: ModelRunFilterState): boolean =>
  state.decisionFrom !== "" &&
  state.decisionTo !== "" &&
  state.decisionFrom > state.decisionTo;

const USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
  style: "currency",
});
const COMPACT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const PRICE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export const formatUsd = (value: number): string => USD.format(value);
export const formatCount = (value: number): string => COMPACT.format(value);
export const formatPrice = (value: number | null): string =>
  value === null ? "—" : PRICE.format(value);
export const formatShare = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

// A version such as "0.2.0+abc123" names a locally adjusted build of the framework.
export const isAdjustedVersion = (version: string | null): boolean =>
  version?.includes("+") === true;

export const totalTokens = (
  run: Pick<AgentModelRunOutput, "inputTokens" | "outputTokens">
): number => run.inputTokens + run.outputTokens;

export const servedModels = (run: AgentModelRunOutput): string[] => [
  ...new Set(
    run.modelsServed
      .map((entry) => entry.served)
      .filter((served) => served !== run.model)
  ),
];

// Saves the CSV through a Blob link; the document is injectable for tests.
export const downloadCsv = (
  output: Pick<AgentModelRunExportOutput, "csv" | "filename">,
  target: Document = document
): void => {
  const url = URL.createObjectURL(
    new Blob([output.csv], { type: "text/csv;charset=utf-8" })
  );
  const link = target.createElement("a");
  link.href = url;
  link.download = output.filename;
  link.rel = "noopener";
  target.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
