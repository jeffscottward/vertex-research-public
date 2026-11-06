import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";
import { MarketSymbolSchema } from "./market-data.ts";

// Operator research assistant. A server-side tool loop calls an OpenRouter model with the MCP tool
// catalogue; every tool call is an internal oRPC request bound to the caller's session, so operator
// checks and validation stay with the existing procedures. Plan mode exposes read tools only; Act mode
// adds record-keeping write tools (tasks, papers, strategies, presets) and three research tools that
// never run inside a turn: saving a strategy definition revision, running a backtest and running a
// parameter sweep each become a confirm card (an assistant action) that runs only after the operator
// approves it with actions.decide. No tool requests deployments or orders. Both modes also get four
// chart tools that run inside the turn and change nothing on the server: their calls carry a
// display-only artifact (chart drawings, a clear, a script, a Teach walkthrough) for the portal.
// Session only: agent API keys are refused.

export const ASSISTANT_MODE_VALUES = ["plan", "act"] as const;
export const ASSISTANT_MESSAGE_MAX = 4000;
// "stopped": the operator pressed Stop; the turn ends at its next step and keeps what it did.
export const ASSISTANT_STOP_REASONS = [
  "completed",
  "step_limit",
  "budget",
  "stopped",
] as const;

export const ASSISTANT_API_ERRORS = {
  ...AGENT_OPS_API_ERRORS,
  NOT_CONFIGURED: { status: 503, message: "Assistant model not configured" },
  UPSTREAM_ERROR: { status: 502, message: "Model provider failed" },
  BUDGET_EXCEEDED: { status: 429, message: "Daily assistant budget used up" },
} as const;

export const ASSISTANT_ACTION_STATUS_VALUES = [
  "pending",
  "running",
  "executed",
  "failed",
  "rejected",
] as const;
export const ASSISTANT_ACTION_DECISIONS = ["approve", "reject"] as const;

export const AssistantModeSchema = z.enum(ASSISTANT_MODE_VALUES);
export const AssistantStopReasonSchema = z.enum(ASSISTANT_STOP_REASONS);

const IdSchema = z.string().trim().min(1).max(128);

// Chart artifacts: what a chart tool call (chart_draw, chart_clear_drawings, chart_script,
// teach_steps) hands the browser. Display only: the portal applies them to the chart workstation
// (drawings, a script in the editor, a teach walkthrough); nothing here reaches orders or risk.
export const ASSISTANT_DRAWING_TOOLS = [
  "trend",
  "level",
  "rectangle",
  "fib",
  "text",
] as const;
/** Points each drawing tool needs (the chart workstation's click steps). */
export const ASSISTANT_DRAWING_POINTS: Readonly<
  Record<(typeof ASSISTANT_DRAWING_TOOLS)[number], number>
> = Object.freeze({ trend: 2, level: 1, rectangle: 2, fib: 2, text: 1 });
export const ASSISTANT_ARTIFACT_DRAWINGS_MAX = 24;
export const ASSISTANT_DRAWING_TEXT_MAX = 80;
export const ASSISTANT_SCRIPT_TITLE_MAX = 80;
export const ASSISTANT_SCRIPT_SOURCE_MAX = 16_000;
export const ASSISTANT_TEACH_TOPIC_MAX = 120;
export const ASSISTANT_TEACH_STEPS_MAX = 12;
export const ASSISTANT_TEACH_STEP_TITLE_MAX = 80;
export const ASSISTANT_TEACH_STEP_BODY_MAX = 800;
export const ASSISTANT_TEACH_STEP_DRAWINGS_MAX = 4;
// Same bounds as the chart workstation's saved drawings (Date range in ms, price magnitude).
const TIMESTAMP_MAX = 8_640_000_000_000_000;
const PRICE_MAX = 1_000_000_000_000;

export const AssistantDrawingPointSchema = z
  .object({
    timestamp: z.number().int().min(-TIMESTAMP_MAX).max(TIMESTAMP_MAX),
    value: z.number().min(-PRICE_MAX).max(PRICE_MAX),
  })
  .strict();

export const AssistantDrawingSchema = z
  .object({
    id: z.string().min(1).max(160),
    tool: z.enum(ASSISTANT_DRAWING_TOOLS),
    points: z.array(AssistantDrawingPointSchema).min(1).max(2),
    text: z.string().max(ASSISTANT_DRAWING_TEXT_MAX),
  })
  .strict()
  .refine(
    (drawing) =>
      drawing.points.length === ASSISTANT_DRAWING_POINTS[drawing.tool],
    { message: "Point count does not match the drawing tool", path: ["points"] }
  );

export const AssistantArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chart_drawings"),
      symbol: MarketSymbolSchema,
      replace: z.boolean(),
      drawings: z
        .array(AssistantDrawingSchema)
        .min(1)
        .max(ASSISTANT_ARTIFACT_DRAWINGS_MAX),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chart_clear"),
      symbol: MarketSymbolSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chart_script"),
      title: z.string().min(1).max(ASSISTANT_SCRIPT_TITLE_MAX),
      source: z.string().min(1).max(ASSISTANT_SCRIPT_SOURCE_MAX),
      overlay: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("teach"),
      /** The chart the step drawings belong to; the portal shows them only on that chart. */
      symbol: MarketSymbolSchema.optional(),
      topic: z.string().min(1).max(ASSISTANT_TEACH_TOPIC_MAX),
      steps: z
        .array(
          z
            .object({
              title: z.string().min(1).max(ASSISTANT_TEACH_STEP_TITLE_MAX),
              body: z.string().min(1).max(ASSISTANT_TEACH_STEP_BODY_MAX),
              drawings: z
                .array(AssistantDrawingSchema)
                .max(ASSISTANT_TEACH_STEP_DRAWINGS_MAX)
                .optional(),
            })
            .strict()
        )
        .min(1)
        .max(ASSISTANT_TEACH_STEPS_MAX),
    })
    .strict(),
]);

export const AssistantToolTraceSchema = z
  .object({
    tool: z.string(),
    args: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    /** What a chart tool call handed the browser (display only); absent for every other tool. */
    artifact: AssistantArtifactSchema.optional(),
  })
  .strict();

export const AssistantActionSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    tool: z.string(),
    /** One-line description shown on the confirm card. */
    summary: z.string(),
    /** The validated tool arguments that run on approval. */
    args: z.record(z.string(), z.unknown()),
    status: z.enum(ASSISTANT_ACTION_STATUS_VALUES),
    /** Tool result text after an approved action executed (untrusted data). */
    result: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    finishedAt: z.date().nullable(),
  })
  .strict();

export const AssistantThreadSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const AssistantMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    mode: AssistantModeSchema,
    content: z.string(),
    toolCalls: z.array(AssistantToolTraceSchema),
    model: z.string().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    createdAt: z.date(),
  })
  .strict();

export const AssistantUsageSchema = z
  .object({
    day: z.string(),
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    requestLimit: z.number().int().positive(),
    tokenLimit: z.number().int().positive(),
  })
  .strict();

export const AssistantStatusSchema = z
  .object({
    configured: z.boolean(),
    model: z.string(),
    maxSteps: z.number().int().positive(),
    usage: AssistantUsageSchema,
  })
  .strict();

export const AssistantThreadListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const AssistantThreadListOutputSchema = z
  .object({
    threads: z.array(AssistantThreadSchema),
    status: AssistantStatusSchema,
  })
  .strict();

export const AssistantThreadCreateInputSchema = z
  .object({
    title: z.string().max(200).optional(),
  })
  .strict();

export const AssistantThreadGetInputSchema = z
  .object({ id: IdSchema })
  .strict();
export const AssistantThreadGetOutputSchema = z
  .object({
    thread: AssistantThreadSchema,
    messages: z.array(AssistantMessageSchema),
    actions: z.array(AssistantActionSchema),
  })
  .strict();

// What the chart workstation shows when the message comes from /charts: the symbol, how many bars
// it loaded, the first and last bar times (ms UTC) and the last close. Context only.
export const AssistantPageChartSchema = z
  .object({
    symbol: MarketSymbolSchema,
    bars: z.number().int().min(0).max(1_000_000),
    firstTimestamp: z
      .number()
      .int()
      .min(-TIMESTAMP_MAX)
      .max(TIMESTAMP_MAX)
      .nullable(),
    lastTimestamp: z
      .number()
      .int()
      .min(-TIMESTAMP_MAX)
      .max(TIMESTAMP_MAX)
      .nullable(),
    lastClose: z.number().min(-PRICE_MAX).max(PRICE_MAX).nullable(),
  })
  .strict();

// The portal page the operator sent a message from (the assistant side panel). The server adds
// it to the system prompt as context, never as an instruction.
export const AssistantPageContextSchema = z
  .object({
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9/_.-]*$/u),
    title: z.string().trim().min(1).max(120),
    chart: AssistantPageChartSchema.optional(),
  })
  .strict();

export const AssistantSendInputSchema = z
  .object({
    threadId: IdSchema,
    message: z.string().trim().min(1).max(ASSISTANT_MESSAGE_MAX),
    mode: AssistantModeSchema.default("plan"),
    page: AssistantPageContextSchema.optional(),
    /** Teach mode: step-by-step explanations (a teach_steps walkthrough when it helps). */
    teach: z.boolean().optional(),
  })
  .strict();
export const AssistantSendOutputSchema = z
  .object({
    thread: AssistantThreadSchema,
    userMessage: AssistantMessageSchema,
    reply: AssistantMessageSchema,
    trace: z.array(AssistantToolTraceSchema),
    stopReason: AssistantStopReasonSchema,
    steps: z.number().int().nonnegative(),
    usage: AssistantUsageSchema,
    /** Confirm cards proposed in this turn; none of them has run. */
    actions: z.array(AssistantActionSchema),
  })
  .strict();

// assistant.send streams one turn as events. "started" comes first (the stored user message);
// "text" carries reply text as the model writes it (modelCall numbers each model call, so a
// client starts a new text block when it changes); "step" names the tools one model step asked
// for, before they run; "tool" reports each finished tool call; "done" is last and carries the
// stored reply, exactly the former response body. A failed turn ends the stream with a typed error.
export const AssistantSendEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("started"),
      thread: AssistantThreadSchema,
      userMessage: AssistantMessageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      modelCall: z.number().int().positive(),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("step"),
      step: z.number().int().positive(),
      tools: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      step: z.number().int().positive(),
      call: AssistantToolTraceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      result: AssistantSendOutputSchema,
    })
    .strict(),
]);

export const AssistantActionDecideInputSchema = z
  .object({
    id: IdSchema,
    decision: z.enum(ASSISTANT_ACTION_DECISIONS),
  })
  .strict();

const assistantApi = oc.errors(ASSISTANT_API_ERRORS);
const tags = ["Assistant"];

const threadsList = assistantApi
  .route({
    method: "GET",
    path: "/assistant/threads",
    operationId: "assistant.threads.list",
    summary:
      "List your assistant threads with model status and today's budget use",
    tags,
  })
  .input(AssistantThreadListInputSchema)
  .output(AssistantThreadListOutputSchema);

const threadsCreate = assistantApi
  .route({
    method: "POST",
    path: "/assistant/threads",
    operationId: "assistant.threads.create",
    summary: "Create an assistant thread",
    tags,
  })
  .input(AssistantThreadCreateInputSchema)
  .output(AssistantThreadSchema);

const threadsGet = assistantApi
  .route({
    method: "GET",
    path: "/assistant/threads/{id}",
    operationId: "assistant.threads.get",
    summary: "Read one of your assistant threads with its messages",
    tags,
  })
  .input(AssistantThreadGetInputSchema)
  .output(AssistantThreadGetOutputSchema);

const send = assistantApi
  .route({
    method: "POST",
    path: "/assistant/threads/{threadId}/send",
    operationId: "assistant.send",
    summary:
      "Send a message and stream the turn (reply text, tool steps, then the stored reply); the assistant may call ledger tools (Plan: read only; Act: also record-keeping writes and confirm cards)",
    tags,
  })
  .input(AssistantSendInputSchema)
  .output(eventIterator(AssistantSendEventSchema));

const actionsDecide = assistantApi
  .route({
    method: "POST",
    path: "/assistant/actions/{id}/decision",
    operationId: "assistant.actions.decide",
    summary:
      "Approve (run now) or reject one of your pending assistant confirm cards (research only, no orders)",
    tags,
  })
  .input(AssistantActionDecideInputSchema)
  .output(AssistantActionSchema);

export const assistantContract = {
  threads: { list: threadsList, create: threadsCreate, get: threadsGet },
  send,
  actions: { decide: actionsDecide },
};

export type AssistantModeValue = z.infer<typeof AssistantModeSchema>;
export type AssistantStopReason = z.infer<typeof AssistantStopReasonSchema>;
export type AssistantActionOutput = z.infer<typeof AssistantActionSchema>;
export type AssistantActionDecision =
  (typeof ASSISTANT_ACTION_DECISIONS)[number];
export type AssistantToolTraceOutput = z.infer<typeof AssistantToolTraceSchema>;
export type AssistantThreadOutput = z.infer<typeof AssistantThreadSchema>;
export type AssistantMessageOutput = z.infer<typeof AssistantMessageSchema>;
export type AssistantUsageOutput = z.infer<typeof AssistantUsageSchema>;
export type AssistantStatusOutput = z.infer<typeof AssistantStatusSchema>;
export type AssistantThreadListOutput = z.infer<
  typeof AssistantThreadListOutputSchema
>;
export type AssistantThreadGetOutput = z.infer<
  typeof AssistantThreadGetOutputSchema
>;
export type AssistantSendInput = z.input<typeof AssistantSendInputSchema>;
export type AssistantPageContext = z.infer<typeof AssistantPageContextSchema>;
export type AssistantSendOutput = z.infer<typeof AssistantSendOutputSchema>;
export type AssistantSendEvent = z.infer<typeof AssistantSendEventSchema>;
export type AssistantPageChart = z.infer<typeof AssistantPageChartSchema>;
export type AssistantArtifact = z.infer<typeof AssistantArtifactSchema>;
export type AssistantDrawing = z.infer<typeof AssistantDrawingSchema>;
export type AssistantDrawingTool = (typeof ASSISTANT_DRAWING_TOOLS)[number];
