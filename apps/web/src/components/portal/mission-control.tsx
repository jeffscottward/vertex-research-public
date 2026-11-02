"use client";

import {
  AGENT_TASK_ATTENTION_STATUSES,
  AGENT_TASK_TERMINAL_STATUSES,
  RESEARCH_PAPER_STAGE_VALUES,
  type AgentOpsSummaryOutput,
  type AgentTaskOutput,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  InfoGlyph,
  OperatorAccessRequired,
  STAGE_LABELS,
  STATUS_LABELS,
  createBrowserAgentOpsGateway,
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  formatDuration,
  formatMetrics,
  formatTimestamp,
  labelFor,
  type AgentOpsGateway,
} from "./agent-ops-client.tsx";

export interface MissionControlProps {
  readonly gateway?: AgentOpsGateway;
  // Server session check outcome from the page; "error" only adds a notice, data still loads client-side.
  readonly summaryState?: Readonly<{ type: string }>;
}

type Loaded = Readonly<{
  summary: AgentOpsSummaryOutput;
  tasks: AgentTaskOutput[];
}>;

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: Loaded }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

const RECENT_RESULTS_LIMIT = 15;

// A wide table scrolls inside its own region instead of widening the page at 375 px. The region
// is focusable so keyboard users can scroll it (axe scrollable-region-focusable).
const TableScroll = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div
    aria-label={label}
    className="overflow-x-auto"
    data-table-scroll="true"
    role="region"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
    tabIndex={0}
  >
    {children}
  </div>
);

const TaskTable = ({
  caption,
  tasks,
  empty,
  showOutcome,
}: {
  readonly caption: string;
  readonly tasks: readonly AgentTaskOutput[];
  readonly empty: string;
  readonly showOutcome?: boolean;
}) => {
  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  }
  return (
    <TableScroll label={caption}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border border-b text-left text-muted-foreground text-xs">
            <th scope="col">Task</th>
            <th scope="col">Kind</th>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col">{showOutcome ? "Metrics" : "Duration"}</th>
            <th scope="col">Updated (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            return (
              <tr
                className="border-border border-b align-top"
                data-task-id={task.id}
                key={task.id}
              >
                <th className="py-1 font-normal" scope="row">
                  <a
                    className="underline-offset-2 hover:underline"
                    href={`/agents?task=${encodeURIComponent(task.id)}`}
                  >
                    {task.title}
                  </a>
                  {task.summary === null ? null : (
                    <div className="text-muted-foreground text-xs">
                      {task.summary.slice(0, 160)}
                    </div>
                  )}
                </th>
                <td className="py-1 font-mono text-xs">{task.kind}</td>
                <td className="py-1 font-mono text-xs">{task.agent}</td>
                <td className="py-1" data-status={task.status}>
                  {labelFor(STATUS_LABELS, task.status)}
                </td>
                <td className="py-1 font-mono text-xs">
                  {showOutcome
                    ? formatMetrics(task.metrics)
                    : formatDuration(task)}
                </td>
                <td className="py-1 font-mono text-muted-foreground text-xs">
                  {formatTimestamp(task.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
};

export const MissionControl = ({
  gateway: suppliedGateway,
  summaryState,
}: MissionControlProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentOpsGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      const [summary, tasks] = await Promise.all([
        gateway.summary(),
        gateway.listTasks({ limit: 200 }),
      ]);
      return setState({ type: "ready", data: { summary, tasks } });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { type: "error", message: describeAgentOpsFailure(error) }
      );
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const notice =
    summaryState?.type === "error" ? (
      <p className="text-muted-foreground text-xs" role="note">
        Workspace session summary unavailable; agent data below loads
        separately.
      </p>
    ) : null;

  if (state.type === "loading") {
    return (
      <div className="space-y-4">
        {notice}
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading agent activity…
        </p>
      </div>
    );
  }
  if (state.type === "forbidden") {
    return (
      <div className="space-y-4">
        {notice}
        <OperatorAccessRequired feature="mission-control" />
      </div>
    );
  }
  if (state.type === "error") {
    return (
      <div className="space-y-2" role="alert">
        {notice}
        <p className="text-sm">{state.message}</p>
        <Button onClick={() => void load()} type="button" variant="secondary">
          Retry
        </Button>
      </div>
    );
  }

  const { summary, tasks } = state.data;
  const attention = tasks.filter((task) =>
    (AGENT_TASK_ATTENTION_STATUSES as readonly string[]).includes(task.status)
  );
  const running = tasks.filter((task) => task.status === "running");
  const recent = tasks
    .filter(
      (task) =>
        (AGENT_TASK_TERMINAL_STATUSES as readonly string[]).includes(
          task.status
        ) && task.status !== "failed"
    )
    .slice(0, RECENT_RESULTS_LIMIT);
  const counters = [
    {
      label: "Running",
      value: summary.statusCounts.running,
      info: "Tasks with status running.",
    },
    {
      label: "Queued",
      value: summary.statusCounts.queued,
      info: "Tasks accepted but not started.",
    },
    {
      label: "Needs review",
      value: summary.statusCounts.needs_review,
      info: "Agent finished a step and waits for operator review.",
    },
    {
      label: "Blocked",
      value: summary.statusCounts.blocked,
      info: "Agent cannot continue without input or access.",
    },
    {
      label: "Failed 24 h",
      value: summary.failedLast24h,
      info: "Tasks that entered failed in the last 24 hours (finished time, else updated time).",
    },
    {
      label: "Succeeded",
      value: summary.statusCounts.succeeded,
      info: "All-time count of succeeded tasks.",
    },
  ];

  return (
    <div className="space-y-8">
      {notice}
      <div className="flex items-center justify-between gap-4">
        <dl
          className="grid flex-1 grid-cols-3 gap-2 md:grid-cols-6"
          aria-label="Task counters"
        >
          {counters.map((counter) => {
            return (
              <div
                className="rounded-md border border-border px-3 py-2"
                key={counter.label}
              >
                <dt className="text-muted-foreground text-xs">
                  {counter.label}
                  <InfoGlyph text={counter.info} />
                </dt>
                <dd
                  className="font-mono text-lg tabular-nums"
                  data-counter={counter.label}
                >
                  {counter.value}
                </dd>
              </div>
            );
          })}
        </dl>
        <Button
          aria-label="Reload mission control"
          onClick={() => void load()}
          type="button"
          variant="secondary"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Reload
        </Button>
      </div>
      <section aria-labelledby="mc-papers" className="space-y-2">
        <h2 className="font-medium text-sm" id="mc-papers">
          Papers by stage
          <InfoGlyph text="Count of research papers at each pipeline stage. Open Papers to change stage or verdict." />
        </h2>
        {/* A grid, not a table: the seven stages wrap at 375 px instead of widening the page. */}
        <dl
          aria-label="Paper counts by stage"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7"
        >
          {RESEARCH_PAPER_STAGE_VALUES.map((stage) => (
            <div
              className="min-w-0 rounded-md border border-border px-3 py-2"
              key={stage}
            >
              <dt className="text-muted-foreground text-xs">
                {labelFor(STAGE_LABELS, stage)}
              </dt>
              <dd className="font-mono text-sm tabular-nums" data-stage={stage}>
                {summary.paperStageCounts[stage] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="mc-attention" className="space-y-2">
        <h2 className="font-medium text-sm" id="mc-attention">
          Needs you
          <InfoGlyph text="Tasks with status needs review, blocked or failed. Change status on Agent runs." />
        </h2>
        <TaskTable
          caption="Tasks that need the operator"
          empty="Nothing needs you. No task is in needs review, blocked or failed."
          tasks={attention}
        />
      </section>
      <section aria-labelledby="mc-running" className="space-y-2">
        <h2 className="font-medium text-sm" id="mc-running">
          Running now
          <InfoGlyph text="Tasks with status running. Duration counts from the first running transition." />
        </h2>
        <TaskTable
          caption="Running tasks"
          empty="No task is running."
          tasks={running}
        />
      </section>
      <section aria-labelledby="mc-recent" className="space-y-2">
        <h2 className="font-medium text-sm" id="mc-recent">
          Recent results
          <InfoGlyph
            text={`Last ${RECENT_RESULTS_LIMIT} succeeded or cancelled tasks, newest first. Failed tasks show under Needs you.`}
          />
        </h2>
        <TaskTable
          caption="Recent task results"
          empty="No finished tasks yet."
          showOutcome
          tasks={recent}
        />
      </section>
      <section aria-labelledby="mc-events" className="space-y-2">
        <h2 className="font-medium text-sm" id="mc-events">
          Latest events
          <InfoGlyph text="Last 20 events appended by agents or the operator, newest first." />
        </h2>
        {summary.latestEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No events recorded.</p>
        ) : (
          <TableScroll label="Latest task events">
            <table className="w-full text-sm">
              <caption className="sr-only">Latest task events</caption>
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground text-xs">
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">Level</th>
                  <th scope="col">Task</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {summary.latestEvents.map((event) => {
                  return (
                    <tr
                      className="border-border border-b align-top"
                      data-level={event.level}
                      key={event.id}
                    >
                      <td className="py-1 font-mono text-muted-foreground text-xs">
                        {formatTimestamp(event.at)}
                      </td>
                      <td className="py-1 font-mono text-xs">{event.level}</td>
                      <td className="py-1">{event.taskTitle}</td>
                      <td className="py-1">{event.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  );
};
