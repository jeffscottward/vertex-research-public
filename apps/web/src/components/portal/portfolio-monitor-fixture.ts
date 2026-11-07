import type {
  PortfolioMonitorExecution,
  PortfolioMonitorOrder,
  PortfolioMonitorOutput,
  PortfolioMonitorPosition,
  PortfolioMonitorStatus,
} from "@darkfactory/api";

// Fictional test data only. Symbols, values and ids are invented; no account ids.

export const fixturePosition = (
  overrides: Partial<PortfolioMonitorPosition> = {}
): PortfolioMonitorPosition => ({
  id: "1001",
  symbol: "ALPHA",
  secType: "STK",
  currency: "USD",
  description: "ALPHA",
  position: 100,
  avgPrice: 50,
  last: 60,
  marketValue: 6000,
  costBasis: 5000,
  dailyPnl: 120,
  unrealized: 1000,
  unrealizedPct: 20,
  realized: 0,
  weightPct: 30,
  ...overrides,
});

export const fixtureOrder = (
  overrides: Partial<PortfolioMonitorOrder> = {}
): PortfolioMonitorOrder => ({
  key: "7:11:9011",
  permId: 9011,
  clientId: 7,
  orderId: 11,
  parentKey: null,
  ocaGroup: "",
  orderRef: "",
  conId: "1001",
  symbol: "ALPHA",
  secType: "STK",
  action: "SELL",
  orderType: "STP",
  qty: 50,
  filledQty: 0,
  remaining: 50,
  avgFill: null,
  limitPrice: null,
  stopPrice: 55,
  trailPct: null,
  tif: "GTC",
  outsideRth: false,
  status: "PreSubmitted",
  completedTime: "",
  completedStatus: "",
  ...overrides,
});

export const fixtureExecution = (
  overrides: Partial<PortfolioMonitorExecution> = {}
): PortfolioMonitorExecution => ({
  execId: "exec-0001",
  time: "20261009 10:30:00 US/Eastern",
  symbol: "ALPHA",
  secType: "STK",
  side: "BOT",
  shares: 10,
  price: 59.5,
  avgPrice: 59.5,
  commission: 1,
  realized: null,
  exchange: "TESTX",
  orderRef: "test-ref",
  localSymbol: "ALPHA",
  permId: 1001,
  ...overrides,
});

export type SnapshotOverrides = Partial<
  Omit<PortfolioMonitorOutput, "status">
> &
  Readonly<{ status?: Partial<PortfolioMonitorStatus> }>;

export const fixtureSnapshot = (
  overrides: SnapshotOverrides = {},
  nowMs = Date.now()
): PortfolioMonitorOutput => {
  const { status, ...rest } = overrides;
  const at = (secondsAgo: number) =>
    new Date(nowMs - secondsAgo * 1000).toISOString();
  return {
    source: "ibkr-gateway",
    readOnly: true,
    status: {
      gateway: "live",
      connected: true,
      dataAsOf: at(2),
      ordersAsOf: at(5),
      generatedAt: at(1),
      receivedAt: at(0),
      lastError: null,
      clientId: 78,
      ...status,
    },
    account: { mode: "paper", count: 1 },
    summary: {
      netLiquidation: 20_000,
      totalCashValue: 9000,
      settledCash: 8500,
      buyingPower: 36_000,
      availableFunds: 9000,
      excessLiquidity: 9500,
      initMarginReq: 2750,
      maintMarginReq: 2500,
      grossPositionValue: 11_000,
      equityWithLoanValue: 20_000,
      cushion: 0.475,
      leverage: 0.55,
      lookAheadExcessLiquidity: 9500,
    },
    pnl: { daily: 200, unrealized: 1500, realized: 0 },
    positions: [
      fixturePosition(),
      fixturePosition({
        id: "1002",
        symbol: "BRAVO",
        description: "BRAVO",
        position: 50,
        avgPrice: 110,
        last: 100,
        marketValue: 5000,
        costBasis: 5500,
        dailyPnl: -80,
        unrealized: -500,
        unrealizedPct: -9.09,
        weightPct: 25,
      }),
    ],
    orders: [
      fixtureOrder({
        key: "7:10:9010",
        orderId: 10,
        permId: 9010,
        action: "BUY",
        orderType: "LMT",
        limitPrice: 58,
        stopPrice: null,
        status: "Submitted",
        qty: 50,
        remaining: 50,
      }),
      fixtureOrder({
        key: "7:11:9011",
        parentKey: "7:10:9010",
        stopPrice: 55,
        ocaGroup: "oca-test-1",
      }),
      fixtureOrder({
        key: "7:12:9012",
        orderId: 12,
        permId: 9012,
        parentKey: "7:10:9010",
        stopPrice: 57,
        orderType: "TRAIL",
        trailPct: 5,
        ocaGroup: "oca-test-1",
      }),
    ],
    completed: [],
    executions: [fixtureExecution()],
    messages: [
      {
        at: at(30),
        code: 2104,
        message: "Market data farm connection is OK (test)",
      },
    ],
    ...rest,
  };
};
