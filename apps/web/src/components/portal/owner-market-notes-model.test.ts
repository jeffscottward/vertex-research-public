import type {
  MarketNote,
  MarketNoteClaim,
  MarketNotesListOutput,
  MarketNoteVerification,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  affectedGroups,
  buildOwnerMarketNotesView,
  claimView,
  httpHref,
  NO_NOTES_TEXT,
  noteView,
  ONLY_RETIRED_NOTES_TEXT,
  STALE_NOTE_LABEL,
  STALE_NOTE_NOTICE,
  sourceView,
  stanceLabel,
  utcDate,
  utcTime,
  verificationBadge,
  verificationSummary,
} from "./owner-market-notes-model.ts";

const CLAIMS: readonly MarketNoteClaim[] = [
  {
    checkedAt: "2026-11-06T15:30:00.000Z",
    evidence: "FRED series T10Y2Y closed at -0.12 on 2026-11-05.",
    id: "c1",
    status: "supported",
    text: "The 2s10s curve is inverted again.",
  },
  {
    checkedAt: "2026-11-06T23:30:00-05:00",
    evidence: "VIX closed at 17.4; the reel says above 30.",
    id: "c2",
    status: "contradicted",
    text: "The VIX is above 30.",
  },
  {
    checkedAt: "2026-11-06T15:32:00.000Z",
    evidence: "No public source for dealer desk positioning.",
    id: "c3",
    status: "cannot-check",
    text: "Dealers are short gamma at every desk.",
  },
  {
    checkedAt: null,
    evidence: null,
    id: "c4",
    status: "unverified",
    text: "Credit spreads will widen next week.",
  },
];

const verification = (
  overrides: Partial<MarketNoteVerification> = {}
): MarketNoteVerification => ({
  cannotCheck: 1,
  checked: false,
  contradicted: 1,
  supported: 1,
  unverified: 1,
  ...overrides,
});

const note = (overrides: Partial<MarketNote> = {}): MarketNote => ({
  affected: {
    sectors: ["Financials"],
    strategies: ["Breadth-90 dip basket"],
    tickers: ["SPY", "XLF"],
  },
  asOf: "2026-11-05",
  claims: [...CLAIMS],
  id: "note-1",
  ownerMessageUrl: null,
  receivedAt: "2026-11-06T14:00:00.000Z",
  reviewBy: "2026-11-20",
  source: {
    author: "Jane Doe",
    kind: "reel",
    url: "https://example.com/reel/1",
  },
  stance: { confidence: "medium", direction: "risk-off" },
  status: "active",
  theme: "Curve inversion returns while volatility stays low",
  updatedAt: "2026-11-06T15:32:00.000Z",
  verification: verification(),
  ...overrides,
});

const list = (notes: readonly MarketNote[]): MarketNotesListOutput => ({
  asOf: "2026-11-11T14:00:00.000Z",
  notes: [...notes],
  today: "2026-11-11",
  truncated: false,
});

describe("owner market notes view-model", () => {
  it("shows active notes first, then expired ones, and only counts retired notes", () => {
    const view = buildOwnerMarketNotesView(
      list([
        note({ id: "expired-new", status: "expired" }),
        note({ id: "retired-1", status: "retired" }),
        note({ id: "active-new" }),
        note({ id: "expired-old", status: "expired" }),
        note({ id: "active-old" }),
        note({ id: "retired-2", status: "retired" }),
      ])
    );
    expect(view.notes.map((item) => item.id)).toEqual([
      "active-new",
      "active-old",
      "expired-new",
      "expired-old",
    ]);
    expect(view.notes.map((item) => item.stale?.label ?? null)).toEqual([
      null,
      null,
      STALE_NOTE_LABEL,
      STALE_NOTE_LABEL,
    ]);
    expect(view.retiredCount).toBe(2);
    expect(view.retiredLine).toBe("2 retired notes are not shown.");
    expect(view.emptyText).toBeNull();
    expect(view.today).toBe("2026-11-11");
    expect(view.loadedLine).toBe("Showing notes loaded at 14:00 UTC.");
  });

  it("names the empty state, and the retired-only state", () => {
    const empty = buildOwnerMarketNotesView(list([]));
    expect(empty).toEqual({
      emptyText: NO_NOTES_TEXT,
      loadedLine: "Showing notes loaded at 14:00 UTC.",
      notes: [],
      retiredCount: 0,
      retiredLine: null,
      today: "2026-11-11",
      truncatedLine: null,
    });
    expect(NO_NOTES_TEXT).toBe("No owner market notes yet.");
    const retiredOnly = buildOwnerMarketNotesView(
      list([note({ status: "retired" })])
    );
    expect(retiredOnly.notes).toEqual([]);
    expect(retiredOnly.emptyText).toBe(ONLY_RETIRED_NOTES_TEXT);
    expect(retiredOnly.retiredLine).toBe("1 retired note is not shown.");
  });

  it("says when the answer leaves out older expired and retired notes", () => {
    expect(buildOwnerMarketNotesView(list([note()])).truncatedLine).toBeNull();
    expect(
      buildOwnerMarketNotesView({ ...list([note()]), truncated: true })
        .truncatedLine
    ).toBe("Older expired and retired notes are not listed.");
  });

  it("builds every field of a note", () => {
    expect(noteView(note())).toEqual({
      affected: [
        { label: "Tickers", values: ["SPY", "XLF"] },
        { label: "Sectors", values: ["Financials"] },
        { label: "Strategies", values: ["Breadth-90 dip basket"] },
      ],
      asOf: "2026-11-05",
      claims: CLAIMS.map(claimView),
      id: "note-1",
      receivedOn: "2026-11-06",
      reviewBy: "2026-11-20",
      source: {
        href: "https://example.com/reel/1",
        label: "Reel by Jane Doe (example.com)",
      },
      stale: null,
      stanceLabel: "Risk-off, medium confidence",
      theme: "Curve inversion returns while volatility stays low",
      verificationBadge: {
        label: "Partly checked: 1 contradicted",
        tone: "destructive",
      },
      verificationSummary:
        "1 supported, 1 contradicted, 1 cannot check, 1 unverified",
    });
  });

  it("marks an expired note as stale and says it is left out of agent context", () => {
    expect(noteView(note({ status: "expired" })).stale).toEqual({
      label: "Stale: review date passed",
      notice: STALE_NOTE_NOTICE,
    });
    expect(STALE_NOTE_NOTICE).toBe(
      "Left out of agent context until the review date is renewed."
    );
  });

  it("labels the four claim statuses and gives evidence only for checked claims", () => {
    expect(CLAIMS.map(claimView)).toEqual([
      {
        check: {
          checkedOn: "2026-11-06",
          evidence: "FRED series T10Y2Y closed at -0.12 on 2026-11-05.",
        },
        id: "c1",
        status: "supported",
        statusLabel: "Supported",
        text: "The 2s10s curve is inverted again.",
        tone: "success",
      },
      {
        // 23:30 at -05:00 is the next day in UTC.
        check: {
          checkedOn: "2026-11-07",
          evidence: "VIX closed at 17.4; the reel says above 30.",
        },
        id: "c2",
        status: "contradicted",
        statusLabel: "Contradicted",
        text: "The VIX is above 30.",
        tone: "destructive",
      },
      {
        check: {
          checkedOn: "2026-11-06",
          evidence: "No public source for dealer desk positioning.",
        },
        id: "c3",
        status: "cannot-check",
        statusLabel: "Cannot check",
        text: "Dealers are short gamma at every desk.",
        tone: "neutral",
      },
      {
        check: null,
        id: "c4",
        status: "unverified",
        statusLabel: "Unverified",
        text: "Credit spreads will widen next week.",
        tone: "warning",
      },
    ]);
  });

  it("summarizes the claim counts in a fixed order", () => {
    expect(
      verificationSummary(
        verification({
          cannotCheck: 1,
          contradicted: 1,
          supported: 2,
          unverified: 3,
        })
      )
    ).toBe("2 supported, 1 contradicted, 1 cannot check, 3 unverified");
    expect(
      verificationSummary(
        verification({
          cannotCheck: 0,
          contradicted: 0,
          supported: 0,
          unverified: 2,
        })
      )
    ).toBe("0 supported, 0 contradicted, 0 cannot check, 2 unverified");
  });

  it.each([
    [
      "every claim unverified",
      { cannotCheck: 0, contradicted: 0, supported: 0, unverified: 3 },
      { label: "Unverified", tone: "warning" },
    ],
    [
      "some claims checked, none contradicted",
      { cannotCheck: 1, contradicted: 0, supported: 1, unverified: 2 },
      { label: "Partly checked", tone: "info" },
    ],
    [
      "some claims checked, two contradicted",
      { cannotCheck: 0, contradicted: 2, supported: 1, unverified: 2 },
      { label: "Partly checked: 2 contradicted", tone: "destructive" },
    ],
    [
      "every claim checked and supported",
      { cannotCheck: 0, contradicted: 0, supported: 3, unverified: 0 },
      { label: "Checked", tone: "success" },
    ],
    [
      "every claim checked, one contradicted",
      { cannotCheck: 0, contradicted: 1, supported: 2, unverified: 0 },
      { label: "Checked: 1 contradicted", tone: "destructive" },
    ],
    [
      "every claim checked, one that cannot be checked",
      { cannotCheck: 1, contradicted: 0, supported: 2, unverified: 0 },
      { label: "Checked", tone: "neutral" },
    ],
  ] as const)("gives the headline badge for %s", (_name, counts, expected) => {
    expect(
      verificationBadge({ ...counts, checked: counts.unverified === 0 })
    ).toEqual(expected);
  });

  it("labels the source by kind and author and links only http(s) URLs", () => {
    expect(
      sourceView({
        author: null,
        kind: "article",
        url: "http://example.com/a",
      })
    ).toEqual({ href: "http://example.com/a", label: "Article (example.com)" });
    // The host is lower case and has no leading "www."; only that prefix is removed.
    expect(
      sourceView({
        author: "Example Analyst",
        kind: "reel",
        url: "https://WWW.Example.test/reel/abc?x=1",
      })
    ).toEqual({
      href: "https://WWW.Example.test/reel/abc?x=1",
      label: "Reel by Example Analyst (example.test)",
    });
    expect(
      sourceView({
        author: null,
        kind: "article",
        url: "https://news.www.example.test:8443/a",
      }).label
    ).toBe("Article (news.www.example.test)");
    expect(
      sourceView({ author: "Owner", kind: "owner-text", url: null })
    ).toEqual({ href: null, label: "Owner text by Owner" });
    // A URL that does not parse, or is not http(s), gives no host and no link.
    expect(sourceView({ author: null, kind: "reel", url: "" })).toEqual({
      href: null,
      label: "Reel",
    });
    expect(
      sourceView({ author: "A", kind: "reel", url: "ftp://example.test/a" })
    ).toEqual({ href: null, label: "Reel by A" });
    expect(httpHref("https://example.com/x?y=1")).toBe(
      "https://example.com/x?y=1"
    );
    // The contract allows only http(s); anything else is never made a link.
    expect(httpHref("javascript:alert(1)")).toBeNull();
    expect(httpHref("not a url")).toBeNull();
    expect(httpHref(null)).toBeNull();
  });

  it.each([
    [{ confidence: "high", direction: "risk-on" }, "Risk-on, high confidence"],
    [
      { confidence: "medium", direction: "risk-off" },
      "Risk-off, medium confidence",
    ],
    [{ confidence: "low", direction: "neutral" }, "Neutral, low confidence"],
  ] as const)("labels the stance %o", (stance, expected) => {
    expect(stanceLabel(stance)).toBe(expected);
  });

  it("leaves out affected groups that list nothing", () => {
    expect(
      affectedGroups({ sectors: [], strategies: [], tickers: [] })
    ).toEqual([]);
    expect(
      affectedGroups({ sectors: ["Energy"], strategies: [], tickers: [] })
    ).toEqual([{ label: "Sectors", values: ["Energy"] }]);
  });

  it("gives the UTC date of a timestamp and keeps text that is not one", () => {
    expect(utcDate("2026-11-06T23:30:00-05:00")).toBe("2026-11-07");
    expect(utcDate("2026-11-06T00:00:00.000Z")).toBe("2026-11-06");
    expect(utcDate("unknown")).toBe("unknown");
  });

  it("gives the UTC time of a timestamp and keeps text that is not one", () => {
    expect(utcTime("2026-11-06T23:30:00-05:00")).toBe("04:30 UTC");
    expect(utcTime("2026-11-11T14:00:59.999Z")).toBe("14:00 UTC");
    expect(utcTime("unknown")).toBe("unknown");
  });
});
