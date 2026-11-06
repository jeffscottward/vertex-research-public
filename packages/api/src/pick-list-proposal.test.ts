import { blackScholes } from "@darkfactory/academy";
import { describe, expect, it } from "vitest";

import type {
  PickListProposalRowOutput,
  PickListScreenMemberOutput,
} from "./contracts/pick-lists.ts";
import {
  callDebitSpread,
  monthlyExpiryAtLeast,
  orderProposalRows,
  PROPOSAL_RULES,
  proposalCandidates,
  proposeMember,
  realizedVolatility,
  strikeForDelta,
  strikeIncrement,
  totalMaxLossPct,
} from "./pick-list-proposal.ts";

const PASS = { ok: true, detail: "ok" } as const;

const screened = (
  extra: Partial<PickListScreenMemberOutput> = {}
): PickListScreenMemberOutput => ({
  symbol: "AAA",
  status: "pass",
  last: 100,
  lastDate: "2026-11-04",
  gates: { emaTrend: PASS, aboveVwap20: PASS, notOverextended: PASS },
  quadrant: "leading",
  sector: "Technology",
  sectorEtf: "XLK",
  sectorQuadrant: "leading",
  reason: null,
  ...extra,
});

/** Closes that alternate +1% / -1%: a steady realized volatility near 16%. */
const zigzag = (count: number, start = 100): number[] =>
  Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? start : start * 1.01
  );

describe("monthlyExpiryAtLeast", () => {
  it("returns the first third Friday at least the given days away", () => {
    // 2026-11-05 + 120 days = 2027-03-05; the March third Friday is 2027-03-19.
    expect(monthlyExpiryAtLeast("2026-11-05", 120)).toEqual({
      expiry: "2027-03-19",
      dte: 134,
    });
    // A third Friday exactly on the limit counts.
    expect(monthlyExpiryAtLeast("2026-11-20", 0)).toEqual({
      expiry: "2026-11-20",
      dte: 0,
    });
    expect(() => monthlyExpiryAtLeast("not-a-date", 1)).toThrow(RangeError);
    // A month that starts on a Friday (January 2027).
    expect(monthlyExpiryAtLeast("2026-12-20", 20)).toEqual({
      expiry: "2027-01-15",
      dte: 26,
    });
  });
});

describe("realizedVolatility", () => {
  it("needs 60 returns and ignores non-positive closes", () => {
    expect(realizedVolatility(zigzag(60))).toBeNull();
    expect(realizedVolatility([0, ...zigzag(60)])).toBeNull();
    const vol = realizedVolatility(zigzag(61));
    expect(vol).not.toBeNull();
    expect(vol ?? 0).toBeCloseTo(0.159, 2);
  });

  it("uses at most the last 252 returns", () => {
    const calm = zigzag(400);
    const wild = [
      ...Array.from({ length: 147 }, (_, index) => (index % 2 ? 50 : 100)),
      ...calm.slice(0, 253),
    ];
    expect(realizedVolatility(wild)).toBeCloseTo(
      realizedVolatility(calm) ?? 0,
      10
    );
  });

  it("is null for a flat or nearly flat series", () => {
    expect(realizedVolatility(Array.from({ length: 80 }, () => 10))).toBeNull();
    expect(
      realizedVolatility(
        Array.from({ length: 80 }, (_, index) =>
          index % 2 ? 10 : 10.000_000_1
        )
      )
    ).toBeNull();
  });
});

describe("strikes", () => {
  it("rounds to a listed-strike increment by price level", () => {
    expect(strikeIncrement(10)).toBe(0.5);
    expect(strikeIncrement(60)).toBe(1);
    expect(strikeIncrement(180)).toBe(2.5);
    expect(strikeIncrement(600)).toBe(5);
  });

  it("solves the Black-Scholes delta", () => {
    const strike = strikeForDelta(100, 0.3, 0.4, 0.3);
    const value = blackScholes({
      kind: "call",
      spot: 100,
      strike,
      years: 0.4,
      vol: 0.3,
      rate: PROPOSAL_RULES.riskFreeRate,
    });
    expect(value.delta).toBeCloseTo(0.3, 6);
  });
});

describe("callDebitSpread", () => {
  it("buys the ~0.60 delta call and sells the ~0.30 delta call", () => {
    const spread = callDebitSpread(100, 0.3, "2026-11-05");
    expect(spread).toMatchObject({
      kind: "call-debit-spread",
      expiry: "2027-03-19",
      dte: 134,
    });
    expect(spread.longStrike).toBeLessThan(spread.shortStrike);
    expect(spread.longDelta).toBeCloseTo(0.6, 1);
    expect(spread.shortDelta).toBeCloseTo(0.3, 1);
    expect(spread.maxLossPerSpread).toBeCloseTo(spread.estDebit * 100, 6);
    expect(spread.maxProfitPerSpread).toBeCloseTo(
      (spread.shortStrike - spread.longStrike) * 100 - spread.maxLossPerSpread,
      6
    );
    expect(spread.estDebit).toBeGreaterThan(0);
    expect(spread.estDebit).toBeLessThan(
      spread.shortStrike - spread.longStrike
    );
  });

  it("keeps the short strike above the long strike at tiny volatility", () => {
    const spread = callDebitSpread(10, 0.001, "2026-11-05");
    expect(spread.shortStrike).toBe(spread.longStrike + 0.5);
  });

  it("never rounds a strike to zero", () => {
    const spread = callDebitSpread(0.3, 0.5, "2026-11-05");
    expect(spread.longStrike).toBe(0.5);
    expect(spread.shortStrike).toBe(1);
  });
});

describe("proposeMember", () => {
  const propose = (
    member: PickListScreenMemberOutput,
    closes: readonly number[] | null = zigzag(120)
  ) =>
    proposeMember({
      screened: member,
      closes,
      buckets: ["TMOBY"],
      asOf: "2026-11-05",
    });

  it("proposes a full-size spread when the sector leads", () => {
    const row = propose(screened());
    expect(row).toMatchObject({
      symbol: "AAA",
      buckets: ["TMOBY"],
      tier: "full",
      maxLossPctNlv: 0.5,
      notes:
        "All 3 gates pass; sector XLK leading; own RRG leading. Enter in 3 tranches (40/30/30).",
    });
    expect(row.structure?.kind).toBe("call-debit-spread");
    expect(row.volatility).toBeCloseTo(0.159, 2);
  });

  it("halves the size when the sector does not lead or improve", () => {
    expect(
      propose(screened({ sectorQuadrant: "lagging", quadrant: null }))
    ).toMatchObject({
      tier: "half",
      maxLossPctNlv: 0.25,
      notes:
        "All 3 gates pass; sector XLK lagging; own RRG unknown (half size: rotation not leading or improving). Enter in 3 tranches (40/30/30).",
    });
    expect(propose(screened({ sectorQuadrant: null })).tier).toBe("half");
  });

  it("uses the own quadrant without a sector ETF", () => {
    expect(
      propose(screened({ sectorEtf: null, quadrant: "improving" }))
    ).toMatchObject({
      tier: "full",
      notes:
        "All 3 gates pass; no sector ETF; own RRG improving. Enter in 3 tranches (40/30/30).",
    });
    expect(
      propose(screened({ sectorEtf: null, quadrant: "weakening" })).tier
    ).toBe("half");
  });

  it("proposes no entry when a gate fails", () => {
    const row = propose(
      screened({
        status: "fail",
        gates: {
          emaTrend: { ok: false, detail: "x" },
          aboveVwap20: PASS,
          notOverextended: { ok: false, detail: "y" },
        },
      })
    );
    expect(row).toMatchObject({
      tier: "none",
      maxLossPctNlv: 0,
      structure: null,
      notes: "No entry: gate failed (EMA trend, not overextended). Watch only.",
    });
  });

  it("proposes no entry when data is missing", () => {
    expect(
      propose(screened({ status: "unknown", reason: "No daily bars" }), null)
    ).toMatchObject({
      tier: "none",
      volatility: null,
      notes: "No entry: data missing (No daily bars).",
    });
    expect(propose(screened({ status: "unknown" })).notes).toBe(
      "No entry: data missing (a gate has too little history)."
    );
    expect(propose(screened({ last: null })).tier).toBe("none");
    expect(propose(screened(), zigzag(30))).toMatchObject({
      tier: "none",
      structure: null,
      notes: "No entry: fewer than 60 daily returns for a volatility estimate.",
    });
  });
});

describe("proposal helpers", () => {
  it("merges members across buckets and keeps the first known sector", () => {
    expect(
      proposalCandidates([
        {
          bucketSymbol: "TMOBY",
          listId: "a",
          listName: "A",
          members: [
            { symbol: "NVDA", sector: null },
            { symbol: "AMD", sector: "Technology" },
          ],
        },
        {
          bucketSymbol: "TMOBY",
          listId: "a2",
          listName: "A again",
          members: [{ symbol: "AMD", sector: "Semis" }],
        },
        {
          bucketSymbol: "WISH",
          listId: "b",
          listName: "B",
          members: [{ symbol: "NVDA", sector: "Technology" }],
        },
      ])
    ).toEqual([
      { symbol: "NVDA", sector: "Technology", buckets: ["TMOBY", "WISH"] },
      { symbol: "AMD", sector: "Technology", buckets: ["TMOBY"] },
    ]);
  });

  it("orders full, half, then no-entry rows and sums max loss", () => {
    const row = (
      symbol: string,
      tier: PickListProposalRowOutput["tier"],
      maxLossPctNlv: number
    ) => ({
      ...proposeMember({
        screened: screened({ symbol }),
        closes: null,
        buckets: ["W"],
        asOf: "2026-11-05",
      }),
      tier,
      maxLossPctNlv,
    });
    const rows = [
      row("C", "none", 0),
      row("B", "half", 0.25),
      row("A", "full", 0.5),
      row("D", "half", 0.25),
    ];
    expect(orderProposalRows(rows).map((entry) => entry.symbol)).toEqual([
      "A",
      "B",
      "D",
      "C",
    ]);
    expect(totalMaxLossPct(rows)).toBe(1);
  });

  it("states the owner limits", () => {
    expect(PROPOSAL_RULES).toMatchObject({
      fullMaxLossPct: 0.5,
      halfMaxLossPct: 0.25,
      maxLossGatePct: 2,
      namePremiumCapPct: 2,
      dteMin: 90,
      dteMax: 180,
    });
  });
});
