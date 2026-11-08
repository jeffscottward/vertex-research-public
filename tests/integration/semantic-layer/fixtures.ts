import { readFileSync } from "node:fs";

// Synthetic feeds for the semantic-layer eval (docs/vertex-rebuild/agent-semantic-layer.md). Every name,
// account and number is invented. The live account (vertex-portfolio feed) and the paper exec node
// (deployment_status) carry different values, so an answer shows which source it used.

/** The eval clock: five seconds after both snapshots were taken. */
export const EVAL_NOW = new Date("2026-11-05T15:30:05.000Z");
const GENERATED_AT = Date.parse("2026-11-05T15:30:00.000Z") / 1000;

type LegInput = Readonly<{
  conId: number;
  symbol: string;
  secType: "STK" | "OPT";
  right?: "C" | "P";
  strike?: number;
  expiry?: string;
  localSymbol: string;
  position: number;
  /** IBKR avgCost: per share for stock, per contract (x multiplier) for options. */
  avgCost: number;
  marketValue: number;
  unrealized: number;
}>;

const leg = (input: LegInput) => {
  const multiplier = input.secType === "OPT" ? "100" : "";
  return {
    acctMarketPrice:
      input.marketValue / input.position / (input.secType === "OPT" ? 100 : 1),
    acctMarketValue: input.marketValue,
    acctUnrealized: input.unrealized,
    avgCost: input.avgCost,
    conId: input.conId,
    currency: "USD",
    dailyPnl: null,
    expiry: input.expiry ?? "",
    localSymbol: input.localSymbol,
    multiplier,
    pnlT: null,
    pnlUnrealized: null,
    pnlValue: null,
    position: input.position,
    realized: 0,
    right: input.right ?? "",
    secType: input.secType,
    strike: input.strike ?? 0,
    symbol: input.symbol,
  };
};

/** vertex-portfolio-snapshot-v1 document of the live IBKR account (synthetic). */
export const LIVE_PORTFOLIO_DOCUMENT = {
  accountCount: 1,
  accountMode: "live",
  clientId: 78,
  completed: [],
  connected: true,
  dataAsOf: GENERATED_AT,
  errors: [],
  executions: [],
  generatedAt: GENERATED_AT,
  lastError: null,
  orders: [],
  ordersAsOf: GENERATED_AT,
  pnl: { daily: -1284.4, realized: 1050, unrealized: 5830 },
  positions: [
    leg({
      avgCost: 550,
      conId: 1001,
      localSymbol: "SPY",
      marketValue: 70_560,
      position: 120,
      secType: "STK",
      symbol: "SPY",
      unrealized: 4560,
    }),
    leg({
      avgCost: 185,
      conId: 1002,
      localSymbol: "NVDA",
      marketValue: 29_400,
      position: 150,
      secType: "STK",
      symbol: "NVDA",
      unrealized: 1650,
    }),
    leg({
      avgCost: 1250,
      conId: 2001,
      expiry: "20261218",
      localSymbol: "NVDA  261218C00200000",
      marketValue: 6760,
      position: 5,
      right: "C",
      secType: "OPT",
      strike: 200,
      symbol: "NVDA",
      unrealized: 510,
    }),
    leg({
      avgCost: 1095,
      conId: 2002,
      expiry: "20270115",
      localSymbol: "SPY   270115P00560000",
      marketValue: 3600,
      position: 4,
      right: "P",
      secType: "OPT",
      strike: 550,
      symbol: "SPY",
      unrealized: -780,
    }),
    leg({
      avgCost: 1100,
      conId: 2003,
      expiry: "20261121",
      localSymbol: "QQQ   261121C00520000",
      marketValue: -1900,
      position: -2,
      right: "C",
      secType: "OPT",
      strike: 520,
      symbol: "QQQ",
      unrealized: 300,
    }),
    leg({
      avgCost: 700,
      conId: 2004,
      expiry: "20261121",
      localSymbol: "QQQ   261121C00530000",
      marketValue: 990,
      position: 2,
      right: "C",
      secType: "OPT",
      strike: 530,
      symbol: "QQQ",
      unrealized: -410,
    }),
  ],
  schema: "vertex-portfolio-snapshot-v1",
  source: "ibkr-gateway",
  state: "live",
  summary: {
    AvailableFunds: 151_200,
    BuyingPower: 604_800,
    NetLiquidation: 248_350.12,
    TotalCashValue: 128_700.12,
  },
  version: "1.0.0",
};

/**
 * vertex-deploy-status-v2 snapshot of the paper exec node: the repository fixture with invented paper
 * values. Its equity is NOT the owner's account.
 */
export const paperExecNodeDocument = (): Record<string, unknown> => {
  const document = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/api/src/contracts/fixtures/deploy-status-v2-stopped-session.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as Record<string, Record<string, unknown>>;
  const asOf = "2026-11-05T15:30:00Z";
  return {
    ...document,
    equity: {
      ...document["equity"],
      age_seconds: 5,
      as_of: asOf,
      available_funds: 90_800,
      buying_power: 363_200,
      cash: 92_000,
      net_liq: 100_412.55,
      realized: -45.1,
      stale: false,
      unrealized: 212.3,
    },
    generatedAt: "2026-11-05T15:30:00+00:00",
    positions: {
      ...document["positions"],
      age_seconds: 5,
      as_of: asOf,
      count: 1,
      items: [
        {
          avg_cost: 234.7,
          avg_px: 234.7,
          currency: "USD",
          market_price: 240,
          market_value: 9600,
          multiplier: null,
          qty: 40,
          realized_pnl: 0,
          sec_type: "STK",
          symbol: "XLK",
          unrealized_pnl: 212,
        },
      ],
      stale: false,
    },
    session: {
      ...document["session"],
      account_masked: "DU****12",
      trading_mode: "paper",
    },
  };
};

export const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
