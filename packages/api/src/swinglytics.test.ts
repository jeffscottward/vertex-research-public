import { describe, expect, it } from "vitest";

import {
  parseSwinglyticsHtml,
  SWINGLYTICS_LIMITS,
  SWINGLYTICS_PARSE_ERRORS,
  SWINGLYTICS_URL,
  SWINGLYTICS_WARNING,
  SwinglyticsParseError,
  SwinglyticsSnapshotSchema,
} from "./swinglytics.ts";

// Synthetic page: invented values in the element form the parser reads. No copy of the site.
const script = (body: string): string => `<script>${body}</script>`;
const chunk = (lines: string): string =>
  script(`self.__next_f.push(${JSON.stringify([1, lines])})`);
const line = (id: string, value: unknown): string =>
  `${id}:${JSON.stringify(value)}\n`;
const page = (...elements: string[]): string =>
  `<!doctype html><html><head><script src="/a.js" async></script></head><body>${elements.join("")}</body></html>`;

type Fields = Record<string, unknown>;

const dashboard = (overrides: Fields = {}): Fields => ({
  breadth: {
    breadth_regime: "Neutral",
    breadth_score: 55.5,
    pct_above_20d: { current: 42.5 },
    pct_above_50d: { current: 50 },
    pct_above_200d: { current: 61 },
  },
  generated_at: "2030-01-07T15:00:00Z",
  market_regime: {
    regime: "Test Regime",
    risk_level: "Moderate",
    trend_strength: "Strong",
  },
  scanner: {
    bearish: [
      { name: "Ccc Corp", sector: "Energy", ticker: "CCC", top_pattern: "Top" },
    ],
    bullish: [
      {
        name: "Aaa Corp",
        sector: "Technology",
        setup_label: "Label",
        ticker: "aaa",
        top_pattern: "Ignored",
      },
      { ticker: "BBB.B" },
    ],
    scan_stats: {
      bearish_candidates: 3,
      bullish_candidates: 4,
      total_scanned: 500.9,
      with_setups: 7,
    },
  },
  themes: [
    { avg_change_1d: 1.5, bias: "bullish", name: "Theme One" },
    { name: "Theme Two" },
  ],
  vix: { level: 18.5, percentile_1y: 40, regime: "Calm", trend: "Falling" },
  ...overrides,
});

const dashboardPage = (overrides: Fields = {}): string =>
  page(chunk(line("5", ["$", "div", null, { data: dashboard(overrides) }])));

const snapshotOf = (overrides: Fields = {}) =>
  parseSwinglyticsHtml(dashboardPage(overrides)).snapshot;

const refusal = (html: string): unknown => {
  try {
    parseSwinglyticsHtml(html);
  } catch (error) {
    return error;
  }
  return null;
};

const expectRefusal = (html: string, message: string): void => {
  const error = refusal(html);
  expect(error).toBeInstanceOf(SwinglyticsParseError);
  expect(error).toMatchObject({ message, name: "SwinglyticsParseError" });
};

describe("constants", () => {
  it("pins the site, the warning and the limits", () => {
    expect(SWINGLYTICS_URL).toBe("https://www.swinglytics.com/");
    expect(SWINGLYTICS_WARNING).toBe(
      "Third-party context only. Swinglytics is not Vertex research, not a market measurement of the platform, not an input of the screen and not an order signal."
    );
    expect(SWINGLYTICS_LIMITS).toMatchObject({
      maxChunkBytes: 400_000,
      maxChunks: 100,
      maxNodes: 20_000,
    });
  });
});

describe("parseSwinglyticsHtml", () => {
  it("reads a complete page", () => {
    const html = page(
      script("window.other = 1"),
      chunk(`${line("1", "text")}no separator line\n2:not json\n`),
      chunk(line("3", { generated_at: "2030-01-01T00:00:00Z", vix: 1 })),
      // One line split over two chunks.
      chunk(line("5", [1, null, { data: dashboard() }]).slice(0, 40)),
      chunk(line("5", [1, null, { data: dashboard() }]).slice(40)),
      chunk(line("6", dashboard({ generated_at: "2031-01-01T00:00:00Z" }))),
      '<script>self.__next_f.push([1,"never closed"])'
    );
    const parsed = parseSwinglyticsHtml(html);
    expect(parsed.generatedAt).toEqual(new Date("2030-01-07T15:00:00Z"));
    expect(parsed.snapshot).toEqual({
      breadth: {
        above20DayPercent: 42.5,
        above50DayPercent: 50,
        above200DayPercent: 61,
        regime: "Neutral",
        score: 55.5,
      },
      regime: {
        label: "Test Regime",
        riskLevel: "Moderate",
        trendStrength: "Strong",
      },
      scanner: { bearish: 3, bullish: 4, total: 500, withSetups: 7 },
      setups: [
        {
          direction: "bullish",
          name: "Aaa Corp",
          pattern: "Label",
          sector: "Technology",
          ticker: "AAA",
        },
        {
          direction: "bullish",
          name: null,
          pattern: null,
          sector: null,
          ticker: "BBB.B",
        },
        {
          direction: "bearish",
          name: "Ccc Corp",
          pattern: "Top",
          sector: "Energy",
          ticker: "CCC",
        },
      ],
      themes: [
        { bias: "bullish", changePercent: 1.5, name: "Theme One" },
        { bias: null, changePercent: null, name: "Theme Two" },
      ],
      vix: {
        level: 18.5,
        percentile1Year: 40,
        regime: "Calm",
        trend: "Falling",
      },
    });
    expect(SwinglyticsSnapshotSchema.parse(parsed.snapshot)).toEqual(
      parsed.snapshot
    );
  });

  it("refuses a page with no matching script", () => {
    expectRefusal(
      page(script("window.other = 1")),
      SWINGLYTICS_PARSE_ERRORS.noDashboard
    );
    expectRefusal("", SWINGLYTICS_PARSE_ERRORS.noDashboard);
  });

  it("accepts 100 chunks and refuses 101", () => {
    const filler = Array.from({ length: 99 }, () => chunk(line("1", 0)));
    const last = chunk(line("5", dashboard()));
    expect(
      parseSwinglyticsHtml(page(...filler, last)).snapshot.regime.label
    ).toBe("Test Regime");
    expectRefusal(
      page(chunk(line("1", 0)), ...filler, last),
      SWINGLYTICS_PARSE_ERRORS.tooManyChunks
    );
  });

  it("refuses an oversized chunk", () => {
    expectRefusal(
      page(chunk("x".repeat(SWINGLYTICS_LIMITS.maxChunkBytes))),
      SWINGLYTICS_PARSE_ERRORS.chunkTooLarge
    );
  });

  it("skips a chunk that is not JSON or has no string item", () => {
    const html = page(
      script("self.__next_f.push(not json)"),
      script("self.__next_f.push([0])"),
      script('self.__next_f.push({"1":"x"})')
    );
    expectRefusal(html, SWINGLYTICS_PARSE_ERRORS.noDashboard);
    expect(
      parseSwinglyticsHtml(`${html}${chunk(line("5", dashboard()))}`).snapshot
        .regime.label
    ).toBe("Test Regime");
  });

  it("refuses a page with no dashboard object", () => {
    for (const key of ["market_regime", "breadth", "vix", "scanner"]) {
      expectRefusal(
        dashboardPage({ [key]: "text" }),
        SWINGLYTICS_PARSE_ERRORS.noDashboard
      );
    }
  });

  it("refuses a missing or invalid generated_at", () => {
    for (const generated_at of [undefined, 5, "not a time", ""]) {
      expectRefusal(
        dashboardPage({ generated_at }),
        SWINGLYTICS_PARSE_ERRORS.noDashboard
      );
    }
  });

  it("refuses a missing regime label", () => {
    for (const regime of [undefined, 7, " \u0000 "]) {
      expectRefusal(
        dashboardPage({ market_regime: { regime } }),
        SWINGLYTICS_PARSE_ERRORS.noRegimeLabel
      );
    }
  });

  it("refuses data above the search limit", () => {
    const wide = Array.from({ length: SWINGLYTICS_LIMITS.maxNodes }, () => 0);
    expectRefusal(
      page(chunk(line("1", wide)), chunk(line("5", dashboard()))),
      SWINGLYTICS_PARSE_ERRORS.tooManyNodes
    );
  });

  it("refuses a very wide array or object with the search limit, not a stack overflow", () => {
    const zeros = "0,".repeat(190_000);
    expectRefusal(
      page(chunk(`1:[${zeros}0]\n`)),
      SWINGLYTICS_PARSE_ERRORS.tooManyNodes
    );
    const wide = Object.fromEntries(
      Array.from({ length: 30_000 }, (_, index) => [`k${index}`, 0])
    );
    expectRefusal(
      page(chunk(line("1", wide))),
      SWINGLYTICS_PARSE_ERRORS.tooManyNodes
    );
  });

  it("reads the script element in every tag form", () => {
    const argument = JSON.stringify([1, line("5", dashboard())]);
    const body = `self.__next_f.push(${argument})`;
    for (const element of [
      `<SCRIPT>${body}</SCRIPT>`,
      `<script type="text/javascript" nonce="n">${body}</script>`,
      `<Script\n>${body}</Script >`,
      `<script\tdata-a="1">\n  ${body}\n</script>`,
      // Tags that only start like a script element are not one.
      `<scripts>${body}</scripts><script-x>${body}</script-x><script>${body}</script>`,
      // An element that is never closed takes the text up to the next closing tag.
      `<script>self.__next_f.push(0)<script>${body}</script><script>${body}</script>`,
    ]) {
      expect(parseSwinglyticsHtml(page(element)).snapshot.regime.label).toBe(
        "Test Regime"
      );
    }
    for (const element of [
      `<scripts>${body}</scripts>`,
      `<script-x>${body}</script-x>`,
      `<script>${body}`,
      `<script ${body}</script`,
      `${body}</script>`,
      "<script",
    ]) {
      expectRefusal(element, SWINGLYTICS_PARSE_ERRORS.noDashboard);
    }
  });

  it("scans a hostile page of 1,000,000 bytes in linear time", () => {
    const size = 1_000_000;
    // A linear scan needs some milliseconds and a quadratic one more than a minute, so a bound
    // of 5 seconds tells them apart on a loaded runner too.
    const limitMs = 5000;
    const fill = (unit: string): string => unit.repeat(size / unit.length);
    const closed = `${fill("<script ")}></script>`;
    for (const html of [
      // Opening tags that never end.
      fill("<script "),
      // Elements that are never closed.
      fill("<script>"),
      // Opening tags that end only at the last byte, and are then closed.
      closed,
      fill("<scriptx"),
      fill("<script\n"),
      fill("</script"),
      fill("<SCRIPT></"),
      fill("<<<<<<<<"),
      fill("<script>a</script>".padEnd(20)),
    ]) {
      expect(new TextEncoder().encode(html).byteLength).toBeGreaterThanOrEqual(
        size
      );
      const startedAt = performance.now();
      const error = refusal(html);
      const elapsed = performance.now() - startedAt;
      expect(error).toMatchObject({
        message: SWINGLYTICS_PARSE_ERRORS.noDashboard,
      });
      expect(elapsed).toBeLessThan(limitMs);
    }
  });

  it("turns out-of-range and non-numeric numbers into null", () => {
    const snapshot = snapshotOf({
      breadth: {
        breadth_score: 100.5,
        pct_above_20d: { current: 101 },
        pct_above_50d: "text",
        pct_above_200d: { current: -100 },
      },
      scan_stats: { total_scanned: 9 },
      scanner: {
        scan_stats: {
          bearish_candidates: 1_000_001,
          bullish_candidates: "4",
          total_scanned: -1,
          with_setups: 1_000_000,
        },
      },
      vix: { level: -0.5, percentile_1y: null },
    });
    expect(snapshot.breadth).toEqual({
      above20DayPercent: null,
      above50DayPercent: null,
      above200DayPercent: -100,
      regime: null,
      score: null,
    });
    expect(snapshot.vix).toEqual({
      level: null,
      percentile1Year: null,
      regime: null,
      trend: null,
    });
    expect(snapshot.scanner).toEqual({
      bearish: null,
      bullish: null,
      total: null,
      withSetups: 1_000_000,
    });
    expect(snapshot.setups).toEqual([]);
  });

  it("reads the scan counts beside the scanner when it has none", () => {
    const snapshot = snapshotOf({
      scan_stats: { total_scanned: 9 },
      scanner: {},
    });
    expect(snapshot.scanner.total).toBe(9);
    expect(snapshotOf({ scanner: {} }).scanner.total).toBeNull();
  });

  it("keeps the first of duplicate themes and skips unnamed items", () => {
    const snapshot = snapshotOf({
      themes: [
        { avg_change_1d: 1, name: "Same" },
        "text",
        { name: 5 },
        { avg_change_1d: 2, name: " Same " },
        { avg_change_1d: 3, name: "Other" },
      ],
    });
    expect(snapshot.themes).toEqual([
      { bias: null, changePercent: 1, name: "Same" },
      { bias: null, changePercent: 3, name: "Other" },
    ]);
    expect(snapshotOf({ themes: "text" }).themes).toEqual([]);
  });

  it("drops the half of a character pair that the cut leaves, and a lone surrogate", () => {
    // U+1F600 is two UTF-16 units (a surrogate pair).
    const pair = "\u{1F600}";
    const names = snapshotOf({
      themes: [
        { name: `${"x".repeat(59)}${pair}` },
        { name: `${"y".repeat(58)}${pair}tail` },
        { name: `Lone \ud83d high, \ude00 low, ${pair} pair\ud83d` },
        { name: "\ud83d" },
      ],
    }).themes.map((theme) => theme.name);
    expect(names).toEqual([
      "x".repeat(59),
      `${"y".repeat(58)}${pair}`,
      `Lone  high,  low, ${pair} pair`,
    ]);
    // No name holds a surrogate outside a pair.
    for (const name of names) {
      expect(name).not.toMatch(/\p{Cs}/u);
      expect(JSON.parse(JSON.stringify(name))).toBe(name);
    }
    const bias = snapshotOf({
      themes: [{ bias: `${"b".repeat(39)}${pair}`, name: "Theme" }],
    }).themes[0]?.bias;
    expect(bias).toBe("b".repeat(39));
  });

  it("keeps 10 of 11 themes and reads only the first 20 items", () => {
    const themes = Array.from({ length: 11 }, (_, index) => ({
      name: `Theme ${index}`,
    }));
    const kept = snapshotOf({ themes }).themes;
    expect(kept).toHaveLength(10);
    expect(kept.at(-1)?.name).toBe("Theme 9");
    const late = [
      ...Array.from({ length: 20 }, () => ({ name: "Same" })),
      { name: "Late" },
    ];
    expect(
      snapshotOf({ themes: late }).themes.map((theme) => theme.name)
    ).toEqual(["Same"]);
  });

  it("skips an invalid ticker and a repeated ticker", () => {
    const snapshot = snapshotOf({
      scanner: {
        bearish: "text",
        bullish: [
          { ticker: "BAD TICKER" },
          { ticker: "TOOLONGTICKER1" },
          { name: "No ticker" },
          null,
          { ticker: "AAA" },
          { name: "Second", ticker: "aaa" },
        ],
      },
    });
    expect(snapshot.setups.map((setup) => setup.ticker)).toEqual([
      "TOOLONGTICKE",
      "AAA",
    ]);
    expect(snapshot.setups[1]?.name).toBeNull();
  });

  it("keeps 5 of 6 setups in one direction", () => {
    const six = ["AA", "BB", "CC", "DD", "EE", "FF"].map((ticker) => ({
      ticker,
    }));
    const snapshot = snapshotOf({ scanner: { bearish: six, bullish: six } });
    expect(snapshot.setups.map((setup) => setup.ticker)).toEqual([
      "AA",
      "BB",
      "CC",
      "DD",
      "EE",
      "AA",
      "BB",
      "CC",
      "DD",
      "EE",
    ]);
    expect(
      snapshot.setups.filter((setup) => setup.direction === "bearish")
    ).toHaveLength(5);
  });

  it("removes control and direction characters and cuts texts", () => {
    const snapshot = snapshotOf({
      market_regime: {
        regime: "  Te\u0000st\u202e \u2066Regime\u0085\n ",
        risk_level: "\u0007",
        trend_strength: "x".repeat(61),
      },
    });
    expect(snapshot.regime).toEqual({
      label: "Test Regime",
      riskLevel: null,
      trendStrength: "x".repeat(60),
    });
  });
});

describe("SwinglyticsSnapshotSchema", () => {
  const valid = () => snapshotOf();

  it("refuses duplicate theme names and 11 themes", () => {
    const theme = { bias: null, changePercent: null, name: "Same" };
    expect(
      SwinglyticsSnapshotSchema.safeParse({
        ...valid(),
        themes: [theme, theme],
      }).success
    ).toBe(false);
    const themes = Array.from({ length: 11 }, (_, index) => ({
      ...theme,
      name: `Theme ${index}`,
    }));
    expect(
      SwinglyticsSnapshotSchema.safeParse({ ...valid(), themes }).success
    ).toBe(false);
  });

  it("refuses 6 setups in one direction and an invalid ticker", () => {
    const setup = {
      direction: "bullish",
      name: null,
      pattern: null,
      sector: null,
      ticker: "AAA",
    };
    const setups = Array.from({ length: 6 }, () => setup);
    expect(
      SwinglyticsSnapshotSchema.safeParse({ ...valid(), setups }).success
    ).toBe(false);
    expect(
      SwinglyticsSnapshotSchema.safeParse({
        ...valid(),
        setups: [{ ...setup, ticker: "aaa" }],
      }).success
    ).toBe(false);
    expect(
      SwinglyticsSnapshotSchema.safeParse({ ...valid(), extra: 1 }).success
    ).toBe(false);
  });
});
