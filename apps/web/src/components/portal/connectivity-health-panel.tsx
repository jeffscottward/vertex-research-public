"use client";

import {
  type ConnectivityHealthOutput,
  type ConnectivityProviderStatus,
  createApiClient,
} from "@darkfactory/api";
import { Button, Panel, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { statusTime } from "../status-time.ts";
import {
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailure,
} from "./portfolio-monitor-client.ts";

// Read-only Vertex feed connectivity & credential health diagnostics panel on /connections
// (card vertex-connectivity-audit-autofix). Surfaces QuantData, OpenBB, IBKR read-only feeds,
// and alert-delivery configuration so HTTP 401/403/5xx gaps never sit silently unaddressed.

export interface ConnectivityHealthGateway {
  readonly health: () => Promise<ConnectivityHealthOutput>;
}

export const createBrowserConnectivityHealthGateway =
  (): ConnectivityHealthGateway => {
    let gateway: ConnectivityHealthGateway | undefined;
    const current = (): ConnectivityHealthGateway => {
      if (gateway === undefined) {
        const client = createApiClient({ baseUrl: window.location.origin });
        gateway = {
          health: () => client.connectivity.health({}),
        };
      }
      return gateway;
    };
    return Object.freeze({
      health: () => current().health(),
    });
  };

const DEFAULT_GATEWAY = createBrowserConnectivityHealthGateway();

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; data: ConnectivityHealthOutput }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "error"; failure: PortfolioMonitorFailure }>;

const OVERALL_BADGE: Readonly<
  Record<
    ConnectivityHealthOutput["overallStatus"],
    Readonly<{ label: string; tone: "success" | "warning" | "destructive" }>
  >
> = {
  auth_failed: { label: "Credential rotation required", tone: "destructive" },
  degraded: { label: "Degraded feeds", tone: "warning" },
  healthy: { label: "Healthy", tone: "success" },
};

const PROVIDER_BADGE: Readonly<
  Record<
    ConnectivityProviderStatus["status"],
    Readonly<{
      label: string;
      tone: "success" | "warning" | "destructive" | "neutral";
    }>
  >
> = {
  auth_failed: { label: "Auth failed", tone: "destructive" },
  degraded: { label: "Degraded", tone: "warning" },
  healthy: { label: "Healthy", tone: "success" },
  not_configured: { label: "Not configured", tone: "neutral" },
};

const ConnectivityBody = ({
  data,
}: Readonly<{ data: ConnectivityHealthOutput }>) => (
  <div className="space-y-4">
    <p className="text-muted-foreground text-xs">
      Checked {statusTime(data.checkedAt)} · ntfy alerts{" "}
      {data.ntfyConfigured
        ? "configured"
        : "not configured (uses #omp-alerts fallback)"}
    </p>
    {data.issues.length > 0 ? (
      <div
        className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        data-connectivity-issues=""
        role="alert"
      >
        <p className="font-medium text-destructive">
          {data.overallStatus === "auth_failed"
            ? "Authentication / credential failure detected — owner credential rotation required (never auto-rotated)."
            : `${data.issues.length} active feed connectivity issue(s) detected.`}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {data.issues.map((issue) => (
            <li data-connectivity-issue={issue.key} key={issue.key}>
              <span className="font-medium">
                {issue.source} ({issue.provider})
              </span>
              : {issue.message}
              {issue.consecutiveFailures > 1
                ? ` (${issue.consecutiveFailures} consecutive)`
                : ""}
              {issue.escalation === "needs_you_credential_rotation" &&
              issue.envVars.length > 0
                ? ` · rotate ${issue.envVars.join(", ")}`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    <ul className="grid gap-3 sm:grid-cols-2">
      {data.providers.map((provider) => {
        const info = PROVIDER_BADGE[provider.status];
        return (
          <li
            className="space-y-1 rounded-md border border-border p-3"
            data-connectivity-provider={provider.id}
            key={provider.id}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">{provider.label}</span>
              <StatusBadge status={info.tone}>{info.label}</StatusBadge>
            </div>
            <p className="text-muted-foreground text-xs">{provider.summary}</p>
          </li>
        );
      })}
    </ul>
  </div>
);

export interface ConnectivityHealthPanelProps {
  readonly gateway?: ConnectivityHealthGateway;
}

export const ConnectivityHealthPanel = ({
  gateway = DEFAULT_GATEWAY,
}: ConnectivityHealthPanelProps) => {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await gateway.health();
      setState({ data, kind: "ready" });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      setState(
        failure.kind === "forbidden"
          ? { kind: "forbidden" }
          : { failure, kind: "error" }
      );
    } finally {
      setBusy(false);
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = state.kind === "ready" ? state.data : null;
  const badge = ready === null ? null : OVERALL_BADGE[ready.overallStatus];

  return (
    <Panel
      actions={
        <div className="flex items-center gap-2">
          {ready === null || badge === null ? null : (
            <StatusBadge
              data-connectivity-overall={ready.overallStatus}
              status={badge.tone}
            >
              {badge.label}
            </StatusBadge>
          )}
          <Button
            className="min-h-11"
            disabled={busy}
            onClick={() => void load()}
            size="sm"
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        </div>
      }
      description="Live status of QuantData, OpenBB, IBKR read-only feeds, runtime endpoints, and alert delivery."
      title="Feed connectivity & credentials"
    >
      {state.kind === "loading" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Checking feed connectivity…
        </p>
      ) : state.kind === "forbidden" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Operator access required to read feed connectivity diagnostics.
        </p>
      ) : state.kind === "error" ? (
        <p
          className="text-destructive text-sm"
          data-connectivity-error=""
          role="alert"
        >
          Connectivity check failed: {state.failure.message}
        </p>
      ) : (
        <ConnectivityBody data={state.data} />
      )}
    </Panel>
  );
};
