import { z } from "zod";

import type { VertexOrderInput } from "../contracts/vertex-orders.ts";
import type {
  GatewayOpenOrder,
  OrderAccount,
  PremiumCaps,
} from "./vertex-orders-rules.ts";

// Mock only. Mirrors market_watch/premium_caps.py (LEAPS_MIN_DTE, LEAPS_PREMIUM_PCT,
// SHORT_PREMIUM_PCT, commit b218d58). Live caps always come from the bridge.
const MOCK_PREMIUM_CAPS: PremiumCaps = {
  leapsMinDays: 365,
  leapsPct: 6,
  shortPct: 2,
};

// Order gateway port for the owner order screen, with two adapters:
// - mock: in-memory account for development, tests and every run while VERTEX_ORDERS_ENABLED is
//   off. It never opens a network connection.
// - bridge: the loopback order bridge on the Vertex host (VERTEX_ORDER_BRIDGE_URL), which wraps the
//   market-watch-bot IBKR gateway (ops/ibkr_reentry_gateway.py place_option/cancel) and reports
//   the bot's kill switch and OPTIONS_ONLY gates. Used only when the flag is on.

export type PlaceOrderResult = Readonly<{
  state: string;
  permId: number | null;
  message: string;
}>;

export interface OrderGatewayPort {
  readonly mode: "simulated" | "live";
  readonly account: () => Promise<OrderAccount>;
  readonly place: (
    order: VertexOrderInput,
    orderRef: string
  ) => Promise<PlaceOrderResult>;
  readonly cancel: (permId: number) => Promise<PlaceOrderResult>;
}

export class OrderGatewayError extends Error {
  readonly code: "NOT_CONFIGURED" | "UPSTREAM_ERROR";
  constructor(code: "NOT_CONFIGURED" | "UPSTREAM_ERROR", message: string) {
    super(message);
    this.name = "OrderGatewayError";
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const yyyymmdd = (date: Date): string =>
  date.toISOString().slice(0, 10).replaceAll("-", "");

// Fictional mock account. Values are visibly round and not tied to any real account.
export const createMockOrderGateway = (
  now: () => Date = () => new Date()
): OrderGatewayPort => {
  const start = now().getTime();
  const leapsExpiry = yyyymmdd(new Date(start + 500 * DAY_MS));
  const shortExpiry = yyyymmdd(new Date(start + 60 * DAY_MS));
  let nextPermId = 900_001;
  const usedRefs = new Set<string>();
  const positions = [
    {
      symbol: "MOCKA",
      secType: "OPT",
      expiry: leapsExpiry,
      strike: 100,
      right: "C",
      quantity: 2,
      premium: 4000,
    },
    // A share position: never counted as option premium.
    {
      symbol: "MOCKA",
      secType: "STK",
      expiry: "",
      strike: 0,
      right: "",
      quantity: 100,
      premium: 9000,
    },
  ];
  const openOrders: GatewayOpenOrder[] = [
    {
      permId: nextPermId++,
      symbol: "MOCKB",
      secType: "OPT",
      expiry: shortExpiry,
      strike: 50,
      right: "C",
      side: "BUY",
      quantity: 1,
      orderType: "LMT",
      limitPrice: 2.5,
      status: "Submitted",
      orderRef: "mock-seed",
    },
    {
      permId: nextPermId++,
      symbol: "MOCKC",
      secType: "STK",
      expiry: null,
      strike: null,
      right: null,
      side: "SELL",
      quantity: 10,
      orderType: "STP",
      limitPrice: null,
      status: "PreSubmitted",
      orderRef: "mock-stop",
    },
  ];
  return {
    mode: "simulated",
    account: () =>
      Promise.resolve({
        netLiquidation: 200_000,
        positions: positions.map((p) => ({ ...p })),
        openOrders: openOrders.map((o) => ({ ...o })),
        gates: { killSwitch: false, optionsOnly: true },
        caps: MOCK_PREMIUM_CAPS,
      }),
    place: (order, orderRef) => {
      // Same rule as the IBKR gateway: an orderRef is used once (replay guard across processes).
      if (
        openOrders.some((o) => o.orderRef === orderRef) ||
        usedRefs.has(orderRef)
      )
        return Promise.resolve({
          state: "aborted",
          permId: null,
          message: `orderRef ${orderRef} already used`,
        });
      usedRefs.add(orderRef);
      const permId = nextPermId++;
      openOrders.push({
        permId,
        symbol: order.symbol,
        secType: "OPT",
        expiry: order.expiry,
        strike: order.strike,
        right: order.right,
        side: order.side,
        quantity: order.quantity,
        orderType: "LMT",
        limitPrice: order.limitPrice,
        status: "Submitted",
        orderRef,
      });
      return Promise.resolve({
        state: "submitted",
        permId,
        message: "Simulated order: mock gateway, nothing sent to IBKR.",
      });
    },
    cancel: (permId) => {
      const index = openOrders.findIndex((o) => o.permId === permId);
      if (index >= 0) openOrders.splice(index, 1);
      return Promise.resolve({
        state: index >= 0 ? "cancelled" : "not-found",
        permId,
        message: "Simulated cancel: mock gateway, nothing sent to IBKR.",
      });
    },
  };
};

const BridgeOrderSchema = z.object({
  permId: z.number().int(),
  symbol: z.string().max(24),
  secType: z.string().max(12),
  expiry: z.string().max(12).nullable(),
  strike: z.number().finite().nullable(),
  right: z.string().max(2).nullable(),
  side: z.string().max(8),
  quantity: z.number().finite(),
  orderType: z.string().max(24),
  limitPrice: z.number().finite().nullable(),
  status: z.string().max(40),
  orderRef: z.string().max(80),
});

const BridgeAccountSchema = z.object({
  netLiquidation: z.number().finite().nullable(),
  positions: z
    .array(
      z.object({
        symbol: z.string().max(24),
        secType: z.string().max(12),
        expiry: z.string().max(12),
        strike: z.number().finite(),
        right: z.string().max(2),
        quantity: z.number().finite(),
        premium: z.number().finite(),
      })
    )
    .max(2000),
  openOrders: z.array(BridgeOrderSchema).max(2000),
  gates: z.object({ killSwitch: z.boolean(), optionsOnly: z.boolean() }),
  // The gateway's effective caps; required, so a bridge without them fails closed.
  caps: z.object({
    leapsMinDays: z.number().int().positive(),
    leapsPct: z.number().positive().max(100),
    shortPct: z.number().positive().max(100),
  }),
});

const BridgeResultSchema = z.object({
  state: z.string().max(40),
  permId: z.number().int().nullable(),
  message: z.string().max(400),
});

type BridgeFetch = (input: string, init?: RequestInit) => Promise<Response>;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BRIDGE_TIMEOUT_MS = 30_000;

export const createBridgeOrderGateway = (
  base: string | null,
  fetchImpl: BridgeFetch = (input, init) => fetch(input, init)
): OrderGatewayPort => {
  const root = (): string => {
    const url = base === null ? null : URL.parse(base);
    if (
      url === null ||
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname)
    )
      throw new OrderGatewayError(
        "NOT_CONFIGURED",
        "Order bridge must be a loopback http URL (VERTEX_ORDER_BRIDGE_URL)"
      );
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  };
  const call = async <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<T> => {
    const url = `${root()}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new OrderGatewayError(
        "UPSTREAM_ERROR",
        "Order bridge did not answer"
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!(response.ok && parsed.success))
      throw new OrderGatewayError(
        "UPSTREAM_ERROR",
        `Order bridge returned an invalid response (HTTP ${response.status})`
      );
    return parsed.data;
  };
  return {
    mode: "live",
    account: () => call("/account", BridgeAccountSchema),
    place: (order, orderRef) =>
      call("/orders", BridgeResultSchema, { ...order, orderRef }),
    cancel: (permId) => call("/cancel", BridgeResultSchema, { permId }),
  };
};
