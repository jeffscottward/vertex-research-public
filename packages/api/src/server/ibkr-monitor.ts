import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  PORTFOLIO_MONITOR_MAX_MESSAGES,
  PORTFOLIO_MONITOR_MAX_ROWS,
  type PortfolioGatewayState,
  type PortfolioMonitorExecution,
  type PortfolioMonitorOrder,
  type PortfolioMonitorOutput,
  PortfolioMonitorOutputSchema,
  type PortfolioMonitorPosition,
} from "../contracts/portfolio-monitor.ts";
import {
  type MarketVolatilityOutput,
  MarketVolatilityOutputSchema,
  type RoundHandleCheckOutput,
  RoundHandleCheckOutputSchema,
} from "../contracts/ibkr-monitor.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { readCappedText, scrubPortfolioText } from "./portfolio-monitor.ts";

// Read-only proxy to the running ibkr-monitor server (IB client 195) on the Vertex host's loopback.
// ibkr-monitor stays the single IBKR reader: this module never opens an IB connection.
// Only the GET endpoints in IBKR_MONITOR_ALLOWED_PATHS can be requested. The 2FA/gateway-restart
// endpoint (/api/ibkr-2fa) and every POST are refused before any network call.

const IBKR_MONITOR_CLIENT_ID = 195;
const IBKR_MONITOR_TIMEOUT_MS = 10_000;
const IBKR_MONITOR_MAX_BYTES = 4 * 1024 * 1024;
export const IBKR_MONITOR_ALLOWED_PATHS = Object.freeze([
  "/api/snapshot",
  "/api/health",
  "/api/volatility",
] as const);
type IbkrMonitorPath = (typeof IBKR_MONITOR_ALLOWED_PATHS)[number];

type IbkrMonitorErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE" | "UPSTREAM_ERROR";

export class IbkrMonitorError extends Error {
  code: IbkrMonitorErrorCode;
  constructor(code: IbkrMonitorErrorCode, message: string) {
    super(message);
    this.name = "IbkrMonitorError";
    this.code = code;
  }
}

type FetchIbkrMonitorOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Returns the full URL for an allow-listed GET path on a loopback http base. Throws otherwise.
export const buildIbkrMonitorUrl = (base: string, path: string): string => {
  if (!(IBKR_MONITOR_ALLOWED_PATHS as readonly string[]).includes(path))
    throw new IbkrMonitorError(
      "UPSTREAM_ERROR",
      "ibkr-monitor path is not on the read-only allow-list"
    );
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new IbkrMonitorError(
      "NOT_CONFIGURED",
      "ibkr-monitor endpoint is not a valid URL (IBKR_MONITOR_URL)"
    );
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new IbkrMonitorError(
      "NOT_CONFIGURED",
      "ibkr-monitor endpoint must be a plain loopback http URL (IBKR_MONITOR_URL)"
    );
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${path}`;
};

const num = z.number().finite().nullable().optional();
const str = z.string().max(400);
const ms = z.number().finite().nonnegative();

const UpstreamPositionSchema = z.object({
  id: z.union([z.string().max(40), z.number()]),
  symbol: str,
  secType: str,
  currency: str.optional().default(""),
  desc: str.optional().default(""),
  position: z.number().finite(),
  avgPrice: num,
  last: num,
  marketValue: num,
  costBasis: num,
  dailyPnl: num,
  unrealized: num,
  unrealizedPct: num,
  realized: num,
  weightPct: num,
});

const UpstreamOrderSchema = z.object({
  key: str,
  permId: z.number().int(),
  clientId: z.number().int(),
  orderId: z.number().int(),
  parentKey: str.nullable().optional(),
  ocaGroup: str.optional().default(""),
  orderRef: str.optional().default(""),
  conId: z.union([z.string().max(40), z.number()]),
  symbol: str,
  secType: str,
  action: str,
  orderType: str,
  qty: num,
  filledQty: num,
  remaining: num,
  avgFill: num,
  lmt: num,
  stop: num,
  trailPct: num,
  tif: str.optional().default(""),
  outsideRth: z.boolean().optional().default(false),
  status: str,
  completedTime: str.optional().default(""),
  completedStatus: str.optional().default(""),
});

const UpstreamExecutionSchema = z.object({
  execId: str,
  time: str,
  symbol: str,
  secType: str,
  side: str,
  shares: num,
  price: num,
  avgPrice: num,
  commission: num,
  realized: num,
  exchange: str.optional().default(""),
  orderRef: str.optional().default(""),
});

// Only the fields the Portfolio tab uses are read; other ibkr-monitor fields are dropped.
const IbkrMonitorSnapshotSchema = z.object({
  status: z.object({
    bridge: z.string().max(40),
    stale: z.boolean(),
    dataAsOf: ms.nullable(),
    lastError: z.string().max(2000).nullable().optional(),
    serverTime: ms,
  }),
  accountCount: z.number().int().nonnegative().optional(),
  summary: z.record(z.string().max(60), z.number().finite().nullable()),
  pnl: z.object({ daily: num, unrealized: num, realized: num }),
  positions: z.array(UpstreamPositionSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
  orders: z.array(UpstreamOrderSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
  ordersAsOf: ms.nullable().optional(),
  completed: z.array(UpstreamOrderSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
  executions: z.array(UpstreamExecutionSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
  errors: z
    .array(
      z.object({ t: ms, code: z.number().int(), msg: z.string().max(2000) })
    )
    .max(200)
    .optional()
    .default([]),
});

const nn = (value: number | null | undefined): number | null =>
  value === undefined || value === null ? null : value;
const isoMs = (value: number): string =>
  new Date(Math.round(value)).toISOString();

// ibkr-monitor bridge states: connecting, live, disconnected, restarting.
export const ibkrBridgeGateway = (bridge: string): PortfolioGatewayState => {
  if (bridge === "live") return "live";
  if (
    bridge === "connecting" ||
    bridge === "restarting" ||
    bridge === "starting"
  )
    return "starting";
  return "disconnected";
};

const mapPosition = (
  row: z.infer<typeof UpstreamPositionSchema>
): PortfolioMonitorPosition => ({
  id: scrubPortfolioText(String(row.id), 24),
  symbol: scrubPortfolioText(row.symbol, 24),
  secType: scrubPortfolioText(row.secType, 12),
  currency: scrubPortfolioText(row.currency, 8),
  description: scrubPortfolioText(row.desc === "" ? row.symbol : row.desc, 80),
  position: row.position,
  avgPrice: nn(row.avgPrice),
  last: nn(row.last),
  marketValue: nn(row.marketValue),
  costBasis: nn(row.costBasis),
  dailyPnl: nn(row.dailyPnl),
  unrealized: nn(row.unrealized),
  unrealizedPct: nn(row.unrealizedPct),
  realized: nn(row.realized),
  weightPct: nn(row.weightPct),
});

const mapOrder = (
  order: z.infer<typeof UpstreamOrderSchema>
): PortfolioMonitorOrder => ({
  key: scrubPortfolioText(order.key, 80),
  permId: order.permId,
  clientId: order.clientId,
  orderId: order.orderId,
  parentKey:
    order.parentKey === null ||
    order.parentKey === undefined ||
    order.parentKey === ""
      ? null
      : scrubPortfolioText(order.parentKey, 80),
  ocaGroup: scrubPortfolioText(order.ocaGroup, 80),
  orderRef: scrubPortfolioText(order.orderRef, 80),
  conId: scrubPortfolioText(String(order.conId), 24),
  symbol: scrubPortfolioText(order.symbol, 24),
  secType: scrubPortfolioText(order.secType, 12),
  action: scrubPortfolioText(order.action, 8),
  orderType: scrubPortfolioText(order.orderType, 24),
  qty: nn(order.qty),
  filledQty: nn(order.filledQty),
  remaining: nn(order.remaining),
  avgFill: nn(order.avgFill),
  limitPrice: nn(order.lmt),
  stopPrice: nn(order.stop),
  trailPct: nn(order.trailPct),
  tif: scrubPortfolioText(order.tif, 12),
  outsideRth: order.outsideRth,
  status: scrubPortfolioText(order.status, 40),
  completedTime: scrubPortfolioText(order.completedTime, 40),
  completedStatus: scrubPortfolioText(order.completedStatus, 200),
});

// A parent key that points at no listed order is dropped, so the table never nests under a ghost.
const linkOrders = (
  orders: readonly PortfolioMonitorOrder[]
): PortfolioMonitorOrder[] => {
  const keys = new Set(orders.map((order) => order.key));
  return orders.map((order) =>
    order.parentKey === null ||
    (keys.has(order.parentKey) && order.parentKey !== order.key)
      ? order
      : { ...order, parentKey: null }
  );
};

const mapExecution = (
  execution: z.infer<typeof UpstreamExecutionSchema>
): PortfolioMonitorExecution => ({
  execId: scrubPortfolioText(execution.execId, 80),
  time: scrubPortfolioText(execution.time, 40),
  symbol: scrubPortfolioText(execution.symbol, 24),
  secType: scrubPortfolioText(execution.secType, 12),
  side: scrubPortfolioText(execution.side, 8),
  shares: nn(execution.shares),
  price: nn(execution.price),
  avgPrice: nn(execution.avgPrice),
  commission: nn(execution.commission),
  realized: nn(execution.realized),
  exchange: scrubPortfolioText(execution.exchange, 24),
  orderRef: scrubPortfolioText(execution.orderRef, 80),
});

const summaryValue = (
  summary: Record<string, number | null>,
  tag: string
): number | null => nn(summary[tag]);

// Maps an ibkr-monitor /api/snapshot document to the Portfolio tab view. ibkr-monitor already
// derives per-share prices, P&L %, weights and parent keys; this keeps its values unchanged.
export const toIbkrMonitorOutput = (
  raw: unknown,
  receivedAt: Date
): PortfolioMonitorOutput => {
  const parsed = IbkrMonitorSnapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new IbkrMonitorError(
      "UPSTREAM_ERROR",
      "ibkr-monitor response failed schema validation"
    );
  const document = parsed.data;
  const gateway = ibkrBridgeGateway(document.status.bridge);
  const positions = document.positions.map(mapPosition);
  positions.sort(
    (left, right) =>
      Math.abs(right.marketValue ?? 0) - Math.abs(left.marketValue ?? 0)
  );
  const { summary } = document;
  const lastError = document.status.lastError;
  const output: PortfolioMonitorOutput = {
    source: "ibkr-gateway",
    readOnly: true,
    status: {
      gateway,
      connected: gateway === "live",
      dataAsOf:
        document.status.dataAsOf === null
          ? null
          : isoMs(document.status.dataAsOf),
      ordersAsOf:
        document.ordersAsOf === null || document.ordersAsOf === undefined
          ? null
          : isoMs(document.ordersAsOf),
      generatedAt: isoMs(document.status.serverTime),
      receivedAt: receivedAt.toISOString(),
      lastError:
        lastError === null || lastError === undefined || lastError === ""
          ? null
          : scrubPortfolioText(lastError, 300),
      clientId: IBKR_MONITOR_CLIENT_ID,
    },
    account: {
      // ibkr-monitor removes account codes before it serves them, so live/paper cannot be derived here.
      mode: "unknown",
      count: document.accountCount ?? 0,
    },
    summary: {
      netLiquidation: summaryValue(summary, "NetLiquidation"),
      totalCashValue: summaryValue(summary, "TotalCashValue"),
      settledCash: summaryValue(summary, "SettledCash"),
      buyingPower: summaryValue(summary, "BuyingPower"),
      availableFunds: summaryValue(summary, "AvailableFunds"),
      excessLiquidity: summaryValue(summary, "ExcessLiquidity"),
      initMarginReq: summaryValue(summary, "InitMarginReq"),
      maintMarginReq: summaryValue(summary, "MaintMarginReq"),
      grossPositionValue: summaryValue(summary, "GrossPositionValue"),
      equityWithLoanValue: summaryValue(summary, "EquityWithLoanValue"),
      cushion: summaryValue(summary, "Cushion"),
      leverage: summaryValue(summary, "Leverage"),
      lookAheadExcessLiquidity: summaryValue(
        summary,
        "LookAheadExcessLiquidity"
      ),
    },
    pnl: {
      daily: nn(document.pnl.daily),
      unrealized: nn(document.pnl.unrealized),
      realized: nn(document.pnl.realized),
    },
    positions,
    orders: linkOrders(document.orders.map(mapOrder)),
    completed: linkOrders(document.completed.map(mapOrder)),
    executions: [...document.executions]
      .sort((left, right) => left.time.localeCompare(right.time))
      .map(mapExecution),
    messages: document.errors
      .slice(-PORTFOLIO_MONITOR_MAX_MESSAGES)
      .map((entry) => ({
        at: new Date(Math.round(entry.t * 1000)).toISOString(),
        code: entry.code,
        message: scrubPortfolioText(entry.msg, 200),
      })),
  };
  return PortfolioMonitorOutputSchema.parse(output);
};

const upstreamFailure = (message: string) =>
  new IbkrMonitorError("UPSTREAM_ERROR", message);

// Only a 200 JSON answer is read; gateway errors mean the service is down.
const assertJsonResponse = (response: Response): void => {
  if (
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  )
    throw new IbkrMonitorError(
      "UNAVAILABLE",
      `ibkr-monitor returned HTTP ${response.status}`
    );
  if (response.status !== 200)
    throw upstreamFailure(`ibkr-monitor returned HTTP ${response.status}`);
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? ""))
    throw upstreamFailure("ibkr-monitor returned an unexpected content type");
};

// GET one allow-listed ibkr-monitor endpoint and return its parsed JSON. No other method exists.
export const fetchIbkrMonitorJson = async (
  base: string | null,
  path: IbkrMonitorPath,
  options: FetchIbkrMonitorOptions = {}
): Promise<unknown> => {
  if (base === null || base === "")
    throw new IbkrMonitorError(
      "NOT_CONFIGURED",
      "ibkr-monitor endpoint not configured (IBKR_MONITOR_URL)"
    );
  const url = buildIbkrMonitorUrl(base, path);
  const doFetch: DeployStatusFetch =
    options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? IBKR_MONITOR_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new IbkrMonitorError(
        "UNAVAILABLE",
        controller.signal.aborted
          ? "ibkr-monitor request timed out"
          : "ibkr-monitor request failed"
      );
    }
    assertJsonResponse(response);
    let body: string;
    try {
      body = await readCappedText(
        response,
        options.maxBytes ?? IBKR_MONITOR_MAX_BYTES,
        (message) => upstreamFailure(`ibkr-monitor ${message.toLowerCase()}`)
      );
    } catch (error) {
      if (error instanceof IbkrMonitorError) throw error;
      const aborted = controller.signal.aborted;
      throw new IbkrMonitorError(
        aborted ? "UNAVAILABLE" : "UPSTREAM_ERROR",
        aborted
          ? "ibkr-monitor request timed out"
          : "ibkr-monitor response could not be read"
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw upstreamFailure("ibkr-monitor response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
};

export const fetchIbkrMonitorSnapshot = async (
  base: string | null,
  options: FetchIbkrMonitorOptions = {}
): Promise<PortfolioMonitorOutput> => {
  const raw = await fetchIbkrMonitorJson(base, "/api/snapshot", options);
  return toIbkrMonitorOutput(raw, (options.now ?? (() => new Date()))());
};

// Only orderCheck is read from GET /api/volatility; market series and ATR fields are dropped.
const UpstreamVolatilitySchema = z.object({
  orderCheck: z.object({
    checked: z.number().int().nonnegative(),
    skippedTrailing: z.number().int().nonnegative(),
    flagged: z
      .array(
        z.object({
          key: str,
          kind: z.enum(["stop", "limit"]),
          price: z.number().finite(),
          handle: str,
          side: z.enum(["below", "above"]),
          offset: z.number().finite(),
          suggested: z.number().finite(),
        })
      )
      .max(PORTFOLIO_MONITOR_MAX_ROWS * 2),
  }),
});

export const toRoundHandleCheck = (raw: unknown): RoundHandleCheckOutput => {
  const parsed = UpstreamVolatilitySchema.safeParse(raw);
  if (!parsed.success)
    throw upstreamFailure(
      "ibkr-monitor volatility response has an unexpected shape"
    );
  const { checked, skippedTrailing, flagged } = parsed.data.orderCheck;
  return RoundHandleCheckOutputSchema.parse({
    checked,
    skippedTrailing,
    flags: flagged.map((flag) => ({
      key: scrubPortfolioText(flag.key, 80),
      kind: flag.kind,
      price: flag.price,
      handle: scrubPortfolioText(flag.handle, 80),
      side: flag.side,
      offset: flag.offset,
      suggested: flag.suggested,
    })),
  });
};

export const fetchIbkrMonitorRoundHandles = async (
  base: string | null,
  options: FetchIbkrMonitorOptions = {}
): Promise<RoundHandleCheckOutput> =>
  toRoundHandleCheck(
    await fetchIbkrMonitorJson(base, "/api/volatility", options)
  );

const UpstreamSeriesSchema = z
  .object({
    value: z.number().finite(),
    asOf: z.string().max(40),
    change1d: num,
    pct1y: num,
    stale: z.boolean(),
  })
  .nullable()
  .optional();

const UpstreamSourceSchema = z
  .object({ error: z.string().max(2000).nullable().optional() })
  .optional();

// Only market fields are read from GET /api/volatility; orderCheck stays with roundHandles.
const UpstreamMarketVolatilitySchema = z.object({
  sources: z
    .object({ cboe: UpstreamSourceSchema, spx: UpstreamSourceSchema })
    .optional(),
  vix: UpstreamSeriesSchema,
  vixeq: UpstreamSeriesSchema,
  vvix: UpstreamSeriesSchema,
  spread: UpstreamSeriesSchema,
  spx: z
    .object({
      price: z.number().finite(),
      movePct: num,
      sessionOpen: z.boolean(),
    })
    .nullable()
    .optional(),
  implied: z
    .object({
      impliedPct: num,
      multiple: num,
      band: z.enum(["normal", "notable", "review"]).nullable().optional(),
    })
    .nullable()
    .optional(),
});

type UpstreamSeries = z.infer<typeof UpstreamSeriesSchema>;
const series = (value: UpstreamSeries) =>
  value
    ? {
        value: value.value,
        asOf: value.asOf,
        change1d: nn(value.change1d),
        pct1y: nn(value.pct1y),
        stale: value.stale,
      }
    : null;

export const toMarketVolatility = (raw: unknown): MarketVolatilityOutput => {
  const parsed = UpstreamMarketVolatilitySchema.safeParse(raw);
  if (!parsed.success)
    throw upstreamFailure(
      "ibkr-monitor volatility response has an unexpected shape"
    );
  const data = parsed.data;
  const sourceErrors = [
    ["Cboe", data.sources?.cboe?.error],
    ["S&P 500", data.sources?.spx?.error],
  ].flatMap(([label, error]) =>
    error ? [`${label}: ${scrubPortfolioText(error, 180)}`] : []
  );
  return MarketVolatilityOutputSchema.parse({
    vix: series(data.vix),
    vixeq: series(data.vixeq),
    vvix: series(data.vvix),
    spread: series(data.spread),
    spx: data.spx
      ? {
          price: data.spx.price,
          movePct: nn(data.spx.movePct),
          sessionOpen: data.spx.sessionOpen,
        }
      : null,
    implied: data.implied
      ? {
          impliedPct: nn(data.implied.impliedPct),
          multiple: nn(data.implied.multiple),
          band: data.implied.band ?? null,
        }
      : null,
    sourceErrors,
  });
};

export const fetchIbkrMonitorVolatility = async (
  base: string | null,
  options: FetchIbkrMonitorOptions = {}
): Promise<MarketVolatilityOutput> =>
  toMarketVolatility(
    await fetchIbkrMonitorJson(base, "/api/volatility", options)
  );

const api = implement(appContract).$context<ApiContext>();

type IbkrMonitorErrorFactories = Readonly<
  Record<IbkrMonitorErrorCode, (options?: { message?: string }) => Error>
>;

let ibkrMonitorFetchOptions: FetchIbkrMonitorOptions = {};
export const setIbkrMonitorFetchOptionsForTesting = (
  options: FetchIbkrMonitorOptions
): void => {
  ibkrMonitorFetchOptions = options;
};

// Maps typed proxy failures to the contract errors once for every ibkrMonitor procedure.
const viaProxy = async <T>(
  errors: unknown,
  read: () => Promise<T>
): Promise<T> => {
  const failures = errors as IbkrMonitorErrorFactories;
  try {
    return await read();
  } catch (error) {
    if (error instanceof IbkrMonitorError)
      throw failures[error.code]({ message: error.message });
    throw failures.UPSTREAM_ERROR({ message: "ibkr-monitor request failed" });
  }
};

const ibkrMonitorSnapshot = api.ibkrMonitor.snapshot
  .use(requireOperator)
  .handler(({ context, errors }) =>
    viaProxy(errors, () =>
      fetchIbkrMonitorSnapshot(
        context.ibkrMonitor ?? null,
        ibkrMonitorFetchOptions
      )
    )
  );

const ibkrMonitorRoundHandles = api.ibkrMonitor.roundHandles
  .use(requireOperator)
  .handler(({ context, errors }) =>
    viaProxy(errors, () =>
      fetchIbkrMonitorRoundHandles(
        context.ibkrMonitor ?? null,
        ibkrMonitorFetchOptions
      )
    )
  );

const ibkrMonitorVolatility = api.ibkrMonitor.volatility
  .use(requireOperator)
  .handler(({ context, errors }) =>
    viaProxy(errors, () =>
      fetchIbkrMonitorVolatility(
        context.ibkrMonitor ?? null,
        ibkrMonitorFetchOptions
      )
    )
  );

export const ibkrMonitorRouter = {
  snapshot: ibkrMonitorSnapshot,
  roundHandles: ibkrMonitorRoundHandles,
  volatility: ibkrMonitorVolatility,
};
