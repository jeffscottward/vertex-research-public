"use client";

import {
  createApiClient,
  type ApiClient,
  type PortfolioMonitorOutput,
  type RoundHandleCheckOutput,
} from "@darkfactory/api";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

// Read-only IBKR portfolio snapshot (portfolioMonitor.snapshot). No write procedure exists.
export interface PortfolioMonitorGateway {
  readonly snapshot: () => Promise<PortfolioMonitorOutput>;
  // Only the ibkr-monitor source has the round-number (.00/.50) check of open orders.
  readonly roundHandles?: () => Promise<RoundHandleCheckOutput>;
}

export const createPortfolioMonitorGateway = (
  client: ApiClient
): PortfolioMonitorGateway => ({
  snapshot: () => client.portfolioMonitor.snapshot({}),
});

export const createBrowserPortfolioMonitorGateway =
  (): PortfolioMonitorGateway => {
    let gateway: PortfolioMonitorGateway | undefined;
    const current = (): PortfolioMonitorGateway => {
      gateway ??= createPortfolioMonitorGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway;
    };
    return Object.freeze({
      snapshot: () => current().snapshot(),
    });
  };

export type IbkrMonitorGateway = PortfolioMonitorGateway &
  Readonly<{ roundHandles: () => Promise<RoundHandleCheckOutput> }>;

// Portfolio tab: the same view, read from the ibkr-monitor service through ibkrMonitor.snapshot.
export const createIbkrMonitorGateway = (
  client: ApiClient
): IbkrMonitorGateway => ({
  snapshot: () => client.ibkrMonitor.snapshot({}),
  roundHandles: () => client.ibkrMonitor.roundHandles({}),
});

export const createBrowserIbkrMonitorGateway = (): IbkrMonitorGateway => {
  let gateway: IbkrMonitorGateway | undefined;
  const current = (): IbkrMonitorGateway => {
    gateway ??= createIbkrMonitorGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    snapshot: () => current().snapshot(),
    roundHandles: () => current().roundHandles(),
  });
};

// forbidden: not an operator. not-configured: server has no VERTEX_PORTFOLIO_URL.
// unavailable: the VPS service or IB Gateway did not answer. unauthorized: session ended.
export type PortfolioMonitorFailureKind =
  | "forbidden"
  | "not-configured"
  | "unavailable"
  | "unauthorized"
  | "error";

export type PortfolioMonitorFailure = Readonly<{
  kind: PortfolioMonitorFailureKind;
  code: string;
  message: string;
}>;

const field = (value: unknown, key: string): unknown => {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
};

const text = (value: unknown): string | null => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const kindFor = (error: unknown, code: string): PortfolioMonitorFailureKind => {
  if (isOperatorAccessDenied(error)) return "forbidden";
  if (code === "NOT_CONFIGURED") return "not-configured";
  if (code === "UNAVAILABLE" || code === "UPSTREAM_ERROR") return "unavailable";
  if (code === "UNAUTHORIZED") return "unauthorized";
  return "error";
};

// Keeps the server's oRPC code and message so the operator can see the real cause.
export const describePortfolioMonitorFailure = (
  error: unknown
): PortfolioMonitorFailure => {
  const code = text(field(error, "code")) ?? "ERROR";
  const kind = kindFor(error, code);
  const message =
    kind === "forbidden"
      ? "Operator access required"
      : (text(field(error, "message")) ?? "Request failed");
  return { kind, code, message };
};
