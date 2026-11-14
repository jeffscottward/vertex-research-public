// Document shapes of the QuantJourney library and its re-run results (see quantjourney.ts).
// A leaf module: the re-run code and the Markdown renderer both read these shapes.
import { z } from "zod";
import { StrategyDefinitionSchema } from "../../packages/api/src/strategy-dsl.ts";

const publishedSchema = z.object({
  benchmarkReturnPct: z.number().nullable(),
  beta: z.number().nullable(),
  cagrPct: z.number().nullable(),
  calmar: z.number().nullable(),
  maxDrawdownPct: z.number(),
  profitFactor: z.number().nullable(),
  profitFactorInfinite: z.boolean(),
  sharpe: z.number().nullable(),
  sortino: z.number().nullable(),
  totalReturnPct: z.number(),
  trades: z.number().nullable(),
  volatilityPct: z.number().nullable(),
  winRatePct: z.number().nullable(),
});

const strategySchema = z.object({
  assetClass: z.string().min(1),
  benchmark: z.string().min(1),
  category: z.enum(["orders", "weights", "walk-forward"]),
  costs: z.string().min(1),
  dashboard: z.url(),
  dsl: StrategyDefinitionSchema.nullable(),
  file: z.string().regex(/^example_[a-z0-9_]+\.py$/),
  github: z.url(),
  granularity: z.string().min(1),
  id: z.string().regex(/^(O|W|WF)\d{2}$/),
  mode: z.enum(["orders", "weights", "wf"]),
  name: z.string().min(1),
  orderType: z.string().nullable(),
  period: z.object({ end: z.string(), start: z.string() }),
  published: publishedSchema.nullable(),
  rebalance: z.string().nullable(),
  rerun: z.object({
    reason: z.string().nullable(),
    status: z.enum(["run", "no-data"]),
  }),
  rules: z.string().min(1),
  section: z.string().min(1).max(80),
  shortName: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(80),
  strategyType: z.string().nullable(),
  styles: z.array(z.string()),
  summary: z.string().min(1),
  universe: z.array(z.string()).min(1),
});

export const libraryDocSchema = z.object({
  count: z.number().int(),
  source: z.object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    dashboards: z.url(),
    fetched: z.string(),
    framing: z.string(),
    license: z.string(),
    name: z.string(),
    repository: z.url(),
    site: z.url(),
    siteSnapshot: z.string(),
    siteSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  strategies: z.array(strategySchema),
});

const halfSchema = z.object({
  cagr: z.number(),
  sharpe: z.number().nullable(),
});

export const seriesSummarySchema = z.object({
  cagr: z.number(),
  end: z.string(),
  excessKurtosis: z.number().nullable(),
  firstHalf: halfSchema,
  maxDrawdown: z.number(),
  meanReturn: z.number(),
  periods: z.number().int(),
  periodsPerYear: z.number(),
  secondHalf: halfSchema,
  sharpe: z.number().nullable(),
  skew: z.number().nullable(),
  start: z.string(),
  stdReturn: z.number(),
  totalReturn: z.number(),
  volatility: z.number(),
});

const adapterRunSchema = z.object({
  qj: z.object({
    maxDrawdown: z.number().nullable(),
    sharpe: z.number().nullable(),
    totalReturn: z.number().nullable(),
  }),
  summary: seriesSummarySchema,
});

const gateSchema = z.object({
  beatsBenchmarkBothHalves: z.boolean(),
  deflatedSharpeProbability: z.number().nullable(),
  pass: z.boolean(),
  qValue: z.number().nullable(),
});

const resultSchema = z.object({
  adapter: adapterRunSchema.nullable(),
  adapterVertexCost: adapterRunSchema.nullable(),
  benchmark: seriesSummarySchema.nullable(),
  dsl: seriesSummarySchema.nullable(),
  flags: z.array(z.string()),
  gate: gateSchema.nullable(),
  id: z.string(),
  note: z.string().nullable(),
  primary: z.enum(["dsl", "adapter"]).nullable(),
  status: z.enum(["run", "no-data", "error"]),
});

export const resultsDocSchema = z.object({
  data: z.object({ manifestSha256: z.string(), source: z.string() }),
  // Engine of the Vertex re-run; absent in files written before 2026-11-08 (TypeScript engine).
  engine: z.string().optional(),
  engineParity: z
    .object({
      against: z.string(),
      equityRelTolerance: z.number(),
      jobs: z.number().int(),
      maxEquityRel: z.number(),
      pass: z.number().int(),
    })
    .nullable()
    .optional(),
  generated: z.string(),
  strategies: z.array(resultSchema),
  trials: z.number().int(),
  vertexCostBps: z.number(),
});

export type HalfSummary = z.infer<typeof halfSchema>;
export type LibraryDoc = z.infer<typeof libraryDocSchema>;
export type LibraryStrategy = LibraryDoc["strategies"][number];
export type Published = z.infer<typeof publishedSchema>;
export type SeriesSummary = z.infer<typeof seriesSummarySchema>;
export type AdapterRun = z.infer<typeof adapterRunSchema>;
export type StrategyResult = z.infer<typeof resultSchema>;
export type ResultsDoc = z.infer<typeof resultsDocSchema>;

export const primarySummary = (
  result: StrategyResult
): SeriesSummary | null => {
  if (result.primary === "dsl") return result.dsl;
  if (result.primary === "adapter")
    return result.adapterVertexCost?.summary ?? null;
  return null;
};
