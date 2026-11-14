// What: UI lab entries for Agents & Automation (/agents, benchmark, run detail, /deployments, /drafts, /engines)
// and the linked /assistant and /knowledge pages: the real workspaces with fake gateways.
// The run detail reads ?id= (default: the first fake run).
"use client";

import type {
  GoLiveDraftApproveInput,
  GoLiveDraftOutput,
  GoLiveQueueOutput,
} from "@darkfactory/api";
import { PageHeader, Panel, StatusBadge } from "@darkfactory/ui";
import { useState } from "react";

import { AgentApiKeysSection } from "../../components/portal/agent-api-keys-section.tsx";
import type { AgentFrameworksGateway } from "../../components/portal/agent-frameworks-client.ts";
import { AgentFrameworksSection } from "../../components/portal/agent-frameworks-section.tsx";
import type { AgentModelBenchmarkGateway } from "../../components/portal/agent-model-benchmark-client.ts";
import { AgentModelBenchmarkWorkspace } from "../../components/portal/agent-model-benchmark-workspace.tsx";
import { AgentModelRunDetail } from "../../components/portal/agent-model-run-detail.tsx";
import type { AgentModelRunsGateway } from "../../components/portal/agent-model-runs-client.ts";
import { AgentModelRunsWorkspace } from "../../components/portal/agent-model-runs-workspace.tsx";
import type {
  AgentApiKeysGateway,
  AgentOpsGateway,
  DeploymentGateway,
  DeploymentRequestsGateway,
  StrategyLibraryGateway,
} from "../../components/portal/agent-ops-client.tsx";
import { AgentRunsWorkspace } from "../../components/portal/agent-runs-workspace.tsx";
import type { AssistantGateway } from "../../components/portal/assistant-client.ts";
import { AssistantWorkspace } from "../../components/portal/assistant-workspace.tsx";
import { DeploymentsView } from "../../components/portal/deployments-view.tsx";
import {
  type EnginesGateway,
  EnginesWorkspace,
} from "../../components/portal/engines-workspace.tsx";
import {
  GoLiveDraftQueue,
  type GoLiveDraftsGateway,
} from "../../components/portal/golive-draft-queue.tsx";
import {
  LAB_AGENT_API_KEYS,
  LAB_AGENT_FRAMEWORKS,
  LAB_AGENT_TASKS,
  LAB_ASSISTANT_THREAD_DETAIL,
  LAB_ASSISTANT_THREADS,
  LAB_DEPLOYMENT_REQUESTS,
  LAB_DEPLOYMENT_STATUS,
  LAB_ENGINES_STATUS,
  LAB_GOLIVE_QUEUE,
  LAB_MODEL_BENCHMARK,
  LAB_MODEL_RUN_BREAKDOWN,
  LAB_MODEL_RUN_FACETS,
  LAB_MODEL_RUNS,
  labAgentTaskEvents,
  labModelRunPage,
} from "../fixtures/automation.ts";
import { labReadOnly } from "../fixtures/core.ts";
import type { LabEntry } from "../registry.ts";

export const labAgentOpsGateway: AgentOpsGateway = {
  appendEvent: labReadOnly,
  createTask: labReadOnly,
  getTask: (id) => {
    const task = LAB_AGENT_TASKS.find((item) => item.id === id);
    return task === undefined
      ? labReadOnly()
      : Promise.resolve({ events: labAgentTaskEvents(id), task });
  },
  listTasks: () => Promise.resolve([...LAB_AGENT_TASKS]),
  summary: labReadOnly,
  updateTask: labReadOnly,
};

export const labModelRunsGateway: AgentModelRunsGateway = {
  breakdown: () => Promise.resolve(LAB_MODEL_RUN_BREAKDOWN),
  events: (runId) => Promise.resolve(labModelRunPage(runId)),
  exportCsv: labReadOnly,
  get: (id) => Promise.resolve(labModelRunPage(id)),
  list: () =>
    Promise.resolve({
      facets: LAB_MODEL_RUN_FACETS,
      nextCursor: null,
      runs: [...LAB_MODEL_RUNS],
    }),
  search: () => Promise.resolve({ results: [] }),
};

const labApiKeysGateway: AgentApiKeysGateway = {
  create: labReadOnly,
  list: () => Promise.resolve([...LAB_AGENT_API_KEYS]),
  revoke: labReadOnly,
};

const labBenchmarkGateway: AgentModelBenchmarkGateway = {
  benchmark: () => Promise.resolve(LAB_MODEL_BENCHMARK),
  facets: () => Promise.resolve(LAB_MODEL_RUN_FACETS),
};

const labFrameworksGateway: AgentFrameworksGateway = {
  frameworks: () => Promise.resolve(LAB_AGENT_FRAMEWORKS),
};

const labDeploymentGateway: DeploymentGateway = {
  status: () => Promise.resolve(LAB_DEPLOYMENT_STATUS),
};

export const labDeploymentRequestsGateway: DeploymentRequestsGateway = {
  approve: labReadOnly,
  create: labReadOnly,
  get: (id) => {
    const request = LAB_DEPLOYMENT_REQUESTS.find((item) => item.id === id);
    return request === undefined ? labReadOnly() : Promise.resolve(request);
  },
  list: () => Promise.resolve([...LAB_DEPLOYMENT_REQUESTS]),
  reject: labReadOnly,
  submit: labReadOnly,
  update: labReadOnly,
  withdraw: labReadOnly,
};

/** The request form's strategy picker: empty in the lab. */
export const labDeploymentStrategies: StrategyLibraryGateway = {
  create: labReadOnly,
  get: labReadOnly,
  list: () => Promise.resolve([]),
  removePreset: labReadOnly,
  savePreset: labReadOnly,
  update: labReadOnly,
};

const labRefusal = (code: string, message: string): Promise<never> =>
  Promise.reject(Object.assign(new Error(message), { code }));

/**
 * The order draft queue in memory. A decision changes only this gateway's copy of the fake
 * drafts and is refused the way the real server refuses it; nothing leaves the browser.
 */
export const createLabGoLiveDraftsGateway = (
  start: GoLiveQueueOutput = LAB_GOLIVE_QUEUE
): GoLiveDraftsGateway => {
  let { drafts } = start;
  const decide = (
    id: string,
    approval: Pick<GoLiveDraftApproveInput, "order" | "revision"> | null,
    note: string | null
  ): Promise<GoLiveDraftOutput> => {
    const draft = drafts.find((entry) => entry.id === id);
    if (draft === undefined)
      return labRefusal("NOT_FOUND", "UI lab: no such dummy draft");
    if (draft.state !== "proposed")
      return labRefusal("CONFLICT", "The draft is no longer proposed");
    if (approval !== null && approval.revision !== draft.revision)
      return labRefusal(
        "CONFLICT",
        `UI lab: revision ${approval.revision} was shown and the dummy draft is at revision ${draft.revision}`
      );
    if (approval !== null && draft.notApprovable.length > 0)
      return labRefusal(
        "CONFLICT",
        `Draft cannot be approved: ${draft.notApprovable.join(", ")}`
      );
    const at = new Date();
    const { maxLoss, maxLossPctNlv } = draft.sizing;
    const decided: GoLiveDraftOutput = {
      ...draft,
      approvedOrder: approval?.order ?? null,
      // The room an approval holds is the max loss of the order it approved.
      approvedRoom:
        approval === null || maxLoss === null
          ? null
          : { maxLoss, maxLossPctNlv },
      decidedAt: at,
      decidedBy: "demo-owner",
      decisionNote: note,
      nodeBadgeAtDecision: approval === null ? null : start.node.badge,
      notApprovable: [...draft.notApprovable, "DRAFT_NOT_PROPOSED"],
      // Every write to a draft adds 1 to its revision, as on the server.
      revision: draft.revision + 1,
      state: approval === null ? "rejected" : "approved",
      updatedAt: at,
    };
    drafts = drafts.map((entry) => (entry.id === id ? decided : entry));
    return Promise.resolve(decided);
  };
  return {
    approve: (input) => decide(input.id, input, input.note ?? null),
    queue: () => Promise.resolve({ ...start, drafts }),
    reject: (input) => decide(input.id, null, input.note),
    // The lab never reaches an order path: a send is refused as from a disarmed node.
    sendApproved: () =>
      Promise.resolve({
        reasons: [
          "GO-LIVE ENGINE_DISARMED: approved, engine running-disarmed (lab); the owner arms the node",
        ],
        sent: false as const,
      }),
  };
};

/** A fresh in-memory queue for each visit of the lab page. */
const LabOrderDrafts = () => {
  const [gateway] = useState(() => createLabGoLiveDraftsGateway());
  return <GoLiveDraftQueue gateway={gateway} />;
};

const labEnginesGateway: EnginesGateway = {
  status: () => Promise.resolve(LAB_ENGINES_STATUS),
};

const labAssistantGateway: AssistantGateway = {
  create: labReadOnly,
  decide: labReadOnly,
  get: () => Promise.resolve(LAB_ASSISTANT_THREAD_DETAIL),
  list: () => Promise.resolve(LAB_ASSISTANT_THREADS),
  send: labReadOnly,
};

export const AUTOMATION_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Agents & Automation",
    id: "agents",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Agent runs" />
        <AgentRunsWorkspace gateway={labAgentOpsGateway} />
        <AgentModelRunsWorkspace gateway={labModelRunsGateway} />
        <AgentApiKeysSection gateway={labApiKeysGateway} />
      </div>
    ),
    route: "/agents",
    title: "Agent runs",
  },
  {
    group: "Agents & Automation",
    id: "agents-benchmark",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Model benchmark" />
        <AgentModelBenchmarkWorkspace gateway={labBenchmarkGateway}>
          <AgentFrameworksSection gateway={labFrameworksGateway} />
        </AgentModelBenchmarkWorkspace>
      </div>
    ),
    route: "/agents/benchmark",
    title: "Model benchmark",
  },
  {
    group: "Agents & Automation",
    id: "agent-run",
    render: (params) => (
      <AgentModelRunDetail
        gateway={labModelRunsGateway}
        runId={params.get("id") ?? "lab-run-1"}
      />
    ),
    route: "/agents/runs/[id]",
    title: "Model run",
  },
  {
    group: "Agents & Automation",
    id: "deployments",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Deployments" />
        <DeploymentsView
          monitor={{ gateway: labDeploymentGateway }}
          requests={{
            gateway: labDeploymentRequestsGateway,
            strategies: labDeploymentStrategies,
          }}
        />
      </div>
    ),
    route: "/deployments",
    title: "Deployments",
  },
  {
    group: "Agents & Automation",
    id: "drafts",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Order drafts" />
        <LabOrderDrafts />
      </div>
    ),
    route: "/drafts",
    title: "Order drafts",
  },
  {
    group: "Agents & Automation",
    id: "engines",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Engines" />
        <EnginesWorkspace gateway={labEnginesGateway} />
      </div>
    ),
    route: "/engines",
    title: "Engines",
  },
  {
    group: "Linked pages",
    id: "assistant",
    render: () => (
      <div
        className="flex h-[calc(100dvh_-_var(--header-height)_-_2rem)] min-h-[32rem] flex-col gap-4 md:h-[calc(100dvh_-_var(--header-height)_-_4rem)] md:gap-6"
        data-assistant-page=""
      >
        <PageHeader title="Assistant" />
        <AssistantWorkspace gateway={labAssistantGateway} />
      </div>
    ),
    route: "/assistant",
    title: "Assistant",
  },
  {
    group: "Linked pages",
    id: "knowledge",
    // Mirrors the server page's "no kb-chat address" state (the page itself reads server env).
    render: () => (
      <div className="space-y-6">
        <PageHeader
          description="Ask the trading and commodities knowledge bases that run on the rig."
          status={<StatusBadge status="warning">Not configured</StatusBadge>}
          title="Knowledge chat"
        />
        <Panel title="Trading and commodities knowledge bases">
          <p
            className="text-muted-foreground text-sm"
            data-kb-chat="unavailable"
          >
            Available on the owner's tailnet device when the rig is online. This
            server has no kb-chat address (VERTEX_KB_CHAT_URL).
          </p>
        </Panel>
      </div>
    ),
    route: "/knowledge",
    title: "Knowledge chat",
  },
];
