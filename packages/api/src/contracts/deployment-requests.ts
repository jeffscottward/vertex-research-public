import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";

// Paper deployment requests: operator records only, LOCKED. Session-only (agent API keys are refused,
// so no agent can create, approve or withdraw), and there is no execution transport: nothing reaches a
// Quant VPS execution owner or a broker. Every output carries the literal lock below; an approval
// records a human decision and does not change it. Field, limit, params and lifecycle rules are
// enforced once in the repository so its messages reach the caller as VALIDATION_ERROR.

export const DEPLOYMENT_REQUEST_STATUS_VALUES = [
  "draft",
  "requested",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export const DEPLOYMENT_REQUEST_LIST_MAX = 200;
export const DEPLOYMENT_NOT_DISPATCHED_REASON =
  "Order submission is disabled (VERTEX_ORDER_SUBMISSION=disabled); no execution transport exists." as const;

export const DeploymentRequestStatusSchema = z.enum(
  DEPLOYMENT_REQUEST_STATUS_VALUES
);

const IdSchema = z.string().trim().min(1).max(128);
const ParamValueSchema = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(100),
]);
const ParamsSchema = z
  .record(z.string().max(64), ParamValueSchema)
  .refine((values) => Object.keys(values).length <= 60, {
    message: "At most 60 params",
  });
const NoteSchema = z.string().max(1000);

export const DeploymentDispatchSchema = z
  .object({
    state: z.literal("not-dispatched"),
    reason: z.literal(DEPLOYMENT_NOT_DISPATCHED_REASON),
  })
  .strict();

// The lock every output carries. Literal types: no server value can widen them.
export const DeploymentLockSchema = z
  .object({
    executionAuthorized: z.literal(false),
    brokerSubmissionAllowed: z.literal(false),
    dispatch: DeploymentDispatchSchema,
  })
  .strict();

export const DeploymentLimitsSchema = z
  .object({
    maxOrderSize: z.number().finite().positive(),
    maxPosition: z.number().finite().positive(),
    maxOrdersPerMinute: z.number().int().positive().max(1000),
    dailyLossLimit: z.number().finite().positive(),
  })
  .strict();

// Optional options block (migration 0067). The full rules (legs agree with the structure, budget not
// above max loss, group contains the request symbol) are enforced by the repository normaliser; the
// ceiling is repeated here so no input or output above it has a valid shape.
export const DEPLOYMENT_OPTION_STRUCTURE_VALUES = [
  "callDebitVertical",
  "putDebitVertical",
  "putCreditVertical",
  "callCreditVertical",
] as const;
export const DEPLOYMENT_MAX_LOSS_PCT_CEILING_VALUE = 2;
export const DEPLOYMENT_GROUP_MIN_SYMBOLS_VALUE = 2;
export const DEPLOYMENT_GROUP_MAX_SYMBOLS_VALUE = 16;

const DEPLOYMENT_WIDTH_UNIT_VALUES = ["sigma", "price"] as const;
const DEPLOYMENT_MAX_WIDTH_VALUE = 10_000;

const SymbolInputSchema = z.string().max(64);
// Strike distance between the anchor and the wing, in sigma (the research sleeves' unit) or in price.
const DeploymentOptionWidthSchema = z
  .object({
    unit: z.enum(DEPLOYMENT_WIDTH_UNIT_VALUES),
    value: z.number().finite().positive().max(DEPLOYMENT_MAX_WIDTH_VALUE),
  })
  .strict();
const DeploymentOptionLegSchema = z
  .object({
    role: z.enum(["anchor", "wing"]),
    action: z.enum(["buy", "sell"]),
    right: z.enum(["call", "put"]),
  })
  .strict();
const DeploymentOptionGroupSchema = z
  .object({
    key: z.string().min(1).max(64),
    symbols: z
      .array(SymbolInputSchema)
      .min(DEPLOYMENT_GROUP_MIN_SYMBOLS_VALUE)
      .max(DEPLOYMENT_GROUP_MAX_SYMBOLS_VALUE),
  })
  .strict();
const deploymentOptionFields = {
  structure: z.enum(DEPLOYMENT_OPTION_STRUCTURE_VALUES),
  dte: z
    .object({
      target: z.number().int().min(1).max(730),
      min: z.number().int().min(0).max(730),
    })
    .strict(),
  width: DeploymentOptionWidthSchema,
  anchorDelta: z.number().gt(0).lt(1),
  budgetPctOfAccount: z
    .number()
    .finite()
    .positive()
    .max(DEPLOYMENT_MAX_LOSS_PCT_CEILING_VALUE),
  maxLossPctOfAccount: z
    .number()
    .finite()
    .positive()
    .max(DEPLOYMENT_MAX_LOSS_PCT_CEILING_VALUE),
};

// Stored form: legs always present, group null unless the request belongs to a multi-symbol group.
export const DeploymentOptionsSchema = z
  .object({
    ...deploymentOptionFields,
    legs: z.array(DeploymentOptionLegSchema).length(2),
    group: DeploymentOptionGroupSchema.nullable(),
  })
  .strict();

// Input form: legs may be left out (the server fills them from the structure); when sent they must
// agree with the structure.
export const DeploymentOptionsInputSchema = z
  .object({
    ...deploymentOptionFields,
    legs: z.array(DeploymentOptionLegSchema).length(2).optional(),
    group: DeploymentOptionGroupSchema.nullable().optional(),
  })
  .strict();

// createGroup: the server fills `group` (generated key, the input symbols), so it is not accepted.
export const DeploymentGroupOptionsInputSchema = z
  .object({
    ...deploymentOptionFields,
    legs: z.array(DeploymentOptionLegSchema).length(2).optional(),
  })
  .strict();

export const DeploymentRequestSchema = z
  .object({
    id: z.string().min(1),
    strategyId: z.string().min(1),
    strategySlug: z.string(),
    strategyName: z.string(),
    presetId: z.string().nullable(),
    presetName: z.string().nullable(),
    params: z.record(z.string(), ParamValueSchema),
    symbol: z.string(),
    timeframe: z.string(),
    mode: z.literal("paper"),
    limits: DeploymentLimitsSchema,
    // null (or absent on a record written before 0067): the old format without an options block.
    options: DeploymentOptionsSchema.nullable().optional(),
    status: DeploymentRequestStatusSchema,
    requestedBy: z.string(),
    requestedAt: z.date().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.date().nullable(),
    decisionNote: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    ...DeploymentLockSchema.shape,
  })
  .strict();

export const DeploymentRequestListInputSchema = z
  .object({
    status: DeploymentRequestStatusSchema.optional(),
    strategyId: IdSchema.optional(),
    limit: z.number().int().min(1).max(DEPLOYMENT_REQUEST_LIST_MAX).optional(),
  })
  .strict();
export const DeploymentRequestListOutputSchema = z
  .object({
    requests: z.array(DeploymentRequestSchema),
    ...DeploymentLockSchema.shape,
  })
  .strict();

export const DeploymentRequestIdInputSchema = z
  .object({ id: IdSchema })
  .strict();

export const DeploymentRequestCreateInputSchema = z
  .object({
    strategyId: IdSchema,
    presetId: IdSchema.nullable().optional(),
    params: ParamsSchema.optional(),
    symbol: z.string().max(64),
    timeframe: z.string().max(16),
    // Only paper exists; accepted for explicitness, never anything else.
    mode: z.literal("paper").optional(),
    limits: DeploymentLimitsSchema,
    options: DeploymentOptionsInputSchema.nullable().optional(),
  })
  .strict();

// One draft per symbol, all or nothing. Same fields as create, with `symbols` instead of `symbol`.
export const DeploymentRequestCreateGroupInputSchema = z
  .object({
    strategyId: IdSchema,
    presetId: IdSchema.nullable().optional(),
    params: ParamsSchema.optional(),
    symbols: z
      .array(SymbolInputSchema)
      .min(DEPLOYMENT_GROUP_MIN_SYMBOLS_VALUE)
      .max(DEPLOYMENT_GROUP_MAX_SYMBOLS_VALUE),
    timeframe: z.string().max(16),
    mode: z.literal("paper").optional(),
    limits: DeploymentLimitsSchema,
    options: DeploymentGroupOptionsInputSchema,
  })
  .strict();
export const DeploymentRequestCreateGroupOutputSchema = z
  .object({
    groupKey: z.string().min(1),
    requests: z.array(DeploymentRequestSchema),
    ...DeploymentLockSchema.shape,
  })
  .strict();

export const DeploymentRequestUpdateInputSchema = z
  .object({
    id: IdSchema,
    presetId: IdSchema.nullable().optional(),
    params: ParamsSchema.optional(),
    symbol: z.string().max(64).optional(),
    timeframe: z.string().max(16).optional(),
    limits: DeploymentLimitsSchema.optional(),
    // null removes the options block; leave it out to keep the stored one.
    options: DeploymentOptionsInputSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.presetId,
        input.params,
        input.symbol,
        input.timeframe,
        input.limits,
        input.options,
      ].some((value) => value !== undefined),
    { message: "Change at least one field" }
  );

export const DeploymentRequestApproveInputSchema = z
  .object({
    id: IdSchema,
    // Must equal the strategy slug; the server re-checks it.
    confirmSlug: z.string().max(80),
    note: NoteSchema.optional(),
  })
  .strict();

export const DeploymentRequestRejectInputSchema = z
  .object({ id: IdSchema, note: NoteSchema })
  .strict();

const deploymentRequestsApi = oc.errors(AGENT_OPS_API_ERRORS);
const tags = ["Deployment requests"];

const list = deploymentRequestsApi
  .route({
    method: "GET",
    path: "/deployment-requests",
    operationId: "deploymentRequests.list",
    summary: "List paper deployment requests (records only; never dispatched)",
    tags,
  })
  .input(DeploymentRequestListInputSchema)
  .output(DeploymentRequestListOutputSchema);

const get = deploymentRequestsApi
  .route({
    method: "GET",
    path: "/deployment-requests/{id}",
    operationId: "deploymentRequests.get",
    summary: "Read one paper deployment request",
    tags,
  })
  .input(DeploymentRequestIdInputSchema)
  .output(DeploymentRequestSchema);

const create = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests",
    operationId: "deploymentRequests.create",
    summary:
      "Create a draft paper deployment request; params are checked against the strategy schema",
    tags,
  })
  .input(DeploymentRequestCreateInputSchema)
  .output(DeploymentRequestSchema);

const createGroup = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests/group",
    operationId: "deploymentRequests.createGroup",
    summary:
      "Create one draft paper deployment request per symbol (2 to 16), all or nothing",
    tags,
  })
  .input(DeploymentRequestCreateGroupInputSchema)
  .output(DeploymentRequestCreateGroupOutputSchema);

const update = deploymentRequestsApi
  .route({
    method: "PATCH",
    path: "/deployment-requests/{id}",
    operationId: "deploymentRequests.update",
    summary: "Edit a draft request",
    tags,
  })
  .input(DeploymentRequestUpdateInputSchema)
  .output(DeploymentRequestSchema);

const submit = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests/{id}/submit",
    operationId: "deploymentRequests.submit",
    summary: "Submit a draft for review (draft to requested)",
    tags,
  })
  .input(DeploymentRequestIdInputSchema)
  .output(DeploymentRequestSchema);

const approve = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests/{id}/approve",
    operationId: "deploymentRequests.approve",
    summary:
      "Record approval (requires the strategy slug); does not dispatch anything",
    tags,
  })
  .input(DeploymentRequestApproveInputSchema)
  .output(DeploymentRequestSchema);

const reject = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests/{id}/reject",
    operationId: "deploymentRequests.reject",
    summary: "Record rejection with a note",
    tags,
  })
  .input(DeploymentRequestRejectInputSchema)
  .output(DeploymentRequestSchema);

const withdraw = deploymentRequestsApi
  .route({
    method: "POST",
    path: "/deployment-requests/{id}/withdraw",
    operationId: "deploymentRequests.withdraw",
    summary: "Withdraw a draft, requested or approved request",
    tags,
  })
  .input(DeploymentRequestIdInputSchema)
  .output(DeploymentRequestSchema);

export const deploymentRequestsContract = {
  list,
  get,
  create,
  createGroup,
  update,
  submit,
  approve,
  reject,
  withdraw,
};

export type DeploymentRequestStatusValue = z.infer<
  typeof DeploymentRequestStatusSchema
>;
export type DeploymentLimitsOutput = z.infer<typeof DeploymentLimitsSchema>;
export type DeploymentRequestOutput = z.infer<typeof DeploymentRequestSchema>;
export type DeploymentRequestListInput = z.input<
  typeof DeploymentRequestListInputSchema
>;
export type DeploymentRequestCreateInput = z.input<
  typeof DeploymentRequestCreateInputSchema
>;
export type DeploymentOptionsOutput = z.infer<typeof DeploymentOptionsSchema>;
export type DeploymentOptionsInput = z.input<
  typeof DeploymentOptionsInputSchema
>;
export type DeploymentRequestCreateGroupInput = z.input<
  typeof DeploymentRequestCreateGroupInputSchema
>;
export type DeploymentRequestCreateGroupOutput = z.infer<
  typeof DeploymentRequestCreateGroupOutputSchema
>;
export type DeploymentRequestUpdateInput = z.input<
  typeof DeploymentRequestUpdateInputSchema
>;
export type DeploymentRequestApproveInput = z.input<
  typeof DeploymentRequestApproveInputSchema
>;
export type DeploymentRequestRejectInput = z.input<
  typeof DeploymentRequestRejectInputSchema
>;
