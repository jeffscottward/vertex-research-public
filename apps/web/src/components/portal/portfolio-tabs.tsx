"use client";

import { PageHeader } from "@darkfactory/ui";
import { type ReactNode, useLayoutEffect, useMemo, useState } from "react";

import {
  DraftsAndOrders,
  type DraftsAndOrdersGateway,
} from "./drafts-and-orders.tsx";
import { createBrowserGoLiveDraftsGateway } from "./golive-draft-queue.tsx";
import { PortfolioMonitor } from "./portfolio-monitor.tsx";
import {
  createBrowserIbkrMonitorGateway,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import {
  readStored,
  useStoredState,
  writeStored,
} from "./portfolio-monitor-controls.tsx";
import { MONITOR_SECTIONS } from "./portfolio-monitor-model.ts";
import { VertexOrders } from "./vertex-orders.tsx";
import {
  createBrowserVertexOrdersGateway,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

export const PORTFOLIO_VIEW_STORAGE_KEY = "vertex.portfolio.view.v2";
/** The v1 key ("ibkr" | "projection" | "orders"); read once as a fallback. */
export const LEGACY_PORTFOLIO_VIEW_STORAGE_KEY = "vertex.portfolio.view.v1";
/** Query parameter of the open view (StickyTabs default). */
const PORTFOLIO_VIEW_PARAM = "tab";

const PORTFOLIO_VIEWS = [...MONITOR_SECTIONS, "projection", "orders"] as const;
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number];

// v1 "ibkr" (the whole live monitor) maps to Positions, its old default section;
// v1 "projection" and "orders" keep their ids.
export const normalizePortfolioView = (value: unknown): PortfolioView =>
  typeof value === "string" &&
  (PORTFOLIO_VIEWS as readonly string[]).includes(value)
    ? (value as PortfolioView)
    : "positions";

// One-time move from the v1 key: with no v2 choice saved, map the v1 value and save it as v2.
// Runs after the stored-state load, so the first render still matches the server.
export const migrateLegacyPortfolioView = (): PortfolioView | null => {
  if (readStored(PORTFOLIO_VIEW_STORAGE_KEY) !== undefined) return null;
  const legacy = readStored(LEGACY_PORTFOLIO_VIEW_STORAGE_KEY);
  return legacy === undefined ? null : normalizePortfolioView(legacy);
};

// Called when a view opens. It saves the view only when ?tab= names it (a tab click or a
// link), so the fallback view on a plain /portfolio visit never overwrites the saved one.
const rememberView = (view: string): void => {
  if (
    new URLSearchParams(window.location.search).get(PORTFOLIO_VIEW_PARAM) ===
    view
  )
    writeStored(PORTFOLIO_VIEW_STORAGE_KEY, normalizePortfolioView(view));
};

interface PortfolioTabsProps {
  readonly draftsGateway?: DraftsAndOrdersGateway;
  readonly gateway?: PortfolioMonitorGateway;
  /** ?tab= from the server request (the page's searchParams). */
  readonly initialTab?: string | undefined;
  /** From the server session. The ibkr-monitor sections are operator-only. */
  readonly operator?: boolean;
  readonly ordersGateway?: VertexOrdersGateway;
  /** From the server session. Order status, position buttons and Vertex orders are owner-only (admin operator, never agent viewer). */
  readonly owner?: boolean;
  readonly projection: ReactNode;
}

// Portfolio home (owner 2026-11-04): page header -> collapsible account Summary -> one sticky
// tab bar over the read-only ibkr-monitor sections, the research projection and the Vertex
// orders view. The open view is in ?tab=; without it the last chosen view (this browser)
// opens. Non-operators get the projection only.
export const PortfolioTabs = ({
  projection,
  gateway: suppliedGateway,
  ordersGateway: suppliedOrdersGateway,
  draftsGateway: suppliedDraftsGateway,
  initialTab,
  operator = false,
  owner = false,
}: PortfolioTabsProps) => {
  const [view, setView] = useStoredState(
    PORTFOLIO_VIEW_STORAGE_KEY,
    normalizePortfolioView
  );
  useLayoutEffect(() => {
    const migrated = migrateLegacyPortfolioView();
    if (migrated !== null) setView(migrated);
  }, [setView]);
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserIbkrMonitorGateway()
  );
  const [defaultOrdersGateway] = useState(createBrowserVertexOrdersGateway);
  const [defaultGoLiveGateway] = useState(createBrowserGoLiveDraftsGateway);
  const ordersGateway = owner
    ? (suppliedOrdersGateway ?? defaultOrdersGateway)
    : undefined;
  const draftsGateway = useMemo((): DraftsAndOrdersGateway => {
    if (suppliedDraftsGateway !== undefined) return suppliedDraftsGateway;
    return ordersGateway === undefined
      ? { drafts: (options) => defaultGoLiveGateway.queue(options) }
      : {
          drafts: (options) => defaultGoLiveGateway.queue(options),
          orders: (options) => ordersGateway.status({}, options),
        };
  }, [suppliedDraftsGateway, ordersGateway, defaultGoLiveGateway]);
  if (!operator)
    return (
      <div className="space-y-4">
        <PageHeader title="Portfolio" />
        {projection}
      </div>
    );
  const defaultTab =
    ordersGateway === undefined && view === "orders" ? "positions" : view;
  const extraTabs = [
    {
      value: "projection",
      label: "Projection",
      content: projection,
    },
    ...(ordersGateway === undefined
      ? []
      : [
          {
            value: "orders",
            label: "Vertex orders",
            content: <VertexOrders gateway={ordersGateway} />,
          },
        ]),
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Portfolio" />
      <DraftsAndOrders gateway={draftsGateway} />
      <PortfolioMonitor
        defaultTab={defaultTab}
        extraTabs={extraTabs}
        gateway={gateway}
        initialTab={initialTab}
        onTabShown={rememberView}
        {...(ordersGateway === undefined ? {} : { ordersGateway })}
        title="Portfolio · IBKR (via ibkr-monitor)"
      />
    </div>
  );
};
