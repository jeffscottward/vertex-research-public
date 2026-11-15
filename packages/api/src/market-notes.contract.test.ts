import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  MARKET_NOTE_AS_OF_MAX_DAYS_AHEAD,
  MARKET_NOTE_DATE_MAX,
  MARKET_NOTE_DATE_MIN,
  MARKET_NOTE_LIST_MAX,
  MARKET_NOTE_MAX_CLAIMS,
  MARKET_NOTE_RAW_TEXT_MAX,
  MARKET_NOTE_RECEIVED_AT_MAX_AHEAD_MS,
  MARKET_NOTE_REVIEW_MAX_DAYS,
  MARKET_NOTE_URL_MAX,
  MarketNoteClaimSchema,
  MarketNoteSchema,
  MarketNoteSourceSchema,
  MarketNotesAddInputSchema,
  MarketNotesGetInputSchema,
  MarketNotesListInputSchema,
  MarketNotesListOutputSchema,
  MarketNotesRecordChecksInputSchema,
  MarketNotesReviewInputSchema,
  marketNotesContract,
} from "./contracts/market-notes.ts";

const addInput = (overrides: Record<string, unknown> = {}) => ({
  affected: { sectors: ["Semiconductors"], strategies: [], tickers: ["NVDA"] },
  asOf: "2026-11-10",
  claims: ["Breadth is narrowing", "Semis lead the tape"],
  ownerMessageUrl: null,
  rawText: "  Transcript of the reel.  ",
  reviewBy: "2026-11-24",
  source: {
    author: "Example Analyst",
    kind: "reel",
    url: "https://www.instagram.com/reel/abc/",
  },
  stance: { confidence: "medium", direction: "risk-off" },
  theme: "Narrow breadth under a rising index",
  ...overrides,
});

const accepts =
  (schema: { safeParse: (value: unknown) => { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

describe("market notes contract", () => {
  it("is mounted on the app contract with GET reads and POST writes", () => {
    expect(appContract.marketNotes).toBe(marketNotesContract);
    const routes = Object.fromEntries(
      Object.entries(marketNotesContract).map(([name, procedure]) => [
        name,
        `${procedure["~orpc"].route.method} ${procedure["~orpc"].route.path}`,
      ])
    );
    expect(routes).toEqual({
      add: "POST /market-notes",
      get: "GET /market-notes/{id}",
      list: "GET /market-notes",
      recordChecks: "POST /market-notes/{id}/checks",
      review: "POST /market-notes/{id}/review",
    });
  });

  it("accepts the intake body, trims the raw text and takes an optional receive time", () => {
    const parsed = MarketNotesAddInputSchema.parse(addInput());
    expect(parsed.rawText).toBe("Transcript of the reel.");
    expect(parsed).not.toHaveProperty("receivedAt");
    expect(
      MarketNotesAddInputSchema.parse(
        addInput({ receivedAt: "2026-11-11T09:00:00-05:00" })
      ).receivedAt
    ).toBe("2026-11-11T09:00:00-05:00");
    // The review date may be the market date itself.
    expect(
      accepts(MarketNotesAddInputSchema)(addInput({ reviewBy: "2026-11-10" }))
    ).toBe(true);
  });

  it("rejects an add with bad claims, dates, text or unknown keys", () => {
    const ok = accepts(MarketNotesAddInputSchema);
    for (const overrides of [
      { claims: [] },
      { claims: ["Same claim", "Same claim"] },
      {
        claims: Array.from(
          { length: MARKET_NOTE_MAX_CLAIMS + 1 },
          (_, index) => `Claim ${index}`
        ),
      },
      { claims: ["Two\nlines"] },
      { reviewBy: "2026-11-09" },
      { asOf: "11/10/2026" },
      { rawText: "   " },
      { rawText: "x".repeat(MARKET_NOTE_RAW_TEXT_MAX + 1) },
      { theme: "Line one\nLine two" },
      { ownerMessageUrl: "ftp://example.com/message" },
      { stance: { confidence: "certain", direction: "risk-off" } },
      { affected: { sectors: [], strategies: [], tickers: ["nvda"] } },
      { status: "retired" },
    ])
      expect(ok(addInput(overrides)), JSON.stringify(overrides)).toBe(false);
  });

  it("ties the source URL to the source kind", () => {
    const ok = accepts(MarketNoteSourceSchema);
    expect(ok({ author: null, kind: "owner-text", url: null })).toBe(true);
    expect(
      ok({ author: null, kind: "article", url: "https://example.com/a" })
    ).toBe(true);
    expect(
      ok({ author: null, kind: "owner-text", url: "https://example.com/a" })
    ).toBe(false);
    expect(ok({ author: null, kind: "reel", url: null })).toBe(false);
    expect(ok({ author: null, kind: "reel", url: "javascript:alert(1)" })).toBe(
      false
    );
    expect(ok({ author: null, kind: "podcast", url: null })).toBe(false);
  });

  it("keeps a claim unverified with no evidence, or checked with evidence and a time", () => {
    const ok = accepts(MarketNoteClaimSchema);
    const unverified = {
      checkedAt: null,
      evidence: null,
      id: "c1",
      status: "unverified",
      text: "Breadth is narrowing",
    };
    const checked = {
      checkedAt: "2026-11-11T15:30:00.000Z",
      evidence: "SOXX +2.1% vs SPY +0.3%",
      id: "c12",
      status: "supported",
      text: "Semis lead the tape",
    };
    expect(ok(unverified)).toBe(true);
    expect(ok(checked)).toBe(true);
    expect(ok({ ...unverified, evidence: "x" })).toBe(false);
    expect(ok({ ...checked, evidence: null })).toBe(false);
    expect(ok({ ...checked, checkedAt: null })).toBe(false);
    expect(ok({ ...checked, id: "c13" })).toBe(false);
    expect(ok({ ...checked, id: "c0" })).toBe(false);
    expect(ok({ ...checked, status: "true" })).toBe(false);
  });

  it("defaults the list scope to all and takes one optional source URL", () => {
    expect(MarketNotesListInputSchema.parse({})).toEqual({ scope: "all" });
    expect(
      MarketNotesListInputSchema.parse({
        scope: "active",
        sourceUrl: "https://example.com/a",
      })
    ).toEqual({ scope: "active", sourceUrl: "https://example.com/a" });
    const ok = accepts(MarketNotesListInputSchema);
    expect(ok({ scope: "expired" })).toBe(false);
    expect(ok({ sourceUrl: "not a url" })).toBe(false);
    expect(ok({ limit: 5 })).toBe(false);
    expect(accepts(MarketNotesGetInputSchema)({ id: "" })).toBe(false);
    expect(accepts(MarketNotesGetInputSchema)({ id: "note-1" })).toBe(true);
  });

  it("takes one check per claim, each with a status and evidence", () => {
    const ok = accepts(MarketNotesRecordChecksInputSchema);
    const check = { claimId: "c1", evidence: "Source A", status: "supported" };
    expect(ok({ checks: [check], id: "note-1" })).toBe(true);
    expect(
      ok({
        checks: [check, { ...check, claimId: "c2", status: "cannot-check" }],
        id: "note-1",
      })
    ).toBe(true);
    expect(ok({ checks: [check, check], id: "note-1" })).toBe(false);
    expect(ok({ checks: [], id: "note-1" })).toBe(false);
    // A check never sets a claim back to unverified, and always carries evidence.
    expect(
      ok({ checks: [{ ...check, status: "unverified" }], id: "note-1" })
    ).toBe(false);
    expect(ok({ checks: [{ ...check, evidence: "  " }], id: "note-1" })).toBe(
      false
    );
    expect(ok({ checks: [{ ...check, claimId: "x1" }], id: "note-1" })).toBe(
      false
    );
  });

  it("takes a renew with a date or a retire, and nothing else", () => {
    const ok = accepts(MarketNotesReviewInputSchema);
    expect(
      ok({ action: { kind: "renew", reviewBy: "2026-12-01" }, id: "note-1" })
    ).toBe(true);
    expect(ok({ action: { kind: "retire" }, id: "note-1" })).toBe(true);
    expect(ok({ action: { kind: "renew" }, id: "note-1" })).toBe(false);
    expect(
      ok({ action: { kind: "retire", reviewBy: "2026-12-01" }, id: "note-1" })
    ).toBe(false);
    expect(ok({ action: { kind: "delete" }, id: "note-1" })).toBe(false);
  });

  it("requires at least one claim and a known status on a stored note", () => {
    const stored = {
      affected: { sectors: [], strategies: [], tickers: [] },
      asOf: "2026-11-10",
      claims: [
        {
          checkedAt: null,
          evidence: null,
          id: "c1",
          status: "unverified",
          text: "Breadth is narrowing",
        },
      ],
      id: "note-1",
      ownerMessageUrl: "https://chat.example.com/m/1",
      receivedAt: "2026-11-11T14:00:00.000Z",
      reviewBy: "2026-11-24",
      source: { author: null, kind: "owner-text", url: null },
      stance: { confidence: "low", direction: "neutral" },
      status: "expired",
      theme: "Narrow breadth",
      updatedAt: "2026-11-11T14:00:00.000Z",
      verification: {
        cannotCheck: 0,
        checked: false,
        contradicted: 0,
        supported: 0,
        unverified: 1,
      },
    };
    const ok = accepts(MarketNoteSchema);
    expect(ok(stored)).toBe(true);
    expect(ok({ ...stored, claims: [] })).toBe(false);
    expect(ok({ ...stored, status: "archived" })).toBe(false);
  });
});

describe("market notes contract: text, dates and URLs the store or a prompt cannot take", () => {
  const ok = accepts(MarketNotesAddInputSchema);
  const LONE_SURROGATE = "\ud83d";

  it("refuses control, format and separator characters and lone surrogates in every line field", () => {
    const unsafe = [
      "\u0000",
      "\u0007",
      "\n",
      "\u2028",
      "\u2029",
      // Bidi override, zero-width space, zero-width joiner and byte order mark.
      "\u202e",
      "\u200b",
      "\u200d",
      "\ufeff",
      LONE_SURROGATE,
    ];
    for (const character of unsafe) {
      const text = `Before${character}after`;
      const label = `U+${character.codePointAt(0)?.toString(16)}`;
      for (const overrides of [
        { theme: text },
        { claims: [text] },
        { source: { author: text, kind: "owner-text", url: null } },
        { affected: { sectors: [text], strategies: [], tickers: [] } },
        { affected: { sectors: [], strategies: [text], tickers: [] } },
      ])
        expect(
          ok(addInput(overrides)),
          `${label} ${JSON.stringify(overrides)}`
        ).toBe(false);
    }
    // Ordinary text in any script, and an emoji (a surrogate pair), stay valid.
    expect(
      ok(
        addInput({ claims: ["Zinsen fallen – 利下げ 📉"], theme: "Übersicht" })
      )
    ).toBe(true);
  });

  it("refuses U+0000 and a lone surrogate in the raw text and in evidence, and keeps line breaks", () => {
    for (const character of ["\u0000", LONE_SURROGATE]) {
      expect(ok(addInput({ rawText: `Text${character}more` }))).toBe(false);
      expect(
        accepts(MarketNotesRecordChecksInputSchema)({
          checks: [
            {
              claimId: "c1",
              evidence: `Source${character}A`,
              status: "supported",
            },
          ],
          id: "note-1",
        })
      ).toBe(false);
    }
    expect(ok(addInput({ rawText: "Line one.\n\nLine two. 📉\u200b" }))).toBe(
      true
    );
    expect(
      accepts(MarketNotesRecordChecksInputSchema)({
        checks: [
          {
            claimId: "c1",
            evidence: "Source A.\nSource B. 📉",
            status: "supported",
          },
        ],
        id: "note-1",
      })
    ).toBe(true);
  });

  it("takes line feed, carriage return and tab in evidence and no other control, format or separator character", () => {
    const evidence = (text: string) =>
      accepts(MarketNotesRecordChecksInputSchema)({
        checks: [{ claimId: "c1", evidence: text, status: "supported" }],
        id: "note-1",
      });
    expect(evidence("Source A:\r\n\t+2.1%\nSource B: 利下げ 📉")).toBe(true);
    for (const character of [
      "\u0000",
      "\u0007",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u2028",
      "\u2029",
      "\u202e",
      "\u200b",
      "\u200d",
      "\ufeff",
      LONE_SURROGATE,
    ])
      expect(
        evidence(`Before${character}after`),
        `U+${character.codePointAt(0)?.toString(16)}`
      ).toBe(false);
    // The same rule for the evidence of a stored claim.
    expect(
      accepts(MarketNoteClaimSchema)({
        checkedAt: "2026-11-11T15:30:00.000Z",
        evidence: "Hidden\u202etext",
        id: "c1",
        status: "supported",
        text: "A claim",
      })
    ).toBe(false);
  });

  it("holds at most 100 notes in a list answer and says when older notes are left out", () => {
    expect(MARKET_NOTE_LIST_MAX).toBe(100);
    const output = {
      asOf: "2026-11-11T14:00:00.000Z",
      notes: [],
      today: "2026-11-11",
    };
    const ok = accepts(MarketNotesListOutputSchema);
    expect(ok({ ...output, truncated: false })).toBe(true);
    expect(ok({ ...output, truncated: true })).toBe(true);
    expect(ok(output)).toBe(false);
  });

  it("keeps market and review dates from 2000-01-01 to 2100-12-31", () => {
    expect(MARKET_NOTE_DATE_MIN).toBe("2000-01-01");
    expect(MARKET_NOTE_DATE_MAX).toBe("2100-12-31");
    expect(ok(addInput({ asOf: "2000-01-01", reviewBy: "2100-12-31" }))).toBe(
      true
    );
    for (const overrides of [
      { asOf: "0000-01-01" },
      { asOf: "1999-12-31" },
      { asOf: "2101-01-01", reviewBy: "2101-01-02" },
      { reviewBy: "2101-01-01" },
      { reviewBy: "9999-12-31" },
    ])
      expect(ok(addInput(overrides)), JSON.stringify(overrides)).toBe(false);
    const renew = (reviewBy: string) =>
      accepts(MarketNotesReviewInputSchema)({
        action: { kind: "renew", reviewBy },
        id: "note-1",
      });
    expect(renew("2100-12-31")).toBe(true);
    expect(renew("2101-01-01")).toBe(false);
    expect(renew("0001-01-01")).toBe(false);
  });

  it("refuses a receive time before 2000", () => {
    expect(ok(addInput({ receivedAt: "2000-01-01T00:00:00Z" }))).toBe(true);
    expect(ok(addInput({ receivedAt: "1999-12-31T23:59:59Z" }))).toBe(false);
    expect(ok(addInput({ receivedAt: "0000-01-01T00:00:00Z" }))).toBe(false);
  });

  it("refuses a URL with credentials, white space or a control or format character", () => {
    const source = (url: string) =>
      accepts(MarketNoteSourceSchema)({ author: null, kind: "article", url });
    expect(source("https://example.com/a?b=c#d")).toBe(true);
    expect(source("http://example.com:8080/a%20b")).toBe(true);
    for (const url of [
      "https://user:secret@example.com/a",
      "https://user@example.com/a",
      "https://:secret@example.com/a",
      "https://example.com/a b",
      " https://example.com/a",
      "https://example.com/a\n",
      "https:example.com/a",
      "https://",
      "ftp://example.com/a",
      "https://exa\tmple.com/a",
      "https://example.com/a\u0000",
      "https://example.com/\u202ea",
      "https://example.com/\u200ba",
      "https://example.com/\u2028a",
      "https://example.com/\ud83d",
      "not a url",
      `https://example.com/${"a".repeat(MARKET_NOTE_URL_MAX)}`,
    ])
      expect(source(url), JSON.stringify(url)).toBe(false);
    // The same rule for the owner message link and the list filter.
    expect(
      ok(addInput({ ownerMessageUrl: "https://user:secret@example.com/m" }))
    ).toBe(false);
    expect(
      accepts(MarketNotesListInputSchema)({
        sourceUrl: "https://user:secret@example.com/a",
      })
    ).toBe(false);
  });

  it("takes note ids of letters, digits, - and _ only", () => {
    const id = accepts(MarketNotesGetInputSchema);
    expect(id({ id: "0f8fad5b-d9cb-469f-a165-70867728950e" })).toBe(true);
    expect(id({ id: "note_1" })).toBe(true);
    for (const value of ["note\u00001", "note 1", "note/1", "a".repeat(65)])
      expect(id({ id: value }), JSON.stringify(value)).toBe(false);
  });

  it("states the server limits for dates and the receive time", () => {
    expect(MARKET_NOTE_REVIEW_MAX_DAYS).toBe(366);
    expect(MARKET_NOTE_AS_OF_MAX_DAYS_AHEAD).toBe(1);
    expect(MARKET_NOTE_RECEIVED_AT_MAX_AHEAD_MS).toBe(300_000);
  });
});
