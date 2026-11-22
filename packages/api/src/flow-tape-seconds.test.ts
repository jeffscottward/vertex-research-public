import { describe, expect, it } from "vitest";

import {
  countTapeSeconds,
  TAPE_SECONDS_FAILURE_PREFIX,
  type TapeSecondsInput,
  tapeSecondsFailureNote,
} from "./flow-tape-seconds.ts";
import type { TapePrint } from "./flow-trade-signing.ts";

// 2026-11-02T15:00:00Z, a whole minute.
const M = 1_793_631_600;
const print = (t: number, size = 1): TapePrint => [t, 6870.5, size, null, null];
const input = (
  overrides: Partial<TapeSecondsInput> = {}
): TapeSecondsInput => ({
  contract: "ESZ6",
  covered: [],
  end: M + 120,
  prints: [],
  since: M,
  symbol: "ES",
  ...overrides,
});
const zeros = (): number[] => new Array<number>(60).fill(0);

describe("countTapeSeconds", () => {
  it("counts each print and its size in the second of its exchange time", () => {
    const rows = countTapeSeconds(
      input({
        covered: [[M, M + 119]],
        prints: [
          print(M + 7, 2),
          print(M + 7, 3),
          print(M + 59),
          print(M + 60),
        ],
      })
    );
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    const trades = zeros();
    trades[7] = 2;
    trades[59] = 1;
    const contracts = zeros();
    contracts[7] = 5;
    contracts[59] = 1;
    expect(first).toEqual({
      contract: "ESZ6",
      contracts,
      covered: "1".repeat(60),
      minute: new Date(M * 1000),
      symbol: "ES",
      totalTrades: 3,
      trades,
    });
    expect(second?.minute).toEqual(new Date((M + 60) * 1000));
    expect(second?.trades[0]).toBe(1);
    expect(second?.totalTrades).toBe(1);
  });

  it("gives a covered minute without a print a row of zeros, and an unseen minute no row", () => {
    const rows = countTapeSeconds(input({ covered: [[M + 60, M + 119]] }));
    expect(rows).toEqual([
      {
        contract: "ESZ6",
        contracts: zeros(),
        covered: "1".repeat(60),
        minute: new Date((M + 60) * 1000),
        symbol: "ES",
        totalTrades: 0,
        trades: zeros(),
      },
    ]);
  });

  it("counts a print of a second that is not covered and leaves its mask at 0", () => {
    const [row] = countTapeSeconds(
      input({ covered: [[M, M + 9]], end: M + 60, prints: [print(M + 30, 4)] })
    );
    expect(row?.covered).toBe("1".repeat(10) + "0".repeat(50));
    expect(row?.trades[30]).toBe(1);
    expect(row?.contracts[30]).toBe(4);
    expect(row?.totalTrades).toBe(1);
  });

  it("stores a minute that has a print and no covered second", () => {
    const [row] = countTapeSeconds(
      input({ end: M + 60, prints: [print(M + 1)] })
    );
    expect(row?.covered).toBe("0".repeat(60));
    expect(row?.totalTrades).toBe(1);
  });

  it("cuts covered pairs to the read range and marks both minutes of a pair that crosses an edge", () => {
    const rows = countTapeSeconds(
      input({
        covered: [
          [M - 30, M + 4],
          [M + 50, M + 69],
          [M + 110, M + 500],
        ],
      })
    );
    expect(rows.map((row) => row.covered)).toEqual([
      "1".repeat(5) + "0".repeat(45) + "1".repeat(10),
      "1".repeat(10) + "0".repeat(40) + "1".repeat(10),
    ]);
  });

  it("marks both parts of two pairs in one minute", () => {
    const [row] = countTapeSeconds(
      input({
        covered: [
          [M, M + 1],
          [M + 58, M + 59],
        ],
        end: M + 60,
      })
    );
    expect(row?.covered).toBe(`11${"0".repeat(56)}11`);
  });

  it("ignores a print before the range and a print at its end", () => {
    const rows = countTapeSeconds(
      input({ end: M + 60, prints: [print(M - 1), print(M + 60)] })
    );
    expect(rows).toEqual([]);
  });

  it("stores a size sum as a whole number", () => {
    const [row] = countTapeSeconds(
      input({ end: M + 60, prints: [print(M, 1.3), print(M, 1.3)] })
    );
    expect(row?.contracts[0]).toBe(3);
  });

  it("cuts a contract name to 20 characters and names an empty one by the symbol", () => {
    const one = (contract: string) =>
      countTapeSeconds(
        input({ contract, end: M + 60, prints: [print(M)], symbol: "NQ" })
      )[0]?.contract;
    expect(one("N".repeat(25))).toBe("N".repeat(20));
    expect(one("")).toBe("NQ");
  });

  it("gives no row for an empty range or a range that ends before its start", () => {
    expect(countTapeSeconds(input({ end: M, prints: [print(M)] }))).toEqual([]);
    expect(
      countTapeSeconds(input({ covered: [[M - 60, M]], end: M - 60 }))
    ).toEqual([]);
  });
});

describe("tapeSecondsFailureNote", () => {
  it("names the wrapped driver error of the collector by its causeName", () => {
    const error = Object.assign(new Error("permission denied"), {
      causeName: "PostgresError",
    });
    expect(tapeSecondsFailureNote(error)).toBe(
      `${TAPE_SECONDS_FAILURE_PREFIX} (PostgresError)`
    );
  });

  it("names another error by its name and a thrown value by its type", () => {
    expect(tapeSecondsFailureNote(new RangeError("bad"))).toBe(
      "; per-second counts not stored (RangeError)"
    );
    expect(tapeSecondsFailureNote("text")).toBe(
      "; per-second counts not stored (string)"
    );
    expect(tapeSecondsFailureNote(null)).toBe(
      "; per-second counts not stored (object)"
    );
    expect(tapeSecondsFailureNote({ causeName: 7 })).toBe(
      "; per-second counts not stored (object)"
    );
  });

  it("cuts a long name to 40 characters", () => {
    const error = Object.assign(new Error("x"), { causeName: "E".repeat(60) });
    expect(tapeSecondsFailureNote(error)).toBe(
      `; per-second counts not stored (${"E".repeat(40)})`
    );
  });

  it("adds the SQLSTATE code of the error or of a cause", () => {
    const driver = Object.assign(new Error("no table"), { code: "42P01" });
    expect(tapeSecondsFailureNote(driver)).toBe(
      "; per-second counts not stored (Error 42P01)"
    );
    const wrapped = Object.assign(new Error("wrapped", { cause: driver }), {
      causeName: "DrizzleQueryError",
    });
    expect(tapeSecondsFailureNote(wrapped)).toBe(
      "; per-second counts not stored (DrizzleQueryError 42P01)"
    );
    const deeper = new Error("outer", {
      cause: new Error("middle", {
        cause: Object.assign(new Error("inner"), { code: "42501" }),
      }),
    });
    expect(tapeSecondsFailureNote(deeper)).toBe(
      "; per-second counts not stored (Error 42501)"
    );
  });

  // The chain of the collector: its wrapper (it names its cause), the query builder's error with
  // the plain name, then the cause.
  const wrapped = (cause: Error): Error => {
    const query = new Error("Failed query: insert ...", { cause });
    return Object.assign(new Error(query.message, { cause: query }), {
      causeName: query.name,
      name: "FlowStorageError",
    });
  };

  it("names a cause below the wrappers of the collector and of the query builder", () => {
    expect(tapeSecondsFailureNote(wrapped(new RangeError("bad size")))).toBe(
      "; per-second counts not stored (RangeError)"
    );
  });

  it("reads a database fault as Error with its SQLSTATE code: the driver names its error 'error'", () => {
    // node-postgres: DatabaseError with the name "error" and the code of the server.
    const driver = Object.assign(new Error("permission denied"), {
      code: "42501",
      name: "error",
    });
    expect(tapeSecondsFailureNote(wrapped(driver))).toBe(
      "; per-second counts not stored (Error 42501)"
    );
  });

  it("adds a system code when no link has an SQLSTATE code", () => {
    const refused = Object.assign(new Error("connect"), {
      code: "ECONNREFUSED",
    });
    const query = new Error("Failed query", { cause: refused });
    const wrapper = Object.assign(new Error("Failed query", { cause: query }), {
      causeName: "Error",
      name: "FlowStorageError",
    });
    expect(tapeSecondsFailureNote(wrapper)).toBe(
      "; per-second counts not stored (Error ECONNREFUSED)"
    );
    // The SQLSTATE code goes first, also when a system code is nearer.
    const both = Object.assign(
      new Error("outer", {
        cause: Object.assign(new Error("inner"), { code: "23514" }),
      }),
      { code: "CONNECT_TIMEOUT" }
    );
    expect(tapeSecondsFailureNote(both)).toBe(
      "; per-second counts not stored (Error 23514)"
    );
    // A code of another form is not shown: lower case, too long, or SQL-like text.
    for (const code of ["econnrefused", "A".repeat(17), "drop table x"])
      expect(
        tapeSecondsFailureNote(Object.assign(new Error("x"), { code }))
      ).toBe("; per-second counts not stored (Error)");
  });

  it("ignores a code that is not text and stops after five causes", () => {
    const numeric = Object.assign(new Error("n"), { code: 42_501 });
    expect(tapeSecondsFailureNote(numeric)).toBe(
      "; per-second counts not stored (Error)"
    );
    // error -> 6 causes; the code sits on the sixth cause, one link too far.
    let chain: Error = Object.assign(new Error("deepest"), { code: "23514" });
    for (let link = 0; link < 6; link += 1)
      chain = new Error(`link ${link}`, { cause: chain });
    expect(tapeSecondsFailureNote(chain)).toBe(
      "; per-second counts not stored (Error)"
    );
    // One link less: the code is on the fifth cause and is found.
    expect(tapeSecondsFailureNote(chain.cause)).toBe(
      "; per-second counts not stored (Error 23514)"
    );
  });
});
