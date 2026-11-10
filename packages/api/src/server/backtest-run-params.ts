import type { BacktestRunRecord } from "@darkfactory/db/server";

import type { CostProfile } from "../backtest-costs.ts";
import { CostProfileSchema } from "../contracts/backtest-cost-profiles.ts";
import type { InstantRunParams } from "../instant-backtest-engine.ts";

// Engine parameters of a stored backtest run spec. A backtest run and its paper forward runner both
// use this function, so the paper runner trades with exactly the settings of its baseline run.

/** Cost profile and capital of a stored spec; undefined without a profile. */
export const costsForSpec = (
  spec: BacktestRunRecord["spec"]
): InstantRunParams["costs"] => {
  if (spec.costProfile === undefined) return undefined;
  const profile: CostProfile = CostProfileSchema.parse(spec.costProfile);
  return { capital: spec.initialCapital, profile };
};

/** Engine parameters of a fixed-rule spec. A strategy definition spec has none. */
export const runParamsForSpec = (
  spec: BacktestRunRecord["spec"]
): InstantRunParams => {
  const { rule } = spec;
  if (rule.kind === "dsl") {
    throw new Error("A strategy definition run has no fixed-rule parameters");
  }
  if (rule.kind === "academy") {
    throw new Error("An Academy run has no fixed-rule parameters");
  }
  const costs = costsForSpec(spec);
  return {
    costBps: spec.costBps,
    rule,
    stopLossPct: spec.stopLossPct,
    takeProfitPct: spec.takeProfitPct,
    ...(costs === undefined ? {} : { costs }),
  };
};
