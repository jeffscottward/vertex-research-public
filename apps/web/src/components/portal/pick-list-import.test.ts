import { describe, expect, it } from "vitest";

import {
  cleanSymbol,
  isPercentColumn,
  MANUAL_IMPORT_SOURCES,
  parseDate,
  parsePickListText,
  parseWeight,
  slugifyListName,
  splitCells,
} from "./pick-list-import.ts";

describe("pick-list manual import parser", () => {
  it("parses a plain ticker paste split on spaces and new lines", () => {
    const result = parsePickListText(
      "aapl MSFT\n$nvda\n# comment\n\nNASDAQ:AMD"
    );
    expect(result.members.map((member) => member.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
      "AMD",
    ]);
    expect(result.members.map((member) => member.rank)).toEqual([1, 2, 3, 4]);
    expect(result.rejects).toEqual([]);
  });

  it("parses a Moby-style CSV with a header, weights and dates", () => {
    const csv = [
      "Ticker,Company,Date Added,Rating,Sector,Price Target",
      'NVDA,"Nvidia, Inc.",10/1/2026,Buy,Technology,"$1,200.50"',
      "TSLA,Tesla,2026-09-15,Hold,,",
    ].join("\r\n");
    const result = parsePickListText(csv);
    expect(result.rejects).toEqual([]);
    expect(result.members).toEqual([
      {
        addedOn: "2026-10-01",
        rank: 1,
        rating: "Buy",
        sector: "Technology",
        symbol: "NVDA",
        targetPrice: 1200.5,
      },
      { addedOn: "2026-09-15", rank: 2, rating: "Hold", symbol: "TSLA" },
    ]);
  });

  it("parses a ProPicks-style tab table with rank and weight", () => {
    const tsv = "#\tSymbol\tWeight %\n2\tMSFT\t6.5%\n1\tBRK.B\t4";
    const result = parsePickListText(tsv);
    expect(result.members).toEqual([
      { rank: 2, symbol: "MSFT", weight: 0.065 },
      { rank: 1, symbol: "BRK.B", weight: 0.04 },
    ]);
  });

  it("uses the first cell when a delimited paste has no header", () => {
    const result = parsePickListText("AAPL;Apple\nmsft;Microsoft");
    expect(result.members.map((member) => member.symbol)).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(parsePickListText("Ticker,Rating\nAMD").members).toEqual([
      { rank: 1, symbol: "AMD" },
    ]);
  });

  it("splits a comma or semicolon ticker list into one ticker per cell", () => {
    const result = parsePickListText("AAPL, MSFT, $NVDA\nAMD,NASDAQ:INTC");
    expect(result.members.map((member) => member.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
      "AMD",
      "INTC",
    ]);
    expect(result.rejects).toEqual([]);
    expect(
      parsePickListText("AMD;INTC").members.map((member) => member.symbol)
    ).toEqual(["AMD", "INTC"]);
  });

  it("reports extra cells of a headerless table as ignored", () => {
    const result = parsePickListText("aapl,Apple,\nmsft,Microsoft");
    expect(result.members.map((member) => member.symbol)).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(result.rejects.map((reject) => [reject.line, reject.text])).toEqual([
      [1, "Apple"],
      [2, "Microsoft"],
    ]);
    expect(result.rejects[0]?.reason).toContain("add a header row");
  });

  it("reads one weight column on one scale", () => {
    const result = parsePickListText("Symbol,Weight\nAAA,5\nBBB,1\nCCC,0.5");
    expect(result.members.map((member) => member.weight)).toEqual([
      0.05, 0.01, 0.005,
    ]);
    const fractions = parsePickListText("Symbol,Weight\nAAA,0.5\nBBB,0.25");
    expect(fractions.members.map((member) => member.weight)).toEqual([
      0.5, 0.25,
    ]);
  });

  it("picks the semicolon delimiter for decimal-comma exports", () => {
    const result = parsePickListText("Symbol;Weight\nAAPL;5,5%\nMSFT;4,5%");
    expect(result.members).toEqual([
      { rank: 1, symbol: "AAPL", weight: 0.055 },
      { rank: 2, symbol: "MSFT", weight: 0.045 },
    ]);
  });

  it("reports a row the contract rejects as invalid", () => {
    const result = parsePickListText(`Symbol,Rating\nAAPL,${"x".repeat(41)}`);
    expect(result.rejects.map((reject) => reject.reason)).toEqual([
      "Invalid row",
    ]);
  });

  it("reports rejects with line, text and reason", () => {
    const csv = [
      "Symbol,Weight,Added,Target,Rank",
      "AAPL,5%,2026-10-01,150,1",
      "123BAD,,,,",
      "AAPL,,,,",
      ",1,,,",
      "MSFT,250,,,",
      "AMD,,yesterday,,",
      "NVDA,,,free,",
      "TSLA,,,,zero",
      "META,,2026-02-30,,",
      "GOOG,,,,1001",
    ].join("\n");
    const result = parsePickListText(csv);
    expect(result.members.map((member) => member.symbol)).toEqual(["AAPL"]);
    expect(
      result.rejects.map((reject) => [reject.line, reject.reason])
    ).toEqual([
      [3, "Not a ticker: 123BAD"],
      [4, "Duplicate"],
      [5, "Missing ticker"],
      [6, "Bad weight"],
      [7, "Bad date (use YYYY-MM-DD or M/D/YYYY)"],
      [8, "Bad target price"],
      [9, "Bad rank (1-1000)"],
      [10, "Bad date (use YYYY-MM-DD or M/D/YYYY)"],
      [11, "Bad rank (1-1000)"],
    ]);
    expect(result.rejects[0]?.text).toBe("123BAD,,,,");
  });

  it("caps a list at 200 members and rejects the rest", () => {
    const tickers = Array.from({ length: 202 }, (_, index) => {
      const a = String.fromCharCode(65 + Math.floor(index / 26));
      const b = String.fromCharCode(65 + (index % 26));
      return `X${a}${b}`;
    });
    const result = parsePickListText(tickers.join(" "));
    expect(result.members).toHaveLength(200);
    expect(result.rejects.map((reject) => reject.reason)).toEqual([
      "Over 200 members",
      "Over 200 members",
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parsePickListText(" \n# only comments")).toEqual({
      members: [],
      rejects: [],
    });
  });

  it("exposes small helpers", () => {
    expect(splitCells('a,"b ""q"", c",d', ",")).toEqual(["a", 'b "q", c', "d"]);
    expect(cleanSymbol(" nyse:brk.b ")).toBe("BRK.B");
    expect(parseWeight("0.5", false)).toBe(0.5);
    expect(parseWeight("50", true)).toBe(0.5);
    expect(parseWeight("5,5%", true)).toBe(0.055);
    expect(parseWeight("x", true)).toBeNull();
    expect(parseWeight("150%", true)).toBeNull();
    expect(isPercentColumn("Weight", ["0.5", "0.2"])).toBe(false);
    expect(isPercentColumn("Weight %", ["0.5"])).toBe(true);
    expect(isPercentColumn("Weight", ["0.5", "2"])).toBe(true);
    expect(isPercentColumn("Weight", ["0.5%"])).toBe(true);
    expect(parseDate("1/2/2026")).toBe("2026-01-02");
    expect(parseDate("2026/01/02")).toBeNull();
    expect(parseDate("2/30/2026")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(slugifyListName("  Moby Top Picks!! ")).toBe("moby-top-picks");
    expect(slugifyListName(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(MANUAL_IMPORT_SOURCES.map((source) => source.id)).toEqual([
      "moby",
      "propicks",
      "owner",
    ]);
  });
});
