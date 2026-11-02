import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  PORTFOLIO_MONITOR_ERRORS,
  PORTFOLIO_MONITOR_MAX_ROWS,
  PortfolioMonitorInputSchema,
  PortfolioMonitorOutputSchema,
} from "./portfolio-monitor.ts";

// Read-only "Portfolio" tab. Source: the running ibkr-monitor server (IB client id 195) on the
// Vertex host's loopback (IBKR_MONITOR_URL). The Vertex server proxies only an allow-list of GET
// endpoints and maps the result to the same browser view as portfolioMonitor.snapshot.
// Nothing here can place, change or cancel an order, and the 2FA/gateway action is not reachable.

export const IBKR_MONITOR_ERRORS = {
  ...PORTFOLIO_MONITOR_ERRORS,
  UNAVAILABLE: { status: 503, message: "ibkr-monitor service unavailable" },
  NOT_CONFIGURED: {
    status: 503,
    message: "ibkr-monitor endpoint not configured",
  },
} as const;

const ibkrMonitor = oc.errors(IBKR_MONITOR_ERRORS);

const snapshot = ibkrMonitor
  .route({
    method: "GET",
    path: "/ibkr-monitor/snapshot",
    operationId: "ibkrMonitor.snapshot",
    summary:
      "Read-only IBKR account, positions, orders and executions from the ibkr-monitor service",
    tags: ["Portfolio monitor"],
  })
  .input(PortfolioMonitorInputSchema)
  .output(PortfolioMonitorOutputSchema);

// Round-handle check of open orders (ibkr-monitor GET /api/volatility, orderCheck only).
// Text flags only: a stop or limit price at a .00/.50 handle and a suggested offset price.
// Nothing here changes an order.
export const RoundHandleFlagSchema = z
  .object({
    key: z.string().max(80),
    kind: z.enum(["stop", "limit"]),
    price: z.number().finite(),
    handle: z.string().max(80),
    side: z.enum(["below", "above"]),
    offset: z.number().finite(),
    suggested: z.number().finite(),
  })
  .strict();
export type RoundHandleFlag = z.infer<typeof RoundHandleFlagSchema>;

export const RoundHandleCheckOutputSchema = z
  .object({
    checked: z.number().int().nonnegative(),
    skippedTrailing: z.number().int().nonnegative(),
    flags: z.array(RoundHandleFlagSchema).max(PORTFOLIO_MONITOR_MAX_ROWS * 2),
  })
  .strict();
export type RoundHandleCheckOutput = z.infer<
  typeof RoundHandleCheckOutputSchema
>;

const roundHandles = ibkrMonitor
  .route({
    method: "GET",
    path: "/ibkr-monitor/round-handles",
    operationId: "ibkrMonitor.roundHandles",
    summary:
      "Read-only round-number (.00/.50) flags on open stop and limit order prices",
    tags: ["Portfolio monitor"],
  })
  .input(PortfolioMonitorInputSchema)
  .output(RoundHandleCheckOutputSchema);

// Market context (audit phase 5): public volatility series read by ibkr-monitor (Cboe VIX, VIXEQ,
// VVIX, their spread) and the S&P 500 implied-vs-actual move. No account data.
export const VolatilitySeriesSchema = z
  .object({
    value: z.number().finite(),
    asOf: z.string().max(40),
    change1d: z.number().finite().nullable(),
    pct1y: z.number().finite().nullable(),
    stale: z.boolean(),
  })
  .strict();
export type VolatilitySeries = z.infer<typeof VolatilitySeriesSchema>;

export const MarketVolatilityOutputSchema = z
  .object({
    vix: VolatilitySeriesSchema.nullable(),
    vixeq: VolatilitySeriesSchema.nullable(),
    vvix: VolatilitySeriesSchema.nullable(),
    spread: VolatilitySeriesSchema.nullable(),
    spx: z
      .object({
        price: z.number().finite(),
        movePct: z.number().finite().nullable(),
        sessionOpen: z.boolean(),
      })
      .strict()
      .nullable(),
    implied: z
      .object({
        impliedPct: z.number().finite().nullable(),
        multiple: z.number().finite().nullable(),
        band: z.enum(["normal", "notable", "review"]).nullable(),
      })
      .strict()
      .nullable(),
    sourceErrors: z.array(z.string().max(200)).max(4),
  })
  .strict();
export type MarketVolatilityOutput = z.infer<
  typeof MarketVolatilityOutputSchema
>;

const volatility = ibkrMonitor
  .route({
    method: "GET",
    path: "/ibkr-monitor/volatility",
    operationId: "ibkrMonitor.volatility",
    summary:
      "Read-only market volatility context (VIX, VIXEQ, VVIX, S&P 500 implied move)",
    tags: ["Portfolio monitor"],
  })
  .input(PortfolioMonitorInputSchema)
  .output(MarketVolatilityOutputSchema);

export const ibkrMonitorContract = { snapshot, roundHandles, volatility };
