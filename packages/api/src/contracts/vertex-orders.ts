import { oc } from "@orpc/contract";
import { z } from "zod";

// Owner order screen (Portfolio > Orders). Options only, limit orders only, one order at a time.
// Every submit and every cancel needs a server-issued confirm token from a preview call, so the
// browser must show the review screen first. While VERTEX_ORDERS_ENABLED is not "true" every
// call uses the in-memory mock gateway and nothing reaches IBKR.

export const VERTEX_ORDERS_ERRORS = {
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Order not found" },
  CONFIRM_INVALID: {
    status: 409,
    message: "Confirmation is missing, expired or does not match the order",
  },
  ORDER_REJECTED: { status: 422, message: "Order rejected by the order rules" },
  RATE_LIMITED: { status: 429, message: "Too many order requests" },
  UPSTREAM_ERROR: { status: 502, message: "Order gateway request failed" },
  NOT_CONFIGURED: {
    status: 503,
    message: "Order gateway not configured",
  },
  AUDIT_UNAVAILABLE: {
    status: 503,
    message: "Order audit record could not be written; nothing was sent",
  },
} as const;

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/, "Symbol must be 1-10 letters");

export const VertexOrderInputSchema = z
  .object({
    symbol,
    // OPT (options) or STK (shares). Shares may only be closed or reduced (rules); for shares,
    // expiry is "", strike 0 and right "".
    secType: z.string().trim().toUpperCase().max(8),
    expiry: z.string().regex(/^(\d{8})?$/, "Expiry must be YYYYMMDD"),
    strike: z.number().finite().min(0).max(100_000),
    right: z.enum(["C", "P", ""]),
    side: z.enum(["BUY", "SELL"]),
    quantity: z.number().int().positive().max(10_000),
    orderType: z.string().trim().toUpperCase().max(8),
    limitPrice: z.number().finite().positive().max(100_000),
  })
  .strict();
export type VertexOrderInput = z.infer<typeof VertexOrderInputSchema>;

export const VertexOrderCapSchema = z.object({
  kind: z.enum(["leaps", "short-dated", "none"]),
  label: z.string(),
  limitPct: z.number(),
  limitAmount: z.number(),
  openPremium: z.number(),
  afterOrder: z.number(),
  afterOrderPct: z.number(),
});

export const VertexOrderReviewSchema = z.object({
  order: VertexOrderInputSchema,
  contractLabel: z.string(),
  daysToExpiry: z.number().int(),
  premium: z.number(),
  premiumPctNlv: z.number().nullable(),
  netLiquidation: z.number().nullable(),
  heldContracts: z.number(),
  cap: VertexOrderCapSchema,
  accepted: z.boolean(),
  reasons: z.array(z.string()),
});
export type VertexOrderReview = z.infer<typeof VertexOrderReviewSchema>;

export const VertexOrderGatesSchema = z.object({
  ordersEnabled: z.boolean(),
  mode: z.enum(["simulated", "live"]),
  killSwitch: z.boolean(),
  optionsOnly: z.boolean(),
});

export const VertexOpenOrderSchema = z.object({
  permId: z.number().int(),
  symbol: z.string(),
  secType: z.string(),
  expiry: z.string().nullable(),
  strike: z.number().nullable(),
  right: z.string().nullable(),
  side: z.string(),
  quantity: z.number(),
  orderType: z.string(),
  limitPrice: z.number().nullable(),
  status: z.string(),
  orderRef: z.string(),
  cancellable: z.boolean(),
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
  gates: VertexOrderGatesSchema,
  review: VertexOrderReviewSchema,
  confirmToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export type VertexOrderPreviewOutput = z.infer<
  typeof VertexOrderPreviewOutputSchema
>;

export const VertexOrderSubmitInputSchema = z
  .object({
    order: VertexOrderInputSchema,
    confirmToken,
    confirm: z.literal(true),
  })
  .strict();

export const VertexOrderResultSchema = z.object({
  mode: z.enum(["simulated", "live"]),
  state: z.string(),
  orderRef: z.string(),
  permId: z.number().int().nullable(),
  message: z.string(),
});
export type VertexOrderResult = z.infer<typeof VertexOrderResultSchema>;

export const VertexCancelPreviewInputSchema = z
  .object({ permId: z.number().int().positive() })
  .strict();

export const VertexCancelPreviewOutputSchema = z.object({
  gates: VertexOrderGatesSchema,
  order: VertexOpenOrderSchema,
  confirmToken: z.string(),
  expiresAt: z.string(),
});

export type VertexCancelPreviewOutput = z.infer<
  typeof VertexCancelPreviewOutputSchema
>;

export const VertexCancelSubmitInputSchema = z
  .object({
    permId: z.number().int().positive(),
    confirmToken,
    confirm: z.literal(true),
  })
  .strict();

// Spread close (owner 2026-11-04): a spread closes as ONE combo (BAG) order, never leg by leg.
// Each leg must reverse a held leg exactly (ratio x quantity == held size). limitPrice is the net
// per combo: positive = debit paid, negative = credit received.
export const VertexComboLegSchema = z
  .object({
    expiry: z.string().regex(/^\d{8}$/, "Expiry must be YYYYMMDD"),
    strike: z.number().finite().positive().max(100_000),
    right: z.enum(["C", "P"]),
    side: z.enum(["BUY", "SELL"]),
    ratio: z.number().int().min(1).max(10),
  })
  .strict();
export type VertexComboLeg = z.infer<typeof VertexComboLegSchema>;

export const VertexComboInputSchema = z
  .object({
    symbol,
    quantity: z.number().int().positive().max(10_000),
    limitPrice: z
      .number()
      .finite()
      .min(-100_000)
      .max(100_000)
      .refine((value) => value !== 0, "Net limit must not be zero"),
    legs: z.array(VertexComboLegSchema).min(2).max(6),
  })
  .strict();
export type VertexComboInput = z.infer<typeof VertexComboInputSchema>;

export const VertexComboReviewSchema = z.object({
  order: VertexComboInputSchema,
  label: z.string(),
  // limitPrice x quantity x 100: positive = debit paid, negative = credit received.
  netAmount: z.number(),
  accepted: z.boolean(),
  reasons: z.array(z.string()),
});
export type VertexComboReview = z.infer<typeof VertexComboReviewSchema>;

export const VertexComboPreviewOutputSchema = z.object({
  gates: VertexOrderGatesSchema,
  review: VertexComboReviewSchema,
  confirmToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type VertexComboPreviewOutput = z.infer<
  typeof VertexComboPreviewOutputSchema
>;

export const VertexComboSubmitInputSchema = z
  .object({
    order: VertexComboInputSchema,
    confirmToken,
    confirm: z.literal(true),
  })
  .strict();

const orders = oc.errors(VERTEX_ORDERS_ERRORS);
const tags = ["Orders"];

const status = orders
  .route({
    method: "GET",
    path: "/vertex-orders/status",
    operationId: "vertexOrders.status",
    summary: "Order gates, net liquidation and open orders",
    tags,
  })
  .input(z.object({}).strict())
  .output(VertexOrdersStatusSchema);

const preview = orders
  .route({
    method: "POST",
    path: "/vertex-orders/preview",
    operationId: "vertexOrders.preview",
    summary:
      "Check one option order against the rules and issue a confirm token",
    tags,
  })
  .input(VertexOrderInputSchema)
  .output(VertexOrderPreviewOutputSchema);

const submit = orders
  .route({
    method: "POST",
    path: "/vertex-orders/submit",
    operationId: "vertexOrders.submit",
    summary: "Send one previewed and confirmed option order",
    tags,
  })
  .input(VertexOrderSubmitInputSchema)
  .output(VertexOrderResultSchema);

const cancelPreview = orders
  .route({
    method: "POST",
    path: "/vertex-orders/cancel-preview",
    operationId: "vertexOrders.cancelPreview",
    summary: "Review one open order before cancel and issue a confirm token",
    tags,
  })
  .input(VertexCancelPreviewInputSchema)
  .output(VertexCancelPreviewOutputSchema);

const cancelSubmit = orders
  .route({
    method: "POST",
    path: "/vertex-orders/cancel",
    operationId: "vertexOrders.cancel",
    summary: "Cancel one previewed and confirmed open order",
    tags,
  })
  .input(VertexCancelSubmitInputSchema)
  .output(VertexOrderResultSchema);

const comboPreview = orders
  .route({
    method: "POST",
    path: "/vertex-orders/combo-preview",
    operationId: "vertexOrders.comboPreview",
    summary:
      "Check one spread close (one combo order) against the rules and issue a confirm token",
    tags,
  })
  .input(VertexComboInputSchema)
  .output(VertexComboPreviewOutputSchema);

const comboSubmit = orders
  .route({
    method: "POST",
    path: "/vertex-orders/combo-submit",
    operationId: "vertexOrders.comboSubmit",
    summary: "Send one previewed and confirmed spread close as one combo order",
    tags,
  })
  .input(VertexComboSubmitInputSchema)
  .output(VertexOrderResultSchema);

export const vertexOrdersContract = {
  status,
  preview,
  submit,
  comboPreview,
  comboSubmit,
  cancelPreview,
  cancelSubmit,
};
