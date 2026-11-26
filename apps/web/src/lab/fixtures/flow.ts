// What: UI lab fixture for the /flow page: a deterministic flow.snapshot for SPY, QQQ, ES or NQ with
// sampled minutes (and unsampled gaps), a book, options flow, GEX levels, events and confluence,
// a flow.control document per group with a streamed futures tape, a flow.tapeSpeed document for
// ES (bars, bursts, a gap) and NQ (not recorded, quiet, a write fault), and a flow.hedgingPressure
// response for SPY (a rise, then a fall, one open gap) and ES (prints that are not signed, not
// priced or IV adjusted). Every value is fictional.
// Used by: apps/web/src/lab/entries/research.tsx.
import {
  buildFlowLiquidityHeatmap,
  buildFlowLiveDom,
  buildFlowTradeBubbles,
  FLOW_TAPE_SPEED_RULES,
  type FlowControl,
  type FlowGroupId,
  type FlowHedgingPressure,
  type FlowHedgingSymbol,
  type FlowLiquidityHeatmap,
  type FlowLiveDom,
  type FlowLiveDomStreamEvent,
  type FlowLiveDomWindowSeconds,
  type FlowOffExchangeLevels,
  type FlowOffExchangeRange,
  type FlowOptionBubbles,
  type FlowOptionBubblesMinPremiumUsd,
  type FlowOptionBubblesSymbol,
  type FlowPutCallRatio,
  type FlowPutCallRatioSymbol,
  type FlowSnapshot,
  type FlowStrikeHeatmap,
  type FlowStrikeHeatmapBucketMinutes,
  type FlowStrikeHeatmapSymbol,
  type FlowTapeSpeed,
  type FlowTapeSymbol,
  type FlowTradeBubbles,
  foldOffExchangeLevels,
  foldOptionBubbles,
  foldPutCallDays,
  foldPutCallSession,
  foldStrikeHeatmap,
  OFF_EXCHANGE_LEVELS_RULES,
  type OffExchangeEventRow,
  type OffExchangeFinraRow,
  type OffExchangeMinuteRow,
  OPTION_BUBBLES_RULES,
  type OptionBubblesGapRow,
  type OptionBubblesMinuteRow,
  type OptionBubblesPrintRow,
  PUT_CALL_RATIO_RULES,
  type PutCallDayRow,
  type PutCallMinuteRow,
  STRIKE_HEATMAP_RULES,
  type StoredTradeBubbleInput,
  type StoredTradeCandleInput,
  type StrikeHeatmapBucketRow,
  type StrikeHeatmapGapRow,
  type StrikeHeatmapSlotPriceRow,
} from "@darkfactory/api";

import { formatSigned } from "../../features/flow/format.ts";
import {
  createSeededRandom,
  LAB_NOW,
  LAB_NOW_ISO,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

type LabFlowInstrument = Readonly<{
  price: number;
  tick: number;
  ticker: NonNullable<FlowSnapshot["gex"]>["ticker"];
  basis: number;
  offExchangeShare: number | null;
  strike: number;
}>;

const LAB_FLOW_INSTRUMENTS: Readonly<
  Record<FlowSnapshot["symbol"], LabFlowInstrument>
> = {
  ES: {
    basis: 18.5,
    offExchangeShare: null,
    price: 6871.25,
    strike: 6850,
    tick: 0.25,
    ticker: "SPX",
  },
  NQ: {
    basis: 42.5,
    offExchangeShare: null,
    price: 25_480.25,
    strike: 25_450,
    tick: 0.25,
    ticker: "NDX",
  },
  QQQ: {
    basis: 0,
    offExchangeShare: 0.38,
    price: 612.4,
    strike: 612,
    tick: 0.01,
    ticker: "QQQ",
  },
  SPY: {
    basis: 0,
    offExchangeShare: 0.41,
    price: 683.4,
    strike: 685,
    tick: 0.01,
    ticker: "SPY",
  },
};

/** Every ninth minute block has three unsampled minutes, like the real 4-minute sampler. */
const sampled = (offset: number): boolean => offset % 9 < 6;

export const labFlowSnapshot = (
  symbol: FlowSnapshot["symbol"],
  minutes: number
): FlowSnapshot => {
  const instrument = LAB_FLOW_INSTRUMENTS[symbol];
  const random = createSeededRandom(`flow-${symbol}-${minutes}`);
  const start = LAB_NOW.getTime() - minutes * 60_000;
  let cvd = 0;
  const rows = Array.from({ length: minutes }, (_, offset) => offset)
    .filter(sampled)
    .map((offset) => {
      const buyVolume = Math.round(2000 + random() * 6000);
      const sellVolume = Math.round(2000 + random() * 6000);
      const delta = buyVolume - sellVolume;
      cvd += delta;
      const close = roundTo(
        instrument.price + (offset - minutes) * instrument.tick * 4,
        2
      );
      return {
        bearishPremium: Math.round(random() * 400_000),
        bookPressure: roundTo(random() - 0.5, 2),
        bullishPremium: Math.round(random() * 500_000),
        buyVolume,
        callPremium: Math.round(random() * 600_000),
        close,
        coveredSeconds: 60,
        cvd,
        delta,
        minute: new Date(start + offset * 60_000).toISOString(),
        optionTrades: Math.round(random() * 40),
        putPremium: Math.round(random() * 500_000),
        sellVolume,
        trades: Math.round(50 + random() * 300),
        volume: buyVolume + sellVolume,
        vwap: roundTo(close - instrument.tick * 8, 2),
      };
    });
  const volume = rows.reduce((sum, row) => sum + row.volume, 0);
  const coveredSeconds = rows.length * 60;
  const gexLevels = {
    callWall: instrument.strike + 25,
    flip: instrument.strike - 10,
    kingNode: instrument.strike + 25,
    maxPain: instrument.strike,
    putWall: instrument.strike - 40,
  };
  const shift = (value: number): number => value + instrument.basis;
  const snapshot: FlowSnapshot = {
    confluence: {
      bearish: 0,
      bullish: 2,
      factors: [
        {
          detail: "Buyers lifted offers on most sampled minutes.",
          key: "order_flow",
          label: "Order flow (delta)",
          value: formatSigned(cvd),
          vote: "bullish",
        },
        {
          detail: "Bid and ask size were close in the latest book snapshot.",
          key: "book",
          label: "Book pressure",
          value: "+0.04",
          vote: "neutral",
        },
        {
          detail: "Call premium at the ask outweighed put premium.",
          key: "options_flow",
          label: "Options flow",
          value: "$4.2M bullish vs $2.9M bearish",
          vote: "bullish",
        },
        {
          detail: "Context only: dealers long gamma tend to damp moves.",
          key: "gex",
          label: "GEX regime",
          value: "positive",
          vote: "context",
        },
      ],
      known: 3,
      label: "Agree: bullish",
      summary: "agree_bullish",
    },
    events: [
      {
        at: labMinutesAgo(4),
        detail: `${instrument.ticker} ${instrument.strike + 5}C sweep at the ask, $1.4M`,
        direction: "bullish",
        kind: "option_sweep",
        premium: 1_400_000,
        price: null,
        size: 900,
      },
      {
        at: labMinutesAgo(17),
        detail: `25,000 ${symbol} at ${instrument.price.toFixed(2)} on a TRF print`,
        direction: "neutral",
        kind: "large_print",
        premium: null,
        price: instrument.price,
        size: 25_000,
      },
    ],
    freshness: [
      {
        ageSeconds: 75,
        lastOkAt: labMinutesAgo(1.25),
        lastStatus: "ok",
        message: null,
        sessionOpen: true,
        source: "ticks",
        state: "fresh",
      },
      {
        ageSeconds: 75,
        lastOkAt: labMinutesAgo(1.25),
        lastStatus: "ok",
        message: null,
        sessionOpen: true,
        source: "depth",
        state: "fresh",
      },
      {
        ageSeconds: 540,
        lastOkAt: labMinutesAgo(9),
        lastStatus: "empty",
        message: "No new prints since the last sample.",
        sessionOpen: true,
        source: "options",
        state: "stale",
      },
      {
        ageSeconds: 900,
        lastOkAt: labMinutesAgo(15),
        lastStatus: "ok",
        message: null,
        sessionOpen: true,
        source: "gex",
        state: "fresh",
      },
    ],
    generatedAt: LAB_NOW_ISO,
    gex: {
      at: labMinutesAgo(15),
      basis: instrument.basis,
      ivRegime: "contango",
      levels: gexLevels,
      netDex: 3_100_000_000,
      regime: "positive",
      spot: instrument.price - instrument.basis,
      symbolLevels: {
        callWall: shift(gexLevels.callWall),
        flip: shift(gexLevels.flip),
        kingNode: shift(gexLevels.kingNode),
        maxPain: shift(gexLevels.maxPain),
        putWall: shift(gexLevels.putWall),
      },
      ticker: instrument.ticker,
      totalGex: 1_850_000_000,
      zeroDteShare: 0.38,
    },
    minutes: rows,
    notes: [
      "Fictional lab data. coveredSeconds says how much of each minute the tape covered.",
    ],
    optionsFlow: {
      askSidePremium: 5_100_000,
      bearishPremium: 2_900_000,
      bidSidePremium: 2_300_000,
      blockPremium: 1_200_000,
      blocks: 3,
      bullishPremium: 4_200_000,
      callPremium: 5_600_000,
      openingPremiumShare: 0.47,
      otmPremiumShare: 0.62,
      putCallPremiumRatio: 0.66,
      putPremium: 3_700_000,
      sweepPremium: 2_600_000,
      sweeps: 11,
      ticker: instrument.ticker,
      topPrints: [
        {
          at: labMinutesAgo(4),
          consolidation: "sweep",
          contract: `${instrument.ticker}261030C${instrument.strike + 5}`,
          expiry: "2026-10-30",
          goldenSweep: true,
          moneyness: "otm",
          opening: true,
          premium: 1_400_000,
          price: 15.5,
          right: "call",
          sentiment: "bullish",
          side: "ask",
          size: 900,
          strike: instrument.strike + 5,
          unusual: true,
          volumeOverOi: true,
        },
        {
          at: labMinutesAgo(22),
          consolidation: "block",
          contract: `${instrument.ticker}261106P${instrument.strike - 20}`,
          expiry: "2026-11-06",
          goldenSweep: false,
          moneyness: "otm",
          opening: false,
          premium: 640_000,
          price: 8,
          right: "put",
          sentiment: "bearish",
          side: "bid",
          size: 800,
          strike: instrument.strike - 20,
          unusual: false,
          volumeOverOi: false,
        },
      ],
      trades: 184,
      unusual: 6,
      volumeOverOi: 4,
      zeroDtePremiumShare: 0.44,
    },
    orderFlow: {
      book: {
        askSize: 1240,
        at: labMinutesAgo(1.25),
        bestAsk: roundTo(instrument.price + instrument.tick, 2),
        bestBid: instrument.price,
        bidSize: 1340,
        levels: 10,
        pressure: 0.04,
      },
      coveredSeconds,
      delta: cvd,
      deltaRatio: roundTo(cvd / volume, 3),
      largePrints: 3,
      lastPrice: instrument.price,
      offExchangeShare: instrument.offExchangeShare,
      volume,
      vwap: roundTo(instrument.price - instrument.tick * 20, 2),
      windowSeconds: minutes * 60,
    },
    schemaVersion: "flow-snapshot.v1",
    symbol,
    windowEnd: LAB_NOW_ISO,
    windowStart: new Date(start).toISOString(),
  };
  if (symbol === "SPY" || symbol === "ES") return snapshot;
  // NQ samples ticks but has no option prints.
  if (symbol === "NQ")
    return {
      ...snapshot,
      freshness: snapshot.freshness.filter((row) => row.source !== "options"),
      optionsFlow: { ...snapshot.optionsFlow, topPrints: [] },
    };
  // QQQ collects depth and GEX only: no sampled minutes, no option prints.
  return {
    ...snapshot,
    freshness: snapshot.freshness.filter(
      (row) => row.source === "depth" || row.source === "gex"
    ),
    minutes: [],
    optionsFlow: { ...snapshot.optionsFlow, topPrints: [] },
  };
};

const LAB_SESSION_OPEN = Date.parse("2026-10-30T13:30:00.000Z"); // 09:30 New York

const labSeries = (
  ticker: FlowControl["netDrift"][number]["ticker"],
  role: "primary" | "check",
  drift: number
): FlowControl["netDrift"][number] => {
  const points = Array.from({ length: 120 }, (_, index) => {
    const call = roundTo((index + 1) * 40_000 * drift, 0);
    const put = roundTo((index + 1) * 25_000, 0);
    return {
      longer: { netCallPremiumUsd: call * 0.6, netPutPremiumUsd: put * 0.7 },
      minute: new Date(LAB_SESSION_OPEN + index * 60_000).toISOString(),
      total: { netCallPremiumUsd: call, netPutPremiumUsd: put },
      underlyingPrice: null,
      zeroDte: { netCallPremiumUsd: call * 0.4, netPutPremiumUsd: put * 0.3 },
    };
  });
  const call = roundTo(points.length * 40_000 * drift, 0);
  const put = points.length * 25_000;
  const totals = (share: number, putShare: number) => ({
    callMinusPutUsd: call * share - put * putShare,
    netCallPremiumUsd: call * share,
    netCallVolume: 12_000 * share,
    netPutPremiumUsd: put * putShare,
    netPutVolume: 9000 * putShare,
  });
  return {
    asOf: labMinutesAgo(1),
    filterProfile: "otm-clean.v1",
    partsDetail: null,
    partsStatus: "complete",
    points,
    role,
    slopeUsdPerMinute: roundTo(40_000 * drift - 25_000, 0),
    slopeWindowMinutes: 15,
    ticker,
    totals: {
      cumulativeFrom: new Date(LAB_SESSION_OPEN).toISOString(),
      longer: totals(0.6, 0.7),
      total: totals(1, 1),
      zeroDte: totals(0.4, 0.3),
    },
  };
};

/**
 * Fictional deep trades from the streamed tape: ES has 14 trades (9 by the quote rule), 90 covered
 * minutes with two gaps and 2 absorption marks; NQ has 3 trades by the tick rule.
 */
const labDeepTrades = (sp500: boolean): FlowControl["deepTrades"] => {
  const at = (minute: number, second = 0) =>
    new Date(LAB_SESSION_OPEN + minute * 60_000 + second * 1000).toISOString();
  const count = sp500 ? 14 : 3;
  const trades = Array.from({ length: count }, (_, index) => {
    const minute = 100 - index * 6;
    return {
      at: at(minute, 7 + index),
      price: sp500 ? 6870.5 - index * 0.25 : 21_450.25 + index,
      side: index % 3 === 1 ? ("sell" as const) : ("buy" as const),
      signing: !sp500 || index >= 9 ? ("tick" as const) : ("quote" as const),
      size: (sp500 ? 40 : 10) + (index % 4) * 3,
    };
  });
  // Covered minutes 0..99 without two gaps (minutes 20-24 and 60-64): 90 minutes.
  const coveredMinutes = Array.from(
    { length: 100 },
    (_, index) => index
  ).filter(
    (index) => !((index >= 20 && index < 25) || (index >= 60 && index < 65))
  );
  const minutes = coveredMinutes.map((minute) => {
    const inMinute = trades.filter(
      (trade) => trade.at.slice(0, 16) === at(minute).slice(0, 16)
    );
    const volume = (side: "buy" | "sell") =>
      inMinute
        .filter((trade) => trade.side === side)
        .reduce((sum, trade) => sum + trade.size, 0);
    return {
      buyVolume: volume("buy"),
      coveredSeconds: minute % 7 === 0 ? 57 : 60,
      minute: at(minute),
      sellVolume: volume("sell"),
    };
  });
  const buyVolume = trades
    .filter((trade) => trade.side === "buy")
    .reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = trades
    .filter((trade) => trade.side === "sell")
    .reduce((sum, trade) => sum + trade.size, 0);
  return {
    absorptions: sp500
      ? [
          {
            at: at(98),
            detail: "Buy absorption: heavy buying, price held",
            direction: "bearish",
            price: 6871.25,
          },
          {
            at: at(71),
            detail: "Sell absorption: heavy selling, price held",
            direction: "bullish",
            price: null,
          },
        ]
      : [],
    capture: "streamed",
    coverage: sp500
      ? { seenSeconds: 1746, share: 0.97, windowSeconds: 1800 }
      : { seenSeconds: 1800, share: 1, windowSeconds: 1800 },
    limitSize: sp500 ? 40 : 10,
    minutes: sp500 ? minutes : minutes.slice(-6),
    signing: sp500 ? null : "tick",
    sums: {
      buyVolume,
      cumulativeFrom: new Date(LAB_SESSION_OPEN).toISOString(),
      netVolume: buyVolume - sellVolume,
      sellVolume,
    },
    symbol: sp500 ? "ES" : "NQ",
    totalTrades: count,
    trades,
  };
};

/** Fictional agreement: sp500 agrees on buyers; nasdaq100 has mixed options, so no comparison. */
const labAgreement = (sp500: boolean): FlowControl["agreement"] =>
  sp500
    ? {
        detail: "ES futures and SPX options both show buyers in control",
        direction: "bullish",
        label: "Agree: buyers in control on both sides",
        since: "2026-10-30T14:36:00.000Z",
        state: "agree",
      }
    : {
        detail:
          "Options mixed: QQQ bullish, NDX bearish: QQQ ratio 0.36 over the last 30 min; NDX is in control of the other side",
        direction: "neutral",
        label: "Cannot compare",
        since: null,
        state: "not_comparable",
      };

/** Fictional futures side: ES buyers; NQ balanced, held back by too few deep trades. */
const labFuturesSide = (sp500: boolean): FlowControl["futures"] => ({
  asOf: labMinutesAgo(2),
  detail: sp500
    ? "Deep-trade ratio 0.38 over the last 30 min from 14 deep trades; enter ratio 0.30"
    : "Deep-trade ratio 0.41 over the last 30 min from 3 deep trades; enter ratio 0.30; not counted: fewer than 10 deep trades",
  direction: sp500 ? "bullish" : "neutral",
  enterRatio: 0.3,
  hold: sp500 ? null : "few_trades",
  // Net and total deep volume of the window, and its covered minutes.
  inputs: sp500
    ? { denominator: 600, numerator: 228, rows: 30 }
    : { denominator: 39, numerator: 16, rows: 30 },
  instrument: sp500 ? "ES" : "NQ",
  label: sp500 ? "ES futures: buyers in control" : "NQ futures: balanced",
  noDataReason: null,
  ratio: sp500 ? 0.38 : 0.41,
  since: sp500 ? "2026-10-30T14:36:00.000Z" : null,
  state: sp500 ? "buyers" : "balanced",
  trades: sp500 ? 14 : 3,
  windowEnd: labMinutesAgo(1),
  windowStart: labMinutesAgo(31),
});

/**
 * A fictional flow-control.v1 document with a streamed futures tape. sp500: options buyers since
 * 10:31 ET, ES buyers since 10:36 ET, so the two sides agree. nasdaq100: options mixed, NQ balanced
 * with too few deep trades, so the two sides cannot be compared.
 */
export const labFlowControl = (group: FlowGroupId): FlowControl => {
  const sp500 = group === "sp500";
  const primary = sp500 ? "SPX" : "QQQ";
  const check = sp500 ? "SPY" : "NDX";
  const future = sp500 ? "ES" : "NQ";
  return {
    agreement: labAgreement(sp500),
    crossCheck: sp500
      ? {
          detail:
            "Stored SPX option prints point the same way as the vendor net drift (48 prints, 0 unread time ranges)",
          oldestUnreadAt: null,
          result: "same_direction",
          storedPrints: 48,
          ticker: "SPX",
          unreadRanges: 0,
        }
      : {
          detail: "Option prints are not collected for QQQ",
          oldestUnreadAt: null,
          result: "not_collected",
          storedPrints: 0,
          ticker: "QQQ",
          unreadRanges: 0,
        },
    deepTrades: labDeepTrades(sp500),
    freshness: [
      ...[primary, check].map((instrument) => ({
        ageSeconds: 60,
        instrument,
        lastOkAt: labMinutesAgo(1),
        message: null,
        source: "net_drift" as const,
        state: "fresh" as const,
      })),
      {
        ageSeconds: 60,
        instrument: future,
        lastOkAt: labMinutesAgo(1),
        message: null,
        source: "ticks",
        state: "fresh",
      },
    ],
    futures: labFuturesSide(sp500),
    futuresRules: {
      enterRatio: 0.3,
      exitRatio: 0.1,
      maxMissingMinutes: 5,
      minBuckets: 10,
      minCoveredSeconds: 55,
      minMinutes: 5,
      minTrades: 10,
      version: "flow-futures-rules.v1",
      windowMinutes: 30,
    },
    generatedAt: LAB_NOW_ISO,
    group,
    levels: sp500
      ? {
          previousClose: 6848.3,
          sessionHigh: 6880.4,
          sessionLow: 6841,
          sessionOpen: 6852.1,
          source: "one_minute_closes",
          ticker: "SPX",
        }
      : null,
    netDrift: [
      labSeries(primary, "primary", sp500 ? 1.4 : 1.2),
      labSeries(check, "check", sp500 ? 1.1 : 0.4),
    ],
    notes: [
      "Fictional lab data.",
      "Research only; a state describes recent flow and is not a trade signal.",
    ],
    options: {
      asOf: labMinutesAgo(1),
      checkState: sp500 ? "buyers" : "sellers",
      checkTicker: check,
      detail: sp500
        ? "Ratio 0.42 over the last 30 min; enter ratio 0.30"
        : "QQQ ratio 0.36 over the last 30 min; NDX is in control of the other side",
      direction: sp500 ? "bullish" : "neutral",
      enterRatio: 0.3,
      inputs: { denominator: 9_500_000, numerator: 3_990_000, rows: 30 },
      instrument: primary,
      label: sp500
        ? "SPX options: bullish, call buying leads"
        : "Options mixed: QQQ bullish, NDX bearish",
      noDataReason: null,
      primaryTicker: primary,
      ratio: sp500 ? 0.42 : 0.36,
      since: sp500 ? "2026-10-30T14:31:00.000Z" : null,
      state: sp500 ? "buyers" : "mixed",
      windowEnd: labMinutesAgo(1),
      windowStart: labMinutesAgo(31),
    },
    rules: {
      enterRatio: 0.3,
      exitRatio: 0.1,
      minBuckets: 10,
      minMinutes: 5,
      version: "flow-control-rules.v1",
      windowMinutes: 30,
    },
    schemaVersion: "flow-control.v1",
    session: {
      date: "2026-10-30",
      event: sp500 ? null : "fomc",
      futuresOpen: true,
      open: true,
      optionsOpen: true,
    },
    study: {
      agreementDetail: "the agreement is not tested as an entry rule yet",
      detail: "Options-side continuation rule (modelled fills): not tested yet",
      rulesVersion: null,
      status: "not_tested",
      strategyId: "flow-control-continuation",
      testedOn: null,
    },
  };
};

// --- Tape speed ------------------------------------------------------------------------------

type LabTapeBar = FlowTapeSpeed["bars"][number];

const tapeBucketSeconds = (minutes: number): number => {
  if (minutes <= 60) return 10;
  if (minutes <= 120) return 20;
  return 60;
};

const emptyTapeBar = (
  start: string,
  state: LabTapeBar["state"]
): LabTapeBar => ({
  burstSeconds: 0,
  contracts: 0,
  coveredSeconds: 0,
  peakContracts: 0,
  peakTrades: 0,
  start,
  state,
  trades: 0,
});

/**
 * A counted bar: one second at `peak` trades and `rate` trades in each of the other covered
 * seconds, so the busiest second is never above the total of the bar.
 */
const countedTapeBar = (
  start: string,
  covered: number,
  rate: number,
  peak: number,
  burstSeconds = 0
): LabTapeBar => ({
  burstSeconds,
  contracts: rate * (covered - 1) * 3 + peak * 4,
  coveredSeconds: covered,
  peakContracts: peak * 4,
  peakTrades: peak,
  start,
  state: "counted",
  trades: rate * (covered - 1) + peak,
});

/**
 * A deterministic flow.tapeSpeed document. ES: a busy start (rates of 300 to 900 trades per second,
 * a largest second of 2,740), three bursts with marks on four bars (bar 3, bars 90 and 91 for one
 * burst of two seconds, and the bar 40 before the end), bars 120 to 155 without data, bars 170 to
 * 175 partly covered, and the newest minute not stored yet. NQ: the first third collected without
 * per-second counts, then covered minutes without a trade, then quiet bars, no burst, 600 covered
 * seconds that the rule could not evaluate, and the note of a failed per-second write. NQ with
 * 390 minutes: nothing stored.
 */
export const labFlowTapeSpeed = (
  symbol: FlowTapeSymbol,
  minutes: number
): FlowTapeSpeed => {
  const bucket = tapeBucketSeconds(minutes);
  const axisStart =
    Math.floor((LAB_NOW.getTime() - minutes * 60_000) / 60_000) * 60_000;
  const count = ((minutes + 1) * 60) / bucket;
  const startOf = (index: number, seconds = 0): string =>
    new Date(axisStart + (index * bucket + seconds) * 1000).toISOString();
  const base = {
    axisStart: new Date(axisStart).toISOString(),
    bucketSeconds: bucket,
    rules: { ...FLOW_TAPE_SPEED_RULES },
    schemaVersion: "flow-tape-speed.v1" as const,
    symbol,
  };
  if (symbol === "NQ" && minutes === 390)
    return {
      ...base,
      bars: Array.from({ length: count }, (_, index) =>
        emptyTapeBar(startOf(index), "no_data")
      ),
      bursts: [],
      contract: null,
      storedUntil: null,
      tape: {
        ageSeconds: null,
        lastOkAt: null,
        lastStatus: null,
        message: null,
        sessionOpen: true,
        source: "ticks",
        state: "never",
      },
      totals: { bursts: 0, coveredSeconds: 0, evaluatedSeconds: 0 },
    };
  // The newest minute of the axis is not stored yet: the collector stores complete minutes.
  const stored = count - 60 / bucket;
  if (symbol === "NQ") {
    const third = Math.floor(stored / 3);
    const bars = Array.from({ length: count }, (_, index) => {
      if (index >= stored) return emptyTapeBar(startOf(index), "no_data");
      if (index < third) return emptyTapeBar(startOf(index), "not_recorded");
      if (index < 2 * third)
        return countedTapeBar(startOf(index), bucket, 0, 0);
      return countedTapeBar(
        startOf(index),
        bucket,
        6 + (index % 5),
        22 + ((index * 7) % 30)
      );
    });
    const coveredSeconds = bars.reduce(
      (sum, bar) => sum + bar.coveredSeconds,
      0
    );
    return {
      ...base,
      bars,
      bursts: [],
      contract: "NQZ6",
      storedUntil: startOf(stored),
      tape: {
        ageSeconds: 245,
        lastOkAt: new Date(LAB_NOW.getTime() - 245_000).toISOString(),
        lastStatus: "ok",
        message:
          "streamed tape NQZ6: 3184 prints in 2 complete minutes, 120 of 120 s covered; 2 deep trades, 1 new; 211 prints signed by the tick rule, 0 without a side; per-second counts not stored (Error 42501)",
        sessionOpen: true,
        source: "ticks",
        state: "stale",
      },
      totals: {
        bursts: 0,
        coveredSeconds,
        evaluatedSeconds: coveredSeconds - 600,
      },
    };
  }
  const lastBurst = count - 40;
  const peaks: Readonly<Record<number, number>> = {
    3: 2244,
    90: 420,
    91: 380,
    [lastBurst]: 310,
  };
  const bars = Array.from({ length: count }, (_, index) => {
    if (index >= stored || (index >= 120 && index <= 155))
      return emptyTapeBar(startOf(index), "no_data");
    const covered = index >= 170 && index <= 175 ? 7 : bucket;
    const burstPeak = peaks[index];
    if (index <= 5)
      return countedTapeBar(
        startOf(index),
        covered,
        300 + index * 120,
        burstPeak ?? 1500 + index * 248,
        burstPeak === undefined ? 0 : 1
      );
    const rate = 12 + ((index * 7) % 23);
    return countedTapeBar(
      startOf(index),
      covered,
      rate,
      burstPeak ?? rate * 3 + (index % 5),
      burstPeak === undefined ? 0 : 1
    );
  });
  const coveredSeconds = bars.reduce((sum, bar) => sum + bar.coveredSeconds, 0);
  return {
    ...base,
    bars,
    bursts: [
      {
        baseline: 180.4,
        contracts: 8976,
        multiple: 2244 / 180.4,
        peakTrades: 2244,
        seconds: 1,
        start: startOf(3, 4),
      },
      {
        baseline: 14.2,
        contracts: 3200,
        multiple: 420 / 14.2,
        peakTrades: 420,
        seconds: 2,
        // The last second of bar 90 and the first second of bar 91.
        start: startOf(91, -1),
      },
      {
        baseline: 15.5,
        contracts: 1240,
        multiple: 20,
        peakTrades: 310,
        seconds: 1,
        start: startOf(lastBurst, 2),
      },
    ],
    contract: "ESZ6",
    storedUntil: startOf(stored),
    tape: {
      ageSeconds: 40,
      lastOkAt: new Date(LAB_NOW.getTime() - 40_000).toISOString(),
      lastStatus: "ok",
      message:
        "streamed tape ESZ6: 4210 prints in 2 complete minutes, 120 of 120 s covered; 3 deep trades, 1 new; 298 prints signed by the tick rule, 0 without a side",
      sessionOpen: true,
      source: "ticks",
      state: "fresh",
    },
    totals: { bursts: 3, coveredSeconds, evaluatedSeconds: coveredSeconds },
  };
};

// --- Hedging pressure ------------------------------------------------------------------------

type LabHedgingPoint = FlowHedgingPressure["points"][number];

/** The largest minute in one direction (1: rise, -1: fall); the first wins. Both exist here. */
const labLargest = (
  points: readonly LabHedgingPoint[],
  direction: 1 | -1
): NonNullable<FlowHedgingPressure["totals"]["largestRise"]> => {
  let best = { minute: LAB_NOW_ISO, minuteNet: 0 };
  for (const point of points)
    if (point.minuteNet * direction > best.minuteNet * direction)
      best = { minute: point.minute, minuteNet: point.minuteNet };
  return best;
};

/**
 * A deterministic flow.hedgingPressure response for the session of LAB_NOW (Friday 2026-10-30,
 * 09:30 to 16:00 New York). SPY: dealers buy until 12:45 and sell after it, one open gap from
 * 11:10 to 11:25 (no point inside it), every print signed and priced. ES (SPX options): a fall,
 * then a rise, with prints that are not signed, not priced and IV adjusted.
 */
export const labFlowHedgingPressure = (
  symbol: FlowHedgingSymbol
): FlowHedgingPressure => {
  const spy = symbol === "SPY";
  const base = spy ? 580 : 5810;
  const points: LabHedgingPoint[] = [];
  let net = 0;
  let calls = 0;
  let puts = 0;
  let gross = 0;
  let counted = 0;
  for (let index = 0; index < 390; index += 1) {
    // Minutes without a counted print, and for SPY the open gap: no point.
    if (index % 7 === 3 || (spy && index >= 100 && index < 115)) continue;
    const size = 1 + ((index * 5) % 13) / 4;
    const turn = spy ? index < 195 : index >= 150;
    const minuteNet = roundTo((turn ? 1 : -1) * size * (spy ? 1e6 : 4e6), 2);
    // Calls carry more than the minute; puts lean against it.
    const callPart = roundTo(minuteNet * 1.3, 2);
    const putPart = roundTo(minuteNet - callPart, 2);
    net = roundTo(net + minuteNet, 2);
    calls = roundTo(calls + callPart, 2);
    puts = roundTo(puts + putPart, 2);
    gross = roundTo(gross + Math.abs(callPart) + Math.abs(putPart), 2);
    const prints = 1 + (index % 4);
    counted += prints;
    points.push({
      calls,
      minute: new Date(LAB_SESSION_OPEN + index * 60_000).toISOString(),
      minuteNet,
      net,
      price: roundTo(
        base *
          (1 +
            0.004 * Math.sin(index / 45) +
            (turn ? 0.0001 : -0.0001) * (index % 9)),
        2
      ),
      prints,
      puts,
    });
  }
  const notSigned = spy ? 0 : 312;
  const notPriced = spy ? 0 : 14;
  // Minute 389 (15:59) always has a point.
  const newest = LAB_SESSION_OPEN + 389 * 60_000;
  return {
    options: {
      ageSeconds: 50,
      lastOkAt: new Date(LAB_NOW.getTime() - 50_000).toISOString(),
      lastStatus: "ok",
      message: `quantdata flow ${spy ? "SPY" : "SPX"}: 3 pages, 1240 prints`,
      sessionOpen: true,
      source: "options",
      state: "fresh",
    },
    points,
    rules: {
      dividendYield: 0.015,
      rate: 0.04,
      version: "hedging-pressure.v1",
      volFallback: 0.2,
    },
    schemaVersion: "flow-hedging-pressure.v1",
    session: "2026-10-30",
    storedUntil: new Date(newest + 41_000).toISOString(),
    symbol,
    ticker: spy ? "SPY" : "SPX",
    totals: {
      calls,
      gross,
      ivAdjusted: spy ? 0 : 57,
      largestFall: labLargest(points, -1),
      largestRise: labLargest(points, 1),
      net,
      notPriced,
      notSigned,
      prints: counted + notSigned + notPriced,
      puts,
      signed: counted + notPriced,
    },
    truncated: false,
    unread: spy
      ? {
          from: new Date(LAB_SESSION_OPEN + 100 * 60_000).toISOString(),
          ranges: 1,
          to: new Date(LAB_SESSION_OPEN + 115 * 60_000).toISOString(),
        }
      : null,
  };
};

// --- Put/call ratio ----------------------------------------------------------------------------

const LAB_PCR_SESSIONS = [
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-26",
  "2026-10-27",
  "2026-10-28",
  "2026-10-29",
  "2026-10-30",
] as const;

/**
 * A deterministic flow.putCallRatio response for the session of LAB_NOW (Friday 2026-10-30,
 * 09:30 to 16:00 New York) plus 8 stored sessions over two weeks. SPY starts call-heavy then
 * turns put-heavy with one open gap (11:10 to 11:25); ES (SPX options) stays above parity with
 * no open gap.
 */
export const labFlowPutCallRatio = (
  symbol: FlowPutCallRatioSymbol
): FlowPutCallRatio => {
  const spy = symbol === "SPY";
  const base = spy ? 580 : 5810;
  const minuteRows: PutCallMinuteRow[] = [];
  let lastSessionPrice = base;
  for (let index = 0; index < 390; index += 1) {
    if (index % 7 === 3 || (spy && index >= 100 && index < 115)) continue;
    const wave = Math.sin(index / 50);
    const putTilt = spy ? (index < 170 ? 0.72 : 1.55) : 1.25 + 0.25 * wave;
    const callPremium = roundTo(
      (spy ? 950_000 : 3_200_000) * (1 + (index % 5) * 0.15),
      2
    );
    const putPremium = roundTo(callPremium * putTilt, 2);
    const callVolume = Math.round((spy ? 320 : 140) * (1 + (index % 4) * 0.2));
    const putVolume = Math.round(callVolume * (putTilt * (spy ? 0.92 : 1.08)));
    const minute = new Date(LAB_SESSION_OPEN + index * 60_000);
    lastSessionPrice = roundTo(base * (1 + 0.004 * wave), 2);
    minuteRows.push({
      callPremium,
      callPrints: 2 + (index % 3),
      callVolume,
      lastPrice: lastSessionPrice,
      lastTradedAt: new Date(minute.getTime() + 41_000),
      minute,
      putPremium,
      putPrints: 2 + ((index + 1) % 3),
      putVolume,
    });
  }
  const fold = foldPutCallSession(minuteRows);

  const dayRows: PutCallDayRow[] = LAB_PCR_SESSIONS.map((session, index) => {
    if (index === LAB_PCR_SESSIONS.length - 1)
      return {
        callPremium: fold.totals.callPremium,
        callPrints: fold.totals.callPrints,
        callVolume: fold.totals.callVolume,
        lastPrice: lastSessionPrice,
        putPremium: fold.totals.putPremium,
        putPrints: fold.totals.putPrints,
        putVolume: fold.totals.putVolume,
        session,
      };
    const tilt = spy
      ? 0.75 + 0.12 * index + (index % 2 === 0 ? -0.08 : 0.14)
      : 1.05 + 0.08 * Math.sin(index + 1);
    const callPremium = roundTo(
      (spy ? 160_000_000 : 520_000_000) * (0.9 + (index % 3) * 0.12),
      2
    );
    const callVolume = Math.round(
      (spy ? 58_000 : 24_000) * (0.92 + (index % 3) * 0.1)
    );
    return {
      callPremium,
      callPrints: 520 + index * 17,
      callVolume,
      lastPrice: roundTo(base * (0.985 + index * 0.0025), 2),
      putPremium: roundTo(callPremium * tilt, 2),
      putPrints: 500 + index * 23,
      putVolume: Math.round(callVolume * (tilt * 0.95)),
      session,
    };
  });

  const days = foldPutCallDays(
    dayRows,
    (session) => spy && session === "2026-10-30"
  );

  return {
    days,
    options: {
      ageSeconds: 50,
      lastOkAt: new Date(LAB_NOW.getTime() - 50_000).toISOString(),
      lastStatus: "ok",
      message: `quantdata flow ${spy ? "SPY" : "SPX"}: 3 pages, 1240 prints`,
      sessionOpen: true,
      source: "options",
      state: "fresh",
    },
    points: fold.points,
    rules: { ...PUT_CALL_RATIO_RULES },
    schemaVersion: "flow-put-call-ratio.v1",
    session: "2026-10-30",
    storedUntil: fold.storedUntil,
    symbol,
    ticker: spy ? "SPY" : "SPX",
    totals: fold.totals,
    unread: spy
      ? {
          from: new Date(LAB_SESSION_OPEN + 100 * 60_000).toISOString(),
          ranges: 1,
          to: new Date(LAB_SESSION_OPEN + 115 * 60_000).toISOString(),
        }
      : null,
  };
};

type LabHeatmapSpec = Readonly<{
  ageSeconds: number;
  askWallOffset: number;
  basePrice: number;
  bidWallOffset: number;
  capture: "streamed" | "sampled";
  contract: string;
  levelStep: number;
  message: string;
  seed: string;
  sizeBase: number;
  sizeRange: number;
  stepMs: number;
  tradeBase: number;
  tradeMod: number;
  tradeRange: number;
  wallRadius: number;
  wallSize: number;
}>;

const LAB_HEATMAP_SPECS: Readonly<Record<FlowTapeSymbol, LabHeatmapSpec>> = {
  ES: {
    ageSeconds: 8,
    askWallOffset: 4.5,
    basePrice: 5912,
    bidWallOffset: -2,
    capture: "streamed",
    contract: "ESZ6",
    levelStep: 0.5,
    message: "streamed depth ESZ6: 12 snapshots, 20 levels",
    seed: "flow-liquidity-heatmap-es",
    sizeBase: 22,
    sizeRange: 34,
    stepMs: 30_000,
    tradeBase: 32,
    tradeMod: 14,
    tradeRange: 85,
    wallRadius: 0.75,
    wallSize: 140,
  },
  NQ: {
    ageSeconds: 42,
    askWallOffset: 8,
    basePrice: 20_640,
    bidWallOffset: -18,
    capture: "sampled",
    contract: "NQZ6",
    levelStep: 2,
    message: "20 levels",
    seed: "flow-liquidity-heatmap-nq",
    sizeBase: 8,
    sizeRange: 12,
    stepMs: 60_000,
    tradeBase: 12,
    tradeMod: 21,
    tradeRange: 28,
    wallRadius: 3,
    wallSize: 45,
  },
};

const buildLabHeatmapDepthSide = (
  best: number,
  direction: -1 | 1,
  wallPrice: number,
  spec: LabHeatmapSpec,
  rand: () => number
): Readonly<{ prices: number[]; sizes: number[] }> => {
  const prices: number[] = [];
  const sizes: number[] = [];
  for (let lvl = 0; lvl < 10; lvl++) {
    const price = best + direction * lvl * spec.levelStep;
    const bonus =
      Math.abs(price - wallPrice) <= spec.wallRadius ? spec.wallSize : 0;
    prices.push(price);
    sizes.push(Math.round(spec.sizeBase + rand() * spec.sizeRange + bonus));
  }
  return { prices, sizes };
};

/**
 * Deterministic flow.liquidityHeatmap fixture for the dev lab and tests.
 * - ES: streamed CME L2 snapshots with a persistent bid wall, overhead ask wall, a brief gap, and
 *   buy/sell large futures trade dots.
 * - NQ (390 min): empty (never collected) state.
 * - NQ (other windows): 1-minute sampled fallback snapshots with a persistent ask wall.
 */
export const labFlowLiquidityHeatmap = (
  symbol: FlowTapeSymbol,
  minutes: number
): FlowLiquidityHeatmap => {
  const windowEnd = LAB_NOW;
  const windowStart = new Date(windowEnd.getTime() - minutes * 60_000);
  if (symbol === "NQ" && minutes === 390) {
    return buildFlowLiquidityHeatmap({
      depth: {
        ageSeconds: null,
        lastOkAt: null,
        lastStatus: null,
        message: null,
        sessionOpen: true,
        source: "depth",
        state: "never",
      },
      largeTrades: [],
      minutes,
      now: windowEnd,
      snapshots: [],
      symbol,
      windowEnd,
      windowStart,
    });
  }

  const spec = LAB_HEATMAP_SPECS[symbol];
  const minTick = 0.25;
  const rand = createSeededRandom(spec.seed);
  const count = Math.min(180, Math.floor((minutes * 60_000) / spec.stepMs));
  const gapStart = Math.floor(count * 0.42);
  const gapEnd = symbol === "ES" ? gapStart + 2 : -1;

  const snapshots: Parameters<
    typeof buildFlowLiquidityHeatmap
  >[0]["snapshots"][number][] = [];
  const largeTrades: Parameters<
    typeof buildFlowLiquidityHeatmap
  >[0]["largeTrades"][number][] = [];

  for (let i = 0; i < count; i++) {
    if (i >= gapStart && i <= gapEnd) continue;
    const tMs = windowStart.getTime() + (i + 1) * spec.stepMs;
    const drift =
      symbol === "ES"
        ? Math.sin(i / 7) * 2.5 + (i / count) * 3.5
        : -Math.cos(i / 6) * 14 - (i / count) * 18;
    const mid = Math.round((spec.basePrice + drift) * 4) / 4;
    const bestBid = mid - minTick;
    const bestAsk = mid + minTick;
    const bids = buildLabHeatmapDepthSide(
      bestBid,
      -1,
      spec.basePrice + spec.bidWallOffset,
      spec,
      rand
    );
    const asks = buildLabHeatmapDepthSide(
      bestAsk,
      1,
      spec.basePrice + spec.askWallOffset,
      spec,
      rand
    );
    snapshots.push({
      askPrices: asks.prices,
      askSizes: asks.sizes,
      bestAsk,
      bestBid,
      bidPrices: bids.prices,
      bidSizes: bids.sizes,
      capture: spec.capture,
      capturedAt: new Date(tMs),
      contract: spec.contract,
      minTick,
    });
    if (i % 7 === 3) {
      const buy = i % spec.tradeMod === 3;
      largeTrades.push({
        capture: "streamed",
        price: buy ? bestAsk : bestBid,
        second: new Date(tMs),
        seq: i,
        side: buy ? "buy" : "sell",
        signing: i % 3 === 0 ? "tick" : "quote",
        size: Math.round(spec.tradeBase + rand() * spec.tradeRange),
      });
    }
  }

  return buildFlowLiquidityHeatmap({
    depth: {
      ageSeconds: spec.ageSeconds,
      lastOkAt: new Date(
        windowEnd.getTime() - spec.ageSeconds * 1000
      ).toISOString(),
      lastStatus: "ok",
      message: spec.message,
      sessionOpen: true,
      source: "depth",
      state: "fresh",
    },
    largeTrades,
    minutes,
    now: windowEnd,
    snapshots,
    symbol,
    windowEnd,
    windowStart,
  });
};

const LAB_SESSION_CLOSE = LAB_SESSION_OPEN + 405 * 60_000; // 16:15 New York

const isSlotInLabGap = (
  slotStartMs: number,
  slotEndMs: number,
  gapStartMs: number,
  gapEndMs: number,
  spy: boolean
): boolean => spy && slotStartMs < gapEndMs && slotEndMs > gapStartMs;

const buildLabSlotPrices = (
  spy: boolean,
  bucketMinutes: FlowStrikeHeatmapBucketMinutes,
  slotCount: number,
  basePrice: number,
  gapStartMs: number,
  gapEndMs: number
): StrikeHeatmapSlotPriceRow[] => {
  const slotPrices: StrikeHeatmapSlotPriceRow[] = [];
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const slotStartMs = LAB_SESSION_OPEN + slotIndex * bucketMinutes * 60_000;
    const slotEndMs = Math.min(
      LAB_SESSION_CLOSE,
      slotStartMs + bucketMinutes * 60_000
    );
    if (isSlotInLabGap(slotStartMs, slotEndMs, gapStartMs, gapEndMs, spy))
      continue;
    const drift =
      slotIndex === slotCount - 1
        ? 0
        : roundTo(Math.sin(slotIndex / 3) * (spy ? 1.35 : 14), 2);
    slotPrices.push({
      price: roundTo(basePrice + drift, 2),
      pricedAt: new Date(slotEndMs - 15_000),
      slotIndex,
    });
  }
  return slotPrices;
};

const buildLabStrikeSlotBuckets = (
  spy: boolean,
  slotCount: number,
  weight: number,
  strikeIdx: number,
  strike: number,
  slotIndex: number,
  lastTradedAt: Date
): StrikeHeatmapBucketRow[] => {
  if (strikeIdx === 10 && slotIndex === 2) {
    return [
      {
        lastTradedAt,
        premium: spy ? 145_000 : 420_000,
        prints: 3,
        right: "call",
        side: "mid",
        slotIndex,
        strike,
        volume: 90,
      },
    ];
  }
  const bullishPhase = spy
    ? slotIndex < Math.floor(slotCount * 0.52)
    : (strikeIdx + slotIndex) % 2 === 0;
  const basePremium = (spy ? 680_000 : 2_100_000) * weight;
  const primaryPremium = roundTo(
    basePremium * (0.65 + ((strikeIdx * 3 + slotIndex) % 5) * 0.2),
    2
  );
  return [
    {
      lastTradedAt,
      premium: primaryPremium,
      prints: 4 + ((strikeIdx + slotIndex) % 6),
      right: bullishPhase ? "call" : "put",
      side: "ask",
      slotIndex,
      strike,
      volume: Math.round((spy ? 240 : 95) * weight),
    },
    {
      lastTradedAt,
      premium: roundTo(primaryPremium * 0.28, 2),
      prints: 2 + (slotIndex % 3),
      right: bullishPhase ? "put" : "call",
      side: "ask",
      slotIndex,
      strike,
      volume: Math.round((spy ? 80 : 35) * weight),
    },
  ];
};

const buildLabStrikeBucketsForStrike = (
  spy: boolean,
  bucketMinutes: FlowStrikeHeatmapBucketMinutes,
  slotCount: number,
  basePrice: number,
  gapStartMs: number,
  gapEndMs: number,
  strikeIdx: number,
  strike: number
): StrikeHeatmapBucketRow[] => {
  const out: StrikeHeatmapBucketRow[] = [];
  const distanceFromCenter = Math.abs(strike - basePrice);
  const weight = spy
    ? Math.max(0.12, 1.35 - distanceFromCenter * 0.1)
    : Math.max(0.25, 1.3 - distanceFromCenter * 0.025);
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    if ((strikeIdx + slotIndex) % 3 !== 0) continue;
    const slotStartMs = LAB_SESSION_OPEN + slotIndex * bucketMinutes * 60_000;
    const slotEndMs = Math.min(
      LAB_SESSION_CLOSE,
      slotStartMs + bucketMinutes * 60_000
    );
    if (isSlotInLabGap(slotStartMs, slotEndMs, gapStartMs, gapEndMs, spy))
      continue;
    out.push(
      ...buildLabStrikeSlotBuckets(
        spy,
        slotCount,
        weight,
        strikeIdx,
        strike,
        slotIndex,
        new Date(slotEndMs - 20_000)
      )
    );
  }
  return out;
};

/**
 * A deterministic flow.strikeHeatmap response for the session of LAB_NOW (Friday 2026-10-30,
 * 09:30 to 16:15 New York) at 5m, 15m, or 30m buckets. SPY has 23 active strikes (top 20 shown,
 * 3 minor omitted), one open collector gap (11:10 to 11:25), an unsigned flat cell, and latest
 * spot between displayed strikes. ES (SPX options) has 12 strikes, exact-strike spot, and no gap.
 */
export const labFlowStrikeHeatmap = (
  symbol: FlowStrikeHeatmapSymbol,
  bucketMinutes: FlowStrikeHeatmapBucketMinutes = STRIKE_HEATMAP_RULES.defaultBucketMinutes
): FlowStrikeHeatmap => {
  const spy = symbol === "SPY";
  const slotCount = Math.ceil(405 / bucketMinutes);
  const strikes = spy
    ? Array.from({ length: 23 }, (_, i) => 570 + i)
    : Array.from({ length: 12 }, (_, i) => 5780 + i * 5);
  const gapStart = new Date(LAB_SESSION_OPEN + 100 * 60_000);
  const gapEnd = new Date(LAB_SESSION_OPEN + 115 * 60_000);
  const gaps: StrikeHeatmapGapRow[] = spy
    ? [{ endTime: gapEnd, startTime: gapStart }]
    : [];
  const basePrice = spy ? 581.45 : 5810;
  const slotPrices = buildLabSlotPrices(
    spy,
    bucketMinutes,
    slotCount,
    basePrice,
    gapStart.getTime(),
    gapEnd.getTime()
  );
  const buckets = strikes.flatMap((strike, strikeIdx) =>
    buildLabStrikeBucketsForStrike(
      spy,
      bucketMinutes,
      slotCount,
      basePrice,
      gapStart.getTime(),
      gapEnd.getTime(),
      strikeIdx,
      strike
    )
  );

  const fold = foldStrikeHeatmap({
    bucketMinutes,
    buckets,
    gaps,
    range: {
      from: new Date(LAB_SESSION_OPEN),
      to: new Date(LAB_SESSION_CLOSE),
    },
    slotPrices,
  });

  return {
    bucketMinutes,
    cells: fold.cells,
    options: {
      ageSeconds: 50,
      lastOkAt: new Date(LAB_NOW.getTime() - 50_000).toISOString(),
      lastStatus: "ok",
      message: `quantdata flow ${spy ? "SPY" : "SPX"}: 3 pages, 1240 prints`,
      sessionOpen: true,
      source: "options",
      state: "fresh",
    },
    rules: { ...STRIKE_HEATMAP_RULES },
    schemaVersion: "flow-strike-heatmap.v1",
    session: "2026-10-30",
    slots: fold.slots,
    storedUntil: fold.storedUntil,
    strikes: fold.strikes,
    symbol,
    ticker: spy ? "SPY" : "SPX",
    totals: fold.totals,
    unread: spy
      ? {
          from: gapStart.toISOString(),
          ranges: 1,
          to: gapEnd.toISOString(),
        }
      : null,
  };
};

/** Deterministic Jigsaw-style Live DOM ladder fixture for /lab/flow and tests (ES or NQ). */
export const labFlowLiveDom = (
  symbol: FlowTapeSymbol,
  windowSeconds: FlowLiveDomWindowSeconds = 900,
  since: number | null = null
): FlowLiveDom => {
  const isEs = symbol === "ES";
  const baseBid = isEs ? 6012.25 : 21_140.25;
  const scale = since === null ? 1 : 0.25;
  return buildFlowLiveDom({
    asks: [
      [baseBid + 0.25, isEs ? 52 : 18],
      [baseBid + 0.5, isEs ? 86 : 24],
      [baseBid + 0.75, isEs ? 215 : 42],
      [baseBid + 1.0, isEs ? 148 : 31],
      [baseBid + 1.25, isEs ? 94 : 19],
    ],
    bids: [
      [baseBid, isEs ? 68 : 22],
      [baseBid - 0.25, isEs ? 264 : 58],
      [baseBid - 0.5, isEs ? 112 : 29],
      [baseBid - 0.75, isEs ? 140 : 35],
      [baseBid - 1.0, isEs ? 95 : 21],
    ],
    capturedAt: "2026-10-30T15:00:00.000Z",
    contract: isEs ? "ESZ6" : "NQZ6",
    depthFeed: {
      error: null,
      lastAt: "2026-10-30T15:00:00.000Z",
      state: "live",
    },
    depthUpdates: isEs ? 1240 : 890,
    lastTrade: {
      price: baseBid + 0.25,
      side: "buy",
      size: isEs ? 6 : 2,
      t: "2026-10-30T14:59:59.000Z",
    },
    minTick: 0.25,
    seq: isEs ? 1540 : 1090,
    since,
    source: "live_stream",
    symbol,
    tapeFeed: {
      error: null,
      lastAt: "2026-10-30T14:59:59.000Z",
      state: "live",
    },
    tapeSeq: isEs ? 300 : 200,
    volumeByPrice: [
      [baseBid + 0.75, Math.round(168 * scale), Math.round(84 * scale), 0, 14],
      [baseBid + 0.5, Math.round(110 * scale), Math.round(72 * scale), 0, 11],
      [baseBid + 0.25, Math.round(240 * scale), Math.round(60 * scale), 0, 24],
      [baseBid, Math.round(45 * scale), Math.round(195 * scale), 0, 19],
      [baseBid - 0.25, Math.round(310 * scale), Math.round(290 * scale), 0, 42],
      [baseBid - 0.5, Math.round(125 * scale), Math.round(140 * scale), 0, 16],
    ],
    volumeSource: "streamed_tape",
    windowSeconds,
  });
};

/** Deterministic single-frame async stream for /lab/flow and workspace tests. */
export const labFlowLiveDomStream = (
  symbol: FlowTapeSymbol,
  windowSeconds: FlowLiveDomWindowSeconds = 900,
  since: number | null = null,
  signal?: AbortSignal
): AsyncIterable<FlowLiveDomStreamEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield {
      frame: labFlowLiveDom(symbol, windowSeconds, since),
      type: "frame",
    };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  },
});

export const labFlowTradeBubbles = (
  symbol: FlowTapeSymbol,
  minutes = 120
): FlowTradeBubbles => {
  const rand = createSeededRandom(
    `lab-flow-trade-bubbles-${symbol}-${minutes}`
  );
  const windowEnd = new Date(LAB_NOW.getTime());
  const windowStart = new Date(windowEnd.getTime() - minutes * 60_000);
  const isEs = symbol === "ES";
  const basePrice = isEs ? 5812.25 : 20_418.5;
  const tick = 0.25;
  const limitSize = isEs ? 40 : 10;
  const minuteBars: StoredTradeCandleInput[] = [];
  const largeTrades: StoredTradeBubbleInput[] = [];

  let price = basePrice;
  let cumulativeNotional = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < minutes; i += 1) {
    const minuteMs = windowStart.getTime() + i * 60_000;
    const open = price;
    const drift = Math.round((rand() - 0.48) * (isEs ? 8 : 24)) * tick;
    const close = roundTo(open + drift, 2);
    const high = roundTo(
      Math.max(open, close) + Math.ceil(rand() * (isEs ? 4 : 12)) * tick,
      2
    );
    const low = roundTo(
      Math.min(open, close) - Math.ceil(rand() * (isEs ? 4 : 12)) * tick,
      2
    );
    const volume = Math.round(
      (isEs ? 900 : 420) + rand() * (isEs ? 1100 : 580)
    );
    cumulativeNotional += ((high + low + close) / 3) * volume;
    cumulativeVolume += volume;
    const vwap = roundTo(cumulativeNotional / cumulativeVolume, 2);
    minuteBars.push({
      close,
      coveredSeconds: 60,
      high,
      low,
      minute: new Date(minuteMs),
      open,
      volume,
      vwap,
    });

    if (i % 5 === 2) {
      const buy = (i + (isEs ? 0 : 1)) % 3 !== 0;
      const size = Math.round(limitSize * (1 + rand() * 3.2));
      const tradePrice = roundTo(
        low + Math.round(rand() * ((high - low) / tick)) * tick,
        2
      );
      largeTrades.push({
        capture: "streamed",
        limitSize,
        price: tradePrice,
        second: new Date(minuteMs + Math.round(rand() * 55) * 1000),
        seq: 0,
        side: buy ? "buy" : "sell",
        signing: i % 4 === 0 ? "tick" : "quote",
        size,
      });
    }
    price = close;
  }

  return buildFlowTradeBubbles({
    largeTrades,
    minuteBars,
    minutes,
    symbol,
    tape: {
      ageSeconds: 8,
      lastOkAt: new Date(windowEnd.getTime() - 8000).toISOString(),
      lastStatus: "ok",
      message: `streamed tape ${symbol}: ${largeTrades.length} deep prints`,
      sessionOpen: true,
      source: "ticks",
      state: "fresh",
    },
    windowEnd,
    windowStart,
  });
};

/**
 * A deterministic flow.optionBubbles response for the session of LAB_NOW (Friday 2026-10-30,
 * 09:30 to 16:15 New York). SPY includes calls and puts across above_ask, ask, bid, below_bid,
 * and mid sides, golden sweeps, one open collector gap (11:10 to 11:25 ET), and one unplotted
 * print. ES (SPX options) includes larger index prints with no open gap.
 */
export const labFlowOptionBubbles = (
  symbol: FlowOptionBubblesSymbol,
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd = OPTION_BUBBLES_RULES.defaultMinPremiumUsd
): FlowOptionBubbles => {
  const spy = symbol === "SPY";
  const ticker = spy ? "SPY" : "SPX";
  const basePrice = spy ? 581.45 : 5810;
  const step = spy ? 0.14 : 1.4;
  const gapStart = new Date(LAB_SESSION_OPEN + 100 * 60_000);
  const gapEnd = new Date(LAB_SESSION_OPEN + 115 * 60_000);
  const gaps: OptionBubblesGapRow[] = spy
    ? [{ endTime: gapEnd, startTime: gapStart }]
    : [];

  const minutes: OptionBubblesMinuteRow[] = [];
  for (let offset = 0; offset < 360; offset += 5) {
    const minuteMs = LAB_SESSION_OPEN + offset * 60_000;
    if (spy && minuteMs >= gapStart.getTime() && minuteMs < gapEnd.getTime())
      continue;
    const wave = Math.sin(offset / 35) * 10 + (offset / 360) * 14;
    const price = roundTo(basePrice + wave * step, 2);
    minutes.push({
      callPremium: spy ? 420_000 : 1_100_000,
      callPrints: 8,
      lastPrice: price,
      lastTradedAt: new Date(minuteMs + 40_000),
      minute: new Date(minuteMs),
      putPremium: spy ? 360_000 : 950_000,
      putPrints: 6,
    });
  }

  const templates: readonly Readonly<{
    offsetMin: number;
    premium: number;
    right: "call" | "put";
    side: OptionBubblesPrintRow["side"];
    consolidation: OptionBubblesPrintRow["consolidation"];
    strikeDelta: number;
    goldenSweep?: boolean;
    unusual?: boolean;
    opening?: boolean;
    volumeOverOi?: boolean;
    unplotted?: boolean;
  }>[] = [
    {
      consolidation: "sweep",
      offsetMin: 18,
      opening: true,
      premium: spy ? 185_000 : 320_000,
      right: "call",
      side: "ask",
      strikeDelta: 2,
    },
    {
      consolidation: "sweep",
      goldenSweep: true,
      offsetMin: 44,
      opening: true,
      premium: spy ? 1_420_000 : 2_850_000,
      right: "call",
      side: "above_ask",
      strikeDelta: 4,
      unusual: true,
      volumeOverOi: true,
    },
    {
      consolidation: "block",
      offsetMin: 78,
      premium: spy ? 680_000 : 1_350_000,
      right: "put",
      side: "ask",
      strikeDelta: -3,
      unusual: true,
    },
    {
      consolidation: "split",
      offsetMin: 132,
      premium: spy ? 460_000 : 880_000,
      right: "call",
      side: "bid",
      strikeDelta: 5,
    },
    {
      consolidation: "sweep",
      goldenSweep: true,
      offsetMin: 185,
      premium: spy ? 1_850_000 : 3_400_000,
      right: "put",
      side: "above_ask",
      strikeDelta: -2,
      unusual: true,
      volumeOverOi: true,
    },
    {
      consolidation: "block",
      offsetMin: 224,
      premium: spy ? 390_000 : 720_000,
      right: "put",
      side: "below_bid",
      strikeDelta: -4,
    },
    {
      consolidation: "other",
      offsetMin: 268,
      premium: spy ? 310_000 : 540_000,
      right: "call",
      side: "mid",
      strikeDelta: 0,
    },
    {
      consolidation: "sweep",
      offsetMin: 312,
      opening: true,
      premium: spy ? 940_000 : 1_900_000,
      right: "call",
      side: "ask",
      strikeDelta: 3,
      volumeOverOi: true,
    },
    {
      consolidation: "block",
      offsetMin: 334,
      premium: spy ? 280_000 : 490_000,
      right: "put",
      side: "unknown",
      strikeDelta: -1,
      unplotted: spy,
    },
  ];

  const prints: OptionBubblesPrintRow[] = templates.map((item, idx) => {
    const wave =
      Math.sin(item.offsetMin / 35) * 10 + (item.offsetMin / 360) * 14;
    const spot = roundTo(basePrice + wave * step, 2);
    const strikeStep = spy ? 1 : 5;
    const strike =
      Math.round(spot / strikeStep) * strikeStep +
      item.strikeDelta * strikeStep;
    const optionPrice = spy ? 3.4 : 24.5;
    return {
      consolidation: item.consolidation,
      dte: 7,
      expiry: "2026-11-06",
      goldenSweep: item.goldenSweep === true,
      id: `lab-bub-${symbol.toLowerCase()}-${idx + 1}`,
      iv: spy ? 17.8 : 16.4,
      moneyness: item.strikeDelta === 0 ? "atm" : "otm",
      openInterest: 5000,
      opening: item.opening === true,
      premium: item.premium,
      price: optionPrice,
      right: item.right,
      sentiment:
        item.side === "mid" || item.side === "unknown"
          ? "neutral"
          : (item.right === "call") ===
              (item.side === "ask" || item.side === "above_ask")
            ? "bullish"
            : "bearish",
      side: item.side,
      size: Math.max(10, Math.round(item.premium / (optionPrice * 100))),
      strike,
      ticker,
      tradedAt: new Date(LAB_SESSION_OPEN + item.offsetMin * 60_000 + 22_000),
      underlyingPrice: item.unplotted ? null : spot,
      unusual: item.unusual === true,
      volumeOverOi: item.volumeOverOi === true,
    };
  });

  const range = {
    from: new Date(LAB_SESSION_OPEN),
    to: new Date(LAB_SESSION_CLOSE),
  };
  const fold = foldOptionBubbles({
    gaps,
    minPremiumUsd,
    minutes,
    prints,
    range,
  });

  return {
    bubbles: fold.bubbles,
    gaps: fold.gaps,
    minPremiumUsd,
    options: {
      ageSeconds: 45,
      lastOkAt: new Date(LAB_NOW.getTime() - 45_000).toISOString(),
      lastStatus: "ok",
      message: `quantdata flow ${ticker}: 3 pages, 1240 prints`,
      sessionOpen: true,
      source: "options",
      state: "fresh",
    },
    pricePoints: fold.pricePoints,
    rules: { ...OPTION_BUBBLES_RULES },
    schemaVersion: "flow-option-bubbles.v1",
    session: "2026-10-30",
    sessionEnd: range.to.toISOString(),
    sessionStart: range.from.toISOString(),
    storedUntil: fold.storedUntil,
    symbol,
    ticker,
    totals: fold.totals,
    truncated: fold.truncated,
    unread: fold.unread,
  };
};

const LAB_OFF_EXCHANGE_SESSIONS = [
  "2026-10-26",
  "2026-10-27",
  "2026-10-28",
  "2026-10-29",
  "2026-10-30",
] as const;

const LAB_OFF_EXCHANGE_WEEKS = [
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
] as const;

export const labFlowOffExchangeLevels = (
  range: FlowOffExchangeRange = "5d"
): FlowOffExchangeLevels => {
  const sessions =
    range === "1d"
      ? LAB_OFF_EXCHANGE_SESSIONS.slice(-1)
      : LAB_OFF_EXCHANGE_SESSIONS;
  const minutes: OffExchangeMinuteRow[] = [];
  const events: OffExchangeEventRow[] = [];
  const random = createSeededRandom("flow-off-exchange-levels");
  let price = 578.5;

  sessions.forEach((day, dayIdx) => {
    // EDT in late October: 09:30 ET = 13:30 UTC
    const openMs = Date.parse(`${day}T13:30:00.000Z`);
    for (let offset = 0; offset < 360; offset += 5) {
      if (dayIdx === sessions.length - 1 && offset >= 180 && offset < 205) {
        continue;
      }
      const delta = roundTo((random() - 0.46) * 0.45, 2);
      const open = price;
      const close = roundTo(open + delta, 2);
      const high = roundTo(Math.max(open, close) + 0.14, 2);
      const low = roundTo(Math.min(open, close) - 0.12, 2);
      const vwap = roundTo((open + high + low + close) / 4, 2);
      const volume = 42_000 + Math.round(random() * 28_000);
      const trfShare = 0.34 + random() * 0.22;
      const offExchangeVolume = Math.round(volume * trfShare);
      minutes.push({
        close,
        coveredSeconds: 50,
        high,
        low,
        minute: new Date(openMs + offset * 60_000),
        offExchangeVolume,
        open,
        volume,
        vwap,
      });
      price = close;
    }
    const anchors: readonly Readonly<{
      offsetMin: number;
      price: number;
      size: number;
      direction: "bullish" | "bearish" | "neutral";
    }>[] = [
      { direction: "bullish", offsetMin: 40, price: 579.28, size: 32_000 },
      { direction: "bearish", offsetMin: 110, price: 581.52, size: 28_500 },
      { direction: "bullish", offsetMin: 195, price: 579.31, size: 19_000 },
      { direction: "neutral", offsetMin: 265, price: 580.4, size: 15_500 },
      { direction: "bearish", offsetMin: 320, price: 582.05, size: 22_000 },
    ];
    anchors.forEach((anchor, idx) => {
      const at = new Date(openMs + anchor.offsetMin * 60_000);
      const printPrice = roundTo(anchor.price + (dayIdx % 2) * 0.04, 2);
      const size = anchor.size + dayIdx * 1500;
      events.push({
        at,
        direction: anchor.direction,
        key: `print:${Math.floor(at.getTime() / 1000)}:${printPrice}:${size}:FINRA:${idx}`,
        price: printPrice,
        size,
      });
    });
  });

  const finraRows: OffExchangeFinraRow[] = LAB_OFF_EXCHANGE_WEEKS.flatMap(
    (weekStart, idx) => [
      {
        lastUpdated: "2026-10-30",
        shares: 34_000_000 + idx * 1_800_000,
        tier: "T1",
        trades: 62_000 + idx * 2100,
        venue: "ats" as const,
        weekStart,
      },
      {
        lastUpdated: "2026-10-30",
        shares: 61_000_000 + idx * 1_400_000,
        tier: "T1",
        trades: 118_000 + idx * 3000,
        venue: "non_ats" as const,
        weekStart,
      },
    ]
  );

  const fold = foldOffExchangeLevels({
    events,
    finraRows,
    minutes,
    range,
    truncated: false,
  });
  const firstMinute = (minutes[0] as OffExchangeMinuteRow).minute;
  const lastMinute = (minutes.at(-1) as OffExchangeMinuteRow).minute;

  return {
    anchorSession: fold.sessions.at(-1) as string,
    bars: fold.bars,
    bucketMinutes: fold.bucketMinutes,
    finraWeekly: fold.finraWeekly,
    latestPrice: fold.latestPrice,
    latestPriceAt: fold.latestPriceAt,
    levels: fold.levels,
    prints: fold.prints,
    range,
    rules: { ...OFF_EXCHANGE_LEVELS_RULES },
    schemaVersion: "flow-off-exchange-levels.v1",
    sessions: fold.sessions,
    symbol: "SPY",
    ticks: {
      ageSeconds: 40,
      lastOkAt: new Date(LAB_NOW.getTime() - 40_000).toISOString(),
      lastStatus: "ok",
      message: "ibkr sampled ticks SPY: 1000 prints",
      sessionOpen: true,
      source: "ticks",
      state: "fresh",
    },
    totals: fold.totals,
    windowEnd: lastMinute.toISOString(),
    windowStart: firstMinute.toISOString(),
  };
};
