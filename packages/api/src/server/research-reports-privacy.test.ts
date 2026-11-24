import { describe, expect, it } from "vitest";

import {
  isPrivateResearchText,
  sanitizeResearchDatasetData,
} from "./research-reports-privacy.ts";

describe("research-reports-privacy", () => {
  it("detects private broker, NLV, portfolio, account and user-order text", () => {
    expect(isPrivateResearchText("IBKR broker refresh snapshot")).toBe(true);
    expect(isPrivateResearchText("Cap at 2% of NLV")).toBe(true);
    expect(isPrivateResearchText("Net liquidation value check")).toBe(true);
    expect(isPrivateResearchText("Pending order for shares")).toBe(true);
    expect(isPrivateResearchText("Limit order already filled")).toBe(true);
    expect(isPrivateResearchText("Account margin balance")).toBe(true);
    expect(isPrivateResearchText("Portfolio exposure limit")).toBe(true);
    expect(isPrivateResearchText("Existing positions in shares")).toBe(true);
    expect(isPrivateResearchText("Current holdings summary")).toBe(true);
    expect(isPrivateResearchText("ibkr_snapshot_v2")).toBe(true);
    expect(isPrivateResearchText("broker_nlv_cap")).toBe(true);
    expect(
      isPrivateResearchText(
        "Long call expiry payoff compared across three strikes"
      )
    ).toBe(false);
  });

  it("leaves non-options-analysis datasets and non-object payloads untouched", () => {
    const technicals = { summary: "IBKR broker note", title: "Technicals" };
    expect(sanitizeResearchDatasetData("technicals", technicals)).toBe(
      technicals
    );
    expect(sanitizeResearchDatasetData("options-analysis", null)).toBeNull();
    expect(sanitizeResearchDatasetData("options-analysis", ["raw"])).toEqual([
      "raw",
    ]);
  });

  it("strips private top-level blocks, private text, extra fields, and non-hypothetical stock sizing", () => {
    const sentinel = "SENTINEL_PRIVATE_APP_991";
    const input = {
      account: { id: `${sentinel}-acct` },
      asOf: "2026-11-22",
      brokerRefresh: { note: `${sentinel}-broker-refresh` },
      currency: "USD",
      finalRecommendation: { headline: `${sentinel}-final-rec` },
      metrics: [
        {
          extraNote: `${sentinel}-metric-extra`,
          label: "Implied volatility",
          period: "30d",
          value: "42%",
        },
        { label: "Broker NLV", period: "live", value: `${sentinel}-nlv` },
        { label: "Margin", period: "Account", value: "10%" },
        null,
      ],
      priorAnalysis: { text: `${sentinel}-prior` },
      recommendation: { text: `${sentinel}-rec` },
      sections: [
        {
          body: ["Public line stays.", `IBKR ${sentinel} line drops.`],
          bullets: ["Public bullet stays.", `Pending order ${sentinel} drops.`],
          id: "tenor-and-budget",
          title: "Tenor and budget",
        },
        {
          body: [`Pending share order ${sentinel}.`],
          id: "entry",
          title: "Entry",
        },
        {
          body: ["Public body under private section id."],
          id: "ibkr_orders",
          title: "Summary",
        },
        {
          body: ["Public body under private title."],
          id: "private-title",
          title: `Account ${sentinel}`,
        },
        {
          body: [`Net liquidation ${sentinel}.`],
          id: "all-private-lines",
          title: "Risk check",
        },
        {
          id: "empty-public",
          title: "Empty public section",
        },
        `${sentinel}-raw-section-string`,
        42,
      ],
      sources: [
        {
          extra: `${sentinel}-source-extra`,
          id: "pub-1",
          title: "Public options chain",
          url: "https://example.test/chain",
        },
        {
          id: "broker-1",
          title: `IBKR ${sentinel}`,
          url: "https://example.test/private",
        },
        null,
      ],
      strategies: [
        {
          expiry: "2027-01-15",
          kind: "long-call",
          legs: [
            {
              multiplier: 100,
              note: `${sentinel}-leg-note`,
              premium: 4.5,
              side: "buy",
              strike: 100,
              type: "call",
            },
            {
              premium: 2.1,
              side: "sell",
              strike: 110,
              type: "call",
            },
            `${sentinel}-raw-string-leg`,
            42,
          ],
          multiplier: 100,
          name: `${sentinel}-strategy-name`,
          orderNote: `${sentinel}-order-note`,
        },
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: 95,
          stockShares: 100,
        },
        {
          hypothetical: false,
          kind: "stock",
          stockEntry: 123.45,
          stockShares: 9999,
        },
        {
          kind: "long-call",
          legs: `${sentinel}-malformed-legs`,
        },
        `${sentinel}-string-row`,
        123,
      ],
      stress: { note: `${sentinel}-stress` },
      summary: `Keep under 2% NLV after ${sentinel} limit order.`,
      title: `Options analysis (${sentinel} broker view)`,
      warnings: [
        "Public volatility caveat.",
        `Portfolio ${sentinel} warning.`,
        42,
      ],
    };

    const sanitized = sanitizeResearchDatasetData("options-analysis", input);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("123.45");
    expect(sanitized).toEqual({
      asOf: "2026-11-22",
      currency: "USD",
      metrics: [
        { label: "Implied volatility", period: "30d", value: "42%" },
        null,
      ],
      sections: [
        {
          body: ["Public line stays."],
          bullets: ["Public bullet stays."],
          id: "tenor-and-budget",
          title: "Tenor and budget",
        },
        {
          id: "empty-public",
          title: "Empty public section",
        },
        null,
        42,
      ],
      sources: [
        {
          id: "pub-1",
          title: "Public options chain",
          url: "https://example.test/chain",
        },
        null,
      ],
      strategies: [
        {
          expiry: "2027-01-15",
          kind: "long-call",
          legs: [
            {
              multiplier: 100,
              premium: 4.5,
              side: "buy",
              strike: 100,
              type: "call",
            },
            {
              premium: 2.1,
              side: "sell",
              strike: 110,
              type: "call",
            },
            null,
            42,
          ],
          multiplier: 100,
        },
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: 95,
          stockShares: 100,
        },
        {
          hypothetical: false,
          kind: "stock",
        },
        {
          kind: "long-call",
          legs: null,
        },
        null,
        123,
      ],
      warnings: ["Public volatility caveat.", 42],
    });
  });

  it("sanitizes malformed non-array strings and preserves public title/summary", () => {
    const sanitized = sanitizeResearchDatasetData("options-analysis", {
      metrics: "not-an-array",
      sections: "not-an-array",
      sources: "not-an-array",
      strategies: "not-an-array",
      summary: "Public summary of expiry payoffs.",
      title: "Public options analysis",
      warnings: "not-an-array",
    });

    expect(sanitized).toEqual({
      metrics: null,
      sections: null,
      sources: null,
      strategies: null,
      summary: "Public summary of expiry payoffs.",
      title: "Public options analysis",
      warnings: null,
    });
    expect(sanitizeResearchDatasetData("options-analysis", {})).toEqual({});
  });
});
