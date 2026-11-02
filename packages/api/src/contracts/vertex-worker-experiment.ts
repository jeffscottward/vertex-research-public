import { z } from "zod";
import {
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";

// Private storage profile, NOT a public research record, review or execution request.
// Field names and identity are the original strategies/quant.py plan_experiment
// payload. Validation must never default, rewrite or wrap its canonical bytes.
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = count.refine((value) => value > 0);
const text = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0);
const window = z
  .object({ start: TimestampSchema, end: TimestampSchema })
  .strict()
  .refine(
    (value) =>
      timestampToEpochNanoseconds(value.start) <
      timestampToEpochNanoseconds(value.end)
  );
const gates = [
  "reproducible-backtest",
  "out-of-sample",
  "walk-forward",
  "stress",
  "cost-sensitivity",
  "forward-paper",
] as const;
export const WorkerExperimentDependencyPinSchema = z
  .object({
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    reviewId: IdentifierSchema,
    reviewVersion: IdentifierSchema,
    rightsPolicyId: IdentifierSchema,
    rightsVersion: IdentifierSchema,
  })
  .strict();
export const WorkerExperimentHandoffSchema = z
  .object({
    internalKind: z.literal("vertex-quant-experiment-handoff-v1"),
    experimentId: IdentifierSchema,
    hypothesis: z
      .object({
        id: IdentifierSchema,
        revision: positive,
        statement: text,
        falsification: text,
        assumptions: z.array(text).min(1).max(64),
        createdAt: TimestampSchema,
        citations: z
          .array(
            z
              .object({
                sourceId: IdentifierSchema,
                artifactHash: DigestSchema,
                locator: text,
                urlOrDoi: text,
                author: text,
                sourceVersion: text,
                // Preserved provenance only; never interpreted as a grant or policy pin.
                rightsReceiptId: IdentifierSchema,
                claimKind: z.enum([
                  "source-asserted",
                  "analyst-derived",
                  "reproduced",
                ]),
              })
              .strict()
          )
          .min(1)
          .max(64),
      })
      .strict(),
    strategy: z
      .object({
        id: IdentifierSchema,
        hash: DigestSchema,
        contractName: z.literal("StrategySpec"),
        schemaVersion: z.literal("1.0.0"),
      })
      .strict(),
    datasets: z
      .array(
        z
          .object({
            datasetId: IdentifierSchema,
            manifestHash: DigestSchema,
            snapshotId: IdentifierSchema,
            availableAt: TimestampSchema,
            knowledgeCutoff: TimestampSchema,
            rightsReceiptId: IdentifierSchema,
            pointInTime: z.literal(true),
          })
          .strict()
      )
      .min(1)
      .max(64),
    windows: z
      .object({ training: window, outOfSample: window, embargoSeconds: count })
      .strict(),
    seed: count,
    environmentDigest: DigestSchema,
    engineVersion: IdentifierSchema,
    implementationDigest: DigestSchema,
    requestedAt: TimestampSchema,
    parameterGrid: z.record(
      IdentifierSchema,
      z.array(z.string().min(1).max(65_536)).min(1).max(64)
    ),
    budget: z
      .object({
        maximumTrials: positive,
        maximumRuntimeSeconds: positive,
        maximumMemoryMb: positive,
      })
      .strict(),
    sandbox: z
      .object({
        network: z.literal(false),
        broker: z.literal(false),
        secrets: z.literal(false),
        writeOutsideArtifactRoot: z.literal(false),
      })
      .strict(),
    priorExperimentHash: DigestSchema.nullable(),
    requiredEvidenceGates: z.array(z.enum(gates)).length(gates.length),
    executionAuthority: z.literal("none"),
    simulatedCapitalEntersNav: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const reject = (): void => {
      context.addIssue({
        code: "custom",
        message: "Invalid frozen experiment inputs",
      });
    };
    const at = timestampToEpochNanoseconds(value.requestedAt);
    if (
      timestampToEpochNanoseconds(value.hypothesis.createdAt) > at ||
      timestampToEpochNanoseconds(value.windows.outOfSample.end) > at
    )
      reject();
    if (
      timestampToEpochNanoseconds(value.windows.outOfSample.start) -
        timestampToEpochNanoseconds(value.windows.training.end) <
      BigInt(value.windows.embargoSeconds) * 1_000_000_000n
    )
      reject();
    if (
      value.requiredEvidenceGates.some((gate, index) => gate !== gates[index])
    )
      reject();
    const names = value.datasets.map((dataset) => dataset.datasetId);
    if (
      new Set(names).size !== names.length ||
      names.some((name, index) => index > 0 && name <= (names[index - 1] ?? ""))
    )
      reject();
    for (const dataset of value.datasets) {
      if (
        timestampToEpochNanoseconds(dataset.knowledgeCutoff) >
          timestampToEpochNanoseconds(dataset.availableAt) ||
        timestampToEpochNanoseconds(dataset.availableAt) > at
      )
        reject();
    }
    const dimensions = Object.values(value.parameterGrid);
    if (dimensions.length > 64) reject();
    let trials = 1n;
    for (const values of dimensions) {
      if (new Set(values).size !== values.length) reject();
      trials *= BigInt(values.length);
      if (trials > BigInt(value.budget.maximumTrials)) reject();
    }
  })
  .readonly()
  .transform(deepFreezeArtifact);
