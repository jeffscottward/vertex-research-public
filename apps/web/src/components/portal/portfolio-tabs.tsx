"use client";

import { PageHeader } from "@darkfactory/ui";
import type { ReactNode } from "react";
import { useLayoutEffect, useState } from "react";

import { PortfolioMonitor } from "./portfolio-monitor.tsx";
import {
  createBrowserIbkrMonitorGateway,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import { VertexOrders } from "./vertex-orders.tsx";
import {
  createBrowserVertexOrdersGateway,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";
import {
  TabPanel,
  TabStrip,
  readStored,
  useStoredState,
} from "./portfolio-monitor-controls.tsx";
import { MONITOR_SECTIONS } from "./portfolio-monitor-model.ts";

export const PORTFOLIO_VIEW_STORAGE_KEY = "vertex.portfolio.view.v2";
/** The v1 key ("ibkr" | "projection" | "orders"); read once as a fallback. */
export const LEGACY_PORTFOLIO_VIEW_STORAGE_KEY = "vertex.portfolio.view.v1";

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

const VIEW_TABS = [
  { id: "positions" as const, label: "Positions" },
  { id: "orders-stops" as const, label: "Orders & stops" },
  { id: "pnl" as const, label: "P&L" },
  { id: "allocation" as const, label: "Allocation" },
  { id: "options" as const, label: "Options" },
  { id: "projection" as const, label: "Projection" },
  { id: "orders" as const, label: "Vertex orders" },
];

interface PortfolioTabsProps {
  readonly projection: ReactNode;
  readonly gateway?: PortfolioMonitorGateway;
  readonly ordersGateway?: VertexOrdersGateway;
  /** From the server session. The ibkr-monitor sections are operator-only. */
  readonly operator?: boolean;
}

// Portfolio home: one tab strip over the read-only ibkr-monitor sections, the research
// projection and the Vertex orders view.
// The choice is saved in this browser. Non-operators get the projection only.
export const PortfolioTabs = ({
  projection,
  gateway: suppliedGateway,
  ordersGateway: suppliedOrdersGateway,
  operator = false,
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
  const [ordersGateway] = useState(
    () => suppliedOrdersGateway ?? createBrowserVertexOrdersGateway()
  );
  if (!operator)
    return (
      <div className="space-y-4">
        <PageHeader title="Portfolio" />
        {projection}
      </div>
    );
  return (
    <div className="space-y-4">
      <PageHeader title="Portfolio" />
      <TabStrip
        idPrefix="portfolio"
        label="Portfolio views"
        onChange={setView}
        tabs={VIEW_TABS}
        value={view}
      />
      <TabPanel id={view} idPrefix="portfolio">
        {view === "projection" ? (
          projection
        ) : view === "orders" ? (
          <VertexOrders gateway={ordersGateway} />
        ) : (
          <PortfolioMonitor
            gateway={gateway}
            section={view}
            title="Portfolio · IBKR (via ibkr-monitor)"
          />
        )}
      </TabPanel>
    </div>
  );
};
