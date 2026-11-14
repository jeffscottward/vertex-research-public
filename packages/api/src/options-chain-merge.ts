// Pure merge of the three options chain sources into one optionsChain.* response: Quant Data
// analytics first, then IBKR live quotes, then the Yahoo Finance snapshot. Each merged value
// names the source it came from. The order per field is OPTIONS_CHAIN_PRIORITY; nothing else in the code
// decides which source wins. No I/O and no clock reads.

import {
  OPTIONS_CHAIN_MAX_EXPIRIES,
  OPTIONS_CHAIN_MAX_ROWS,
  OPTIONS_CHAIN_SOURCE_LABELS,
  type OptionContract,
  type OptionsChainExpiriesOutput,
  type OptionsChainOutput,
  type OptionsChainRow,
  type OptionsChainSourceId,
} from "./contracts/options-chain.ts";
import {
  blackScholes,
  daysToExpiry,
  expiryCloseMs,
  type OptionRight,
  yearsToExpiry,
} from "./options-chain-greeks.ts";
import type {
  OptionQuote,
  OptionsAnalyticsRow,
  OptionsAnalyticsSnapshot,
  OptionsChainSnapshot,
  OptionsLiveQuote,
  OptionsQuoteSnapshot,
} from "./server/options-chain-source.ts";

type ContractSources = OptionContract["sources"];

/**
 * Source order per field (owner decision 2026-11-13: Quant Data first for chains, then IBKR
 * live bid and ask, Yahoo fills gaps). For a value the first source that has it wins; the
 * expiry list is the union of the lists, and `expiries` is also the order in which the service
 * tries the nearest expiry of each source.
 */
export const OPTIONS_CHAIN_PRIORITY = {
  // Bid and ask together. Quant Data has no live chain bid and ask: its order-flow prints
  // carry the bid and ask at the time of a past trade, and that is never shown as a quote.
  quote: ["ibkr", "yahoo"],
  iv: ["quantdata", "yahoo"],
  openInterest: ["quantdata", "yahoo"],
  // model: Black-Scholes from the chosen IV.
  delta: ["quantdata", "model"],
  spot: ["quantdata", "ibkr", "yahoo"],
  expiries: ["quantdata", "ibkr", "yahoo"],
} as const satisfies Readonly<
  {
    [Field in keyof ContractSources]: readonly NonNullable<
      ContractSources[Field]
    >[];
  } & {
    spot: readonly OptionsChainSourceId[];
    expiries: readonly OptionsChainSourceId[];
  }
>;

/** Fixed risk-free rate assumption for the Greeks (continuously compounded, decimal). */
export const OPTIONS_CHAIN_RISK_FREE_RATE = 0.04;
/** Window of the Quant Data order-flow prints behind `flow` and the Quant Data open interest. */
export const OPTIONS_CHAIN_FLOW_HOURS = 24;

/** One source read: its data, or why there is none (`message` is safe to show). */
export type OptionsSourceRead<Data> =
  | Readonly<{ status: "ok"; data: Data }>
  | Readonly<{ status: "failed" | "off"; message: string }>;

export type OptionsChainReads = Readonly<{
  symbol: string;
  quantdata: OptionsSourceRead<OptionsAnalyticsSnapshot>;
  ibkr: OptionsSourceRead<OptionsQuoteSnapshot>;
  yahoo: OptionsSourceRead<OptionsChainSnapshot>;
}>;

const SOURCE_MESSAGE_MAX = 200;
const EMPTY_MESSAGES: Readonly<Record<OptionsChainSourceId, string>> = {
  ibkr: "IBKR answered without a live quote",
  quantdata: "Quant Data answered without a usable value",
  yahoo: "Yahoo Finance has no option rows for this expiry",
};
// How the notes name the source of a value.
const NOTE_NAMES: Readonly<Record<OptionsChainSourceId | "model", string>> = {
  ...OPTIONS_CHAIN_SOURCE_LABELS,
  ibkr: `${OPTIONS_CHAIN_SOURCE_LABELS.ibkr} live quotes`,
  model: "Black-Scholes",
};

const dataOf = <Data>(read: OptionsSourceRead<Data>): Data | null =>
  read.status === "ok" ? read.data : null;

/**
 * The IBKR snapshot when it carries a live value (a quote or the underlying price), else null.
 * An answer without one (frozen or delayed data, no subscription, a stale copy) is not used for
 * anything: the source is reported `empty` and adds no expiry to the list.
 */
export const liveQuotes = (
  read: OptionsSourceRead<OptionsQuoteSnapshot>
): OptionsQuoteSnapshot | null => {
  const data = dataOf(read);
  return data !== null && (data.quotes.length > 0 || data.spot !== null)
    ? data
    : null;
};

/**
 * True when a chain can be served for `expiry`: a source has at least one contract of it
 * (a Quant Data row, an IBKR live quote, a Yahoo call or put). A Yahoo snapshot of the expiry
 * without a call or a put counts only with `allowEmpty` (a requested expiry, or the last resort
 * of the service): without it the service goes on to the next expiry it can try.
 */
export const hasChain = (
  reads: OptionsChainReads,
  expiry: string,
  allowEmpty: boolean
): boolean => {
  if (dataOf(reads.quantdata)?.rows.some((row) => row.expiry === expiry))
    return true;
  const ibkr = liveQuotes(reads.ibkr);
  if (ibkr !== null && ibkr.expiry === expiry && ibkr.quotes.length > 0)
    return true;
  const yahoo = dataOf(reads.yahoo);
  return (
    yahoo?.expiry === expiry &&
    (allowEmpty || yahoo.calls.length > 0 || yahoo.puts.length > 0)
  );
};

type Picked<Source extends string, Value> =
  | Readonly<{ source: Source; value: Value }>
  | Readonly<{ source: null; value: null }>;
const NONE = { source: null, value: null } as const;

// The value of the first source in `order` that has one.
const pick = <Source extends string, Value>(
  order: readonly Source[],
  candidates: Readonly<Record<Source, Value | null | undefined>>
): Picked<Source, Value> => {
  for (const source of order) {
    const value = candidates[source];
    if (value !== null && value !== undefined) return { source, value };
  }
  return NONE;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const percent = (value: number): string => `${(value * 100).toFixed(2)} %`;

const contractKey = (right: OptionRight, strike: number): string =>
  `${right}|${strike}`;

// OCC-style contract symbol: root, YYMMDD, C or P, strike x 1000 padded to 8 digits.
const occContractSymbol = (
  symbol: string,
  expiry: string,
  right: OptionRight,
  strike: number
): string =>
  `${symbol.replace(/[^A-Z0-9]/gu, "")}${expiry.slice(2).replaceAll("-", "")}${
    right === "call" ? "C" : "P"
  }${String(Math.round(strike * 1000)).padStart(8, "0")}`;

// The contracts of one expiry per source, by right and strike.
type ContractIndex = Readonly<{
  live: ReadonlyMap<string, OptionsLiveQuote>;
  analytics: ReadonlyMap<string, OptionsAnalyticsRow>;
  snapshot: ReadonlyMap<string, OptionQuote>;
}>;

const indexContracts = (
  expiry: string | null,
  ibkr: OptionsQuoteSnapshot | null,
  quantData: OptionsAnalyticsSnapshot | null,
  yahoo: OptionsChainSnapshot | null
): ContractIndex => {
  const live = new Map<string, OptionsLiveQuote>();
  if (ibkr?.expiry === expiry)
    for (const quote of ibkr.quotes)
      live.set(contractKey(quote.right, quote.strike), quote);
  const analytics = new Map<string, OptionsAnalyticsRow>();
  for (const row of quantData?.rows ?? [])
    if (row.expiry === expiry)
      analytics.set(contractKey(row.right, row.strike), row);
  const snapshot = new Map<string, OptionQuote>();
  if (yahoo?.expiry === expiry) {
    for (const quote of yahoo.calls)
      snapshot.set(contractKey("call", quote.strike), quote);
    for (const quote of yahoo.puts)
      snapshot.set(contractKey("put", quote.strike), quote);
  }
  return { analytics, live, snapshot };
};

type ChainFacts = Readonly<{
  symbol: string;
  expiry: string;
  spot: number | null;
  dividendYield: number;
  years: number;
}>;

const inTheMoney = (right: OptionRight, strike: number, spot: number) =>
  right === "call" ? strike < spot : strike > spot;

// Values only Yahoo has; a contract without a Yahoo row shows none.
const NO_YAHOO_ROW = {
  change: null,
  last: null,
  lastTradeAt: null,
  volume: null,
} as const;
const NO_QUOTE = { ask: null, bid: null } as const;

// A provider delta counts only when its sign fits the right: call 0..1, put -1..0.
const fittingDelta = (
  right: OptionRight,
  delta: number | null | undefined
): number | null => {
  if (delta === null || delta === undefined) return null;
  const [low, high] = right === "call" ? [0, 1] : [-1, 0];
  return delta >= low && delta <= high ? delta : null;
};

// Yahoo's bid and ask; null when it has neither side.
const yahooPair = (row: OptionQuote | undefined): OptionQuote | null =>
  row === undefined || (row.bid === null && row.ask === null) ? null : row;

const mergeContract = (
  facts: ChainFacts,
  index: ContractIndex,
  right: OptionRight,
  strike: number
): OptionContract | null => {
  const key = contractKey(right, strike);
  const quoteRow = index.live.get(key);
  const analyticsRow = index.analytics.get(key);
  const yahooRow = index.snapshot.get(key);
  if (
    quoteRow === undefined &&
    analyticsRow === undefined &&
    yahooRow === undefined
  )
    return null;
  const quote = pick(OPTIONS_CHAIN_PRIORITY.quote, {
    ibkr: quoteRow,
    yahoo: yahooPair(yahooRow),
  });
  const iv = pick(OPTIONS_CHAIN_PRIORITY.iv, {
    quantdata: analyticsRow?.iv,
    yahoo: yahooRow?.iv,
  });
  const openInterest = pick(OPTIONS_CHAIN_PRIORITY.openInterest, {
    quantdata: analyticsRow?.openInterest,
    yahoo: yahooRow?.openInterest,
  });
  const model =
    facts.spot === null || iv.value === null
      ? null
      : blackScholes({
          dividendYield: facts.dividendYield,
          rate: OPTIONS_CHAIN_RISK_FREE_RATE,
          right,
          spot: facts.spot,
          strike,
          volatility: iv.value,
          years: facts.years,
        });
  // Without the model there are no Greeks to put a provider delta into.
  const delta =
    model === null
      ? NONE
      : pick(OPTIONS_CHAIN_PRIORITY.delta, {
          model: model.delta,
          quantdata: fittingDelta(right, analyticsRow?.delta),
        });
  const { ask, bid } = quote.value ?? NO_QUOTE;
  const { change, last, lastTradeAt, volume } = yahooRow ?? NO_YAHOO_ROW;
  return {
    ask,
    bid,
    change,
    contractSymbol:
      yahooRow?.contractSymbol ??
      occContractSymbol(facts.symbol, facts.expiry, right, strike),
    flow: analyticsRow?.flow ?? null,
    greeks:
      model === null || delta.value === null
        ? null
        : {
            delta: delta.value,
            gamma: model.gamma,
            rho: model.rho,
            theta: model.theta,
            vega: model.vega,
          },
    // From the spot shown in the response; Yahoo's flag only without a spot.
    inTheMoney:
      facts.spot === null
        ? (yahooRow?.inTheMoney ?? false)
        : inTheMoney(right, strike, facts.spot),
    iv: iv.value,
    last,
    lastTradeAt,
    openInterest: openInterest.value,
    sources: {
      delta: delta.source,
      iv: iv.source,
      openInterest: openInterest.source,
      quote: quote.source,
    },
    volume,
  };
};

const sourceStatus = <Source extends OptionsChainSourceId>(
  source: Source,
  read: OptionsSourceRead<unknown>,
  used: ReadonlySet<unknown>,
  warning: string | null | undefined
) => {
  if (read.status !== "ok")
    return {
      message: read.message.slice(0, SOURCE_MESSAGE_MAX),
      source,
      status: read.status,
    };
  const shown = warning?.slice(0, SOURCE_MESSAGE_MAX) ?? null;
  return used.has(source)
    ? { message: shown, source, status: "used" as const }
    : {
        message: shown ?? EMPTY_MESSAGES[source],
        source,
        status: "empty" as const,
      };
};

// The age of the values of each source, one sentence each; together they are one note.
// Quant Data: the term-structure answer is cached for 5 minutes, shared with /charts, and
// this API caches the merged read for 60 s.
const QUANT_DATA_AGE_NOTE =
  "Quant Data IV, delta and spot can be up to about 6 minutes old (5 min shared cache plus 60 s here).";
// The service caches an answer for 30 s and this API caches the merged read for 60 s.
const IBKR_AGE_NOTE =
  "IBKR live quotes and spot can be about 90 seconds old (30 s service cache plus 60 s here).";
const YAHOO_DELAY_NOTE =
  "Yahoo Finance values can be delayed by 15 minutes or more; its bid and ask can show 0 outside market hours.";
const FLOW_FIRST_PAGE_NOTE =
  "Only the first provider page of prints was read: flow totals can be too low and contracts can be missing.";

type NoteFacts = Readonly<{
  contracts: readonly OptionContract[];
  spotSource: OptionsChainSourceId | null;
  expiriesSources: readonly OptionsChainSourceId[];
  // Delayed Yahoo market values are in the response.
  yahooValues: boolean;
  // Quant Data has contracts of this expiry.
  quantDataRows: boolean;
  flowFirstPageOnly: boolean;
  dividendYield: number;
  hasDividendData: boolean;
  years: number;
}>;

const chainNotes = (facts: NoteFacts): string[] => {
  const { contracts } = facts;
  const count = (
    field: keyof ContractSources,
    source: OptionsChainSourceId | "model"
  ): number =>
    contracts.filter((item) => item.sources[field] === source).length;
  // "IBKR live quotes for 12, Yahoo Finance for 28", in priority order.
  const split = (field: keyof ContractSources): string =>
    OPTIONS_CHAIN_PRIORITY[field]
      .map((source) => [NOTE_NAMES[source], count(field, source)] as const)
      .filter(([, total]) => total > 0)
      .map(([name, total]) => `${name} for ${total}`)
      .join(", ") || "no source";
  const missingIv = contracts.filter((item) => item.iv === null).length;
  const quantDataDelta = count("delta", "quantdata");
  const spotNote =
    facts.spotSource === null
      ? ""
      : `Spot price: ${OPTIONS_CHAIN_SOURCE_LABELS[facts.spotSource]}. `;
  const expiriesNote =
    facts.expiriesSources.length === 0
      ? ""
      : `Expiry list: ${facts.expiriesSources
          .map((source) => OPTIONS_CHAIN_SOURCE_LABELS[source])
          .join(", ")}. `;
  const deltaNote =
    quantDataDelta > 0
      ? ` Delta comes from Quant Data for ${quantDataDelta} contracts.`
      : "";
  const optional = (shown: boolean, note: string): string[] =>
    shown ? [note] : [];
  // One note on the age of the values, a sentence per source with a market value in the
  // response, in priority order.
  const age = [
    ...optional(
      facts.spotSource === "quantdata" ||
        count("iv", "quantdata") > 0 ||
        quantDataDelta > 0,
      QUANT_DATA_AGE_NOTE
    ),
    ...optional(
      facts.spotSource === "ibkr" || count("quote", "ibkr") > 0,
      IBKR_AGE_NOTE
    ),
    ...optional(facts.yahooValues, YAHOO_DELAY_NOTE),
  ].join(" ");
  return [
    `${spotNote}${expiriesNote}Bid and ask: ${split("quote")} (of ${contracts.length} contracts).`,
    ...optional(age !== "", age),
    `IV: ${split("iv")}. Open interest: ${split("openInterest")}.`,
    ...optional(
      facts.quantDataRows,
      `Quant Data open interest and flow come from the order-flow prints of the last ${OPTIONS_CHAIN_FLOW_HOURS} hours, so a contract without a print shows neither.${
        facts.flowFirstPageOnly ? ` ${FLOW_FIRST_PAGE_NOTE}` : ""
      }`
    ),
    `Greeks are calculated here with Black-Scholes (European exercise) from the chosen IV: risk-free rate ${percent(OPTIONS_CHAIN_RISK_FREE_RATE)} (fixed assumption), dividend yield ${percent(facts.dividendYield)} (${
      facts.hasDividendData ? "trailing" : "no dividend data"
    }), time to 16:00 New York on the expiry day.${deltaNote}`,
    "US stock options are American-style. The model does not include early exercise.",
    ...optional(
      missingIv > 0,
      `${missingIv} contracts have no usable IV, so they show no Greeks.`
    ),
    ...optional(
      facts.spotSource === null,
      "No spot price is available, so no Greeks are shown."
    ),
    ...optional(
      facts.years <= 0,
      "This expiry has closed, so no Greeks are shown."
    ),
    "Read-only market data for research. It is not a trading signal.",
  ];
};

// At most OPTIONS_CHAIN_MAX_ROWS strikes, ascending: the ones nearest the spot, or the lowest
// ones without a spot.
const shownStrikes = (
  strikes: readonly number[],
  spot: number | null
): readonly number[] => {
  if (strikes.length <= OPTIONS_CHAIN_MAX_ROWS) return strikes;
  if (spot === null) return strikes.slice(0, OPTIONS_CHAIN_MAX_ROWS);
  return [...strikes]
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, OPTIONS_CHAIN_MAX_ROWS)
    .sort((a, b) => a - b);
};

// The union of `dates`: expiries that have not closed yet (16:00 New York), plus the expiry
// being shown, ascending; at most OPTIONS_CHAIN_MAX_EXPIRIES (the nearest ones and the expiry
// being shown).
const shownExpiries = (
  dates: readonly string[],
  expiry: string | null,
  now: Date
): readonly string[] => {
  const open = [...new Set(dates)]
    .filter((date) => date === expiry || expiryCloseMs(date) > now.getTime())
    .sort();
  // A source can show an expiry that no list has.
  const all =
    expiry === null || open.includes(expiry) ? open : [...open, expiry].sort();
  const first = all.slice(0, OPTIONS_CHAIN_MAX_EXPIRIES);
  return expiry === null || first.includes(expiry)
    ? first
    : [...first.slice(0, -1), expiry];
};

type Merged = Readonly<{
  listing: OptionsChainExpiriesOutput;
  rows: OptionsChainRow[];
  dividendYield: number;
  flowFirstPageOnly: boolean;
  notes: string[];
}>;

const merge = (
  reads: OptionsChainReads,
  expiry: string | null,
  now: Date
): Merged => {
  const ibkr = liveQuotes(reads.ibkr);
  const quantData = dataOf(reads.quantdata);
  const yahoo = dataOf(reads.yahoo);
  const trailingYield = yahoo?.dividendYield ?? null;
  const dividendYield = trailingYield ?? 0;

  const spot = pick(OPTIONS_CHAIN_PRIORITY.spot, {
    ibkr: ibkr?.spot,
    quantdata: quantData?.spot,
    yahoo: yahoo?.spot,
  });
  // The expiry list is the union of the lists; a source that gave one of the shown expiries
  // is named, in priority order.
  const listed: Readonly<Record<OptionsChainSourceId, readonly string[]>> = {
    ibkr: ibkr?.expiries ?? [],
    quantdata: quantData?.expiries ?? [],
    yahoo: yahoo?.expiries ?? [],
  };
  const expiries = shownExpiries(
    OPTIONS_CHAIN_PRIORITY.expiries.flatMap((source) => listed[source]),
    expiry,
    now
  );
  const expiriesSources = OPTIONS_CHAIN_PRIORITY.expiries.filter((source) =>
    listed[source].some((date) => expiries.includes(date))
  );
  // The time of the spot quote, from the source of the spot. Quant Data sends none: its
  // client result does not carry the time the (cached) answer was fetched.
  const quoteTimes: Readonly<Record<OptionsChainSourceId, string | null>> = {
    ibkr: ibkr?.asOf ?? null,
    quantdata: null,
    yahoo: yahoo?.quoteTime ?? null,
  };

  const index = indexContracts(expiry, ibkr, quantData, yahoo);
  const years = expiry === null ? 0 : yearsToExpiry(expiry, now);
  const strikes = shownStrikes(
    [
      ...new Set(
        [
          ...index.live.values(),
          ...index.analytics.values(),
          ...index.snapshot.values(),
        ].map((row) => row.strike)
      ),
    ].sort((a, b) => a - b),
    spot.value
  );
  const rows: OptionsChainRow[] =
    expiry === null
      ? []
      : strikes.map((strike) => {
          const facts = {
            dividendYield,
            expiry,
            spot: spot.value,
            symbol: reads.symbol,
            years,
          };
          return {
            call: mergeContract(facts, index, "call", strike),
            put: mergeContract(facts, index, "put", strike),
            strike,
          };
        });
  const contracts = rows
    .flatMap((row) => [row.call, row.put])
    .filter((item) => item !== null);

  // Every source that gave the response a value.
  const used = new Set<string | null>([
    spot.source,
    ...expiriesSources,
    ...contracts.flatMap((item) => Object.values(item.sources)),
  ]);
  if (contracts.some((item) => item.flow !== null)) used.add("quantdata");
  // Delayed Yahoo market values in the response (the currency alone is not one).
  const yahooValues = index.snapshot.size > 0 || spot.source === "yahoo";
  const currency = yahoo?.currency ?? null;
  if (yahooValues || currency !== null) used.add("yahoo");

  const today = isoDay(now);
  const flowFirstPageOnly = quantData?.flowFirstPageOnly ?? false;
  return {
    dividendYield,
    flowFirstPageOnly,
    listing: {
      currency,
      expiries: expiries.map((date) => ({
        date,
        dte: daysToExpiry(date, today),
      })),
      expiriesSources,
      quoteTime: spot.source === null ? null : quoteTimes[spot.source],
      receivedAt: now.toISOString(),
      sources: [
        sourceStatus("quantdata", reads.quantdata, used, quantData?.warning),
        sourceStatus("ibkr", reads.ibkr, used, dataOf(reads.ibkr)?.warning),
        sourceStatus("yahoo", reads.yahoo, used, null),
      ],
      spot: spot.value,
      spotSource: spot.source,
      symbol: yahoo?.symbol ?? reads.symbol,
    },
    notes: chainNotes({
      contracts,
      dividendYield,
      expiriesSources,
      flowFirstPageOnly,
      hasDividendData: trailingYield !== null,
      quantDataRows: index.analytics.size > 0,
      spotSource: spot.source,
      years,
      yahooValues,
    }),
    rows,
  };
};

/** The quote fields and expiry list; `expiry` (the expiry being shown) stays listed after its close. */
export const mergeOptionsExpiries = (
  reads: OptionsChainReads,
  expiry: string | null,
  now: Date
): OptionsChainExpiriesOutput => merge(reads, expiry, now).listing;

/** The chain response of one expiry: rows by strike, calls and puts side by side, with Greeks. */
export const mergeOptionsChain = (
  reads: OptionsChainReads,
  expiry: string,
  now: Date
): OptionsChainOutput => {
  const merged = merge(reads, expiry, now);
  return {
    ...merged.listing,
    assumptions: {
      dayCount: "act/365",
      dividendYield: merged.dividendYield,
      model: "black-scholes-european",
      riskFreeRate: OPTIONS_CHAIN_RISK_FREE_RATE,
    },
    dte: daysToExpiry(expiry, isoDay(now)),
    expiry,
    flowFirstPageOnly: merged.flowFirstPageOnly,
    notes: merged.notes,
    rows: merged.rows,
  };
};
