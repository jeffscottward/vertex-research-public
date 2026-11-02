import {
  type AutopilotCampaignRecord,
  type AutopilotCandidateSummary,
  type AutopilotRepository,
  DatabaseConflictError,
  DeploymentRequestStateError,
  InvalidRepositoryInputError,
  normalizeDeploymentLimits,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { AUTOPILOT_GATE } from "../autopilot-gate.ts";
import {
  autopilotDefinitionId,
  autopilotLibraryStrategy,
  autopilotLiveReadiness,
  nautilusPaperConfig,
} from "../autopilot-handoff.ts";
import { appContract } from "../contract.ts";
import {
  AUTOPILOT_LEADERBOARD_MAX,
  AUTOPILOT_TICK_MAX,
  type AutopilotCampaignOutput,
  AutopilotCampaignSchema,
  type AutopilotCandidateSummaryOutput,
  AutopilotCandidateDetailSchema,
  AutopilotCandidateSummarySchema,
  AutopilotGateSchema,
  type AutopilotTickResult,
} from "../contracts/autopilot.ts";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import {
  type AutopilotRunnerDependencies,
  seriesKey,
  tickAutopilotCampaign,
} from "./autopilot-runner.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import { strategyDefinitionSha256 } from "./strategy-definitions.ts";

// Autopilot procedures (autopilot.*). Operator sessions only, except autopilot.campaigns.tick,
// which an operator WRITE key may call (the scheduler; see AGENT_API_KEY_PROCEDURE_PATHS).
// sendToPaper also refuses keys itself: only an operator session creates the PAPER deployment
// request, which then waits for the owner's approval in the existing flow. Nothing here arms,
// routes or submits orders, and nothing requests live.

export const AUTOPILOT_SESSION_REQUIRED_MESSAGE =
  "Sending a candidate to paper needs an operator session; API keys are refused";

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<
  Record<
    | "NOT_FOUND"
    | "CONFLICT"
    | "FORBIDDEN"
    | "STORAGE_ERROR"
    | "VALIDATION_ERROR",
    (options?: { message?: string }) => Error
  >
>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): AutopilotRepository => {
  const repository = context.repositories.autopilot;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const campaignOutput = (
  row: AutopilotCampaignRecord
): AutopilotCampaignOutput => AutopilotCampaignSchema.parse(row);

const summaryOutput = (
  row: AutopilotCandidateSummary
): AutopilotCandidateSummaryOutput =>
  AutopilotCandidateSummarySchema.parse({
    ...row,
    gate: row.gate === null ? null : AutopilotGateSchema.parse(row.gate),
  });

const runnerFor = (
  context: ApiContext,
  failures: Failures
): AutopilotRunnerDependencies => {
  const marketBars = context.repositories.marketBars;
  if (marketBars === undefined) throw failures.STORAGE_ERROR();
  return {
    autopilot: repositoryFor(context, failures),
    clock: () => performance.now(),
    generateId: () => crypto.randomUUID(),
    marketBars,
  };
};

const create = api.autopilot.campaigns.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const marketBars = context.repositories.marketBars;
    if (marketBars === undefined) throw failures.STORAGE_ERROR();
    const series = await marketBars.getSeries(input.symbol, input.timeframe);
    if (series === null || series.barCount < AUTOPILOT_GATE.minBars)
      throw failures.VALIDATION_ERROR({
        message: `Autopilot needs at least ${AUTOPILOT_GATE.minBars} stored ${input.timeframe} bars for ${input.symbol}; found ${series?.barCount ?? 0}.`,
      });
    // A research seed for reproducible breeding, not a secret.
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const row = await repository.createCampaign({
      config: {
        budget: input.budget,
        costBps: input.costBps,
        gateVersion: AUTOPILOT_GATE.version,
        seed,
      },
      createdBy: context.principal.userId,
      name: input.name,
      symbol: input.symbol,
      timeframe: input.timeframe,
    });
    return campaignOutput(row);
  });

const list = api.autopilot.campaigns.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = repositoryFor(context, errors as unknown as Failures);
    return {
      campaigns: (await repository.listCampaigns(100)).map(campaignOutput),
    };
  });

const get = api.autopilot.campaigns.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const campaign = await repository.getCampaign(input.id);
    if (campaign === null)
      throw failures.NOT_FOUND({ message: "Campaign not found" });
    const [leaderboard, verified, rejected, ledger] = await Promise.all([
      repository.listCandidates({
        campaignId: campaign.id,
        limit: AUTOPILOT_LEADERBOARD_MAX,
        order: "fitness",
      }),
      repository.listCandidates({
        campaignId: campaign.id,
        limit: AUTOPILOT_LEADERBOARD_MAX,
        order: "fitness",
        status: "verified",
      }),
      repository.listCandidates({
        campaignId: campaign.id,
        limit: AUTOPILOT_LEADERBOARD_MAX,
        order: "recent",
        status: "rejected",
      }),
      repository.ledger({
        excludeId: "",
        sample: 1,
        series: seriesKey(campaign),
      }),
    ]);
    return {
      campaign: campaignOutput(campaign),
      gated: [...verified, ...rejected].map(summaryOutput),
      leaderboard: leaderboard.map(summaryOutput),
      seriesTrials: ledger.total,
    };
  });

const setStatus = api.autopilot.campaigns.setStatus
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const row = await repository.transitionCampaign({
      id: input.id,
      note: input.action === "stop" ? "Stopped by an operator." : null,
      to: input.action === "start" ? "running" : "stopped",
    });
    if (row !== null) return campaignOutput(row);
    const existing = await repository.getCampaign(input.id);
    if (existing === null)
      throw failures.NOT_FOUND({ message: "Campaign not found" });
    throw failures.CONFLICT({
      message: `The campaign is ${existing.status}; it cannot ${input.action}.`,
    });
  });

const tick = api.autopilot.campaigns.tick
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = runnerFor(context, failures);
    let campaigns: AutopilotCampaignRecord[];
    if (input.id === undefined) {
      campaigns = await dependencies.autopilot.dueCampaigns(AUTOPILOT_TICK_MAX);
    } else {
      const campaign = await dependencies.autopilot.getCampaign(input.id);
      if (campaign === null)
        throw failures.NOT_FOUND({ message: "Campaign not found" });
      if (campaign.status !== "running")
        throw failures.CONFLICT({
          message: `The campaign is ${campaign.status}.`,
        });
      campaigns = [campaign];
    }
    const results: AutopilotTickResult[] = [];
    for (const campaign of campaigns)
      results.push(await tickAutopilotCampaign(dependencies, campaign));
    return { results };
  });

const candidateGet = api.autopilot.candidates.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const row = await repository.getCandidate(input.id);
    if (row === null)
      throw failures.NOT_FOUND({ message: "Candidate not found" });
    const campaign = await repository.getCampaign(row.campaignId);
    if (campaign === null)
      throw failures.NOT_FOUND({ message: "Campaign not found" });
    const definition = StrategyDefinitionSchema.parse(row.definition);
    const curve = AutopilotCandidateDetailSchema.shape.curve.parse(
      row.gate?.["curve"] ?? []
    );
    const [parents, children] = await Promise.all([
      repository.getCandidates(row.parentIds),
      repository.children(row.id, AUTOPILOT_LEADERBOARD_MAX),
    ]);
    return {
      candidate: summaryOutput(row),
      children: children.map(summaryOutput),
      curve,
      definition,
      liveReadiness: autopilotLiveReadiness({
        paperRequestId: row.deploymentRequestId,
        verified: row.status === "verified",
      }),
      nautilus:
        row.status === "verified"
          ? nautilusPaperConfig(
              row,
              {
                gateVersion: AUTOPILOT_GATE.version,
                symbol: campaign.symbol,
                timeframe: campaign.timeframe,
              },
              definition,
              await strategyDefinitionSha256(definition)
            )
          : null,
      parents: parents.map(summaryOutput),
    };
  });

const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true)
    throw (errors as unknown as Failures).FORBIDDEN({
      message: AUTOPILOT_SESSION_REQUIRED_MESSAGE,
    });
  return await next();
});

const sendToPaper = api.autopilot.candidates.sendToPaper
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const { deploymentRequests, strategyDefinitions, strategyLibrary } =
      context.repositories;
    if (
      deploymentRequests === undefined ||
      strategyDefinitions === undefined ||
      strategyLibrary === undefined
    )
      throw failures.STORAGE_ERROR();
    const row = await repository.getCandidate(input.id);
    if (row === null)
      throw failures.NOT_FOUND({ message: "Candidate not found" });
    if (row.status !== "verified")
      throw failures.CONFLICT({
        message: "Only a verified candidate can go to paper.",
      });
    if (row.deploymentRequestId !== null)
      throw failures.CONFLICT({
        message: `This candidate already has paper request ${row.deploymentRequestId}.`,
      });
    const campaign = await repository.getCampaign(row.campaignId);
    if (campaign === null)
      throw failures.NOT_FOUND({ message: "Campaign not found" });
    // Check what the paper request will refuse before any write, so a refused hand-off leaves
    // nothing behind (no saved revision, no library strategy).
    try {
      normalizeDeploymentLimits(input.limits);
      normalizeDeploymentSymbol(campaign.symbol);
      normalizeDeploymentTimeframe(campaign.timeframe);
    } catch (error) {
      // The normalizers throw DeploymentRequestInputError, an Error with the reason.
      throw failures.VALIDATION_ERROR({ message: (error as Error).message });
    }
    const definition = StrategyDefinitionSchema.parse(row.definition);
    const sha256 = await strategyDefinitionSha256(definition);
    const definitionId = autopilotDefinitionId(row.id);
    await strategyDefinitions.insert({
      createdBy: context.principal.userId,
      definition: row.definition,
      definitionId,
      name: definition.name,
      note: `Autopilot candidate ${row.id}, verified by ${AUTOPILOT_GATE.version}.`,
      revision: 1,
      sha256,
    });
    const handoff = { gateVersion: AUTOPILOT_GATE.version, ...campaign };
    try {
      const strategy = await strategyLibrary.create(
        autopilotLibraryStrategy(row, handoff, sha256)
      );
      const draft = await deploymentRequests.create({
        limits: input.limits,
        requestedBy: context.principal.userId,
        strategyId: strategy.id,
        symbol: campaign.symbol,
        timeframe: campaign.timeframe,
      });
      if (draft === null)
        throw failures.CONFLICT({
          message: "The library strategy was removed.",
        });
      const request = await deploymentRequests.transition({
        action: "submit",
        actorId: context.principal.userId,
        id: draft.id,
      });
      const recorded = await repository.recordHandoff({
        deploymentRequestId: draft.id,
        id: row.id,
        strategyId: strategy.id,
      });
      if (recorded === null)
        throw failures.CONFLICT({
          message: "Another hand-off of this candidate finished first.",
        });
      return {
        candidate: summaryOutput(recorded),
        request: {
          brokerSubmissionAllowed: false as const,
          executionAuthorized: false as const,
          id: draft.id,
          mode: "paper" as const,
          status: request?.status ?? draft.status,
          strategyId: strategy.id,
        },
      };
    } catch (error) {
      if (error instanceof InvalidRepositoryInputError)
        throw failures.VALIDATION_ERROR({ message: error.message });
      if (
        error instanceof DatabaseConflictError ||
        error instanceof DeploymentRequestStateError
      )
        throw failures.CONFLICT({
          message: `A hand-off of this candidate already started (library strategy autopilot-${row.id}). Finish it on Deployments.`,
        });
      throw error;
    }
  });

export const autopilotRouter = {
  campaigns: { create, get, list, setStatus, tick },
  candidates: { get: candidateGet, sendToPaper },
};
