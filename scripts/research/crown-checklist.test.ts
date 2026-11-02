// Ported from tests/crown-desk-checklist.test.mjs (legacy main fe6f831/f7ba230). Checks the Crown desk
// checklist (reel DejvlgDD22R) against the pinned market-health extract of the revision it maps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const macro = join(import.meta.dirname, "..", "..", "research", "macro");
const checklist = z
  .object({
    marketHealth: z.object({
      file: z.string(),
      revision: z.string(),
      asOf: z.string(),
    }),
    coverageLevels: z.record(z.string(), z.string()),
    steps: z.array(
      z
        .object({
          order: z.number().int(),
          coverage: z.string(),
          existing: z.array(z.string()),
          gaps: z.array(z.string()),
          sourceAnchor: z.string(),
        })
        .loose()
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(join(macro, "crown-desk-checklist-2026-10-16.json"), "utf8")
    )
  );

const extract = z
  .object({
    source: z.object({
      file: z.string(),
      commit: z.string(),
      blob: z.string(),
    }),
    revision: z.string(),
    asOf: z.string(),
    indicators: z.array(z.object({ id: z.string(), status: z.string() })),
  })
  .parse(
    JSON.parse(
      readFileSync(
        join(
          macro,
          `market-health-extract-${checklist.marketHealth.revision}.json`
        ),
        "utf8"
      )
    )
  );

const status = new Map(extract.indicators.map((i) => [i.id, i.status]));

describe("Crown desk checklist", () => {
  it("pins the market-health revision it was mapped against", () => {
    expect(extract.source.file).toBe(checklist.marketHealth.file);
    expect(extract.revision).toBe(checklist.marketHealth.revision);
    expect(extract.asOf).toBe(checklist.marketHealth.asOf);
    expect(status.size).toBe(extract.indicators.length);
  });

  it("maps only indicators that exist in market health", () => {
    for (const step of checklist.steps) {
      for (const id of step.existing) {
        expect(
          status.has(id),
          `step ${step.order}: unknown indicator ${id}`
        ).toBe(true);
      }
    }
  });

  it("uses coverage levels that agree with the mapped indicator statuses", () => {
    const levels = Object.keys(checklist.coverageLevels);
    for (const step of checklist.steps) {
      const label = `step ${step.order}`;
      expect(levels, label).toContain(step.coverage);
      const measured = step.existing.some(
        (id) => status.get(id) === "available"
      );
      if (step.coverage === "missing") {
        expect(step.existing, label).toHaveLength(0);
      } else {
        expect(step.existing.length, label).toBeGreaterThan(0);
      }
      if (step.coverage === "measured" || step.coverage === "partial") {
        expect(measured, `${label}: no available series`).toBe(true);
      }
      if (step.coverage !== "measured") {
        expect(step.gaps.length, `${label}: gaps required`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps steps ordered, sourced and free of invented thresholds or scores", () => {
    checklist.steps.forEach((step, index) => {
      expect(step.order).toBe(index + 1);
      expect(step.sourceAnchor.length).toBeGreaterThan(0);
      for (const key of ["threshold", "weight", "score"]) {
        expect(step, `step ${step.order}`).not.toHaveProperty(key);
      }
    });
  });
});
