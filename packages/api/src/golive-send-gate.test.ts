import type {
  GoLiveDraftRecord,
  GoLivePlanRecord,
} from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import {
  type GoLiveSendInputs,
  goLiveSendRefusals,
  workingOrderRisks,
} from "./server/golive-send-gate.ts";

// 2026-11-13 16:30 New York (before the close): order session day 2026-11-13.
const NOW = new Date("2026-11-13T21:30:00.000Z");
const DAY = "2026-11-16";

const ORDER = {
  legs: [
    { expiry: "20261218", ratio: 1, right: "C", side: "BUY", strike: 100 },
    { expiry: "20261218", ratio: 1, right: "C", side: "SELL", strike: 105 },
  ],
  limitPrice: 1.25,
  quantity: 4,
  symbol: "SPY",
} satisfies GoLiveSendInputs["order"];

const draft = (overrides: Partial<GoLiveDraftRecord> = {}): GoLiveDraftRecord =>
  ({
    approvedOrder: ORDER,
    expiry: "20261218",
    id: "d-spy",
    kind: "entry",
    longStrike: 100,
    planId: "pie",
    shortStrike: 105,
    state: "approved",
    structure: "callDebitVertical",
    symbol: "SPY",
    tradingDay: DAY,
    ...overrides,
  }) as GoLiveDraftRecord;

const PLAN = {
  id: "pie",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 4,
    positionRiskPct: 1,
  },
  sleeves: [{ symbols: ["SPY", "QQQ"] }],
  status: "approved",
} as unknown as GoLivePlanRecord;

const ARMED = {
  arm: null,
  badge: "running-armed",
  checkedAt: NOW.toISOString(),
} as const;

const inputs = (
  overrides: Partial<GoLiveSendInputs> = {}
): GoLiveSendInputs => ({
  account: { netLiquidation: 100_000, openOrders: [], positions: [] },
  draftId: "d-spy",
  drafts: [draft()],
  node: ARMED,
  now: NOW,
  order: ORDER,
  plan: PLAN,
  sendEnabled: true,
  ...overrides,
});

const codes = (refusals: string[]) =>
  refusals.map((text) => text.split(":")[0]);

describe("goLiveSendRefusals", () => {
  it("allows the approved order of an approved entry with the node armed and room in every cap", () => {
    expect(goLiveSendRefusals(inputs())).toEqual([]);
  });

  it("refuses every send by name while go-live sends are off (v3 not on the live path)", () => {
    expect(codes(goLiveSendRefusals(inputs({ sendEnabled: false })))).toEqual([
      "GO-LIVE V3_NOT_ON_LIVE_PATH",
    ]);
  });

  it("refuses with the engine disarmed and says so", () => {
    const [refusal] = goLiveSendRefusals(
      inputs({ node: { ...ARMED, badge: "running-disarmed" } })
    );
    expect(refusal).toContain(
      "GO-LIVE ENGINE_DISARMED: approved, engine running-disarmed"
    );
    expect(codes(goLiveSendRefusals(inputs({ node: null })))).toEqual([
      "GO-LIVE ENGINE_DISARMED",
    ]);
  });

  it("refuses an order that differs from the approved one by one cent or one contract", () => {
    for (const order of [
      { ...ORDER, limitPrice: 1.26 },
      { ...ORDER, quantity: 5 },
    ])
      expect(codes(goLiveSendRefusals(inputs({ order })))).toEqual([
        "GO-LIVE ORDER_NOT_APPROVED",
      ]);
  });

  it("refuses a draft that is not an approved entry of the session day", () => {
    expect(
      codes(
        goLiveSendRefusals(inputs({ drafts: [draft({ state: "proposed" })] }))
      )
    ).toEqual(["GO-LIVE DRAFT_NOT_APPROVED"]);
    expect(
      codes(
        goLiveSendRefusals(
          inputs({ drafts: [draft({ tradingDay: "2026-11-12" })] })
        )
      )
    ).toEqual(["GO-LIVE DRAFT_NOT_FOUND"]);
  });

  it("refuses when the plan is not in force", () => {
    expect(
      codes(
        goLiveSendRefusals(
          inputs({ plan: { ...PLAN, status: "proposed" } as GoLivePlanRecord })
        )
      )
    ).toEqual(["GO-LIVE PLAN_NOT_IN_FORCE"]);
  });

  it("counts only the plan's names: a large position outside the plan does not use the plan caps", () => {
    const positions = [
      {
        expiry: "20280121",
        premium: 119_474,
        quantity: 13,
        right: "C",
        secType: "OPT",
        strike: 160,
        symbol: "BE",
      },
    ];
    expect(
      goLiveSendRefusals(
        inputs({
          account: { netLiquidation: 100_000, openOrders: [], positions },
        })
      )
    ).toEqual([]);
  });

  it("counts working orders on the plan's names only", () => {
    const working = (symbol: string) => ({
      expiry: "20261218",
      limitPrice: 30,
      orderRef: `x-${symbol}`,
      orderType: "LMT",
      permId: 1,
      quantity: 2,
      right: "C",
      secType: "OPT",
      side: "BUY",
      status: "Submitted",
      strike: 500,
      symbol,
    });
    // QQQ: 30 x 2 x 100 = 6,000 working on a plan name, over the 4,000 total; BE is not counted.
    expect(
      codes(
        goLiveSendRefusals(
          inputs({
            account: {
              netLiquidation: 100_000,
              openOrders: [working("BE"), working("QQQ")],
              positions: [],
            },
          })
        )
      )
    ).toEqual(["GO-LIVE OPEN_RISK_CAP"]);
  });

  it("applies the caps at send to open positions and working orders", () => {
    // Order max loss 4 x 125 = 500. 3,600 already open elsewhere: 4,100 > 4,000.
    const positions = [
      {
        expiry: "20261218",
        premium: 3600,
        quantity: 2,
        right: "C",
        secType: "OPT",
        strike: 500,
        symbol: "QQQ",
      },
    ];
    expect(
      codes(
        goLiveSendRefusals(
          inputs({
            account: { netLiquidation: 100_000, openOrders: [], positions },
          })
        )
      )
    ).toEqual(["GO-LIVE OPEN_RISK_CAP"]);
  });
});

describe("workingOrderRisks", () => {
  const order = {
    expiry: "20261218",
    limitPrice: 2 as number | null,
    orderRef: "x",
    permId: 1,
    quantity: 1,
    right: "C",
    secType: "OPT",
    side: "BUY",
    status: "Submitted",
    strike: 100,
    symbol: "SPY",
  };
  it("counts an option buy at its limit, a covered sell at 0, a combo as unknown", () => {
    const held = [
      {
        expiry: "20261218",
        premium: 100,
        quantity: 1,
        right: "C",
        secType: "OPT",
        strike: 100,
        symbol: "SPY",
      },
    ];
    expect(
      workingOrderRisks(
        [
          order,
          { ...order, side: "SELL" },
          { ...order, quantity: 2, side: "SELL" },
          { ...order, secType: "BAG" },
        ] as never,
        held
      ).map((r) => r.maxLoss)
    ).toEqual([200, 0, null, null]);
  });

  it("counts two sells against one held long once, a share buy at its cost, a go-live combo at its approved max loss", () => {
    const held = [
      {
        expiry: "20261218",
        premium: 100,
        quantity: 1,
        right: "C",
        secType: "OPT",
        strike: 100,
        symbol: "SPY",
      },
    ];
    expect(
      workingOrderRisks(
        [
          { ...order, side: "SELL" },
          { ...order, side: "SELL" },
          { ...order, limitPrice: 50, quantity: 10, secType: "STK" },
          { ...order, quantity: 10, secType: "STK", side: "SELL" },
          { ...order, orderRef: "vertex-glabc", secType: "BAG" },
          { ...order, limitPrice: null, secType: "STK" },
          { ...order, side: "SELL", strike: 200 },
        ] as never,
        [...held, { ...held[0], secType: "STK", strike: 0 }] as never,
        new Map([["vertex-glabc", 500]])
      ).map((r) => r.maxLoss)
    ).toEqual([0, null, 500, 0, 500, null, null]);
  });
});
