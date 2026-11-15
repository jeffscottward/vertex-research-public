import { createHash } from "node:crypto";
import type { MarketDailyColumns } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import {
  compareDigests,
  formatParity,
  researchViewDigests,
  type ViewDigest,
  viewDigest,
} from "./parity.ts";

const EMPTY_SHA = createHash("sha256").digest("hex");

const columns = (
  dates: string[],
  close: number[],
  bars: boolean
): MarketDailyColumns => ({
  adjClose: close.map((value) => (bars ? value - 1 : null)),
  close,
  dates,
  high: close.map((value) => (bars ? value + 1 : null)),
  low: close.map((value) => (bars ? value - 2 : null)),
  open: close.map((value) => (bars ? value : null)),
});

describe("viewDigest", () => {
  it("hashes the ASCII date then each value as a big-endian double", () => {
    const expected = createHash("sha256")
      .update("2024-01-02")
      .update(Buffer.from("3ff0000000000000c000000000000000", "hex"))
      .update("2024-01-03")
      .update(Buffer.from("8000000000000000", "hex"))
      .digest("hex");
    expect(
      viewDigest([
        ["2024-01-02", [1, -2]],
        ["2024-01-03", [-0]],
      ])
    ).toEqual({
      count: 2,
      first: "2024-01-02",
      last: "2024-01-03",
      sha256: expected,
    });
  });

  it("describes an empty view", () => {
    expect(viewDigest([])).toEqual({
      count: 0,
      first: null,
      last: null,
      sha256: EMPTY_SHA,
    });
  });
});

describe("researchViewDigests", () => {
  it("digests closes of every series, bars of ETFs and futures, and ETF total returns", () => {
    const loaded = new Map([
      ["SPY", columns(["2024-01-02", "2024-01-03"], [10, 11], true)],
      ["ES=F", columns(["2024-01-02"], [5000], true)],
      ["VIX", columns(["2024-01-02"], [13], false)],
    ]);
    const digests = researchViewDigests(loaded);
    expect(Object.keys(digests).sort()).toEqual([
      "ES=F",
      "ES=F#bars",
      "SPY",
      "SPY#bars",
      "SPY:TR",
      "VIX",
    ]);
    expect(digests["SPY"]).toEqual(
      viewDigest([
        ["2024-01-02", [10]],
        ["2024-01-03", [11]],
      ])
    );
    expect(digests["SPY#bars"]).toEqual(
      viewDigest([
        ["2024-01-02", [10, 11, 8, 10, 9]],
        ["2024-01-03", [11, 12, 9, 11, 10]],
      ])
    );
    expect(digests["SPY:TR"]).toEqual(
      viewDigest([
        ["2024-01-02", [9]],
        ["2024-01-03", [10]],
      ])
    );
  });
});

describe("compareDigests and formatParity", () => {
  const digest = (sha: string, count = 1): ViewDigest => ({
    count,
    first: "2024-01-02",
    last: "2024-01-02",
    sha256: sha.repeat(64),
  });

  it("marks equal views and reports a clean verdict", () => {
    const rows = compareDigests({ SPY: digest("a") }, { SPY: digest("a") });
    expect(rows).toEqual([
      {
        equal: true,
        python: digest("a"),
        typescript: digest("a"),
        view: "SPY",
      },
    ]);
    expect(formatParity(rows)).toBe(
      "OK   SPY                ts     1 aaaaaaaaaaaaaaaa  py     1 aaaaaaaaaaaaaaaa\nparity: all 1 views equal\n"
    );
  });

  it("flags differing digests, counts, dates and views missing on either side", () => {
    const rows = compareDigests(
      {
        A: digest("a"),
        B: digest("a", 2),
        C: { ...digest("a"), first: "2024-01-01" },
        D: { ...digest("a"), last: "2024-01-03" },
        E: digest("a"),
      },
      {
        A: digest("b"),
        B: digest("a"),
        C: digest("a"),
        D: digest("a"),
        F: digest("a"),
      }
    );
    expect(rows.map((row) => [row.view, row.equal])).toEqual([
      ["A", false],
      ["B", false],
      ["C", false],
      ["D", false],
      ["E", false],
      ["F", false],
    ]);
    const text = formatParity(rows);
    expect(text).toContain(
      "DIFF E                  ts     1 aaaaaaaaaaaaaaaa  py missing"
    );
    expect(text).toContain("DIFF F                  ts missing");
    expect(text.trim().split("\n").at(-1)).toBe("parity: 6 of 6 views differ");
  });
});
