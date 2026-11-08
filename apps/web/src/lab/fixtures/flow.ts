// What: UI lab fixture for the /flow page: a deterministic flow.snapshot for SPY or ES with
// sampled minutes (and unsampled gaps), a book, options flow, GEX levels, events and confluence.
// Every value is fictional.
// Used by: apps/web/src/lab/entries/research.tsx.
import type { FlowSnapshot } from "@darkfactory/api";

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
  return {
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
          vote: "neutral",
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
      "Fictional lab data. Ticks are sampled; coveredSeconds says how much of each minute was seen.",
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
};
