"use client";

import type {
  DeployServiceStatusOutput,
  DeploymentStatusOutput,
} from "@darkfactory/api";
import {
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  OperatorAccessRequired,
  createBrowserDeploymentGateway,
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  type DeploymentGateway,
} from "./agent-ops-client.tsx";
import {
  DEFAULT_DEPLOYMENT_TAB,
  DeploymentTabs,
  EquityPanel,
  FillsPanel,
  LogsPanel,
  OrdersPanel,
  PositionsPanel,
  RiskPanel,
  StatusStrip,
  isDeploymentTab,
  type DeploymentTab,
} from "./deployments-snapshot.tsx";

// Read-only QuantVPS trading-stack monitor. Renders agentOps.deployment.status; there are no
// controls that act on services. Auto-refresh runs every 30 s while the document is visible.

const DEPLOYMENT_REFRESH_MS = 30_000;
const DEPLOYMENT_LOG_WINDOW_LINES = 500;

export interface DeploymentsWorkspaceProps {
  readonly gateway?: DeploymentGateway;
  readonly refreshMs?: number;
  readonly now?: () => Date;
}

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{
      type: "ready";
      data: DeploymentStatusOutput;
      refreshError: string | null;
    }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "not_configured" }>
  | Readonly<{ type: "forbidden" }>;

export type DeploymentAlert = Readonly<{ service: string; message: string }>;

const errorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : null;
};

const formatUtc = (value: string | null): string => {
  if (value === null) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
};

export const formatAge = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
};

const secondsBetween = (from: string, to: Date): number => {
  return Math.max(0, Math.floor((to.getTime() - Date.parse(from)) / 1000));
};

const stateDetail = (service: DeployServiceStatusOutput): string => {
  if (!service.present) return "container missing";
  const status = service.status ?? "unknown";
  if (service.startedAt === null) return `status ${status}, never started`;
  const exit =
    service.exitCode === null ? "" : `, exit code ${service.exitCode}`;
  const oom = service.oomKilled ? ", OOM killed" : "";
  return `status ${status}${exit}${oom}`;
};

// Alert rows for the services that gate trading: Nautilus not running, IB Gateway not running or unhealthy.
export const deploymentAlerts = (
  services: readonly DeployServiceStatusOutput[]
): DeploymentAlert[] => {
  const alerts: DeploymentAlert[] = [];
  const find = (name: string) =>
    services.find((service) => service.service === name);
  const nautilus = find("nautilus-trader");
  if (nautilus === undefined) {
    alerts.push({
      service: "nautilus-trader",
      message: "Nautilus is not running: not reported by the status endpoint",
    });
  } else if (!(nautilus.present && nautilus.running)) {
    alerts.push({
      service: "nautilus-trader",
      message: `Nautilus is not running: ${stateDetail(nautilus)}`,
    });
  }
  const gateway = find("ib-gateway");
  if (gateway === undefined) {
    alerts.push({
      service: "ib-gateway",
      message: "IB Gateway is not running: not reported by the status endpoint",
    });
  } else if (!(gateway.present && gateway.running)) {
    alerts.push({
      service: "ib-gateway",
      message: `IB Gateway is not running: ${stateDetail(gateway)}`,
    });
  } else if (gateway.health === "unhealthy") {
    alerts.push({
      service: "ib-gateway",
      message: "IB Gateway is unhealthy: container health check failing",
    });
  }
  return alerts;
};

export const upSinceText = (
  service: DeployServiceStatusOutput,
  now: Date
): string => {
  if (!service.present) return "—";
  if (service.running && service.startedAt !== null) {
    return `${formatUtc(service.startedAt)} (${formatAge(secondsBetween(service.startedAt, now))})`;
  }
  if (service.startedAt === null) return "never started";
  return service.finishedAt === null
    ? "stopped"
    : `stopped ${formatUtc(service.finishedAt)}`;
};

const stateText = (service: DeployServiceStatusOutput): string => {
  if (!service.present) return "missing";
  const base = service.status ?? "unknown";
  const exit =
    !service.running && service.exitCode !== null && service.startedAt !== null
      ? ` (exit ${service.exitCode})`
      : "";
  return `${base}${exit}${service.oomKilled ? " OOM" : ""}`;
};

const isProblem = (service: DeployServiceStatusOutput): boolean => {
  return (
    !(service.present && service.running) ||
    service.health === "unhealthy" ||
    service.oomKilled
  );
};

const cell = "whitespace-nowrap px-2 py-1.5 align-top";

const readInitialTab = (): DeploymentTab => {
  if (typeof window === "undefined") return DEFAULT_DEPLOYMENT_TAB;
  const value = new URLSearchParams(window.location.search).get("tab");
  return isDeploymentTab(value) ? value : DEFAULT_DEPLOYMENT_TAB;
};

// Keeps ?tab= in the address bar so a view can be linked and restored.
const writeTab = (tab: DeploymentTab): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (tab === DEFAULT_DEPLOYMENT_TAB) {
    url.searchParams.delete("tab");
  } else url.searchParams.set("tab", tab);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const ServicesTable = ({
  services,
  current,
}: {
  readonly services: readonly DeployServiceStatusOutput[];
  readonly current: Date;
}) => {
  return (
    <div
      aria-label="QuantVPS container state"
      className="overflow-x-auto"
      data-deployment-scroll="services"
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
      tabIndex={0}
    >
      <Table
        containerClassName="overflow-visible"
        className="w-full min-w-[56rem] text-sm"
      >
        <TableCaption className="sr-only">
          QuantVPS container state
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
            <TableHead
              className={cn("text-muted-foreground", cell)}
              scope="col"
            >
              Service
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", cell)}
              scope="col"
            >
              State
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", cell)}
              scope="col"
            >
              Health
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", cell)}
              scope="col"
            >
              Up since
            </TableHead>
            <TableHead
              className={`text-muted-foreground ${cell} text-right`}
              scope="col"
            >
              Restarts
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", cell)}
              scope="col"
            >
              Last log
            </TableHead>
            <TableHead
              className={`text-muted-foreground ${cell} text-right`}
              scope="col"
            >
              Errors/Warns (last {DEPLOYMENT_LOG_WINDOW_LINES} lines)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((service) => {
            return (
              <TableRow
                className={`border-border border-b ${isProblem(service) ? "text-destructive" : ""}`}
                data-deployment-service={service.service}
                key={service.service}
              >
                <TableCell className={`${cell} font-mono`}>
                  {service.service}
                  {service.image === null || service.image === "" ? null : (
                    <span className="block text-muted-foreground text-xs">
                      {service.image}
                    </span>
                  )}
                </TableCell>
                <TableCell className={`${cell} font-mono`}>
                  {stateText(service)}
                </TableCell>
                <TableCell className={`${cell} font-mono`}>
                  {service.health ?? "—"}
                </TableCell>
                <TableCell className={`${cell} font-mono text-xs`}>
                  {upSinceText(service, current)}
                </TableCell>
                <TableCell className={`${cell} text-right font-mono`}>
                  {service.restartCount ?? "—"}
                </TableCell>
                <TableCell className={`${cell} font-mono text-xs`}>
                  {service.log === null
                    ? "—"
                    : formatUtc(service.log.lastLineAt)}
                </TableCell>
                <TableCell className={`${cell} text-right font-mono`}>
                  {service.log === null
                    ? "—"
                    : `${service.log.errorLines} / ${service.log.warnLines}`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

export const DeploymentsWorkspace = ({
  gateway: suppliedGateway,
  refreshMs = DEPLOYMENT_REFRESH_MS,
  now = () => new Date(),
}: DeploymentsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserDeploymentGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<DeploymentTab>(readInitialTab);
  const selectTab = useCallback((next: DeploymentTab) => {
    setTab(next);
    return writeTab(next);
  }, []);
  const inFlight = useRef(false);
  // 401/403 cannot be fixed by polling: stop the timer and tab-return reloads.
  // The Reload button still asks again.
  const stopped = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current || stopped.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const data = await gateway.status();
      return setState({ type: "ready", data, refreshError: null });
    } catch (error) {
      if (isOperatorAccessDenied(error)) {
        stopped.current = true;
        return setState({ type: "forbidden" });
      }
      if (errorCode(error) === "UNAUTHORIZED") stopped.current = true;
      if (errorCode(error) === "NOT_CONFIGURED") {
        return setState({ type: "not_configured" });
      }
      const message = describeAgentOpsFailure(error);
      return setState((previous) => {
        return previous.type === "ready"
          ? { ...previous, refreshError: message }
          : { type: "error", message };
      });
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    const tick = () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState === "visible"
      )
        return void load();
      return;
    };
    const timer = setInterval(tick, refreshMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") return void load();
      return;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      return document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, refreshMs]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="deployments" />;

  const reload = (
    <Button
      disabled={refreshing}
      onClick={() => {
        stopped.current = false;
        return void load();
      }}
      type="button"
      variant="secondary"
    >
      <RotateCcw aria-hidden="true" className="size-4" />
      {refreshing ? "Reloading…" : "Reload"}
    </Button>
  );

  if (state.type === "loading") {
    return (
      <p aria-busy="true" className="text-muted-foreground text-sm">
        Loading deployment status…
      </p>
    );
  }

  if (state.type === "not_configured") {
    return (
      <div
        className="space-y-2 rounded-md border border-border p-4"
        data-deployment-state="not-configured"
        role="status"
      >
        <p className="font-medium text-sm">Deployment status not configured</p>
        <p className="text-muted-foreground text-sm">
          Set VERTEX_DEPLOY_STATUS_URL (https) and VERTEX_DEPLOY_STATUS_TOKEN
          (at least 32 characters) on the server to read QuantVPS container
          state.
        </p>
        {reload}
      </div>
    );
  }

  if (state.type === "error") {
    return (
      <div className="space-y-2" data-deployment-state="error" role="alert">
        <p className="text-sm">{state.message}</p>
        {reload}
      </div>
    );
  }

  const { data, refreshError } = state;
  const current = now();
  const alerts = deploymentAlerts(data.services);
  return (
    <div className="space-y-4" data-deployment-state="ready">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className="text-muted-foreground text-xs"
          data-deployment-snapshot=""
        >
          Host <span className="font-mono">{data.source.host}</span> · snapshot{" "}
          {formatUtc(data.source.generatedAt)} · age{" "}
          {formatAge(data.source.ageSeconds)} · fetched{" "}
          {formatUtc(data.fetchedAt)} · refresh every{" "}
          {Math.round(refreshMs / 1000)} s while visible
        </p>
        {reload}
      </div>
      {data.source.stale ? (
        <p
          className="font-medium text-destructive text-sm"
          data-deployment-stale=""
          role="alert"
        >
          Stale snapshot: generated {formatAge(data.source.ageSeconds)} ago
          (limit 120 s)
        </p>
      ) : null}
      {data.snapshotError === undefined ? null : (
        <p
          className="font-medium text-sm text-warning-foreground"
          data-deployment-snapshot-error=""
          role="status"
        >
          {data.snapshotError}
        </p>
      )}
      {refreshError === null ? null : (
        <p
          className="text-destructive text-sm"
          data-deployment-refresh-error=""
          role="alert"
        >
          Last reload failed: {refreshError} Showing the previous snapshot.
        </p>
      )}
      {alerts.length === 0 ? null : (
        <ul className="space-y-1" data-deployment-alerts="">
          {alerts.map((alert) => {
            return (
              <li
                className="rounded-md border border-destructive px-3 py-2 font-medium text-destructive text-sm"
                data-deployment-alert={alert.service}
                key={alert.service}
                role="alert"
              >
                {alert.message}
              </li>
            );
          })}
        </ul>
      )}
      <StatusStrip data={data} />
      <RiskPanel data={data} />
      <DeploymentTabs
        onTab={selectTab}
        panels={{
          positions: () => <PositionsPanel data={data} />,
          orders: () => <OrdersPanel data={data} />,
          fills: () => <FillsPanel data={data} />,
          equity: () => <EquityPanel data={data} />,
          logs: () => <LogsPanel data={data} />,
          services: () => (
            <ServicesTable current={current} services={data.services} />
          ),
        }}
        tab={tab}
      />
    </div>
  );
};
