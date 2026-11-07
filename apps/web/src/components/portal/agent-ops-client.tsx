"use client";

import {
  createApiClient,
  type AgentApiKeyCreateOutput,
  type AgentApiKeyOutput,
  type AgentOpsSummaryOutput,
  type AgentTaskAppendEventInput,
  type AgentTaskCreateInput,
  type AgentTaskEventOutput,
  type AgentTaskGetOutput,
  type AgentTaskListInput,
  type AgentTaskOutput,
  type AgentTaskUpdateInput,
  type ApiClient,
  type BacktestGetOutput,
  type BacktestListInput,
  type BacktestResultSummaryOutput,
  type DeploymentRequestCreateInput,
  type DeploymentRequestListInput,
  type DeploymentRequestOutput,
  type DeploymentRequestUpdateInput,
  type DeploymentStatusOutput,
  type OptimizationGetOutput,
  type OptimizationListInput,
  type OptimizationSummaryOutput,
  type PapersAddFromArxivOutput,
  type PapersAddInput,
  type PapersUpdateInput,
  type ResearchPaperOutput,
  type StrategyCreateInput,
  type StrategyGetOutput,
  type StrategyListInput,
  type StrategyOutput,
  type StrategyPresetOutput,
  type StrategyPresetSaveInput,
  type StrategySummaryOutput,
  type StrategyUpdateInput,
} from "@darkfactory/api";
import { Info } from "lucide-react";

export interface AgentOpsGateway {
  readonly summary: () => Promise<AgentOpsSummaryOutput>;
  readonly listTasks: (
    input?: AgentTaskListInput
  ) => Promise<AgentTaskOutput[]>;
  readonly getTask: (id: string) => Promise<AgentTaskGetOutput>;
  readonly createTask: (
    input: AgentTaskCreateInput
  ) => Promise<AgentTaskOutput>;
  readonly updateTask: (
    input: AgentTaskUpdateInput
  ) => Promise<AgentTaskOutput>;
  readonly appendEvent: (
    input: AgentTaskAppendEventInput
  ) => Promise<AgentTaskEventOutput>;
}

export interface PapersGateway {
  readonly list: () => Promise<ResearchPaperOutput[]>;
  readonly add: (input: PapersAddInput) => Promise<ResearchPaperOutput>;
  readonly update: (input: PapersUpdateInput) => Promise<ResearchPaperOutput>;
  readonly addFromArxiv: (arxiv: string) => Promise<PapersAddFromArxivOutput>;
}

// Operator reads of agent-reported backtests. Writes come from agents (agentOps.backtests.record).
export interface BacktestsGateway {
  readonly list: (
    input?: BacktestListInput
  ) => Promise<BacktestResultSummaryOutput[]>;
  readonly get: (id: string) => Promise<BacktestGetOutput>;
}

const createBacktestsGateway = (client: ApiClient): BacktestsGateway => ({
  list: async (input = {}) =>
    (await client.agentOps.backtests.list(input)).backtests,
  get: (id) => client.agentOps.backtests.get({ id }),
});

// Operator reads of agent-recorded optimizer runs. Writes come from agents (agentOps.optimizations.record).
export interface OptimizationsGateway {
  readonly list: (
    input?: OptimizationListInput
  ) => Promise<OptimizationSummaryOutput[]>;
  readonly get: (id: string) => Promise<OptimizationGetOutput>;
}

const createOptimizationsGateway = (
  client: ApiClient
): OptimizationsGateway => ({
  list: async (input = {}) =>
    (await client.agentOps.optimizations.list(input)).optimizations,
  get: (id) => client.agentOps.optimizations.get({ id }),
});

// Operator strategy library (strategyLibrary.*).
export interface StrategyLibraryGateway {
  readonly list: (
    input?: StrategyListInput
  ) => Promise<StrategySummaryOutput[]>;
  readonly get: (id: string) => Promise<StrategyGetOutput>;
  readonly create: (input: StrategyCreateInput) => Promise<StrategyOutput>;
  readonly update: (input: StrategyUpdateInput) => Promise<StrategyOutput>;
  readonly savePreset: (
    input: StrategyPresetSaveInput
  ) => Promise<StrategyPresetOutput>;
  readonly removePreset: (strategyId: string, id: string) => Promise<void>;
}

const createStrategyLibraryGateway = (
  client: ApiClient
): StrategyLibraryGateway => ({
  list: async (input = {}) =>
    (await client.strategyLibrary.list(input)).strategies,
  get: (id) => client.strategyLibrary.get({ id }),
  create: (input) => client.strategyLibrary.create(input),
  update: (input) => client.strategyLibrary.update(input),
  savePreset: (input) => client.strategyLibrary.presets.save(input),
  removePreset: async (strategyId, id) => {
    await client.strategyLibrary.presets.remove({ strategyId, id });
    return;
  },
});

// Read-only QuantVPS deployment state (agentOps.deployment.status). No write procedures exist.
export interface DeploymentGateway {
  readonly status: () => Promise<DeploymentStatusOutput>;
}

const createDeploymentGateway = (client: ApiClient): DeploymentGateway => ({
  status: () => client.agentOps.deployment.status({}),
});

// Paper deployment requests (deploymentRequests.*): session-only records. Approve records a decision;
// nothing is dispatched.
export interface DeploymentRequestsGateway {
  readonly list: (
    input?: DeploymentRequestListInput
  ) => Promise<DeploymentRequestOutput[]>;
  readonly get: (id: string) => Promise<DeploymentRequestOutput>;
  readonly create: (
    input: DeploymentRequestCreateInput
  ) => Promise<DeploymentRequestOutput>;
  readonly update: (
    input: DeploymentRequestUpdateInput
  ) => Promise<DeploymentRequestOutput>;
  readonly submit: (id: string) => Promise<DeploymentRequestOutput>;
  readonly approve: (
    id: string,
    confirmSlug: string,
    note?: string
  ) => Promise<DeploymentRequestOutput>;
  readonly reject: (
    id: string,
    note: string
  ) => Promise<DeploymentRequestOutput>;
  readonly withdraw: (id: string) => Promise<DeploymentRequestOutput>;
}

const createDeploymentRequestsGateway = (
  client: ApiClient
): DeploymentRequestsGateway => ({
  list: async (input = {}) =>
    (await client.deploymentRequests.list(input)).requests,
  get: (id) => client.deploymentRequests.get({ id }),
  create: (input) => client.deploymentRequests.create(input),
  update: (input) => client.deploymentRequests.update(input),
  submit: (id) => client.deploymentRequests.submit({ id }),
  approve: (id, confirmSlug, note) =>
    client.deploymentRequests.approve({
      id,
      confirmSlug,
      ...(note === undefined ? {} : { note }),
    }),
  reject: (id, note) => client.deploymentRequests.reject({ id, note }),
  withdraw: (id) => client.deploymentRequests.withdraw({ id }),
});

// Session-only key management. The full key exists only in the create result.
export interface AgentApiKeysGateway {
  readonly list: () => Promise<AgentApiKeyOutput[]>;
  readonly create: (
    name: string,
    access?: "read" | "write"
  ) => Promise<AgentApiKeyCreateOutput>;
  readonly revoke: (id: string) => Promise<void>;
}

const createAgentApiKeysGateway = (client: ApiClient): AgentApiKeysGateway => ({
  list: async () => (await client.agentApiKeys.list({})).keys,
  create: (name, access = "read") =>
    client.agentApiKeys.create({ name, access }),
  revoke: async (id) => {
    await client.agentApiKeys.revoke({ id });
    return;
  },
});

const createAgentOpsGateway = (client: ApiClient): AgentOpsGateway => ({
  summary: () => client.agentOps.summary({}),
  listTasks: async (input = {}) =>
    (await client.agentOps.tasks.list(input)).tasks,
  getTask: (id) => client.agentOps.tasks.get({ id }),
  createTask: (input) => client.agentOps.tasks.create(input),
  updateTask: (input) => client.agentOps.tasks.update(input),
  appendEvent: (input) => client.agentOps.tasks.appendEvent(input),
});

const createPapersGateway = (client: ApiClient): PapersGateway => ({
  list: async () => (await client.papers.list({})).papers,
  add: (input) => client.papers.add(input),
  update: (input) => client.papers.update(input),
  addFromArxiv: (arxiv) => client.papers.addFromArxiv({ arxiv }),
});

let browserClient: ApiClient | undefined;
const currentClient = (): ApiClient => {
  browserClient ??= createApiClient({ baseUrl: window.location.origin });
  return browserClient;
};

export const createBrowserAgentOpsGateway = (): AgentOpsGateway => {
  return Object.freeze({
    summary: () => createAgentOpsGateway(currentClient()).summary(),
    listTasks: (input?: AgentTaskListInput) =>
      createAgentOpsGateway(currentClient()).listTasks(input),
    getTask: (id: string) => createAgentOpsGateway(currentClient()).getTask(id),
    createTask: (input: AgentTaskCreateInput) =>
      createAgentOpsGateway(currentClient()).createTask(input),
    updateTask: (input: AgentTaskUpdateInput) =>
      createAgentOpsGateway(currentClient()).updateTask(input),
    appendEvent: (input: AgentTaskAppendEventInput) =>
      createAgentOpsGateway(currentClient()).appendEvent(input),
  });
};

export const createBrowserAgentApiKeysGateway = (): AgentApiKeysGateway => {
  return Object.freeze({
    list: () => createAgentApiKeysGateway(currentClient()).list(),
    create: (name: string, access?: "read" | "write") =>
      createAgentApiKeysGateway(currentClient()).create(name, access),
    revoke: (id: string) =>
      createAgentApiKeysGateway(currentClient()).revoke(id),
  });
};

export const describeAgentApiKeyFailure = (error: unknown): string => {
  switch (errorField(error, "code")) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return `${OPERATOR_ACCESS_REQUIRED_TEXT}.`;
    }
    case "NOT_FOUND": {
      return "Key no longer exists. Reload.";
    }
    case "BAD_REQUEST": {
      return "Rejected: name must be 1-64 characters.";
    }
    case "UNAVAILABLE": {
      return "Agent API keys unavailable (503).";
    }
    default: {
      return "Request failed. Apply migration 0016 if the apikey table is missing, then retry.";
    }
  }
};

export const createBrowserPapersGateway = (): PapersGateway => {
  return Object.freeze({
    list: () => createPapersGateway(currentClient()).list(),
    add: (input: PapersAddInput) =>
      createPapersGateway(currentClient()).add(input),
    update: (input: PapersUpdateInput) =>
      createPapersGateway(currentClient()).update(input),
    addFromArxiv: (arxiv: string) =>
      createPapersGateway(currentClient()).addFromArxiv(arxiv),
  });
};

export const createBrowserDeploymentGateway = (): DeploymentGateway => {
  return Object.freeze({
    status: () => createDeploymentGateway(currentClient()).status(),
  });
};

export const createBrowserStrategyLibraryGateway =
  (): StrategyLibraryGateway => {
    return Object.freeze({
      list: (input?: StrategyListInput) =>
        createStrategyLibraryGateway(currentClient()).list(input),
      get: (id: string) =>
        createStrategyLibraryGateway(currentClient()).get(id),
      create: (input: StrategyCreateInput) =>
        createStrategyLibraryGateway(currentClient()).create(input),
      update: (input: StrategyUpdateInput) =>
        createStrategyLibraryGateway(currentClient()).update(input),
      savePreset: (input: StrategyPresetSaveInput) =>
        createStrategyLibraryGateway(currentClient()).savePreset(input),
      removePreset: (strategyId: string, id: string) =>
        createStrategyLibraryGateway(currentClient()).removePreset(
          strategyId,
          id
        ),
    });
  };

export const createBrowserDeploymentRequestsGateway =
  (): DeploymentRequestsGateway => {
    return Object.freeze({
      list: (input?: DeploymentRequestListInput) =>
        createDeploymentRequestsGateway(currentClient()).list(input),
      get: (id: string) =>
        createDeploymentRequestsGateway(currentClient()).get(id),
      create: (input: DeploymentRequestCreateInput) =>
        createDeploymentRequestsGateway(currentClient()).create(input),
      update: (input: DeploymentRequestUpdateInput) =>
        createDeploymentRequestsGateway(currentClient()).update(input),
      submit: (id: string) =>
        createDeploymentRequestsGateway(currentClient()).submit(id),
      approve: (id: string, confirmSlug: string, note?: string) =>
        createDeploymentRequestsGateway(currentClient()).approve(
          id,
          confirmSlug,
          note
        ),
      reject: (id: string, note: string) =>
        createDeploymentRequestsGateway(currentClient()).reject(id, note),
      withdraw: (id: string) =>
        createDeploymentRequestsGateway(currentClient()).withdraw(id),
    });
  };

export const createBrowserOptimizationsGateway = (): OptimizationsGateway => {
  return Object.freeze({
    list: (input?: OptimizationListInput) =>
      createOptimizationsGateway(currentClient()).list(input),
    get: (id: string) => createOptimizationsGateway(currentClient()).get(id),
  });
};

export const createBrowserBacktestsGateway = (): BacktestsGateway => {
  return Object.freeze({
    list: (input?: BacktestListInput) =>
      createBacktestsGateway(currentClient()).list(input),
    get: (id: string) => createBacktestsGateway(currentClient()).get(id),
  });
};

const errorField = (error: unknown, key: string): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 ? value : null;
};

// 403 from agentOps.*, papers.* or agentApiKeys.* means the session is not on the
// operator allow-list (or not active/verified). Workspaces render a dedicated state.
export const isOperatorAccessDenied = (error: unknown): boolean => {
  return errorField(error, "code") === "FORBIDDEN";
};

export const OPERATOR_ACCESS_REQUIRED_TEXT = "Operator access required";

/** What each operator-only feature is, for the "Operator access required" notice. */
export const OPERATOR_FEATURE_COPY = Object.freeze({
  academy:
    "The Define Your Risk Academy (private transcripts, backtests and deploy requests) is limited to operators.",
  "agent-runs": "Agent runs and agent API keys are limited to operators.",
  assistant: "The research assistant is limited to operators.",
  autopilot: "Autopilot campaigns are limited to operators.",
  backtests: "Backtest runs are limited to operators.",
  "deployment-requests": "Paper deployment requests are limited to operators.",
  deployments: "Deployment status is limited to operators.",
  engines: "Engine status is limited to operators.",
  "ibkr-monitor": "The IBKR monitor is limited to operators.",
  "instant-backtest": "Instant backtests are limited to operators.",
  "knowledge-chat": "The knowledge chat is limited to operators.",
  "market-context":
    "GEX, macro and news from the rig are limited to operators.",
  "mission-control":
    "Agent work and the IBKR monitor on Mission control are limited to operators.",
  optimizations: "Optimization runs are limited to operators.",
  papers: "The research paper pipeline is limited to operators.",
  "strategy-library": "The strategy library is limited to operators.",
  "watchlist-analysis":
    "Watchlist relationships and exposure (IBKR bars and positions) are limited to operators.",
} as const);

export type OperatorFeature = keyof typeof OPERATOR_FEATURE_COPY;

export const OperatorAccessRequired = ({
  feature,
}: {
  readonly feature: OperatorFeature;
}) => (
  <div
    className="space-y-1 rounded-md border border-border p-4"
    data-operator-access="required"
    data-operator-feature={feature}
    role="status"
  >
    <p className="font-medium text-sm">{OPERATOR_ACCESS_REQUIRED_TEXT}</p>
    <p className="text-muted-foreground text-sm">
      {`${OPERATOR_FEATURE_COPY[feature]} Ask the workspace owner to add your verified email to the operator list.`}
    </p>
  </div>
);

export const describeAgentOpsFailure = (error: unknown): string => {
  switch (errorField(error, "code")) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return `${OPERATOR_ACCESS_REQUIRED_TEXT}.`;
    }
    case "NOT_FOUND": {
      return "Record no longer exists. Reload.";
    }
    case "VALIDATION_ERROR":
    case "BAD_REQUEST": {
      return `Rejected: ${errorField(error, "message") ?? "invalid input"}`;
    }
    case "CONFLICT": {
      return "Conflict with an existing record.";
    }
    case "UPSTREAM_ERROR": {
      return `Upstream source failed (502): ${errorField(error, "message") ?? "no detail"}`;
    }
    case "STORAGE_ERROR": {
      return "Agent operations storage unavailable (503). Apply migrations 0015 and 0017 if the tables are missing.";
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};

export const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "Queued",
  running: "Running",
  needs_review: "Needs review",
  blocked: "Blocked",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
});

export const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "Queued",
  ingested: "Ingested",
  spec_extracted: "Spec extracted",
  implemented: "Implemented",
  backtested: "Backtested",
  forward_tested: "Forward tested",
  verdict: "Verdict",
});

export const labelFor = (
  labels: Readonly<Record<string, string>>,
  value: string
): string => {
  return labels[value] ?? value.replaceAll("_", " ");
};

export const formatTimestamp = (value: Date | null): string => {
  return value === null
    ? "—"
    : value.toISOString().slice(0, 16).replace("T", " ");
};

export const formatDuration = (
  task: Pick<AgentTaskOutput, "startedAt" | "finishedAt">,
  now = new Date()
): string => {
  if (task.startedAt === null) return "—";
  const end = task.finishedAt ?? now;
  const seconds = Math.max(
    0,
    Math.round((end.getTime() - task.startedAt.getTime()) / 1000)
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

export const formatMetrics = (
  metrics: Readonly<Record<string, number | string>>,
  limit = 4
): string => {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return "—";
  const shown = entries
    .slice(0, limit)
    .map(([key, value]) => `${key}=${value}`);
  return entries.length > limit
    ? `${shown.join(" · ")} · +${entries.length - limit}`
    : shown.join(" · ");
};

// Parses "key=value" lines; numeric values become numbers. Returns an error string for bad lines.
export const parseMetricsText = (
  text: string
): Record<string, number | string> | string => {
  const result: Record<string, number | string> = {};
  for (const rawLine of text.split(/\n|;/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const index = line.indexOf("=");
    if (index <= 0) return `Bad metric line: ${line.slice(0, 40)}`;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    const numeric = Number(value);
    result[key] = value !== "" && Number.isFinite(numeric) ? numeric : value;
  }
  return result;
};

export const metricsToText = (
  metrics: Readonly<Record<string, number | string>>
): string => {
  return Object.entries(metrics)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
};

export const upsertById = <T extends { id: string }>(
  rows: readonly T[],
  next: T
): T[] => {
  return rows.some((row) => row.id === next.id)
    ? rows.map((row) => (row.id === next.id ? next : row))
    : [next, ...rows];
};

// Column explanation glyph: native title tooltip plus an accessible label.
export const InfoGlyph = ({ text }: { readonly text: string }) => (
  <span
    aria-label={text}
    className="ml-1 inline-flex align-middle text-muted-foreground"
    role="img"
    title={text}
  >
    <Info aria-hidden="true" className="size-3" />
  </span>
);
