// What: UI lab entries for the research lens pages (rotation matrix, sector rotation, deep value,
// congress trades, risk allocator, market context): the real workspaces with fake gateways.
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import {
  OWNER_RISK_CAPS,
  RiskAllocatorInputSchema,
  suggestAllocation,
} from "@darkfactory/api";

import type { CongressTradesGateway } from "../../components/portal/congress-trades-client.ts";
import {
  CongressTradesWorkspace,
  parseCongressTradesParams,
} from "../../components/portal/congress-trades-workspace.tsx";
import {
  DeepValueWorkspace,
  parseDeepValueParams,
} from "../../components/portal/deep-value-workspace.tsx";
import { MarketContextPage } from "../../components/portal/market-context-page.tsx";
import type { MarketContextGateway } from "../../components/portal/market-context-workspace.tsx";
import type { MarketFeedsGateway } from "../../components/portal/market-feeds-workspace.tsx";
import type { ResearchLensesGateway } from "../../components/portal/research-lenses-client.ts";
import type { RiskAllocatorGateway } from "../../components/portal/risk-allocator-client.ts";
import {
  parseRiskAllocatorParams,
  type RiskAllocatorWatchlist,
  RiskAllocatorWorkspace,
} from "../../components/portal/risk-allocator-workspace.tsx";
import {
  parseRotationMatrixParams,
  RotationMatrixWorkspace,
} from "../../components/portal/rotation-matrix-workspace.tsx";
import type { SectorRotationGateway } from "../../components/portal/sector-rotation-client.ts";
import {
  parseSectorRotationParams,
  SectorRotationWorkspace,
} from "../../components/portal/sector-rotation-workspace.tsx";
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
import { LAB_WATCHLIST } from "../fixtures/research.ts";
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

/** Read-only fake watchlist for the risk allocator's default suggestion (first symbol: SPY). */
export const labRiskAllocatorWatchlist: RiskAllocatorWatchlist = {
  list: () => Promise.resolve(LAB_WATCHLIST),
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
    render: (params) => (
      <RotationMatrixWorkspace
        gateway={labResearchLensesGateway}
        initial={parseRotationMatrixParams(Object.fromEntries(params))}
      />
    ),
    route: "/rotation-matrix",
    title: "Rotation matrix",
  },
  {
    group: GROUP,
    id: "sector-rotation",
    render: (params) => (
      <SectorRotationWorkspace
        gateway={labSectorRotationGateway}
        initial={parseSectorRotationParams(Object.fromEntries(params))}
      />
    ),
    route: "/sector-rotation",
    title: "Sector rotation",
  },
  {
    group: GROUP,
    id: "deep-value",
    render: (params) => (
      <DeepValueWorkspace
        gateway={labResearchLensesGateway}
        initial={parseDeepValueParams(Object.fromEntries(params))}
      />
    ),
    route: "/deep-value",
    title: "Deep value screen",
  },
  {
    group: GROUP,
    id: "congress-trades",
    render: (params) => (
      <CongressTradesWorkspace
        gateway={labCongressTradesGateway}
        initial={parseCongressTradesParams(Object.fromEntries(params))}
      />
    ),
    route: "/congress-trades",
    title: "Congress trades",
  },
  {
    group: GROUP,
    id: "risk-allocator",
    render: (params) => (
      <RiskAllocatorWorkspace
        gateway={labRiskAllocatorGateway}
        initial={parseRiskAllocatorParams(Object.fromEntries(params))}
        initialAsOf={labDaysAgo(0)}
        watchlist={labRiskAllocatorWatchlist}
      />
    ),
    route: "/risk-allocator",
    title: "Risk allocator",
  },
  {
    group: GROUP,
    id: "markets",
    render: () => (
      <MarketContextPage
        contextGateway={labMarketContextGateway}
        feedsGateway={labMarketFeedsGateway}
      />
    ),
    route: "/markets",
    title: "Market context",
  },
];
