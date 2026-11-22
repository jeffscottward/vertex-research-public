// What: UI lab fixture for the /flow page: a deterministic flow.snapshot for SPY, QQQ, ES or NQ with
// sampled minutes (and unsampled gaps), a book, options flow, GEX levels, events and confluence,
// a flow.control document per group with a streamed futures tape, and a flow.tapeSpeed document for
// ES (bars, bursts, a gap) and NQ (not recorded, quiet, a write fault). Every value is fictional.
// Used by: apps/web/src/lab/entries/research.tsx.
import {
  FLOW_TAPE_SPEED_RULES,
  type FlowControl,
  type FlowGroupId,
  type FlowSnapshot,
  type FlowTapeSpeed,
  type FlowTapeSymbol,
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
  ticker: FlowSnapshot["optionsFlow"]["ticker"];
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

/** A counted bar: `rate` trades per second over `covered` seconds, with one second at `peak`. */
const countedTapeBar = (
  start: string,
  covered: number,
  rate: number,
  peak: number,
  burstSeconds = 0
): LabTapeBar => ({
  burstSeconds,
  contracts: rate * covered * 3,
  coveredSeconds: covered,
  peakContracts: peak * 4,
  peakTrades: peak,
  start,
  state: "counted",
  trades: rate * covered,
});

/**
 * A deterministic flow.tapeSpeed document. ES: a busy start (means of 300 to 900 trades per second,
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
          "streamed tape NQZ6: 3184 prints in 2 complete minutes, 120 of 120 s covered; 2 deep trades, 1 new; 211 prints signed by the tick rule, 0 without a side; per-second counts not stored (PostgresError 42501)",
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
