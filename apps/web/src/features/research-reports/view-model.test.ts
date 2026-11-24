import type {
  ResearchReportDatasetOutput,
  ResearchReportSummary,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  countCatalogReports,
  DATASET_LABELS,
  DATASET_TABS,
  filterCatalogGroups,
  reportHref,
  toCatalogSummary,
  toCatalogViewModel,
  toDatasetViewModel,
} from "./view-model.ts";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const hex = (digit: string) => digit.repeat(64);

const summary = (
  overrides: Partial<ResearchReportSummary> = {}
): ResearchReportSummary => {
  const sourceUpdatedAt =
    "sourceUpdatedAt" in overrides
      ? (overrides.sourceUpdatedAt ?? null)
      : new Date("2026-09-10T15:52:25.000Z");
  const dataDate =
    "dataDate" in overrides
      ? (overrides.dataDate ?? null)
      : sourceUpdatedAt === null
        ? null
        : sourceUpdatedAt.toISOString().slice(0, 10);
  return {
    assetType: "equity",
    companyResearch: {
      acceptedAt: NOW,
      reportRevision: hex("a"),
      revision: hex("e"),
    },
    currency: "USD",
    dataDate,
    dataRevision: hex("a"),
    dataSource: "revision",
    exchange: "Fixture Exchange",
    freshness: {
      asOf: dataDate,
      expectedSession: "2026-11-02",
      isStale: dataDate !== null && dataDate < "2026-10-01",
      maxSessionsBehind: 2,
      sessionsBehind:
        dataDate === null ? null : dataDate < "2026-10-01" ? 30 : 0,
      status:
        dataDate === null
          ? "no_date"
          : dataDate < "2026-10-01"
            ? "stale"
            : "fresh",
    },
    id: "AAA",
    identityStatus: "verified",
    importedAt: NOW,
    name: "Fixture A",
    providerSymbol: "AAA",
    sourceUpdatedAt,
    status: "ready",
    symbol: "AAA",
    ...overrides,
  };
};

const datasetOutput = (data: unknown): ResearchReportDatasetOutput => ({
  byteLength: 10,
  data,
  dataRevision: hex("b"),
  dataset: "fundamentals",
  reportId: "AAA",
  revisions: [hex("a"), hex("b")],
  sha256: hex("c"),
});

describe("research dossier catalog view-model", () => {
  it("groups reports by category in catalog order and collects the rest", () => {
    const groups = toCatalogViewModel({
      categories: [
        {
          description: "First",
          id: "one",
          label: "One",
          reportIds: ["BBB", "GONE", "AAA"],
        },
        { description: "Empty", id: "empty", label: "Empty", reportIds: [] },
      ],
      reports: [
        summary(),
        summary({
          assetType: null,
          companyResearch: null,
          id: "BBB",
          sourceUpdatedAt: null,
          symbol: "BBB",
        }),
        summary({ id: "CCC", symbol: "CCC" }),
      ],
    });
    expect(groups.map((group) => group.id)).toEqual(["one", "other"]);
    expect(groups[0]?.reports.map((report) => report.id)).toEqual([
      "BBB",
      "AAA",
    ]);
    expect(groups[0]?.reports[0]).toEqual({
      assetType: "Not classified",
      href: "/research/reports/BBB",
      id: "BBB",
      isStale: false,
      name: "Fixture A",
      research: false,
      status: "ready",
      symbol: "BBB",
      updated: "No date recorded",
    });
    expect(groups[0]?.reports[1]).toMatchObject({
      assetType: "equity",
      isStale: true,
      research: true,
      updated: "2026-09-10",
    });
    expect(groups[1]?.reports.map((report) => report.id)).toEqual(["CCC"]);
  });

  it("has no other group when every report is in a category", () => {
    expect(
      toCatalogViewModel({
        categories: [
          { description: "", id: "all", label: "All", reportIds: ["AAA"] },
        ],
        reports: [summary()],
      }).map((group) => group.id)
    ).toEqual(["all"]);
    expect(reportHref("A B")).toBe("/research/reports/A%20B");
  });

  it("labels every public dataset once", () => {
    expect(DATASET_TABS.map((tab) => tab.id)).toEqual(
      Object.keys(DATASET_LABELS)
    );
    expect(DATASET_LABELS["options-analysis"]).toBe("Options analysis");
  });

  it("sums the catalog for the KPI row: reports, groups, research, newest update", () => {
    const output = {
      categories: [
        { description: "", id: "one", label: "One", reportIds: ["AAA"] },
      ],
      reports: [
        summary({ sourceUpdatedAt: new Date("2026-08-01T00:00:00.000Z") }),
        summary({
          companyResearch: null,
          id: "BBB",
          sourceUpdatedAt: null,
          symbol: "BBB",
        }),
        summary({
          id: "CCC",
          sourceUpdatedAt: new Date("2026-10-02T09:00:00.000Z"),
          symbol: "CCC",
        }),
        summary({
          id: "DDD",
          sourceUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
          symbol: "DDD",
        }),
      ],
    };
    expect(toCatalogSummary(output, toCatalogViewModel(output))).toEqual({
      dossiers: 4,
      groups: 2,
      lastUpdated: "2026-10-02",
      research: 3,
      stale: 2,
    });
    expect(toCatalogSummary({ categories: [], reports: [] }, [])).toEqual({
      dossiers: 0,
      groups: 0,
      lastUpdated: "No date recorded",
      research: 0,
      stale: 0,
    });
  });

  it("filters by symbol or name, drops empty groups and counts each report once", () => {
    const groups = toCatalogViewModel({
      categories: [
        { description: "", id: "one", label: "One", reportIds: ["AAA", "BBB"] },
        { description: "", id: "two", label: "Two", reportIds: ["AAA"] },
      ],
      reports: [
        summary(),
        summary({ id: "BBB", name: "Beta Holdings", symbol: "BBB" }),
      ],
    });
    expect(filterCatalogGroups(groups, "  ")).toBe(groups);
    expect(countCatalogReports(groups)).toBe(2);
    const bySymbol = filterCatalogGroups(groups, "aaa");
    expect(bySymbol.map((group) => group.id)).toEqual(["one", "two"]);
    expect(countCatalogReports(bySymbol)).toBe(1);
    const byName = filterCatalogGroups(groups, " beta ");
    expect(byName.map((group) => group.id)).toEqual(["one"]);
    expect(byName[0]?.reports.map((report) => report.id)).toEqual(["BBB"]);
    expect(filterCatalogGroups(groups, "zzz")).toEqual([]);
  });
});

describe("research dossier dataset view-model", () => {
  it("reads summary, metrics, sections, sources, news and warnings", () => {
    const view = toDatasetViewModel(
      datasetOutput({
        asOf: "2026-09-10",
        items: [
          {
            date: "2026-09-10",
            source: "Fixture wire",
            summary: "A fixture item.",
            title: "Fixture headline",
            url: "https://example.test/news",
          },
          { title: "Unlinked", url: "javascript:alert(1)" },
          { url: "https://example.test/no-title" },
          "not an object",
        ],
        metrics: [
          { label: "Revenue", period: "FY2026", value: "1,000 USD" },
          { label: "Score", value: 7 },
          { label: "No value" },
          { value: "no label" },
        ],
        sections: [
          {
            body: ["line one", 2, null],
            bullets: [true],
            id: "first",
            title: "First section",
          },
          { body: "not a list", title: "Second" },
          { body: ["untitled"] },
        ],
        sources: [
          { id: "s1", title: "Source one", url: "https://example.test/s1" },
          { title: "Source two", url: "ftp://example.test" },
          { id: "s3" },
        ],
        summary: "Fixture summary.",
        title: "Fixture title",
        warnings: ["Check the data", 3, { nested: true }],
      })
    );
    expect(view).toEqual({
      asOf: "2026-09-10",
      metrics: [
        { label: "Revenue", period: "FY2026", value: "1,000 USD" },
        { label: "Score", period: null, value: "7" },
      ],
      newsItems: [
        {
          date: "2026-09-10",
          href: "https://example.test/news",
          source: "Fixture wire",
          summary: "A fixture item.",
          title: "Fixture headline",
        },
        {
          date: null,
          href: null,
          source: null,
          summary: null,
          title: "Unlinked",
        },
      ],
      revision: "bbbbbbbbbbbb",
      revisionCount: 2,
      sections: [
        {
          id: "first",
          lines: ["line one", "2", "true"],
          title: "First section",
        },
        { id: "section-1", lines: [], title: "Second" },
      ],
      sources: [
        { href: "https://example.test/s1", id: "s1", title: "Source one" },
        { href: null, id: "source-1", title: "Source two" },
      ],
      summary: "Fixture summary.",
      title: "Fixture title",
      warnings: ["Check the data", "3"],
    });
  });

  it("shows a market quote price as a metric", () => {
    expect(
      toDatasetViewModel(
        datasetOutput({
          quote: { asOf: "2026-09-10T20:00:00.000Z", price: 218.36 },
        })
      ).metrics
    ).toEqual([
      {
        label: "Quote price",
        period: "2026-09-10T20:00:00.000Z",
        value: "218.36",
      },
    ]);
    expect(
      toDatasetViewModel(datasetOutput({ quote: { price: "n/a" } })).metrics
    ).toEqual([]);
  });

  it("never shows the private entry section regardless of case or whitespace", () => {
    const view = toDatasetViewModel(
      datasetOutput({
        sections: [
          {
            body: ["Verify whether the fixture share order is pending."],
            id: "entry",
            title: "Entry conditions",
          },
          {
            body: ["Capitalized entry block."],
            id: " Entry ",
            title: "Capitalized Entry",
          },
          { body: ["Support near a level."], id: "levels", title: "Levels" },
        ],
      })
    );
    expect(view.sections.map((section) => section.id)).toEqual(["levels"]);
  });

  it("blocks private broker, portfolio, NLV and user-order text across all options-analysis fields", () => {
    const sentinel = "SENTINEL_APP_PRIVACY_774";
    const view = toDatasetViewModel({
      ...datasetOutput({
        asOf: `IBKR snapshot ${sentinel}`,
        items: [
          {
            date: "2026-11-22",
            source: "Exchange",
            summary: "Public volatility news.",
            title: "Public options volume update",
            url: "https://example.test/news/public",
          },
          {
            date: "2026-11-22",
            source: "Exchange",
            summary: "Public text",
            title: `IBKR ${sentinel} title`,
            url: "https://example.test/news/1",
          },
          {
            date: `NLV ${sentinel}`,
            source: "Exchange",
            summary: "Public text",
            title: "Public title 2",
            url: "https://example.test/news/2",
          },
          {
            date: "2026-11-22",
            source: "Exchange",
            summary: "Public text",
            title: "Public title 3",
            url: `ibkr://account/${sentinel}`,
          },
          {
            date: "2026-11-22",
            source: `brokerRefresh ${sentinel}`,
            summary: "Public text",
            title: "Public title 4",
            url: "https://example.test/news/4",
          },
          {
            date: "2026-11-22",
            source: "Exchange",
            summary: `Placed order ${sentinel}`,
            title: "Public title 5",
            url: "https://example.test/news/5",
          },
        ],
        metrics: [
          { label: "30d IV", period: "2026-11-22", value: "48%" },
          { label: "Broker NLV", period: "live", value: `${sentinel}-label` },
          { label: "Cap", period: "30d", value: `2% NLV ${sentinel}` },
          { label: "Exposure", period: "Account", value: `${sentinel}-period` },
        ],
        quote: {
          asOf: `IBKR ${sentinel} quote`,
          price: 199.99,
        },
        sections: [
          {
            body: [
              "Public payoff note stays.",
              `IBKR ${sentinel} broker refresh line drops.`,
            ],
            bullets: [
              "Public bullet stays.",
              `Limit order ${sentinel} already filled drops.`,
            ],
            id: "tenor-and-budget",
            title: "Tenor and budget",
          },
          {
            body: [`Net liquidation ${sentinel} only.`],
            id: "private-only",
            title: "Sizing",
          },
          {
            body: [`Public line under camelCase id ${sentinel}.`],
            id: "ibkrSnapshot",
            title: "Public heading",
          },
          {
            body: ["Public line under private heading."],
            id: "public-id",
            title: `Portfolio ${sentinel}`,
          },
        ],
        sources: [
          {
            id: "pub-chain",
            title: "Public options chain",
            url: "https://example.test/chain",
          },
          {
            id: "public-id-1",
            title: `IBKR ${sentinel}`,
            url: "https://example.test/private-title",
          },
          {
            id: "brokerRefresh",
            title: `Public title ${sentinel}`,
            url: "https://example.test/private-id",
          },
          {
            id: "public-id-3",
            title: `Public title ${sentinel}`,
            url: "https://example.test/nlv-feed",
          },
          {
            id: "public-id-4",
            title: `Public title ${sentinel}`,
            url: `ibkr://account/${sentinel}`,
          },
        ],
        summary: `Keep under 2% NLV for ${sentinel} pending order.`,
        title: `Options analysis (${sentinel} account view)`,
        warnings: [
          "Public volatility warning.",
          `User-order ${sentinel} warning.`,
        ],
      }),
      dataset: "options-analysis",
      reportId: "APP",
    });

    expect(JSON.stringify(view)).not.toContain(sentinel);
    expect(view.asOf).toBeNull();
    expect(view.title).toBeNull();
    expect(view.summary).toBeNull();
    expect(view.metrics).toEqual([
      { label: "30d IV", period: "2026-11-22", value: "48%" },
    ]);
    expect(view.newsItems).toEqual([
      {
        date: "2026-11-22",
        href: "https://example.test/news/public",
        source: "Exchange",
        summary: "Public volatility news.",
        title: "Public options volume update",
      },
    ]);
    expect(view.sections).toEqual([
      {
        id: "tenor-and-budget",
        lines: ["Public payoff note stays.", "Public bullet stays."],
        title: "Tenor and budget",
      },
    ]);
    expect(view.sources).toEqual([
      {
        href: "https://example.test/chain",
        id: "pub-chain",
        title: "Public options chain",
      },
    ]);
    expect(view.warnings).toEqual(["Public volatility warning."]);
  });

  it("keeps public asOf on options-analysis and leaves non-options-analysis text unfiltered", () => {
    const publicOptions = toDatasetViewModel({
      ...datasetOutput({
        asOf: "2026-11-23",
        quote: { asOf: "2026-11-23", price: 150 },
        summary: "Public payoff summary",
        title: "Public options view",
      }),
      dataset: "options-analysis",
    });
    expect(publicOptions.asOf).toBe("2026-11-23");
    expect(publicOptions.title).toBe("Public options view");
    expect(publicOptions.summary).toBe("Public payoff summary");
    expect(publicOptions.metrics).toEqual([
      { label: "Quote price", period: "2026-11-23", value: "150" },
    ]);

    const technicals = toDatasetViewModel({
      ...datasetOutput({
        asOf: "IBKR snapshot",
        summary: "Account NLV reference",
        title: "Broker technicals",
        warnings: ["Pending order note"],
      }),
      dataset: "technicals",
    });
    expect(technicals.asOf).toBe("IBKR snapshot");
    expect(technicals.title).toBe("Broker technicals");
    expect(technicals.summary).toBe("Account NLV reference");
    expect(technicals.warnings).toEqual(["Pending order note"]);
  });

  it("returns an empty view for data that is not an object", () => {
    for (const data of [
      null,
      ["array"],
      "text",
      { metrics: "x", sections: {}, summary: " " },
    ]) {
      expect(toDatasetViewModel(datasetOutput(data))).toMatchObject({
        asOf: null,
        metrics: [],
        newsItems: [],
        sections: [],
        sources: [],
        summary: null,
        title: null,
        warnings: [],
      });
    }
  });
});
