import { describe, expect, it } from "vitest";

import { ENGINE_COMPARISON_SUPERSEDED_ERROR } from "../../packages/api/src/contracts/engine-comparison.ts";
import { buildModel, type ReportModel } from "./model.ts";
import { escapeHtml, formatMs, renderReport, timelineSvg } from "./render.ts";
import { RIG_BENCHMARK_2026_11_06 } from "./rig-benchmark-2026-11-06.ts";
import { comparisonRow, nautilusRun } from "./test-fixtures.ts";

const DAY_MS = 86_400_000;

const busyModel = (): ReportModel =>
  buildModel({
    benchmark: RIG_BENCHMARK_2026_11_06,
    comparisons: {
      academy: [
        comparisonRow(
          {
            differences: {
              items: [
                {
                  detail: "trades 3 vs <4>",
                  field: "trades",
                  nautilus: 4,
                  typescript: 3,
                },
              ],
              ok: false,
            },
          },
          { feature: "academy", label: "SPY <iron condor>" }
        ),
        comparisonRow(
          { engineRun: null, error: "engine <crashed>", status: "failed" },
          { feature: "academy" }
        ),
        comparisonRow(
          {
            engineRun: null,
            error: ENGINE_COMPARISON_SUPERSEDED_ERROR,
            status: "failed",
          },
          { feature: "academy" }
        ),
        comparisonRow({ differences: null }, { feature: "academy" }),
      ],
      sweep: [
        comparisonRow(
          {},
          {
            typescript: {
              ...comparisonRow().comparison.typescript,
              wallMs: null,
            },
          }
        ),
      ],
    },
    generatedAt: new Date("2026-11-10T20:00:00.000Z"),
    journal: {
      entries: [
        {
          at: Date.parse("2026-11-10T19:00:00Z"),
          message: "Stopped Vertex Nautilus backtest worker.",
        },
      ],
      read: true,
    },
    limit: 1,
    nautilusListFull: true,
    nautilusRuns: [
      nautilusRun(),
      nautilusRun({
        engineRun: null,
        error: "no bars",
        id: "nautilus-2",
        startedAt: null,
        status: "failed",
      }),
    ],
  });

describe("formatMs and escapeHtml", () => {
  it("picks a unit by size", () => {
    expect([null, 0.3, 39, 1250, 42_000].map(formatMs)).toEqual([
      "-",
      "0.30 ms",
      "39.0 ms",
      "1.25 s",
      "42.0 s",
    ]);
  });

  it("escapes markup", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });
});

describe("renderReport", () => {
  it("marks the 15 h worker outage and the step-4 shortfall", () => {
    const html = renderReport(busyModel(), {
      snapshotHref: "snapshot-2026-11-06/",
    });
    expect(html).toContain("worker outage 15.3 h");
    expect(html).toContain("2026-11-07 21:08Z");
    expect(html).toContain("2026-11-08 12:24Z");
    expect(html).toContain("still going on");
    expect(html).toContain("10 day(s) left");
    expect(html).toContain(
      "Not met yet: the dual run has been live 4 of 14 days."
    );
    expect(html).toContain('<span class="warn">');
    expect(html).toContain("older Nautilus runs are not shown");
    expect(html).toContain("done, differences not readable");
    expect(html).toContain("list limit reached");
    expect(html).toContain("1 timer frozen");
    expect(html).toContain("SPY &lt;iron condor&gt;");
    expect(html).toContain("trades 3 vs &lt;4&gt;");
    expect(html).toContain("engine &lt;crashed&gt;");
    expect(html).toContain("failed: no bars");
    expect(html).toContain("Asset-Class Trend &lt;10-month SMA&gt;");
    expect(html).toContain('href="snapshot-2026-11-06/"');
    expect(html).toContain("worker journal from 2026-11-10 19:00Z (1 lines)");
    expect(html).not.toContain("<iron");
  });

  it("renders a quiet period with no data", () => {
    const daily = Array.from({ length: 14 }, (_, index) =>
      comparisonRow({
        createdAt: new Date(
          Date.parse("2026-11-06T12:00:00Z") + index * DAY_MS
        ).toISOString(),
      })
    );
    const empty = buildModel({
      benchmark: { ...RIG_BENCHMARK_2026_11_06, knownOutages: [] },
      comparisons: { autopilotGate: daily, instant: daily, sweep: daily },
      generatedAt: new Date("2026-11-21T00:00:00.000Z"),
      journal: { entries: [], read: false },
      limit: 500,
      nautilusListFull: false,
      nautilusRuns: [],
    });
    const html = renderReport(empty);
    expect(html).toContain("(2026-11-20, passed 1 day(s) ago)");
    expect(html).toContain("<span>Met. The dual run has been live 15 days.");
    expect(html).not.toContain("older Nautilus runs are not shown");
    expect(html).toContain("<p>None found.</p>");
    expect(html).toContain("<p>None.</p>");
    expect(html).toContain("worker journal not read");
    expect(html).not.toContain("Original page");
    const readEmpty = buildModel({
      benchmark: RIG_BENCHMARK_2026_11_06,
      comparisons: {},
      generatedAt: new Date("2026-11-10T20:00:00.000Z"),
      journal: { entries: [], read: true },
      limit: 500,
      nautilusListFull: false,
      nautilusRuns: [],
    });
    expect(
      renderReport({ ...readEmpty, generatedAt: "2026-11-20T08:00:00.000Z" })
    ).toContain("(2026-11-20, today)");
    expect(renderReport(readEmpty)).toContain(
      "worker journal from - (0 lines)"
    );
  });

  it("draws differences and failures over superseded runs", () => {
    const svg = timelineSvg(busyModel());
    const superseded = svg.indexOf('fill="#6b7280"');
    expect(superseded).toBeGreaterThan(0);
    expect(svg.indexOf('fill="#e8a33d"')).toBeGreaterThan(superseded);
    expect(svg.indexOf('fill="#e05252" fill-opacity="0.75"')).toBeGreaterThan(
      superseded
    );
  });

  it("thins the day labels of a long window", () => {
    const model = { ...busyModel(), windowFrom: "2026-09-01T00:00:00.000Z" };
    const labels =
      timelineSvg(model).match(/font-size="11" text-anchor="middle"/g) ?? [];
    expect(labels.length).toBeLessThan(30);
  });
});
