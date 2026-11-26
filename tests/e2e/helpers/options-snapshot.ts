import type {
  GexContext,
  GreekHeatmapMetricData,
  GreekHeatmapOutput,
} from "@darkfactory/api";

// Dummy GEX context for mocked optionsAnalytics.snapshot answers in browser specs: no value
// was computed (no GEX estimate, flow not received, no IV term data), no factors. The panel
// requires `context` in every snapshot.
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
    bias: "not_received",
    bullishPremium: 0,
    newestTradeAt: null,
    weekShare: null,
    zeroDteShare: null,
  },
  greeks: { netCharm: null, netDex: null, netVanna: null },
  iv: { backIv: null, frontIv: null, regime: "no_term_data" },
  levels: {
    callWall: null,
    callWallMoves: null,
    dailyMove: null,
    flip: null,
    flipMoves: null,
    putWall: null,
    putWallMoves: null,
  },
  profile: [],
  regime: "no_data",
  session: "closed",
};

const EMPTY_GREEK_HEATMAP_METRIC: GreekHeatmapMetricData = {
  expiryTotals: [],
  grandTotal: null,
  marks: {
    callWall: null,
    flip: null,
    kingStrike: null,
    putWall: null,
  },
  message: null,
  rows: [],
  status: "empty",
};

// Dummy empty answer for mocked optionsAnalytics.greekHeatmap requests in browser specs
// where CI has no QuantData API key.
export const EMPTY_GREEK_HEATMAP: GreekHeatmapOutput = {
  expiries: [],
  message: null,
  metrics: {
    charm: EMPTY_GREEK_HEATMAP_METRIC,
    dex: EMPTY_GREEK_HEATMAP_METRIC,
    gex: EMPTY_GREEK_HEATMAP_METRIC,
    vex: EMPTY_GREEK_HEATMAP_METRIC,
    volumeGex: EMPTY_GREEK_HEATMAP_METRIC,
  },
  notes: [],
  rateLimited: false,
  receivedAt: "2024-06-09T00:00:01Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: null,
  status: "empty",
  symbol: "SPY",
};
