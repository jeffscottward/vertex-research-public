// What: UI lab entries for Mission control (/dashboard), Today, Todos and Portfolio: the real
// workspaces with fake gateways (Demo Capital). Orders use a fake gateway; nothing reaches IBKR.
// /lab/portfolio?tab=orders-stops opens a Portfolio tab (positions by default).
"use client";

import { PageHeader } from "@darkfactory/ui";
import { type ReactNode, useLayoutEffect, useState } from "react";

import type { AgentOpsGateway } from "../../components/portal/agent-ops-client.tsx";
import type { IbkrRecoveryGateway } from "../../components/portal/ibkr-recovery-client.ts";
import type { NautilusArmGateway } from "../../components/portal/nautilus-arm-client.ts";
import type { IbkrMonitorGateway } from "../../components/portal/portfolio-monitor-client.ts";
import { writeStored } from "../../components/portal/portfolio-monitor-controls.tsx";
import { DashboardViews } from "../../components/portal/portfolio-monitor-dashboard.tsx";
import { MONITOR_SECTIONS } from "../../components/portal/portfolio-monitor-model.ts";
import {
  PORTFOLIO_VIEW_STORAGE_KEY,
  PortfolioTabs,
  type PortfolioView,
} from "../../components/portal/portfolio-tabs.tsx";
import type { TodosGateway } from "../../components/portal/todos-client.ts";
import { TodosWorkspace } from "../../components/portal/todos-workspace.tsx";
import { TradeJournal } from "../../components/portal/trade-journal.tsx";
import type { VertexOrdersGateway } from "../../components/portal/vertex-orders-client.ts";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import { PortfolioWorkspace } from "../../features/experience/portfolio.tsx";
import type { ExperienceServices } from "../../features/experience/ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "../../features/experience/shared.tsx";
import { TodayWorkspace } from "../../features/experience/today.tsx";
import { labDaysAgo, labReadOnly } from "../fixtures/core.ts";
import {
  LAB_AGENT_SUMMARY,
  LAB_AGENT_TASKS,
  LAB_DASHBOARD_SUMMARY_STATE,
  LAB_EXPERIENCE_SCOPE,
  LAB_NAUTILUS_STATUS,
  LAB_PORTFOLIO_READ,
  LAB_RECOVERY_STATUS,
  LAB_ROUND_HANDLES,
  LAB_SECTOR_ROTATION,
  LAB_TODOS,
  LAB_VERTEX_ORDERS_STATUS,
  labDecisionInbox,
  labPortfolioMonitorSnapshot,
  labWallClock,
} from "../fixtures/overview.ts";
import { readLabChoice } from "../params.ts";
import type { LabEntry } from "../registry.ts";

/** ibkr-monitor reads; `clock` stamps the freshness fields so the monitor reads "Live". */
export const createLabIbkrMonitorGateway = (
  clock: () => Date = labWallClock
): IbkrMonitorGateway => ({
  roundHandles: () => Promise.resolve(LAB_ROUND_HANDLES),
  snapshot: () => Promise.resolve(labPortfolioMonitorSnapshot(clock())),
});

const labIbkrMonitor = createLabIbkrMonitorGateway();

const labNautilus: NautilusArmGateway = {
  arm: labReadOnly,
  disarm: labReadOnly,
  status: () => Promise.resolve(LAB_NAUTILUS_STATUS),
};

const labRecovery: IbkrRecoveryGateway = {
  request: labReadOnly,
  status: () => Promise.resolve(LAB_RECOVERY_STATUS),
};

const labAgentOps: AgentOpsGateway = {
  appendEvent: labReadOnly,
  createTask: labReadOnly,
  // Mission control never opens one task; the detail lives on Agent runs.
  getTask: labReadOnly,
  listTasks: () => Promise.resolve([...LAB_AGENT_TASKS]),
  summary: () => Promise.resolve(LAB_AGENT_SUMMARY),
  updateTask: labReadOnly,
};

const labSectorRotation = () => Promise.resolve(LAB_SECTOR_ROTATION);

const labTodos: TodosGateway = {
  create: labReadOnly,
  list: () => Promise.resolve([...LAB_TODOS]),
  remove: labReadOnly,
  update: labReadOnly,
};

/** Fake order gateway: status only; preview, submit and cancel are refused in the browser. */
const labVertexOrders: VertexOrdersGateway = {
  cancelPreview: labReadOnly,
  cancelSubmit: labReadOnly,
  comboPreview: labReadOnly,
  comboSubmit: labReadOnly,
  preview: labReadOnly,
  status: () => Promise.resolve(LAB_VERTEX_ORDERS_STATUS),
  submit: labReadOnly,
};

const unavailable = createUnavailableExperienceServices();

const LAB_EXPERIENCE_SERVICES: ExperienceServices = {
  ...unavailable,
  reads: {
    ...unavailable.reads,
    inbox: labDecisionInbox,
    portfolio: () => Promise.resolve(LAB_PORTFOLIO_READ),
    scopes: () => Promise.resolve([LAB_EXPERIENCE_SCOPE]),
  },
};

// The portal shell supplies the verified session scope; the lab scope is always current.
const LAB_READ_SCOPE = createResearchReadScope();

const LabExperience = ({ children }: { readonly children: ReactNode }) => (
  <ResearchReadScopeProvider scope={LAB_READ_SCOPE}>
    <ExperienceProvider services={LAB_EXPERIENCE_SERVICES}>
      {children}
    </ExperienceProvider>
  </ResearchReadScopeProvider>
);

const PORTFOLIO_VIEWS: readonly PortfolioView[] = [
  ...MONITOR_SECTIONS,
  "projection",
  "orders",
];

// PortfolioTabs keeps the open tab in localStorage; save the ?tab= choice before it mounts.
const LabPortfolioView = ({
  view,
  children,
}: {
  readonly view: PortfolioView;
  readonly children: ReactNode;
}) => {
  const [saved, setSaved] = useState(false);
  useLayoutEffect(() => {
    // The key is shared with the real /portfolio on the same origin: put it back on unmount.
    const previous = window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY);
    writeStored(PORTFOLIO_VIEW_STORAGE_KEY, view);
    setSaved(true);
    return () => {
      if (previous === null)
        window.localStorage.removeItem(PORTFOLIO_VIEW_STORAGE_KEY);
      else window.localStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, previous);
    };
  }, [view]);
  return saved ? children : null;
};

export const OVERVIEW_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Overview",
    id: "dashboard",
    render: () => (
      <div className="space-y-4">
        <PageHeader title="Mission control" />
        <DashboardViews
          account={{
            configured: true,
            gateway: labIbkrMonitor,
            nautilus: { configured: true, gateway: labNautilus },
            recovery: { configured: true, gateway: labRecovery },
          }}
          gateway={labAgentOps}
          operator
          sectorRotation={labSectorRotation}
          summaryState={LAB_DASHBOARD_SUMMARY_STATE}
        />
      </div>
    ),
    route: "/dashboard",
    title: "Mission control",
  },
  {
    group: "Overview",
    id: "today",
    render: () => (
      <LabExperience>
        <TodayWorkspace sectorRotation={labSectorRotation} />
      </LabExperience>
    ),
    route: "/today",
    title: "Decision inbox",
  },
  {
    group: "Overview",
    id: "todos",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Todos" />
        <TodosWorkspace gateway={labTodos} today={labDaysAgo(0)} />
      </div>
    ),
    route: "/todos",
    title: "Todos",
  },
  {
    group: "Portfolio",
    id: "portfolio",
    render: (params) => {
      const view = readLabChoice(params, "tab", PORTFOLIO_VIEWS, "positions");
      return (
        <LabExperience>
          <LabPortfolioView key={view} view={view}>
            <PortfolioTabs
              gateway={labIbkrMonitor}
              operator
              ordersGateway={labVertexOrders}
              projection={<PortfolioWorkspace />}
            />
          </LabPortfolioView>
        </LabExperience>
      );
    },
    route: "/portfolio",
    title: "Portfolio",
  },
  {
    group: "Portfolio",
    id: "journal",
    render: () => (
      <div className="space-y-6">
        <PageHeader title="Trade journal" />
        <TradeJournal load={labIbkrMonitor.snapshot} source="ibkr-monitor" />
      </div>
    ),
    route: "/journal",
    title: "Trade journal",
  },
];
