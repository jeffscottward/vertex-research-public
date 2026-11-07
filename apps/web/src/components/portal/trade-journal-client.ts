"use client";

// What: where the Trade Journal reads its fills (one read-only IBKR snapshot) and a one-shot
// loader hook shared by the journal page and the Mission control widgets.
// See: portfolio-monitor-client.ts (the same snapshot procedures /portfolio uses).
import {
  type ApiClient,
  createApiClient,
  type PortfolioMonitorOutput,
} from "@darkfactory/api";
import { useEffect, useState } from "react";

/**
 * ibkr-monitor: ibkrMonitor.snapshot (IBKR_MONITOR_URL), the reader /portfolio uses.
 * portfolio-monitor: portfolioMonitor.snapshot (VERTEX_PORTFOLIO_URL).
 * Both return PortfolioMonitorOutput with the same executions list.
 */
export type JournalSource = "ibkr-monitor" | "portfolio-monitor";

export type JournalSnapshotLoader = () => Promise<PortfolioMonitorOutput>;

export const journalSnapshotFor = (
  client: ApiClient,
  source: JournalSource
): JournalSnapshotLoader =>
  source === "ibkr-monitor"
    ? () => client.ibkrMonitor.snapshot({})
    : () => client.portfolioMonitor.snapshot({});

/** The API client is created on the first call, in the browser. */
export const createBrowserJournalLoader = (
  source: JournalSource
): JournalSnapshotLoader => {
  let load: JournalSnapshotLoader | undefined;
  return () => {
    load ??= journalSnapshotFor(
      createApiClient({ baseUrl: window.location.origin }),
      source
    );
    return load();
  };
};

export type LoadState<T> =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; value: T }>
  | Readonly<{ type: "error"; error: unknown }>;

/**
 * Calls `load` once per (load, reloadKey). A null `load` sends nothing and stays idle.
 * `load` must keep its identity across renders (state, memo or a module function).
 */
export const useLoadOnce = <T>(
  load: (() => Promise<T>) | null,
  reloadKey = 0
): LoadState<T> => {
  const [state, setState] = useState<LoadState<T>>(
    load === null ? { type: "idle" } : { type: "loading" }
  );
  useEffect(() => {
    if (load === null) {
      setState({ type: "idle" });
      return;
    }
    let alive = true;
    setState({ type: "loading" });
    load().then(
      (value) => {
        if (alive) setState({ type: "ready", value });
      },
      (error: unknown) => {
        if (alive) setState({ error, type: "error" });
      }
    );
    return () => {
      alive = false;
    };
  }, [load, reloadKey]);
  return state;
};
