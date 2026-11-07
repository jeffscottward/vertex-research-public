// What: UI lab entries for Markets & Research: research chat, dossiers, watchlist, price alerts,
// news, baskets, pick lists and papers. Each renders the real page body with fake gateways.
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import { PageHeader } from "@darkfactory/ui";

import type { PapersGateway } from "../../components/portal/agent-ops-client.tsx";
import { BasketWatchlistSection } from "../../components/portal/basket-watchlist-section.tsx";
import type { BasketGateway } from "../../components/portal/baskets-client.ts";
import { BasketsWorkspace } from "../../components/portal/baskets-workspace.tsx";
import { CalendarWorkspace } from "../../components/portal/calendar-workspace.tsx";
import type { MarketDataGateway } from "../../components/portal/market-data-client.ts";
import type { MarketFeedsGateway } from "../../components/portal/market-feeds-workspace.tsx";
import type { MarketNewsGateway } from "../../components/portal/market-news-client.ts";
import { MarketNewsWorkspace } from "../../components/portal/market-news-workspace.tsx";
import { PapersWorkspace } from "../../components/portal/papers-workspace.tsx";
import type { PickListGateway } from "../../components/portal/pick-lists-client.ts";
import { PickListsWorkspace } from "../../components/portal/pick-lists-workspace.tsx";
import type { PortfolioMonitorGateway } from "../../components/portal/portfolio-monitor-client.ts";
import type { PriceAlertsGateway } from "../../components/portal/price-alerts-client.ts";
import { PriceAlertsWorkspace } from "../../components/portal/price-alerts-workspace.tsx";
import {
  ResearchReportDetail,
  ResearchReportsCatalog,
  type ResearchReportsGateway,
} from "../../components/portal/research-reports.tsx";
import type { WatchlistGateway } from "../../components/portal/watchlist-client.ts";
import { WatchlistWorkspace } from "../../components/portal/watchlist-workspace.tsx";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import type { ExperienceResearchChatPort } from "../../features/experience/ports.ts";
import { ResearchWorkspace } from "../../features/experience/research.tsx";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "../../features/experience/shared.tsx";
import { labReadOnly } from "../fixtures/core.ts";
import { LAB_MARKET_CONTEXT } from "../fixtures/lenses.ts";
import { labBarsOutput } from "../fixtures/market.ts";
import {
  labPortfolioMonitorSnapshot,
  labWallClock,
} from "../fixtures/overview.ts";
import {
  LAB_BASKETS,
  LAB_PAPERS,
  LAB_PICK_LIST_PROPOSAL,
  LAB_PICK_LISTS,
  LAB_PRICE_ALERTS,
  LAB_RESEARCH_DEFAULT_REPORT,
  LAB_RESEARCH_REPORTS,
  LAB_RESEARCH_ROSTER,
  LAB_RESEARCH_SCOPE,
  LAB_RESEARCH_THREAD_ID,
  LAB_RESEARCH_THREAD_PAGE,
  LAB_WATCHLIST,
  labBasketValuation,
  labMarketNews,
  labPickListScreen,
  labResearchDataset,
  labResearchTranscript,
} from "../fixtures/research.ts";
import { readLabSymbol } from "../params.ts";
import type { LabEntry } from "../registry.ts";

const GROUP = "Markets & Research";

const labResearchChatPort: ExperienceResearchChatPort = {
  appendResponse: labReadOnly,
  approveAndRequestDebateStep: labReadOnly,
  approveAndRequestNativeEvidence: labReadOnly,
  approveAndRequestResponse: labReadOnly,
  createThread: labReadOnly,
  listMessages: labReadOnly,
  listThreads: () => Promise.resolve(LAB_RESEARCH_THREAD_PAGE),
  prepareDebateStep: labReadOnly,
  prepareNativeEvidence: labReadOnly,
  prepareResponse: labReadOnly,
  readDebateRun: labReadOnly,
  readResponse: labReadOnly,
  readResponseContent: labReadOnly,
  readThread: labReadOnly,
  readTranscriptPage: (input) =>
    Promise.resolve(labResearchTranscript(input.threadId)),
  roster: () => Promise.resolve(LAB_RESEARCH_ROSTER),
  sendMessage: labReadOnly,
};

const labResearchServices = {
  ...createUnavailableExperienceServices(),
  reads: {
    ...createUnavailableExperienceServices().reads,
    scopes: () => Promise.resolve([LAB_RESEARCH_SCOPE]),
  },
  researchChat: labResearchChatPort,
};

const labResearchReportsGateway: ResearchReportsGateway = {
  dataset: (reportId, dataset) =>
    Promise.resolve(labResearchDataset(reportId, dataset)),
  list: () => Promise.resolve(LAB_RESEARCH_REPORTS),
};

const labWatchlistGateway: WatchlistGateway = {
  add: labReadOnly,
  list: () => Promise.resolve(LAB_WATCHLIST),
  remove: labReadOnly,
  update: labReadOnly,
};

const labBasketGateway: BasketGateway = {
  create: labReadOnly,
  list: () => Promise.resolve(LAB_BASKETS),
  remove: labReadOnly,
  update: labReadOnly,
  valuation: (id) => Promise.resolve(labBasketValuation(id)),
};

const labPriceAlertsGateway: PriceAlertsGateway = {
  check: labReadOnly,
  create: labReadOnly,
  list: () => Promise.resolve(LAB_PRICE_ALERTS),
  remove: labReadOnly,
};

const labMarketNewsGateway: MarketNewsGateway = {
  watchlist: (hours) => Promise.resolve(labMarketNews(hours)),
};

const labMarketFeedsGateway: MarketFeedsGateway = {
  context: () => Promise.resolve(LAB_MARKET_CONTEXT),
};

const labWatchlistMarketData: MarketDataGateway = {
  bars: (input) => Promise.resolve(labBarsOutput(input)),
};

const labWatchlistPortfolio: PortfolioMonitorGateway = {
  snapshot: () => Promise.resolve(labPortfolioMonitorSnapshot(labWallClock())),
};

const labPickListGateway: PickListGateway = {
  import: labReadOnly,
  list: () => Promise.resolve(LAB_PICK_LISTS),
  proposal: () => Promise.resolve(LAB_PICK_LIST_PROPOSAL),
  screen: (id) => Promise.resolve(labPickListScreen(id)),
  syncBucket: labReadOnly,
};

const labPapersGateway: PapersGateway = {
  add: labReadOnly,
  addFromArxiv: labReadOnly,
  list: () => Promise.resolve(LAB_PAPERS),
  update: labReadOnly,
};

export const RESEARCH_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: GROUP,
    id: "research",
    render: () => (
      <ResearchReadScopeProvider scope={createResearchReadScope()}>
        <ExperienceProvider services={labResearchServices}>
          <ResearchWorkspace initialThreadId={LAB_RESEARCH_THREAD_ID} />
        </ExperienceProvider>
      </ResearchReadScopeProvider>
    ),
    route: "/research",
    title: "Research",
  },
  {
    group: GROUP,
    id: "research-reports",
    render: () => (
      <ResearchReportsCatalog gateway={labResearchReportsGateway} />
    ),
    route: "/research/reports",
    title: "Research dossiers",
  },
  {
    group: GROUP,
    id: "research-report",
    render: (params) => (
      <ResearchReportDetail
        gateway={labResearchReportsGateway}
        initialTab={params.get("tab") ?? undefined}
        reportId={readLabSymbol(params, LAB_RESEARCH_DEFAULT_REPORT, "id")}
      />
    ),
    route: "/research/reports/[reportId]",
    title: "Research dossier",
  },
  {
    group: GROUP,
    id: "watchlist",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Watchlist" />
        <BasketWatchlistSection gateway={labBasketGateway} />
        <WatchlistWorkspace
          gateway={labWatchlistGateway}
          marketData={labWatchlistMarketData}
          operator
          portfolio={labWatchlistPortfolio}
        />
      </div>
    ),
    route: "/watchlist",
    title: "Watchlist",
  },
  {
    group: GROUP,
    id: "price-alerts",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Price alerts" />
        <PriceAlertsWorkspace gateway={labPriceAlertsGateway} />
      </div>
    ),
    route: "/price-alerts",
    title: "Price alerts",
  },
  {
    group: GROUP,
    id: "news",
    render: (params) => (
      <MarketNewsWorkspace
        gateway={labMarketNewsGateway}
        initialDays={params.get("days") ?? ""}
      />
    ),
    route: "/news",
    title: "News monitor",
  },
  {
    group: GROUP,
    id: "calendar",
    render: () => (
      <CalendarWorkspace
        contextGateway={labMarketFeedsGateway}
        newsGateway={labMarketNewsGateway}
      />
    ),
    route: "/calendar",
    title: "Calendar",
  },
  {
    group: GROUP,
    id: "baskets",
    render: (params) => (
      <div className="space-y-8">
        <BasketsWorkspace
          gateway={labBasketGateway}
          initialBasket={params.get("basket") ?? params.get("symbol")}
        />
      </div>
    ),
    route: "/baskets",
    title: "Baskets",
  },
  {
    group: GROUP,
    id: "pick-lists",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Pick lists" />
        <PickListsWorkspace gateway={labPickListGateway} />
      </div>
    ),
    route: "/pick-lists",
    title: "Pick lists",
  },
  {
    group: GROUP,
    id: "papers",
    render: (params) => (
      <div className="space-y-8">
        <PapersWorkspace
          gateway={labPapersGateway}
          initialStatus={params.get("status")}
        />
      </div>
    ),
    route: "/papers",
    title: "Papers",
  },
];
