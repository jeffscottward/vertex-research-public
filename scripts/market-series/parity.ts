// Research-view digests of loaded daily series, the TypeScript side of the parity check against
// services/research/strategies/qc_ports/data.py (see scripts/market-series/parity.py for the
// matching Python side and the digest definition). Research only.
import { createHash } from "node:crypto";

import {
  createMarketDailyViews,
  type MarketDailyBars,
  type MarketDailyColumns,
} from "@darkfactory/db/server";

import { ETF_SYMBOLS, FUTURES } from "./import.ts";

export type ViewDigest = Readonly<{
  count: number;
  first: string | null;
  last: string | null;
  sha256: string;
}>;

/** SHA-256 over the rows in order: ASCII date, then each value as a big-endian double. */
export const viewDigest = (
  rows: readonly (readonly [string, readonly number[]])[]
): ViewDigest => {
  const hash = createHash("sha256");
  for (const [date, values] of rows) {
    hash.update(date, "ascii");
    const bytes = new DataView(new ArrayBuffer(values.length * 8));
    for (const [index, value] of values.entries()) {
      bytes.setFloat64(index * 8, value, false);
    }
    hash.update(new Uint8Array(bytes.buffer));
  }
  return {
    count: rows.length,
    first: rows[0]?.[0] ?? null,
    last: rows.at(-1)?.[0] ?? null,
    sha256: hash.digest("hex"),
  };
};

/** `<ID>` closes of every loaded series, `<SYM>#bars` of ETFs and futures, and `<ETF>:TR`. */
export const researchViewDigests = (
  loaded: ReadonlyMap<string, MarketDailyColumns>
): Record<string, ViewDigest> => {
  const views = createMarketDailyViews(loaded);
  const digests: Record<string, ViewDigest> = {};
  const series = (ref: string) =>
    viewDigest(
      [...(views.series(ref) as Map<string, number>)].map(
        ([date, value]) => [date, [value]] as const
      )
    );
  for (const id of loaded.keys()) digests[id] = series(id);
  for (const symbol of [...ETF_SYMBOLS, ...FUTURES]) {
    if (!loaded.has(symbol)) continue;
    const bars = views.barsOf(symbol) as MarketDailyBars;
    digests[`${symbol}#bars`] = viewDigest(
      bars.dates.map(
        (date, index) =>
          [
            date,
            [
              bars.open[index] as number,
              bars.high[index] as number,
              bars.low[index] as number,
              bars.close[index] as number,
              bars.adjClose[index] as number,
            ],
          ] as const
      )
    );
  }
  for (const symbol of ETF_SYMBOLS) {
    if (loaded.has(symbol)) digests[`${symbol}:TR`] = series(`${symbol}:TR`);
  }
  return digests;
};

export type ParityRow = Readonly<{
  view: string;
  typescript: ViewDigest | undefined;
  python: ViewDigest | undefined;
  equal: boolean;
}>;

/** One row per view named on either side, sorted by view; equal when both digests match. */
export const compareDigests = (
  typescript: Readonly<Record<string, ViewDigest>>,
  python: Readonly<Record<string, ViewDigest>>
): ParityRow[] =>
  [...new Set([...Object.keys(typescript), ...Object.keys(python)])]
    .sort()
    .map((view) => {
      const left = typescript[view];
      const right = python[view];
      return {
        equal:
          left !== undefined &&
          right !== undefined &&
          left.count === right.count &&
          left.first === right.first &&
          left.last === right.last &&
          left.sha256 === right.sha256,
        python: right,
        typescript: left,
        view,
      };
    });

/** A fixed-width table of the comparison and a final verdict line. */
export const formatParity = (rows: readonly ParityRow[]): string => {
  const lines = rows.map((row) => {
    const side = (digest: ViewDigest | undefined) =>
      digest === undefined
        ? "missing"
        : `${String(digest.count).padStart(5)} ${digest.sha256.slice(0, 16)}`;
    return `${row.equal ? "OK  " : "DIFF"} ${row.view.padEnd(18)} ts ${side(row.typescript)}  py ${side(row.python)}`;
  });
  const failed = rows.filter((row) => !row.equal).length;
  lines.push(
    failed === 0
      ? `parity: all ${rows.length} views equal`
      : `parity: ${failed} of ${rows.length} views differ`
  );
  return `${lines.join("\n")}\n`;
};
