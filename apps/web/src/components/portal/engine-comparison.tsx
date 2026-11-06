"use client";

import {
  type ApiClient,
  createApiClient,
  type EngineComparisonListOutput,
  type EngineComparisonRun,
  type EngineComparisonTiming,
  type EngineDifferences,
} from "@darkfactory/api";
import { StatusBadge } from "@darkfactory/ui";
import { useEffect, useState } from "react";

// Engine comparison (dual run) views: the TypeScript timing line, the Nautilus status of a
// comparison group (polled until every run is done) and the differences badge. The TypeScript
// result is shown at once; the Nautilus side follows when the research worker on the rig finishes.
// Research only; no orders.

export interface EngineComparisonGateway {
  readonly comparisons: (
    groupId: string
  ) => Promise<EngineComparisonListOutput>;
}

export const createEngineComparisonGateway = (
  client: ApiClient
): EngineComparisonGateway => ({
  comparisons: (groupId) =>
    client.backtestRuns.comparisons.list({ groupId, limit: 500 }),
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserEngineComparisonGateway =
  (): EngineComparisonGateway => ({
    comparisons: (groupId) =>
      createEngineComparisonGateway(
        createApiClient({ baseUrl: window.location.origin })
      ).comparisons(groupId),
  });

const COMPARISON_POLL_MS = 2000;
/** 20 minutes: the worker's 10-minute pickup limit plus the 9-minute run limit. */
export const COMPARISON_POLL_MAX = 600;

/** Milliseconds as "123 ms" or "1.2 s"; "n/a" without a value. */
export const formatMs = (ms: number | null): string => {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
};

const isDone = (run: EngineComparisonRun): boolean =>
  run.status === "succeeded" || run.status === "failed";

export type ComparisonState = Readonly<{
  runs: readonly EngineComparisonRun[] | null;
  message: string | null;
}>;

/**
 * Reads the comparison group and polls it while a run is queued or running, up to the poll limit.
 * A new `revision` (for example a campaign tick) reads it again.
 */
export const useComparisonRuns = (
  gateway: EngineComparisonGateway,
  groupId: string | null,
  pollMs = COMPARISON_POLL_MS,
  pollMax = COMPARISON_POLL_MAX,
  revision: unknown = null
): ComparisonState => {
  const [state, setState] = useState<ComparisonState>({
    message: null,
    runs: null,
  });
  useEffect(() => {
    setState({ message: null, runs: null });
    if (groupId === null) return;
    let active = true;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      reads += 1;
      gateway.comparisons(groupId).then(
        ({ runs }) => {
          if (!active) return;
          setState({ message: null, runs });
          const waiting = !runs.every(isDone);
          if (waiting && reads < pollMax) timer = setTimeout(read, pollMs);
        },
        () => {
          if (!active) return;
          setState((previous) => ({
            ...previous,
            message: "The Nautilus status could not be read.",
          }));
          if (reads < pollMax) timer = setTimeout(read, pollMs);
        }
      );
    };
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [gateway, groupId, pollMs, pollMax, revision]);
  return state;
};

/** "TypeScript · <host> · <client ms>", with the server engine time when the runtime clock moved. */
export const TypeScriptEngineLine = ({
  timing,
  clientMs,
}: Readonly<{ timing: EngineComparisonTiming; clientMs: number | null }>) => (
  <p className="text-muted-foreground text-xs" data-engine="typescript">
    TypeScript · {timing.host} ·{" "}
    {clientMs === null
      ? "shown from this visit's cache"
      : `${formatMs(clientMs)} (round trip)`}
    {timing.wallMs === null
      ? ` · engine time n/a (${timing.wallNote ?? "not measured"})`
      : ` · engine ${formatMs(timing.wallMs)}`}
  </p>
);

/** The status text of one Nautilus run: queued, running, its engine time and queue wait, or failed. */
export const nautilusRunText = (run: EngineComparisonRun): string => {
  if (run.status === "queued") return "queued";
  if (run.status === "running")
    return `running (queue ${formatMs(run.queueWaitMs)})`;
  if (run.status === "failed") return `failed: ${run.error ?? "no reason"}`;
  return `${formatMs(run.engineRun?.wallMs ?? null)} (queue ${formatMs(run.queueWaitMs)})`;
};

/** "match", "N differences" (with the list) or nothing while the run is not done. */
export const DifferencesBadge = ({
  differences,
}: Readonly<{ differences: EngineDifferences | null }>) => {
  if (differences === null) return null;
  if (differences.ok)
    return (
      <StatusBadge data-differences="0" status="success">
        match
      </StatusBadge>
    );
  const count = differences.items.length;
  return (
    <details className="text-xs" data-differences={count}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center">
        <StatusBadge status="warning">
          {count} {count === 1 ? "difference" : "differences"}
        </StatusBadge>
      </summary>
      <ul className="mt-1 space-y-1 text-muted-foreground">
        {differences.items.map((item) => (
          <li key={`${item.field}:${item.detail}`}>
            {item.field}: TypeScript {String(item.typescript ?? "n/a")},
            Nautilus {String(item.nautilus ?? "n/a")}. {item.detail}
          </li>
        ))}
      </ul>
    </details>
  );
};

/** One run's Nautilus status and differences badge, for a table cell or a list row. */
export const NautilusRunStatus = ({
  run,
}: Readonly<{ run: EngineComparisonRun | undefined }>) => {
  if (run === undefined)
    return (
      <span className="text-muted-foreground text-xs" data-nautilus="none">
        not repeated
      </span>
    );
  return (
    <span
      className="inline-flex flex-wrap items-center gap-2 text-xs"
      data-nautilus={run.status}
    >
      <span>{nautilusRunText(run)}</span>
      <DifferencesBadge differences={run.differences} />
    </span>
  );
};

/** Counts for a group summary line. */
export const comparisonSummary = (
  runs: readonly EngineComparisonRun[]
): Readonly<{
  done: number;
  matched: number;
  differing: number;
  failed: number;
}> => ({
  differing: runs.filter((run) => run.differences?.ok === false).length,
  done: runs.filter(isDone).length,
  failed: runs.filter((run) => run.status === "failed").length,
  matched: runs.filter((run) => run.differences?.ok === true).length,
});

/**
 * The Nautilus card of one comparison group (instant backtest): status of its run, engine time,
 * queue wait and the differences badge. Its space is reserved, so the page does not shift.
 */
export const NautilusCard = ({
  gateway,
  timing,
  pollMs,
  pollMax,
}: Readonly<{
  gateway: EngineComparisonGateway;
  timing: EngineComparisonTiming;
  pollMs?: number;
  pollMax?: number;
}>) => {
  const state = useComparisonRuns(gateway, timing.groupId, pollMs, pollMax);
  const run = state.runs?.[0];
  const host = run?.engineRun?.host ?? "rig";
  return (
    <section
      aria-label="Nautilus result"
      aria-live="polite"
      className="min-h-20 rounded-xl border p-3 text-sm"
      data-nautilus-card={
        run?.status ?? (timing.error === undefined ? "waiting" : "error")
      }
    >
      {timing.error === undefined ? (
        <>
          <p className="font-medium">
            Nautilus · {host} ·{" "}
            {run === undefined ? "queued" : nautilusRunText(run)}
          </p>
          {run === undefined ? null : (
            <DifferencesBadge differences={run.differences} />
          )}
          {state.message === null ? null : (
            <p className="text-destructive text-xs">{state.message}</p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">Nautilus · {timing.error}</p>
      )}
    </section>
  );
};

/** Sweep summary: the TypeScript line and how many repeated cells Nautilus finished and matched. */
export const SweepComparisonSummary = ({
  timing,
  clientMs,
  state,
}: Readonly<{
  timing: EngineComparisonTiming &
    Readonly<{ queued: number; dropped: number }>;
  clientMs: number | null;
  state: ComparisonState;
}>) => {
  const runs = state.runs ?? [];
  const summary = comparisonSummary(runs);
  return (
    <div
      aria-live="polite"
      className="min-h-16 space-y-1 rounded-xl border p-3 text-sm"
      data-sweep-comparison={timing.groupId === null ? "none" : "on"}
    >
      <TypeScriptEngineLine clientMs={clientMs} timing={timing} />
      <p>
        {timing.error === undefined
          ? `Nautilus · ${runs[0]?.engineRun?.host ?? "rig"} · ${summary.done} of ${timing.queued} cells done, ${summary.matched} match, ${summary.differing} differ, ${summary.failed} failed.`
          : `Nautilus · ${timing.error}`}
      </p>
      <p className="text-muted-foreground text-xs">
        Nautilus repeats at most the first 100 cells of a sweep
        {timing.dropped > 0
          ? `; ${timing.dropped} cells were not repeated`
          : ""}
        . Cells the TypeScript engine refused are not repeated.
      </p>
      {state.message === null ? null : (
        <p className="text-destructive text-xs">{state.message}</p>
      )}
    </div>
  );
};

/** The Nautilus checks of one gated Autopilot candidate: one line per repeated gate run. */
export const GateNautilusStatus = ({
  runs,
}: Readonly<{ runs: readonly EngineComparisonRun[] | undefined }>) => {
  if (runs === undefined || runs.length === 0)
    return <NautilusRunStatus run={undefined} />;
  return (
    <ul className="space-y-1">
      {runs.map((run) => (
        <li key={run.id}>
          <span className="text-muted-foreground text-xs">
            {run.comparison.label.split(": ").at(-1)}:{" "}
          </span>
          <NautilusRunStatus run={run} />
        </li>
      ))}
    </ul>
  );
};

/** Comparison runs by their key (sweep cell index, Autopilot candidate id). */
export const runsByKey = (
  runs: readonly EngineComparisonRun[] | null
): ReadonlyMap<string, readonly EngineComparisonRun[]> => {
  const byKey = new Map<string, EngineComparisonRun[]>();
  for (const run of runs ?? []) {
    const key = run.comparison.key ?? "";
    byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  return byKey;
};
