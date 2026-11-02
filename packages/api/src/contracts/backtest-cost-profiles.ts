import { z } from "zod";

import {
  COST_PROFILE_PRESET_IDS,
  type CostProfilePresetId,
} from "../backtest-costs.ts";

// Contract for backtest cost profiles (see `../backtest-costs.ts`). A run accepts a preset id or a
// full custom profile; the server stores the resolved profile in the run spec. Research only.

const money = z.number().min(0).max(1_000_000);
const rate = z.number().min(0).max(1);

export const CostProfileSchema = z
  .object({
    borrowFeeAnnualPct: z.number().min(0).max(1000),
    commission: z
      .object({
        maxPercentOfValue: z.number().min(0).max(100).nullable(),
        maxPerOrder: money.nullable(),
        minPerOrder: money,
        perContract: money,
        percentOfValue: z.number().min(0).max(100),
        perShare: money,
        premiumTiers: z
          .array(
            z
              .object({
                belowPremium: z.number().positive(),
                perContract: money,
              })
              .strict()
          )
          .max(10)
          .readonly(),
      })
      .strict(),
    fees: z
      .object({ ofCommission: rate, ofSaleValue: rate, perUnit: money })
      .strict(),
    id: z.string().trim().min(1).max(64),
    instrument: z.enum(["stock", "option"]),
    label: z.string().trim().min(1).max(120),
    multiplier: z.number().positive().max(100_000),
    slippage: z.discriminatedUnion("kind", [
      z
        .object({ bps: z.number().min(0).max(1000), kind: z.literal("bps") })
        .strict(),
      z
        .object({
          fraction: z.number().min(0).max(10),
          kind: z.literal("atr"),
          period: z.number().int().min(1).max(500),
        })
        .strict(),
    ]),
    source: z.string().trim().min(1).max(300),
    spreadBps: z.number().min(0).max(2000),
  })
  .strict();

export const CostProfilePresetIdSchema = z.enum(
  COST_PROFILE_PRESET_IDS as [CostProfilePresetId, ...CostProfilePresetId[]]
);

export const CostProfileInputSchema = z.union([
  CostProfilePresetIdSchema,
  CostProfileSchema,
]);

export const BacktestRunCostsSchema = z.object({
  bps: z.number(),
  commission: z.number(),
  fees: z.number(),
  netProfitBeforeCosts: z.number(),
  profileId: z.string(),
  profileLabel: z.string(),
  slippage: z.number(),
  spread: z.number(),
  total: z.number(),
});
