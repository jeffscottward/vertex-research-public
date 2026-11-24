import { describe, expect, it } from "vitest";

import {
  isPrivateResearchText,
  sanitizeResearchDatasetData,
} from "./research-reports-privacy.ts";

describe("research-reports-privacy", () => {
  it("detects private broker, NLV, portfolio, account and user-order text including camelCase and snake_case", () => {
    const privateSamples = [
      "IBKR broker refresh snapshot",
      "interactive_brokers feed",
      "Cap at 2% of NLV",
      "Net liquidation value check",
      "net_liquidation_ratio",
      "net-liquidation-cap",
      "Pending order for shares",
      "Limit order already filled",
      "Placed order awaiting execution",
      "Submitted order for review",
      "Order active in book",
      "Account margin balance",
      "Portfolio exposure limit",
      "Existing positions in shares",
      "Existing exposure cap",
      "Current holdings summary",
      "ibkr_snapshot_v2",
      "broker_nlv_cap",
      "brokerRefresh",
      "ibkrSnapshot",
      "IBKRSnapshot",
      "nlvCap",
      "NLVCap",
      "portfolioExposure",
      "accountBalance",
      "limitOrder",
      "netLiquidation",
    ];
    for (const sample of privateSamples) {
      expect(isPrivateResearchText(sample)).toBe(true);
    }

    const publicSamples = [
      "Long call expiry payoff compared across three strikes",
      "PayoffLab 30d IV skew",
      "optionsAnalysis",
      "2026-11-22",
    ];
    for (const sample of publicSamples) {
      expect(isPrivateResearchText(sample)).toBe(false);
    }
  });

  it("leaves non-options-analysis datasets untouched and returns null for non-object options-analysis payloads", () => {
    const technicals = { summary: "IBKR broker note", title: "Technicals" };
    expect(sanitizeResearchDatasetData("technicals", technicals)).toBe(
      technicals
    );
    expect(sanitizeResearchDatasetData("options-analysis", null)).toBeNull();
    expect(
      sanitizeResearchDatasetData("options-analysis", [
        { account: "IBKR-SENTINEL" },
      ])
    ).toBeNull();
    expect(
      sanitizeResearchDatasetData("options-analysis", "IBKR NLV raw string")
    ).toBeNull();
    expect(sanitizeResearchDatasetData("options-analysis", 42)).toBeNull();
  });

  it("strips private top-level blocks, private text, nested objects/arrays, extra fields, and invalid/non-hypothetical strategy fields", () => {
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
        {
          label: "Skew ratio",
          value: 1.25,
        },
        {
          label: "Active flag",
          value: true,
        },
        { label: "Broker NLV", period: "live", value: `${sentinel}-nlv` },
        { label: "Margin", period: "Account", value: "10%" },
        { label: { nested: `${sentinel}-obj-label` }, value: { nested: 1 } },
        ["nested-array", `${sentinel}-metric-arr`],
        null,
      ],
      priorAnalysis: { text: `${sentinel}-prior` },
      recommendation: { text: `${sentinel}-rec` },
      sections: [
        {
          body: [
            "Public line stays.",
            42,
            false,
            Number.NaN,
            { nested: `${sentinel}-body-obj` },
            [`${sentinel}-body-arr`],
            `IBKR ${sentinel} line drops.`,
          ],
          bullets: [
            "Public bullet stays.",
            { nested: `${sentinel}-bullet-obj` },
            `Pending order ${sentinel} drops.`,
          ],
          id: "tenor-and-budget",
          title: "Tenor and budget",
        },
        {
          body: [`Pending share order ${sentinel}.`],
          id: "entry",
          title: "Entry",
        },
        {
          body: ["Public text under capitalized Entry id."],
          id: " Entry ",
          title: "Capitalized Entry",
        },
        {
          body: ["Public body under private section id."],
          id: "ibkr_orders",
          title: "Summary",
        },
        {
          body: ["Public body under camelCase private section id."],
          id: "brokerRefresh",
          title: "Refresh",
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
        {
          id: { nested: `${sentinel}-id-obj` },
          title: [`${sentinel}-title-arr`],
        },
        `${sentinel}-raw-section-string`,
        [`${sentinel}-section-nested-array`],
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
        {
          id: { nested: `${sentinel}-src-obj` },
          title: 99,
          url: [`${sentinel}-src-arr`],
        },
        [`${sentinel}-source-nested-array`],
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
              multiplier: "100",
              premium: 2.1,
              side: "sell",
              strike: 110,
              type: "put",
            },
            {
              multiplier: `${sentinel}-bad-mult`,
              premium: -1,
              side: `${sentinel}-side`,
              strike: `${sentinel}-strike`,
              type: `${sentinel}-type`,
            },
            `${sentinel}-raw-string-leg`,
            { nested: `${sentinel}-leg-obj` },
            [`${sentinel}-leg-arr`],
            42,
          ],
          multiplier: "100",
          name: `${sentinel}-strategy-name`,
          orderNote: `${sentinel}-order-note`,
          stockEntry: 88.88,
          stockShares: 777,
        },
        {
          expiry: `${sentinel}-expiry`,
          kind: "bull-call-spread",
          legs: [],
          multiplier: `${sentinel}-bad-strat-mult`,
        },
        {
          expiry: "2026-02-31",
          kind: "put-credit-spread",
          legs: [],
        },
        {
          expiry: "2027-06-18",
          kind: "cash-secured-put",
        },
        {
          expiry: `${sentinel}-unknown-expiry`,
          kind: `${sentinel}-kind`,
          legs: [{ side: "buy", type: "call" }],
        },
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: 95,
          stockShares: 100,
        },
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: -10,
          stockShares: 50,
        },
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: 55.5,
          stockShares: 0,
        },
        {
          hypothetical: false,
          kind: "stock",
          stockEntry: 123.45,
          stockShares: 9999,
        },
        {
          hypothetical: `${sentinel}-not-bool`,
          kind: "stock",
          stockEntry: 321.5,
          stockShares: 8888,
        },
        {
          kind: "long-call",
          legs: `${sentinel}-malformed-legs`,
        },
        {
          kind: "long-call",
          legs: { broker: `${sentinel}-obj-legs` },
        },
        `${sentinel}-string-row`,
        [`${sentinel}-row-arr`],
        123,
      ],
      stress: { note: `${sentinel}-stress` },
      summary: `Keep under 2% NLV after ${sentinel} limit order.`,
      title: `Options analysis (${sentinel} broker view)`,
      warnings: [
        "Public volatility caveat.",
        `Portfolio ${sentinel} warning.`,
        42,
        true,
        { nested: `${sentinel}-warn-obj` },
        [`${sentinel}-warn-arr`],
      ],
    };

    const sanitized = sanitizeResearchDatasetData("options-analysis", input);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("123.45");
    expect(serialized).not.toContain("8888");
    expect(serialized).not.toContain("321.5");
    expect(serialized).not.toContain("777");
    expect(serialized).not.toContain("88.88");
    expect(serialized).not.toContain("55.5");
    expect(sanitized).toEqual({
      asOf: "2026-11-22",
      currency: "USD",
      metrics: [
        { label: "Implied volatility", period: "30d", value: "42%" },
        { label: "Skew ratio", value: 1.25 },
        { label: "Active flag", value: true },
      ],
      sections: [
        {
          body: ["Public line stays.", 42, false],
          bullets: ["Public bullet stays."],
          id: "tenor-and-budget",
          title: "Tenor and budget",
        },
        {
          id: "empty-public",
          title: "Empty public section",
        },
      ],
      sources: [
        {
          id: "pub-1",
          title: "Public options chain",
          url: "https://example.test/chain",
        },
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
              multiplier: 100,
              premium: 2.1,
              side: "sell",
              strike: 110,
              type: "put",
            },
            {
              multiplier: null,
            },
            null,
            {},
            null,
            null,
          ],
          multiplier: 100,
        },
        {
          kind: "bull-call-spread",
          legs: [],
          multiplier: null,
        },
        {
          kind: "put-credit-spread",
          legs: [],
        },
        {
          expiry: "2027-06-18",
          kind: "cash-secured-put",
        },
        {},
        {
          hypothetical: true,
          kind: "stock",
          stockEntry: 95,
          stockShares: 100,
        },
        {
          hypothetical: true,
          kind: "stock",
          stockShares: 50,
        },
        {
          hypothetical: true,
          kind: "stock",
        },
        {
          hypothetical: false,
          kind: "stock",
        },
        {
          kind: "stock",
        },
        {
          kind: "long-call",
          legs: null,
        },
        {
          kind: "long-call",
          legs: null,
        },
        null,
        null,
        null,
      ],
      warnings: ["Public volatility caveat.", 42, true],
    });
  });

  it("drops private or non-string asOf, currency, title, summary and non-array containers", () => {
    const sentinel = "SENTINEL_TOP_LEVEL";
    expect(
      sanitizeResearchDatasetData("options-analysis", {
        asOf: `IBKR snapshot ${sentinel}`,
        currency: `${sentinel}-USD`,
        metrics: { broker: sentinel },
        sections: { account: sentinel },
        sources: { nlv: sentinel },
        strategies: { order: sentinel },
        summary: { nested: sentinel },
        title: [sentinel],
        warnings: { text: sentinel },
      })
    ).toEqual({
      metrics: null,
      sections: null,
      sources: null,
      strategies: null,
      warnings: null,
    });

    expect(
      sanitizeResearchDatasetData("options-analysis", {
        asOf: "2026-11-23",
        currency: "EUR",
        summary: "Public summary of expiry payoffs.",
        title: "Public options analysis",
      })
    ).toEqual({
      asOf: "2026-11-23",
      currency: "EUR",
      summary: "Public summary of expiry payoffs.",
      title: "Public options analysis",
    });

    expect(sanitizeResearchDatasetData("options-analysis", {})).toEqual({});
  });
});
