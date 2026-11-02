import { and, asc, eq, inArray } from "drizzle-orm";

import {
  type AssistantActionStatus,
  assistantActions,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Assistant confirm cards. A mutating research tool call that the assistant proposes is stored as a
// pending action; it runs only after its owner approves it. The only transitions are
// pending -> running (approve) -> executed | failed, and pending -> rejected. Each transition is a
// conditional update on the current status, so an action is decided and executed at most once.
// The tool arguments are written once by createMany and never updated.

/** Most actions one list call returns (100 messages x 4 cards, plus room). */
export const ASSISTANT_ACTIONS_LIST_MAX = 500;
export const ASSISTANT_ACTION_RESULT_MAX_LENGTH = 16_000;
export const ASSISTANT_ACTION_ERROR_MAX_LENGTH = 500;
export const ASSISTANT_ACTION_SUMMARY_MAX_LENGTH = 500;

export type AssistantActionRecord = Readonly<{
  id: string;
  threadId: string;
  messageId: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: AssistantActionStatus;
  result: string | null;
  error: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  finishedAt: Date | null;
}>;

export type AssistantActionCreateInput = Readonly<{
  threadId: string;
  messageId: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}>;

export type AssistantActionFinish =
  | Readonly<{ status: "executed"; result: string }>
  | Readonly<{ status: "failed"; error: string }>;

export type AssistantActionsRepository = Readonly<{
  createMany: (
    inputs: readonly AssistantActionCreateInput[]
  ) => Promise<AssistantActionRecord[]>;
  /** Actions attached to the given messages of one thread, oldest first. */
  listForMessages: (
    threadId: string,
    messageIds: readonly string[]
  ) => Promise<AssistantActionRecord[]>;
  /** Moves the owner's pending action to running (approve) or rejected. Null when not pending. */
  decide: (
    input: Readonly<{
      id: string;
      userId: string;
      decision: "approve" | "reject";
    }>
  ) => Promise<AssistantActionRecord | null>;
  /** Moves a running action to executed or failed. Null when it is not running. */
  finish: (
    id: string,
    outcome: AssistantActionFinish
  ) => Promise<AssistantActionRecord | null>;
}>;

/** Cuts text to a stored maximum. Never empty. */
export const boundAssistantActionText = (
  text: string,
  max: number,
  fallback: string
): string => {
  const trimmed = text.trim();
  return (trimmed === "" ? fallback : trimmed).slice(0, max);
};

export const createAssistantActionsRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): AssistantActionsRepository => ({
  createMany: async (inputs) => {
    if (inputs.length === 0) return [];
    // One millisecond apart, so cards list in the order the assistant proposed them.
    const first = dependencies.now().getTime();
    return (await database
      .insert(assistantActions)
      .values(
        inputs.map((input, index) => ({
          id: dependencies.generateId(),
          threadId: input.threadId,
          messageId: input.messageId,
          userId: input.userId,
          tool: input.tool,
          args: input.args,
          summary: boundAssistantActionText(
            input.summary,
            ASSISTANT_ACTION_SUMMARY_MAX_LENGTH,
            input.tool
          ),
          status: "pending" as const,
          createdAt: new Date(first + index),
        }))
      )
      .returning()) as AssistantActionRecord[];
  },
  listForMessages: async (threadId, messageIds) => {
    if (messageIds.length === 0) return [];
    return (await database
      .select()
      .from(assistantActions)
      .where(
        and(
          eq(assistantActions.threadId, threadId),
          inArray(assistantActions.messageId, [...messageIds])
        )
      )
      .orderBy(asc(assistantActions.createdAt), asc(assistantActions.id))
      .limit(ASSISTANT_ACTIONS_LIST_MAX)) as AssistantActionRecord[];
  },
  decide: async (input) => {
    const now = dependencies.now();
    const [row] = await database
      .update(assistantActions)
      .set(
        input.decision === "approve"
          ? { status: "running", decidedAt: now }
          : { status: "rejected", decidedAt: now, finishedAt: now }
      )
      .where(
        and(
          eq(assistantActions.id, input.id),
          eq(assistantActions.userId, input.userId),
          eq(assistantActions.status, "pending")
        )
      )
      .returning();
    return (row as AssistantActionRecord | undefined) ?? null;
  },
  finish: async (id, outcome) => {
    const [row] = await database
      .update(assistantActions)
      .set(
        outcome.status === "executed"
          ? {
              status: "executed",
              result: outcome.result.slice(
                0,
                ASSISTANT_ACTION_RESULT_MAX_LENGTH
              ),
              finishedAt: dependencies.now(),
            }
          : {
              status: "failed",
              error: boundAssistantActionText(
                outcome.error,
                ASSISTANT_ACTION_ERROR_MAX_LENGTH,
                "Action failed"
              ),
              finishedAt: dependencies.now(),
            }
      )
      .where(
        and(eq(assistantActions.id, id), eq(assistantActions.status, "running"))
      )
      .returning();
    return (row as AssistantActionRecord | undefined) ?? null;
  },
});
