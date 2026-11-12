import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LEVERAGED_ETF_OPTION_GATES,
  LeveragedEtfUniverseDocumentSchema,
} from "./document.ts";

const GATE = {
  bandPct: 10,
  maxHalfSpreadPct: 4,
  maxWindowDays: 21,
  minBandOpenInterest: 1000,
  minWindowDays: 5,
  version: 1,
};
// 2026-11-11 10:20 in New York: the regular session, and the same day in New York and in UTC.
const OPTIONS = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  windowExpiry: "2026-11-20",
};
const PASS = {
  leverage: 3,
  listingExchange: "NASDAQ",
  name: "ProShares UltraPro QQQ",
  optionGate: "pass",
  optionGateReasons: [] as string[],
  options: OPTIONS as Record<string, unknown> | null,
  optionsListed: true,
  productType: "etf",
  symbol: "TQQQ",
  underlying: "QQQ" as string | null,
};
const NO_OPTIONS = {
  ...PASS,
  leverage: -2,
  name: "Example 2x Inverse Note",
  optionGate: "fail",
  optionGateReasons: ["no-listed-options"],
  options: null,
  optionsListed: false,
  productType: "etn",
  symbol: "AAAZ",
  underlying: null,
};

const documentOf = (
  funds: readonly unknown[],
  overrides: Record<string, unknown> = {}
) => ({
  funds,
  gate: GATE,
  generatedAt: "2026-11-11T15:30:00Z",
  schema: "leveraged-etf-universe-v1",
  ...overrides,
});

/** One fund with listed options: the option facts, the gate label and its reasons. */
const gated = (
  options: Record<string, unknown>,
  optionGate: string,
  optionGateReasons: readonly string[]
) => ({
  ...PASS,
  optionGate,
  optionGateReasons,
  options: { ...OPTIONS, ...options },
});

/** The readable problems of a document; an empty string means it is valid. */
const problems = (document: unknown): string => {
  const parsed = LeveragedEtfUniverseDocumentSchema.safeParse(document);
  return parsed.success ? "" : z.prettifyError(parsed.error);
};

describe("leveraged ETF universe document", () => {
  it("accepts a document with a passing fund and a fund without listed options", () => {
    const document = documentOf([NO_OPTIONS, PASS]);
    expect(LeveragedEtfUniverseDocumentSchema.parse(document)).toEqual(
      document
    );
    expect(LEVERAGED_ETF_OPTION_GATES).toEqual([
      "pass",
      "fail",
      "spread-not-measured",
    ]);
  });

  it("accepts a UTC datetime with Z or +00:00 and refuses another offset", () => {
    expect(
      problems(documentOf([PASS], { generatedAt: "2026-11-11T15:30:00+00:00" }))
    ).toBe("");
    expect(
      problems(documentOf([PASS], { generatedAt: "2026-11-11T17:30:00+02:00" }))
    ).toMatch(/must be a UTC datetime[\s\S]*generatedAt/u);
    expect(problems(documentOf([PASS], { generatedAt: "2026-11-11" }))).toMatch(
      /generatedAt/u
    );
  });

  it("refuses an unknown schema name, an unknown key, no funds and more than 2000 funds", () => {
    expect(
      problems(documentOf([PASS], { schema: "leveraged-etf-universe-v2" }))
    ).toMatch(/schema/u);
    expect(problems(documentOf([PASS], { note: "extra" }))).toMatch(
      /Unrecognized key: "note"/u
    );
    expect(problems(documentOf([{ ...PASS, note: "extra" }]))).toMatch(
      /Unrecognized key: "note"/u
    );
    expect(
      problems(documentOf([gated({ note: "extra" }, "pass", [])]))
    ).toMatch(/Unrecognized key: "note"/u);
    expect(problems(documentOf([]))).toMatch(/funds/u);
    const many = Array.from({ length: 2001 }, (_, index) => ({
      ...NO_OPTIONS,
      symbol: `F${String(index).padStart(4, "0")}`,
    }));
    expect(problems(documentOf(many))).toMatch(/funds/u);
    expect(problems(documentOf(many.slice(0, 2000)))).toBe("");
  });

  it("refuses gate constants that are out of range or in the wrong order", () => {
    expect(
      problems(documentOf([PASS], { gate: { ...GATE, minWindowDays: 22 } }))
    ).toMatch(/minWindowDays must not be larger than maxWindowDays/u);
    for (const gate of [
      { ...GATE, bandPct: 0 },
      { ...GATE, maxHalfSpreadPct: 101 },
      { ...GATE, version: 0 },
      { ...GATE, minBandOpenInterest: 1.5 },
      { ...GATE, extra: 1 },
    ])
      expect(problems(documentOf([PASS], { gate }))).toMatch(/gate/u);
  });

  it("checks the fields of a fund", () => {
    for (const [field, value] of [
      ["symbol", "tqqq"],
      ["symbol", "TOOLONGSYMBOL"],
      ["name", ""],
      ["name", "x".repeat(201)],
      ["productType", "fund"],
      ["listingExchange", ""],
      ["underlying", ""],
      ["optionsListed", "yes"],
      ["optionGate", "maybe"],
      ["optionGateReasons", ["unknown-reason"]],
    ] as const)
      expect(problems(documentOf([{ ...PASS, [field]: value }]))).toContain(
        `funds[0].${field}`
      );
    expect(problems(documentOf([{ ...PASS, underlying: null }]))).toBe("");
  });

  it("accepts the listed leverage examples and refuses 0, 1, a third decimal and more than 5", () => {
    for (const leverage of [2, 3, -1, -2, -3, 1.5, 1.25, 4, -5, 5, 0.07])
      expect(problems(documentOf([{ ...PASS, leverage }]))).toBe("");
    for (const leverage of [0, 1])
      expect(problems(documentOf([{ ...PASS, leverage }]))).toMatch(
        /must not be 0 or 1/u
      );
    expect(problems(documentOf([{ ...PASS, leverage: 1.333 }]))).toMatch(
      /must have at most 2 decimals/u
    );
    for (const leverage of [5.5, -6])
      expect(problems(documentOf([{ ...PASS, leverage }]))).toContain(
        "funds[0].leverage"
      );
  });

  it("refuses a repeated symbol and funds that are not sorted by symbol", () => {
    expect(problems(documentOf([PASS, PASS]))).toMatch(
      /symbol TQQQ appears more than once[\s\S]*funds\[1\]\.symbol/u
    );
    expect(problems(documentOf([PASS, NO_OPTIONS]))).toMatch(
      /funds must be sorted by symbol: AAAZ comes after TQQQ/u
    );
  });

  it("requires options to be null exactly when optionsListed is false", () => {
    expect(problems(documentOf([{ ...PASS, optionsListed: false }]))).toMatch(
      /TQQQ: must be null exactly when optionsListed is false[\s\S]*funds\[0\]\.options/u
    );
    expect(
      problems(documentOf([{ ...NO_OPTIONS, optionsListed: true }]))
    ).toMatch(/AAAZ: must be null exactly when optionsListed is false/u);
  });

  it("checks the fields of the option facts", () => {
    for (const [field, value] of [
      ["quotedAt", "2026-11-11T10:20:00-05:00"],
      ["session", "open"],
      ["spot", 0],
      ["nearestExpiries", []],
      [
        "nearestExpiries",
        ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11"],
      ],
      ["nearestExpiries", ["2026-02-30"]],
      ["windowExpiry", "20261120"],
      ["totalOpenInterest", -1],
      ["totalOpenInterest", 2_147_483_648],
      ["bandOpenInterest", 0.5],
      ["halfSpreadPct", 101],
    ] as const)
      expect(
        problems(documentOf([gated({ [field]: value }, "pass", [])]))
      ).toContain(`funds[0].options.${field}`);
  });

  it("requires ascending expiries on or after the quote day", () => {
    expect(
      problems(
        documentOf([
          gated({ nearestExpiries: ["2026-11-20", "2026-11-13"] }, "pass", []),
        ])
      )
    ).toMatch(/must be in ascending order without a repeated date/u);
    expect(
      problems(
        documentOf([
          gated({ nearestExpiries: ["2026-11-13", "2026-11-13"] }, "pass", []),
        ])
      )
    ).toMatch(/must be in ascending order without a repeated date/u);
    expect(
      problems(
        documentOf([
          gated({ nearestExpiries: ["2026-11-10", "2026-11-13"] }, "pass", []),
        ])
      )
    ).toMatch(/must not hold an expiry before the quote day 2026-11-11/u);
    // An expiry on the quote day itself is allowed.
    expect(
      problems(
        documentOf([
          gated({ nearestExpiries: ["2026-11-11", "2026-11-13"] }, "pass", []),
        ])
      )
    ).toBe("");
  });

  it("requires the band open interest and half spread to follow the window expiry", () => {
    const noWindow = ["no-window-expiry", "no-two-sided-quote"];
    // The band open interest is still set.
    expect(
      problems(
        documentOf([
          gated({ halfSpreadPct: null, windowExpiry: null }, "fail", noWindow),
        ])
      )
    ).toMatch(
      /TQQQ: must be null when windowExpiry is null[\s\S]*funds\[0\]\.options\.bandOpenInterest/u
    );
    expect(
      problems(
        documentOf([
          gated({ bandOpenInterest: null, windowExpiry: null }, "fail", [
            "no-window-expiry",
          ]),
        ])
      )
    ).toMatch(
      /TQQQ: must be null when windowExpiry is null[\s\S]*funds\[0\]\.options\.halfSpreadPct/u
    );
    expect(
      problems(documentOf([gated({ bandOpenInterest: null }, "pass", [])]))
    ).toMatch(/TQQQ: must be a count when windowExpiry is set/u);
  });

  it("requires the window expiry to be inside the gate window after the quote day", () => {
    // 4 days and 22 days after 2026-11-11 are outside the 5 to 21 day window.
    for (const windowExpiry of ["2026-11-15", "2026-12-03"])
      expect(
        problems(documentOf([gated({ windowExpiry }, "pass", [])]))
      ).toMatch(
        /must be 5 to 21 calendar days after the quote day 2026-11-11/u
      );
    for (const windowExpiry of ["2026-11-16", "2026-12-02"])
      expect(problems(documentOf([gated({ windowExpiry }, "pass", [])]))).toBe(
        ""
      );
  });

  it("accepts a date rule that holds for the New York day or for the UTC day of an evening chain", () => {
    // 2026-11-12 01:00 UTC is 2026-11-11 20:00 in New York (EST): two different days.
    const evening = {
      halfSpreadPct: null,
      quotedAt: "2026-11-12T01:00:00Z",
      session: "closed",
    };
    const closed = ["market-closed-at-quote"];
    // 21 days after the UTC day and 22 days after the New York day.
    expect(
      problems(
        documentOf([
          gated(
            { ...evening, windowExpiry: "2026-12-03" },
            "spread-not-measured",
            closed
          ),
        ])
      )
    ).toBe("");
    // 5 days after the New York day and 4 days after the UTC day; the first expiry is the New York day.
    expect(
      problems(
        documentOf([
          gated(
            {
              ...evening,
              nearestExpiries: ["2026-11-11", "2026-11-16"],
              windowExpiry: "2026-11-16",
            },
            "spread-not-measured",
            closed
          ),
        ])
      )
    ).toBe("");
    expect(
      problems(
        documentOf([
          gated(
            { ...evening, windowExpiry: "2026-12-04" },
            "spread-not-measured",
            closed
          ),
        ])
      )
    ).toMatch(/calendar days after the quote day 2026-11-11/u);
  });
});

describe("leveraged ETF universe option gate", () => {
  const noWindow = {
    bandOpenInterest: null,
    halfSpreadPct: null,
    windowExpiry: null,
  };

  it.each([
    ["a regular-session chain inside every threshold", {}, "pass", []],
    [
      "a half spread equal to the maximum and band open interest equal to the minimum",
      { bandOpenInterest: 1000, halfSpreadPct: 4 },
      "pass",
      [],
    ],
    [
      "band open interest below the minimum",
      { bandOpenInterest: 999 },
      "fail",
      ["open-interest-below-minimum"],
    ],
    [
      "a half spread above the maximum",
      { halfSpreadPct: 4.01 },
      "fail",
      ["spread-above-maximum"],
    ],
    [
      "no two-sided quote in the regular session",
      { halfSpreadPct: null },
      "fail",
      ["no-two-sided-quote"],
    ],
    [
      "thin open interest and a wide spread together",
      { bandOpenInterest: 0, halfSpreadPct: 12 },
      "fail",
      ["open-interest-below-minimum", "spread-above-maximum"],
    ],
    [
      "no window expiry in the regular session",
      noWindow,
      "fail",
      ["no-window-expiry", "no-two-sided-quote"],
    ],
    [
      "no window expiry after the close",
      { ...noWindow, session: "closed" },
      "fail",
      ["no-window-expiry"],
    ],
    [
      "a chain read after the close with enough open interest",
      { halfSpreadPct: 9, session: "closed" },
      "spread-not-measured",
      ["market-closed-at-quote"],
    ],
    [
      "a chain read after the close with no quote",
      { halfSpreadPct: null, session: "closed" },
      "spread-not-measured",
      ["market-closed-at-quote"],
    ],
    [
      "thin open interest after the close",
      { bandOpenInterest: 10, session: "closed" },
      "fail",
      ["open-interest-below-minimum"],
    ],
  ] as const)(
    "accepts the label of %s",
    (_name, options, optionGate, reasons) => {
      expect(problems(documentOf([gated(options, optionGate, reasons)]))).toBe(
        ""
      );
    }
  );

  it("uses the gate constants of the document", () => {
    const gate = { ...GATE, maxHalfSpreadPct: 1, minBandOpenInterest: 50_000 };
    expect(
      problems(
        documentOf(
          [
            gated({}, "fail", [
              "open-interest-below-minimum",
              "spread-above-maximum",
            ]),
          ],
          { gate }
        )
      )
    ).toBe("");
    expect(problems(documentOf([PASS], { gate }))).toMatch(
      /TQQQ: the gate rule gives "fail" with reasons \["open-interest-below-minimum","spread-above-maximum"\]; the document has "pass" with reasons \[\]/u
    );
  });

  it("accepts the reasons in any order", () => {
    expect(
      problems(
        documentOf([
          gated({ bandOpenInterest: 0, halfSpreadPct: 12 }, "fail", [
            "spread-above-maximum",
            "open-interest-below-minimum",
          ]),
        ])
      )
    ).toBe("");
  });

  it("refuses a label or reasons that the gate rule does not give", () => {
    const thinAndWide = { bandOpenInterest: 0, halfSpreadPct: 12 };
    for (const [options, optionGate, reasons] of [
      // A wrong label.
      [{}, "fail", []],
      [{}, "spread-not-measured", ["market-closed-at-quote"]],
      [{ session: "closed" }, "pass", []],
      // The right label with a missing, an extra, a repeated or another reason.
      [thinAndWide, "fail", ["spread-above-maximum"]],
      [{}, "pass", ["market-closed-at-quote"]],
      [thinAndWide, "fail", ["spread-above-maximum", "spread-above-maximum"]],
      [thinAndWide, "fail", ["spread-above-maximum", "no-two-sided-quote"]],
    ] as const)
      expect(
        problems(documentOf([gated(options, optionGate, reasons)]))
      ).toMatch(/TQQQ: the gate rule gives[\s\S]*funds\[0\]\.optionGate/u);
    expect(
      problems(documentOf([{ ...NO_OPTIONS, optionGateReasons: [] }]))
    ).toMatch(
      /AAAZ: the gate rule gives "fail" with reasons \["no-listed-options"\]; the document has "fail" with reasons \[\]/u
    );
  });
});
