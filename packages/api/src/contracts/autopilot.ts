import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  StrategyDefinitionSchema,
  StrategyFiltersSchema,
} from "../strategy-dsl.ts";
import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";
import { DeploymentLimitsSchema } from "./deployment-requests.ts";
import { INSTANT_BACKTEST_TIMEFRAMES } from "./instant-backtest.ts";

// Autopilot (research only): campaigns breed strategy-definition candidates on one stored bar
// series, score them in sample, and pass the best through the fixed verification gate. Operators
// start, stop and tick campaigns with a session; an operator write key may call only the tick. The hand-off
// "send to paper" needs an operator session: it creates a PAPER deployment request in the existing
// approval flow, status "requested", and nothing else. No procedure here routes, arms or submits
// orders, and none requests live trading.

export const AUTOPILOT_CAMPAIGN_STATUS_VALUES = [
  "running",
  "stopped",
  "completed",
  "failed",
] as const;
export const AUTOPILOT_CANDIDATE_STATUS_VALUES = [
  "evaluated",
  "rejected",
  "verified",
] as const;
export const AUTOPILOT_ORIGIN_VALUES = [
  "random",
  "crossover",
  "mutation",
  "neighbour",
] as const;
export const AUTOPILOT_GATE_CHECK_IDS = [
  "oosSharpe",
  "forwardFolds",
  "monteCarlo",
  "deflatedSharpe",
  "fdr",
  "minTrades",
  "costs",
  "neighbours",
] as const;
export const AUTOPILOT_LEADERBOARD_MAX = 50;
export const AUTOPILOT_TICK_MAX = 10;
export const AUTOPILOT_NAUTILUS_FORMAT = "vertex-nautilus-dsl-strategy-v1";

const IdSchema = z.string().trim().min(1).max(128);
const nullableNumber = z.number().nullable();

export const AutopilotBudgetSchema = z
  .object({
    /** Best ungated candidates sent through the gate after each generation. */
    gatePerGeneration: z.number().int().min(1).max(10).default(3),
    /** Stop after this many candidates (trials) in the campaign. */
    maxCandidates: z.number().int().min(20).max(1_000_000).default(2000),
    /** Stop after this much engine CPU time in total. */
    maxCpuMinutes: z.number().int().min(1).max(1440).default(60),
    /** Candidates bred per generation; also the size of the parent pool. */
    populationSize: z.number().int().min(4).max(200).default(40),
    /** Work done by one tick call before it returns. */
    tickSeconds: z.number().int().min(2).max(55).default(20),
  })
  .strict();

export const AutopilotCampaignConfigSchema = z
  .object({
    budget: AutopilotBudgetSchema,
    /** Flat cost in basis points per side; the gate needs at least 1. */
    costBps: z.number().finite().min(1).max(100).default(5),
    /**
     * Sector entry filters added to every candidate definition. Optional with no default, so
     * campaigns created without filters keep the same config.
     */
    filters: StrategyFiltersSchema.optional(),
    gateVersion: z.string().max(40),
    seed: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();

export const AutopilotCampaignCreateInputSchema = z
  .object({
    budget: AutopilotBudgetSchema.default({
      gatePerGeneration: 3,
      maxCandidates: 2000,
      maxCpuMinutes: 60,
      populationSize: 40,
      tickSeconds: 20,
    }),
    costBps: z.number().finite().min(1).max(100).default(5),
    filters: StrategyFiltersSchema.optional(),
    name: z.string().trim().min(1).max(120),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    symbol: z.string().trim().min(1).max(64),
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
  })
  .strict();

export const AutopilotCampaignSchema = z.object({
  bestCandidateId: z.string().nullable(),
  bestFitness: nullableNumber,
  candidateCount: z.number().int(),
  config: AutopilotCampaignConfigSchema,
  cpuMs: z.number(),
  createdAt: z.date(),
  createdBy: z.string(),
  finishedAt: z.date().nullable(),
  gatedCount: z.number().int(),
  generation: z.number().int(),
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  startedAt: z.date().nullable(),
  status: z.enum(AUTOPILOT_CAMPAIGN_STATUS_VALUES),
  symbol: z.string(),
  tickedAt: z.date().nullable(),
  timeframe: z.string(),
  updatedAt: z.date(),
  verifiedCount: z.number().int(),
});

const GateCheckSchema = z.object({
  detail: z.string(),
  id: z.enum(AUTOPILOT_GATE_CHECK_IDS),
  label: z.string(),
  passed: z.boolean(),
  threshold: z.string(),
  value: nullableNumber,
});

const CurvePointSchema = z.object({ equity: z.number(), t: z.string() });

export const AutopilotGateSchema = z.object({
  checks: z.array(GateCheckSchema),
  costStress: z.object({ costBps: z.number(), oosSharpe: nullableNumber }),
  deflatedSharpe: z
    .object({
      expectedMaxSharpe: z.number(),
      probability: z.number(),
      sharpe: z.number(),
      trials: z.number().int(),
    })
    .nullable(),
  fdr: z
    .object({
      discoveries: z.number().int(),
      qValue: z.number(),
      tested: z.number().int(),
    })
    .nullable(),
  folds: z.array(
    z.object({ from: z.string(), to: z.string(), totalReturn: z.number() })
  ),
  monteCarlo: z
    .object({
      drawdownP5: z.number(),
      finalP5: z.number(),
      finalP50: z.number(),
      probabilityOfProfit: z.number(),
    })
    .nullable(),
  neighbours: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        oosSharpe: nullableNumber,
      })
    )
    .default([]),
  oos: z.object({
    cagr: nullableNumber,
    maxDrawdown: z.number(),
    sharpe: nullableNumber,
    totalReturn: z.number(),
    trades: z.number().int(),
  }),
  passed: z.boolean(),
  splitT: z.string(),
  tradesTotal: z.number().int(),
  version: z.string(),
});

export const AutopilotInSampleSchema = z.object({
  fitness: nullableNumber,
  maxDrawdown: z.number(),
  sharpe: nullableNumber,
  totalReturn: z.number(),
  trades: z.number().int(),
});

export const AutopilotCandidateSummarySchema = z.object({
  campaignId: z.string(),
  createdAt: z.date(),
  deploymentRequestId: z.string().nullable(),
  fitness: nullableNumber,
  gate: AutopilotGateSchema.nullable(),
  gatedAt: z.date().nullable(),
  generation: z.number().int(),
  id: z.string(),
  inSample: AutopilotInSampleSchema,
  label: z.string(),
  oosSharpe: nullableNumber,
  origin: z.enum(AUTOPILOT_ORIGIN_VALUES),
  parentIds: z.array(z.string()),
  status: z.enum(AUTOPILOT_CANDIDATE_STATUS_VALUES),
  strategyId: z.string().nullable(),
});

const ReadinessCheckSchema = z.object({
  detail: z.string(),
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "conflict"]),
});

export const AutopilotNautilusConfigSchema = z.object({
  armed: z.literal(false),
  autopilot: z.object({
    campaignId: z.string(),
    candidateId: z.string(),
    gateVersion: z.string(),
  }),
  engine: z.string(),
  format: z.literal(AUTOPILOT_NAUTILUS_FORMAT),
  instrument: z.object({ symbol: z.string(), timeframe: z.string() }),
  mode: z.literal("paper"),
  note: z.string(),
  strategy: z.object({
    adapter: z.string(),
    definition: StrategyDefinitionSchema,
    definitionSha256: z.string(),
  }),
});

export const AutopilotCandidateDetailSchema = z.object({
  candidate: AutopilotCandidateSummarySchema,
  children: z.array(AutopilotCandidateSummarySchema),
  curve: z.array(CurvePointSchema),
  definition: StrategyDefinitionSchema,
  liveReadiness: z.object({
    allowed: z.literal(false),
    checks: z.array(ReadinessCheckSchema),
  }),
  nautilus: AutopilotNautilusConfigSchema.nullable(),
  parents: z.array(AutopilotCandidateSummarySchema),
});

export const AutopilotCampaignDetailSchema = z.object({
  campaign: AutopilotCampaignSchema,
  gated: z.array(AutopilotCandidateSummarySchema),
  leaderboard: z.array(AutopilotCandidateSummarySchema),
  seriesTrials: z.number().int(),
});

export const AutopilotTickResultSchema = z.object({
  campaignId: z.string(),
  /** Engine comparison on: gate runs queued on Nautilus this tick and those the cap left out. */
  comparison: z
    .object({
      dropped: z.number().int().nonnegative(),
      error: z.string().optional(),
      queued: z.number().int().nonnegative(),
    })
    .optional(),
  cpuMs: z.number(),
  evaluated: z.number().int(),
  gated: z.number().int(),
  generation: z.number().int(),
  note: z.string().nullable(),
  status: z.enum(AUTOPILOT_CAMPAIGN_STATUS_VALUES),
  verified: z.number().int(),
});

const autopilot = oc.errors(AGENT_OPS_API_ERRORS);

const create = autopilot
  .route({
    method: "POST",
    operationId: "autopilot.campaigns.create",
    path: "/autopilot/campaigns",
    summary: "Create and start an Autopilot campaign (research only)",
    tags: ["Autopilot"],
  })
  .input(AutopilotCampaignCreateInputSchema)
  .output(AutopilotCampaignSchema);

const list = autopilot
  .route({
    method: "GET",
    operationId: "autopilot.campaigns.list",
    path: "/autopilot/campaigns",
    summary: "List Autopilot campaigns, newest first",
    tags: ["Autopilot"],
  })
  .input(z.object({}).strict())
  .output(z.object({ campaigns: z.array(AutopilotCampaignSchema) }));

const get = autopilot
  .route({
    method: "GET",
    operationId: "autopilot.campaigns.get",
    path: "/autopilot/campaigns/{id}",
    summary: "Read a campaign with its leaderboard and gated candidates",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema }).strict())
  .output(AutopilotCampaignDetailSchema);

const setStatus = autopilot
  .route({
    method: "POST",
    operationId: "autopilot.campaigns.setStatus",
    path: "/autopilot/campaigns/{id}/status",
    summary: "Start or stop a campaign",
    tags: ["Autopilot"],
  })
  .input(z.object({ action: z.enum(["start", "stop"]), id: IdSchema }).strict())
  .output(AutopilotCampaignSchema);

const tick = autopilot
  .route({
    method: "POST",
    operationId: "autopilot.campaigns.tick",
    path: "/autopilot/tick",
    summary:
      "Run running campaigns for one time slice each (scheduler; research only)",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema.optional() }).strict())
  .output(z.object({ results: z.array(AutopilotTickResultSchema) }));

const candidate = autopilot
  .route({
    method: "GET",
    operationId: "autopilot.candidates.get",
    path: "/autopilot/candidates/{id}",
    summary:
      "Read a candidate: tearsheet, gate checklist, lineage and paper config",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema }).strict())
  .output(AutopilotCandidateDetailSchema);

const sendToPaper = autopilot
  .route({
    method: "POST",
    operationId: "autopilot.candidates.sendToPaper",
    path: "/autopilot/candidates/{id}/paper",
    summary:
      "Create a PAPER deployment request for a verified candidate (operator session; awaits approval)",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema, limits: DeploymentLimitsSchema }).strict())
  .output(
    z.object({
      candidate: AutopilotCandidateSummarySchema,
      request: z.object({
        brokerSubmissionAllowed: z.literal(false),
        executionAuthorized: z.literal(false),
        id: z.string(),
        mode: z.literal("paper"),
        status: z.string(),
        strategyId: z.string(),
      }),
    })
  );

export const autopilotContract = {
  campaigns: { create, get, list, setStatus, tick },
  candidates: { get: candidate, sendToPaper },
};

export type AutopilotCampaignOutput = z.infer<typeof AutopilotCampaignSchema>;
export type AutopilotCampaignConfig = z.infer<
  typeof AutopilotCampaignConfigSchema
>;
export type AutopilotCampaignCreateInput = z.input<
  typeof AutopilotCampaignCreateInputSchema
>;
export type AutopilotCandidateSummaryOutput = z.infer<
  typeof AutopilotCandidateSummarySchema
>;
export type AutopilotCandidateDetailOutput = z.infer<
  typeof AutopilotCandidateDetailSchema
>;
export type AutopilotCampaignDetailOutput = z.infer<
  typeof AutopilotCampaignDetailSchema
>;
export type AutopilotGateOutput = z.infer<typeof AutopilotGateSchema>;
export type AutopilotTickResult = z.infer<typeof AutopilotTickResultSchema>;
