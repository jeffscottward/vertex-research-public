import {
  blackScholes,
  daysToExpiry,
  type MarketBarsInput,
  type MarketBarsOutput,
  type OptionContract,
  type OptionsChainExpiriesInput,
  type OptionsChainExpiriesOutput,
  type OptionsChainInput,
  type OptionsChainOutput,
  yearsToExpiry,
} from "@darkfactory/api";

import type { MarketDataGateway } from "../../components/portal/market-data-client.ts";
import type { OptionsChainGateway } from "./options-chain-client.ts";

// Deterministic DUMMY market data for tests and the /lab component browser. Prices, quotes,
// volumes and open interest are generated from the symbol; none of it is real market data.
// The chain mimics the merged response (Quant Data first, then IBKR, then Yahoo): the 13 strikes
// nearest the spot carry an "IBKR" quote and "Quant Data" open interest and flow, the rest are
// tagged Yahoo.
// Special symbols: NOOPT lists no options, FAIL makes every request fail.

export const FAKE_NOW = new Date("2026-11-04T15:00:00.000Z");
const RATE = 0.04;

type FakeOptions = Readonly<{ now?: Date }>;

const MODULUS = 2_147_483_647;

// Polynomial string hash: the same symbol always gives the same numbers.
const hash = (text: string): number => {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % MODULUS;
  return value;
};

// Park-Miller pseudo-random generator in (0, 1).
const random = (seed: number): (() => number) => {
  let state = (seed % (MODULUS - 1)) + 1;
  return () => {
    state = (state * 48_271) % MODULUS;
    return state / MODULUS;
  };
};

const cents = (value: number): number => Math.round(value * 100) / 100;

/** Dummy spot price for a symbol, between 20 and 520. */
export const fakeSpot = (symbol: string): number =>
  cents(20 + (hash(symbol) % 50_000) / 100);

const failure = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

// Next six weekly Fridays plus the third Friday of the next four months.
const fakeExpiries = (now: Date): string[] => {
  const today = isoDay(now);
  const dates = new Set<string>();
  const day = new Date(`${today}T00:00:00Z`);
  const toFriday = (5 - day.getUTCDay() + 7) % 7;
  for (let week = 0; week < 6; week += 1)
    dates.add(
      isoDay(new Date(day.getTime() + (toFriday + 7 * week) * 86_400_000))
    );
  for (let month = 1; month <= 4; month += 1) {
    const first = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + month, 1)
    );
    const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
    dates.add(
      isoDay(
        new Date(
          Date.UTC(
            first.getUTCFullYear(),
            first.getUTCMonth(),
            firstFriday + 14
          )
        )
      )
    );
  }
  return [...dates].sort();
};

const quoteFields = (
  symbol: string,
  now: Date
): OptionsChainExpiriesOutput => ({
  currency: "USD",
  expiries: fakeExpiries(now).map((date) => ({
    date,
    dte: daysToExpiry(date, isoDay(now)),
  })),
  expiriesSources: ["quantdata", "ibkr", "yahoo"],
  // Quant Data sends no quote time, as on the server.
  quoteTime: null,
  receivedAt: now.toISOString(),
  sources: [
    { message: null, source: "quantdata", status: "used" },
    { message: null, source: "ibkr", status: "used" },
    { message: null, source: "yahoo", status: "used" },
  ],
  spot: fakeSpot(symbol),
  spotSource: "quantdata",
  symbol,
});

const strikeStep = (spot: number): number =>
  spot < 50 ? 1 : spot < 200 ? 5 : 10;

const fakeContract = (
  symbol: string,
  expiry: string,
  right: "call" | "put",
  strike: number,
  spot: number,
  now: Date,
  // One of the strikes nearest the spot: the ones the dummy IBKR and Quant Data cover.
  near: boolean
): OptionContract => {
  const moneyness = Math.log(strike / spot);
  const years = Math.max(yearsToExpiry(expiry, now), 1 / 365);
  // Far strikes get no IV (like provider placeholders), so the lab shows missing Greeks.
  const iv =
    Math.abs(moneyness) > 0.4
      ? null
      : 0.28 + 0.9 * moneyness * moneyness + 0.02 / Math.sqrt(years);
  const model =
    iv === null
      ? null
      : blackScholes({
          dividendYield: 0,
          rate: RATE,
          right,
          spot,
          strike,
          volatility: iv,
          years,
        });
  const intrinsic = Math.max(
    0,
    right === "call" ? spot - strike : strike - spot
  );
  const price = model?.price ?? intrinsic;
  const spread = Math.max(0.01, price * 0.03);
  const volume = Math.floor(6000 * Math.exp(-Math.abs(moneyness) * 14));
  const code = `${expiry.slice(2).replaceAll("-", "")}${right === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  return {
    ask: cents(price + spread),
    bid: cents(Math.max(0, price - spread)),
    change: cents(price * 0.04 * (right === "call" ? 1 : -1)),
    contractSymbol: `${symbol}${code}`.slice(0, 40),
    flow: near
      ? {
          premium: cents(price * volume * 10),
          trades: 1 + (volume % 7),
          volume: Math.floor(volume / 10),
        }
      : null,
    greeks:
      model === null
        ? null
        : {
            delta: model.delta,
            gamma: model.gamma,
            rho: model.rho,
            theta: model.theta,
            vega: model.vega,
          },
    inTheMoney: right === "call" ? strike < spot : strike > spot,
    iv,
    last: cents(price),
    lastTradeAt: now.toISOString(),
    openInterest: volume * 7 + 13,
    sources: {
      delta: model === null ? null : "model",
      iv: iv === null ? null : "yahoo",
      openInterest: near ? "quantdata" : "yahoo",
      quote: near ? "ibkr" : "yahoo",
    },
    volume,
  };
};

/** Dummy options chain gateway: 41 strikes around the dummy spot for every fake expiry. */
export const createFakeOptionsChainGateway = (
  options: FakeOptions = {}
): OptionsChainGateway => {
  const now = options.now ?? FAKE_NOW;
  const check = (symbol: string): string => {
    const upper = symbol.trim().toUpperCase();
    if (upper === "FAIL")
      throw failure("UNAVAILABLE", "Options data source unavailable (dummy)");
    if (upper === "NOOPT")
      throw failure("NOT_FOUND", `No listed options for ${upper} (dummy)`);
    return upper;
  };
  return Object.freeze({
    chain: ({ symbol, expiry }: OptionsChainInput) =>
      Promise.resolve().then(() => {
        const upper = check(symbol);
        const fields = quoteFields(upper, now);
        const match = fields.expiries.find(
          (item) => expiry === undefined || item.date === expiry
        );
        if (match === undefined)
          throw failure(
            "NOT_FOUND",
            `No ${upper} options expire on ${expiry} (dummy)`
          );
        const selected = match.date;
        const spot = fakeSpot(upper);
        const step = strikeStep(spot);
        const center = Math.round(spot / step) * step;
        const strikes = Array.from(
          { length: 41 },
          (_, index) => center + (index - 20) * step
        ).filter((strike) => strike > 0);
        const output: OptionsChainOutput = {
          ...fields,
          assumptions: {
            dayCount: "act/365",
            dividendYield: 0,
            model: "black-scholes-european",
            riskFreeRate: RATE,
          },
          dte: match.dte,
          expiry: selected,
          flowFirstPageOnly: false,
          notes: [
            "DUMMY DATA for the lab and tests. These are not market quotes.",
            "Greeks are calculated with Black-Scholes (European exercise): risk-free rate 4.00 % (fixed assumption), dividend yield 0.00 %.",
          ],
          rows: strikes.map((strike) => {
            const near = Math.abs(strike - center) <= 6 * step;
            return {
              call: fakeContract(
                upper,
                selected,
                "call",
                strike,
                spot,
                now,
                near
              ),
              put: fakeContract(
                upper,
                selected,
                "put",
                strike,
                spot,
                now,
                near
              ),
              strike,
            };
          }),
        };
        return output;
      }),
    expiries: ({ symbol }: OptionsChainExpiriesInput) =>
      Promise.resolve().then(() => quoteFields(check(symbol), now)),
  });
};

const BAR_STEP_SECONDS: Readonly<
  Record<MarketBarsInput["barSize"] & string, number>
> = {
  "1 day": 86_400,
  "1 hour": 3600,
  "1 min": 60,
  "15 mins": 900,
  "30 mins": 1800,
  "5 mins": 300,
};

/** Dummy IBKR-shaped bars: a seeded random walk ending at the fake spot. */
export const createFakeMarketDataGateway = (
  options: FakeOptions = {}
): MarketDataGateway => {
  const now = options.now ?? FAKE_NOW;
  return Object.freeze({
    bars: (input: MarketBarsInput): Promise<MarketBarsOutput> =>
      Promise.resolve().then(() => {
        const symbol = input.symbol.trim().toUpperCase();
        if (symbol === "FAIL")
          throw failure(
            "UNAVAILABLE",
            "IBKR history service unavailable (dummy)"
          );
        const barSize = input.barSize ?? "1 day";
        const step = BAR_STEP_SECONDS[barSize];
        const count = barSize === "1 day" ? 252 : 390;
        const next = random(hash(`${symbol}|${barSize}`));
        const end = Math.floor(now.getTime() / 1000 / step) * step;
        let walk = fakeSpot(symbol);
        const closes: number[] = [walk];
        for (let index = 1; index < count; index += 1) {
          walk = Math.max(1, walk * (1 + (next() - 0.5) * 0.04));
          closes.unshift(walk);
        }
        const bars = closes.map((close, index) => {
          const open = cents(close * (1 + (next() - 0.5) * 0.01));
          const c = cents(close);
          return {
            c,
            h: cents(Math.max(open, c) * (1 + next() * 0.01)),
            l: cents(Math.min(open, c) * (1 - next() * 0.01)),
            o: open,
            t: end - (count - 1 - index) * step,
            v: Math.floor(1_000_000 + next() * 9_000_000),
          };
        });
        return {
          asOf: new Date(end * 1000).toISOString(),
          bars,
          cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 300 },
          contract: {
            conId: hash(symbol) % 1_000_000,
            currency: "USD",
            exchange: "SMART",
            lastTradeDateOrContractMonth: null,
            localSymbol: symbol,
            longName: `${symbol} Dummy Corp (fake)`,
            matches: 1,
            multiplier: null,
            secType: "STK",
            timeZoneId: "US/Eastern",
          },
          count: bars.length,
          fetchedAt: now.toISOString(),
          receivedAt: now.toISOString(),
          request: {
            barSize,
            contractMonth: null,
            currency: "USD",
            duration: input.duration ?? "1 Y",
            exchange: "SMART",
            secType: "STK",
            symbol,
            useRTH: input.useRTH ?? true,
            whatToShow: input.whatToShow ?? "TRADES",
          },
          source: "ibkr-gateway",
        } satisfies MarketBarsOutput;
      }),
  });
};
