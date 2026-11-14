import { oc } from "@orpc/contract";
import { z } from "zod";

// Owner order screen (Portfolio > Orders). Options only, limit orders only, one order at a time.
// Every submit and every cancel needs a server-issued confirm token from a preview call, so the
// browser must show the review screen first. While VERTEX_ORDERS_ENABLED is not "true" every
// call uses the in-memory mock gateway and nothing reaches IBKR.

export const VERTEX_ORDERS_ERRORS = {
  AUDIT_UNAVAILABLE: {
    message: "Order audit record could not be written; nothing was sent",
    status: 503,
  },
  CONFIRM_INVALID: {
    message: "Confirmation is missing, expired or does not match the order",
    status: 409,
  },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_CONFIGURED: {
    message: "Order gateway not configured",
    status: 503,
  },
  NOT_FOUND: { message: "Order not found", status: 404 },
  ORDER_REJECTED: { message: "Order rejected by the order rules", status: 422 },
  RATE_LIMITED: { message: "Too many order requests", status: 429 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UPSTREAM_ERROR: { message: "Order gateway request failed", status: 502 },
} as const;

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/, "Symbol must be 1-10 letters");

export const VertexOrderInputSchema = z
  .object({
    expiry: z.string().regex(/^(\d{8})?$/, "Expiry must be YYYYMMDD"),
    limitPrice: z.number().finite().positive().max(100_000),
    orderType: z.string().trim().toUpperCase().max(8),
    quantity: z.number().int().positive().max(10_000),
    right: z.enum(["C", "P", ""]),
    // OPT (options) or STK (shares). Shares may only be closed or reduced (rules); for shares,
    // expiry is "", strike 0 and right "".
    secType: z.string().trim().toUpperCase().max(8),
    side: z.enum(["BUY", "SELL"]),
    strike: z.number().finite().min(0).max(100_000),
    symbol,
  })
  .strict();
export type VertexOrderInput = z.infer<typeof VertexOrderInputSchema>;

export const VertexOrderCapSchema = z.object({
  afterOrder: z.number(),
  afterOrderPct: z.number(),
  kind: z.enum(["leaps", "short-dated", "none"]),
  label: z.string(),
  limitAmount: z.number(),
  limitPct: z.number(),
  openPremium: z.number(),
});

// Final JEV order gate (merge plan P6). Runs on every order review, simulated and live.
export const VertexFinalGateSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  jevStance: z.enum(["BULLISH", "NEUTRAL", "BEARISH"]).nullable(),
  jevState: z.enum(["fresh", "stale", "none", "unreachable"]),
  maxLoss: z.number().nullable(),
  maxLossPct: z.number().nullable(),
  reasons: z.array(z.string()),
  structure: z.enum([
    "long-option",
    "debit-vertical",
    "credit-vertical",
    "risk-reducing",
    "rejected",
  ]),
});
export type VertexFinalGate = z.infer<typeof VertexFinalGateSchema>;

export const VertexOrderReviewSchema = z.object({
  accepted: z.boolean(),
  cap: VertexOrderCapSchema,
  contractLabel: z.string(),
  daysToExpiry: z.number().int(),
  finalGate: VertexFinalGateSchema.nullable().optional(),
  heldContracts: z.number(),
  netLiquidation: z.number().nullable(),
  order: VertexOrderInputSchema,
  premium: z.number(),
  premiumPctNlv: z.number().nullable(),
  reasons: z.array(z.string()),
});
export type VertexOrderReview = z.infer<typeof VertexOrderReviewSchema>;

export const VertexOrderGatesSchema = z.object({
  killSwitch: z.boolean(),
  mode: z.enum(["simulated", "live"]),
  optionsOnly: z.boolean(),
  ordersEnabled: z.boolean(),
});

export const VertexOpenOrderSchema = z.object({
  cancellable: z.boolean(),
  expiry: z.string().nullable(),
  limitPrice: z.number().nullable(),
  orderRef: z.string(),
  orderType: z.string(),
  permId: z.number().int(),
  quantity: z.number(),
  right: z.string().nullable(),
  secType: z.string(),
  side: z.string(),
  status: z.string(),
  strike: z.number().nullable(),
  symbol: z.string(),
});
export type VertexOpenOrder = z.infer<typeof VertexOpenOrderSchema>;

export const VertexOrdersStatusSchema = z.object({
  gates: VertexOrderGatesSchema,
  netLiquidation: z.number().nullable(),
  openOrders: z.array(VertexOpenOrderSchema),
});
export type VertexOrdersStatus = z.infer<typeof VertexOrdersStatusSchema>;

const confirmToken = z.string().min(16).max(4096);

export const VertexOrderPreviewOutputSchema = z.object({
  confirmToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
  gates: VertexOrderGatesSchema,
  review: VertexOrderReviewSchema,
});

export type VertexOrderPreviewOutput = z.infer<
  typeof VertexOrderPreviewOutputSchema
>;

export const VertexOrderSubmitInputSchema = z
  .object({
    confirm: z.literal(true),
    confirmToken,
    order: VertexOrderInputSchema,
  })
  .strict();

export const VertexOrderResultSchema = z.object({
  message: z.string(),
  mode: z.enum(["simulated", "live"]),
  orderRef: z.string(),
  permId: z.number().int().nullable(),
  state: z.string(),
});
export type VertexOrderResult = z.infer<typeof VertexOrderResultSchema>;

export const VertexCancelPreviewInputSchema = z
  .object({ permId: z.number().int().positive() })
  .strict();

export const VertexCancelPreviewOutputSchema = z.object({
  confirmToken: z.string(),
  expiresAt: z.string(),
  gates: VertexOrderGatesSchema,
  order: VertexOpenOrderSchema,
});

export type VertexCancelPreviewOutput = z.infer<
  typeof VertexCancelPreviewOutputSchema
>;

export const VertexCancelSubmitInputSchema = z
  .object({
    confirm: z.literal(true),
    confirmToken,
    permId: z.number().int().positive(),
  })
  .strict();

// Spread close (owner 2026-11-04): a spread closes as ONE combo (BAG) order, never leg by leg.
// Opening verticals (P6) are accepted only through the final gate.
// Each leg must reverse a held leg exactly (ratio x quantity == held size). limitPrice is the net
// per combo: positive = debit paid, negative = credit received.
export const VertexComboLegSchema = z
  .object({
    expiry: z.string().regex(/^\d{8}$/, "Expiry must be YYYYMMDD"),
    ratio: z.number().int().min(1).max(10),
    right: z.enum(["C", "P"]),
    side: z.enum(["BUY", "SELL"]),
    strike: z.number().finite().positive().max(100_000),
  })
  .strict();
export type VertexComboLeg = z.infer<typeof VertexComboLegSchema>;

export const VertexComboInputSchema = z
  .object({
    legs: z.array(VertexComboLegSchema).min(2).max(6),
    limitPrice: z
      .number()
      .finite()
      .min(-100_000)
      .max(100_000)
      .refine((value) => value !== 0, "Net limit must not be zero"),
    quantity: z.number().int().positive().max(10_000),
    symbol,
  })
  .strict();
export type VertexComboInput = z.infer<typeof VertexComboInputSchema>;

export const VertexComboReviewSchema = z.object({
  accepted: z.boolean(),
  finalGate: VertexFinalGateSchema.nullable().optional(),
  label: z.string(),
  // limitPrice x quantity x 100: positive = debit paid, negative = credit received.
  netAmount: z.number(),
  order: VertexComboInputSchema,
  reasons: z.array(z.string()),
});
export type VertexComboReview = z.infer<typeof VertexComboReviewSchema>;

export const VertexComboPreviewOutputSchema = z.object({
  confirmToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
  gates: VertexOrderGatesSchema,
  review: VertexComboReviewSchema,
});
export type VertexComboPreviewOutput = z.infer<
  typeof VertexComboPreviewOutputSchema
>;

// A go-live draft id binds the order to the owner's approval of that draft (GO-LIVE 4): the
// server then also requires the exact approved order, the node armed and the plan caps at send.
const goLiveDraftId = z.string().min(1).max(80).optional();

export const VertexComboPreviewInputSchema = VertexComboInputSchema.extend({
  goLiveDraftId,
}).strict();

export const VertexComboSubmitInputSchema = z
  .object({
    confirm: z.literal(true),
    confirmToken,
    goLiveDraftId,
    order: VertexComboInputSchema,
  })
  .strict();

const orders = oc.errors(VERTEX_ORDERS_ERRORS);
const tags = ["Orders"];

const status = orders
  .route({
    method: "GET",
    operationId: "vertexOrders.status",
    path: "/vertex-orders/status",
    summary: "Order gates, net liquidation and open orders",
    tags,
  })
  .input(z.object({}).strict())
  .output(VertexOrdersStatusSchema);

const preview = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.preview",
    path: "/vertex-orders/preview",
    summary:
      "Check one option order against the rules and issue a confirm token",
    tags,
  })
  .input(VertexOrderInputSchema)
  .output(VertexOrderPreviewOutputSchema);

const submit = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.submit",
    path: "/vertex-orders/submit",
    summary: "Send one previewed and confirmed option order",
    tags,
  })
  .input(VertexOrderSubmitInputSchema)
  .output(VertexOrderResultSchema);

const cancelPreview = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.cancelPreview",
    path: "/vertex-orders/cancel-preview",
    summary: "Review one open order before cancel and issue a confirm token",
    tags,
  })
  .input(VertexCancelPreviewInputSchema)
  .output(VertexCancelPreviewOutputSchema);

const cancelSubmit = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.cancel",
    path: "/vertex-orders/cancel",
    summary: "Cancel one previewed and confirmed open order",
    tags,
  })
  .input(VertexCancelSubmitInputSchema)
  .output(VertexOrderResultSchema);

const comboPreview = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.comboPreview",
    path: "/vertex-orders/combo-preview",
    summary:
      "Check one spread close (one combo order) against the rules and issue a confirm token",
    tags,
  })
  .input(VertexComboPreviewInputSchema)
  .output(VertexComboPreviewOutputSchema);

const comboSubmit = orders
  .route({
    method: "POST",
    operationId: "vertexOrders.comboSubmit",
    path: "/vertex-orders/combo-submit",
    summary: "Send one previewed and confirmed spread close as one combo order",
    tags,
  })
  .input(VertexComboSubmitInputSchema)
  .output(VertexOrderResultSchema);

export const vertexOrdersContract = {
  cancelPreview,
  cancelSubmit,
  comboPreview,
  comboSubmit,
  preview,
  status,
  submit,
};
