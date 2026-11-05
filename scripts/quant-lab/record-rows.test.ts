import { describe, expect, it } from "vitest";

import {
  backtestRow,
  captureIdFor,
  captureRow,
  paperOutcome,
  paperRow,
  parseQuantLabResult,
  pickMetrics,
  type QuantLabResult,
  quantLabCaptureSchema,
  quantLabSpecSchema,
  shortHash,
  specRow,
  strategyRow,
  taskRow,
} from "./record-rows.ts";
import {
  captureFixture,
  rawResultFixture,
  specFixture,
} from "./test-fixtures.ts";

const result: QuantLabResult = parseQuantLabResult(rawResultFixture);

describe("Quant Lab record mapping", () => {
  it("keys papers by DOI and captures by DOI plus version", () => {
    expect(paperRow(captureFixture)).toMatchObject({
      id: "paper-ssrn-2242795",
      identifier: captureFixture.doi,
      stage: "ingested",
      verdict: "pending",
    });
    expect(captureIdFor(captureFixture)).toBe(
      captureIdFor({ ...captureFixture, topic: "other" })
    );
    expect(captureIdFor(captureFixture)).not.toBe(
      captureIdFor({
        ...captureFixture,
        version: "crossref-deposited:2027-01-01T00:00:00Z",
      })
    );
    expect(captureIdFor(captureFixture)).toBe("capture-bafbf505c9e4c0a2");
  });

  it("keeps paper notes within the column limit and states the PDF status", () => {
    const notes = paperRow(captureFixture).notes ?? "";
    expect(notes.length).toBeLessThanOrEqual(4000);
    expect(notes).toContain("No PDF retained (no_free_copy)");
    expect(notes.endsWith("…")).toBe(true);
    expect(
      captureRow(captureFixture, "paper-ssrn-2242795").abstract
    ).toHaveLength(5000);
  });

  it("handles a retained PDF, no authors and no abstract", () => {
    const capture = {
      ...captureFixture,
      abstract: null,
      authors: [],
      pdf_bytes: 10,
      pdf_sha256: "b".repeat(64),
      pdf_status: "retained",
    };
    expect(paperRow(capture).authors).toBeNull();
    expect(paperRow(capture).notes).toContain(
      `PDF retained, sha256 ${"b".repeat(64)}.\nAbstract (Crossref): (none)`
    );
    expect(captureRow(capture, "p")).toMatchObject({
      abstract: null,
      authors: [],
      capturedAt: new Date("2026-10-18T17:49:32Z"),
      pdfBytes: 10,
    });
    expect(paperRow(captureFixture).authors).toBe("Valeriy Zakamulin");
  });

  it("keeps paper claims and our reading in separate columns", () => {
    const row = specRow(specFixture, {
      captureId: "c",
      paperId: "p",
      strategyId: "s",
    });
    expect(row.paperClaims).toEqual(specFixture.paper_claims);
    expect(row.ourReading).toEqual(specFixture.our_reading);
    expect(row.spec).toBe(specFixture);
    expect(row.id).toBe("spec-7eb540a22b926076");
  });

  it("lists the strategy with its lookback range", () => {
    const row = strategyRow(specFixture, "backtested");
    expect(row.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(row.params?.[0]).toMatchObject({
      default: 10,
      max: 12,
      min: 2,
      name: "lookback",
    });
    expect(row).toMatchObject({
      id: "strategy-quantlab-zakamulin-2013-sma-timing",
      section: "Quant Lab",
      status: "backtested",
    });
    const long = strategyRow(
      { ...specFixture, id: `${"a".repeat(70)}-bc` },
      "researching"
    );
    expect(long.slug).toBe(`quantlab-${"a".repeat(70)}`);
  });

  it("normalizes the backtest and derives drawdown from equity", () => {
    const task = taskRow(specFixture, result, "p");
    const row = backtestRow(specFixture, result, {
      paperId: "p",
      strategyId: "s",
      taskId: task.id,
    });
    expect(row.taskId).toBe(task.id);
    expect(row.maxDrawdown).toBeCloseTo(0.9 / 1.2 - 1, 10);
    expect(row.tradeCount).toBe(1);
    expect(row.notes).toContain("1/2 preregistered criteria passed");
    expect(row.notes).toContain("FAIL oos_sharpe_gt_benchmark");
    expect(row.notes).toContain("PASS walk_forward_sharpe_gt_benchmark");
    const hash = shortHash(JSON.stringify(rawResultFixture)).slice(0, 12);
    expect(row.id).toBe(`bt-quantlab-7eb540a22b92-${hash}`);
    expect(task.id).toBe(`task-quantlab-7eb540a22b92-${hash}`);
    expect(task.summary).toBe(
      "Verdict inconclusive. Walk-forward Sharpe 0.63 vs buy-and-hold 0.57; max drawdown -0.24 vs -0.55."
    );
    expect(task.metrics).toEqual({
      bh_sharpe: 0.57,
      wf_cagr: 0.09,
      wf_sharpe: 0.63,
    });
  });

  it("rejects an invalid result instead of writing it", () => {
    expect(() =>
      backtestRow(
        specFixture,
        { ...result, periodEnd: "2001-01-01" },
        { paperId: null, strategyId: "s", taskId: "t" }
      )
    ).toThrow();
    expect(() =>
      parseQuantLabResult({ ...rawResultFixture, verdict: "great" })
    ).toThrow();
  });

  it("records our metrics as reproduced and leaves reported metrics alone", () => {
    const outcome = paperOutcome(result);
    expect(outcome).toMatchObject({
      stage: "backtested",
      verdict: "inconclusive",
    });
    expect(outcome.reproducedMetrics["wf_sharpe"]).toBe(0.63);
    expect(outcome).not.toHaveProperty("reported_metrics");
    expect(pickMetrics({ a: 1 }, ["a", "b"])).toEqual({ a: 1 });
  });

  it("checks capture and spec files and keeps unknown spec keys", () => {
    expect(() =>
      quantLabCaptureSchema.parse({ ...captureFixture, doi: 1 })
    ).toThrow();
    const spec = quantLabSpecSchema.parse({
      ...specFixture,
      universe: { x: 1 },
    });
    expect(spec["universe"]).toEqual({ x: 1 });
    expect(() =>
      quantLabSpecSchema.parse({ ...specFixture, spec_sha256: "bad" })
    ).toThrow();
  });
});
