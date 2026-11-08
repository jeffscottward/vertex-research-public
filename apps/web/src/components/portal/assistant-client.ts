"use client";

import {
  createApiClient,
  type ApiClient,
  type AssistantActionDecision,
  type AssistantActionOutput,
  type AssistantModeValue,
  type AssistantPageContext,
  type AssistantSendEvent,
  type AssistantSendOutput,
  type AssistantThreadGetOutput,
  type AssistantThreadListOutput,
  type AssistantThreadOutput,
} from "@darkfactory/api";

// Research assistant (assistant.*): operator session only. The browser never sees the model key; the
// server runs the tool loop and streams the turn: reply text as the model writes it, tool steps, then
// the stored reply with its tool-call trace. Confirm cards (save a strategy definition, run a
// backtest, run a sweep) run only after `decide` with "approve". A message sent from the side panel
// carries the portal page it came from (on /charts also what the chart shows); the server adds it to
// the prompt as context only. Chart tool calls carry display-only artifacts (assistant-artifacts.tsx).
export type AssistantSendRequest = Readonly<{
  threadId: string;
  message: string;
  mode: AssistantModeValue;
  page?: AssistantPageContext;
  /** Teach mode: the server asks for step-by-step explanations (a walkthrough card). */
  teach?: boolean;
}>;

export interface AssistantGateway {
  readonly list: () => Promise<AssistantThreadListOutput>;
  readonly create: (title?: string) => Promise<AssistantThreadOutput>;
  readonly get: (id: string) => Promise<AssistantThreadGetOutput>;
  readonly send: (
    input: AssistantSendRequest,
    // Stop: aborting closes the stream; the server ends the turn at its next step and keeps it.
    signal?: AbortSignal,
    // Live progress while the turn runs; the promise resolves with the stored reply.
    onEvent?: (event: AssistantSendEvent) => void
  ) => Promise<AssistantSendOutput>;
  readonly decide: (
    id: string,
    decision: AssistantActionDecision
  ) => Promise<AssistantActionOutput>;
}

const STREAM_ENDED_CODE = "STREAM_ENDED";

/** Reads a streamed turn: passes each event on and returns the stored reply from "done". */
export const readAssistantTurn = async (
  events: AsyncIterable<AssistantSendEvent>,
  onEvent?: (event: AssistantSendEvent) => void
): Promise<AssistantSendOutput> => {
  for await (const event of events) {
    onEvent?.(event);
    if (event.type === "done") return event.result;
  }
  throw Object.assign(
    new Error("The reply stream ended before the reply was stored."),
    { code: STREAM_ENDED_CODE }
  );
};

const createAssistantGateway = (client: ApiClient): AssistantGateway => ({
  list: () => client.assistant.threads.list({}),
  create: (title) =>
    client.assistant.threads.create(title === undefined ? {} : { title }),
  get: (id) => client.assistant.threads.get({ id }),
  send: async (input, signal, onEvent) =>
    readAssistantTurn(
      await client.assistant.send(
        {
          threadId: input.threadId,
          message: input.message,
          mode: input.mode,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.teach === true ? { teach: true } : {}),
        },
        signal === undefined ? {} : { signal }
      ),
      onEvent
    ),
  decide: (id, decision) => client.assistant.actions.decide({ id, decision }),
});

export const createBrowserAssistantGateway = (): AssistantGateway => {
  let gateway: AssistantGateway | undefined;
  const current = (): AssistantGateway => {
    gateway ??= createAssistantGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    list: () => current().list(),
    create: (title?: string) => current().create(title),
    get: (id: string) => current().get(id),
    send: (
      input: AssistantSendRequest,
      signal?: AbortSignal,
      onEvent?: (event: AssistantSendEvent) => void
    ) => current().send(input, signal, onEvent),
    decide: (id: string, decision: AssistantActionDecision) =>
      current().decide(id, decision),
  });
};

export const ASSISTANT_STARTER_PROMPTS: readonly string[] = Object.freeze([
  "Summarize my latest backtests",
  "Which strategies have no backtests?",
  "Show ES daily bars stats for the last year",
  "What needs my review right now?",
]);

export const ASSISTANT_MODE_HELP: Readonly<Record<AssistantModeValue, string>> =
  Object.freeze({
    plan: "Plan: read-only tools. The assistant looks things up and proposes changes.",
    act: "Act: may also record tasks, papers, strategies and presets, and propose confirm cards (save a definition, run a backtest or sweep) that run only after you approve. Never deployments or orders.",
  });

const field = (value: unknown, key: string): unknown => {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
};

const text = (value: unknown): string | null => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

export const assistantFailureCode = (error: unknown): string => {
  return text(field(error, "code")) ?? "ERROR";
};

export const describeAssistantFailure = (error: unknown): string => {
  const message = text(field(error, "message"));
  switch (assistantFailureCode(error)) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return message ?? "Operator access required.";
    }
    case "NOT_FOUND": {
      return "Thread not found. Reload the page.";
    }
    case "CONFLICT": {
      return message ?? "Already decided. Reload the page.";
    }
    case "NOT_CONFIGURED": {
      return message ?? "Assistant model not configured.";
    }
    case "BUDGET_EXCEEDED": {
      return message ?? "Daily assistant budget used up.";
    }
    case "UPSTREAM_ERROR": {
      return message ?? "Model provider failed.";
    }
    case "BAD_REQUEST":
    case "VALIDATION_ERROR": {
      return `Rejected: ${message ?? "invalid input"}`;
    }
    case "STORAGE_ERROR": {
      return message ?? "Assistant storage unavailable.";
    }
    case STREAM_ENDED_CODE: {
      return "The reply stopped arriving. The thread shows what the server kept.";
    }
    default: {
      return "Request failed. Try again.";
    }
  }
};

// Thread titles come from the first message: one line, at most 80 characters.
export const threadTitleFrom = (message: string): string => {
  const line = message.replace(/\s+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

export const formatTokens = (value: number): string => {
  return value >= 10_000
    ? `${Math.round(value / 1000)}k`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);
};

export const formatToolDuration = (milliseconds: number): string => {
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(1)} s`
    : `${milliseconds} ms`;
};

export const ASSISTANT_ACTION_STATUS_TEXT: Readonly<
  Record<AssistantActionOutput["status"], string>
> = Object.freeze({
  pending: "Waiting for your approval",
  running: "Running",
  executed: "Approved and run",
  failed: "Approved; the run failed",
  rejected: "Rejected; nothing ran",
});

export const ASSISTANT_ACTION_TITLES: Readonly<Record<string, string>> =
  Object.freeze({
    strategy_definition_save: "Save strategy definition",
    backtest_runs_submit: "Run backtest",
    backtest_runs_sweep: "Run parameter sweep",
  });

const RESULT_PREVIEW_MAX = 2000;

/** The start of a tool result for the card; the full text stays on the server. */
export const actionResultPreview = (result: string): string => {
  return result.length > RESULT_PREVIEW_MAX
    ? `${result.slice(0, RESULT_PREVIEW_MAX)}…`
    : result;
};
