"use client";

import {
  type ApiClient,
  createApiClient,
  type ResearchStudy,
} from "@darkfactory/api";
import { Button, EmptyState, Skeleton } from "@darkfactory/ui";
import { FlaskConical, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  type FilterStudyViewModel,
  toFilterStudyViewModel,
} from "../../features/research-studies/view-model.ts";
import { FilterStudiesPanel } from "./filter-studies-panel.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Filter studies section of the Backtests page. Loads the ADX/RVOL study from Postgres through
// researchStudies.get (operator-only, like Quant Lab) and renders FilterStudiesPanel. Read-only; new
// runs are stored with `bun run vertex:research-studies:import`.

export const FILTER_STUDY_ID = "adx-rvol-filters";
export const RESEARCH_STUDIES_IMPORT_COMMAND =
  "bun run vertex:research-studies:import";

export interface ResearchStudyGateway {
  readonly get: (id: string) => Promise<ResearchStudy>;
}

export const createBrowserResearchStudyGateway = (): ResearchStudyGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    get: (id: string) => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.researchStudies.get({ id });
    },
  });
};

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "not-found" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; model: FilterStudyViewModel }>;

type PendingState = Exclude<State, Readonly<{ type: "ready" }>>;

const Body = ({
  state,
  onRetry,
}: {
  readonly state: PendingState;
  readonly onRetry: () => void;
}) => {
  if (state.type === "loading")
    return (
      <div aria-busy="true" className="min-h-40 space-y-2" role="status">
        <span className="sr-only">Loading filter studies</span>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (state.type === "forbidden")
    return (
      <p className="min-h-40 text-muted-foreground text-sm" role="status">
        Filter studies are limited to operators.
      </p>
    );
  if (state.type === "not-found")
    return (
      <EmptyState
        description={
          <>
            Store one with <code>{RESEARCH_STUDIES_IMPORT_COMMAND}</code>.
          </>
        }
        headingLevel={3}
        icon={<FlaskConical />}
        title="No filter study stored yet"
      />
    );
  return (
    <div className="min-h-40 space-y-3">
      <p className="text-sm" role="alert">
        Filter studies unavailable. {state.message}
      </p>
      <Button onClick={onRetry} variant="outline">
        <RotateCcw aria-hidden="true" className="size-4" />
        Retry now
      </Button>
    </div>
  );
};

export const FilterStudiesSection = ({
  gateway: supplied,
}: Readonly<{ gateway?: ResearchStudyGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchStudyGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      const { study } = await gateway.get(FILTER_STUDY_ID);
      return setState({ model: toFilterStudyViewModel(study), type: "ready" });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      if (failure.kind === "forbidden") return setState({ type: "forbidden" });
      if (failure.code === "NOT_FOUND") return setState({ type: "not-found" });
      return setState({
        message: `${failure.code}: ${failure.message}`,
        type: "error",
      });
    }
  }, [gateway]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.type === "ready")
    return (
      <div data-filter-studies-state="ready">
        <FilterStudiesPanel model={state.model} />
      </div>
    );
  return (
    <section
      aria-labelledby="filter-studies-heading"
      className="space-y-4 rounded-lg border border-border p-4"
      data-filter-studies-state={state.type}
    >
      <h2 className="font-medium text-base" id="filter-studies-heading">
        Filter studies
      </h2>
      <Body onRetry={() => void load()} state={state} />
    </section>
  );
};
