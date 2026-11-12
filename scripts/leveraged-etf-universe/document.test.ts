import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LEVERAGED_ETF_GATE_CONSTANTS,
  LEVERAGED_ETF_OPTION_GATES,
  LeveragedEtfUniverseDocumentSchema,
} from "./document.ts";

const GATE = {
  bandPct: 10,
  maxHalfSpreadPct: 4,
  maxWindowDays: 21,
  minBandOpenInterest: 1000,
  minTwoSidedQuotes: 3,
  minWindowDays: 5,
  version: 1,
};
const GENERATED_AT = "2026-11-11T15:30:00Z";
// 2026-11-11 10:20 in New York: the regular session, the same day in New York and in UTC, and 10
// minutes before GENERATED_AT.
const OPTIONS = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  twoSidedQuotes: 8,
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
const CLOSED = ["market-closed-at-quote"];
const NO_QUOTE = { halfSpreadPct: null, twoSidedQuotes: 0 };
const NO_WINDOW = {
  bandOpenInterest: null,
  halfSpreadPct: null,
  twoSidedQuotes: null,
  windowExpiry: null,
};

const documentOf = (
  funds: readonly unknown[],
  overrides: Record<string, unknown> = {}
) => ({
  funds,
  gate: GATE,
  generatedAt: GENERATED_AT,
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
    for (const leverage of [2, 3, -1, -2, -3, 1.5, 1.25, 1.2, 4, -5, 5, 0.07])
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
      ["twoSidedQuotes", -1],
      ["twoSidedQuotes", 2.5],
    ] as const)
      expect(
        problems(documentOf([gated({ [field]: value }, "pass", [])]))
      ).toContain(`funds[0].options.${field}`);
    // The count of two-sided quotes is a required key.
    const { twoSidedQuotes: _, ...withoutCount } = OPTIONS;
    expect(
      problems(documentOf([{ ...PASS, options: withoutCount }]))
    ).toContain("funds[0].options.twoSidedQuotes");
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

  it("requires the band open interest, the half spread and the quote count to follow the window expiry", () => {
    const noWindow = ["no-window-expiry", "no-two-sided-quote"];
    // Without a window expiry each of the three facts must be null.
    for (const [field, value] of [
      ["bandOpenInterest", 23_456],
      ["halfSpreadPct", 1.2],
      ["twoSidedQuotes", 8],
    ] as const)
      expect(
        problems(
          documentOf([
            gated({ ...NO_WINDOW, [field]: value }, "fail", noWindow),
          ])
        )
      ).toMatch(
        new RegExp(
          `TQQQ: must be null when windowExpiry is null[\\s\\S]*funds\\[0\\]\\.options\\.${field}`,
          "u"
        )
      );
    expect(problems(documentOf([gated(NO_WINDOW, "fail", noWindow)]))).toBe("");
    // With a window expiry the two counts must be set.
    for (const field of ["bandOpenInterest", "twoSidedQuotes"])
      expect(
        problems(documentOf([gated({ [field]: null }, "pass", [])]))
      ).toMatch(
        new RegExp(
          `TQQQ: must be a count when windowExpiry is set[\\s\\S]*funds\\[0\\]\\.options\\.${field}`,
          "u"
        )
      );
  });

  it("requires the half spread to be null exactly when there is no two-sided quote", () => {
    const unequal =
      /TQQQ: must be null exactly when twoSidedQuotes is 0[\s\S]*funds\[0\]\.options\.halfSpreadPct/u;
    expect(
      problems(
        documentOf([
          gated({ halfSpreadPct: null }, "fail", ["no-two-sided-quote"]),
        ])
      )
    ).toMatch(unequal);
    expect(
      problems(
        documentOf([
          gated({ twoSidedQuotes: 0 }, "fail", ["no-two-sided-quote"]),
        ])
      )
    ).toMatch(unequal);
    expect(
      problems(documentOf([gated(NO_QUOTE, "fail", ["no-two-sided-quote"])]))
    ).toBe("");
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
      ...NO_QUOTE,
      quotedAt: "2026-11-12T01:00:00Z",
      session: "closed",
    };
    const at = { generatedAt: "2026-11-12T02:00:00Z" };
    // 21 days after the UTC day and 22 days after the New York day.
    expect(
      problems(
        documentOf(
          [
            gated(
              { ...evening, windowExpiry: "2026-12-03" },
              "spread-not-measured",
              CLOSED
            ),
          ],
          at
        )
      )
    ).toBe("");
    // 5 days after the New York day and 4 days after the UTC day; the first expiry is the New York day.
    expect(
      problems(
        documentOf(
          [
            gated(
              {
                ...evening,
                nearestExpiries: ["2026-11-11", "2026-11-16"],
                windowExpiry: "2026-11-16",
              },
              "spread-not-measured",
              CLOSED
            ),
          ],
          at
        )
      )
    ).toBe("");
    expect(
      problems(
        documentOf(
          [
            gated(
              { ...evening, windowExpiry: "2026-12-04" },
              "spread-not-measured",
              CLOSED
            ),
          ],
          at
        )
      )
    ).toMatch(/calendar days after the quote day 2026-11-11/u);
  });
});

describe("leveraged ETF universe gate constants", () => {
  it("holds the constants of gate version 1", () => {
    const { version, ...constants } = GATE;
    expect(LEVERAGED_ETF_GATE_CONSTANTS).toEqual({ [version]: constants });
  });

  it("refuses a gate block that differs from the constants of its version", () => {
    for (const [key, value] of [
      ["bandPct", 50],
      ["maxHalfSpreadPct", 100],
      ["maxWindowDays", 365],
      ["minBandOpenInterest", 0],
      ["minTwoSidedQuotes", 1],
      ["minWindowDays", 0],
    ] as const)
      expect(
        problems(documentOf([NO_OPTIONS], { gate: { ...GATE, [key]: value } }))
      ).toMatch(
        new RegExp(
          `must be ${GATE[key]} in gate version 1; the document has ${value}[\\s\\S]*gate\\.${key}`,
          "u"
        )
      );
  });

  it("refuses an unknown gate version, a missing constant and an unknown key", () => {
    expect(
      problems(documentOf([NO_OPTIONS], { gate: { ...GATE, version: 2 } }))
    ).toMatch(/gate version 2 is not known \(known: 1\)[\s\S]*gate\.version/u);
    for (const version of [0, 1.5])
      expect(
        problems(documentOf([NO_OPTIONS], { gate: { ...GATE, version } }))
      ).toContain("gate.version");
    const { minTwoSidedQuotes: _, ...withoutMinimum } = GATE;
    expect(
      problems(documentOf([NO_OPTIONS], { gate: withoutMinimum }))
    ).toContain("gate.minTwoSidedQuotes");
    expect(
      problems(documentOf([NO_OPTIONS], { gate: { ...GATE, extra: 1 } }))
    ).toMatch(/Unrecognized key: "extra"/u);
  });

  it("reads the constants of the version, not the numbers of the document", () => {
    // The document says that the minimum is 0 and labels a fund with 5 contracts "pass".
    const text = problems(
      documentOf([gated({ bandOpenInterest: 5 }, "pass", [])], {
        gate: { ...GATE, minBandOpenInterest: 0 },
      })
    );
    expect(text).toMatch(/must be 1000 in gate version 1/u);
    expect(text).toMatch(
      /TQQQ: the gate rule gives "fail" with reasons \["open-interest-below-minimum"\]; the document has "pass" with reasons \[\]/u
    );
  });

  it("does not apply a gate rule of an unknown version, and still checks the order of the funds", () => {
    const text = problems(
      documentOf([PASS, gated({ bandOpenInterest: 5 }, "pass", [])], {
        gate: { ...GATE, version: 2 },
      })
    );
    expect(text).toMatch(/gate version 2 is not known/u);
    expect(text).toMatch(/symbol TQQQ appears more than once/u);
    expect(text).not.toMatch(/the gate rule gives/u);
  });
});

describe("leveraged ETF universe option gate", () => {
  it.each([
    ["a regular-session chain inside every threshold", {}, "pass", []],
    [
      "a half spread, a band open interest and a quote count equal to their limits",
      { bandOpenInterest: 1000, halfSpreadPct: 4, twoSidedQuotes: 3 },
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
      NO_QUOTE,
      "fail",
      ["no-two-sided-quote"],
    ],
    [
      "two two-sided quotes in the regular session",
      { twoSidedQuotes: 2 },
      "fail",
      ["too-few-two-sided-quotes"],
    ],
    [
      "one tight quote in the regular session",
      { halfSpreadPct: 0.1, twoSidedQuotes: 1 },
      "fail",
      ["too-few-two-sided-quotes"],
    ],
    [
      "two wide quotes: the spread of too few quotes is not judged",
      { halfSpreadPct: 40, twoSidedQuotes: 2 },
      "fail",
      ["too-few-two-sided-quotes"],
    ],
    [
      "thin open interest and a wide spread together",
      { bandOpenInterest: 0, halfSpreadPct: 12 },
      "fail",
      ["open-interest-below-minimum", "spread-above-maximum"],
    ],
    [
      "no window expiry in the regular session",
      NO_WINDOW,
      "fail",
      ["no-window-expiry", "no-two-sided-quote"],
    ],
    [
      "no window expiry after the close",
      { ...NO_WINDOW, session: "closed" },
      "fail",
      ["no-window-expiry"],
    ],
    [
      "a chain read after the close with enough open interest",
      { halfSpreadPct: 9, session: "closed" },
      "spread-not-measured",
      CLOSED,
    ],
    [
      "a chain read after the close with no quote",
      { ...NO_QUOTE, session: "closed" },
      "spread-not-measured",
      CLOSED,
    ],
    [
      "a chain read after the close with one quote",
      { session: "closed", twoSidedQuotes: 1 },
      "spread-not-measured",
      CLOSED,
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

  it("refuses a pass that the facts do not support", () => {
    for (const options of [
      NO_WINDOW,
      { bandOpenInterest: 999 },
      { halfSpreadPct: 4.01 },
      { twoSidedQuotes: 2 },
      NO_QUOTE,
      { session: "closed" },
    ])
      expect(problems(documentOf([gated(options, "pass", [])]))).toMatch(
        /TQQQ: the gate rule gives "(?:fail|spread-not-measured)" with reasons \[.+\]; the document has "pass" with reasons \[\][\s\S]*funds\[0\]\.optionGate/u
      );
  });

  it("refuses a label or reasons that the gate rule does not give", () => {
    const thinAndWide = { bandOpenInterest: 0, halfSpreadPct: 12 };
    for (const [options, optionGate, reasons] of [
      // A wrong label.
      [{}, "fail", []],
      [{}, "spread-not-measured", CLOSED],
      // The right label with a missing, an extra, a repeated or another reason.
      [thinAndWide, "fail", ["spread-above-maximum"]],
      [{}, "pass", CLOSED],
      [thinAndWide, "fail", ["spread-above-maximum", "spread-above-maximum"]],
      [thinAndWide, "fail", ["spread-above-maximum", "no-two-sided-quote"]],
      // A reason of a fund without option facts on a fund that has them.
      [{}, "fail", ["no-listed-options"]],
      // A quote count that says "judge the spread" with no spread to judge.
      [{ halfSpreadPct: null }, "pass", []],
    ] as const)
      expect(
        problems(documentOf([gated(options, optionGate, reasons)]))
      ).toMatch(/TQQQ: the gate rule gives[\s\S]*funds\[0\]\.optionGate/u);
  });

  it("accepts either reason of a fund without option facts, and only one of them", () => {
    const refused =
      /AAAZ: a fund without option facts is "fail" with the one reason "no-listed-options" or "no-standard-contract"; the document has/u;
    expect(
      problems(
        documentOf([
          { ...NO_OPTIONS, optionGateReasons: ["no-standard-contract"] },
        ])
      )
    ).toBe("");
    for (const [optionGate, optionGateReasons] of [
      ["fail", []],
      ["fail", ["no-listed-options", "no-standard-contract"]],
      ["fail", ["stale-chain"]],
      ["pass", []],
      ["spread-not-measured", ["no-listed-options"]],
    ] as const)
      expect(
        problems(documentOf([{ ...NO_OPTIONS, optionGate, optionGateReasons }]))
      ).toMatch(refused);
  });
});

describe("leveraged ETF universe chain age", () => {
  // A chain of Friday 2026-11-06 16:30 in New York with an expiry 7 days later.
  const friday = {
    nearestExpiries: ["2026-11-13"],
    quotedAt: "2026-11-06T21:30:00Z",
    session: "closed",
    windowExpiry: "2026-11-13",
  };

  it("accepts a chain of more than 4 New York days before generatedAt only as a stale fail", () => {
    // GENERATED_AT is on 2026-11-11 in New York: 5 days after the chain.
    expect(problems(documentOf([gated(friday, "fail", ["stale-chain"])]))).toBe(
      ""
    );
    for (const [optionGate, reasons] of [
      ["spread-not-measured", CLOSED],
      ["fail", ["open-interest-below-minimum"]],
      ["fail", ["stale-chain", "market-closed-at-quote"]],
    ] as const)
      expect(
        problems(documentOf([gated(friday, optionGate, reasons)]))
      ).toMatch(
        /TQQQ: the gate rule gives "fail" with reasons \["stale-chain"\]/u
      );
    // The other facts of a stale chain are not judged: this one has no open interest and no quote.
    expect(
      problems(
        documentOf([
          gated({ ...friday, ...NO_QUOTE, bandOpenInterest: 0 }, "fail", [
            "stale-chain",
          ]),
        ])
      )
    ).toBe("");
  });

  it("counts New York calendar days, not hours and not UTC days", () => {
    // 23:59:59 on 2026-11-06 and 00:00:00 on 2026-11-07 in New York; both are 2026-11-07 in UTC.
    expect(
      problems(
        documentOf([
          gated({ ...friday, quotedAt: "2026-11-07T04:59:59Z" }, "fail", [
            "stale-chain",
          ]),
        ])
      )
    ).toBe("");
    expect(
      problems(
        documentOf([
          gated(
            { ...friday, quotedAt: "2026-11-07T05:00:00Z" },
            "spread-not-measured",
            CLOSED
          ),
        ])
      )
    ).toBe("");
    expect(
      problems(
        documentOf([
          gated({ ...friday, quotedAt: "2026-11-07T05:00:00Z" }, "fail", [
            "stale-chain",
          ]),
        ])
      )
    ).toMatch(/the gate rule gives "spread-not-measured"/u);
  });

  it("refuses session regular for a chain of another New York day than generatedAt", () => {
    // The quotes of the day before, 10:20 in New York, with good numbers: they cannot pass.
    const yesterday = { quotedAt: "2026-11-10T15:20:00Z" };
    expect(problems(documentOf([gated(yesterday, "pass", [])]))).toMatch(
      /TQQQ: must be "closed": the chain is of 2026-11-10, and generatedAt is on 2026-11-11 \(New York days\)[\s\S]*funds\[0\]\.options\.session/u
    );
    expect(
      problems(
        documentOf([
          gated(
            { ...yesterday, session: "closed" },
            "spread-not-measured",
            CLOSED
          ),
        ])
      )
    ).toBe("");
    // The same New York day, and the next UTC day: a run in the New York evening.
    expect(
      problems(documentOf([PASS], { generatedAt: "2026-11-12T02:14:36Z" }))
    ).toBe("");
  });

  it("refuses a chain that is more than 5 minutes newer than generatedAt", () => {
    expect(
      problems(
        documentOf([gated({ quotedAt: "2026-11-11T15:35:00Z" }, "pass", [])])
      )
    ).toBe("");
    expect(
      problems(
        documentOf([gated({ quotedAt: "2026-11-11T15:35:01Z" }, "pass", [])])
      )
    ).toMatch(
      /TQQQ: must not be more than 5 minutes after generatedAt 2026-11-11T15:30:00\.000Z[\s\S]*funds\[0\]\.options\.quotedAt/u
    );
  });

  it("requires the window expiry of a fund that is not fail to be on or after the generatedAt day", () => {
    // A chain of 2026-10-01 with its expiry on 2026-10-09: both are long before GENERATED_AT.
    const october = {
      nearestExpiries: ["2026-10-09"],
      quotedAt: "2026-10-01T21:00:00Z",
      session: "closed",
      windowExpiry: "2026-10-09",
    };
    expect(
      problems(documentOf([gated(october, "fail", ["stale-chain"])]))
    ).toBe("");
    expect(
      problems(documentOf([gated(october, "spread-not-measured", CLOSED)]))
    ).toMatch(
      /TQQQ: must be on or after the generatedAt day 2026-11-11 for a fund that is not "fail"[\s\S]*funds\[0\]\.options\.windowExpiry/u
    );
  });
});

describe("leveraged ETF universe document built by the Python fetcher", () => {
  // services/research/tests/test_leveraged_etf_universe.py builds this file with the Python gate
  // rule and fails when the file and the rule differ. So the two rules cannot drift apart.
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../services/research/tests/fixtures/leveraged_etf/universe-document.json",
        import.meta.url
      ),
      "utf8"
    )
  );

  it("is accepted as it is: every label and every reason of the Python rule", () => {
    const parsed = LeveragedEtfUniverseDocumentSchema.safeParse(fixture);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(fixture);
    const funds = parsed.data?.funds ?? [];
    expect(new Set(funds.map((fund) => fund.optionGate))).toEqual(
      new Set(LEVERAGED_ETF_OPTION_GATES)
    );
    expect(
      [...new Set(funds.flatMap((fund) => fund.optionGateReasons))].sort()
    ).toEqual([
      "market-closed-at-quote",
      "no-listed-options",
      "no-standard-contract",
      "no-two-sided-quote",
      "no-window-expiry",
      "open-interest-below-minimum",
      "spread-above-maximum",
      "stale-chain",
      "too-few-two-sided-quotes",
    ]);
  });

  it("holds the real chain of PUR, read 42 days after Cboe wrote it, as a stale fail", () => {
    const parsed = LeveragedEtfUniverseDocumentSchema.parse(fixture);
    const pur = parsed.funds.find((fund) => fund.symbol === "PUR");
    expect(parsed.generatedAt).toBe("2026-11-12T02:39:56Z");
    expect(pur).toMatchObject({
      optionGate: "fail",
      optionGateReasons: ["stale-chain"],
      options: {
        quotedAt: "2026-09-30T19:09:46Z",
        session: "closed",
        windowExpiry: "2026-10-16",
      },
    });
    // The label that the first version of the rule gave to this chain is refused now.
    const judged = parsed.funds.map((fund) =>
      fund.symbol === "PUR"
        ? {
            ...fund,
            optionGateReasons: [
              "open-interest-below-minimum",
              "spread-above-maximum",
            ],
            options: { ...fund.options, session: "regular" },
          }
        : fund
    );
    const text = problems({ ...parsed, funds: judged });
    expect(text).toMatch(
      /PUR: the gate rule gives "fail" with reasons \["stale-chain"\]/u
    );
    expect(text).toMatch(/PUR: must be "closed": the chain is of 2026-09-30/u);
  });
});
