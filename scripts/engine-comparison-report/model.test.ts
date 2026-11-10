import { describe, expect, it } from "vitest";

import { ENGINE_COMPARISON_SUPERSEDED_ERROR } from "../../packages/api/src/contracts/engine-comparison.ts";
import {
  buildModel,
  findOutages,
  IsoDateSchema,
  mergeOutages,
  nearestRank,
  statsOf,
  summarizeFeature,
} from "./model.ts";
import { RIG_BENCHMARK_2026_11_06 } from "./rig-benchmark-2026-11-06.ts";
import { comparisonRow, nautilusRun } from "./test-fixtures.ts";

const at = (iso: string): number => Date.parse(iso);
const MINUTE = 60_000;

describe("nearestRank and statsOf", () => {
  it("uses the nearest rank over the sorted values", () => {
    const values = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect(nearestRank(values, 0.5)).toBe(10);
    expect(nearestRank(values, 0.95)).toBe(19);
    expect(nearestRank([7], 0)).toBe(7);
    expect(nearestRank([], 0.5)).toBeUndefined();
  });

  it("drops values that are not finite", () => {
    expect(statsOf([3, Number.NaN, 1, 2])).toEqual({
      max: 3,
      n: 3,
      p50: 2,
      p95: 3,
    });
    expect(statsOf([Number.POSITIVE_INFINITY])).toBeNull();
  });
});

describe("findOutages", () => {
  const now = at("2026-11-10T20:00:00Z");

  it("finds the 2026-11-07 name lookup outage that ended with a service restart", () => {
    const entries = [
      {
        at: at("2026-11-07T20:00:00Z"),
        message: "nautilus worker: 550 requests sent; quiet for 65 s",
      },
      ...Array.from({ length: 305 }, (_, index) => ({
        at: at("2026-11-07T21:08:54Z") + index * 3 * MINUTE,
        message:
          "nautilus worker: getaddrinfo ENOTFOUND quantvps-vertex.tail.ts.net",
      })),
      {
        at: at("2026-11-08T12:23:45Z"),
        message:
          "nautilus worker: getaddrinfo ENOTFOUND quantvps-vertex.tail.ts.net",
      },
      { at: at("2026-11-08T12:23:46Z"), message: "alert posted to omp-alerts" },
      {
        at: at("2026-11-08T12:23:49Z"),
        message: "Stopping Vertex Nautilus backtest worker (research only)...",
      },
      {
        at: at("2026-11-08T12:23:49Z"),
        message: "Stopped Vertex Nautilus backtest worker (research only).",
      },
      {
        at: at("2026-11-08T12:24:54Z"),
        message: "Started Vertex Nautilus backtest worker (research only).",
      },
    ];
    expect(findOutages(entries, { now })).toEqual([
      {
        from: at("2026-11-07T21:08:54Z"),
        reason:
          "worker could not resolve the API host name (getaddrinfo ENOTFOUND) until the service restart",
        to: at("2026-11-08T12:24:54Z"),
      },
    ]);
  });

  it("closes an error cluster at its last error after a quiet gap and drops short ones", () => {
    const entries = [
      {
        at: at("2026-11-07T09:00:00Z"),
        message: "backtestRuns/engine/claim returned HTTP 503: busy",
      },
      {
        at: at("2026-11-07T09:04:00Z"),
        message: "backtestRuns/engine/claim returned HTTP 502: busy",
      },
      {
        at: at("2026-11-07T09:08:00Z"),
        message: "backtestRuns/engine/claim returned HTTP 503: busy",
      },
      {
        at: at("2026-11-07T09:12:00Z"),
        message: "backtestRuns/engine/claim returned HTTP 503: busy",
      },
      {
        at: at("2026-11-07T10:00:00Z"),
        message: "nautilus worker: The operation timed out.",
      },
      {
        at: at("2026-11-07T11:00:00Z"),
        message: "batch: 2 runs in 1 engine processes",
      },
    ];
    expect(findOutages(entries, { now })).toEqual([
      {
        from: at("2026-11-07T09:00:00Z"),
        reason: "API answered with server errors (HTTP 5xx)",
        to: at("2026-11-07T09:12:00Z"),
      },
    ]);
    expect(findOutages(entries, { minMs: 0, now })).toHaveLength(2);
  });

  it("reports stopped services and outages still going on", () => {
    const stopped = [
      {
        at: at("2026-11-05T23:43:00Z"),
        message: "Stopped Vertex Nautilus backtest worker (research only).",
      },
      {
        at: at("2026-11-05T23:43:00Z"),
        message: "vertex-nautilus-worker.service: Consumed 1.2s CPU time",
      },
      {
        at: at("2026-11-06T01:08:00Z"),
        message: "Started Vertex Nautilus backtest worker (research only).",
      },
      {
        at: at("2026-11-06T01:09:00Z"),
        message: "Started Vertex Nautilus backtest worker (research only).",
      },
      {
        at: at("2026-11-10T19:00:00Z"),
        message: "Stopped Vertex Nautilus backtest worker (research only).",
      },
    ];
    expect(findOutages(stopped, { now })).toEqual([
      {
        from: at("2026-11-05T23:43:00Z"),
        reason: "worker service stopped",
        to: at("2026-11-06T01:08:00Z"),
      },
      {
        from: at("2026-11-10T19:00:00Z"),
        reason: "worker service stopped",
        to: null,
      },
    ]);
    const failing = Array.from({ length: 15 }, (_, index) => ({
      at: at("2026-11-10T19:00:00Z") + index * 4 * MINUTE,
      message: "connect ECONNREFUSED 100.64.0.1:3451",
    }));
    expect(findOutages(failing, { now })).toEqual([
      {
        from: at("2026-11-10T19:00:00Z"),
        reason: "worker could not reach the API",
        to: null,
      },
    ]);
    expect(
      findOutages(failing, { now: at("2026-11-10T21:00:00Z") })[0]?.to
    ).toBe(at("2026-11-10T19:56:00Z"));
  });
});

describe("findOutages edge cases", () => {
  const now = at("2026-11-10T20:00:00Z");
  const error = (iso: string) => ({
    at: at(iso),
    message: "getaddrinfo EAI_AGAIN host",
  });

  it("keeps one outage when errors come back after a restart", () => {
    expect(
      findOutages(
        [
          error("2026-11-09T10:00:00Z"),
          error("2026-11-09T10:08:00Z"),
          {
            at: at("2026-11-09T10:09:00Z"),
            message: "Started Vertex Nautilus backtest worker.",
          },
          error("2026-11-09T10:15:00Z"),
          error("2026-11-09T10:20:00Z"),
          {
            at: at("2026-11-09T11:00:00Z"),
            message: "batch: 1 runs in 1 engine processes",
          },
        ],
        { now }
      )
    ).toEqual([
      {
        from: at("2026-11-09T10:00:00Z"),
        reason:
          "worker could not resolve the API host name (getaddrinfo EAI_AGAIN)",
        to: at("2026-11-09T10:20:00Z"),
      },
    ]);
  });

  it("counts an outage of exactly the minimum length", () => {
    expect(
      findOutages(
        [error("2026-11-09T10:00:00Z"), error("2026-11-09T10:10:00Z")],
        { now }
      )
    ).toHaveLength(1);
    expect(
      findOutages(
        [error("2026-11-09T10:00:00Z"), error("2026-11-09T10:09:59Z")],
        { now }
      )
    ).toHaveLength(0);
  });
});

describe("IsoDateSchema", () => {
  it("normalizes offsets to UTC and refuses other text", () => {
    expect(IsoDateSchema.parse("2026-11-07T16:08:54-05:00")).toBe(
      "2026-11-07T21:08:54.000Z"
    );
    expect(IsoDateSchema.safeParse("Nov 7 2026 (<b>)").success).toBe(false);
  });
});

describe("mergeOutages", () => {
  it("merges overlapping windows and keeps the earliest reason", () => {
    expect(
      mergeOutages(
        [{ from: 10, reason: "recorded", to: 20 }],
        [
          { from: 10, reason: "journal", to: 25 },
          { from: 22, reason: "later", to: 24 },
          { from: 30, reason: "open", to: null },
          { from: 31, reason: "inside open", to: 40 },
          { from: 50, reason: "after open", to: null },
        ]
      )
    ).toEqual([
      { from: 10, reason: "recorded", to: 25 },
      { from: 30, reason: "open", to: null },
    ]);
    expect(
      mergeOutages(
        [{ from: 1, reason: "a", to: 5 }],
        [{ from: 2, reason: "b", to: null }]
      )
    ).toEqual([{ from: 1, reason: "a", to: null }]);
    expect(
      mergeOutages(
        [{ from: 1, reason: "a", to: 5 }],
        [{ from: 5, reason: "b", to: 9 }]
      )
    ).toEqual([{ from: 1, reason: "a", to: 9 }]);
  });
});

describe("summarizeFeature", () => {
  it("counts statuses, differences, failures and timings", () => {
    const rows = [
      comparisonRow(),
      comparisonRow(
        {
          createdAt: "2026-11-07T10:00:00.000Z",
          differences: {
            items: [
              {
                detail: "Sharpe 0.5 vs 0.6",
                field: "sharpe",
                nautilus: 0.6,
                typescript: 0.5,
              },
            ],
            ok: false,
          },
          engineRun: {
            cpuMs: null,
            gpu: "not used",
            host: "rig-2",
            processCases: 2,
            processes: 2,
            processWallMs: null,
            wallMs: null,
          },
          id: "run-2",
        },
        {
          groupId: "group-2",
          typescript: {
            ...comparisonRow().comparison.typescript,
            wallMs: null,
          },
        }
      ),
      comparisonRow({
        engineRun: null,
        error: ENGINE_COMPARISON_SUPERSEDED_ERROR,
        id: "run-3",
        queueWaitMs: 5,
        status: "failed",
      }),
      comparisonRow({
        differences: null,
        engineRun: null,
        error: null,
        id: "run-4",
        status: "failed",
      }),
      comparisonRow({
        differences: null,
        engineRun: null,
        error: "engine crashed",
        id: "run-5",
        status: "failed",
      }),
      comparisonRow({
        differences: null,
        engineRun: null,
        error: "engine crashed",
        id: "run-6",
        status: "failed",
      }),
      comparisonRow({
        differences: null,
        engineRun: null,
        id: "run-7",
        queueWaitMs: null,
        startedAt: null,
        status: "queued",
      }),
    ];
    const summary = summarizeFeature("sweep", rows, 7);
    expect(summary).toMatchObject({
      days: 2,
      differenceItems: [
        {
          detail: "Sharpe 0.5 vs 0.6",
          field: "sharpe",
          label: "SPY SMA 10/40",
        },
      ],
      differing: 1,
      failures: [
        { count: 2, error: "engine crashed" },
        { count: 1, error: "failed without an error text" },
      ],
      matched: 2,
      nautilusHosts: ["omarchy-rig", "rig-2"],
      requests: 2,
      runs: 7,
      span: {
        first: "2026-11-06T03:27:53.699Z",
        last: "2026-11-07T10:00:00.000Z",
      },
      status: { failed: 4, queued: 1, running: 0, succeeded: 2 },
      step: 4,
      superseded: 1,
      title: "Parameter sweep",
      truncated: true,
      tsFrozen: 1,
    });
    expect(summary.engineWall).toEqual({ max: 270, n: 1, p50: 270, p95: 270 });
    expect(summary.queueWait).toEqual({
      max: 42_000,
      n: 2,
      p50: 42_000,
      p95: 42_000,
    });
    expect(summary.tsWall?.n).toBe(6);
  });

  it("keeps an empty feature empty", () => {
    expect(summarizeFeature("instant", [], 500)).toMatchObject({
      cpu: null,
      engineWall: null,
      runs: 0,
      span: null,
      truncated: false,
    });
  });
});

describe("buildModel", () => {
  it("joins the stored runs, the journal and the recorded outages", () => {
    const model = buildModel({
      benchmark: RIG_BENCHMARK_2026_11_06,
      comparisons: {
        academy: [
          comparisonRow(
            { createdAt: "2026-11-10T17:34:36.399Z", status: "running" },
            { feature: "academy" }
          ),
          comparisonRow(
            { error: ENGINE_COMPARISON_SUPERSEDED_ERROR, status: "failed" },
            { feature: "academy" }
          ),
          comparisonRow(
            { error: "boom", status: "failed" },
            { feature: "academy" }
          ),
          comparisonRow(
            { differences: { items: [], ok: false } },
            { feature: "academy" }
          ),
        ],
        sweep: [
          comparisonRow(),
          comparisonRow({
            createdAt: "2026-11-05T22:00:00.000Z",
            differences: null,
          }),
        ],
      },
      generatedAt: new Date("2026-11-10T20:00:00.000Z"),
      journal: {
        entries: [
          {
            at: at("2026-11-08T12:23:45Z"),
            message: "getaddrinfo ENOTFOUND host",
          },
          {
            at: at("2026-11-08T12:24:54Z"),
            message: "Started Vertex Nautilus backtest worker.",
          },
          {
            at: at("2026-11-10T17:00:00Z"),
            message: "Stopped Vertex Nautilus backtest worker.",
          },
        ],
        read: true,
      },
      limit: 500,
      nautilusListFull: false,
      nautilusRuns: [
        nautilusRun({ createdAt: "2026-11-08T01:00:00.000Z", startedAt: null }),
        nautilusRun(),
      ],
    });
    expect(model.windowFrom).toBe("2026-11-05T00:00:00.000Z");
    expect(model.journal).toEqual({
      entries: 3,
      firstAt: "2026-11-08T12:23:45.000Z",
      read: true,
    });
    expect(model.outages[0]?.hours).toBeCloseTo(15 + 16 / 60, 6);
    expect(
      model.outages.map((outage) => ({
        ...outage,
        hours: Math.round(outage.hours * 10) / 10,
      }))
    ).toEqual([
      {
        from: "2026-11-07T21:08:54.000Z",
        hours: 15.3,
        reason: RIG_BENCHMARK_2026_11_06.knownOutages[0]?.reason,
        runsCreated: 1,
        to: "2026-11-08T12:24:54.000Z",
      },
      {
        from: "2026-11-10T17:00:00.000Z",
        hours: 3,
        reason: "worker service stopped",
        runsCreated: 1,
        to: null,
      },
    ]);
    expect(model.nautilusRuns.map((run) => run.queueWaitMs)).toEqual([
      3000,
      null,
    ]);
    expect(model.timeline.map((point) => point.kind)).toEqual([
      "matched",
      "unknown",
      "pending",
      "superseded",
      "failed",
      "differs",
      "nautilus",
      "nautilus",
    ]);
    expect(model.step4).toEqual({
      daysNeeded: 14,
      daysSinceStart: 4,
      decisionDate: "2026-11-20",
      lines: [
        "Instant backtest: no live comparison runs since 2026-11-06.",
        "Parameter sweep: 1 runs from 1 request(s), on 1 of 4 day(s) (2026-11-06 to 2026-11-06); 1 same, 0 differ.",
        "Autopilot gate: no live comparison runs since 2026-11-06.",
      ],
      met: false,
      since: "2026-11-06",
      verdict:
        "Not met yet: the dual run has been live 4 of 14 days. No live comparison runs for Instant backtest, Autopilot gate.",
    });
  });

  const daily = Array.from({ length: 14 }, (_, index) =>
    comparisonRow({
      createdAt: new Date(
        at("2026-11-06T12:00:00Z") + index * 86_400_000
      ).toISOString(),
    })
  );
  const step4At = (
    generatedAt: string,
    comparisons: Parameters<typeof buildModel>[0]["comparisons"],
    limit = 500
  ) =>
    buildModel({
      benchmark: RIG_BENCHMARK_2026_11_06,
      comparisons,
      generatedAt: new Date(generatedAt),
      journal: { entries: [], read: false },
      limit,
      nautilusListFull: true,
      nautilusRuns: [],
    });

  it("passes step 4 after two weeks with live runs of every step-4 feature", () => {
    const model = step4At("2026-11-20T12:00:00.000Z", {
      autopilotGate: daily,
      instant: daily,
      sweep: daily,
    });
    expect(model.journal.firstAt).toBeNull();
    expect(model.nautilusListFull).toBe(true);
    expect(model.step4.met).toBe(true);
    expect(model.step4.verdict).toBe(
      "Met. The dual run has been live 14 days. Every step-4 feature has live comparison runs."
    );
  });

  it("does not pass step 4 early, without runs, and says when counts are lower bounds", () => {
    expect(
      step4At("2026-11-12T00:00:00.000Z", {
        autopilotGate: daily,
        instant: daily,
        sweep: daily,
      }).step4.verdict
    ).toBe(
      "Not met yet: the dual run has been live 6 of 14 days. Every step-4 feature has live comparison runs."
    );
    const late = step4At(
      "2026-11-21T00:00:00.000Z",
      { instant: daily, sweep: daily },
      14
    ).step4;
    expect(late.met).toBe(false);
    expect(late.verdict).toBe(
      "The dual run has been live 15 days. No live comparison runs for Autopilot gate. Counts for Instant backtest, Parameter sweep are lower bounds (list limit reached)."
    );
    expect(late.lines[0]).toMatch(
      /^Instant backtest: at least 14 runs from 1 request\(s\), on 14 of 15 day\(s\)/u
    );
  });
});
