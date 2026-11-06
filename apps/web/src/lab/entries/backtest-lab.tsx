// What: UI lab entries for the backtest pages: instant backtest, setup replay, backtest runs,
// parameter sweeps, portfolio combos, forward drift, strategy builder and Autopilot, each the
// real workspace with fake gateways. /lab/backtest-runs?run=<id> (or ?id=) opens that run.
"use client";

import { PageHeader } from "@darkfactory/ui";

import {
  type AutopilotGateway,
  AutopilotWorkspace,
} from "../../components/portal/autopilot-workspace.tsx";
import {
  type BacktestRunsGateway,
  BacktestRunsWorkspace,
} from "../../components/portal/backtest-runs-workspace.tsx";
import {
  type BacktestSweepsGateway,
  BacktestSweepsWorkspace,
} from "../../components/portal/backtest-sweeps-workspace.tsx";
import {
  type ForwardDriftGateway,
  ForwardDriftWorkspace,
} from "../../components/portal/forward-drift-workspace.tsx";
import {
  type InstantBacktestGateway,
  InstantBacktestWorkspace,
} from "../../components/portal/instant-backtest-workspace.tsx";
import {
  type PortfolioCombosGateway,
  PortfolioCombosWorkspace,
} from "../../components/portal/portfolio-combos-workspace.tsx";
import type { SetupReplayGateway } from "../../components/portal/setup-replay-client.ts";
import { SetupReplayWorkspace } from "../../components/portal/setup-replay-workspace.tsx";
import { StrategyBuilderWorkspace } from "../../components/portal/strategy-builder-workspace.tsx";
import {
  LAB_AUTOPILOT_CAMPAIGNS,
  LAB_BACKTEST_RUN_SUMMARIES,
  LAB_BACKTEST_SERIES,
  LAB_DEFAULT_RUN_ID,
  LAB_DRIFT_ALERTS,
  LAB_DRIFT_MONITORS,
  LAB_SETUP_PRESETS,
  LAB_STRATEGIES,
  labAutopilotCandidate,
  labAutopilotDetail,
  labBacktestRun,
  labCombo,
  labDriftMonitor,
  labInstantRun,
  labSetupReplay,
  labSweep,
} from "../fixtures/backtest-lab.ts";
import { labReadOnly } from "../fixtures/core.ts";
import type { LabEntry } from "../registry.ts";

export const labInstantBacktestGateway: InstantBacktestGateway = {
  run: (input) => Promise.resolve(labInstantRun(input)),
  series: () => Promise.resolve({ series: [...LAB_BACKTEST_SERIES] }),
};

export const labSetupReplayGateway: SetupReplayGateway = {
  presets: () => Promise.resolve({ presets: [...LAB_SETUP_PRESETS] }),
  run: (input) => Promise.resolve(labSetupReplay(input)),
  series: () => Promise.resolve({ series: [...LAB_BACKTEST_SERIES] }),
};

export const labBacktestRunsGateway: BacktestRunsGateway = {
  get: (id) => Promise.resolve(labBacktestRun(id)),
  list: () => Promise.resolve(LAB_BACKTEST_RUN_SUMMARIES),
  series: () => Promise.resolve(LAB_BACKTEST_SERIES),
  strategies: () => Promise.resolve(LAB_STRATEGIES),
  submit: labReadOnly,
};

export const labBacktestSweepsGateway: BacktestSweepsGateway = {
  series: () => Promise.resolve(LAB_BACKTEST_SERIES),
  submit: labReadOnly,
  sweep: (input) => Promise.resolve(labSweep(input)),
};

export const labPortfolioCombosGateway: PortfolioCombosGateway = {
  combine: (input) => Promise.resolve(labCombo(input)),
  list: () => Promise.resolve(LAB_BACKTEST_RUN_SUMMARIES),
};

export const labForwardDriftGateway: ForwardDriftGateway = {
  acknowledge: labReadOnly,
  create: labReadOnly,
  get: (id) => Promise.resolve(labDriftMonitor(id)),
  list: () =>
    Promise.resolve({
      monitors: LAB_DRIFT_MONITORS,
      openAlerts: LAB_DRIFT_ALERTS,
    }),
  paperSet: labReadOnly,
  paperTick: labReadOnly,
  record: labReadOnly,
  runs: () => Promise.resolve(LAB_BACKTEST_RUN_SUMMARIES),
};

export const labAutopilotGateway: AutopilotGateway = {
  candidate: (id) => Promise.resolve(labAutopilotCandidate(id)),
  create: labReadOnly,
  get: (id) => Promise.resolve(labAutopilotDetail(id)),
  list: () => Promise.resolve(LAB_AUTOPILOT_CAMPAIGNS),
  sendToPaper: labReadOnly,
  series: () => Promise.resolve(LAB_BACKTEST_SERIES),
  setStatus: labReadOnly,
  submitBacktest: labReadOnly,
  tick: labReadOnly,
};

const RUN_ID = /^[\w-]{1,128}$/u;

/** ?run= (as on the real page) or ?id=; the newest fake run when neither names a valid id. */
const labRunId = (params: URLSearchParams): string => {
  const value = params.get("run") ?? params.get("id") ?? "";
  return RUN_ID.test(value) ? value : LAB_DEFAULT_RUN_ID;
};

const GROUP = "Strategies & Backtests";

export const BACKTEST_LAB_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: GROUP,
    id: "instant-backtest",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Instant backtest" />
        <InstantBacktestWorkspace gateway={labInstantBacktestGateway} />
      </div>
    ),
    route: "/instant-backtest",
    title: "Instant backtest",
  },
  {
    group: GROUP,
    id: "setup-replay",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Setup replay" />
        <SetupReplayWorkspace gateway={labSetupReplayGateway} />
      </div>
    ),
    route: "/setup-replay",
    title: "Setup replay",
  },
  {
    group: GROUP,
    id: "backtest-runs",
    render: (params) => (
      <div className="space-y-8">
        <PageHeader title="Backtest runs" />
        <BacktestRunsWorkspace
          gateway={labBacktestRunsGateway}
          initialRunId={labRunId(params)}
        />
      </div>
    ),
    route: "/backtest-runs",
    title: "Backtest runs",
  },
  {
    group: GROUP,
    id: "backtest-sweeps",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Parameter sweeps" />
        <BacktestSweepsWorkspace gateway={labBacktestSweepsGateway} />
      </div>
    ),
    route: "/backtest-sweeps",
    title: "Parameter sweeps",
  },
  {
    group: GROUP,
    id: "portfolio-combos",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Portfolio combos" />
        <PortfolioCombosWorkspace gateway={labPortfolioCombosGateway} />
      </div>
    ),
    route: "/portfolio-combos",
    title: "Portfolio combos",
  },
  {
    group: GROUP,
    id: "forward-drift",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Forward drift" />
        <ForwardDriftWorkspace gateway={labForwardDriftGateway} />
      </div>
    ),
    route: "/forward-drift",
    title: "Forward drift",
  },
  {
    group: GROUP,
    id: "strategy-builder",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Strategy builder" />
        <StrategyBuilderWorkspace gateway={labBacktestRunsGateway} />
      </div>
    ),
    route: "/strategy-builder",
    title: "Strategy builder",
  },
  {
    group: GROUP,
    id: "autopilot",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Autopilot" />
        <AutopilotWorkspace gateway={labAutopilotGateway} />
      </div>
    ),
    route: "/autopilot",
    title: "Autopilot",
  },
];
