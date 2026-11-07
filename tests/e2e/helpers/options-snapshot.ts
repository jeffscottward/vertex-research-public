import type { GexContext } from "@darkfactory/api";

// Dummy GEX context for mocked optionsAnalytics.snapshot answers in browser specs: every
// value unknown, no factors. The panel requires `context` in every snapshot.
export const EMPTY_GEX_CONTEXT: GexContext = {
  dealerSignAssumption: "dealers long calls, short puts",
  expiry: {
    monthlyOpexDays: 0,
    nextExpiry: null,
    nextExpiryDte: null,
    nextMonthlyOpex: "2026-01-16",
  },
  factors: [],
  flow: {
    bearishPremium: 0,
    bias: "unknown",
    bullishPremium: 0,
    newestTradeAt: null,
    weekShare: null,
    zeroDteShare: null,
  },
  greeks: { netCharm: null, netDex: null, netVanna: null },
  iv: { backIv: null, frontIv: null, regime: "unknown" },
  levels: {
    callWall: null,
    callWallMoves: null,
    dailyMove: null,
    flip: null,
    flipMoves: null,
    putWall: null,
    putWallMoves: null,
  },
  regime: "unknown",
  session: "closed",
};
