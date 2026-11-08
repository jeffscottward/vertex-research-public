import type {
  AutopilotCampaignRecord,
  AutopilotCandidateInput,
  AutopilotCandidateRecord,
  AutopilotRepository,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

import { breedGeneration } from "../autopilot-breeding.ts";
import {
  AUTOPILOT_GATE,
  type AutopilotGateCheck,
  type AutopilotLedger,
  evaluateGate,
  evaluateInSample,
  type GateReport,
  type InSampleResult,
  neighbourCheck,
  outOfSampleSharpe,
} from "../autopilot-gate.ts";
import {
  type AutopilotGenome,
  genomeDefinition,
  genomeKey,
  genomeLabel,
  genomeNeighbours,
} from "../autopilot-genome.ts";
import { createRandom, seedFrom } from "../backtest-analytics.ts";
import {
  type AutopilotCampaignConfig,
  AutopilotCampaignConfigSchema,
  type AutopilotTickResult,
} from "../contracts/autopilot.ts";
import type { ComparisonQueue } from "../engine-comparison.ts";
import {
  type BarColumns,
  InstantBacktestInputError,
} from "../instant-backtest-engine.ts";
import {
  StrategyDefinitionSchema,
  serverStrategyRefusal,
} from "../strategy-dsl.ts";
import {
  SectorQuadrantDataError,
  type SectorQuadrantSeries,
} from "../strategy-dsl-compile.ts";
import {
  type GatedCandidate,
  queueGateComparisons,
} from "./autopilot-comparison.ts";
import {
  loadSectorQuadrants,
  type SectorQuadrantSource,
} from "./sector-quadrant-series.ts";

// Autopilot runner. One tick works on one running campaign for at most its tick time slice:
// breed a generation from the fittest candidates (in-sample fitness only), evaluate and store the
// children (each one a trial of the series ledger), then gate the best ungated candidates. A
// candidate that passes the gate is refined: its parameter neighbours are evaluated and stored as
// trials too, the gate is run again with the larger ledger, and the neighbourhood must hold up.
// Research only: no broker client, order path, deployment or network call is reachable from here.

const AUTOPILOT_LEDGER_SAMPLE = 500;
const MINUTE_MS = 60_000;

export type AutopilotRunnerDependencies = Readonly<{
  autopilot: AutopilotRepository;
  marketBars: MarketBarsRepository;
  /** Monotonic milliseconds (performance.now in production). */
  clock: () => number;
  generateId: () => string;
  /** Stored sector rotation points for campaigns with sector filters. */
  sectorRotation?: SectorQuadrantSource;
  /** Engine comparison on: queue for the Nautilus shadow runs of the gate. */
  comparison?: ComparisonQueue;
}>;

const GeneSchema = z.object({
  block: z.string(),
  params: z.array(z.number()),
});
// Stored genomes were written by this runner; the schema only restores their type.
const GenomeSchema = z.object({
  entry: z.array(GeneSchema),
  exit: z.array(GeneSchema),
  stop: GeneSchema.nullable(),
  target: GeneSchema.nullable(),
});
const InSampleStoredSchema = z.object({
  excessKurtosis: z.number().nullable(),
  fitness: z.number().nullable(),
  maxDrawdown: z.number(),
  periodsPerYear: z.number(),
  sharpe: z.number().nullable(),
  skew: z.number().nullable(),
  summary: z.object({
    firstT: z.string().nullable(),
    lastT: z.string().nullable(),
    meanReturn: z.number().nullable(),
    returns: z.number(),
    stdReturn: z.number().nullable(),
  }),
  totalReturn: z.number(),
  trades: z.number(),
});

const storedGenome = (value: unknown): AutopilotGenome =>
  GenomeSchema.parse(value) as AutopilotGenome;

export const seriesKey = (campaign: AutopilotCampaignRecord): string =>
  `${campaign.symbol}/${campaign.timeframe}`;

const toRecord = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

type Context = Readonly<{
  dependencies: AutopilotRunnerDependencies;
  campaign: AutopilotCampaignRecord;
  config: AutopilotCampaignConfig;
  bars: BarColumns;
  keys: Set<string>;
  ledger: { value: AutopilotLedger | null };
  /** Series for the campaign's sector filters; undefined without filters. */
  sectorQuadrants: SectorQuadrantSeries | undefined;
  /** Candidates gated in this tick (engine comparison shadows them). */
  gated: GatedCandidate[];
}>;

const candidateRow = (
  context: Context,
  input: Readonly<{
    genome: AutopilotGenome;
    key: string;
    origin: AutopilotCandidateInput["origin"];
    parentIds: readonly string[];
    generation: number;
  }>
): Readonly<{ row: AutopilotCandidateInput; inSample: InSampleResult }> => {
  const label = genomeLabel(input.genome);
  const id = context.dependencies.generateId();
  const bred = genomeDefinition(
    input.genome,
    `AP ${context.campaign.symbol} ${label}`
  );
  // Campaign filters become part of every candidate definition, so the gate and the paper
  // hand-off use the same rules as the in-sample run.
  const filters = context.config.filters;
  const definition = filters === undefined ? bred : { ...bred, filters };
  const inSample = evaluateInSample(
    context.bars,
    definition,
    context.config.costBps,
    context.sectorQuadrants
  );
  const summary = inSample.summary;
  return {
    inSample,
    row: {
      campaignId: context.campaign.id,
      definition: toRecord(definition),
      firstT: new Date(String(summary.firstT)),
      fitness: inSample.fitness,
      generation: input.generation,
      genome: toRecord(input.genome),
      genomeKey: input.key,
      id,
      inSample: toRecord(inSample),
      label: label.slice(0, 500),
      lastT: new Date(String(summary.lastT)),
      origin: input.origin,
      parentIds: input.parentIds,
      returnsCount: summary.returns,
      returnsMean: Number(summary.meanReturn),
      returnsStd: Number(summary.stdReturn),
      series: seriesKey(context.campaign),
    },
  };
};

// The series ledger is read once per generation (after its children are stored) and then kept
// current in memory: refine neighbours add to the total as they are stored. The candidate itself
// is never one of the "others".
const ledgerFor = async (
  context: Context,
  candidateId: string
): Promise<AutopilotLedger> => {
  if (context.ledger.value === null) {
    const series = seriesKey(context.campaign);
    const ledger = await context.dependencies.autopilot.ledger({
      excludeId: "",
      sample: AUTOPILOT_LEDGER_SAMPLE,
      series,
    });
    context.ledger.value = {
      key: series,
      others: ledger.others.map((trial) => ({
        firstT: trial.firstT.toISOString(),
        id: trial.id,
        lastT: trial.lastT.toISOString(),
        meanReturn: trial.meanReturn,
        returns: trial.returns,
        stdReturn: trial.stdReturn,
      })),
      total: ledger.total,
    };
  }
  const current = context.ledger.value;
  return {
    ...current,
    others: current.others.filter((trial) => trial.id !== candidateId),
  };
};

const NOT_RUN: AutopilotGateCheck = {
  detail: "Not run: the candidate failed an earlier check.",
  id: "neighbours",
  label: "Parameter neighbourhood",
  passed: false,
  threshold: "75% of neighbours keep 50% of the out-of-sample Sharpe",
  value: null,
};

type Neighbour = Readonly<{
  id: string;
  label: string;
  oosSharpe: number | null;
}>;

const refine = async (
  context: Context,
  candidate: AutopilotCandidateRecord,
  genome: AutopilotGenome
): Promise<Neighbour[]> => {
  const neighbours: Neighbour[] = [];
  const rows: AutopilotCandidateInput[] = [];
  for (const neighbour of genomeNeighbours(genome)) {
    const key = genomeKey(neighbour);
    const built = candidateRow(context, {
      generation: candidate.generation,
      genome: neighbour,
      key,
      origin: "neighbour",
      parentIds: [candidate.id],
    });
    const known = context.keys.has(key);
    neighbours.push({
      id: known ? "" : built.row.id,
      label: built.row.label,
      oosSharpe: outOfSampleSharpe(
        context.bars,
        StrategyDefinitionSchema.parse(built.row.definition),
        context.config.costBps,
        context.sectorQuadrants
      ),
    });
    if (!known) {
      context.keys.add(key);
      rows.push(built.row);
    }
  }
  const inserted = await context.dependencies.autopilot.insertCandidates(rows);
  const ledger = context.ledger.value as AutopilotLedger;
  context.ledger.value = { ...ledger, total: ledger.total + inserted.length };
  return neighbours;
};

/** Gates one candidate and stores the verdict. Returns true when it is verified. */
const gateCandidate = async (
  context: Context,
  candidate: AutopilotCandidateRecord
): Promise<boolean> => {
  const definition = StrategyDefinitionSchema.parse(candidate.definition);
  context.gated.push({ definition, id: candidate.id });
  const inSample = InSampleStoredSchema.parse(
    candidate.inSample
  ) as InSampleResult;
  const run = async (): Promise<GateReport> =>
    evaluateGate({
      bars: context.bars,
      costBps: context.config.costBps,
      definition,
      inSample,
      ledger: await ledgerFor(context, candidate.id),
      sectorQuadrants: context.sectorQuadrants,
      seed: candidate.id,
    });
  let report = await run();
  let neighbours: Neighbour[] = [];
  let neighbourResult = NOT_RUN;
  if (report.passed) {
    neighbours = await refine(
      context,
      candidate,
      storedGenome(candidate.genome)
    );
    // The neighbours are trials too: gate again with the larger ledger.
    report = await run();
    neighbourResult = neighbourCheck(
      report.oos.sharpe,
      neighbours.map((neighbour) => neighbour.oosSharpe)
    );
  }
  const checks = [...report.checks, neighbourResult];
  const passed = checks.every((check) => check.passed);
  const stored = await context.dependencies.autopilot.recordGate({
    gate: toRecord({ ...report, checks, neighbours, passed }),
    id: candidate.id,
    oosSharpe: report.oos.sharpe,
    status: passed ? "verified" : "rejected",
  });
  // Another tick may have gated this candidate first; count only what this tick stored.
  return passed && stored !== null;
};

const failure = async (
  dependencies: AutopilotRunnerDependencies,
  campaign: AutopilotCampaignRecord,
  note: string
): Promise<AutopilotTickResult> => {
  const failed = await dependencies.autopilot.transitionCampaign({
    id: campaign.id,
    note,
    to: "failed",
  });
  return {
    campaignId: campaign.id,
    cpuMs: 0,
    evaluated: 0,
    gated: 0,
    generation: campaign.generation,
    note,
    status: failed?.status ?? campaign.status,
    verified: 0,
  };
};

const loadBars = async (
  dependencies: AutopilotRunnerDependencies,
  campaign: AutopilotCampaignRecord
): Promise<BarColumns | null> => {
  if (campaign.timeframe !== "1d" && campaign.timeframe !== "1m") return null;
  const series = await dependencies.marketBars.getSeries(
    campaign.symbol,
    campaign.timeframe
  );
  if (series === null) return null;
  return await dependencies.marketBars.loadColumns(series.id);
};

/** Runs one time slice of a running campaign. */
export const tickAutopilotCampaign = async (
  dependencies: AutopilotRunnerDependencies,
  campaign: AutopilotCampaignRecord
): Promise<AutopilotTickResult> => {
  const parsed = AutopilotCampaignConfigSchema.safeParse(campaign.config);
  if (!parsed.success)
    return await failure(
      dependencies,
      campaign,
      "The campaign configuration is invalid."
    );
  const config = parsed.data;
  // A campaign stored before the create check: fail it rather than run without its series.
  const refusal = serverStrategyRefusal({ filters: config.filters });
  if (refusal !== undefined)
    return await failure(dependencies, campaign, refusal.message);
  const bars = await loadBars(dependencies, campaign);
  if (bars === null)
    return await failure(
      dependencies,
      campaign,
      `No stored ${campaign.timeframe} bars for ${campaign.symbol}.`
    );
  if (bars.c.length < AUTOPILOT_GATE.minBars)
    return await failure(
      dependencies,
      campaign,
      `The stored series has ${bars.c.length} bars; Autopilot needs at least ${AUTOPILOT_GATE.minBars}.`
    );
  try {
    return await runSlice(dependencies, campaign, config, bars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bad stored data fails the campaign for good (that message is written for users). Any other error (for example a short database
    // outage) only records a note and the tick time, so the campaign retries next tick and never
    // blocks the campaigns behind it.
    if (
      error instanceof InstantBacktestInputError &&
      !(error instanceof SectorQuadrantDataError)
    )
      return await failure(
        dependencies,
        campaign,
        `Tick failed: ${message}`.slice(0, 500)
      );
    // Sector data may arrive with the next collection, so the campaign waits for it. The raw
    // message of other errors can hold SQL and parameters: their stored note stays generic.
    const note =
      error instanceof SectorQuadrantDataError
        ? `${message}; the next tick retries.`
        : "Tick error; the next tick retries.";
    const saved = await dependencies.autopilot.recordProgress({
      cpuMs: 0,
      generation: campaign.generation,
      id: campaign.id,
      note,
      status: "running",
      version: campaign.version,
    });
    return {
      campaignId: campaign.id,
      cpuMs: 0,
      evaluated: 0,
      gated: 0,
      generation: campaign.generation,
      note,
      status: saved?.status ?? campaign.status,
      verified: 0,
    };
  }
};

const runSlice = async (
  dependencies: AutopilotRunnerDependencies,
  campaign: AutopilotCampaignRecord,
  config: AutopilotCampaignConfig,
  bars: BarColumns
): Promise<AutopilotTickResult> => {
  const started = dependencies.clock();
  const deadline = started + config.budget.tickSeconds * 1000;
  const cpuBudget = config.budget.maxCpuMinutes * MINUTE_MS - campaign.cpuMs;
  const context: Context = {
    bars,
    campaign,
    config,
    dependencies,
    gated: [],
    keys: new Set(await dependencies.autopilot.campaignKeys(campaign.id)),
    ledger: { value: null },
    sectorQuadrants: await loadSectorQuadrants(
      dependencies.sectorRotation,
      config,
      bars.t[0] as number
    ),
  };
  let generation = campaign.generation;
  let evaluated = 0;
  let gated = 0;
  let verified = 0;
  let stalled = false;
  const remaining = () => config.budget.maxCandidates - context.keys.size;
  const elapsed = () => dependencies.clock() - started;
  while (
    dependencies.clock() < deadline &&
    remaining() > 0 &&
    elapsed() < cpuBudget
  ) {
    const parents = await dependencies.autopilot.population(
      campaign.id,
      config.budget.populationSize
    );
    const offspring = breedGeneration({
      count: Math.min(config.budget.populationSize, remaining()),
      knownKeys: context.keys,
      parents: parents.map((parent) => ({
        fitness: parent.fitness,
        genome: storedGenome(parent.genome),
        id: parent.id,
      })),
      random: createRandom(
        seedFrom(`${config.seed}:${campaign.id}:${generation}`)
      ),
    });
    if (offspring.length === 0) {
      stalled = true;
      break;
    }
    const rows = offspring.map(
      (child) => candidateRow(context, { ...child, generation }).row
    );
    for (const child of offspring) context.keys.add(child.key);
    evaluated += (await dependencies.autopilot.insertCandidates(rows)).length;
    generation += 1;
    context.ledger.value = null;
    for (const candidate of await dependencies.autopilot.ungated(
      campaign.id,
      config.budget.gatePerGeneration
    )) {
      gated += 1;
      if (await gateCandidate(context, candidate)) verified += 1;
    }
  }
  const cpuMs = elapsed();
  const comparison =
    dependencies.comparison === undefined
      ? undefined
      : await queueGateComparisons({
          bars,
          campaign,
          candidates: context.gated,
          clock: dependencies.clock,
          costBps: config.costBps,
          queue: dependencies.comparison,
          sectorQuadrants: context.sectorQuadrants,
        });
  const exhausted =
    stalled ||
    remaining() <= 0 ||
    campaign.cpuMs + cpuMs >= config.budget.maxCpuMinutes * MINUTE_MS;
  const note = stalled
    ? "Breeding found no new genomes; the campaign is complete."
    : exhausted
      ? "The candidate or CPU budget is used up; the campaign is complete."
      : null;
  const saved = await dependencies.autopilot.recordProgress({
    cpuMs,
    generation,
    id: campaign.id,
    note,
    status: exhausted ? "completed" : "running",
    version: campaign.version,
  });
  return {
    campaignId: campaign.id,
    ...(comparison === undefined ? {} : { comparison }),
    cpuMs,
    evaluated,
    gated,
    generation,
    note:
      saved === null
        ? "The campaign was stopped or changed during the tick."
        : note,
    status:
      saved?.status ??
      (await dependencies.autopilot.getCampaign(campaign.id))?.status ??
      "stopped",
    verified,
  };
};
