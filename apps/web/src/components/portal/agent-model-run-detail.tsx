"use client";

import {
  AGENT_MODEL_RUN_EVENTS_PAGE_MAX,
  type AgentModelRunEventKindValue,
  type AgentModelRunEventOutput,
  type AgentModelRunOutput,
} from "@darkfactory/api";
import { Badge, Button, PageHeader, Skeleton } from "@darkfactory/ui";
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileOutput,
  Flag,
  Gavel,
  type LucideIcon,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Wrench,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  FrameworkLabel,
  RatingBadge,
  ResearchOnlyNote,
  RunStatusBadge,
} from "./agent-model-run-badges.tsx";
import {
  AGENT_PHASE_LABELS,
  agentCards,
  initRunView,
  isFinishedStatus,
  LIVE_POLL_MS,
  REPLAY_SPEEDS,
  type RunEventPage,
  type RunViewAction,
  type RunViewState,
  runViewReducer,
} from "./agent-model-run-view.ts";
import {
  type AgentModelRunsGateway,
  createBrowserAgentModelRunsGateway,
  describeModelRunFailure,
  formatCount,
  formatPrice,
  formatUsd,
  isModelRunForbidden,
  servedModels,
} from "./agent-model-runs-client.ts";
import {
  formatTimestamp,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";

export interface AgentModelRunDetailProps {
  readonly runId: string;
  readonly gateway?: AgentModelRunsGateway;
}

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; page: RunEventPage }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

const KIND_ICONS: Readonly<Record<AgentModelRunEventKindValue, LucideIcon>> = {
  decision: Gavel,
  flag: Flag,
  llm_call: Bot,
  message: MessageSquare,
  reasoning: Brain,
  status: Activity,
  tool_call: Wrench,
  tool_result: FileOutput,
};

const KIND_LABELS: Readonly<Record<AgentModelRunEventKindValue, string>> = {
  decision: "Decision",
  flag: "Flag",
  llm_call: "LLM call",
  message: "Message",
  reasoning: "Reasoning",
  status: "Status",
  tool_call: "Tool call",
  tool_result: "Tool result",
};

const LIVE_POLL_TRIES = 3;
// A finished run can still get late events for 10 minutes; it is polled less often until done.
const FINISHED_POLL_MS = 10_000;

const nextPollDelay = (page: RunEventPage): number => {
  if (page.events.length >= AGENT_MODEL_RUN_EVENTS_PAGE_MAX) return 0;
  return isFinishedStatus(page.run.status) ? FINISHED_POLL_MS : LIVE_POLL_MS;
};

// A gap of this many pixels from the bottom means the reader scrolled up to read.
const FOLLOW_SLACK_PX = 48;

const BackLink = () => (
  <a
    className="inline-flex min-h-11 items-center gap-1 text-sm underline underline-offset-2"
    href="/agents"
  >
    <ArrowLeft aria-hidden="true" className="size-4" />
    All model runs
  </a>
);

const RunFields = ({ run }: { readonly run: AgentModelRunOutput }) => {
  const served = servedModels(run);
  const fields: readonly (readonly [string, ReactNode])[] = [
    ["Decision date", run.decisionDate],
    [
      "Framework",
      <FrameworkLabel
        framework={run.framework}
        frameworkVersion={run.frameworkVersion}
        key="framework"
      />,
    ],
    ["Provider / model", `${run.provider} / ${run.model}`],
    ["Served model", served.length === 0 ? "as requested" : served.join(", ")],
    [
      "Rating",
      <RatingBadge
        key="rating"
        rating={run.rating}
        ratingSource={run.ratingSource}
      />,
    ],
    [
      "Entry / stop / target",
      `${formatPrice(run.entryPrice)} / ${formatPrice(run.stopPrice)} / ${formatPrice(run.targetPrice)}`,
    ],
    ["Horizon", run.horizon ?? "—"],
    ["Status", <RunStatusBadge key="status" status={run.status} />],
    [
      "Tokens (in / out)",
      `${formatCount(run.inputTokens)} / ${formatCount(run.outputTokens)}`,
    ],
    ["LLM calls / tool calls", `${run.llmCalls} / ${run.toolCalls}`],
    ["Cost", formatUsd(run.costUsd)],
    ["Analysts", run.analysts.length === 0 ? "—" : run.analysts.join(", ")],
    ["Purpose", run.purpose],
    ["Variant", run.variant ?? "—"],
    ["Batch", run.batch ?? "—"],
    ["Memory", run.memory ? "on" : "off"],
    ["Data source", run.dataSource ?? "—"],
    ["Started", formatTimestamp(run.startedAt)],
    ["Finished", formatTimestamp(run.finishedAt)],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
        {fields.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {run.flags.length === 0 ? null : (
        <ul aria-label="Flags" className="flex flex-wrap gap-1">
          {run.flags.map((flag) => (
            <li key={flag}>
              <Badge variant="secondary">{flag}</Badge>
            </li>
          ))}
        </ul>
      )}
      {run.error === null ? null : (
        <pre className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]">
          {run.error}
        </pre>
      )}
    </div>
  );
};

const AgentCards = ({ state }: { readonly state: RunViewState }) => {
  const finished =
    isFinishedStatus(state.run.status) &&
    state.position >= state.events.length - 1;
  const cards = agentCards(state.events, state.position, finished);
  return (
    <section
      aria-label="Agents"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      {cards.map((card) => (
        <article
          className="min-w-0 space-y-2 rounded-md border border-border p-3"
          data-phase={card.phase}
          key={card.agent}
        >
          <header className="flex items-center justify-between gap-2">
            <h3 className="min-w-0 truncate font-medium text-sm">
              {card.agent}
            </h3>
            <Badge variant={card.phase === "done" ? "secondary" : "outline"}>
              {AGENT_PHASE_LABELS[card.phase]}
            </Badge>
          </header>
          <p className="text-muted-foreground text-xs tabular-nums">
            {card.llmCalls} LLM · {card.toolCalls} tools ·{" "}
            {formatCount(card.tokens)} tokens · {formatUsd(card.costUsd)}
          </p>
          <p className="line-clamp-3 min-h-12 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            {card.line}
          </p>
        </article>
      ))}
    </section>
  );
};

const TimelineEvent = ({
  event,
  current,
}: {
  readonly event: AgentModelRunEventOutput;
  readonly current: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICONS[event.kind];
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={`space-y-1 border-border border-l-2 py-1 pl-3 ${current ? "border-primary" : ""}`}
      data-kind={event.kind}
      data-seq={event.seq}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only">{KIND_LABELS[event.kind]}:</span>
        <span className="font-mono text-muted-foreground text-xs">
          {formatTimestamp(event.at)}
        </span>
        <span className="font-medium">{event.agent}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{event.title}</span>
        {event.toolName === null ? null : (
          <Badge variant="outline">{event.toolName}</Badge>
        )}
        {event.body === null ? null : (
          <Button
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {open ? (
              <ChevronDown aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4" />
            )}
            {open ? "Hide text" : "Show text"}
          </Button>
        )}
      </div>
      {open && event.body !== null ? (
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs [overflow-wrap:anywhere]">
          {event.body}
        </pre>
      ) : null}
    </li>
  );
};

const Controls = ({
  state,
  dispatch,
}: {
  readonly state: RunViewState;
  readonly dispatch: (action: RunViewAction) => void;
}) => {
  const live = state.mode === "live";
  const running = live ? state.follow : state.playing;
  const last = state.events.length - 1;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Replay controls"
    >
      <Button
        onClick={() => dispatch({ type: running ? "pause" : "play" })}
        variant="secondary"
      >
        {running ? (
          <Pause aria-hidden="true" className="size-4" />
        ) : (
          <Play aria-hidden="true" className="size-4" />
        )}
        {running ? "Pause" : live ? "Follow" : "Play"}
      </Button>
      <Button
        aria-label="Step back"
        disabled={state.position <= 0}
        onClick={() => dispatch({ by: -1, type: "step" })}
        variant="ghost"
      >
        <SkipBack aria-hidden="true" className="size-4" />
      </Button>
      <Button
        aria-label="Step forward"
        disabled={state.position >= last}
        onClick={() => dispatch({ by: 1, type: "step" })}
        variant="ghost"
      >
        <SkipForward aria-hidden="true" className="size-4" />
      </Button>
      <label className="flex min-h-11 min-w-48 flex-1 items-center gap-2 text-sm">
        <span className="sr-only">Replay position</span>
        <input
          className="w-full accent-primary"
          disabled={last < 1}
          max={Math.max(last, 0)}
          min={0}
          onChange={(event) =>
            dispatch({ position: Number(event.target.value), type: "seek" })
          }
          type="range"
          value={Math.max(state.position, 0)}
        />
      </label>
      <span
        className="text-muted-foreground text-xs tabular-nums"
        aria-live="polite"
      >
        Event {state.position + 1} of {state.events.length}
      </span>
      {live ? null : (
        <span
          className="flex items-center gap-1"
          role="group"
          aria-label="Replay speed"
        >
          {REPLAY_SPEEDS.map((speed) => (
            <Button
              aria-pressed={state.speed === speed}
              key={speed}
              onClick={() => dispatch({ speed, type: "speed" })}
              size="sm"
              variant={state.speed === speed ? "secondary" : "ghost"}
            >
              {speed}x
            </Button>
          ))}
        </span>
      )}
    </div>
  );
};

const RunView = ({
  initial,
  runId,
  gateway,
}: {
  readonly initial: RunEventPage;
  readonly runId: string;
  readonly gateway: AgentModelRunsGateway;
}) => {
  const [state, dispatch] = useReducer(runViewReducer, initial, initRunView);
  const [pollError, setPollError] = useState("");
  const [polling, setPolling] = useState(true);
  const nextSeq = useRef(state.nextSeq);
  nextSeq.current = state.nextSeq;
  const timeline = useRef<HTMLOListElement>(null);
  const live = state.mode === "live" && polling;

  // Poll every 2 seconds from the last seq while the run is live; stop when it is done, on an error
  // or on unmount. A full page is followed by an immediate poll to catch up.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      try {
        const page = await gateway.events(runId, nextSeq.current);
        if (cancelled) return;
        failures = 0;
        dispatch({ page, type: "appended" });
        timer = setTimeout(poll, nextPollDelay(page));
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        // Up to 3 tries with a growing delay, then stop and offer Resume.
        if (failures < LIVE_POLL_TRIES) {
          timer = setTimeout(poll, LIVE_POLL_MS * 2 ** failures);
          return;
        }
        setPollError(describeModelRunFailure(error));
        setPolling(false);
      }
    };
    timer = setTimeout(poll, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [gateway, runId, live]);

  useEffect(() => {
    if (state.mode !== "replay" || !state.playing) return;
    const timer = setInterval(
      () => dispatch({ type: "tick" }),
      1000 / state.speed
    );
    return () => clearInterval(timer);
  }, [state.mode, state.playing, state.speed]);

  // Follow the newest event without animation (no motion for readers who reduce motion).
  const shown = state.position;
  useEffect(() => {
    const element = timeline.current;
    if (element !== null && state.follow)
      element.scrollTop = element.scrollHeight;
  }, [shown, state.follow]);

  const visible = state.events.slice(0, state.position + 1);
  return (
    <div className="space-y-6">
      <PageHeader
        title={`${state.run.ticker} · ${state.run.decisionDate} · ${state.run.framework}`}
      />
      <ResearchOnlyNote />
      <RunFields run={state.run} />
      <div
        className="flex min-h-6 flex-wrap items-center gap-2 text-sm"
        role="status"
      >
        {state.mode === "live" && !isFinishedStatus(state.run.status) ? (
          <Badge data-live="true" variant="outline">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-primary motion-safe:animate-pulse"
            />
            Live
          </Badge>
        ) : null}
        {state.mode === "live" && isFinishedStatus(state.run.status)
          ? "Finished; checking for late events…"
          : null}
        {pollError === "" ? null : (
          <>
            <span className="text-destructive">
              Live updates stopped: {pollError}
            </span>
            <Button
              onClick={() => {
                setPollError("");
                setPolling(true);
              }}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Resume
            </Button>
          </>
        )}
      </div>
      {state.events.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {state.mode === "live"
            ? "No events yet. New events appear here as the agents work."
            : "This run recorded no events."}
        </p>
      ) : (
        <>
          <Controls dispatch={dispatch} state={state} />
          <AgentCards state={state} />
          <section aria-label="Timeline" className="space-y-2">
            <h2 className="font-medium text-sm">Timeline</h2>
            <ol
              className="max-h-[32rem] space-y-1 overflow-y-auto pr-2"
              onScroll={(event) => {
                const element = event.currentTarget;
                if (
                  state.follow &&
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight >
                    FOLLOW_SLACK_PX
                )
                  dispatch({ type: "scrolledAway" });
              }}
              ref={timeline}
            >
              {visible.map((event, index) => (
                <TimelineEvent
                  current={index === state.position}
                  event={event}
                  key={event.seq}
                />
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
};

export const AgentModelRunDetail = ({
  runId,
  gateway: suppliedGateway,
}: AgentModelRunDetailProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentModelRunsGateway()
  );
  const [state, setState] = useState<LoadState>({ type: "loading" });

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      setState({ page: await gateway.get(runId), type: "ready" });
    } catch (error) {
      setState(
        isModelRunForbidden(error)
          ? { type: "forbidden" }
          : { message: describeModelRunFailure(error), type: "error" }
      );
    }
  }, [gateway, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <BackLink />
      {state.type === "ready" ? (
        <RunView gateway={gateway} initial={state.page} runId={runId} />
      ) : (
        <>
          <PageHeader title="Model run" />
          <ResearchOnlyNote />
        </>
      )}
      {state.type === "loading" ? (
        <div aria-busy="true" className="space-y-2" role="status">
          <span className="sr-only">Loading the model run</span>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      {state.type === "forbidden" ? (
        <OperatorAccessRequired feature="agent-runs" />
      ) : null}
      {state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-destructive text-sm">{state.message}</p>
          <Button onClick={() => void load()} variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
};
