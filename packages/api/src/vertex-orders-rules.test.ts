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
  evaluateOrder,
  openPremium,
  parseExpiry,
} from "./server/vertex-orders-rules.ts";

// Fictional account values only.
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

  it("rejects share orders (options only) and non-limit orders", () => {
    const review = evaluateOrder(
      order({ secType: "STK", orderType: "MKT" }),
      account(),
      now
    );
    expect(review.accepted).toBe(false);
    expect(review.reasons.join(" ")).toContain("Options only");
    expect(review.reasons.join(" ")).toContain("Limit orders only");
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
      "Calls only",
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
    ).toContain("no short");
    const duplicate = account({
      openOrders: [
        { ...restingBuy(LEAPS, 1), strike: 100 },
        { ...restingBuy(LEAPS, 1), strike: null },
      ],
    });
    expect(evaluateOrder(order(), duplicate, now).reasons).toContain(
      "An open order for this contract already exists."
    );
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
      }
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
  });

  it("bridge gateway fails closed on bad config, network errors and bad replies", async () => {
    const fail = async (gateway: OrderGatewayPort, code: string) => {
      await expect(gateway.account()).rejects.toMatchObject({ code });
    };
    await fail(createBridgeOrderGateway(null), "NOT_CONFIGURED");
    await fail(
      createBridgeOrderGateway("http://127.0.0.1:1"),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway("https://example.test"),
      "NOT_CONFIGURED"
    );
    await fail(
      createBridgeOrderGateway("http://localhost:1", async () => {
        throw new Error("down");
      }),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway(
        "http://localhost:1",
        async () => new Response("nope", { status: 500 })
      ),
      "UPSTREAM_ERROR"
    );
    await fail(
      createBridgeOrderGateway("http://localhost:1", async () =>
        Response.json({ netLiquidation: "x" })
      ),
      "UPSTREAM_ERROR"
    );
    expect(new OrderGatewayError("UPSTREAM_ERROR", "m").name).toBe(
      "OrderGatewayError"
    );
  });
});
