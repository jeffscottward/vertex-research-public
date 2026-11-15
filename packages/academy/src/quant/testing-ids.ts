// What: Contract of the testing quant scenes (backtest overfitting and significance testing): modes, the element ids
// each mode draws (lesson steps reveal these), default element colors, model notes for the
// constants table and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

export const TESTING_ELEMENTS = {
  significance: [
    "axes",
    "curve",
    "threshold",
    "marker",
    "pdf",
    "observed",
    "pvalue",
  ],
  snooping: ["axes", "curve", "best", "marker", "points", "zero"],
} as const;
export type TestingMode = keyof typeof TESTING_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const TESTING_COLORS: Readonly<Record<string, ColorToken>> = {
  best: "amber",
  observed: "amber",
  points: "blue",
  pvalue: "red",
  threshold: "red",
  zero: "gray",
};

/** One line per mode for the constants table (model and assumptions). */
export const TESTING_MODELS: Readonly<Record<TestingMode, string>> = {
  significance:
    "Null: true Sharpe 0; estimated annual Sharpe ~ N(0, 1/√years), t = SR·√years, two-sided normal p-value",
  snooping:
    "N seeded rules with true Sharpe 0; in- and out-of-sample Sharpe estimates drawn independently from N(0, 1/√years)",
};

export const TESTING_FORMULA_IDS = ["tStat", "dataSnooping"] as const;
export type TestingFormulaId = (typeof TESTING_FORMULA_IDS)[number];
