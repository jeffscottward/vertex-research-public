"use client";

import {
  createApiClient,
  type EngineStatus,
  type EnginesStatusOutput,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  StatCard,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Engines view (audit phase 5): state of the rig trading-engine timers (engines.status). Read-only:
// it shows unit state only and cannot start, stop or change an engine.

export interface EnginesGateway {
  readonly status: () => Promise<EnginesStatusOutput>;
}

export const createBrowserEnginesGateway = (): EnginesGateway => {
  let client: ReturnType<typeof createApiClient> | undefined;
  return Object.freeze({
    status: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.engines.status({});
    },
  });
};

export const ENGINES_REFRESH_MS = 60_000;

/** Summary order on the page: healthy first, then the states that need a look. */
const HEALTH_LABELS = ["OK", "Running", "Timer off", "Failed"] as const;

type Health = Readonly<{
  label: (typeof HEALTH_LABELS)[number];
  tone: "success" | "warning" | "info" | "destructive";
}>;

export const engineHealth = (engine: EngineStatus): Health => {
  if (engine.serviceState === "failed" || engine.result !== "success")
    return { label: "Failed", tone: "destructive" };
  if (engine.serviceState === "active" || engine.serviceState === "activating")
    return { label: "Running", tone: "info" };
  if (!engine.timerActive) return { label: "Timer off", tone: "warning" };
  return { label: "OK", tone: "success" };
};

const when = (value: string | null): string =>
  value === null
    ? "—"
    : new Date(value).toLocaleString("en-US", {
        dateStyle: "short",
        timeStyle: "short",
      });

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: EnginesStatusOutput }>;

export const EnginesWorkspace = ({
  gateway: supplied,
}: Readonly<{ gateway?: EnginesGateway }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserEnginesGateway());
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    try {
      return setState({ type: "ready", data: await gateway.status() });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      return setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { type: "error", message: `${failure.code}: ${failure.message}` }
      );
    }
  }, [gateway]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), ENGINES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="engines" />;
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading engine status…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-3" data-engines-state="error">
        <p className="text-sm" role="alert">
          Engine status unavailable. {state.message}
        </p>
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  const counts = HEALTH_LABELS.map((label) => ({
    label,
    value: data.engines.filter((engine) => engineHealth(engine).label === label)
      .length,
  }));
  return (
    <div className="space-y-6" data-engines-state="ready">
      {data.stale ? (
        <p className="text-sm" data-engines-stale="" role="alert">
          The rig has not pushed for more than 3 minutes. These states may be
          old.
        </p>
      ) : null}
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
        data-engines-summary=""
      >
        {counts.map((count) => (
          <StatCard
            className="gap-1 px-4 py-3"
            key={count.label}
            label={count.label}
            value={count.value}
          />
        ))}
      </div>
      <Panel
        description={
          <span role="note">
            Timer state from the rig, pushed every minute. Read-only: no logs,
            and nothing here starts or stops an engine. Pushed{" "}
            {when(data.generatedAt)}.
          </span>
        }
        flush={data.engines.length > 0}
        title="Engine timers"
      >
        {data.engines.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No engine timers found.
          </p>
        ) : (
          <Table className="text-sm">
            <TableCaption className="sr-only">Engine timers</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Engine</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead className="hidden sm:table-cell" scope="col">
                  Last run
                </TableHead>
                <TableHead className="hidden sm:table-cell" scope="col">
                  Next run
                </TableHead>
                <TableHead className="hidden sm:table-cell" scope="col">
                  Result
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.engines.map((engine) => {
                const health = engineHealth(engine);
                return (
                  <TableRow data-engine={engine.unit} key={engine.unit}>
                    <TableHead
                      className="whitespace-normal font-mono"
                      scope="row"
                    >
                      {engine.unit}
                      {/* Phones show only two columns, so the runs stack under the name. */}
                      <span
                        className="block font-normal font-sans text-muted-foreground text-xs sm:hidden"
                        data-engine-runs-mobile=""
                      >
                        {`Last ${when(engine.lastRunAt)} · Next ${when(engine.nextRunAt)}`}
                        {engine.result === "success"
                          ? ""
                          : ` · ${engine.result}`}
                      </span>
                    </TableHead>
                    <TableCell>
                      <StatusBadge
                        data-health={health.label}
                        status={health.tone}
                      >
                        {health.label}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {when(engine.lastRunAt)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {when(engine.nextRunAt)}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {engine.result}
                      {engine.exitStatus === null || engine.exitStatus === 0
                        ? ""
                        : ` (exit ${engine.exitStatus})`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
};
