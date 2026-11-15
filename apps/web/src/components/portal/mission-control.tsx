"use client";

import {
  AGENT_TASK_ATTENTION_STATUSES,
  AGENT_TASK_TERMINAL_STATUSES,
  type AgentOpsSummaryOutput,
  type AgentTaskOutput,
  RESEARCH_PAPER_STAGE_VALUES,
  type SectorRotationSnapshot,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type AgentOpsGateway,
  createBrowserAgentOpsGateway,
  describeAgentOpsFailure,
  formatDuration,
  formatMetrics,
  formatTimestamp,
  InfoGlyph,
  isOperatorAccessDenied,
  labelFor,
  OperatorAccessRequired,
  STAGE_LABELS,
  STATUS_LABELS,
} from "./agent-ops-client.tsx";
import { SectorRotationChanges } from "./sector-rotation-changes.tsx";

export interface MissionControlProps {
  readonly gateway?: AgentOpsGateway;
  // Sector rotation card loader; defaults to the browser API client.
  readonly sectorRotation?: (() => Promise<SectorRotationSnapshot>) | undefined;
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
      <Table containerClassName="overflow-visible" data-click-private="">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Task</TableHead>
            <TableHead scope="col">Kind</TableHead>
            <TableHead scope="col">Agent</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">
              {showOutcome ? "Metrics" : "Duration"}
            </TableHead>
            <TableHead scope="col">Updated (UTC)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            return (
              <TableRow
                className="[&>td]:align-top [&>th]:align-top"
                data-task-id={task.id}
                key={task.id}
              >
                <TableHead
                  className="h-auto min-w-64 whitespace-normal py-2.5 align-top font-normal"
                  scope="row"
                >
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
                </TableHead>
                <TableCell className="align-top font-mono text-xs">
                  {task.kind}
                </TableCell>
                <TableCell className="align-top font-mono text-xs">
                  {task.agent}
                </TableCell>
                <TableCell className="align-top" data-status={task.status}>
                  {labelFor(STATUS_LABELS, task.status)}
                </TableCell>
                <TableCell className="min-w-40 whitespace-normal align-top font-mono text-xs">
                  {showOutcome
                    ? formatMetrics(task.metrics)
                    : formatDuration(task)}
                </TableCell>
                <TableCell className="align-top font-mono text-muted-foreground text-xs">
                  {formatTimestamp(task.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableScroll>
  );
};

export const MissionControl = ({
  gateway: suppliedGateway,
  summaryState,
  sectorRotation,
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
      return setState({ data: { summary, tasks }, type: "ready" });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { message: describeAgentOpsFailure(error), type: "error" }
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
      info: "Tasks with status running.",
      label: "Running",
      value: summary.statusCounts.running,
    },
    {
      info: "Tasks accepted but not started.",
      label: "Queued",
      value: summary.statusCounts.queued,
    },
    {
      info: "Agent finished a step and waits for operator review.",
      label: "Needs review",
      value: summary.statusCounts.needs_review,
    },
    {
      info: "Agent cannot continue without input or access.",
      label: "Blocked",
      value: summary.statusCounts.blocked,
    },
    {
      info: "Tasks that entered failed in the last 24 hours (finished time, else updated time).",
      label: "Failed 24 h",
      value: summary.failedLast24h,
    },
    {
      info: "All-time count of succeeded tasks.",
      label: "Succeeded",
      value: summary.statusCounts.succeeded,
    },
  ];

  return (
    <div className="space-y-8">
      {notice}
      <div className="flex items-center justify-between gap-4">
        <dl
          aria-label="Task counters"
          className="grid flex-1 grid-cols-3 gap-2 md:grid-cols-6"
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
      <SectorRotationChanges load={sectorRotation} />
      <Panel
        headingId="mc-papers"
        title={
          <>
            Papers by stage
            <InfoGlyph text="Count of research papers at each pipeline stage. Open Papers to change stage or verdict." />
          </>
        }
      >
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
      </Panel>
      <Panel
        flush={attention.length > 0}
        headingId="mc-attention"
        title={
          <>
            Needs you
            <InfoGlyph text="Tasks with status needs review, blocked or failed. Change status on Agent runs." />
          </>
        }
      >
        <TaskTable
          caption="Tasks that need the operator"
          empty="Nothing needs you. No task is in needs review, blocked or failed."
          tasks={attention}
        />
      </Panel>
      <Panel
        flush={running.length > 0}
        headingId="mc-running"
        title={
          <>
            Running now
            <InfoGlyph text="Tasks with status running. Duration counts from the first running transition." />
          </>
        }
      >
        <TaskTable
          caption="Running tasks"
          empty="No task is running."
          tasks={running}
        />
      </Panel>
      <Panel
        flush={recent.length > 0}
        headingId="mc-recent"
        title={
          <>
            Recent results
            <InfoGlyph
              text={`Last ${RECENT_RESULTS_LIMIT} succeeded or cancelled tasks, newest first. Failed tasks show under Needs you.`}
            />
          </>
        }
      >
        <TaskTable
          caption="Recent task results"
          empty="No finished tasks yet."
          showOutcome
          tasks={recent}
        />
      </Panel>
      <Panel
        flush={summary.latestEvents.length > 0}
        headingId="mc-events"
        title={
          <>
            Latest events
            <InfoGlyph text="Last 20 events appended by agents or the operator, newest first." />
          </>
        }
      >
        {summary.latestEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No events recorded.</p>
        ) : (
          <TableScroll label="Latest task events">
            <Table containerClassName="overflow-visible">
              <TableCaption className="sr-only">
                Latest task events
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Time (UTC)</TableHead>
                  <TableHead scope="col">Level</TableHead>
                  <TableHead scope="col">Task</TableHead>
                  <TableHead scope="col">Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.latestEvents.map((event) => {
                  return (
                    <TableRow
                      className="[&>td]:align-top [&>th]:align-top"
                      data-level={event.level}
                      key={event.id}
                    >
                      <TableCell className="align-top font-mono text-muted-foreground text-xs">
                        {formatTimestamp(event.at)}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs">
                        {event.level}
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal align-top">
                        {event.taskTitle}
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal align-top">
                        {event.message}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
};
