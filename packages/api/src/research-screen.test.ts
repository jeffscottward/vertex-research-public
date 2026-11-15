import { describe, expect, it } from "vitest";

import {
  boundedMessages,
  CALENDAR_UNVERIFIED_LIMITATION,
  type CatalogEntry,
  completedBars,
  effectiveRow,
  momentumPercentOf,
  parseCatalogEntry,
  RESEARCH_SCREEN_LIMITATIONS,
  RESEARCH_SCREEN_LIMITS,
  RESEARCH_SCREEN_WARNING_TEXTS,
  type ResearchScreenBar,
  type ResearchScreenEvidence,
  type ResearchScreenQuote,
  runStatusOf,
  type ScreenObservation,
  schedulerStateOf,
  screenReport,
} from "./research-screen.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const FIRST_DAY = Date.parse("2026-01-01T00:00:00Z");

/** N synthetic daily bars on consecutive dates from 2026-01-01, oldest first. */
const makeBars = (
  count: number,
  shape: (index: number) => Partial<ResearchScreenBar> & { c: number }
): ResearchScreenBar[] =>
  Array.from({ length: count }, (_, index) => {
    const part = shape(index);
    return {
      date: new Date(FIRST_DAY + index * DAY_MS).toISOString().slice(0, 10),
      h: part.c + 1,
      l: part.c - 1,
      o: part.c,
      ...part,
    };
  });

/**
 * The fixed series: 60 bars, 2026-01-01 to 2026-03-01.
 * Bars 0..39: close 50 + 0.5 x index (50 to 69.5). Bars 40..59: close 70.
 * High = close + 1, low = close - 1, but bar 45 has the high `spikeHigh`.
 */
const fixedSeries = (spikeHigh = 78, lastClose = 70): ResearchScreenBar[] =>
  makeBars(60, (index) => {
    if (index < 40) return { c: 50 + index * 0.5 };
    if (index === 45) return { c: 70, h: spikeHigh, l: 69 };
    if (index === 59) return { c: lastClose, h: 71, l: 69 };
    return { c: 70 };
  });

const NOW = new Date("2026-03-02T15:00:00Z");

const entry: CatalogEntry = {
  aliases: [],
  assetType: "equity",
  currency: "USD",
  hasContractSpecs: false,
  id: "report-1",
  providerSymbol: "TEST",
  status: "ready",
  symbol: "TEST",
  timeZone: "America/New_York",
};

const quoteOf = (
  part: Partial<ResearchScreenQuote> = {}
): ResearchScreenQuote => ({
  currency: "USD",
  instrumentType: "EQUITY",
  price: 70.05,
  quoteAt: new Date("2026-03-02T14:55:00Z"),
  sessionEnd: new Date("2026-03-02T21:00:00Z"),
  sessionStart: new Date("2026-03-02T14:30:00Z"),
  timeZone: "America/New_York",
  ...part,
});

const evidenceOf = (
  part: Partial<ResearchScreenEvidence> = {}
): ResearchScreenEvidence => ({
  bars: fixedSeries(),
  barsSource: "yahoo",
  fetchError: null,
  quote: quoteOf(),
  ...part,
});

const observe = (
  evidence: ResearchScreenEvidence,
  catalog: CatalogEntry = entry,
  now: Date = NOW
): ScreenObservation => {
  const result = screenReport(catalog, evidence, now);
  if (!result.ok) throw new Error(`screen failed: ${result.errorCode}`);
  return result.observation;
};

const failureCode = (
  evidence: ResearchScreenEvidence,
  catalog: CatalogEntry = entry
): string => {
  const result = screenReport(catalog, evidence, NOW);
  if (result.ok) throw new Error("screen did not fail");
  expect(result.errorMessage.length).toBeGreaterThan(0);
  return result.errorCode;
};

const codesOf = (observation: ScreenObservation): string[] =>
  observation.blockingWarnings.map((warning) => warning.code);

describe("RESEARCH_SCREEN_LIMITS and texts", () => {
  it("holds the constants of the design", () => {
    expect(RESEARCH_SCREEN_LIMITS).toEqual({
      historyAgeLimitMs: 345_600_000,
      ibkrFailureStop: 3,
      leaseSeconds: 240,
      maxMessageLength: 400,
      maxMessages: 24,
      minimumBars: 50,
      quoteAgeLimitMs: 14_400_000,
      runDeadlineMs: 1_500_000,
      schedulerLateMs: 1_800_000,
      schedulerOkMs: 600_000,
      shareBudgetMs: 50_000,
      swinglyticsStaleMs: 14_400_000,
      yahooRateLimitStop: 3,
    });
    expect(Object.isFrozen(RESEARCH_SCREEN_LIMITS)).toBe(true);
  });

  it("has 4 limitation texts and a calendar text without forbidden words", () => {
    const texts = [
      ...RESEARCH_SCREEN_LIMITATIONS,
      CALENDAR_UNVERIFIED_LIMITATION,
      ...Object.values(RESEARCH_SCREEN_WARNING_TEXTS),
    ];
    expect(RESEARCH_SCREEN_LIMITATIONS).toHaveLength(4);
    expect(RESEARCH_SCREEN_LIMITATIONS[3]).toContain(
      "Options are not checked by this screen."
    );
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(400);
      expect(text).not.toMatch(
        /unknown|n\/a|unavailable|not available|not set/i
      );
    }
  });

  it("bounds message lists", () => {
    const many = Array.from({ length: 30 }, (_, index) => `message ${index}`);
    expect(boundedMessages(many)).toHaveLength(24);
    expect(boundedMessages(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(boundedMessages(["x".repeat(500)])).toEqual(["x".repeat(400)]);
  });
});

describe("parseCatalogEntry", () => {
  const report = {
    assetType: null,
    id: "report-1",
    identityStatus: "verified",
    metadata: { currency: "USD", other: 1, timeZone: "America/New_York" },
    providerSymbol: "TEST.X",
    status: "ready",
    symbol: "TEST",
  };
  const invalid = (key: string) => ({
    errorCode: "metadata-invalid",
    errorMessage: `The catalog field ${key} is missing or not valid.`,
    ok: false,
  });

  it("parses a minimal entry: null asset type is equity, aliases default empty", () => {
    expect(parseCatalogEntry(report)).toEqual({
      entry: {
        aliases: [],
        assetType: "equity",
        currency: "USD",
        hasContractSpecs: false,
        id: "report-1",
        providerSymbol: "TEST.X",
        status: "ready",
        symbol: "TEST",
        timeZone: "America/New_York",
      },
      ok: true,
    });
  });

  it("parses aliases and contract specs", () => {
    const aliases = [{ confirmed: false, input: "AAA", resolution: "TEST" }];
    const result = parseCatalogEntry({
      ...report,
      assetType: "future",
      metadata: {
        ...report.metadata,
        aliases,
        contractSpecs: { multiplier: 5 },
      },
    });
    expect(result).toMatchObject({
      entry: { aliases, assetType: "future", hasContractSpecs: true },
      ok: true,
    });
  });

  it("names the first failed key", () => {
    const withMeta = (metadata: unknown) =>
      parseCatalogEntry({ ...report, metadata });
    expect(withMeta(null)).toEqual(invalid("metadata"));
    expect(withMeta("text")).toEqual(invalid("metadata"));
    expect(
      parseCatalogEntry({ ...report, assetType: "crypto", metadata: {} })
    ).toEqual(invalid("assetType"));
    expect(withMeta({ timeZone: "UTC" })).toEqual(invalid("currency"));
    expect(withMeta({ currency: "usd", timeZone: "UTC" })).toEqual(
      invalid("currency")
    );
    expect(withMeta({ currency: "USDX", timeZone: "UTC" })).toEqual(
      invalid("currency")
    );
    expect(withMeta({ currency: "USD" })).toEqual(invalid("timeZone"));
    expect(withMeta({ currency: "USD", timeZone: "" })).toEqual(
      invalid("timeZone")
    );
    expect(withMeta({ currency: "USD", timeZone: "Mars/Olympus" })).toEqual(
      invalid("timeZone")
    );
    expect(
      withMeta({ ...report.metadata, aliases: [{ input: "AAA" }] })
    ).toEqual(invalid("aliases"));
    expect(withMeta({ ...report.metadata, contractSpecs: 5 })).toEqual(
      invalid("contractSpecs")
    );
  });

  it("refuses an identity that is not verified", () => {
    expect(parseCatalogEntry({ ...report, identityStatus: "pending" })).toEqual(
      {
        errorCode: "identity-unverified",
        errorMessage: "The catalog identity of this report is not verified.",
        ok: false,
      }
    );
  });
});

describe("screenReport failure steps", () => {
  it("step 2: gives the error code of the price read", () => {
    for (const code of [
      "provider-http",
      "provider-timeout",
      "rate-limited",
    ] as const)
      expect(failureCode(evidenceOf({ fetchError: code, quote: null }))).toBe(
        code
      );
    expect(failureCode(evidenceOf({ quote: null }))).toBe("provider-http");
  });

  it("step 3: identity mismatch of type, currency or time zone", () => {
    const mismatch = (part: Partial<ResearchScreenQuote>) =>
      failureCode(evidenceOf({ quote: quoteOf(part) }));
    expect(mismatch({ instrumentType: "ETF" })).toBe("identity-mismatch");
    expect(mismatch({ instrumentType: null })).toBe("identity-mismatch");
    expect(mismatch({ currency: "CAD" })).toBe("identity-mismatch");
    expect(mismatch({ timeZone: "Europe/London" })).toBe("identity-mismatch");
    // Step 3 comes before step 4.
    expect(mismatch({ currency: "CAD", price: null })).toBe(
      "identity-mismatch"
    );
  });

  it("step 3: each asset type expects its instrument type", () => {
    const pairs = [
      ["etf", "ETF"],
      ["future", "FUTURE"],
      ["index", "INDEX"],
    ] as const;
    for (const [assetType, instrumentType] of pairs) {
      const catalog = { ...entry, assetType };
      expect(failureCode(evidenceOf(), catalog)).toBe("identity-mismatch");
      const result = screenReport(
        catalog,
        evidenceOf({ quote: quoteOf({ instrumentType }) }),
        NOW
      );
      expect(result.ok).toBe(true);
    }
  });

  it("step 4: the quote needs a price above 0 and a provider time", () => {
    const missing = (part: Partial<ResearchScreenQuote>) =>
      failureCode(evidenceOf({ quote: quoteOf(part) }));
    expect(missing({ price: null })).toBe("quote-missing");
    expect(missing({ price: 0 })).toBe("quote-missing");
    expect(missing({ price: Number.NaN })).toBe("quote-missing");
    expect(missing({ quoteAt: null })).toBe("quote-missing");
  });

  it("step 5: needs 50 completed bars", () => {
    expect(failureCode(evidenceOf({ bars: [] }))).toBe("too-few-bars");
    const result = screenReport(
      entry,
      evidenceOf({ bars: fixedSeries().slice(11) }),
      NOW
    );
    expect(result).toMatchObject({
      errorCode: "too-few-bars",
      errorMessage:
        "The screen needs at least 50 completed daily bars; it received 49.",
      ok: false,
    });
    expect(
      screenReport(entry, evidenceOf({ bars: fixedSeries().slice(10) }), NOW).ok
    ).toBe(true);
  });

  it("step 5: the bar of the session that still runs does not count", () => {
    // 50 bars end on 2026-03-02, the date of the running session.
    const bars = makeBars(61, (index) => ({ c: 50 + index })).slice(11);
    expect(failureCode(evidenceOf({ bars }))).toBe("too-few-bars");
  });

  it("step 6: refuses bars with invalid high or low, and a zero ATR", () => {
    const broken = (part: Partial<ResearchScreenBar>) =>
      failureCode(
        evidenceOf({
          bars: fixedSeries().map((bar, index) =>
            index === 5 ? { ...bar, ...part } : bar
          ),
        })
      );
    expect(broken({ h: 0 })).toBe("invalid-ohlc");
    expect(broken({ l: 0 })).toBe("invalid-ohlc");
    expect(broken({ l: Number.NaN })).toBe("invalid-ohlc");
    expect(broken({ h: 52 })).toBe("invalid-ohlc"); // close 52.5
    expect(broken({ l: 53 })).toBe("invalid-ohlc");
    const flat = makeBars(60, () => ({ c: 10, h: 10, l: 10 }));
    expect(failureCode(evidenceOf({ bars: flat }))).toBe("invalid-ohlc");
  });
});

describe("completedBars", () => {
  const bar = (date: string, c = 10): ResearchScreenBar => ({
    c,
    date,
    h: c + 1,
    l: c - 1,
    o: c,
  });
  const zone = "America/New_York";

  it("keeps valid bars, one per date, oldest first", () => {
    const bars = [
      bar("2026-02-27"),
      bar("2026-02-26", 11),
      bar("2026-02-27", 99),
      bar("2026-02-25", 0),
      bar("2026-02-24", Number.POSITIVE_INFINITY),
      bar("bad-date"),
      bar("2026-13-01"),
      bar("2026-02-30"),
      bar("2026-03-03"),
      bar("2026-03-02"),
    ];
    expect(completedBars(bars, quoteOf(), zone, NOW)).toEqual([
      bar("2026-02-26", 11),
      bar("2026-02-27"),
    ]);
  });

  it("counts the bar of the session date after the session end or without session times", () => {
    const bars = [bar("2026-03-01"), bar("2026-03-02")];
    const after = new Date("2026-03-02T21:00:00Z");
    expect(completedBars(bars, quoteOf(), zone, after)).toHaveLength(2);
    expect(
      completedBars(bars, quoteOf({ sessionStart: null }), zone, NOW)
    ).toHaveLength(2);
    expect(
      completedBars(bars, quoteOf({ sessionEnd: null }), zone, NOW)
    ).toHaveLength(2);
  });

  it("uses the date of now in the entry time zone", () => {
    // 2026-03-03 02:00 UTC is still 2026-03-02 in New York.
    const late = new Date("2026-03-03T02:00:00Z");
    const bars = [bar("2026-03-02"), bar("2026-03-03")];
    expect(completedBars(bars, quoteOf(), zone, late)).toEqual([
      bar("2026-03-02"),
    ]);
    expect(completedBars(bars, quoteOf(), "UTC", late)).toHaveLength(2);
  });
});

describe("screenReport values", () => {
  it("fixed series of 60 bars: every value, computed by hand", () => {
    const observation = observe(evidenceOf());
    // True range of every bar is 2 (high - low), but bar 45 has 78 - 69 = 9.
    // Wilder: ATR is 2 up to bar 44; at bar 45 (2 x 13 + 9) / 14 = 2.5; then
    // 14 more bars (46..59) each move the excess over 2 by 13/14:
    // atr = 2 + 0.5 x (13/14)^14 = 2.177168...
    const atr = 2 + 0.5 * (13 / 14) ** 14;
    expect(atr).toBeCloseTo(2.177_168, 5);
    // support = lowest low of bars 40..59 = 70 - 1 = 69.
    expect(observation.support).toBe(69);
    // target = highest high of bars 40..59 = the high of bar 45 = 78.
    expect(observation.target).toBe(78);
    // buy zone = 69 to min(78, 69 + atr / 2) = 69 to 70.088584.
    expect(observation.buyZone.low).toBe(69);
    expect(observation.buyZone.high).toBeCloseTo(70.088_584, 5);
    expect(observation.buyZone.high).toBeCloseTo(69 + atr / 2, 9);
    // stop = 69 - atr = 66.822832.
    expect(observation.stop).toBeCloseTo(66.822_832, 5);
    // reward to risk = (78 - 70.05) / (70.05 - 66.822832) = 7.95 / 3.227168 = 2.46346.
    expect(observation.rewardRisk).toBeCloseTo(7.95 / (70.05 - 69 + atr), 9);
    expect(observation.rewardRisk).toBeCloseTo(2.463_46, 4);
    // change = (70.05 / 70 - 1) x 100; the bar before the quote date is bar 59.
    expect(observation.changePercent).toBeCloseTo(0.071_429, 5);
    // momentum = (close of bar 59 / close of bar 39 - 1) x 100 = (70 / 69.5 - 1) x 100.
    expect(observation.momentumPercent).toBeCloseTo(0.719_424, 5);
    // sma20 = mean of bars 40..59 = 70. sma50 = mean of bars 10..59 =
    // (30 closes 55..69.5 with mean 62.25 = 1867.5, plus 20 x 70 = 1400) / 50 = 65.35.
    // trend: 70 >= 70, 70 > 65.35, momentum > 0 -> 30. In zone: 69 <= 70.05 <= 70.0886 -> 25.
    // Reward 2.46 >= 2 -> 25. Quote age 5 minutes and history age 15 hours -> 20. Score 100.
    expect(observation.score).toBe(100);
    expect(observation.action).toBe("review-entry");
    expect(observation.blockingWarnings).toEqual([]);
    expect(observation.price).toBe(70.05);
    expect(observation.quoteAt).toEqual(new Date("2026-03-02T14:55:00Z"));
    // End of the day of the last bar (2026-03-01): 2026-03-02 00:00 UTC.
    expect(observation.historyAt).toEqual(new Date("2026-03-02T00:00:00Z"));
    expect(observation.reasons).toHaveLength(4);
    expect(observation.reasons[0]).toMatch(/^The trend holds/);
    expect(observation.reasons[1]).toMatch(/inside the buy zone/);
    expect(observation.reasons[2]).toMatch(/at least 2 to 1/);
    expect(observation.reasons[3]).toMatch(/last 20 completed sessions/);
    expect(observation.warnings).toEqual([
      "These levels are for research only. They are no order and no advice.",
      "Options are not checked by this screen.",
    ]);
  });

  it("change is null when no completed bar is before the quote date", () => {
    const quote = quoteOf({ quoteAt: new Date("2025-12-31T15:00:00Z") });
    const observation = observe(evidenceOf({ quote }));
    expect(observation.changePercent).toBeNull();
    expect(codesOf(observation)).toEqual(["quote-stale"]);
  });

  it("momentum is null with fewer than 21 closes", () => {
    const closes = Array.from({ length: 21 }, (_, index) => 100 + index);
    expect(momentumPercentOf(closes)).toBeCloseTo(20, 9);
    expect(momentumPercentOf(closes.slice(1))).toBeNull();
    expect(momentumPercentOf([])).toBeNull();
  });

  it("stop and reward to risk are null when support minus ATR is not above 0", () => {
    // Range 2.5 on every bar: ATR 2.5, support 0.5, 0.5 - 2.5 < 0.
    const bars = makeBars(60, () => ({ c: 1, h: 3, l: 0.5 }));
    const observation = observe(
      evidenceOf({ bars, quote: quoteOf({ price: 0.6 }) })
    );
    expect(observation.stop).toBeNull();
    expect(observation.rewardRisk).toBeNull();
    expect(observation.buyZone).toEqual({ high: 1.75, low: 0.5 });
    expect(observation.action).toBe("wait");
    expect(observation.score).toBe(45);
  });

  it("reward to risk is null when the price is at or above the target or at or below the stop", () => {
    const at = (price: number) =>
      observe(evidenceOf({ quote: quoteOf({ price }) }));
    expect(at(78).rewardRisk).toBeNull();
    expect(at(80).rewardRisk).toBeNull();
    expect(at(60).rewardRisk).toBeNull();
    expect(at(60).stop).not.toBeNull();
    expect(codesOf(at(60))).toEqual(["outside-buy-zone", "reward-below-2"]);
    expect(at(60).action).toBe("watch");
    expect(at(60).score).toBe(50);
  });

  it("a split-like jump inside the window still computes", () => {
    const bars = makeBars(60, (index) => ({ c: index < 50 ? 100 : 50 }));
    const observation = observe(
      evidenceOf({ bars, quote: quoteOf({ price: 50 }) })
    );
    expect(observation.support).toBe(49);
    expect(observation.target).toBe(101);
    expect(observation.changePercent).toBe(0);
    expect(observation.momentumPercent).toBe(-50);
    expect(observation.action).toBe("wait");
  });
});

describe("screenReport blocking warnings, score and action", () => {
  const only = (observation: ScreenObservation, code: string) => {
    expect(observation.blockingWarnings).toEqual([
      {
        code,
        text: RESEARCH_SCREEN_WARNING_TEXTS[
          code as keyof typeof RESEARCH_SCREEN_WARNING_TEXTS
        ],
      },
    ]);
  };

  it("quote-stale alone: older than 4 hours, and a future quote", () => {
    const at = (quoteAt: string) =>
      observe(evidenceOf({ quote: quoteOf({ quoteAt: new Date(quoteAt) }) }));
    const old = at("2026-03-02T10:59:59Z");
    only(old, "quote-stale");
    expect(old.score).toBe(80);
    expect(old.action).toBe("watch");
    only(at("2026-03-02T15:00:01Z"), "quote-stale");
    expect(at("2026-03-02T11:00:00Z").action).toBe("review-entry");
    expect(at("2026-03-02T15:00:00Z").action).toBe("review-entry");
  });

  it("history-stale alone: the last bar is older than 4 days", () => {
    const quote = (now: Date) =>
      quoteOf({
        quoteAt: new Date(now.getTime() - MINUTE_MS),
        sessionEnd: null,
        sessionStart: null,
      });
    // historyAt is 2026-03-02 00:00 UTC; 4 days later is the limit.
    const limit = new Date("2026-03-06T00:00:00Z");
    const atLimit = observe(evidenceOf({ quote: quote(limit) }), entry, limit);
    expect(atLimit.action).toBe("review-entry");
    const after = new Date(limit.getTime() + 1);
    const stale = observe(evidenceOf({ quote: quote(after) }), entry, after);
    only(stale, "history-stale");
    expect(stale.score).toBe(80);
    expect(stale.action).toBe("watch");
  });

  it("history-stale alone: the ended session has no bar", () => {
    const now = new Date("2026-03-02T21:00:00Z");
    const quote = quoteOf({ quoteAt: new Date("2026-03-02T20:59:00Z") });
    const stale = observe(evidenceOf({ quote }), entry, now);
    only(stale, "history-stale");
    // With the bar of 2026-03-02 the history is current, though its end of
    // day (2026-03-03 00:00 UTC) is after now.
    const bars = [
      ...fixedSeries(),
      { c: 70, date: "2026-03-02", h: 71, l: 69, o: 70 },
    ];
    const current = observe(evidenceOf({ bars, quote }), entry, now);
    expect(codesOf(current)).not.toContain("history-stale");
    expect(current.historyAt).toEqual(new Date("2026-03-03T00:00:00Z"));
  });

  it("trend-not-aligned alone gives wait", () => {
    // Last close 69.5: sma20 = (19 x 70 + 69.5) / 20 = 69.975 > 69.5, and
    // momentum = 69.5 / 69.5 - 1 = 0.
    const observation = observe(evidenceOf({ bars: fixedSeries(78, 69.5) }));
    only(observation, "trend-not-aligned");
    expect(observation.score).toBe(70);
    expect(observation.action).toBe("wait");
    expect(observation.reasons[0]).toBe(
      RESEARCH_SCREEN_WARNING_TEXTS["trend-not-aligned"]
    );
  });

  it("trend fails when sma20 is not above sma50", () => {
    const bars = makeBars(60, () => ({ c: 70 }));
    const observation = observe(evidenceOf({ bars }));
    expect(codesOf(observation)).toContain("trend-not-aligned");
  });

  it("outside-buy-zone alone", () => {
    // Price 70.5 is above 70.0886; reward = 7.5 / (70.5 - 66.8228) = 2.04.
    const observation = observe(
      evidenceOf({ quote: quoteOf({ price: 70.5 }) })
    );
    only(observation, "outside-buy-zone");
    expect(observation.score).toBe(75);
    expect(observation.action).toBe("watch");
    expect(observation.reasons[1]).toBe(
      RESEARCH_SCREEN_WARNING_TEXTS["outside-buy-zone"]
    );
    const below = observe(evidenceOf({ quote: quoteOf({ price: 68.9 }) }));
    expect(codesOf(below)).toEqual(["outside-buy-zone"]);
  });

  it("reward-below-2 alone", () => {
    // Bar 45 high 76: atr = 2 + (5/14) x (13/14)^14 = 2.126548; zone high
    // 70.0633; stop 66.873452; reward = 5.95 / 3.176548 = 1.8731.
    const observation = observe(evidenceOf({ bars: fixedSeries(76) }));
    only(observation, "reward-below-2");
    expect(observation.rewardRisk).toBeCloseTo(1.8731, 3);
    expect(observation.score).toBe(75);
    expect(observation.action).toBe("watch");
    expect(observation.reasons[2]).toBe(
      RESEARCH_SCREEN_WARNING_TEXTS["reward-below-2"]
    );
  });

  it("catalog-not-ready alone", () => {
    const observation = observe(evidenceOf(), { ...entry, status: "draft" });
    only(observation, "catalog-not-ready");
    expect(observation.score).toBe(100);
    expect(observation.action).toBe("watch");
  });

  it("future-not-executable alone, with the futures and currency notes", () => {
    const observation = observe(
      evidenceOf({
        quote: quoteOf({ currency: "EUR", instrumentType: "FUTURE" }),
      }),
      { ...entry, assetType: "future", currency: "EUR" }
    );
    only(observation, "future-not-executable");
    expect(observation.warnings).toEqual([
      "These levels are for research only. They are no order and no advice.",
      "Prices and levels are in EUR, not in USD.",
      "The prices come from a provider futures series. A roll between contracts can move the levels.",
      "Options are not checked by this screen.",
    ]);
  });

  it("alias-unconfirmed alone, with one line per alias", () => {
    const aliases = [
      { confirmed: true, input: "AAA", resolution: "TEST" },
      { confirmed: false, input: "BBB", resolution: "TEST" },
    ];
    const confirmed = observe(evidenceOf(), {
      ...entry,
      aliases: aliases.slice(0, 1),
    });
    expect(confirmed.action).toBe("review-entry");
    const observation = observe(evidenceOf(), { ...entry, aliases });
    only(observation, "alias-unconfirmed");
    expect(observation.warnings).toContain("Alias AAA: TEST (confirmed).");
    expect(observation.warnings).toContain("Alias BBB: TEST (not confirmed).");
  });

  it("bounds the warnings", () => {
    const aliases = Array.from({ length: 30 }, (_, index) => ({
      confirmed: true,
      input: `${index}-${"x".repeat(500)}`,
      resolution: "TEST",
    }));
    const { warnings } = observe(evidenceOf(), { ...entry, aliases });
    expect(warnings).toHaveLength(24);
    expect(Math.max(...warnings.map((text) => text.length))).toBe(400);
  });

  it("all conditions fail: score 0 and wait", () => {
    const bars = makeBars(60, (index) => ({ c: 100 - index }));
    const quote = quoteOf({
      price: 90,
      quoteAt: new Date("2026-03-01T15:00:00Z"),
    });
    const observation = observe(evidenceOf({ bars, quote }));
    expect(observation.score).toBe(0);
    expect(observation.action).toBe("wait");
    expect(codesOf(observation)).toEqual([
      "quote-stale",
      "trend-not-aligned",
      "outside-buy-zone",
      "reward-below-2",
    ]);
  });
});

describe("effectiveRow", () => {
  const row = (ageMs: number | null, action = "review-entry" as const) => ({
    action,
    id: "row-1",
    quoteAt: ageMs === null ? null : new Date(NOW.getTime() - ageMs),
    score: 100,
    warnings: ["note"],
  });
  const expired = {
    action: "watch",
    id: "row-1",
    score: 80,
    storedAction: "review-entry",
    storedScore: 100,
    warnings: ["note", RESEARCH_SCREEN_WARNING_TEXTS["entry-expired"]],
  };

  it("keeps a row with a quote of 3 hours 59 minutes, and at the limit", () => {
    const stored = row(3 * HOUR_MS + 59 * MINUTE_MS);
    expect(effectiveRow(stored, NOW)).toEqual({
      ...stored,
      storedAction: "review-entry",
      storedScore: 100,
    });
    expect(effectiveRow(row(4 * HOUR_MS), NOW).action).toBe("review-entry");
    expect(effectiveRow(row(0), NOW).action).toBe("review-entry");
  });

  it("expires a row at 4 hours 1 minute, with a future quote and with no quote time", () => {
    for (const age of [4 * HOUR_MS + MINUTE_MS, -1, null])
      expect(effectiveRow(row(age), NOW)).toMatchObject(expired);
  });

  it("does not let the score go below 0", () => {
    const stored = { ...row(null), score: 10 };
    expect(effectiveRow(stored, NOW).score).toBe(0);
  });

  it("changes no row with another action", () => {
    for (const action of ["watch", "wait", "unavailable"] as const) {
      const stored = { ...row(null), action };
      expect(effectiveRow(stored, NOW)).toEqual({
        ...stored,
        storedAction: action,
        storedScore: 100,
      });
    }
  });
});

describe("runStatusOf", () => {
  it("gives completed, partial or failed", () => {
    const of = (total: number, succeeded: number, failed: number) =>
      runStatusOf({
        failed,
        notReached: total - succeeded - failed,
        succeeded,
        total,
      });
    expect(of(3, 3, 0)).toBe("completed");
    expect(of(3, 2, 1)).toBe("partial");
    expect(of(3, 1, 0)).toBe("partial");
    expect(of(3, 0, 3)).toBe("failed");
    expect(of(3, 0, 0)).toBe("failed");
    expect(of(0, 0, 0)).toBe("failed");
  });
});

describe("schedulerStateOf", () => {
  it("gives never, ok, late or silent", () => {
    const at = (ageMs: number) =>
      schedulerStateOf(new Date(NOW.getTime() - ageMs), NOW);
    expect(schedulerStateOf(null, NOW)).toBe("never");
    expect(at(-1)).toBe("ok");
    expect(at(0)).toBe("ok");
    expect(at(10 * MINUTE_MS)).toBe("ok");
    expect(at(10 * MINUTE_MS + 1)).toBe("late");
    expect(at(30 * MINUTE_MS)).toBe("late");
    expect(at(30 * MINUTE_MS + 1)).toBe("silent");
  });
});
