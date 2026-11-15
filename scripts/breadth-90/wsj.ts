// WSJ markets diary (public JSON behind wsj.com/market-data/stocks/marketsdiary): NYSE advancing and
// declining issues and advancing and declining share volume for the current (or last) session. The
// second source: a fallback for today's value when TradingView fails and a cross-check otherwise.

import { z } from "zod";

import type { BreadthValues } from "./tradingview.ts";

export const WSJ_URL =
  "https://www.wsj.com/market-data/stocks/marketsdiary?id=%7B%22application%22%3A%22WSJ%22%2C%22marketsDiaryType%22%3A%22overview%22%7D&type=mdc_marketsdiary";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const DiarySchema = z.object({
  data: z.object({
    instrumentSets: z.array(
      z.object({
        headerFields: z.array(z.object({ label: z.string().optional() })),
        instruments: z.array(
          z.object({ NYSE: z.string().optional(), name: z.string() })
        ),
      })
    ),
    timestamp: z.string(),
  }),
});

export type WsjResult = Readonly<{
  source: "wsj";
  date: string;
  values: BreadthValues;
  asOf: string;
}>;

const toNumber = (text: string | undefined): number => {
  const value = Number((text ?? "").replaceAll(",", ""));
  if (!(Number.isFinite(value) && value >= 0 && text)) {
    throw new Error(`wsj: unreadable number ${JSON.stringify(text)}`);
  }
  return value;
};

/** "3:09 PM EST 11/06/26" → the New York date and the stamp as given. */
export const parseWsjTimestamp = (stamp: string): string => {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{2})\s*$/.exec(stamp);
  if (!match) {
    throw new Error(`wsj: unreadable timestamp ${JSON.stringify(stamp)}`);
  }
  return `20${match[3]}-${match[1]?.padStart(2, "0")}-${match[2]?.padStart(2, "0")}`;
};

export const parseWsjDiary = (body: unknown): WsjResult => {
  const { data } = DiarySchema.parse(body);
  const label = (set: (typeof data.instrumentSets)[number]): string =>
    set.headerFields.map((field) => field.label ?? "").join(" ");
  const issues = data.instrumentSets.find((set) =>
    /^Issues$/i.test(label(set).trim())
  );
  const volume = data.instrumentSets.find((set) => /volume/i.test(label(set)));
  if (!(issues && volume)) {
    throw new Error("wsj: diary has no issues or volume table");
  }
  const nyse = (set: typeof issues, name: string): number =>
    toNumber(set.instruments.find((row) => row.name === name)?.NYSE);
  return {
    asOf: data.timestamp,
    date: parseWsjTimestamp(data.timestamp),
    source: "wsj",
    values: {
      adv: nyse(issues, "Advancing"),
      decl: nyse(issues, "Declining"),
      dvol: nyse(volume, "Declining"),
      uvol: nyse(volume, "Advancing"),
    },
  };
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const fetchWsj = async (fetcher: FetchLike): Promise<WsjResult> => {
  const response = await fetcher(WSJ_URL, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`wsj: HTTP ${response.status}`);
  }
  return parseWsjDiary(await response.json());
};
