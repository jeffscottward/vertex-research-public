import { describe, expect, it } from "vitest";

import { ALL_ACADEMY_LESSONS as ACADEMY_LESSONS } from "./lessons/database-courses.test-support.ts";
import { defaultValues, payoffSummary, resolveLegs } from "./position.ts";
import {
  buildScene,
  elementColors,
  expectedPnl,
  pricePathOf,
} from "./scenes.ts";
import {
  lessonTimeline,
  lessonVtt,
  parseLessonVtt,
  stateAt,
} from "./timeline.ts";

describe("scenes", () => {
  it("finds the breakeven and capped profit/loss of a call debit spread", () => {
    const values = { spot: 100, iv: 25, rate: 0 };
    const legs = resolveLegs(
      [
        { kind: "call", side: "long", qty: 1, strike: 95, dte: 30 },
        { kind: "call", side: "short", qty: 1, strike: 105, dte: 30 },
      ],
      values
    );
    const summary = payoffSummary(legs, 100, 0);
    const debit = (legs[0]?.entry ?? 0) - (legs[1]?.entry ?? 0);
    expect(summary.breakevens[0]).toBeCloseTo(95 + debit, 1);
    expect(summary.maxProfit).toBeCloseTo((10 - debit) * 100, 0);
    expect(summary.maxLoss).toBeCloseTo(-debit * 100, 0);
  });

  it("gives a fairly priced iron condor an EV of about zero without an excess-drift view", () => {
    const values = { spot: 100, iv: 30, rate: 4 };
    const legs = resolveLegs(
      [
        { kind: "put", side: "long", qty: 1, strike: 80, dte: 30 },
        { kind: "put", side: "short", qty: 1, strike: 90, dte: 30 },
        { kind: "call", side: "short", qty: 1, strike: 110, dte: 30 },
        { kind: "call", side: "long", qty: 1, strike: 120, dte: 30 },
      ],
      values
    );
    // Discounting aside, EV under the pricing measure equals the credit's carry: well under $1.
    expect(Math.abs(expectedPnl(legs, 100, 0.3, 30, 0.04, 0.04))).toBeLessThan(
      1
    );
  });

  it("nets the financing carry out of EV for stock and deep ITM debits", () => {
    const values = { spot: 100, iv: 30, rate: 4 };
    const stock = resolveLegs(
      [{ kind: "stock", side: "long", qty: 1 }],
      values
    );
    expect(Math.abs(expectedPnl(stock, 100, 0.3, 30, 0.04, 0.04))).toBeLessThan(
      0.5
    );
    const deep = resolveLegs(
      [{ kind: "call", side: "long", qty: 1, strike: 80, dte: 365 }],
      values
    );
    expect(Math.abs(expectedPnl(deep, 100, 0.3, 365, 0.04, 0.04))).toBeLessThan(
      2
    );
  });

  it("drifts an unanchored price path at the risk-free rate plus the excess-drift input, like the risk table", () => {
    const path = pricePathOf(
      { spot: 100, iv: 30, rate: 4, drift: 5, realizedVol: 1, seed: 1 },
      365
    );
    // 1% vol: the path ends near 100 x e^{0.09}, not 100 x e^{0.05}.
    expect(path.at(-1)).toBeGreaterThan(100 * Math.exp(0.075));
    expect(path.at(-1)).toBeLessThan(100 * Math.exp(0.105));
  });

  it("makes a story price path pass through every waypoint", () => {
    const path = pricePathOf({ spot: 50, iv: 30, seed: 4 }, 40, [
      { day: 10, movePct: -20 },
      { day: 30, movePct: 15 },
    ]);
    expect(path).toHaveLength(41);
    expect(path[10]).toBeCloseTo(40, 6);
    expect(path[30]).toBeCloseTo(57.5, 6);
  });

  it("builds finite scenes for every lesson at entry, midpoint and horizon", () => {
    for (const lesson of ACADEMY_LESSONS) {
      for (const t of [0, 0.5, 1]) {
        const scene = buildScene(lesson, defaultValues(lesson.params), t);
        expect(scene.panels.length, lesson.slug).toBeGreaterThan(0);
        for (const panel of scene.panels)
          expect(
            panel.xDomain.every(Number.isFinite),
            `${lesson.slug} ${panel.id}`
          ).toBe(true);
      }
    }
  });
});

describe("timeline and captions", () => {
  it("writes one colored cue per step and matches the element color", () => {
    const lesson = ACADEMY_LESSONS.find(
      (entry) => entry.slug === "itm-debit-call-spread"
    );
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const cues = parseLessonVtt(lessonVtt(lesson));
    const timeline = lessonTimeline(lesson);
    const colors = elementColors(lesson);
    expect(cues).toHaveLength(lesson.steps.length + 1);
    for (const [index, step] of timeline.steps.entries()) {
      const cue = cues[index + 1];
      expect(cue?.start).toBeCloseTo(step.start, 3);
      expect(cue?.color).toBe(colors[step.element]);
      expect(stateAt(timeline, step.start + 0.1).active?.element).toBe(
        step.element
      );
    }
  });

  it("keeps the recovery marker on the chart at a 95% loss and moves it continuously from t = 0", () => {
    const lesson = ACADEMY_LESSONS.find(
      (entry) => entry.slug === "risk-first-max-downside"
    );
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const values = { ...defaultValues(lesson.params), lossPct: 95 };
    const panel = buildScene(lesson, values, 1, 0).panels[0];
    const marker = panel?.markers.find((entry) => entry.kind === "dot");
    expect(marker?.y).toBeCloseTo(1900, 0);
    expect(marker?.x ?? 0).toBeLessThanOrEqual(panel?.xDomain?.[1] ?? 0);
    expect(marker?.y ?? 0).toBeLessThanOrEqual(panel?.yDomain?.[1] ?? 0);
    const start = buildScene(lesson, values, 0, 0).panels[0]?.markers[0];
    const early = buildScene(lesson, values, 0.01, 0).panels[0]?.markers[0];
    expect(Math.abs((start?.x ?? 0) - (early?.x ?? 0))).toBeLessThan(1);
  });

  it.each(
    ACADEMY_LESSONS.filter(
      (lesson) =>
        lesson.scene.type === "ivrv" ||
        lesson.scene.type === "distribution" ||
        (lesson.scene.type === "portfolio" &&
          lesson.scene.mode !== "allocation")
    ).map((lesson) => [lesson.slug, lesson] as const)
  )(
    "draws data under every caption after the first in %s (time reaches the end)",
    (_slug, lesson) => {
      const timeline = lessonTimeline(lesson);
      for (const step of timeline.steps.slice(1))
        expect(
          stateAt(timeline, step.end - 0.01).t,
          `step ${step.index}`
        ).toBeGreaterThan(0.5);
    }
  );

  it("labels the shared-horizon line of the longer side by its day, not as at expiry", () => {
    const lesson = ACADEMY_LESSONS.find(
      (entry) => entry.slug === "deep-itm-leaps-capital-efficiency"
    );
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const labels =
      buildScene(
        lesson,
        defaultValues(lesson.params),
        0.5,
        0
      ).panels[0]?.series.map((series) => series.label) ?? [];
    expect(labels.filter((label) => label.endsWith("at expiry"))).toHaveLength(
      1
    );
    expect(labels.some((label) => /at day \d+ of \d+$/u.test(label))).toBe(
      true
    );
  });
});
