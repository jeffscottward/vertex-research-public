import { oc } from "@orpc/contract";
import { z } from "zod";

import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
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
    /** Candidates bred per generation; also the size of the parent pool. */
    populationSize: z.number().int().min(4).max(200).default(40),
    /** Stop after this many candidates (trials) in the campaign. */
    maxCandidates: z.number().int().min(20).max(1_000_000).default(2000),
    /** Stop after this much engine CPU time in total. */
    maxCpuMinutes: z.number().int().min(1).max(1440).default(60),
    /** Work done by one tick call before it returns. */
    tickSeconds: z.number().int().min(2).max(55).default(20),
    /** Best ungated candidates sent through the gate after each generation. */
    gatePerGeneration: z.number().int().min(1).max(10).default(3),
  })
  .strict();

export const AutopilotCampaignConfigSchema = z
  .object({
    budget: AutopilotBudgetSchema,
    /** Flat cost in basis points per side; the gate needs at least 1. */
    costBps: z.number().finite().min(1).max(100).default(5),
    seed: z.number().int().min(0).max(2_147_483_647),
    gateVersion: z.string().max(40),
  })
  .strict();

export const AutopilotCampaignCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    symbol: z.string().trim().min(1).max(64),
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
    budget: AutopilotBudgetSchema.default({
      gatePerGeneration: 3,
      maxCandidates: 2000,
      maxCpuMinutes: 60,
      populationSize: 40,
      tickSeconds: 20,
    }),
    costBps: z.number().finite().min(1).max(100).default(5),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();

export const AutopilotCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  status: z.enum(AUTOPILOT_CAMPAIGN_STATUS_VALUES),
  config: AutopilotCampaignConfigSchema,
  generation: z.number().int(),
  candidateCount: z.number().int(),
  gatedCount: z.number().int(),
  verifiedCount: z.number().int(),
  cpuMs: z.number(),
  bestFitness: nullableNumber,
  bestCandidateId: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  tickedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});

const GateCheckSchema = z.object({
  id: z.enum(AUTOPILOT_GATE_CHECK_IDS),
  label: z.string(),
  passed: z.boolean(),
  value: nullableNumber,
  threshold: z.string(),
  detail: z.string(),
});

const CurvePointSchema = z.object({ t: z.string(), equity: z.number() });

export const AutopilotGateSchema = z.object({
  version: z.string(),
  passed: z.boolean(),
  checks: z.array(GateCheckSchema),
  splitT: z.string(),
  oos: z.object({
    sharpe: nullableNumber,
    totalReturn: z.number(),
    cagr: nullableNumber,
    maxDrawdown: z.number(),
    trades: z.number().int(),
  }),
  folds: z.array(
    z.object({ from: z.string(), to: z.string(), totalReturn: z.number() })
  ),
  monteCarlo: z
    .object({
      probabilityOfProfit: z.number(),
      drawdownP5: z.number(),
      finalP5: z.number(),
      finalP50: z.number(),
    })
    .nullable(),
  deflatedSharpe: z
    .object({
      probability: z.number(),
      sharpe: z.number(),
      expectedMaxSharpe: z.number(),
      trials: z.number().int(),
    })
    .nullable(),
  fdr: z
    .object({
      qValue: z.number(),
      tested: z.number().int(),
      discoveries: z.number().int(),
    })
    .nullable(),
  costStress: z.object({ costBps: z.number(), oosSharpe: nullableNumber }),
  tradesTotal: z.number().int(),
  neighbours: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        oosSharpe: nullableNumber,
      })
    )
    .default([]),
});

export const AutopilotInSampleSchema = z.object({
  fitness: nullableNumber,
  sharpe: nullableNumber,
  totalReturn: z.number(),
  maxDrawdown: z.number(),
  trades: z.number().int(),
});

export const AutopilotCandidateSummarySchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  generation: z.number().int(),
  origin: z.enum(AUTOPILOT_ORIGIN_VALUES),
  parentIds: z.array(z.string()),
  label: z.string(),
  fitness: nullableNumber,
  inSample: AutopilotInSampleSchema,
  oosSharpe: nullableNumber,
  status: z.enum(AUTOPILOT_CANDIDATE_STATUS_VALUES),
  gate: AutopilotGateSchema.nullable(),
  strategyId: z.string().nullable(),
  deploymentRequestId: z.string().nullable(),
  createdAt: z.date(),
  gatedAt: z.date().nullable(),
});

const ReadinessCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "conflict"]),
  detail: z.string(),
});

export const AutopilotNautilusConfigSchema = z.object({
  format: z.literal(AUTOPILOT_NAUTILUS_FORMAT),
  mode: z.literal("paper"),
  engine: z.string(),
  strategy: z.object({
    adapter: z.string(),
    definitionSha256: z.string(),
    definition: StrategyDefinitionSchema,
  }),
  instrument: z.object({ symbol: z.string(), timeframe: z.string() }),
  autopilot: z.object({
    campaignId: z.string(),
    candidateId: z.string(),
    gateVersion: z.string(),
  }),
  armed: z.literal(false),
  note: z.string(),
});

export const AutopilotCandidateDetailSchema = z.object({
  candidate: AutopilotCandidateSummarySchema,
  definition: StrategyDefinitionSchema,
  curve: z.array(CurvePointSchema),
  parents: z.array(AutopilotCandidateSummarySchema),
  children: z.array(AutopilotCandidateSummarySchema),
  nautilus: AutopilotNautilusConfigSchema.nullable(),
  liveReadiness: z.object({
    allowed: z.literal(false),
    checks: z.array(ReadinessCheckSchema),
  }),
});

export const AutopilotCampaignDetailSchema = z.object({
  campaign: AutopilotCampaignSchema,
  leaderboard: z.array(AutopilotCandidateSummarySchema),
  gated: z.array(AutopilotCandidateSummarySchema),
  seriesTrials: z.number().int(),
});

export const AutopilotTickResultSchema = z.object({
  campaignId: z.string(),
  status: z.enum(AUTOPILOT_CAMPAIGN_STATUS_VALUES),
  generation: z.number().int(),
  evaluated: z.number().int(),
  gated: z.number().int(),
  verified: z.number().int(),
  cpuMs: z.number(),
  note: z.string().nullable(),
});

const autopilot = oc.errors(AGENT_OPS_API_ERRORS);

const create = autopilot
  .route({
    method: "POST",
    path: "/autopilot/campaigns",
    operationId: "autopilot.campaigns.create",
    summary: "Create and start an Autopilot campaign (research only)",
    tags: ["Autopilot"],
  })
  .input(AutopilotCampaignCreateInputSchema)
  .output(AutopilotCampaignSchema);

const list = autopilot
  .route({
    method: "GET",
    path: "/autopilot/campaigns",
    operationId: "autopilot.campaigns.list",
    summary: "List Autopilot campaigns, newest first",
    tags: ["Autopilot"],
  })
  .input(z.object({}).strict())
  .output(z.object({ campaigns: z.array(AutopilotCampaignSchema) }));

const get = autopilot
  .route({
    method: "GET",
    path: "/autopilot/campaigns/{id}",
    operationId: "autopilot.campaigns.get",
    summary: "Read a campaign with its leaderboard and gated candidates",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema }).strict())
  .output(AutopilotCampaignDetailSchema);

const setStatus = autopilot
  .route({
    method: "POST",
    path: "/autopilot/campaigns/{id}/status",
    operationId: "autopilot.campaigns.setStatus",
    summary: "Start or stop a campaign",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema, action: z.enum(["start", "stop"]) }).strict())
  .output(AutopilotCampaignSchema);

const tick = autopilot
  .route({
    method: "POST",
    path: "/autopilot/tick",
    operationId: "autopilot.campaigns.tick",
    summary:
      "Run running campaigns for one time slice each (scheduler; research only)",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema.optional() }).strict())
  .output(z.object({ results: z.array(AutopilotTickResultSchema) }));

const candidate = autopilot
  .route({
    method: "GET",
    path: "/autopilot/candidates/{id}",
    operationId: "autopilot.candidates.get",
    summary:
      "Read a candidate: tearsheet, gate checklist, lineage and paper config",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema }).strict())
  .output(AutopilotCandidateDetailSchema);

const sendToPaper = autopilot
  .route({
    method: "POST",
    path: "/autopilot/candidates/{id}/paper",
    operationId: "autopilot.candidates.sendToPaper",
    summary:
      "Create a PAPER deployment request for a verified candidate (operator session; awaits approval)",
    tags: ["Autopilot"],
  })
  .input(z.object({ id: IdSchema, limits: DeploymentLimitsSchema }).strict())
  .output(
    z.object({
      candidate: AutopilotCandidateSummarySchema,
      request: z.object({
        id: z.string(),
        status: z.string(),
        strategyId: z.string(),
        mode: z.literal("paper"),
        executionAuthorized: z.literal(false),
        brokerSubmissionAllowed: z.literal(false),
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
