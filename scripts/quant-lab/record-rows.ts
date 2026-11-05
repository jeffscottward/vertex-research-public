// Pure mapping from Quant Lab artifacts (services/research/quantlab output) to Drizzle rows for
// the Quant Lab store in @darkfactory/db/server. Inputs: a paper capture JSON, a frozen spec JSON
// and a backtest result JSON. Zod schemas check each file at the boundary. Ids come from content
// hashes, so recording the same artifacts twice writes nothing new.
import { createHash } from "node:crypto";
import {
  QUANT_LAB_PAPER_CLAIMS_MAX,
  QuantLabJsonObjectSchema,
} from "@darkfactory/api";
import {
  type NormalizedBacktestResult,
  normalizeBacktestResult,
  type QuantLabCaptureRow,
  type QuantLabPaperOutcome,
  type QuantLabPaperRow,
  type QuantLabSpecRow,
  type QuantLabStrategyRow,
  type QuantLabTaskRow,
} from "@darkfactory/db/server";
import { z } from "zod";

export const quantLabCaptureSchema = z.object({
  abstract: z.string().nullable(),
  authors: z.array(z.string()),
  captured_at: z.iso.datetime({ offset: true }),
  doi: z.string().regex(/^10\.2139\/ssrn\.[0-9]+$/),
  metadata_source: z.string().min(1),
  pdf_bytes: z.number().int().nullable(),
  pdf_sha256: z.string().nullable(),
  pdf_source_url: z.string().nullable(),
  pdf_status: z.union([
    z.literal("retained"),
    z.string().regex(/^metadata_only:.+$/),
  ]),
  posted: z.string().nullable(),
  ssrn_id: z.string().min(1),
  title: z.string().min(1),
  topic: z.string().min(1),
  url: z.string().min(1),
  version: z.string().min(1),
  year: z.number().int().nullable(),
});

export const quantLabSearchSchema = z.object({
  captures: z.array(quantLabCaptureSchema),
});

// Loose: the whole spec is stored in strategy_specs.spec, so unknown keys must stay.
export const quantLabSpecSchema = z.looseObject({
  costs: z.looseObject({
    commission_bps: z.number(),
    half_spread_bps: z.number(),
    slippage_bps: z.number(),
  }),
  hypothesis: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  // Same bounds as the API read contract, so a recorded spec can always be served.
  our_reading: QuantLabJsonObjectSchema,
  paper: z.looseObject({ doi: z.string().min(1), version: z.string().min(1) }),
  paper_claims: z
    .array(QuantLabJsonObjectSchema)
    .min(1)
    .max(QUANT_LAB_PAPER_CLAIMS_MAX),
  signal: z.looseObject({
    lookback: z.number(),
    lookback_unit: z.string(),
    type: z.string().min(1),
  }),
  spec_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  validation: z.looseObject({
    walk_forward: z.looseObject({
      lookback_grid: z.array(z.number()).min(1),
    }),
  }),
});

export const quantLabResultSchema = z.object({
  benchmark: z.unknown(),
  criteria: z.array(
    z.object({
      check: z.string(),
      description: z.string(),
      passed: z.boolean(),
    })
  ),
  dataSource: z.string(),
  equity: z.unknown(),
  folds: z.unknown(),
  instruments: z.string(),
  isSplit: z.unknown(),
  metrics: z.record(z.string(), z.number()),
  periodEnd: z.string(),
  periodStart: z.string(),
  runConfig: z.unknown(),
  specId: z.string().min(1),
  specSha256: z.string().min(1),
  strategy: z.string(),
  trades: z.unknown(),
  verdict: z.enum(["promising", "inconclusive", "rejected"]),
});

export type QuantLabCapture = z.output<typeof quantLabCaptureSchema>;
export type QuantLabSpec = z.output<typeof quantLabSpecSchema>;
/** A checked result plus the hash of the file content it was read from. */
export type QuantLabResult = z.output<typeof quantLabResultSchema> &
  Readonly<{ contentHash: string }>;

export const shortHash = (value: string, length = 16): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

/**
 * Checks a parsed result file. The content hash is taken from the raw value, the same way the
 * Civet recorder hashed it, so task and backtest ids stay stable.
 */
export const resultContentHash = (raw: unknown): string =>
  shortHash(JSON.stringify(raw));

export const parseQuantLabResult = (raw: unknown): QuantLabResult => ({
  ...quantLabResultSchema.parse(raw),
  contentHash: resultContentHash(raw),
});

const paperIdFor = (capture: QuantLabCapture): string =>
  `paper-ssrn-${capture.ssrn_id}`;
export const captureIdFor = (capture: QuantLabCapture): string =>
  `capture-${shortHash(`${capture.doi}|${capture.version}`)}`;
const specIdFor = (spec: QuantLabSpec): string =>
  `spec-${spec.spec_sha256.slice(0, 16)}`;
export const strategyIdFor = (spec: QuantLabSpec): string =>
  `strategy-quantlab-${spec.id}`.slice(0, 120);

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const runSuffix = (spec: QuantLabSpec, result: QuantLabResult): string =>
  `${spec.spec_sha256.slice(0, 12)}-${result.contentHash.slice(0, 12)}`;

const paperNotes = (capture: QuantLabCapture): string => {
  const pdf =
    capture.pdf_status === "retained"
      ? `PDF retained, sha256 ${capture.pdf_sha256}`
      : `No PDF retained (${capture.pdf_status.replace("metadata_only:", "")})`;
  const head = `SSRN capture ${capture.captured_at}, ${capture.version}. ${pdf}.\nAbstract (Crossref): `;
  return clip(`${head}${capture.abstract ?? "(none)"}`, 4000);
};

export const paperRow = (
  capture: QuantLabCapture
): QuantLabPaperRow & { id: string } => ({
  authors:
    capture.authors.length === 0 ? null : clip(capture.authors.join(", "), 500),
  id: paperIdFor(capture),
  identifier: capture.doi,
  kind: "paper",
  notes: paperNotes(capture),
  sourceUrl: capture.url,
  stage: "ingested",
  title: clip(capture.title, 300),
  verdict: "pending",
  year: capture.year,
});

export const captureRow = (
  capture: QuantLabCapture,
  paperId: string
): QuantLabCaptureRow => ({
  abstract: capture.abstract === null ? null : clip(capture.abstract, 10_000),
  authors: capture.authors,
  capturedAt: new Date(capture.captured_at),
  doi: capture.doi,
  id: captureIdFor(capture),
  metadataSource: capture.metadata_source,
  paperId,
  pdfBytes: capture.pdf_bytes,
  pdfSha256: capture.pdf_sha256,
  pdfSourceUrl: capture.pdf_source_url,
  pdfStatus: capture.pdf_status,
  posted: capture.posted,
  ssrnId: capture.ssrn_id,
  title: clip(capture.title, 300),
  topic: capture.topic,
  url: capture.url,
  version: capture.version,
});

export const strategyRow = (
  spec: QuantLabSpec,
  status: "researching" | "backtested"
): QuantLabStrategyRow => {
  const grid = spec.validation.walk_forward.lookback_grid;
  return {
    description: clip(spec.hypothesis, 2000),
    id: strategyIdFor(spec),
    kind: "python",
    name: clip(spec.name, 200),
    params: [
      {
        default: spec.signal.lookback,
        max: Math.max(...grid),
        min: Math.min(...grid),
        name: "lookback",
        step: 1,
        title: `Signal lookback (${spec.signal.lookback_unit})`,
        type: "integer",
      },
    ],
    section: "Quant Lab",
    // Cut without an ellipsis so a long id still gives a valid slug.
    slug: `quantlab-${spec.id}`.slice(0, 80).replace(/-+$/, ""),
    sourceRef: "services/research/quantlab",
    status,
    tags: ["quant-lab", "ssrn", spec.signal.type],
  };
};

export const specRow = (
  spec: QuantLabSpec,
  ids: Readonly<{
    paperId: string | null;
    captureId: string | null;
    strategyId: string;
  }>
): QuantLabSpecRow => ({
  captureId: ids.captureId,
  hypothesis: clip(spec.hypothesis, 4000),
  id: specIdFor(spec),
  name: clip(spec.name, 200),
  ourReading: spec.our_reading,
  paperClaims: spec.paper_claims,
  paperId: ids.paperId,
  spec,
  specKey: spec.id,
  specSha256: spec.spec_sha256,
  strategyId: ids.strategyId,
});

const backtestNotes = (spec: QuantLabSpec, result: QuantLabResult): string => {
  const passed = result.criteria.filter((item) => item.passed).length;
  const lines = [
    `Quant Lab verdict: ${result.verdict} (${passed}/${result.criteria.length} preregistered criteria passed).`,
    ...result.criteria.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.check}: ${item.description}`
    ),
    `Spec ${spec.id} sha256 ${spec.spec_sha256}. Paper ${spec.paper.doi} (${spec.paper.version}).`,
    "Equity = stitched walk-forward out-of-sample curve; benchmark = buy and hold on the same days. Bar-level fills at the next open with commission, half-spread and slippage. Research only; not a trading signal.",
  ];
  return clip(lines.join("\n"), 4000);
};

/** Keeps only the named metrics that the result reports (stored metrics never hold nulls). */
export const pickMetrics = (
  metrics: Readonly<Record<string, number>>,
  names: readonly string[]
): Record<string, number> =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = metrics[name];
      return value === undefined ? [] : [[name, value]];
    })
  );

export const taskRow = (
  spec: QuantLabSpec,
  result: QuantLabResult,
  paperId: string | null
): QuantLabTaskRow & { id: string } => ({
  agent: "quant-lab",
  id: `task-quantlab-${runSuffix(spec, result)}`,
  kind: "backtest",
  links: [],
  metrics: pickMetrics(result.metrics, ["wf_sharpe", "bh_sharpe", "wf_cagr"]),
  paperId,
  status: "succeeded",
  summary: clip(
    `Verdict ${result.verdict}. Walk-forward Sharpe ${result.metrics["wf_sharpe"]} vs buy-and-hold ${result.metrics["bh_sharpe"]}; max drawdown ${result.metrics["wf_max_drawdown"]} vs ${result.metrics["bh_max_drawdown"]}.`,
    4000
  ),
  title: clip(`Quant Lab backtest: ${spec.name}`, 300),
});

export const backtestRow = (
  spec: QuantLabSpec,
  result: QuantLabResult,
  ids: Readonly<{
    taskId: string;
    paperId: string | null;
    strategyId: string;
  }>
): NormalizedBacktestResult & { id: string } => ({
  id: `bt-quantlab-${runSuffix(spec, result)}`,
  ...normalizeBacktestResult({
    benchmark: result.benchmark,
    dataSource: result.dataSource,
    equity: result.equity,
    folds: result.folds,
    instruments: result.instruments,
    isSplit: result.isSplit,
    metrics: result.metrics,
    notes: backtestNotes(spec, result),
    paperId: ids.paperId,
    periodEnd: result.periodEnd,
    periodStart: result.periodStart,
    runConfig: result.runConfig,
    strategy: result.strategy,
    strategyId: ids.strategyId,
    taskId: ids.taskId,
    trades: result.trades,
  }),
});

/** Paper stage and verdict after a recorded backtest. Reproduced metrics are ours; reported metrics stay the paper's. */
export const paperOutcome = (result: QuantLabResult): QuantLabPaperOutcome => ({
  reproducedMetrics: pickMetrics(result.metrics, [
    "wf_cagr",
    "wf_sharpe",
    "wf_max_drawdown",
    "bh_sharpe",
    "bh_max_drawdown",
  ]),
  stage: "backtested",
  verdict: result.verdict,
});
