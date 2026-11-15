import type {
  ExposureSection,
  FlowEvent,
  GexContext,
  GexContextFactor,
  OptionsAnalyticsOutput,
} from "../contracts/options-analytics.ts";
import { normalCdf, normalPdf } from "../options-chain-greeks.ts";
import {
  type ChainRow,
  daysUntil,
  gammaModel,
  type GammaModel,
} from "./options-analytics-engine.ts";

// GEX context: the caveats a reader (or a research agent) needs before trusting an
// estimated GEX number. Pure functions over the payloads options-analytics already
// fetched; no I/O. Black-Scholes with zero rate and dividend, like the GEX estimate.
// Sign convention everywhere: dealers are long calls and short puts.

const TRADING_DAYS = 252;
const DAYS_PER_YEAR = 365;
// Flow bias needs this share of signed premium on one side.
const FLOW_BIAS_SHARE = 0.2;
// Front/back ATM IV ratio outside 0.95-1.05 is inverted or contango.
const IV_TERM_BAND = 0.05;
// The back point for the term regime: the first expiry at least this far out.
const IV_BACK_MIN_DTE = 25;
// Flip search: spot x (1 +/- FLIP_RANGE) in FLIP_STEPS steps.
const FLIP_RANGE = 0.3;
const FLIP_STEPS = 120;

type StrikeOi = ExposureSection["strikes"][number];

type SideGreeks = Readonly<{
  gamma: number;
  delta: number;
  vanna: number;
  charm: number;
}>;

// Call-side Greeks at zero rate; the put shares gamma, vanna and charm, delta is call - 1.
// Charm is the change of delta per year as time passes.
export const callGreeks = (
  spot: number,
  strike: number,
  iv: number,
  years: number
): SideGreeks => {
  const volT = iv * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / volT;
  const d2 = d1 - volT;
  const density = normalPdf(d1);
  return {
    charm: (density * d2) / (2 * years),
    delta: normalCdf(d1),
    gamma: density / (spot * volT),
    vanna: (-density * d2) / iv,
  };
};

type DealerTotals = Readonly<{
  gex: number;
  dex: number;
  vanna: number;
  charm: number;
}>;

// Dealer totals at a hypothetical spot over the given strikes; null when no strike has IV.
export const dealerTotals = (
  strikes: readonly StrikeOi[],
  model: GammaModel,
  spot: number
): DealerTotals | null => {
  let gex = 0;
  let dex = 0;
  let vanna = 0;
  let charm = 0;
  let any = false;
  for (const row of strikes) {
    const callIv = model.ivAt(row.strike, "call");
    const putIv = model.ivAt(row.strike, "put");
    if (callIv === null || putIv === null) continue;
    any = true;
    const call = callGreeks(spot, row.strike, callIv, model.years);
    const put = callGreeks(spot, row.strike, putIv, model.years);
    const calls = row.callOpenInterest * 100;
    const puts = row.putOpenInterest * 100;
    gex += (calls * call.gamma - puts * put.gamma) * spot * spot * 0.01;
    // DEX is the vendor-standard net delta of open interest from the holders' side
    // (calls +, puts -: put delta = call delta - 1). It does not use the dealer sign:
    // under that assumption dealer delta would always be positive and say nothing.
    dex += (calls * call.delta + puts * (put.delta - 1)) * spot;
    vanna += (calls * call.vanna - puts * put.vanna) * spot * 0.01;
    charm += ((calls * call.charm - puts * put.charm) * spot) / DAYS_PER_YEAR;
  }
  return any ? { charm, dex, gex, vanna } : null;
};

// Spot where the GEX profile changes sign, nearest to spot (linear interpolation).
export const gexFlip = (
  strikes: readonly StrikeOi[],
  model: GammaModel,
  spot: number
): number | null => {
  const low = spot * (1 - FLIP_RANGE);
  const step = (spot * 2 * FLIP_RANGE) / FLIP_STEPS;
  let best: number | null = null;
  let previous: Readonly<{ at: number; gex: number }> | null = null;
  for (let index = 0; index <= FLIP_STEPS; index += 1) {
    const at = low + step * index;
    const gex = dealerTotals(strikes, model, at)?.gex ?? null;
    if (gex === null) return null;
    if (previous !== null && Math.sign(previous.gex) !== Math.sign(gex)) {
      const crossing =
        previous.at + (step * previous.gex) / (previous.gex - gex);
      if (best === null || Math.abs(crossing - spot) < Math.abs(best - spot))
        best = crossing;
    }
    previous = { at, gex };
  }
  return best;
};

// Call wall: largest positive estimated GEX strike; put wall: most negative.
export const gexWalls = (
  strikes: readonly StrikeOi[]
): Readonly<{ callWall: number | null; putWall: number | null }> => {
  let callWall: Readonly<{ strike: number; gex: number }> | null = null;
  let putWall: Readonly<{ strike: number; gex: number }> | null = null;
  for (const { strike, gex } of strikes) {
    if (gex !== null && gex > 0 && (callWall === null || gex > callWall.gex))
      callWall = { gex, strike };
    if (gex !== null && gex < 0 && (putWall === null || gex < putWall.gex))
      putWall = { gex, strike };
  }
  return {
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
  };
};

export type FlowContext = GexContext["flow"];

// Signed premium share needed on one side; below it the flow is balanced.
const flowBias = (bullish: number, bearish: number): FlowContext["bias"] => {
  const signed = bullish + bearish;
  if (signed === 0) return "unknown";
  const net = (bullish - bearish) / signed;
  if (net >= FLOW_BIAS_SHARE) return "bullish";
  return net <= -FLOW_BIAS_SHARE ? "bearish" : "balanced";
};

// Who is spending premium: bullish (calls bought, puts sold) vs bearish, plus the
// share of premium in contracts that expire today or within a week.
export const flowContext = (
  events: readonly FlowEvent[],
  today: string
): FlowContext => {
  let bullishPremium = 0;
  let bearishPremium = 0;
  let total = 0;
  let zeroDte = 0;
  let week = 0;
  let newest: string | null = null;
  for (const event of events) {
    if (newest === null || Date.parse(event.time) > Date.parse(newest))
      newest = event.time;
    const premium = Math.abs(event.premium);
    total += premium;
    if (event.sentiment === "bullish") bullishPremium += premium;
    if (event.sentiment === "bearish") bearishPremium += premium;
    const dte = daysUntil(event.expiry, today);
    if (dte <= 0) zeroDte += premium;
    if (dte <= 7) week += premium;
  }
  return {
    bearishPremium,
    bias: flowBias(bullishPremium, bearishPremium),
    bullishPremium,
    newestTradeAt: newest,
    weekShare: total === 0 ? null : week / total,
    zeroDteShare: total === 0 ? null : zeroDte / total,
  };
};

export type IvContext = GexContext["iv"];

// Front (first DTE >= 1) vs back (first DTE >= 25, else the last) ATM IV.
export const ivContext = (
  term: OptionsAnalyticsOutput["volatility"]["termStructure"]
): IvContext => {
  const front = term.find((point) => point.dte >= 1) ?? null;
  const back =
    term.find((point) => point.dte >= IV_BACK_MIN_DTE) ?? term.at(-1) ?? null;
  if (front === null || back === null || back.expiry === front.expiry)
    return { backIv: null, frontIv: front?.atmIv ?? null, regime: "unknown" };
  const ratio = front.atmIv / back.atmIv;
  return {
    backIv: back.atmIv,
    frontIv: front.atmIv,
    regime:
      ratio > 1 + IV_TERM_BAND
        ? "inverted"
        : ratio < 1 - IV_TERM_BAND
          ? "contango"
          : "flat",
  };
};

export type MarketSession = GexContext["session"];

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
});

export const newYorkParts = (now: Date): Record<string, string> =>
  Object.fromEntries(
    NEW_YORK.formatToParts(now).map((part) => [part.type, part.value])
  );

// The New York calendar date (YYYY-MM-DD): expiries, 0DTE and OpEx follow the US market
// day, which differs from the UTC date from 20:00 (19:00 in summer) to midnight New York.
export const newYorkDate = (now: Date): string => {
  const parts = newYorkParts(now);
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
};

// US equity session by New York wall time; holidays are not modelled.
export const marketSession = (now: Date): MarketSession => {
  const parts = newYorkParts(now);
  if (parts["weekday"] === "Sat" || parts["weekday"] === "Sun") return "closed";
  const minutes = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  if (minutes < 4 * 60 || minutes >= 20 * 60) return "closed";
  if (minutes < 9 * 60 + 30) return "premarket";
  if (minutes < 12 * 60) return "morning";
  if (minutes < 14 * 60) return "midday";
  if (minutes < 16 * 60) return "afternoon";
  return "afterhours";
};

// Third Friday of a UTC month (month is 0-based and may be 12 for next January).
const thirdFriday = (year: number, month: number): string => {
  const first = new Date(Date.UTC(year, month, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month, firstFriday + 14))
    .toISOString()
    .slice(0, 10);
};

// Monthly OpEx: the third Friday of this month, or of next month once it has passed.
export const nextMonthlyOpex = (today: string): string => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const current = thirdFriday(year, month);
  return current >= today ? current : thirdFriday(year, month + 1);
};

const SESSION_LABELS: Readonly<Record<MarketSession, string>> = {
  afternoon: "PM session",
  afterhours: "After hours",
  closed: "Market closed",
  midday: "Midday",
  morning: "Morning",
  premarket: "Pre-market",
};

const compactMoney = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "+";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const moves = (value: number): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(1)} day-moves`;

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

const hedge = (value: number): string =>
  value > 0 ? "hedge selling" : value < 0 ? "hedge buying" : "flat";

export type GexContextInput = Readonly<{
  exposure: ExposureSection;
  chain: readonly ChainRow[];
  spot: number | null;
  term: OptionsAnalyticsOutput["volatility"]["termStructure"];
  events: readonly FlowEvent[];
  flowHours: number;
  flowOk: boolean;
  now: Date;
}>;

type Levels = GexContext["levels"];
type Greeks = GexContext["greeks"];

const NO_LEVELS: Levels = {
  callWall: null,
  callWallMoves: null,
  dailyMove: null,
  flip: null,
  flipMoves: null,
  putWall: null,
  putWallMoves: null,
};
const NO_GREEKS: Greeks = { netCharm: null, netDex: null, netVanna: null };

const dealerContext = (
  input: GexContextInput,
  today: string
): Readonly<{ levels: Levels; greeks: Greeks }> => {
  const { spot } = input;
  const strikes = input.exposure.strikes;
  const model =
    spot === null || spot <= 0 || strikes.length === 0
      ? null
      : gammaModel(input.chain, spot, today);
  const atmIv = model?.atmIv ?? null;
  // With a front ATM IV every strike has an IV (ivAt falls back to it), so totals exist.
  const totals =
    spot === null || model === null || atmIv === null
      ? null
      : dealerTotals(strikes, model, spot);
  if (spot === null || model === null || atmIv === null || totals === null)
    return { greeks: NO_GREEKS, levels: NO_LEVELS };
  const walls = gexWalls(strikes);
  const flip = gexFlip(strikes, model, spot);
  const dailyMove = (spot * atmIv) / Math.sqrt(TRADING_DAYS);
  const distance = (level: number | null): number | null =>
    level === null ? null : (level - spot) / dailyMove;
  return {
    greeks: {
      netCharm: totals.charm,
      netDex: totals.dex,
      netVanna: totals.vanna,
    },
    levels: {
      callWall: walls.callWall,
      callWallMoves: distance(walls.callWall),
      dailyMove,
      flip,
      flipMoves: distance(flip),
      putWall: walls.putWall,
      putWallMoves: distance(walls.putWall),
    },
  };
};

type FactorParts = Omit<GexContext, "factors" | "dealerSignAssumption">;

const levelFactor = (levels: Levels): GexContextFactor => {
  // Moves are null exactly when the level is null (dailyMove always exists with levels).
  const known = (
    [
      ["flip", levels.flipMoves],
      ["call wall", levels.callWallMoves],
      ["put wall", levels.putWallMoves],
    ] as const
  ).flatMap(([name, value]) => (value === null ? [] : [{ name, value }]));
  const parts = known.map(({ name, value }) => `${name} ${moves(value)}`);
  const near = known.some(({ value }) => Math.abs(value) <= 1);
  return {
    detail:
      "Distance from spot in one-day implied moves (spot x front ATM IV / sqrt 252); beyond one day-move a level rarely matters today. Estimate: fixed IV per strike, one front-expiry time for all OI. Hedging zones, not reversal signals.",
    key: "levels",
    label: "Spot vs levels",
    tone: near ? "caution" : "neutral",
    value:
      parts.length === 0 ? "No flip or walls" : parts.join(" · ").slice(0, 80),
  };
};

const flowFactor = (
  flow: GexContext["flow"],
  regime: GexContext["regime"],
  input: GexContextInput
): GexContextFactor => {
  const window = `last ${input.flowHours} h`;
  if (!input.flowOk || flow.bias === "unknown")
    return {
      detail: `No signed QuantData flow in the ${window}. Without flow, a GEX level says where hedging changes, not which way price goes.`,
      key: "flow",
      label: "Flow (who is paying)",
      tone: "alert",
      value: "Unknown",
    };
  const net = flow.bullishPremium - flow.bearishPremium;
  const fights =
    (regime === "positive" && flow.bias === "bearish") ||
    (regime === "negative" && flow.bias === "bullish");
  return {
    detail: `Bullish premium (calls bought, puts sold) minus bearish premium, ${window}. Follow the flow instead of fading into a GEX level; a level against strong flow can break.`,
    key: "flow",
    label: "Flow (who is paying)",
    tone: fights ? "caution" : "neutral",
    value: `${flow.bias === "balanced" ? "Balanced" : flow.bias === "bullish" ? "Bulls" : "Bears"} ${compactMoney(net)} net`,
  };
};

const DEALER_SIGN_FACTOR: GexContextFactor = {
  detail:
    "The GEX, flip, wall, vanna and charm signs here assume customers sell calls and buy puts (dealers long calls, short puts). If customers bought the calls, the sign flips.",
  key: "dealerSign",
  label: "Dealer sign",
  tone: "caution",
  value: "Assumed: long calls, short puts",
};

const REGIME_VALUES: Readonly<Record<GexContext["regime"], string>> = {
  negative: "Negative GEX, not a dump promise",
  positive: "Positive GEX, not a range promise",
  unknown: "Unknown",
};

const regimeFactor = (regime: GexContext["regime"]): GexContextFactor => ({
  detail:
    "Positive GEX does not guarantee a range and negative GEX does not guarantee a selloff. Either regime can trend; check flow, the other Greeks and IV first.",
  key: "regime",
  label: "Regime (estimate)",
  tone: regime === "unknown" ? "alert" : "neutral",
  value: REGIME_VALUES[regime],
});

const freshnessFactor = (
  flow: GexContext["flow"],
  now: Date
): GexContextFactor => {
  const minutes =
    flow.newestTradeAt === null
      ? null
      : Math.max(
          0,
          Math.round((now.getTime() - Date.parse(flow.newestTradeAt)) / 60_000)
        );
  return {
    detail:
      "Open interest is QuantData's previous-session snapshot (it updates overnight), so new positions from today are missing. Chain and OI are cached up to 5 min.",
    key: "freshness",
    label: "Freshness",
    tone: "caution",
    value: `OI prior session · ${minutes === null ? "no recent trades" : `newest trade ${minutes} min ago`}`,
  };
};

const shareText = (value: number | null): string =>
  value === null ? "n/a" : percent(value);

const expiryFactor = (
  expiry: GexContext["expiry"],
  flow: GexContext["flow"],
  flowHours: number
): GexContextFactor => {
  const zeroDteToday = expiry.nextExpiryDte === 0;
  return {
    detail: `OI is aggregated across all expiries, so the 0DTE vs monthly split of these levels is unknown. Levels from the front expiry roll off at its close. Flow share in the ${flowHours} h window: ${shareText(flow.zeroDteShare)} 0DTE, ${shareText(flow.weekShare)} within 7 days.`,
    key: "expiryMix",
    label: "Expiry mix",
    tone: zeroDteToday ? "caution" : "neutral",
    value:
      expiry.nextExpiry === null
        ? "No listed expiry"
        : zeroDteToday
          ? "0DTE today: levels roll off at close"
          : `Next expiry in ${expiry.nextExpiryDte}d`,
  };
};

const greekFactors = (
  greeks: Greeks,
  session: MarketSession,
  ivHigh: boolean
): GexContextFactor[] => [
  {
    detail:
      "Net delta of all open options in dollars, holders' side (calls +, puts -; same OI and IV as GEX). Positioning sets the delta dealers must hedge; GEX is only how fast it changes.",
    key: "dex",
    label: "Open-interest delta (DEX)",
    tone: "neutral",
    value: greeks.netDex === null ? "n/a" : compactMoney(greeks.netDex),
  },
  {
    detail: `Estimated change of dealer delta per day as time passes; dealers hedge against it. Rule of thumb: charm acts most in the PM session and into expiry. Now: ${SESSION_LABELS[session]}.`,
    key: "charm",
    label: `Charm · ${SESSION_LABELS[session]}`,
    tone:
      session === "afternoon" && greeks.netCharm !== null
        ? "caution"
        : "neutral",
    value:
      greeks.netCharm === null
        ? "n/a"
        : `${compactMoney(greeks.netCharm)}/day, ${hedge(greeks.netCharm)}`,
  },
  {
    detail:
      "Estimated change of dealer delta if IV rises 1 point; dealers hedge against it (an IV drop reverses it). Vanna matters most when IV is elevated.",
    key: "vanna",
    label: "Vanna",
    tone: ivHigh && greeks.netVanna !== null ? "caution" : "neutral",
    value:
      greeks.netVanna === null
        ? "n/a"
        : `${compactMoney(greeks.netVanna)} per IV pt, ${hedge(greeks.netVanna)}`,
  },
];

const IV_REGIME_LABELS: Readonly<Record<IvContext["regime"], string>> = {
  contango: "Contango",
  flat: "Flat",
  inverted: "Inverted",
  unknown: "Unknown",
};

const ivFactor = (iv: IvContext): GexContextFactor => ({
  detail:
    "Front ATM IV vs the first expiry 25+ days out. Inverted (front above back) means stress and a larger vanna effect. Historical IV rank is not in this feed.",
  key: "ivRegime",
  label: "IV regime",
  tone:
    iv.regime === "inverted"
      ? "caution"
      : iv.regime === "unknown"
        ? "alert"
        : "neutral",
  // ivContext sets both IVs exactly when the regime is known.
  value:
    iv.frontIv === null || iv.backIv === null
      ? IV_REGIME_LABELS.unknown
      : `${IV_REGIME_LABELS[iv.regime]} ${percent(iv.frontIv)} vs ${percent(iv.backIv)}`,
});

const eventsFactor = (expiry: GexContext["expiry"]): GexContextFactor => ({
  detail:
    "Monthly OpEx (third Friday) removes a large block of OI and resets levels. Earnings, CPI and FOMC dates are not in this feed: check them (/markets lists BLS releases) before trusting any level.",
  key: "events",
  label: "Events",
  tone: expiry.monthlyOpexDays <= 2 ? "caution" : "neutral",
  value:
    expiry.monthlyOpexDays === 0
      ? "Monthly OpEx today"
      : `Monthly OpEx in ${expiry.monthlyOpexDays}d (${expiry.nextMonthlyOpex.slice(5)})`,
});

const buildFactors = (
  parts: FactorParts,
  input: GexContextInput
): GexContextFactor[] =>
  [
    DEALER_SIGN_FACTOR,
    regimeFactor(parts.regime),
    freshnessFactor(parts.flow, input.now),
    expiryFactor(parts.expiry, parts.flow, input.flowHours),
    levelFactor(parts.levels),
    flowFactor(parts.flow, parts.regime, input),
    ...greekFactors(
      parts.greeks,
      parts.session,
      parts.iv.regime === "inverted"
    ),
    ivFactor(parts.iv),
    eventsFactor(parts.expiry),
  ].map((factor) => ({ ...factor, value: factor.value.slice(0, 80) }));

export const buildGexContext = (input: GexContextInput): GexContext => {
  const today = newYorkDate(input.now);
  const { levels, greeks } = dealerContext(input, today);
  const total = input.exposure.totalGex;
  // Exactly zero (no imbalance or no GEX at all) has no sign to report.
  const regime =
    total === null || total === 0
      ? "unknown"
      : total > 0
        ? "positive"
        : "negative";
  const nextExpiry =
    [...new Set(input.chain.map((row) => row.expiry))]
      .filter((expiry) => expiry >= today)
      .sort()[0] ?? null;
  const opex = nextMonthlyOpex(today);
  const parts: FactorParts = {
    expiry: {
      monthlyOpexDays: daysUntil(opex, today),
      nextExpiry,
      nextExpiryDte: nextExpiry === null ? null : daysUntil(nextExpiry, today),
      nextMonthlyOpex: opex,
    },
    flow: flowContext(input.flowOk ? input.events : [], today),
    greeks,
    iv: ivContext(input.term),
    levels,
    regime,
    session: marketSession(input.now),
  };
  return {
    ...parts,
    dealerSignAssumption: "dealers long calls, short puts",
    factors: buildFactors(parts, input),
  };
};
