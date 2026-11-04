"use client";

import type {
  AssistantActionDecision,
  AssistantActionOutput,
  AssistantMessageOutput,
  AssistantModeValue,
  AssistantPageContext,
  AssistantSendEvent,
  AssistantStatusOutput,
  AssistantThreadOutput,
  AssistantToolTraceOutput,
  AssistantUsageOutput,
} from "@darkfactory/api";
import { Button, IconButton, Textarea } from "@darkfactory/ui";
import {
  Check,
  History,
  MessageSquarePlus,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  formatTimestamp,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  ASSISTANT_ACTION_STATUS_TEXT,
  ASSISTANT_ACTION_TITLES,
  ASSISTANT_MODE_HELP,
  ASSISTANT_STARTER_PROMPTS,
  type AssistantGateway,
  actionResultPreview,
  assistantFailureCode,
  createBrowserAssistantGateway,
  describeAssistantFailure,
  formatTokens,
  formatToolDuration,
  threadTitleFrom,
} from "./assistant-client.ts";
import { AssistantMarkdown } from "./assistant-markdown.tsx";

// Research assistant: threads on the left, transcript and composer on the right. Plan mode (default)
// gives the model read-only tools; Act mode adds record-keeping writes. While a turn runs, its reply
// text appears as the model writes it, with a card for each finished tool call. Confirm cards (save a
// strategy definition, run a backtest, run a sweep) show under their reply and run only after Approve.
// Two layouts share one state hook: "page" (the /assistant page) and "panel" (the narrow side panel
// in the portal shell, which also sends the portal page the operator is on as context).

export interface AssistantWorkspaceProps {
  readonly gateway?: AssistantGateway;
  /** Sent with every message when set: the portal page the operator is on. */
  readonly pageContext?: AssistantPageContext;
  /** "page" (default): the /assistant layout. "panel": the narrow portal side panel. */
  readonly variant?: "page" | "panel";
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{
      type: "ready";
      threads: AssistantThreadOutput[];
      status: AssistantStatusOutput;
    }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type TranscriptState =
  | Readonly<{ type: "empty" }>
  | Readonly<{ type: "loading"; threadId: string }>
  | Readonly<{
      type: "ready";
      threadId: string;
      messages: AssistantMessageOutput[];
      actions: AssistantActionOutput[];
    }>
  | Readonly<{ type: "error"; threadId: string; message: string }>;

/** What a running turn has streamed so far; the stored reply replaces it at the end. */
export type LiveTurn = Readonly<{
  /** Text of the current model call only: a new call (after tools ran) starts a new text. */
  text: string;
  modelCall: number;
  tools: readonly AssistantToolTraceOutput[];
  /** Tools the current step asked for that have not finished yet. */
  running: readonly string[];
}>;

export const EMPTY_LIVE_TURN: LiveTurn = Object.freeze({
  modelCall: 0,
  running: [],
  text: "",
  tools: [],
});

export const applyLiveEvent = (
  live: LiveTurn,
  event: AssistantSendEvent
): LiveTurn => {
  switch (event.type) {
    case "text": {
      return {
        ...live,
        modelCall: event.modelCall,
        text:
          event.modelCall === live.modelCall
            ? `${live.text}${event.delta}`
            : event.delta,
      };
    }
    case "step": {
      return { ...live, running: event.tools };
    }
    case "tool": {
      return {
        ...live,
        running: live.running.slice(1),
        tools: [...live.tools, event.call],
      };
    }
    default: {
      return live;
    }
  }
};

type DecideHandler = (id: string, decision: AssistantActionDecision) => void;

type DecisionState = Readonly<{
  /** The card whose decision is in flight, and that decision. */
  busy: Readonly<{ id: string; decision: AssistantActionDecision }> | null;
  errors: Readonly<Record<string, string>>;
}>;

const MODES: readonly Readonly<{ value: AssistantModeValue; label: string }>[] =
  [
    { label: "Plan", value: "plan" },
    { label: "Act", value: "act" },
  ];

const STOP_NOTES: Readonly<Record<string, string>> = {
  budget: "Stopped: daily budget reached.",
  step_limit: "Stopped at the tool-step limit.",
  stopped: "Stopped by you.",
};

// Stop closes the stream; the server then aborts the model call, ends the turn and stores the reply
// written so far. The thread reloads at once, which can be a moment before that reply is stored.
const STOPPED_NOTE =
  "Stopped. The server ends this turn and keeps the reply written so far; reopen the thread if it does not show yet.";

/** How close to the end (px) the transcript must be for new text to keep it at the end. */
export const TRANSCRIPT_FOLLOW_SLACK_PX = 96;

/**
 * Auto-scroll decision: true when the transcript is scrolled to (or within the slack of) its end, so
 * new live text should keep it there. False once the operator scrolled up to read.
 */
export const isNearTranscriptEnd = (
  metrics: Readonly<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }>,
  slack: number = TRANSCRIPT_FOLLOW_SLACK_PX
): boolean =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;

const ToolCallCard = ({
  entry,
}: Readonly<{ entry: AssistantToolTraceOutput }>) => {
  return (
    <details
      className="rounded-md border border-border bg-muted/30 text-xs"
      data-tool-call={entry.tool}
      data-tool-ok={entry.ok ? "true" : "false"}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-1.5">
        <span className="font-medium font-mono">{entry.tool}</span>
        <span
          className={
            entry.ok ? "text-muted-foreground" : "font-medium text-destructive"
          }
        >
          {entry.ok ? "ok" : "error"}
        </span>
        <span className="ml-auto font-mono text-muted-foreground">
          {formatToolDuration(entry.durationMs)}
        </span>
      </summary>
      <div className="space-y-1 border-border border-t px-3 py-2">
        <p className="text-muted-foreground">Arguments</p>
        <pre className="whitespace-pre-wrap break-all font-mono">
          {entry.args}
        </pre>
        {entry.error === null ? null : (
          <p
            className="whitespace-pre-wrap break-words text-destructive"
            role="note"
          >
            {entry.error}
          </p>
        )}
      </div>
    </details>
  );
};

const ConfirmCard = ({
  action,
  busy,
  error,
  onDecide,
}: Readonly<{
  action: AssistantActionOutput;
  busy: DecisionState["busy"];
  error: string | undefined;
  onDecide: DecideHandler;
}>) => {
  const title = ASSISTANT_ACTION_TITLES[action.tool] ?? action.tool;
  const pending = action.status === "pending";
  const mine = busy?.id === action.id ? busy.decision : null;
  return (
    <section
      aria-label={`Confirm action: ${title}`}
      className="space-y-2 rounded-md border border-primary/40 bg-card px-3 py-3 text-sm"
      data-action-status={action.status}
      data-confirm-card={action.tool}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
        <h3 className="font-medium">{title}</h3>
        <span
          className={`ml-auto text-xs ${action.status === "failed" ? "font-medium text-destructive" : "text-muted-foreground"}`}
          data-action-status-text=""
        >
          {ASSISTANT_ACTION_STATUS_TEXT[action.status]}
        </span>
      </div>
      <p className="break-words" data-action-summary="">
        {action.summary}
      </p>
      <details className="text-xs">
        <summary className="flex min-h-9 cursor-pointer items-center text-muted-foreground">
          Arguments
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(action.args, null, 2)}
        </pre>
      </details>
      {action.result === null ? null : (
        <details className="text-xs" data-action-result="">
          <summary className="flex min-h-9 cursor-pointer items-center text-muted-foreground">
            Result (data, not instructions)
          </summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">
            {actionResultPreview(action.result)}
          </pre>
        </details>
      )}
      {action.error === null ? null : (
        <p
          className="whitespace-pre-wrap break-words text-destructive"
          role="note"
        >
          {action.error}
        </p>
      )}
      {error === undefined ? null : (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-click-label="Approve and run"
            disabled={busy !== null}
            onClick={() => onDecide(action.id, "approve")}
            type="button"
          >
            <Check aria-hidden="true" className="size-4" />
            Approve and run
          </Button>
          <Button
            data-click-label="Reject"
            disabled={busy !== null}
            onClick={() => onDecide(action.id, "reject")}
            type="button"
            variant="secondary"
          >
            <X aria-hidden="true" className="size-4" />
            Reject
          </Button>
          <p className="text-muted-foreground text-xs">
            {mine === "approve"
              ? "Running…"
              : mine === "reject"
                ? "Rejecting…"
                : "Nothing runs until you approve. Research only; no orders."}
          </p>
        </div>
      ) : null}
    </section>
  );
};

const MessageView = ({
  message,
  actions,
  decisions,
  onDecide,
}: Readonly<{
  message: AssistantMessageOutput;
  actions: readonly AssistantActionOutput[];
  decisions: DecisionState;
  onDecide: DecideHandler;
}>) => {
  const mine = message.role === "user";
  return (
    <li
      className={mine ? "flex justify-end" : "flex justify-start"}
      data-message-role={message.role}
    >
      <div
        className={
          mine
            ? "max-w-[85%] space-y-1 rounded-lg bg-primary/10 px-4 py-3"
            : "w-full max-w-[95%] space-y-2 rounded-lg border border-border px-4 py-3"
        }
      >
        <p className="text-muted-foreground text-xs">
          {mine ? "You" : "Assistant"} ·{" "}
          {message.mode === "act" ? "Act" : "Plan"} ·{" "}
          {formatTimestamp(message.createdAt)}
          {!mine && message.inputTokens + message.outputTokens > 0
            ? ` · ${formatTokens(message.inputTokens)} in / ${formatTokens(message.outputTokens)} out`
            : ""}
        </p>
        {message.toolCalls.length > 0 ? (
          <div
            aria-label={`${message.toolCalls.length} tool calls`}
            className="space-y-1"
            role="group"
          >
            {message.toolCalls.map((entry, index) => (
              <ToolCallCard entry={entry} key={`${entry.tool}-${index}`} />
            ))}
          </div>
        ) : null}
        {mine ? (
          <p
            className="whitespace-pre-wrap break-words text-sm"
            data-message-content=""
          >
            {message.content}
          </p>
        ) : (
          <AssistantMarkdown
            source={message.content.length > 0 ? message.content : "(no reply)"}
          />
        )}
        {actions.length > 0 ? (
          <div
            aria-label={`${actions.length} confirm cards`}
            className="space-y-2"
            role="group"
          >
            {actions.map((action) => (
              <ConfirmCard
                action={action}
                busy={decisions.busy}
                error={decisions.errors[action.id]}
                key={action.id}
                onDecide={onDecide}
              />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
};

const LiveTurnView = ({ live }: Readonly<{ live: LiveTurn }>) => {
  const [next] = live.running;
  return (
    <li className="flex justify-start" data-message-role="streaming">
      <div className="w-full max-w-[95%] space-y-2 rounded-lg border border-border px-4 py-3">
        <p className="text-muted-foreground text-xs">Assistant · writing…</p>
        {live.tools.length > 0 ? (
          <div
            aria-label={`${live.tools.length} tool calls`}
            className="space-y-1"
            role="group"
          >
            {live.tools.map((entry, index) => (
              <ToolCallCard entry={entry} key={`${entry.tool}-${index}`} />
            ))}
          </div>
        ) : null}
        {next === undefined ? null : (
          <p className="text-muted-foreground text-xs" data-running-tool="">
            Calling <span className="font-mono">{next}</span>…
          </p>
        )}
        {live.text.length > 0 ? (
          <div data-streaming-text="">
            <AssistantMarkdown source={live.text} />
          </div>
        ) : next === undefined ? (
          <p className="text-muted-foreground text-xs">
            Working… the assistant may call several tools.
          </p>
        ) : null}
      </div>
    </li>
  );
};

const BudgetMeter = ({
  usage,
  model,
}: Readonly<{ usage: AssistantUsageOutput; model: string }>) => {
  const tokens = usage.inputTokens + usage.outputTokens;
  return (
    <div
      aria-label="Assistant budget today"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs"
      data-budget-meter=""
      role="group"
    >
      <label className="flex items-center gap-2">
        <span>
          Requests {usage.requests} / {usage.requestLimit}
        </span>
        <meter
          className="h-2 w-20"
          high={usage.requestLimit * 0.8}
          max={usage.requestLimit}
          min={0}
          value={Math.min(usage.requests, usage.requestLimit)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span>
          Tokens {formatTokens(tokens)} / {formatTokens(usage.tokenLimit)}
        </span>
        <meter
          className="h-2 w-20"
          high={usage.tokenLimit * 0.8}
          max={usage.tokenLimit}
          min={0}
          value={Math.min(tokens, usage.tokenLimit)}
        />
      </label>
      {model.length > 0 ? <span className="font-mono">{model}</span> : null}
    </div>
  );
};

type AssistantChatOptions = Readonly<{
  gateway: AssistantGateway | undefined;
  pageContext: AssistantPageContext | undefined;
}>;

/** All assistant state and actions; both layouts (page and side panel) render from it. */
const useAssistantChat = ({
  gateway: suppliedGateway,
  pageContext,
}: AssistantChatOptions) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAssistantGateway()
  );
  const [list, setList] = useState<ListState>({ type: "loading" });
  const [transcript, setTranscript] = useState<TranscriptState>({
    type: "empty",
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<AssistantModeValue>("plan");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn>(EMPTY_LIVE_TURN);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionState>({
    busy: null,
    errors: {},
  });
  const generation = useRef(0);
  const stopper = useRef<AbortController | null>(null);
  const started = useRef(false);
  // The message list is the only scroll area. following: the operator is at (or near) its end, so
  // new messages and live text keep it there; scrolling up to read turns it off until they return.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const loadList = useCallback(async () => {
    try {
      const output = await gateway.list();
      return setList({
        status: output.status,
        threads: output.threads,
        type: "ready",
      });
    } catch (error) {
      return setList(
        assistantFailureCode(error) === "FORBIDDEN"
          ? { type: "forbidden" }
          : { message: describeAssistantFailure(error), type: "error" }
      );
    }
  }, [gateway]);

  const openThread = useCallback(
    async (threadId: string, keepNotice = false) => {
      const mine = ++generation.current;
      setActiveId(threadId);
      if (!keepNotice) {
        following.current = true;
        setSendError(null);
        setStopNote(null);
      }
      setTranscript({ threadId, type: "loading" });
      try {
        const output = await gateway.get(threadId);
        if (mine === generation.current)
          return setTranscript({
            actions: output.actions,
            messages: output.messages,
            threadId,
            type: "ready",
          });
        return;
      } catch (error) {
        if (mine === generation.current)
          return setTranscript({
            message: describeAssistantFailure(error),
            threadId,
            type: "error",
          });
        return;
      }
    },
    [gateway]
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    return void loadList();
  }, [loadList]);

  // Keep the newest message, the "Working" line and live text in view while the operator follows
  // the end. No smooth scroll: it can block reading.
  const shownCount =
    transcript.type === "ready" ? transcript.messages.length : 0;
  const liveBlocks = live.tools.length + live.modelCall;
  const liveText = live.text.length;
  useEffect(() => {
    const element = scroller.current;
    if (shownCount + liveBlocks + liveText === 0 && pending === null) return;
    if (element === null || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [shownCount, pending, liveBlocks, liveText]);

  const newThread = () => {
    generation.current += 1;
    following.current = true;
    setActiveId(null);
    setTranscript({ type: "empty" });
    setSendError(null);
    return setStopNote(null);
  };

  const pageInput = useMemo(
    () => (pageContext === undefined ? {} : { page: pageContext }),
    [pageContext]
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (message.length === 0 || pending !== null) return;
      setPending(message);
      setLive(EMPTY_LIVE_TURN);
      setSendError(null);
      setStopNote(null);
      // Sending is a request to see the answer: follow the end again.
      following.current = true;
      const controller = new AbortController();
      stopper.current = controller;
      let threadId = activeId;
      try {
        if (threadId === null) {
          const thread = await gateway.create(threadTitleFrom(message));
          threadId = thread.id;
          generation.current += 1;
          setActiveId(thread.id);
          setTranscript({
            actions: [],
            messages: [],
            threadId: thread.id,
            type: "ready",
          });
        }
        const output = await gateway.send(
          {
            message,
            mode,
            threadId,
            ...pageInput,
          },
          controller.signal,
          (event) => setLive((current) => applyLiveEvent(current, event))
        );
        setDraft("");
        setTranscript((current) => {
          const same =
            current.type === "ready" && current.threadId === output.thread.id;
          return {
            actions: [...(same ? current.actions : []), ...output.actions],
            messages: [
              ...(same ? current.messages : []),
              output.userMessage,
              output.reply,
            ],
            threadId: output.thread.id,
            type: "ready",
          };
        });
        setStopNote(STOP_NOTES[output.stopReason] ?? null);
        return setList((current) => {
          if (current.type !== "ready") return current;
          const others = current.threads.filter(
            (thread) => thread.id !== output.thread.id
          );
          return {
            ...current,
            status: { ...current.status, usage: output.usage },
            threads: [output.thread, ...others],
          };
        });
      } catch (error) {
        if (controller.signal.aborted) {
          setStopNote(STOPPED_NOTE);
          if (threadId !== null) void openThread(threadId, true);
          return void loadList();
        }
        setSendError(describeAssistantFailure(error));
        // A failed turn may still be recorded; show what the server kept and refresh the budget.
        if (threadId !== null) void openThread(threadId, true);
        return void loadList();
      } finally {
        stopper.current = null;
        setPending(null);
        setLive(EMPTY_LIVE_TURN);
      }
    },
    [activeId, gateway, loadList, mode, openThread, pageInput, pending]
  );

  const decide = useCallback(
    async (id: string, decision: AssistantActionDecision) => {
      if (decisions.busy !== null) return;
      setDecisions((current) => {
        const { [id]: _cleared, ...errors } = current.errors;
        return { busy: { decision, id }, errors };
      });
      try {
        const updated = await gateway.decide(id, decision);
        setTranscript((current) =>
          current.type === "ready"
            ? {
                ...current,
                actions: current.actions.map((action) =>
                  action.id === updated.id ? updated : action
                ),
              }
            : current
        );
        return setDecisions((current) => ({ ...current, busy: null }));
      } catch (error) {
        return setDecisions((current) => ({
          busy: null,
          errors: { ...current.errors, [id]: describeAssistantFailure(error) },
        }));
      }
    },
    [decisions.busy, gateway]
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return void send(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      // Submit through the form so the click log records Enter like a Send click.
      event.currentTarget.form?.requestSubmit();
    }
    return;
  };

  const status = list.type === "ready" ? list.status : null;
  const messages = transcript.type === "ready" ? transcript.messages : [];
  const busy = pending !== null;
  return {
    actions: transcript.type === "ready" ? transcript.actions : [],
    activeId,
    busy,
    configured: status?.configured ?? false,
    decide,
    decisions,
    draft,
    list,
    live,
    messages,
    mode,
    newThread,
    onKeyDown,
    onTranscriptScroll: (event: UIEvent<HTMLDivElement>) => {
      following.current = isNearTranscriptEnd(event.currentTarget);
    },
    openThread,
    pending,
    scroller,
    send,
    sendError,
    setDraft,
    setMode,
    showStarters:
      transcript.type !== "loading" && messages.length === 0 && !busy,
    status,
    stop: () => stopper.current?.abort(),
    stopNote,
    submit,
    threads: list.type === "ready" ? list.threads : [],
    transcript,
  };
};

type AssistantChat = ReturnType<typeof useAssistantChat>;
type ChatProps = Readonly<{ chat: AssistantChat }>;

const ModeToggle = ({
  chat,
  compact = false,
  describedBy,
}: ChatProps & Readonly<{ compact?: boolean; describedBy?: string }>) => {
  return (
    <div
      aria-describedby={describedBy}
      aria-label="Assistant mode"
      className="inline-flex rounded-md border border-border p-0.5"
      role="radiogroup"
    >
      {MODES.map((option) => {
        return (
          <button
            aria-checked={chat.mode === option.value}
            className={`min-h-11 rounded text-sm ${compact ? "min-w-12 px-2" : "min-w-16 px-3"} ${chat.mode === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            data-mode={option.value}
            disabled={chat.busy}
            key={option.value}
            onClick={() => chat.setMode(option.value)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

/** Model not configured, and the thread loading or failing to load. */
const ChatNotices = ({ chat }: ChatProps) => {
  return (
    <>
      {chat.status !== null && !chat.configured ? (
        <p
          className="shrink-0 rounded-md border border-border p-3 text-sm"
          data-assistant-unconfigured=""
          role="status"
        >
          Assistant model not configured. Set OPENROUTER_API_KEY on the server
          to enable it.
        </p>
      ) : null}
      {chat.transcript.type === "loading" ? (
        <p aria-busy="true" className="shrink-0 text-muted-foreground text-sm">
          Loading conversation…
        </p>
      ) : null}
      {chat.transcript.type === "error" ? (
        <p className="shrink-0 text-sm" role="alert">
          {chat.transcript.message}
        </p>
      ) : null}
    </>
  );
};

/** The only scroll area: the composer and Stop below stay in view while a reply streams. */
const TranscriptScroll = ({
  chat,
  children,
}: ChatProps & Readonly<{ children: ReactNode }>) => {
  return (
    <div
      aria-label="Messages"
      className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-transcript-scroll=""
      onScroll={chat.onTranscriptScroll}
      ref={chat.scroller}
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll the transcript.
      tabIndex={0}
    >
      <ol
        aria-busy={chat.busy}
        aria-label="Transcript"
        aria-live="polite"
        className="space-y-3"
        data-click-private=""
      >
        {chat.messages.map((message) => (
          <MessageView
            actions={chat.actions.filter(
              (action) => action.messageId === message.id
            )}
            decisions={chat.decisions}
            key={message.id}
            message={message}
            onDecide={(id, decision) => void chat.decide(id, decision)}
          />
        ))}
        {chat.pending === null ? null : (
          <>
            <li className="flex justify-end" data-message-role="pending">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary/10 px-4 py-3 text-sm">
                {chat.pending}
              </p>
            </li>
            <LiveTurnView live={chat.live} />
          </>
        )}
      </ol>
      {children}
    </div>
  );
};

const PromptChip = ({
  chat,
  prompt,
}: ChatProps & Readonly<{ prompt: string }>) => {
  return (
    <Button
      disabled={!chat.configured}
      onClick={() => void chat.send(prompt)}
      size="compact"
      type="button"
      variant="secondary"
    >
      {prompt}
    </Button>
  );
};

const Composer = ({
  chat,
  hint,
  label,
  rows,
  textareaId,
}: ChatProps &
  Readonly<{
    hint: string;
    label: string;
    rows: number;
    textareaId: string;
  }>) => {
  return (
    <div
      className="shrink-0 space-y-2 border-border border-t pt-3"
      data-assistant-composer=""
    >
      {chat.stopNote === null ? null : (
        <p className="text-muted-foreground text-xs" role="status">
          {chat.stopNote}
        </p>
      )}
      {chat.sendError === null ? null : (
        <p
          className="rounded-md border border-border p-3 text-sm"
          data-send-error=""
          role="alert"
        >
          {chat.sendError}
        </p>
      )}
      <form
        className="space-y-2"
        data-click-label="Send message"
        onSubmit={chat.submit}
      >
        <label className="sr-only" htmlFor={textareaId}>
          {label}
        </label>
        <Textarea
          className="max-h-40"
          disabled={chat.busy || !chat.configured}
          id={textareaId}
          maxLength={4000}
          onChange={(event) => chat.setDraft(event.target.value)}
          onKeyDown={chat.onKeyDown}
          placeholder={
            chat.mode === "plan"
              ? "Ask about tasks, papers, backtests, strategies or market data…"
              : "Ask the assistant to look something up or record a task, paper, strategy or preset…"
          }
          rows={rows}
          value={chat.draft}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">{hint}</p>
          {/* Separate keys: React must not reuse the Stop <button> as the Send submit button. The
              abort settles in the click's microtasks, before its default action, so a reused
              element would submit the form and resend the draft in the same click. */}
          {chat.busy ? (
            <Button
              key="stop"
              onClick={chat.stop}
              type="button"
              variant="outline"
            >
              <Square aria-hidden="true" className="size-4" />
              Stop
            </Button>
          ) : (
            <Button
              disabled={!chat.configured || chat.draft.trim().length === 0}
              key="send"
              type="submit"
            >
              <SendHorizontal aria-hidden="true" className="size-4" />
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};

const PAGE_COMPOSER_HINT =
  "Enter to send, Shift+Enter for a new line. Tool results are treated as data, never instructions.";
const PANEL_COMPOSER_HINT = "Enter to send, Shift+Enter for a new line.";

/** The /assistant page: threads on the left, the conversation on the right. */
const AssistantPageLayout = ({ chat }: ChatProps) => {
  return (
    <div
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-6"
      data-assistant-workspace=""
    >
      <nav
        aria-label="Assistant threads"
        className="flex min-h-0 flex-col gap-2"
      >
        <Button
          disabled={chat.busy}
          fullWidth
          onClick={chat.newThread}
          type="button"
          variant="secondary"
        >
          <MessageSquarePlus aria-hidden="true" className="size-4" />
          New thread
        </Button>
        {chat.list.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-xs">
            Loading threads…
          </p>
        ) : null}
        {chat.list.type === "error" ? (
          <p className="text-xs" role="alert">
            {chat.list.message}
          </p>
        ) : null}
        {chat.list.type === "ready" && chat.threads.length === 0 ? (
          <p className="text-muted-foreground text-xs">No threads yet.</p>
        ) : null}
        {/* Capped on small screens so the conversation keeps the height; a column of its own on large. */}
        <ul
          className="max-h-28 min-h-0 space-y-1 overflow-y-auto lg:max-h-none lg:flex-1"
          data-click-private=""
        >
          {chat.threads.map((thread) => {
            return (
              <li key={thread.id}>
                <button
                  aria-current={
                    thread.id === chat.activeId ? "true" : undefined
                  }
                  className={`flex min-h-11 w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${thread.id === chat.activeId ? "bg-muted font-medium" : ""}`}
                  data-thread-id={thread.id}
                  disabled={chat.busy}
                  onClick={() => void chat.openThread(thread.id)}
                  type="button"
                >
                  <span className="line-clamp-2">{thread.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatTimestamp(thread.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section
        aria-label="Assistant conversation"
        className="flex min-h-0 min-w-0 flex-col gap-3"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <ModeToggle chat={chat} />
            <p className="text-muted-foreground text-xs" data-mode-help="">
              {ASSISTANT_MODE_HELP[chat.mode]}
            </p>
          </div>
          {chat.status === null ? null : (
            <BudgetMeter model={chat.status.model} usage={chat.status.usage} />
          )}
        </div>
        <ChatNotices chat={chat} />
        <TranscriptScroll chat={chat}>
          {chat.showStarters ? (
            <div
              aria-label="Starter prompts"
              className="flex flex-wrap gap-2"
              role="group"
            >
              {ASSISTANT_STARTER_PROMPTS.map((prompt) => (
                <PromptChip chat={chat} key={prompt} prompt={prompt} />
              ))}
            </div>
          ) : null}
        </TranscriptScroll>
        <Composer
          chat={chat}
          hint={PAGE_COMPOSER_HINT}
          label="Message"
          rows={3}
          textareaId="assistant-message"
        />
      </section>
    </div>
  );
};

const EXPLAIN_PAGE_PROMPT = "Explain this page";
const PANEL_HISTORY_ID = "assistant-panel-history";
const PANEL_MODE_HELP_ID = "assistant-panel-mode-help";
const PANEL_HISTORY_MAX = 20;

/**
 * Recent threads for the narrow panel; choosing one opens it. Escape closes the list only: the
 * capture listener marks the key handled (preventDefault), so the panel itself stays open.
 */
const PanelHistory = ({
  chat,
  onClose,
}: ChatProps & Readonly<{ onClose: () => void }>) => {
  const threads = chat.threads.slice(0, PANEL_HISTORY_MAX);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      return onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <nav
      aria-label="Recent threads"
      className="absolute inset-x-0 top-12 z-popover max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      id={PANEL_HISTORY_ID}
    >
      {chat.list.type === "loading" ? (
        <p aria-busy="true" className="px-2 py-2 text-muted-foreground text-xs">
          Loading threads…
        </p>
      ) : null}
      {chat.list.type === "error" ? (
        <p className="px-2 py-2 text-xs" role="alert">
          {chat.list.message}
        </p>
      ) : null}
      {chat.list.type === "ready" && threads.length === 0 ? (
        <p className="px-2 py-2 text-muted-foreground text-xs">
          No threads yet.
        </p>
      ) : null}
      <ul className="space-y-0.5" data-click-private="">
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              aria-current={thread.id === chat.activeId ? "true" : undefined}
              autoFocus={thread === threads[0]}
              className={`flex min-h-11 w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${thread.id === chat.activeId ? "bg-muted font-medium" : ""}`}
              data-thread-id={thread.id}
              disabled={chat.busy}
              onClick={() => {
                onClose();
                return void chat.openThread(thread.id);
              }}
              type="button"
            >
              <span className="line-clamp-1">{thread.title}</span>
              <span className="text-muted-foreground text-xs">
                {formatTimestamp(thread.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};

/** The side panel: compact toolbar, greeting and chips when empty, composer pinned at the bottom. */
const AssistantPanelLayout = ({
  chat,
  pageAware,
}: ChatProps & Readonly<{ pageAware: boolean }>) => {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    return historyButton.current?.focus();
  }, []);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-2"
      data-assistant-workspace=""
      data-variant="panel"
    >
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          aria-controls={PANEL_HISTORY_ID}
          aria-expanded={historyOpen}
          aria-label="Thread history"
          disabled={chat.busy}
          onClick={() => setHistoryOpen((open) => !open)}
          ref={historyButton}
        >
          <History aria-hidden="true" />
        </IconButton>
        <ModeToggle chat={chat} compact describedBy={PANEL_MODE_HELP_ID} />
        <IconButton
          aria-label="New chat"
          className="ml-auto"
          disabled={chat.busy}
          onClick={() => {
            setHistoryOpen(false);
            return chat.newThread();
          }}
        >
          <MessageSquarePlus aria-hidden="true" />
        </IconButton>
      </div>
      {historyOpen ? <PanelHistory chat={chat} onClose={closeHistory} /> : null}
      <p
        className="shrink-0 text-muted-foreground text-xs"
        data-mode-help=""
        id={PANEL_MODE_HELP_ID}
      >
        {ASSISTANT_MODE_HELP[chat.mode]}
      </p>
      <ChatNotices chat={chat} />
      <TranscriptScroll chat={chat}>
        {chat.showStarters ? (
          <div
            className="flex min-h-full flex-col items-center justify-center gap-3 px-2 py-6 text-center"
            data-assistant-greeting=""
          >
            <span className="flex size-10 items-center justify-center rounded-full border border-border">
              <Sparkles aria-hidden="true" className="size-5 text-primary" />
            </span>
            <p className="font-medium text-sm">
              Ask about this page or your research
            </p>
            <div
              aria-label="Starter prompts"
              className="flex flex-wrap justify-center gap-2"
              role="group"
            >
              {(pageAware
                ? [EXPLAIN_PAGE_PROMPT, ...ASSISTANT_STARTER_PROMPTS]
                : ASSISTANT_STARTER_PROMPTS
              ).map((prompt) => (
                <PromptChip chat={chat} key={prompt} prompt={prompt} />
              ))}
            </div>
          </div>
        ) : null}
      </TranscriptScroll>
      <Composer
        chat={chat}
        hint={PANEL_COMPOSER_HINT}
        label="Ask the assistant"
        rows={2}
        textareaId="assistant-panel-message"
      />
    </div>
  );
};

export const AssistantWorkspace = ({
  gateway,
  pageContext,
  variant = "page",
}: AssistantWorkspaceProps) => {
  const chat = useAssistantChat({ gateway, pageContext });
  if (chat.list.type === "forbidden")
    return <OperatorAccessRequired feature="assistant" />;
  return variant === "panel" ? (
    <AssistantPanelLayout chat={chat} pageAware={pageContext !== undefined} />
  ) : (
    <AssistantPageLayout chat={chat} />
  );
};
