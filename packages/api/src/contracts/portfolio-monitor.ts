import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only IBKR portfolio monitor (Mission control "Monitor" view).
// Source: the QuantVPS tailnet service vertex-portfolio (vertex-portfolio-snapshot-v1, IB client id 78).
// The server derives this view from the upstream snapshot. Account ids never appear in it.
// Nothing here can place, change or cancel an order.

export const PORTFOLIO_MONITOR_MAX_ROWS = 500;
export const PORTFOLIO_MONITOR_MAX_MESSAGES = 20;
export const PORTFOLIO_ACCOUNT_MODES = ["live", "paper", "unknown"] as const;
export const PORTFOLIO_GATEWAY_STATES = [
  "starting",
  "live",
  "disconnected",
] as const;

const money = z.number().finite().nullable();
const shortText = (max: number) => z.string().max(max);
const isoTime = z.string().max(40);

export const PortfolioMonitorInputSchema = z.object({}).strict();

export const PortfolioMonitorStatusSchema = z
  .object({
    // Gateway connection state reported by the VPS service.
    gateway: z.enum(PORTFOLIO_GATEWAY_STATES),
    connected: z.boolean(),
    // Last IBKR callback seen by the service, and the last full open-order refresh.
    dataAsOf: isoTime.nullable(),
    ordersAsOf: isoTime.nullable(),
    // Service clock when it built the snapshot, and when this server received it.
    generatedAt: isoTime,
    receivedAt: isoTime,
    lastError: shortText(300).nullable(),
    // IB API client id of the reader: 78 (vertex-portfolio) or 195 (ibkr-monitor, Portfolio tab).
    clientId: z.number().int().nonnegative(),
  })
  .strict();

export const PortfolioMonitorAccountSchema = z
  .object({
    // Derived on the VPS from the managed account code prefix (DU/DF = paper). The code itself is removed.
    mode: z.enum(PORTFOLIO_ACCOUNT_MODES),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const PortfolioMonitorSummarySchema = z
  .object({
    netLiquidation: money,
    totalCashValue: money,
    settledCash: money,
    buyingPower: money,
    availableFunds: money,
    excessLiquidity: money,
    initMarginReq: money,
    maintMarginReq: money,
    grossPositionValue: money,
    equityWithLoanValue: money,
    cushion: money,
    leverage: money,
    lookAheadExcessLiquidity: money,
  })
  .strict();

export const PortfolioMonitorPnlSchema = z
  .object({
    daily: money,
    unrealized: money,
    realized: money,
  })
  .strict();

export const PortfolioMonitorPositionSchema = z
  .object({
    id: shortText(24),
    symbol: shortText(24),
    secType: shortText(12),
    currency: shortText(8),
    description: shortText(80),
    position: z.number().finite(),
    avgPrice: money,
    last: money,
    marketValue: money,
    costBasis: money,
    dailyPnl: money,
    unrealized: money,
    unrealizedPct: money,
    realized: money,
    weightPct: money,
    // Option contract fields from IBKR (OPT rows only), so an order can name the contract exactly
    // even when the description text has another form (owner 2026-11-04: every row can be closed).
    option: z
      .object({
        expiry: shortText(16),
        strike: z.number().finite(),
        right: shortText(8),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PortfolioMonitorOrderSchema = z
  .object({
    key: shortText(80),
    permId: z.number().int(),
    clientId: z.number().int(),
    orderId: z.number().int(),
    parentKey: shortText(80).nullable(),
    ocaGroup: shortText(80),
    orderRef: shortText(80),
    conId: shortText(24),
    symbol: shortText(24),
    secType: shortText(12),
    action: shortText(8),
    orderType: shortText(24),
    qty: money,
    filledQty: money,
    remaining: money,
    avgFill: money,
    limitPrice: money,
    stopPrice: money,
    trailPct: money,
    tif: shortText(12),
    outsideRth: z.boolean(),
    status: shortText(40),
    completedTime: shortText(40),
    completedStatus: shortText(200),
  })
  .strict();

export const PortfolioMonitorExecutionSchema = z
  .object({
    execId: shortText(80),
    time: shortText(40),
    symbol: shortText(24),
    secType: shortText(12),
    side: shortText(8),
    shares: money,
    price: money,
    avgPrice: money,
    commission: money,
    realized: money,
    exchange: shortText(24),
    orderRef: shortText(80),
  })
  .strict();

export const PortfolioMonitorMessageSchema = z
  .object({
    at: isoTime,
    code: z.number().int(),
    message: shortText(200),
  })
  .strict();

export const PortfolioMonitorOutputSchema = z
  .object({
    source: z.literal("ibkr-gateway"),
    readOnly: z.literal(true),
    status: PortfolioMonitorStatusSchema,
    account: PortfolioMonitorAccountSchema,
    summary: PortfolioMonitorSummarySchema,
    pnl: PortfolioMonitorPnlSchema,
    positions: z
      .array(PortfolioMonitorPositionSchema)
      .max(PORTFOLIO_MONITOR_MAX_ROWS),
    orders: z
      .array(PortfolioMonitorOrderSchema)
      .max(PORTFOLIO_MONITOR_MAX_ROWS),
    completed: z
      .array(PortfolioMonitorOrderSchema)
      .max(PORTFOLIO_MONITOR_MAX_ROWS),
    executions: z
      .array(PortfolioMonitorExecutionSchema)
      .max(PORTFOLIO_MONITOR_MAX_ROWS),
    messages: z
      .array(PortfolioMonitorMessageSchema)
      .max(PORTFOLIO_MONITOR_MAX_MESSAGES),
  })
  .strict();

export const PORTFOLIO_MONITOR_ERRORS = {
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  UPSTREAM_ERROR: { status: 502, message: "Portfolio snapshot request failed" },
  UNAVAILABLE: { status: 503, message: "IBKR portfolio service unavailable" },
  NOT_CONFIGURED: {
    status: 503,
    message: "Portfolio monitor endpoint not configured",
  },
} as const;

const portfolioMonitor = oc.errors(PORTFOLIO_MONITOR_ERRORS);

const snapshot = portfolioMonitor
  .route({
    method: "GET",
    path: "/portfolio-monitor/snapshot",
    operationId: "portfolioMonitor.snapshot",
    summary:
      "Read-only IBKR account summary, positions, orders and executions from the QuantVPS portfolio service",
    tags: ["Portfolio monitor"],
  })
  .input(PortfolioMonitorInputSchema)
  .output(PortfolioMonitorOutputSchema);

export const portfolioMonitorContract = { snapshot };

export type PortfolioAccountMode = (typeof PORTFOLIO_ACCOUNT_MODES)[number];
export type PortfolioGatewayState = (typeof PORTFOLIO_GATEWAY_STATES)[number];
export type PortfolioMonitorOutput = z.infer<
  typeof PortfolioMonitorOutputSchema
>;
export type PortfolioMonitorStatus = z.infer<
  typeof PortfolioMonitorStatusSchema
>;
export type PortfolioMonitorSummary = z.infer<
  typeof PortfolioMonitorSummarySchema
>;
export type PortfolioMonitorPnl = z.infer<typeof PortfolioMonitorPnlSchema>;
export type PortfolioMonitorPosition = z.infer<
  typeof PortfolioMonitorPositionSchema
>;
export type PortfolioMonitorOrder = z.infer<typeof PortfolioMonitorOrderSchema>;
export type PortfolioMonitorExecution = z.infer<
  typeof PortfolioMonitorExecutionSchema
>;
export type PortfolioMonitorMessage = z.infer<
  typeof PortfolioMonitorMessageSchema
>;
