// Quant Data adapter of the options chain (OptionsAnalyticsSource), the first source of the
// chain: per contract of every listed expiry, IV and delta from term-structure (with the
// underlying price), and open interest and flow from the order-flow prints of the last 24 hours
// (the first provider page; more pages are reported, not read). It has no live bid and ask: a
// print carries the bid and ask at the time of a past trade, and that is never shown as a quote.
// Both requests are built by quantDataRequests (options-analytics.ts), so the chain and the
// /charts analytics share the cached answers and the provider quota. One failed request does
// not hide the other. Read-only.

import { z } from "zod";

import { OPTIONS_CHAIN_FLOW_HOURS } from "../options-chain-merge.ts";
import type { OptionRight } from "../options-chain-greeks.ts";
import { newYorkDate } from "./gex-context.ts";
import { quantDataRequests, quantDataStockPrice } from "./options-analytics.ts";
import { parseChain, parseFlow } from "./options-analytics-engine.ts";
import {
  type OptionsAnalyticsRow,
  type OptionsAnalyticsSource,
  OptionsChainSourceError,
  type OptionsContractFlow,
} from "./options-chain-source.ts";
import type { QuantDataClient, QuantDataResult } from "./quantdata-client.ts";

// The open interest of the contract at the time of one print. The same numeric forms as
// parseFlow reads: a number or a numeric string.
const PrintOpenInterestSchema = z.object({
  openInterest: z
    .union([z.number(), z.string().trim().min(1).transform(Number)])
    .pipe(z.number().finite().nonnegative()),
});

interface Tally {
  expiry: string;
  right: OptionRight;
  strike: number;
  flow: { premium: number; trades: number; volume: number };
  openInterest: number | null;
  // Trade time (ms) of the print `openInterest` came from.
  openInterestAt: number;
}

const contractKey = (
  expiry: string,
  right: OptionRight,
  strike: number
): string => `${expiry}|${right}|${strike}`;

/**
 * Flow and open interest per contract (expiries from `today` on) from raw order-flow rows.
 * parseFlow reads each row, as in the /charts analytics, so both count the same prints; rows it
 * refuses are skipped.
 */
const flowByContract = (
  data: unknown,
  symbol: string,
  today: string
): Map<
  string,
  Readonly<{
    expiry: string;
    right: OptionRight;
    strike: number;
    flow: OptionsContractFlow;
    openInterest: number | null;
  }>
> => {
  const tallies = new Map<string, Tally>();
  for (const raw of Array.isArray(data) ? data : []) {
    const [print] = parseFlow([raw], symbol);
    // The chain contract has no negative premium and no strike of zero or less.
    if (
      print === undefined ||
      print.expiry < today ||
      print.premium < 0 ||
      print.strike <= 0
    )
      continue;
    const key = contractKey(print.expiry, print.right, print.strike);
    const tally = tallies.get(key) ?? {
      expiry: print.expiry,
      flow: { premium: 0, trades: 0, volume: 0 },
      openInterest: null,
      openInterestAt: Number.NEGATIVE_INFINITY,
      right: print.right,
      strike: print.strike,
    };
    tally.flow.premium += print.premium;
    tally.flow.trades += 1;
    tally.flow.volume += print.size;
    const openInterest = PrintOpenInterestSchema.safeParse(raw);
    const at = Date.parse(print.time);
    // The newest print that carries an open interest wins.
    if (openInterest.success && at >= tally.openInterestAt) {
      tally.openInterest = Math.trunc(openInterest.data.openInterest);
      tally.openInterestAt = at;
    }
    tallies.set(key, tally);
  }
  return tallies;
};

// IV and delta per contract (expiries from `today` on) from a term-structure answer.
const chainRows = (
  data: unknown,
  today: string
): Map<string, OptionsAnalyticsRow> => {
  const rows = new Map<string, OptionsAnalyticsRow>();
  for (const row of parseChain(data, today).rows)
    rows.set(contractKey(row.expiry, row.right, row.strike), {
      delta: row.delta,
      expiry: row.expiry,
      flow: null,
      iv: row.iv,
      openInterest: null,
      right: row.right,
      strike: row.strike,
    });
  return rows;
};

const FLOW_FIRST_PAGE_WARNING =
  "Quant Data order flow: first provider page only, so flow totals can be too low";

const failureMessage = (result: QuantDataResult): string | null =>
  result.ok ? null : result.message;

/**
 * Quant Data analytics per contract of every expiry through the shared client. `now` is the
 * request clock. Expiry dates follow the New York market day, as in the analytics: expiries
 * before it are left out.
 */
export const createQuantDataOptionsSource = (
  client: QuantDataClient,
  now: () => Date
): OptionsAnalyticsSource => ({
  read: async (symbol) => {
    const at = now();
    const requests = quantDataRequests(
      client,
      symbol,
      OPTIONS_CHAIN_FLOW_HOURS,
      at
    );
    const chainResult = await requests.termStructure();
    const flowResult = await requests.orderFlow();
    if (!(chainResult.ok || flowResult.ok))
      throw new OptionsChainSourceError("UNAVAILABLE", chainResult.message);
    const today = newYorkDate(at);
    const contracts = chainResult.ok
      ? chainRows(chainResult.data, today)
      : new Map<string, OptionsAnalyticsRow>();
    const prints = flowResult.ok ? flowResult.data : [];
    for (const [key, tally] of flowByContract(prints, symbol, today))
      contracts.set(key, {
        delta: null,
        expiry: tally.expiry,
        iv: null,
        right: tally.right,
        strike: tally.strike,
        ...contracts.get(key),
        flow: tally.flow,
        openInterest: tally.openInterest,
      });
    // A contract the provider lists without any value is not a row.
    const rows = [...contracts.values()].filter(
      (row) =>
        row.iv !== null ||
        row.delta !== null ||
        row.openInterest !== null ||
        row.flow !== null
    );
    // More pages exist than the one read (the /charts analytics reads the same first page).
    const flowFirstPageOnly =
      flowResult.ok && Array.isArray(flowResult.body["nextSearchAfter"]);
    return {
      expiries: [...new Set(rows.map((row) => row.expiry))].sort(),
      flowFirstPageOnly,
      rows,
      spot: quantDataStockPrice(chainResult),
      warning:
        failureMessage(chainResult) ??
        failureMessage(flowResult) ??
        (flowFirstPageOnly ? FLOW_FIRST_PAGE_WARNING : null),
    };
  },
});
