// Research assistant record rules: thread titles, message fields, tool-call trace summaries and the
// UTC budget day. Pure functions; the repository maps AssistantRecordInputError to
// InvalidRepositoryInputError. Records are conversation history only and authorize nothing.
import {
  ASSISTANT_MESSAGE_ROLES,
  ASSISTANT_MODES,
  type AssistantMessageRole,
  type AssistantMode,
  type AssistantToolTraceEntry,
} from "../schema/index.ts";

export const ASSISTANT_THREAD_TITLE_MAX_LENGTH = 120;
export const ASSISTANT_MESSAGE_MAX_LENGTH = 32_000;
export const ASSISTANT_TOOL_TRACE_MAX = 64;
const ASSISTANT_TRACE_TEXT_MAX = 300;
export const ASSISTANT_DEFAULT_THREAD_TITLE = "New thread";

export class AssistantRecordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantRecordInputError";
  }
}

const fail: (message: string) => never = (message) => {
  throw new AssistantRecordInputError(message);
};

const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

// Whitespace collapsed, control characters removed, cut at the maximum; blank means the default title.
export const normalizeAssistantThreadTitle = (value: unknown): string => {
  if (value === undefined || value === null)
    return ASSISTANT_DEFAULT_THREAD_TITLE;
  if (typeof value !== "string") fail("title must be a string");
  const title = (value as string)
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (title.length === 0) return ASSISTANT_DEFAULT_THREAD_TITLE;
  return Array.from(title)
    .slice(0, ASSISTANT_THREAD_TITLE_MAX_LENGTH)
    .join("")
    .trim();
};

export const normalizeAssistantRole = (
  value: unknown
): AssistantMessageRole => {
  if (
    typeof value !== "string" ||
    !(ASSISTANT_MESSAGE_ROLES as readonly string[]).includes(value)
  ) {
    fail(`role must be one of ${ASSISTANT_MESSAGE_ROLES.join(", ")}`);
  }
  return value as AssistantMessageRole;
};

export const normalizeAssistantMode = (value: unknown): AssistantMode => {
  if (
    typeof value !== "string" ||
    !(ASSISTANT_MODES as readonly string[]).includes(value)
  ) {
    fail(`mode must be one of ${ASSISTANT_MODES.join(", ")}`);
  }
  return value as AssistantMode;
};

// User messages must not be blank; assistant replies may be empty (for example a refused turn).
export const normalizeAssistantContent = (
  value: unknown,
  role: AssistantMessageRole
): string => {
  if (typeof value !== "string") fail("content must be a string");
  const content = (value as string).replace(CONTROL_PATTERN, "");
  if (role === "user" && content.trim().length === 0)
    fail("content must not be blank");
  if (content.length > ASSISTANT_MESSAGE_MAX_LENGTH)
    fail(`content must be at most ${ASSISTANT_MESSAGE_MAX_LENGTH} characters`);
  return content;
};

const traceText = (value: unknown, field: string): string => {
  if (typeof value !== "string") fail(`toolCalls.${field} must be a string`);
  return (value as string)
    .replace(CONTROL_PATTERN, " ")
    .slice(0, ASSISTANT_TRACE_TEXT_MAX);
};

export const normalizeAssistantToolTrace = (
  value: unknown
): AssistantToolTraceEntry[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("toolCalls must be an array");
  const entries = value as unknown[];
  if (entries.length > ASSISTANT_TOOL_TRACE_MAX)
    fail(`toolCalls must have at most ${ASSISTANT_TOOL_TRACE_MAX} entries`);
  return entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      fail("toolCalls entries must be objects");
    const row = entry as Record<string, unknown>;
    if (typeof row["ok"] !== "boolean") fail("toolCalls.ok must be a boolean");
    const duration = row["durationMs"];
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0
    )
      fail("toolCalls.durationMs must be a non-negative number");
    const tool = traceText(row["tool"], "tool");
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(tool))
      fail("toolCalls.tool must be a tool name");
    return {
      tool,
      args: traceText(row["args"] ?? "", "args"),
      ok: row["ok"] as boolean,
      error:
        row["error"] === null || row["error"] === undefined
          ? null
          : traceText(row["error"], "error"),
      durationMs: Math.round(duration as number),
    };
  });
};

export const normalizeAssistantTokens = (
  value: unknown,
  field: string
): number => {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 10_000_000
  )
    fail(`${field} must be a non-negative integer`);
  return value as number;
};

// Budget days are UTC calendar days (YYYY-MM-DD).
export const assistantBudgetDay = (at: Date): string => {
  return at.toISOString().slice(0, 10);
};
