"use client";

import {
  createApiClient,
  type ApiClient,
  type AssistantActionDecision,
  type AssistantActionOutput,
  type AssistantModeValue,
  type AssistantSendOutput,
  type AssistantThreadGetOutput,
  type AssistantThreadListOutput,
  type AssistantThreadOutput,
} from "@darkfactory/api";

// Research assistant (assistant.*): operator session only. The browser never sees the model key; the
// server runs the tool loop and returns the reply with a tool-call trace. Confirm cards (save a
// strategy definition, run a backtest, run a sweep) run only after `decide` with "approve".
export interface AssistantGateway {
  readonly list: () => Promise<AssistantThreadListOutput>;
  readonly create: (title?: string) => Promise<AssistantThreadOutput>;
  readonly get: (id: string) => Promise<AssistantThreadGetOutput>;
  readonly send: (
    input: Readonly<{
      threadId: string;
      message: string;
      mode: AssistantModeValue;
    }>,
    // Stop: aborting cancels the request; the server ends the turn at its next step.
    signal?: AbortSignal
  ) => Promise<AssistantSendOutput>;
  readonly decide: (
    id: string,
    decision: AssistantActionDecision
  ) => Promise<AssistantActionOutput>;
}

const createAssistantGateway = (client: ApiClient): AssistantGateway => ({
  list: () => client.assistant.threads.list({}),
  create: (title) =>
    client.assistant.threads.create(title === undefined ? {} : { title }),
  get: (id) => client.assistant.threads.get({ id }),
  send: (input, signal) =>
    client.assistant.send(
      {
        threadId: input.threadId,
        message: input.message,
        mode: input.mode,
      },
      signal === undefined ? {} : { signal }
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
      input: Readonly<{
        threadId: string;
        message: string;
        mode: AssistantModeValue;
      }>,
      signal?: AbortSignal
    ) => current().send(input, signal),
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
      return "Operator access required.";
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
