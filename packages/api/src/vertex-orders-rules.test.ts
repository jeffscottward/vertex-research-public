import { describe, expect, it } from "vitest";

import type { VertexOrderInput } from "./contracts/vertex-orders.ts";
import {
  CONFIRM_TTL_MS,
  consumeConfirmToken,
  issueConfirmToken,
} from "./server/vertex-orders-confirm.ts";
import {
  OrderGatewayError,
  type OrderGatewayPort,
  createBridgeOrderGateway,
  createMockOrderGateway,
} from "./server/vertex-orders-gateway.ts";
import {
  type OrderAccount,
  daysToExpiry,
  evaluateCombo,
  evaluateOrder,
  openPremium,
  parseExpiry,
} from "./server/vertex-orders-rules.ts";

// Fictional account values only.
const TOKEN = "t".repeat(40);
const now = new Date("2026-10-22T15:00:00.000Z");
const LEAPS = "20280121"; // > 365 days
const SHORT = "20261218"; // < 365 days

const order = (
  overrides: Partial<VertexOrderInput> = {}
): VertexOrderInput => ({
  symbol: "ABC",
  secType: "OPT",
  expiry: LEAPS,
  strike: 100,
  right: "C",
  side: "BUY",
  quantity: 1,
  orderType: "LMT",
  limitPrice: 10,
  ...overrides,
});

const account = (overrides: Partial<OrderAccount> = {}): OrderAccount => ({
  netLiquidation: 100_000,
  positions: [],
  openOrders: [],
  gates: { killSwitch: false, optionsOnly: true },
  caps: { leapsMinDays: 365, leapsPct: 6, shortPct: 2 },
  ...overrides,
});

const restingBuy = (expiry: string, limitPrice: number | null) => ({
  permId: 7,
  symbol: "ABC",
  secType: "OPT",
  expiry,
  strike: 150,
  right: "C",
  side: "BUY",
  quantity: 1,
  orderType: "LMT",
  limitPrice,
  status: "Submitted",
  orderRef: "x",
});

describe("vertex order rules", () => {
  it("accepts a LEAPS call buy within the 2% max-loss gate and reports the review", () => {
    const review = evaluateOrder(order({ quantity: 2 }), account(), now);
    expect(review).toMatchObject({
      accepted: true,
      reasons: [],
      premium: 2000,
      premiumPctNlv: 2,
      contractLabel: "ABC 20280121 100 call",
      cap: { kind: "leaps", limitPct: 6, limitAmount: 6000, afterOrder: 2000 },
    });
    expect(review.daysToExpiry).toBeGreaterThanOrEqual(365);
  });

  it("refuses an opening buy above 2% NLV max loss even inside the 6% LEAPS cap", () => {
    const review = evaluateOrder(order({ quantity: 5 }), account(), now);
    expect(review.accepted).toBe(false);
    expect(review.reasons).toEqual([
      "Max loss: this order risks $5000 (5% NLV); new positions are limited to 2% NLV.",
    ]);
    const buyBack = evaluateOrder(
      order({ quantity: 5 }),
      account({
        positions: [
          {
            symbol: "ABC",
            secType: "OPT",
            expiry: LEAPS,
            strike: 100,
            right: "C",
            quantity: -5,
            premium: 0,
          },
        ],
      }),
      now
    );
    expect(buyBack).toMatchObject({ accepted: true, cap: { kind: "none" } });
  });

  it("rejects other security types, bad option fields and non-limit orders", () => {
    const review = evaluateOrder(
      order({ secType: "FUT", orderType: "MKT", right: "", strike: 0 }),
      account(),
      now
    );
    expect(review.accepted).toBe(false);
    const text = review.reasons.join(" ");
    for (const part of [
      "Options only for new positions",
      "Limit orders only",
      "right must be C",
      "strike must be positive",
    ])
      expect(text).toContain(part);
  });

  it("closes or reduces shares; never opens shares (owner 2026-11-04)", () => {
    const shares = (
      quantity: number,
      openOrders: OrderAccount["openOrders"] = []
    ) =>
      account({
        positions: [
          {
            symbol: "ABC",
            secType: "STK",
            expiry: "",
            strike: 0,
            right: "",
            quantity,
            premium: 0,
          },
        ],
        openOrders,
      });
    const stk = (over: Partial<VertexOrderInput> = {}) =>
      order({
        secType: "STK",
        expiry: "",
        strike: 0,
        right: "",
        side: "SELL",
        quantity: 100,
        limitPrice: 9.5,
        ...over,
      });
    // An option order on the same name does not block a share close.
    const optionOrder = { ...restingBuy(LEAPS, 1), strike: 100 };
    expect(evaluateOrder(stk(), shares(100, [optionOrder]), now)).toMatchObject(
      {
        accepted: true,
        contractLabel: "ABC shares",
        premium: 950,
        premiumPctNlv: 0.95,
        heldContracts: 100,
        cap: { kind: "none", label: "No cap: closing sale" },
      }
    );
    expect(
      evaluateOrder(stk({ side: "BUY", quantity: 50 }), shares(-50), now)
    ).toMatchObject({
      accepted: true,
      cap: { label: "No cap: closing buy (covers a short)" },
    });
    expect(
      evaluateOrder(stk({ side: "BUY", quantity: 1 }), shares(100), now)
        .reasons[0]
    ).toContain("options only for new positions");
    expect(
      evaluateOrder(stk({ quantity: 101 }), shares(100), now).accepted
    ).toBe(false);
    const stop = {
      ...restingBuy(LEAPS, null),
      secType: "STK",
      side: "SELL",
      expiry: null,
      strike: null,
      right: null,
    };
    const blocked = evaluateOrder(
      stk({ orderType: "MKT" }),
      {
        ...shares(100, [stop]),
        gates: { killSwitch: true, optionsOnly: false },
        netLiquidation: null,
      },
      now
    );
    expect(blocked.premiumPctNlv).toBeNull();
    for (const part of ["Limit orders only", "cancel it first"])
      expect(blocked.reasons.join(" ")).toContain(part);
    // The kill switch never blocks a close (owner 2026-11-04).
    expect(blocked.reasons.join(" ")).not.toContain("Kill switch");
    // OPTIONS_ONLY off does not block a share close.
    expect(
      evaluateOrder(
        stk(),
        { ...shares(100), gates: { killSwitch: false, optionsOnly: false } },
        now
      ).accepted
    ).toBe(true);
  });

  it("kill switch blocks opening and increasing only; every close passes", () => {
    const killed = (positions: OrderAccount["positions"]) =>
      account({ positions, gates: { killSwitch: true, optionsOnly: true } });
    const long = killed([
      {
        symbol: "ABC",
        secType: "OPT",
        expiry: LEAPS,
        strike: 100,
        right: "C",
        quantity: 2,
        premium: 1000,
      },
    ]);
    expect(
      evaluateOrder(order({ side: "SELL", quantity: 2 }), long, now).accepted
    ).toBe(true);
    expect(
      evaluateOrder(order({ quantity: 1 }), long, now).reasons.join(" ")
    ).toContain("Kill switch is on: no opening or increasing orders");
    const short = killed([
      {
        symbol: "ABC",
        secType: "OPT",
        expiry: LEAPS,
        strike: 100,
        right: "P",
        quantity: -1,
        premium: 0,
      },
    ]);
    expect(
      evaluateOrder(order({ right: "P", quantity: 1 }), short, now).accepted
    ).toBe(true);
    const spread = killed([
      {
        symbol: "ABC",
        secType: "OPT",
        expiry: LEAPS,
        strike: 100,
        right: "C",
        quantity: 1,
        premium: 500,
      },
      {
        symbol: "ABC",
        secType: "OPT",
        expiry: LEAPS,
        strike: 120,
        right: "C",
        quantity: -1,
        premium: 0,
      },
    ]);
    expect(
      evaluateCombo(
        {
          symbol: "ABC",
          quantity: 1,
          limitPrice: -1,
          legs: [
            { expiry: LEAPS, strike: 100, right: "C", side: "SELL", ratio: 1 },
            { expiry: LEAPS, strike: 120, right: "C", side: "BUY", ratio: 1 },
          ],
        },
        spread,
        now
      ).accepted
    ).toBe(true);
  });

  it("closes puts and calls even when OPTIONS_ONLY is off or NLV is unknown; refuses sell-to-open", () => {
    const put = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: SHORT,
          strike: 90,
          right: "P",
          quantity: 3,
          premium: 900,
        },
      ],
      gates: { killSwitch: false, optionsOnly: false },
      netLiquidation: null,
    });
    expect(
      evaluateOrder(
        order({
          expiry: SHORT,
          strike: 90,
          right: "P",
          side: "SELL",
          quantity: 3,
        }),
        put,
        now
      ).accepted
    ).toBe(true);
    // Opening on the same account is blocked by those gates.
    const open = evaluateOrder(order({ quantity: 1 }), put, now).reasons.join(
      " "
    );
    expect(open).toContain("OPTIONS_ONLY");
    expect(open).toContain("Net liquidation is unknown");
    // Sell-to-open of an option not held: refused (no naked short).
    expect(
      evaluateOrder(
        order({ side: "SELL", quantity: 1, strike: 130 }),
        account(),
        now
      ).reasons.join(" ")
    ).toContain(
      "Sell-to-open is only allowed as a leg of a defined-width spread"
    );
    // A working combo on the name blocks a second order.
    const bag = {
      ...restingBuy(SHORT, 1),
      secType: "BAG",
      expiry: null,
      strike: null,
      right: null,
    };
    expect(
      evaluateOrder(
        order({
          expiry: SHORT,
          strike: 90,
          right: "P",
          side: "SELL",
          quantity: 3,
        }),
        { ...put, openOrders: [bag] },
        now
      ).reasons.join(" ")
    ).toContain("combo order on ABC is still working");
  });

  it("applies the 6% LEAPS cap and counts open premium in the name", () => {
    expect(evaluateOrder(order({ quantity: 7 }), account(), now).accepted).toBe(
      false
    );
    const withOpen = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: SHORT,
          strike: 90,
          right: "C",
          quantity: 1,
          premium: 3000,
        },
        {
          symbol: "XYZ",
          secType: "OPT",
          expiry: LEAPS,
          strike: 90,
          right: "C",
          quantity: 1,
          premium: 9000,
        },
      ],
      openOrders: [restingBuy(LEAPS, 20)],
    });
    expect(openPremium(withOpen, "ABC", now, "all")).toBe(5000);
    const badExpiry = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: "bad",
          strike: 1,
          right: "C",
          quantity: 1,
          premium: 100,
        },
      ],
    });
    expect(openPremium(badExpiry, "ABC", now, "short-dated")).toBe(100);
    const review = evaluateOrder(order({ quantity: 2 }), withOpen, now);
    expect(review.cap.openPremium).toBe(5000);
    expect(review.accepted).toBe(false);
    expect(review.reasons[0]).toContain("cap is 6%");
  });

  it("applies the 2% short-dated cap and the 6% name total", () => {
    expect(
      evaluateOrder(order({ expiry: SHORT, quantity: 2 }), account(), now)
        .accepted
    ).toBe(true);
    const tooMuch = evaluateOrder(
      order({ expiry: SHORT, quantity: 3 }),
      account(),
      now
    );
    expect(tooMuch.cap).toMatchObject({ kind: "short-dated", limitPct: 2 });
    expect(tooMuch.reasons[0]).toContain("cap is 2%");
    const nameFull = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: LEAPS,
          strike: 90,
          right: "C",
          quantity: 1,
          premium: 5500,
        },
      ],
      openOrders: [restingBuy(SHORT, null)],
    });
    const review = evaluateOrder(
      order({ expiry: SHORT, quantity: 1 }),
      nameFull,
      now
    );
    expect(review.cap.openPremium).toBe(0);
    expect(review.reasons).toEqual([
      expect.stringContaining("per-name maximum is 6%"),
    ]);
  });

  it("blocks on the kill switch, OPTIONS_ONLY off, unknown NLV, puts and bad expiries", () => {
    const review = evaluateOrder(
      order({ right: "P", expiry: "20261301" }),
      account({
        netLiquidation: null,
        gates: { killSwitch: true, optionsOnly: false },
      }),
      now
    );
    const text = review.reasons.join(" ");
    for (const part of [
      "not a valid date",
      "Kill switch",
      "OPTIONS_ONLY",
      "Net liquidation",
    ])
      expect(text).toContain(part);
    expect(review).toMatchObject({ premiumPctNlv: null, daysToExpiry: 0 });
    expect(review.cap.limitAmount).toBe(0);
    expect(
      evaluateOrder(order({ expiry: "20261022" }), account(), now).reasons
    ).toEqual([
      "Expiry must be after today (only a closing order may trade on expiry day).",
    ]);
    expect(
      evaluateOrder(order({ expiry: "20261021" }), account(), now).reasons
    ).toEqual(["Expiry must be after today."]);
  });

  it("allows closing orders on expiry day and treats a BUY that covers a short as closing", () => {
    const today = "20261022";
    const position = (quantity: number) => ({
      symbol: "ABC",
      secType: "OPT",
      expiry: today,
      strike: 100,
      right: "C",
      quantity,
      premium: 500,
    });
    const sell = evaluateOrder(
      order({ expiry: today, side: "SELL", quantity: 2 }),
      account({ positions: [position(2)] }),
      now
    );
    expect(sell).toMatchObject({ accepted: true, cap: { kind: "none" } });
    const cover = evaluateOrder(
      order({ expiry: today, quantity: 3, limitPrice: 1000 }),
      account({ positions: [position(-3)] }),
      now
    );
    expect(cover).toMatchObject({
      accepted: true,
      cap: { kind: "none", label: "No cap: closing buy (covers a short)" },
    });
    expect(
      evaluateOrder(
        order({ expiry: today, quantity: 4 }),
        account({ positions: [position(-3)] }),
        now
      ).accepted
    ).toBe(false);
  });

  it("allows a SELL only to close held contracts and refuses duplicates", () => {
    const held = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: LEAPS,
          strike: 100,
          right: "C",
          quantity: 2,
          premium: 1000,
        },
      ],
    });
    const close = evaluateOrder(
      order({ side: "SELL", quantity: 2 }),
      held,
      now
    );
    expect(close).toMatchObject({
      accepted: true,
      heldContracts: 2,
      cap: { kind: "none" },
    });
    expect(
      evaluateOrder(order({ side: "SELL", quantity: 3 }), held, now).reasons[0]
    ).toContain("no naked short");
    const duplicate = account({
      openOrders: [
        { ...restingBuy(LEAPS, 1), strike: 100 },
        { ...restingBuy(LEAPS, 1), strike: null },
      ],
    });
    expect(evaluateOrder(order(), duplicate, now).reasons).toContain(
      "An open order for this contract already exists."
    );
    // A resting exit on the contract (any client) blocks a close too: cancel it first.
    const exit = account({
      positions: held.positions,
      openOrders: [{ ...restingBuy(LEAPS, 1), strike: 100, side: "SELL" }],
    });
    expect(
      evaluateOrder(order({ side: "SELL", quantity: 2 }), exit, now).reasons
    ).toContain("An open order for this contract already exists.");
  });

  it("evaluates a spread close as one combo and refuses legging out", () => {
    const spread = account({
      positions: [
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: LEAPS,
          strike: 100,
          right: "C",
          quantity: 4,
          premium: 4000,
        },
        {
          symbol: "ABC",
          secType: "OPT",
          expiry: LEAPS,
          strike: 120,
          right: "C",
          quantity: -2,
          premium: 0,
        },
      ],
    });
    const combo = (over = {}) => ({
      symbol: "ABC",
      quantity: 2,
      limitPrice: -2,
      legs: [
        {
          expiry: LEAPS,
          strike: 100,
          right: "C" as const,
          side: "SELL" as const,
          ratio: 2,
        },
        {
          expiry: LEAPS,
          strike: 120,
          right: "C" as const,
          side: "BUY" as const,
          ratio: 1,
        },
      ],
      ...over,
    });
    expect(evaluateCombo(combo(), spread, now)).toMatchObject({
      accepted: true,
      netAmount: -400,
      label: "ABC combo x2: SELL 2x 20280121 100C / BUY 20280121 120C",
    });
    const bad = evaluateCombo(
      combo({
        quantity: 1,
        legs: [
          {
            expiry: "20261021",
            strike: 100,
            right: "C" as const,
            side: "SELL" as const,
            ratio: 1,
          },
          {
            expiry: "20261021",
            strike: 100,
            right: "C" as const,
            side: "SELL" as const,
            ratio: 1,
          },
        ],
      }),
      account({
        gates: { killSwitch: true, optionsOnly: false },
        openOrders: [
          { ...restingBuy("20261021", 1), strike: 100 },
          { ...restingBuy("20261021", 1), secType: "BAG" },
        ],
      }),
      now
    );
    expect(bad.accepted).toBe(false);
    const text = bad.reasons.join(" ");
    expect(text).not.toContain("Kill switch");
    for (const part of [
      "different contract",
      "does not close the held 0 exactly",
      "expiry is not a valid future date",
      "cancel it first",
      "still working",
    ])
      expect(text).toContain(part);
    // Leg-out guard: a single-leg close on a spread name is refused.
    const legOut = evaluateOrder(
      order({ side: "SELL", quantity: 4 }),
      spread,
      now
    );
    expect(legOut.reasons.join(" ")).toContain("close it as one combo order");
    expect(
      evaluateOrder(
        order({ quantity: 2, strike: 120 }),
        spread,
        now
      ).reasons.join(" ")
    ).toContain("close it as one combo order");
    expect(
      evaluateCombo(
        combo({
          legs: [
            {
              expiry: LEAPS,
              strike: 100,
              right: "C" as const,
              side: "BUY" as const,
              ratio: 2,
            },
            {
              expiry: LEAPS,
              strike: 120,
              right: "C" as const,
              side: "SELL" as const,
              ratio: 1,
            },
          ],
        }),
        spread,
        now
      ).accepted
    ).toBe(false);
  });

  it("uses the caps the gateway reports (pre-deploy gateway: 2% for LEAPS too)", () => {
    const old = account({
      caps: { leapsMinDays: 365, leapsPct: 2, shortPct: 2 },
    });
    const review = evaluateOrder(order({ quantity: 3 }), old, now);
    expect(review.cap).toMatchObject({
      kind: "leaps",
      limitPct: 2,
      label: "LEAPS cap 2% NLV per name",
    });
    expect(review.reasons[0]).toContain("cap is 2%");
  });

  it("ignores share positions for premium and held contracts", () => {
    const shares = account({
      positions: [
        {
          symbol: "ABC",
          secType: "STK",
          expiry: "",
          strike: 0,
          right: "",
          quantity: 100,
          premium: 50_000,
        },
        {
          symbol: "ABC",
          secType: "STK",
          expiry: LEAPS,
          strike: 100,
          right: "C",
          quantity: 5,
          premium: 1,
        },
      ],
    });
    expect(openPremium(shares, "ABC", now, "all")).toBe(0);
    const review = evaluateOrder(order({ side: "SELL" }), shares, now);
    expect(review.heldContracts).toBe(0);
    expect(evaluateOrder(order(), shares, now).accepted).toBe(true);
  });

  it("parses expiries strictly", () => {
    expect(parseExpiry("20260230")).toBeNull();
    expect(parseExpiry("20261023")?.toISOString()).toBe(
      "2026-10-23T00:00:00.000Z"
    );
    expect(daysToExpiry("bad00000", now)).toBeNull();
    expect(daysToExpiry("20261023", now)).toBe(1);
  });
});

describe("vertex order confirm tokens", () => {
  const secret = "s".repeat(40);
  const claims = { userId: "u1", action: "a", nonce: "n1", expiresAt: 1000 };

  it("accepts a valid token once and refuses replays", async () => {
    const token = await issueConfirmToken(secret, claims);
    expect(await consumeConfirmToken(secret, token, claims, 500)).toEqual(
      claims
    );
    expect(await consumeConfirmToken(secret, token, claims, 500)).toBeNull();
    expect(CONFIRM_TTL_MS).toBe(120_000);
  });

  it("refuses tampered, foreign, expired or malformed tokens", async () => {
    const token = await issueConfirmToken(secret, { ...claims, nonce: "n2" });
    expect(
      await consumeConfirmToken("x".repeat(40), token, claims, 500)
    ).toBeNull();
    expect(
      await consumeConfirmToken(secret, `${token}x`, claims, 500)
    ).toBeNull();
    expect(
      await consumeConfirmToken(secret, token, { ...claims, userId: "u2" }, 500)
    ).toBeNull();
    expect(
      await consumeConfirmToken(secret, token, { ...claims, action: "b" }, 500)
    ).toBeNull();
    expect(await consumeConfirmToken(secret, token, claims, 2000)).toBeNull();
    expect(await consumeConfirmToken(secret, "abc", claims, 500)).toBeNull();
    const badClaims = await issueConfirmToken(secret, { ...claims, nonce: "" });
    expect(
      await consumeConfirmToken(secret, badClaims, claims, 500)
    ).toBeNull();
    expect(
      await consumeConfirmToken(secret, "abc.@@@", claims, 500)
    ).toBeNull();
    expect(
      await consumeConfirmToken(secret, token.slice(0, -3), claims, 500)
    ).toBeNull();
    expect(await consumeConfirmToken(secret, "a.b.c", claims, 500)).toBeNull();
  });

  it("fails closed on a correctly signed payload that is not JSON", async () => {
    const { createHmac } = await import("node:crypto");
    for (const payload of ["bm90LWpzb24", "@@@"]) {
      const signature = createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");
      expect(
        await consumeConfirmToken(
          secret,
          `${payload}.${signature}`,
          claims,
          500
        )
      ).toBeNull();
    }
  });

  it("drops expired nonces when a new token is consumed", async () => {
    const first = await issueConfirmToken(secret, {
      ...claims,
      nonce: "old",
      expiresAt: 10,
    });
    expect(await consumeConfirmToken(secret, first, claims, 5)).not.toBeNull();
    const second = await issueConfirmToken(secret, {
      ...claims,
      nonce: "new",
      expiresAt: 100,
    });
    expect(
      await consumeConfirmToken(secret, second, claims, 50)
    ).not.toBeNull();
    const reuse = await issueConfirmToken(secret, {
      ...claims,
      nonce: "old",
      expiresAt: 100,
    });
    expect(await consumeConfirmToken(secret, reuse, claims, 60)).not.toBeNull();
  });
});

describe("vertex order gateways", () => {
  it("mock gateway simulates place and cancel without a network", async () => {
    const gateway = createMockOrderGateway(() => now);
    expect(gateway.mode).toBe("simulated");
    const before = await gateway.account();
    expect(before.gates).toEqual({ killSwitch: false, optionsOnly: true });
    const placed = await gateway.place(order(), "vertex-1");
    expect(placed.state).toBe("submitted");
    expect((await gateway.account()).openOrders).toHaveLength(
      before.openOrders.length + 1
    );
    expect((await gateway.cancel(placed.permId ?? 0)).state).toBe("cancelled");
    expect((await gateway.cancel(1)).state).toBe("not-found");
    expect(createMockOrderGateway().mode).toBe("simulated");
  });

  it("bridge gateway calls only the loopback bridge and validates replies", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const reply = { state: "submitted", permId: 5, message: "ok" };
    const gateway = createBridgeOrderGateway(
      "http://127.0.0.1:3470/",
      async (url, init) => {
        calls.push([url, init]);
        return Response.json(
          url.endsWith("/account")
            ? {
                netLiquidation: 1,
                positions: [],
                openOrders: [],
                gates: { killSwitch: false, optionsOnly: true },
                caps: { leapsMinDays: 365, leapsPct: 2, shortPct: 2 },
              }
            : reply
        );
      },
      TOKEN
    );
    expect(gateway.mode).toBe("live");
    expect((await gateway.account()).netLiquidation).toBe(1);
    expect(await gateway.place(order(), "vertex-2")).toEqual(reply);
    expect(await gateway.cancel(5)).toEqual(reply);
    expect(calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      "GET http://127.0.0.1:3470/account",
      "POST http://127.0.0.1:3470/orders",
      "POST http://127.0.0.1:3470/cancel",
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({
      orderRef: "vertex-2",
    });
    expect(calls[0]?.[1]?.headers).toMatchObject({
      "x-vertex-bridge-token": TOKEN,
    });
  });

  it("bridge gateway fails closed on bad config, network errors and bad replies", async () => {
    const fail = async (gateway: OrderGatewayPort, code: string) => {
      await expect(gateway.account()).rejects.toMatchObject({ code });
    };
    await fail(createBridgeOrderGateway(null), "NOT_CONFIGURED");
    // No or short token: nothing is sent.
    const unsent = async () => {
      throw new Error("must not be called");
    };
    await fail(
      createBridgeOrderGateway("http://127.0.0.1:1", unsent),
      "NOT_CONFIGURED"
    );
    await fail(
      createBridgeOrderGateway("http://127.0.0.1:1", unsent, "short"),
      "NOT_CONFIGURED"
    );
    await fail(
      createBridgeOrderGateway("http://127.0.0.1:1", undefined, TOKEN),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway("https://example.test", undefined, TOKEN),
      "NOT_CONFIGURED"
    );
    await fail(
      createBridgeOrderGateway(
        "http://localhost:1",
        async () => {
          throw new Error("down");
        },
        TOKEN
      ),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway(
        "http://localhost:1",
        async () => new Response("nope", { status: 500 }),
        TOKEN
      ),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway(
        "http://localhost:1",
        async () => Response.json({ netLiquidation: "x" }),
        TOKEN
      ),
      "UPSTREAM_ERROR"
    );
    expect(new OrderGatewayError("UPSTREAM_ERROR", "m").name).toBe(
      "OrderGatewayError"
    );
  });
});
