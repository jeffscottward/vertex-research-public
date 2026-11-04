import type {
  ResearchReportDatasetOutput,
  ResearchReportSummary,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  DATASET_LABELS,
  DATASET_TABS,
  reportHref,
  toCatalogViewModel,
  toDatasetViewModel,
} from "./view-model.ts";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const hex = (digit: string) => digit.repeat(64);

const summary = (
  overrides: Partial<ResearchReportSummary> = {}
): ResearchReportSummary => ({
  assetType: "equity",
  companyResearch: {
    acceptedAt: NOW,
    reportRevision: hex("a"),
    revision: hex("e"),
  },
  currency: "USD",
  dataRevision: hex("a"),
  exchange: "Fixture Exchange",
  id: "AAA",
  identityStatus: "verified",
  importedAt: NOW,
  name: "Fixture A",
  providerSymbol: "AAA",
  sourceUpdatedAt: new Date("2026-09-10T15:52:25.000Z"),
  status: "ready",
  symbol: "AAA",
  ...overrides,
});

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
      assetType: "—",
      href: "/research/reports/BBB",
      id: "BBB",
      name: "Fixture A",
      research: false,
      status: "ready",
      symbol: "BBB",
      updated: "—",
    });
    expect(groups[0]?.reports[1]).toMatchObject({
      assetType: "equity",
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
