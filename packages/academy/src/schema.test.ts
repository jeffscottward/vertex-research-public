import { describe, expect, it } from "vitest";

import { LESSON_SPECS } from "./lessons/specs.generated.ts";
import { LessonSpecSchema } from "./schema.ts";

type Raw = Record<string, unknown> & {
  kind: string;
  params: { id: string }[];
  steps: { element: string }[];
  scene: Record<string, unknown>;
};

const clone = (value: unknown): Raw => structuredClone(value) as Raw;
const strategy = clone(
  LESSON_SPECS.find((spec) => (spec as unknown as Raw).kind === "strategy")
);
const concept = clone(
  LESSON_SPECS.find((spec) => (spec as unknown as Raw).kind === "concept")
);

const messages = (raw: unknown): string[] => {
  const result = LessonSpecSchema.safeParse(raw);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

const payoff = (legs: unknown[]): Raw => ({
  ...clone(strategy),
  scene: { type: "payoff", legs },
});

describe("LessonSpecSchema refinements", () => {
  it("accepts the shipped specs", () => {
    expect(messages(strategy)).toEqual([]);
    expect(messages(concept)).toEqual([]);
  });

  it("defaults the course to dyr and accepts a registered course only", () => {
    expect(strategy["course"]).toBeUndefined();
    expect(LessonSpecSchema.parse(strategy).course).toBe("dyr");
    expect(
      LessonSpecSchema.parse({ ...clone(concept), course: "quantfinancetogo" })
        .course
    ).toBe("quantfinancetogo");
    expect(
      LessonSpecSchema.safeParse({ ...clone(concept), course: "nope" }).success
    ).toBe(false);
  });

  it("rejects duplicate param ids", () => {
    const raw = clone(strategy);
    raw.params = [...raw.params, ...raw.params.slice(0, 1)];
    expect(messages(raw)).toContain("param ids must be unique");
  });

  it("rejects steps drawing an element the scene lacks", () => {
    const raw = clone(strategy);
    raw.steps[0] = { ...raw.steps[0], element: "nope" } as never;
    expect(messages(raw).join()).toMatch(/element nope is not drawn/u);
  });

  it("requires backtests only on strategy lessons", () => {
    const noBacktest = clone(strategy);
    delete noBacktest["backtest"];
    expect(messages(noBacktest)).toContain(
      "strategy lessons need a backtest preset"
    );
    const withBacktest = { ...clone(concept), backtest: strategy["backtest"] };
    expect(messages(withBacktest)).toContain(
      "concept lessons have no backtest preset"
    );
  });

  it("checks leg param references and option strike/dte", () => {
    const raw = payoff([
      { kind: "call", side: "long", strike: "missingParam", dte: 30 },
      { kind: "put", side: "short", strike: 100 },
      { kind: "stock", side: "long" },
    ]);
    const issues = messages(raw);
    expect(issues).toContain("leg references unknown param missingParam");
    expect(issues).toContain("option legs need strike and dte");
    const known = payoff([
      { kind: "call", side: "long", strike: raw.params[0]?.id, dte: 30 },
    ]);
    expect(messages(known).join()).not.toMatch(/unknown param/u);
  });
});
