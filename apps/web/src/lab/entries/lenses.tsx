// What: UI lab entries for the research lens pages (rotation matrix, sector rotation, deep value,
// congress trades, risk allocator, market context): the real workspaces with fake gateways.
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import {
  OWNER_RISK_CAPS,
  RiskAllocatorInputSchema,
  suggestAllocation,
} from "@darkfactory/api";
import { PageHeader } from "@darkfactory/ui";

import type { CongressTradesGateway } from "../../components/portal/congress-trades-client.ts";
import { CongressTradesWorkspace } from "../../components/portal/congress-trades-workspace.tsx";
import { DeepValueWorkspace } from "../../components/portal/deep-value-workspace.tsx";
import {
  type MarketContextGateway,
  MarketContextWorkspace,
} from "../../components/portal/market-context-workspace.tsx";
import {
  type MarketFeedsGateway,
  MarketFeedsWorkspace,
} from "../../components/portal/market-feeds-workspace.tsx";
import type { ResearchLensesGateway } from "../../components/portal/research-lenses-client.ts";
import type { RiskAllocatorGateway } from "../../components/portal/risk-allocator-client.ts";
import { RiskAllocatorWorkspace } from "../../components/portal/risk-allocator-workspace.tsx";
import { RotationMatrixWorkspace } from "../../components/portal/rotation-matrix-workspace.tsx";
import type { SectorRotationGateway } from "../../components/portal/sector-rotation-client.ts";
import { SectorRotationWorkspace } from "../../components/portal/sector-rotation-workspace.tsx";
import { labDaysAgo } from "../fixtures/core.ts";
import {
  LAB_MARKET_CONTEXT,
  LAB_MARKET_VOLATILITY,
  LAB_SECTOR_UNIVERSES,
  labCongressFeed,
  labDeepValue,
  labDeepValueScore,
  labRotationMatrix,
  labSectorRotationMap,
} from "../fixtures/lenses.ts";
import type { LabEntry } from "../registry.ts";

export const labResearchLensesGateway: ResearchLensesGateway = {
  deepValue: () => Promise.resolve(labDeepValue()),
  rotationMatrix: (period) => Promise.resolve(labRotationMatrix(period)),
  score: (symbol) => Promise.resolve(labDeepValueScore(symbol)),
};

export const labSectorRotationGateway: SectorRotationGateway = {
  map: (input) => Promise.resolve(labSectorRotationMap(input)),
  universes: () => Promise.resolve(LAB_SECTOR_UNIVERSES),
};

export const labCongressTradesGateway: CongressTradesGateway = {
  feed: (days) => Promise.resolve(labCongressFeed(days)),
};

/** Caps and suggestions are pure, local computations: the lab runs the real allocator on fake input. */
export const labRiskAllocatorGateway: RiskAllocatorGateway = {
  caps: () => Promise.resolve(OWNER_RISK_CAPS),
  suggest: (input) =>
    Promise.resolve(suggestAllocation(RiskAllocatorInputSchema.parse(input))),
};

const labMarketContextGateway: MarketContextGateway = {
  volatility: () => Promise.resolve(LAB_MARKET_VOLATILITY),
};

const labMarketFeedsGateway: MarketFeedsGateway = {
  context: () => Promise.resolve(LAB_MARKET_CONTEXT),
};

const GROUP = "Markets & Research";

export const LENSES_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: GROUP,
    id: "rotation-matrix",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Rotation matrix" />
        <RotationMatrixWorkspace gateway={labResearchLensesGateway} />
      </div>
    ),
    route: "/rotation-matrix",
    title: "Rotation matrix",
  },
  {
    group: GROUP,
    id: "sector-rotation",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Sector rotation" />
        <SectorRotationWorkspace gateway={labSectorRotationGateway} />
      </div>
    ),
    route: "/sector-rotation",
    title: "Sector rotation",
  },
  {
    group: GROUP,
    id: "deep-value",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Deep value screen" />
        <DeepValueWorkspace gateway={labResearchLensesGateway} />
      </div>
    ),
    route: "/deep-value",
    title: "Deep value screen",
  },
  {
    group: GROUP,
    id: "congress-trades",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Congress trades" />
        <CongressTradesWorkspace gateway={labCongressTradesGateway} />
      </div>
    ),
    route: "/congress-trades",
    title: "Congress trades",
  },
  {
    group: GROUP,
    id: "risk-allocator",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Risk allocator" />
        <RiskAllocatorWorkspace
          gateway={labRiskAllocatorGateway}
          initialAsOf={labDaysAgo(0)}
        />
      </div>
    ),
    route: "/risk-allocator",
    title: "Risk allocator",
  },
  {
    group: GROUP,
    id: "markets",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Market context" />
        <MarketContextWorkspace gateway={labMarketContextGateway} />
        <MarketFeedsWorkspace gateway={labMarketFeedsGateway} />
      </div>
    ),
    route: "/markets",
    title: "Market context",
  },
];
