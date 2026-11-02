// Synthetic daily bars for the paper agent desk tests. Values are fictional and non-production.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeskInput } from "./desk.ts";
import type { Bar, RulePoint } from "./technical.ts";

export const dateAt = (index: number): string =>
  new Date(Date.UTC(2024, 0, 1) + index * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const bars = (
  closes: readonly number[],
  opens: readonly (number | null)[] = closes
): Bar[] =>
  closes.map((close, index) => ({
    close,
    date: dateAt(index),
    open: opens[index] ?? null,
  }));

/** 300 bars of slow uptrend, a 25% rise over 30 bars, then 70 flat bars: ROC63 resets to 0. */
export const resetCloses = (): number[] => {
  const closes: number[] = [];
  for (let index = 0; index < 300; index++) closes.push(100 * 1.001 ** index);
  const base = closes.at(-1) as number;
  for (let index = 1; index <= 30; index++)
    closes.push(base * (1 + (0.25 * index) / 30));
  const top = closes.at(-1) as number;
  for (let index = 0; index < 70; index++) closes.push(top);
  return closes;
};

/** Six rise-and-reset cycles, so the backtest has enough closed trades; the last bar signals. */
export const signalCloses = (): number[] => {
  const closes: number[] = [];
  for (let index = 0; index < 300; index++) closes.push(100 * 1.001 ** index);
  for (let cycle = 0; cycle < 6; cycle++) {
    const base = closes.at(-1) as number;
    for (let index = 1; index <= 30; index++)
      closes.push(base * (1 + (0.25 * index) / 30));
    const top = closes.at(-1) as number;
    for (let index = 0; index < 70; index++)
      closes.push(top * (1 + 0.0002 * index));
  }
  return closes;
};

/** Hand-made rule points: `smas[i]` is the SMA at bar i, `signals` lists signalling indices. */
export const points = (
  smas: readonly (number | null)[],
  signals: readonly number[] = [],
  known = true
): RulePoint[] =>
  smas.map((sma, index) => ({
    checks: {
      closeAboveSma: null,
      priorRocHigh: null,
      rocNearZero: null,
      smaRising: null,
    },
    close: 0,
    date: dateAt(index),
    known,
    priorRocPeak: null,
    roc: null,
    signal: signals.includes(index),
    sma,
    smaSlopeFrom: null,
  }));

export const deskInput = (
  id: string,
  history: readonly unknown[],
  overrides: Partial<DeskInput> = {}
): DeskInput => {
  const lastDate = (history.at(-1) as Bar).date;
  return {
    committee: {
      asOf: lastDate,
      finalRecommendation: { headline: null, horizon: null, status: "wait" },
    },
    fundamentals: {
      asOf: lastDate,
      financialFacts: [{ asOf: lastDate }],
      valuation: { scenarios: [{ id: "base", upsidePct: 12 }] },
    },
    history,
    metadata: { assetType: "equity", id, name: id },
    news: {
      asOf: lastDate,
      catalysts: [],
      items: [{ category: "earnings", date: lastDate, title: "results" }],
      risks: [],
    },
    sentiment: null,
    ...overrides,
  };
};

/** Writes a small fictional Workspace report store; returns the data root. */
export const writeStore = (
  root: string,
  history: readonly unknown[]
): string => {
  const data = join(root, "data");
  const lastDate = (history.at(-1) as Bar).date;
  const identity = (id: string) => ({
    currency: "USD",
    reportId: id,
    symbol: id,
  });
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    writeFileSync(join(data, path), JSON.stringify(value));
  };
  put("reports.json", {
    defaultReportId: "AAA",
    reports: [
      {
        assetType: "equity",
        currency: "USD",
        dataRevision: "r1",
        id: "AAA",
        name: "Alpha",
        providerSymbol: "AAA",
      },
      { currency: "USD", id: "BBB", providerSymbol: "BBB" },
      { currency: "USD", id: "APP", providerSymbol: "APP" },
    ],
    version: 1,
  });
  const revision = "reports/AAA/revisions/r1";
  put(`${revision}/market.json`, { ...identity("AAA"), history });
  put(`${revision}/fundamentals.json`, {
    ...identity("AAA"),
    asOf: lastDate,
    financialFacts: [],
    valuation: { scenarios: [{ id: "base", upsidePct: 5 }] },
  });
  put(`${revision}/news.json`, {
    ...identity("AAA"),
    asOf: lastDate,
    items: [{ category: "earnings", date: lastDate, title: "results" }],
  });
  put(`${revision}/committee.json`, {
    ...identity("AAA"),
    asOf: lastDate,
    finalRecommendation: { status: "wait" },
  });
  put("reports/BBB/market.json", {
    ...identity("BBB"),
    history: history.slice(0, 5),
  });
  put("market.json", { history: history.slice(0, 3) });
  return data;
};
