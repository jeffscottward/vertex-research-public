import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  PORTFOLIO_ACCOUNT_MODE_SOURCES,
  PORTFOLIO_ACCOUNT_MODES,
  type PortfolioMonitorAccount,
  PORTFOLIO_MONITOR_MAX_MESSAGES,
  PORTFOLIO_MONITOR_MAX_ROWS,
  PortfolioMonitorOutputSchema,
  type PortfolioMonitorExecution,
  type PortfolioMonitorOrder,
  type PortfolioMonitorOutput,
  type PortfolioMonitorPosition,
  type PortfolioMonitorSummary,
} from "../contracts/portfolio-monitor.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";

// Bounded, read-only fetch of the IBKR portfolio snapshot from the QuantVPS tailnet service
// vertex-portfolio (VERTEX_PORTFOLIO_URL, bearer VERTEX_DEPLOY_STATUS_TOKEN). GET only, 15 s timeout,
// 4 MiB cap, redirects never followed, strict schema parse. The server derives the browser view
// (prices per share, P&L %, weights, order parent links) from the raw snapshot. Account codes are
// removed again here. Messages never include the token or the URL.

const PORTFOLIO_MONITOR_TIMEOUT_MS = 15_000;
const PORTFOLIO_MONITOR_MAX_BYTES = 4 * 1024 * 1024;
// Per-position P&L subscriptions older than this are ignored in favor of account-update values.
const PORTFOLIO_PNL_FRESH_SECONDS = 600;

export type PortfolioMonitorErrorCode =
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR";

export class PortfolioMonitorError extends Error {
  code: PortfolioMonitorErrorCode;
  constructor(code: PortfolioMonitorErrorCode, message: string) {
    super(message);
    this.name = "PortfolioMonitorError";
    this.code = code;
  }
}

export type FetchPortfolioMonitorOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}>;

const num = z.number().finite().nullable();
const text = (max: number) => z.string().max(max);
const epoch = z.number().finite().nonnegative();

const UpstreamPositionSchema = z
  .object({
    conId: z.number().int(),
    symbol: text(24),
    secType: text(12),
    currency: text(8),
    right: text(8),
    strike: z.number().finite(),
    expiry: text(16),
    multiplier: text(16),
    localSymbol: text(40),
    position: z.number().finite(),
    avgCost: num,
    acctMarketPrice: num,
    acctMarketValue: num,
    acctUnrealized: num,
    realized: num,
    pnlValue: num,
    dailyPnl: num,
    pnlUnrealized: num,
    pnlT: epoch.nullable(),
  })
  .strict();

const UpstreamOrderSchema = z
  .object({
    key: text(80),
    orderId: z.number().int(),
    permId: z.number().int(),
    clientId: z.number().int(),
    parentId: z.number().int(),
    ocaGroup: text(200),
    orderRef: text(200),
    conId: z.number().int(),
    symbol: text(24),
    secType: text(12),
    localSymbol: text(40),
    action: text(8),
    orderType: text(24),
    qty: num,
    filledQty: num,
    remaining: num,
    avgFill: num,
    lmt: num,
    aux: num,
    trailPct: num,
    trailStop: num,
    tif: text(12),
    outsideRth: z.boolean(),
    status: text(40),
    transmit: z.boolean(),
    completedTime: text(40),
    completedStatus: text(400),
  })
  .strict();

const UpstreamExecutionSchema = z
  .object({
    execId: text(80),
    time: text(40),
    symbol: text(24),
    secType: text(12),
    localSymbol: text(40),
    side: text(8),
    shares: num,
    price: num,
    avgPrice: num,
    cumQty: num,
    orderId: z.number().int(),
    permId: z.number().int(),
    clientId: z.number().int(),
    exchange: text(24),
    orderRef: text(200),
    commission: num,
    realized: num,
  })
  .strict();

const SUMMARY_TAGS = [
  "NetLiquidation",
  "TotalCashValue",
  "SettledCash",
  "BuyingPower",
  "AvailableFunds",
  "ExcessLiquidity",
  "InitMarginReq",
  "MaintMarginReq",
  "FullInitMarginReq",
  "FullMaintMarginReq",
  "GrossPositionValue",
  "EquityWithLoanValue",
  "Cushion",
  "Leverage",
  "LookAheadExcessLiquidity",
] as const;

export const VertexPortfolioUpstreamSchema = z
  .object({
    schema: z.literal("vertex-portfolio-snapshot-v1"),
    source: z.literal("ibkr-gateway"),
    clientId: z.literal(78),
    version: text(16),
    generatedAt: epoch,
    state: z.enum(["starting", "live", "disconnected"]),
    connected: z.boolean(),
    lastError: text(400).nullable(),
    // Service 1.1.0 always sends live or paper, or null with a modeError. Any other value comes
    // from service 1.0.0 (no configured mode yet) and is read as "mode not reported".
    accountMode: z.enum(PORTFOLIO_ACCOUNT_MODES).nullable().catch(null),
    modeSource: z.enum(PORTFOLIO_ACCOUNT_MODE_SOURCES).nullable().optional(),
    modeConfirmedAt: epoch.nullable().optional(),
    modeError: z.enum(["mismatch", "not-configured"]).nullable().optional(),
    // Start of the current connection state (live since / not live since).
    stateSince: epoch.nullable().optional(),
    accountCount: z.number().int().nonnegative(),
    dataAsOf: epoch.nullable(),
    ordersAsOf: epoch.nullable(),
    summary: z.partialRecord(z.enum(SUMMARY_TAGS), z.number().finite()),
    pnl: z
      .object({
        daily: num.optional(),
        unrealized: num.optional(),
        realized: num.optional(),
      })
      .strict(),
    positions: z.array(UpstreamPositionSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
    orders: z.array(UpstreamOrderSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
    completed: z.array(UpstreamOrderSchema).max(PORTFOLIO_MONITOR_MAX_ROWS),
    executions: z
      .array(UpstreamExecutionSchema)
      .max(PORTFOLIO_MONITOR_MAX_ROWS),
    errors: z
      .array(
        z.object({ t: epoch, code: z.number().int(), msg: text(400) }).strict()
      )
      .max(100),
  })
  .strict();

export type VertexPortfolioUpstream = z.infer<
  typeof VertexPortfolioUpstreamSchema
>;
type UpstreamOrder = z.infer<typeof UpstreamOrderSchema>;

const ACCOUNT_PATTERN = /\b(?:D?U|DF|F|I)\d{4,}\b/g;
// Removes account codes and control characters; the VPS already did this, the server repeats it.
export const scrubPortfolioText = (value: string, max: number): string => {
  return value
    .replace(ACCOUNT_PATTERN, "[account]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
};

const iso = (seconds: number): string =>
  new Date(Math.round(seconds * 1000)).toISOString();
const isoOrNull = (seconds: number | null): string | null =>
  seconds === null ? null : iso(seconds);
const nn = (value: number | null | undefined): number | null =>
  value === undefined ||
  value === null ||
  !Number.isFinite(value) ||
  Math.abs(value) >= 1e300 // IBKR's Double.MAX "unset" marker
    ? null
    : value;

const toSummary = (
  summary: VertexPortfolioUpstream["summary"]
): PortfolioMonitorSummary => ({
  netLiquidation: nn(summary.NetLiquidation),
  totalCashValue: nn(summary.TotalCashValue),
  settledCash: nn(summary.SettledCash),
  buyingPower: nn(summary.BuyingPower),
  availableFunds: nn(summary.AvailableFunds),
  excessLiquidity: nn(summary.ExcessLiquidity),
  initMarginReq: nn(summary.InitMarginReq),
  maintMarginReq: nn(summary.MaintMarginReq),
  grossPositionValue: nn(summary.GrossPositionValue),
  equityWithLoanValue: nn(summary.EquityWithLoanValue),
  cushion: nn(summary.Cushion),
  leverage: nn(summary.Leverage),
  lookAheadExcessLiquidity: nn(summary.LookAheadExcessLiquidity),
});

const describePosition = (
  row: VertexPortfolioUpstream["positions"][number]
): string => {
  if (row.secType === "OPT") {
    return scrubPortfolioText(
      `${row.symbol} ${row.expiry} ${row.strike} ${row.right}`,
      80
    );
  }
  return scrubPortfolioText(
    row.localSymbol === "" ? row.symbol : row.localSymbol,
    80
  );
};

// Same arithmetic as the ibkr-monitor reference: IBKR reports avgCost and market value per contract
// multiplier, so prices per share divide by the multiplier. Fresh per-position P&L wins over
// account-update values.
const derivePortfolioPositions = (
  document: VertexPortfolioUpstream
): PortfolioMonitorPosition[] => {
  const nlv = nn(document.summary.NetLiquidation);
  const positions = document.positions.map((row) => {
    const multiplier = Number(row.multiplier) || 1;
    const quantity = row.position;
    const fresh =
      row.pnlT !== null &&
      document.generatedAt - row.pnlT < PORTFOLIO_PNL_FRESH_SECONDS;
    const marketValue =
      nn(fresh ? row.pnlValue : null) ?? nn(row.acctMarketValue);
    const last =
      marketValue !== null && quantity !== 0
        ? marketValue / quantity / multiplier
        : nn(row.acctMarketPrice);
    const avgPrice = row.avgCost === null ? null : row.avgCost / multiplier;
    const unrealized =
      nn(fresh ? row.pnlUnrealized : null) ?? nn(row.acctUnrealized);
    const costBasis =
      avgPrice === null ? null : Math.abs(avgPrice * quantity * multiplier);
    const position: PortfolioMonitorPosition = {
      id: String(row.conId),
      symbol: scrubPortfolioText(row.symbol, 24),
      secType: scrubPortfolioText(row.secType, 12),
      currency: scrubPortfolioText(row.currency, 8),
      description: describePosition(row),
      position: quantity,
      avgPrice,
      last,
      marketValue,
      costBasis,
      dailyPnl: nn(row.dailyPnl),
      unrealized,
      unrealizedPct:
        unrealized !== null && costBasis
          ? (unrealized / costBasis) * 100
          : null,
      realized: nn(row.realized),
      weightPct: marketValue !== null && nlv ? (marketValue / nlv) * 100 : null,
      ...(row.secType === "OPT"
        ? {
            option: {
              expiry: scrubPortfolioText(row.expiry, 16),
              strike: row.strike,
              right: scrubPortfolioText(row.right, 8),
            },
          }
        : {}),
    };
    return position;
  });
  positions.sort(
    (left, right) =>
      Math.abs(right.marketValue ?? 0) - Math.abs(left.marketValue ?? 0)
  );
  return positions;
};

const orderStop = (order: UpstreamOrder): number | null => {
  if (order.orderType.startsWith("TRAIL"))
    return nn(order.trailStop) ?? nn(order.aux);
  if (order.orderType.includes("STP")) return nn(order.aux);
  return null;
};

const mapOrder = (order: UpstreamOrder): PortfolioMonitorOrder => ({
  key: scrubPortfolioText(order.key, 80),
  permId: order.permId,
  clientId: order.clientId,
  orderId: order.orderId,
  parentKey: null,
  ocaGroup: scrubPortfolioText(order.ocaGroup, 80),
  orderRef: scrubPortfolioText(order.orderRef, 80),
  conId: String(order.conId),
  symbol: scrubPortfolioText(order.symbol, 24),
  secType: scrubPortfolioText(order.secType, 12),
  action: scrubPortfolioText(order.action, 8),
  orderType: scrubPortfolioText(order.orderType, 24),
  qty: nn(order.qty),
  filledQty: nn(order.filledQty),
  remaining: nn(order.remaining),
  avgFill: nn(order.avgFill),
  limitPrice: order.orderType.includes("LMT") ? nn(order.lmt) : null,
  stopPrice: orderStop(order),
  trailPct: nn(order.trailPct),
  tif: scrubPortfolioText(order.tif, 12),
  outsideRth: order.outsideRth,
  status: scrubPortfolioText(order.status, 40),
  completedTime: scrubPortfolioText(order.completedTime, 40),
  completedStatus: scrubPortfolioText(order.completedStatus, 200),
});

// IBKR links a child to its parent by (clientId, parentId == parent's orderId).
const derivePortfolioOrders = (
  orders: readonly UpstreamOrder[]
): PortfolioMonitorOrder[] => {
  const mapped = orders.map((source) => ({
    parentId: source.parentId,
    order: mapOrder(source),
  }));
  const byClientOrder = new Map<string, PortfolioMonitorOrder>();
  for (const { order } of mapped) {
    if (order.orderId !== 0) {
      byClientOrder.set(`${order.clientId}:${order.orderId}`, order);
    }
  }
  return mapped.map(({ parentId, order }) => {
    const parent =
      parentId === 0
        ? undefined
        : byClientOrder.get(`${order.clientId}:${parentId}`);
    return parent === undefined || parent === order
      ? order
      : { ...order, parentKey: parent.key };
  });
};

const mapExecution = (
  execution: z.infer<typeof UpstreamExecutionSchema>
): PortfolioMonitorExecution => ({
  execId: scrubPortfolioText(execution.execId, 80),
  time: scrubPortfolioText(execution.time, 40),
  symbol: scrubPortfolioText(execution.symbol, 24),
  secType: scrubPortfolioText(execution.secType, 12),
  localSymbol: scrubPortfolioText(execution.localSymbol, 40),
  permId:
    execution.permId !== null && execution.permId > 0 ? execution.permId : null,
  side: scrubPortfolioText(execution.side, 8),
  shares: nn(execution.shares),
  price: nn(execution.price),
  avgPrice: nn(execution.avgPrice),
  commission: nn(execution.commission),
  realized: nn(execution.realized),
  exchange: scrubPortfolioText(execution.exchange, 24),
  orderRef: scrubPortfolioText(execution.orderRef, 80),
});

type ReportedAccount = Readonly<{
  // False for a reader version that sends no mode fields at all.
  reported: boolean;
  mode: string | null | undefined;
  modeSource: string | null | undefined;
  modeConfirmedAt: string | null;
  modeError: string | null | undefined;
  count: number;
}>;

// The account block of the view. It has a mode (live or paper) or a named error, never neither.
export const toPortfolioAccount = (
  input: ReportedAccount
): PortfolioMonitorAccount => {
  const none = {
    mode: null,
    modeSource: null,
    modeConfirmedAt: null,
    count: input.count,
  };
  if (!input.reported) {
    // A reader without the mode fields that still names a mode read it from the account list of
    // its current session: that is a confirmed mode. Anything else is "not reported".
    return input.mode === "live" || input.mode === "paper"
      ? {
          mode: input.mode,
          modeSource: "confirmed",
          modeConfirmedAt: null,
          modeError: null,
          count: input.count,
        }
      : { ...none, modeError: "not-reported" };
  }
  if (input.modeError === "mismatch") return { ...none, modeError: "mismatch" };
  if (input.mode !== "live" && input.mode !== "paper")
    return { ...none, modeError: "not-configured" };
  return {
    mode: input.mode,
    modeSource: input.modeSource === "confirmed" ? "confirmed" : "configured",
    modeConfirmedAt: input.modeConfirmedAt,
    modeError: null,
    count: input.count,
  };
};

// Configured mode and account list disagree: nothing from that account is shown as this account's
// data. The readers already withhold it; this keeps the rule in one more place.
export const withholdOnModeMismatch = (
  output: PortfolioMonitorOutput
): PortfolioMonitorOutput =>
  output.account.modeError === "mismatch"
    ? {
        ...output,
        status: { ...output.status, dataAsOf: null, ordersAsOf: null },
        summary: toSummary({}),
        pnl: { daily: null, unrealized: null, realized: null },
        positions: [],
        orders: [],
        completed: [],
        executions: [],
      }
    : output;

export const toPortfolioMonitorOutput = (
  raw: unknown,
  receivedAt: Date
): PortfolioMonitorOutput => {
  const parsed = VertexPortfolioUpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new PortfolioMonitorError(
      "UPSTREAM_ERROR",
      "Portfolio response failed schema validation"
    );
  const document = parsed.data;
  const output: PortfolioMonitorOutput = {
    source: "ibkr-gateway",
    readOnly: true,
    status: {
      gateway: document.state,
      connected: document.connected,
      // While the IB session is live, the subscriptions keep every value current, so the data is as
      // of the snapshot time (as in the ibkr-monitor reference). Quiet markets send few callbacks.
      dataAsOf:
        document.state === "live" && document.connected
          ? iso(document.generatedAt)
          : isoOrNull(document.dataAsOf),
      ordersAsOf: isoOrNull(document.ordersAsOf),
      generatedAt: iso(document.generatedAt),
      receivedAt: receivedAt.toISOString(),
      lastError:
        document.lastError === null
          ? null
          : scrubPortfolioText(document.lastError, 300),
      since: isoOrNull(document.stateSince ?? null),
      clientId: 78,
    },
    account: toPortfolioAccount({
      reported:
        document.modeSource !== undefined || document.modeError !== undefined,
      mode: document.accountMode,
      modeSource: document.modeSource,
      modeConfirmedAt: isoOrNull(document.modeConfirmedAt ?? null),
      modeError: document.modeError,
      count: document.accountCount,
    }),
    summary: toSummary(document.summary),
    pnl: {
      daily: nn(document.pnl.daily),
      unrealized: nn(document.pnl.unrealized),
      realized: nn(document.pnl.realized),
    },
    positions: derivePortfolioPositions(document),
    orders: derivePortfolioOrders(document.orders),
    completed: derivePortfolioOrders(document.completed),
    executions: [...document.executions]
      .sort((left, right) => left.time.localeCompare(right.time))
      .map(mapExecution),
    messages: document.errors
      .slice(-PORTFOLIO_MONITOR_MAX_MESSAGES)
      .map((entry) => ({
        at: iso(entry.t),
        code: entry.code,
        message: scrubPortfolioText(entry.msg, 200),
      })),
  };
  // Final guard: the browser contract is strict too.
  return PortfolioMonitorOutputSchema.parse(withholdOnModeMismatch(output));
};

// Reads at most maxBytes of a response body as UTF-8; `fail` builds the error to throw.
export const readCappedText = async (
  response: Response,
  maxBytes: number,
  fail: (message: string) => Error
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw fail("Response exceeds the size cap");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw fail("Response exceeds the size cap");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail("Response is not valid UTF-8");
  }
};

export const buildPortfolioSnapshotUrl = (base: string): string => {
  return `${base.replace(/\/+$/, "")}/snapshot`;
};

const upstreamFailure = (error: string) =>
  new PortfolioMonitorError("UPSTREAM_ERROR", error);

export const fetchPortfolioMonitor = async (
  config: DeployStatusConfig | null,
  options: FetchPortfolioMonitorOptions = {}
): Promise<PortfolioMonitorOutput> => {
  if (config === null)
    throw new PortfolioMonitorError(
      "NOT_CONFIGURED",
      "Portfolio monitor endpoint not configured (VERTEX_PORTFOLIO_URL)"
    );
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PORTFOLIO_MONITOR_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(buildPortfolioSnapshotUrl(config.url), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new PortfolioMonitorError(
        "UNAVAILABLE",
        controller.signal.aborted
          ? "Portfolio request timed out"
          : "Portfolio request failed"
      );
    }
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      throw new PortfolioMonitorError(
        "UNAVAILABLE",
        `Portfolio endpoint returned HTTP ${response.status}`
      );
    }
    if (response.status !== 200)
      throw upstreamFailure(
        `Portfolio endpoint returned HTTP ${response.status}`
      );
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    ) {
      throw upstreamFailure(
        "Portfolio endpoint returned an unexpected content type"
      );
    }
    let body: string;
    try {
      body = await readCappedText(
        response,
        options.maxBytes ?? PORTFOLIO_MONITOR_MAX_BYTES,
        (message) => upstreamFailure(`Portfolio ${message.toLowerCase()}`)
      );
    } catch (error) {
      if (error instanceof PortfolioMonitorError) throw error;
      throw new PortfolioMonitorError(
        controller.signal.aborted ? "UNAVAILABLE" : "UPSTREAM_ERROR",
        controller.signal.aborted
          ? "Portfolio request timed out"
          : "Portfolio response could not be read"
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      throw upstreamFailure("Portfolio response is not valid JSON");
    }
    return toPortfolioMonitorOutput(raw, (options.now ?? (() => new Date()))());
  } finally {
    clearTimeout(timer);
  }
};

const api = implement(appContract).$context<ApiContext>();

type PortfolioMonitorErrorFactories = Readonly<
  Record<PortfolioMonitorErrorCode, (options?: { message?: string }) => Error>
>;

let portfolioMonitorFetchOptions: FetchPortfolioMonitorOptions = {};
export const setPortfolioMonitorFetchOptionsForTesting = (
  options: FetchPortfolioMonitorOptions
): void => {
  portfolioMonitorFetchOptions = options;
};

const portfolioMonitorSnapshot = api.portfolioMonitor.snapshot
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as PortfolioMonitorErrorFactories;
    try {
      return await fetchPortfolioMonitor(
        context.portfolioMonitor ?? null,
        portfolioMonitorFetchOptions
      );
    } catch (error) {
      if (error instanceof PortfolioMonitorError)
        throw failures[error.code]({ message: error.message });
      throw failures.UPSTREAM_ERROR({ message: "Portfolio request failed" });
    }
  });

export const portfolioMonitorRouter = { snapshot: portfolioMonitorSnapshot };
