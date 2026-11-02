"use client";

import {
  AGENT_TASK_KIND_VALUES,
  AGENT_TASK_STATUS_VALUES,
  type AgentTaskGetOutput,
  type AgentTaskKindValue,
  type AgentTaskOutput,
  type AgentTaskStatusValue,
} from "@darkfactory/api";
import { Button, Input } from "@darkfactory/ui";
import { ChevronDown, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";

import {
  InfoGlyph,
  OperatorAccessRequired,
  STATUS_LABELS,
  createBrowserAgentOpsGateway,
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  formatDuration,
  formatMetrics,
  formatTimestamp,
  labelFor,
  upsertById,
  type AgentOpsGateway,
} from "./agent-ops-client.tsx";

export interface AgentRunsWorkspaceProps {
  readonly gateway?: AgentOpsGateway;
  readonly initialTaskId?: string | null;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; tasks: AgentTaskOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type DetailState =
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; id: string; detail: AgentTaskGetOutput }>
  | Readonly<{ type: "error"; id: string; message: string }>;

type Draft = Readonly<{
  kind: AgentTaskKindValue;
  agent: string;
  title: string;
  summary: string;
}>;

const BLANK_DRAFT: Draft = {
  kind: "research",
  agent: "operator",
  title: "",
  summary: "",
};
const selectClass =
  "h-9 rounded-md border border-border bg-background px-2 text-sm";

const TaskDetail = ({ detail }: { readonly detail: AgentTaskGetOutput }) => {
  const metrics = Object.entries(detail.task.metrics);
  return (
    <div className="grid gap-4 py-2 md:grid-cols-3">
      <section aria-label="Task metrics" className="space-y-1">
        <h3 className="font-medium text-muted-foreground text-xs">Metrics</h3>
        {metrics.length === 0 ? (
          <p className="text-muted-foreground text-xs">No metrics reported.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 font-mono text-xs">
            {metrics.map(([key, value]) => {
              return (
                <Fragment key={key}>
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="tabular-nums">{String(value)}</dd>
                </Fragment>
              );
            })}
          </dl>
        )}
      </section>
      <section aria-label="Task links" className="space-y-1">
        <h3 className="font-medium text-muted-foreground text-xs">Links</h3>
        {detail.task.links.length === 0 ? (
          <p className="text-muted-foreground text-xs">No links.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {detail.task.links.map((link) => {
              return (
                <li key={`${link.label}-${link.url}`}>
                  <a
                    className="underline underline-offset-2"
                    href={link.url}
                    rel="noreferrer noopener"
                    target={link.url.startsWith("/") ? undefined : "_blank"}
                  >
                    {link.label}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          Started {formatTimestamp(detail.task.startedAt)} · finished{" "}
          {formatTimestamp(detail.task.finishedAt)} · created{" "}
          {formatTimestamp(detail.task.createdAt)}
        </p>
      </section>
      <section aria-label="Task events" className="space-y-1">
        <h3 className="font-medium text-muted-foreground text-xs">
          Events (newest first)
        </h3>
        {detail.events.length === 0 ? (
          <p className="text-muted-foreground text-xs">No events.</p>
        ) : (
          <ol className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {detail.events.map((event) => {
              return (
                <li data-level={event.level} key={event.id}>
                  <span className="font-mono text-muted-foreground">
                    {formatTimestamp(event.at)}
                  </span>{" "}
                  <span className="font-mono">{event.level}</span>{" "}
                  {event.message}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
};

// initialTaskId undefined: read ?task= from the browser URL (Mission control links there).
const taskIdFromLocation = (): string | null => {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("task");
  return id === null || id.trim() === "" ? null : id.slice(0, 128);
};

export const AgentRunsWorkspace = ({
  gateway: suppliedGateway,
  initialTaskId,
}: AgentRunsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentOpsGateway()
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [statusFilter, setStatusFilter] = useState<AgentTaskStatusValue | "">(
    ""
  );
  const [kindFilter, setKindFilter] = useState<AgentTaskKindValue | "">("");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      const tasks = await gateway.listTasks({
        ...(statusFilter === "" ? {} : { status: statusFilter }),
        ...(kindFilter === "" ? {} : { kind: kindFilter }),
        limit: 200,
      });
      return setState({ type: "ready", tasks });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { type: "error", message: describeAgentOpsFailure(error) }
      );
    }
  }, [gateway, statusFilter, kindFilter]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetail({ type: "loading", id });
      try {
        return setDetail({
          type: "ready",
          id,
          detail: await gateway.getTask(id),
        });
      } catch (error) {
        return setDetail({
          type: "error",
          id,
          message: describeAgentOpsFailure(error),
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    const id =
      initialTaskId === undefined ? taskIdFromLocation() : initialTaskId;
    if (id !== null && id !== "") void openDetail(id);
    return;
  }, [initialTaskId, openDetail]);

  const toggle = (id: string): void => {
    setNote("");
    if (detail?.id === id) {
      setDetail(null);
    } else void openDetail(id);
  };

  const replaceTask = (task: AgentTaskOutput): void => {
    setState((current) =>
      current.type === "ready"
        ? { type: "ready", tasks: upsertById(current.tasks, task) }
        : current
    );
  };

  const changeStatus = async (
    task: AgentTaskOutput,
    status: AgentTaskStatusValue
  ): Promise<void> => {
    if (status === task.status) return;
    setBusy(true);
    try {
      const next = await gateway.updateTask({ id: task.id, status });
      replaceTask(next);
      await gateway.appendEvent({
        taskId: task.id,
        level: "info",
        message: `Operator set status ${task.status} -> ${status}`,
      });
      if (detail?.id === task.id) await openDetail(task.id);
      setFeedback(`${task.title}: ${labelFor(STATUS_LABELS, status)}`);
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    if (draft.title.trim() === "" || draft.agent.trim() === "") {
      setFeedback("Title and agent are required.");
      return;
    }
    setBusy(true);
    try {
      const task = await gateway.createTask({
        kind: draft.kind,
        agent: draft.agent,
        title: draft.title,
        ...(draft.summary.trim() === "" ? {} : { summary: draft.summary }),
      });
      replaceTask(task);
      setDraft({ ...BLANK_DRAFT, kind: draft.kind, agent: draft.agent });
      setFeedback(`Created ${task.title}`);
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const appendNote = async (taskId: string): Promise<void> => {
    if (note.trim() === "") return;
    setBusy(true);
    try {
      await gateway.appendEvent({ taskId, level: "info", message: note });
      setNote("");
      await openDetail(taskId);
      setFeedback("Event added.");
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="agent-runs" />;

  return (
    <div className="space-y-6">
      <section aria-labelledby="agent-runs-create" className="space-y-2">
        <h2 className="font-medium text-sm" id="agent-runs-create">
          Create task
          <InfoGlyph text="Manual entry. Agents create tasks through agentOps.tasks.create with the same fields." />
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Kind
            <select
              aria-label="New task kind"
              className={`${selectClass} block`}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  kind: event.target.value as AgentTaskKindValue,
                })
              }
              value={draft.kind}
            >
              {AGENT_TASK_KIND_VALUES.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Agent
            <Input
              aria-label="New task agent"
              maxLength={100}
              onChange={(event) =>
                setDraft({ ...draft, agent: event.target.value })
              }
              value={draft.agent}
            />
          </label>
          <label className="min-w-64 flex-1 text-xs">
            Title
            <Input
              aria-label="New task title"
              maxLength={300}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
              value={draft.title}
            />
          </label>
          <label className="min-w-64 flex-1 text-xs">
            Summary (optional)
            <Input
              aria-label="New task summary"
              maxLength={4000}
              onChange={(event) =>
                setDraft({ ...draft, summary: event.target.value })
              }
              value={draft.summary}
            />
          </label>
          <Button disabled={busy} onClick={() => void create()} type="button">
            <Plus aria-hidden="true" className="size-4" />
            Create task
          </Button>
        </div>
      </section>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          Status
          <select
            aria-label="Filter by status"
            className={`${selectClass} block`}
            onChange={(event) =>
              setStatusFilter(event.target.value as AgentTaskStatusValue | "")
            }
            value={statusFilter}
          >
            <option value="">All</option>
            {AGENT_TASK_STATUS_VALUES.map((status) => (
              <option key={status} value={status}>
                {labelFor(STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Kind
          <select
            aria-label="Filter by kind"
            className={`${selectClass} block`}
            onChange={(event) =>
              setKindFilter(event.target.value as AgentTaskKindValue | "")
            }
            value={kindFilter}
          >
            <option value="">All</option>
            {AGENT_TASK_KIND_VALUES.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <Button
          aria-label="Reload tasks"
          onClick={() => void load()}
          type="button"
          variant="secondary"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Reload
        </Button>
      </div>
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading tasks…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : state.tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No tasks match. Agents record tasks through the agentOps API, or
          create one above.
        </p>
      ) : (
        // `relative` makes the scroll box the containing block of the absolutely
        // positioned sr-only "Expand" label, so it cannot widen the page on a phone.
        <div className="relative overflow-x-auto" data-agent-tasks-scroll>
          <table className="w-full text-sm">
            <caption className="sr-only">Agent tasks</caption>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground text-xs">
                <th scope="col">
                  <span className="sr-only">Expand</span>
                </th>
                <th scope="col">Task</th>
                <th scope="col">Kind</th>
                <th scope="col">Agent</th>
                <th scope="col">
                  Status
                  <InfoGlyph text="Running sets the started time once. Succeeded, failed and cancelled set the finished time. Queued clears both." />
                </th>
                <th scope="col">Duration</th>
                <th scope="col">Metrics</th>
                <th scope="col">Updated (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {state.tasks.map((task) => {
                const open = detail?.id === task.id;
                return (
                  <Fragment key={task.id}>
                    <tr
                      className="border-border border-b align-top"
                      data-task-id={task.id}
                    >
                      <td className="py-1">
                        <Button
                          aria-expanded={open}
                          aria-label={`${open ? "Collapse" : "Expand"} ${task.title}`}
                          onClick={() => toggle(task.id)}
                          type="button"
                          variant="ghost"
                        >
                          {open ? (
                            <ChevronDown
                              aria-hidden="true"
                              className="size-4"
                            />
                          ) : (
                            <ChevronRight
                              aria-hidden="true"
                              className="size-4"
                            />
                          )}
                        </Button>
                      </td>
                      <th className="py-1 font-normal" scope="row">
                        {task.title}
                        {task.summary === null ? null : (
                          <div className="text-muted-foreground text-xs">
                            {task.summary.slice(0, 200)}
                          </div>
                        )}
                      </th>
                      <td className="py-1 font-mono text-xs">{task.kind}</td>
                      <td className="py-1 font-mono text-xs">{task.agent}</td>
                      <td className="py-1">
                        <select
                          aria-label={`${task.title} status`}
                          className={selectClass}
                          disabled={busy}
                          onChange={(event) =>
                            void changeStatus(
                              task,
                              event.target.value as AgentTaskStatusValue
                            )
                          }
                          value={task.status}
                        >
                          {AGENT_TASK_STATUS_VALUES.map((status) => (
                            <option key={status} value={status}>
                              {labelFor(STATUS_LABELS, status)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 font-mono text-xs">
                        {formatDuration(task)}
                      </td>
                      <td className="py-1 font-mono text-xs">
                        {formatMetrics(task.metrics)}
                      </td>
                      <td className="py-1 font-mono text-muted-foreground text-xs">
                        {formatTimestamp(task.updatedAt)}
                      </td>
                    </tr>
                    {open ? (
                      <tr className="border-border border-b bg-surface">
                        <td colSpan={8}>
                          {detail?.type === "loading" ? (
                            <p
                              aria-busy="true"
                              className="py-2 text-muted-foreground text-xs"
                            >
                              Loading events…
                            </p>
                          ) : detail?.type === "error" ? (
                            <p className="py-2 text-xs" role="alert">
                              {detail.message}
                            </p>
                          ) : detail?.type === "ready" ? (
                            <TaskDetail detail={detail.detail} />
                          ) : null}
                          <div className="flex gap-2 pb-2">
                            <Input
                              aria-label={`Event for ${task.title}`}
                              maxLength={2000}
                              onChange={(event) => setNote(event.target.value)}
                              placeholder="Operator note (appended as info event)"
                              value={note}
                            />
                            <Button
                              disabled={busy}
                              onClick={() => void appendNote(task.id)}
                              type="button"
                              variant="secondary"
                            >
                              Add event
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
