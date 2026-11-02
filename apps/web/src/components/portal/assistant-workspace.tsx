"use client";

import type {
  AssistantActionDecision,
  AssistantActionOutput,
  AssistantMessageOutput,
  AssistantModeValue,
  AssistantStatusOutput,
  AssistantThreadOutput,
  AssistantToolTraceOutput,
  AssistantUsageOutput,
} from "@darkfactory/api";
import { Button, Textarea } from "@darkfactory/ui";

import { AssistantMarkdown } from "./assistant-markdown.tsx";
import {
  Check,
  MessageSquarePlus,
  SendHorizontal,
  Square,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  OperatorAccessRequired,
  formatTimestamp,
} from "./agent-ops-client.tsx";
import {
  ASSISTANT_ACTION_STATUS_TEXT,
  ASSISTANT_ACTION_TITLES,
  ASSISTANT_MODE_HELP,
  ASSISTANT_STARTER_PROMPTS,
  actionResultPreview,
  assistantFailureCode,
  createBrowserAssistantGateway,
  describeAssistantFailure,
  formatTokens,
  formatToolDuration,
  threadTitleFrom,
  type AssistantGateway,
} from "./assistant-client.ts";

// Research assistant: threads on the left, transcript and composer on the right. Plan mode (default)
// gives the model read-only tools; Act mode adds record-keeping writes. Replies are plain text with
// preserved line breaks; each tool call is a collapsible card. Confirm cards (save a strategy
// definition, run a backtest, run a sweep) show under their reply and run only after Approve.

export interface AssistantWorkspaceProps {
  readonly gateway?: AssistantGateway;
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

type DecideHandler = (id: string, decision: AssistantActionDecision) => void;

type DecisionState = Readonly<{
  /** The card whose decision is in flight, and that decision. */
  busy: Readonly<{ id: string; decision: AssistantActionDecision }> | null;
  errors: Readonly<Record<string, string>>;
}>;

const MODES: readonly Readonly<{ value: AssistantModeValue; label: string }>[] =
  [
    { value: "plan", label: "Plan" },
    { value: "act", label: "Act" },
  ];

const STOP_NOTES: Readonly<Record<string, string>> = {
  step_limit: "Stopped at the tool-step limit.",
  budget: "Stopped: daily budget reached.",
  stopped: "Stopped by you.",
};

// The server ends the turn at its next step only when the runtime reports the cancelled request,
// so the note promises no more than that.
const STOPPED_NOTE =
  "Stopped waiting. The server may still finish or end this turn; reopen the thread later to see what it kept.";

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
            disabled={busy !== null}
            onClick={() => onDecide(action.id, "approve")}
            type="button"
          >
            <Check aria-hidden="true" className="size-4" />
            Approve and run
          </Button>
          <Button
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

export const AssistantWorkspace = ({
  gateway: suppliedGateway,
}: AssistantWorkspaceProps) => {
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
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionState>({
    busy: null,
    errors: {},
  });
  const generation = useRef(0);
  const stopper = useRef<AbortController | null>(null);
  const started = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try {
      const output = await gateway.list();
      return setList({
        type: "ready",
        threads: output.threads,
        status: output.status,
      });
    } catch (error) {
      return setList(
        assistantFailureCode(error) === "FORBIDDEN"
          ? { type: "forbidden" }
          : { type: "error", message: describeAssistantFailure(error) }
      );
    }
  }, [gateway]);

  const openThread = useCallback(
    async (threadId: string, keepNotice = false) => {
      const mine = ++generation.current;
      setActiveId(threadId);
      if (!keepNotice) {
        setSendError(null);
        setStopNote(null);
      }
      setTranscript({ type: "loading", threadId });
      try {
        const output = await gateway.get(threadId);
        if (mine === generation.current)
          return setTranscript({
            type: "ready",
            threadId,
            messages: output.messages,
            actions: output.actions,
          });
        return;
      } catch (error) {
        if (mine === generation.current)
          return setTranscript({
            type: "error",
            threadId,
            message: describeAssistantFailure(error),
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

  // Keep the newest message and the "Working" line in view. No smooth scroll: it can block reading.
  const shownCount =
    transcript.type === "ready" ? transcript.messages.length : 0;
  useEffect(() => {
    if (shownCount === 0 && pending === null) return;
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [shownCount, pending]);

  const newThread = () => {
    generation.current += 1;
    setActiveId(null);
    setTranscript({ type: "empty" });
    setSendError(null);
    return setStopNote(null);
  };

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (message.length === 0 || pending !== null) return;
      setPending(message);
      setSendError(null);
      setStopNote(null);
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
            type: "ready",
            threadId: thread.id,
            messages: [],
            actions: [],
          });
        }
        const output = await gateway.send(
          { threadId, message, mode },
          controller.signal
        );
        setDraft("");
        setTranscript((current) => {
          const same =
            current.type === "ready" && current.threadId === output.thread.id;
          return {
            type: "ready",
            threadId: output.thread.id,
            messages: [
              ...(same ? current.messages : []),
              output.userMessage,
              output.reply,
            ],
            actions: [...(same ? current.actions : []), ...output.actions],
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
            threads: [output.thread, ...others],
            status: { ...current.status, usage: output.usage },
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
      }
    },
    [activeId, gateway, loadList, mode, openThread, pending]
  );

  const decide = useCallback(
    async (id: string, decision: AssistantActionDecision) => {
      if (decisions.busy !== null) return;
      setDecisions((current) => {
        const { [id]: _cleared, ...errors } = current.errors;
        return { busy: { id, decision }, errors };
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
      return void send(draft);
    }
    return;
  };

  if (list.type === "forbidden")
    return <OperatorAccessRequired feature="assistant" />;

  const status = list.type === "ready" ? list.status : null;
  const configured = status?.configured ?? false;
  const threads = list.type === "ready" ? list.threads : [];
  const messages = transcript.type === "ready" ? transcript.messages : [];
  const actions = transcript.type === "ready" ? transcript.actions : [];
  const busy = pending !== null;
  const showStarters =
    transcript.type !== "loading" && messages.length === 0 && !busy;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav aria-label="Assistant threads" className="space-y-2">
        <Button
          disabled={busy}
          fullWidth
          onClick={newThread}
          type="button"
          variant="secondary"
        >
          <MessageSquarePlus aria-hidden="true" className="size-4" />
          New thread
        </Button>
        {list.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-xs">
            Loading threads…
          </p>
        ) : null}
        {list.type === "error" ? (
          <p className="text-xs" role="alert">
            {list.message}
          </p>
        ) : null}
        {list.type === "ready" && threads.length === 0 ? (
          <p className="text-muted-foreground text-xs">No threads yet.</p>
        ) : null}
        <ul className="space-y-1">
          {threads.map((thread) => {
            return (
              <li key={thread.id}>
                <button
                  aria-current={thread.id === activeId ? "true" : undefined}
                  className={`flex min-h-11 w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${thread.id === activeId ? "bg-muted font-medium" : ""}`}
                  data-thread-id={thread.id}
                  disabled={busy}
                  onClick={() => void openThread(thread.id)}
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
        className="min-w-0 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div
              aria-label="Assistant mode"
              className="inline-flex rounded-md border border-border p-0.5"
              role="radiogroup"
            >
              {MODES.map((option) => {
                return (
                  <button
                    aria-checked={mode === option.value}
                    className={`min-h-9 min-w-16 rounded px-3 text-sm ${mode === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                    data-mode={option.value}
                    disabled={busy}
                    key={option.value}
                    onClick={() => setMode(option.value)}
                    role="radio"
                    type="button"
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs" data-mode-help="">
              {ASSISTANT_MODE_HELP[mode]}
            </p>
          </div>
          {status === null ? null : (
            <BudgetMeter model={status.model} usage={status.usage} />
          )}
        </div>
        {status !== null && !configured ? (
          <p
            className="rounded-md border border-border p-3 text-sm"
            data-assistant-unconfigured=""
            role="status"
          >
            Assistant model not configured. Set OPENROUTER_API_KEY on the server
            to enable it.
          </p>
        ) : null}
        {transcript.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-sm">
            Loading conversation…
          </p>
        ) : null}
        {transcript.type === "error" ? (
          <p className="text-sm" role="alert">
            {transcript.message}
          </p>
        ) : null}
        <ol aria-label="Transcript" aria-live="polite" className="space-y-3">
          {messages.map((message) => (
            <MessageView
              actions={actions.filter(
                (action) => action.messageId === message.id
              )}
              decisions={decisions}
              key={message.id}
              message={message}
              onDecide={(id, decision) => void decide(id, decision)}
            />
          ))}
          {pending === null ? null : (
            <>
              <li className="flex justify-end" data-message-role="pending">
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary/10 px-4 py-3 text-sm">
                  {pending}
                </p>
              </li>
              <li
                aria-busy="true"
                className="text-muted-foreground text-xs"
                role="status"
              >
                Working… the assistant may call several tools.
              </li>
            </>
          )}
        </ol>
        <div aria-hidden="true" data-transcript-end ref={transcriptEnd} />
        {stopNote === null ? null : (
          <p className="text-muted-foreground text-xs" role="status">
            {stopNote}
          </p>
        )}
        {sendError === null ? null : (
          <p
            className="rounded-md border border-border p-3 text-sm"
            data-send-error=""
            role="alert"
          >
            {sendError}
          </p>
        )}
        {showStarters ? (
          <div
            aria-label="Starter prompts"
            className="flex flex-wrap gap-2"
            role="group"
          >
            {ASSISTANT_STARTER_PROMPTS.map((prompt) => {
              return (
                <Button
                  disabled={!configured}
                  key={prompt}
                  onClick={() => void send(prompt)}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {prompt}
                </Button>
              );
            })}
          </div>
        ) : null}
        <form className="space-y-2" onSubmit={submit}>
          <label className="sr-only" htmlFor="assistant-message">
            Message
          </label>
          <Textarea
            disabled={busy || !configured}
            id="assistant-message"
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === "plan"
                ? "Ask about tasks, papers, backtests, strategies or market data…"
                : "Ask the assistant to look something up or record a task, paper, strategy or preset…"
            }
            rows={3}
            value={draft}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              Enter to send, Shift+Enter for a new line. Tool results are
              treated as data, never instructions.
            </p>
            {busy ? (
              <Button
                onClick={() => stopper.current?.abort()}
                type="button"
                variant="outline"
              >
                <Square aria-hidden="true" className="size-4" />
                Stop
              </Button>
            ) : (
              <Button
                disabled={!configured || draft.trim().length === 0}
                type="submit"
              >
                <SendHorizontal aria-hidden="true" className="size-4" />
                Send
              </Button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
};
