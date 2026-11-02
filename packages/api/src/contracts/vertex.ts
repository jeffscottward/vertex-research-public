import { z } from "zod";
import {
  RECOVERY_CONFIRMATION,
  VERTEX_HASH_PROFILE,
  VERTEX_SCHEMA_VERSION,
  VERTEX_TIMESTAMP_PATTERN,
  canonicalArtifactJson,
  compareDecimals as compareExactDecimals,
  decimalUnits,
  deepFreezeArtifact,
  hashArtifact,
  isTickAligned as isExactTickAligned,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { DeepReadonly } from "@darkfactory/shared/vertex";

// Nonfatal schema issues may still reach refinements. Exact helpers fail closed
// here rather than throwing through safeParse on malformed source timestamps.
const timestampNanoseconds = (value: string): bigint | null => {
  try {
    return timestampToEpochNanoseconds(value);
  } catch {
    return null;
  }
};

const timeDifference = (left: string, right: string): bigint | null => {
  const a = timestampNanoseconds(left);
  const b = timestampNanoseconds(right);
  return a === null || b === null ? null : a - b;
};

const compareTimes = (left: string, right: string): number => {
  const difference = timeDifference(left, right);
  return difference === null
    ? Number.NaN
    : difference < 0n
      ? -1
      : difference > 0n
        ? 1
        : 0;
};

const millisecondsToNanoseconds = (value: number): bigint | null => {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
    ? BigInt(value) * 1_000_000n
    : null;
};

// Strict fixed-shape schemas clone plain graphs and validate every scalar.
// Deep freezing still independently validates the canonical artifact domain.
const freezeValidatedArtifact = <T>(value: T): DeepReadonly<T> => {
  return deepFreezeArtifact(value);
};

// Public data boundaries only. No procedure, broker client, side effect, live
// authorization token, raw provider record, or arbitrary metadata bag exists here.
export const SchemaVersionSchema = z.literal(VERTEX_SCHEMA_VERSION);
export const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const VersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .max(64);
export const TimestampSchema = z
  .string()
  .regex(VERTEX_TIMESTAMP_PATTERN)
  .refine((value) => timestampNanoseconds(value) !== null, {
    message: "Expected a valid Gregorian timestamp",
  });
export const DecimalStringSchema = z
  .string()
  .regex(/^(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))$/);
export const NonnegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{0,17}[1-9])?$/);
export const PositiveDecimalSchema = NonnegativeDecimalSchema.refine(
  (value) =>
    NonnegativeDecimalSchema.safeParse(value).success &&
    decimalUnits(value) > 0n,
  { message: "Expected positive decimal" }
);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not canonical",
  });
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const TextSchema = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[^\u0000-\u001f\u007f\ud800-\udfff]*$/u);
const ShortTextSchema = TextSchema.max(200);
const ids = () =>
  z
    .array(IdentifierSchema)
    .max(512)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate identity",
    });
const timesOrdered = (start: string, end: string): boolean =>
  compareTimes(start, end) < 0;
const common = { schemaVersion: SchemaVersionSchema };

// Zod may run refinements after a nonfatal regex issue. Invalid decimal input
// must return validation failure, never throw from exact arithmetic helpers.
const compareDecimals = (left: string, right: string): number => {
  if (
    !(
      DecimalStringSchema.safeParse(left).success &&
      DecimalStringSchema.safeParse(right).success
    )
  )
    return Number.NaN;
  return compareExactDecimals(left, right);
};

const isTickAligned = (value: string, tickSize: string): boolean => {
  return (
    DecimalStringSchema.safeParse(value).success &&
    PositiveDecimalSchema.safeParse(tickSize).success &&
    isExactTickAligned(value, tickSize)
  );
};

export const SourceIdentitySchema = z
  .object({
    provider: IdentifierSchema,
    sourceId: IdentifierSchema,
    snapshotId: IdentifierSchema,
    contentHash: DigestSchema,
  })
  .strict()
  .readonly()
  .transform(freezeValidatedArtifact);

// Preserve Gamma's original hashes; conversion to this wire shape does not
// preserve a hash over Gamma floats or Python's original datetime spelling.
export const GammaProvenanceSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    replaySchemaVersion: z.literal(2),
    sourceTradeRunId: IdentifierSchema,
    replayManifestId: z.string().regex(/^replay-manifest-[0-9a-f]{24}$/),
    manifestHash: DigestSchema,
    inputHash: DigestSchema,
    outputHash: DigestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.replayManifestId ===
      `replay-manifest-${value.manifestHash.slice(0, 24)}`,
    { message: "Gamma manifest identity mismatch" }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export const FreshnessSchema = z
  .object({
    status: z.enum(["fresh", "stale", "missing", "unknown"]),
    observedAt: TimestampSchema.nullable(),
    evaluatedAt: TimestampSchema,
    maxAgeMs: SafeIntegerSchema,
  })
  .strict()
  .refine(
    (value) => {
      if (value.status === "missing") return value.observedAt === null;
      if (value.observedAt === null) return value.status === "unknown";
      const age = timeDifference(value.evaluatedAt, value.observedAt);
      const maxAge = millisecondsToNanoseconds(value.maxAgeMs);
      if (age === null || maxAge === null || age < 0n) return false;
      if (value.status === "fresh") return age <= maxAge;
      if (value.status === "stale") return age > maxAge;
      return true;
    },
    { message: "Freshness must match observed data age" }
  );

export const EntitlementSchema = z
  .object({
    policyId: IdentifierSchema,
    status: z.enum(["granted", "expired", "denied", "unknown"]),
    checkedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => {
      if (value.status === "granted")
        return (
          value.expiresAt !== null &&
          timesOrdered(value.checkedAt, value.expiresAt)
        );
      if (value.status === "expired")
        return (
          value.expiresAt !== null &&
          compareTimes(value.expiresAt, value.checkedAt) <= 0
        );
      return true;
    },
    { message: "Entitlement expiry contradicts its status" }
  );

export const MarketDataSourceSchema = z
  .object({
    identity: SourceIdentitySchema,
    dataKind: z.enum(["real", "synthetic"]),
    syntheticReason: ShortTextSchema.nullable(),
    providerTimezone: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/),
    entitlement: EntitlementSchema,
    freshness: FreshnessSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.dataKind === "synthetic"
        ? value.syntheticReason !== null
        : value.syntheticReason === null,
    { message: "Synthetic data needs an explicit label" }
  );

const marketCommon = {
  ...common,
  instrumentId: IdentifierSchema,
  currency: CurrencySchema,
  source: MarketDataSourceSchema,
};
export const QuoteSchema = z
  .object({
    ...marketCommon,
    quoteId: IdentifierSchema,
    bid: NonnegativeDecimalSchema,
    ask: NonnegativeDecimalSchema,
    bidSize: NonnegativeDecimalSchema,
    askSize: NonnegativeDecimalSchema,
    lastPrice: NonnegativeDecimalSchema.nullable(),
    sourceTimestamp: TimestampSchema,
    receivedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => {
      return (
        compareDecimals(value.bid, value.ask) <= 0 &&
        compareTimes(value.sourceTimestamp, value.receivedAt) <= 0 &&
        value.source.freshness.observedAt !== null &&
        compareTimes(
          value.source.freshness.observedAt,
          value.sourceTimestamp
        ) === 0 &&
        compareTimes(value.receivedAt, value.source.freshness.evaluatedAt) <= 0
      );
    },
    { message: "Quote prices or observation chronology are inconsistent" }
  );

export const CandleSchema = z
  .object({
    ...marketCommon,
    candleId: IdentifierSchema,
    startAtInclusive: TimestampSchema,
    endAtExclusive: TimestampSchema,
    interval: z.enum(["1s", "1m", "5m", "15m", "1h", "1d", "1w", "session"]),
    open: NonnegativeDecimalSchema,
    high: NonnegativeDecimalSchema,
    low: NonnegativeDecimalSchema,
    close: NonnegativeDecimalSchema,
    volume: NonnegativeDecimalSchema,
  })
  .strict()
  .refine(
    (value) => {
      return (
        timesOrdered(value.startAtInclusive, value.endAtExclusive) &&
        compareDecimals(value.low, value.open) <= 0 &&
        compareDecimals(value.open, value.high) <= 0 &&
        compareDecimals(value.low, value.close) <= 0 &&
        compareDecimals(value.close, value.high) <= 0
      );
    },
    { message: "Invalid candle range or time interval" }
  );

export const TradeFlowSchema = z
  .object({
    ...marketCommon,
    flowId: IdentifierSchema,
    sourceTimestamp: TimestampSchema,
    receivedAt: TimestampSchema,
    price: NonnegativeDecimalSchema,
    quantity: PositiveDecimalSchema,
    aggressor: z.enum(["buy", "sell", "unknown"]),
  })
  .strict()
  .refine(
    (value) => compareTimes(value.sourceTimestamp, value.receivedAt) <= 0,
    { message: "Trade cannot precede its source observation" }
  );

export const VolumeProfileBinSchema = z
  .object({
    lowerPriceInclusive: NonnegativeDecimalSchema,
    upperPriceExclusive: PositiveDecimalSchema,
    buyVolume: NonnegativeDecimalSchema,
    sellVolume: NonnegativeDecimalSchema,
    unknownVolume: NonnegativeDecimalSchema,
  })
  .strict()
  .refine(
    (value) =>
      compareDecimals(value.lowerPriceInclusive, value.upperPriceExclusive) < 0,
    { message: "Invalid price bin" }
  );

export const VolumeProfileSchema = z
  .object({
    ...marketCommon,
    profileId: IdentifierSchema,
    startAtInclusive: TimestampSchema,
    endAtExclusive: TimestampSchema,
    bins: z.array(VolumeProfileBinSchema).min(1).max(10_000),
  })
  .strict()
  .refine(
    (value) => {
      if (!timesOrdered(value.startAtInclusive, value.endAtExclusive))
        return false;
      const sorted = [...value.bins].sort((left, right) =>
        compareDecimals(left.lowerPriceInclusive, right.lowerPriceInclusive)
      );
      return sorted.every(
        (bin, index) =>
          index === 0 ||
          compareDecimals(
            sorted[index - 1]?.upperPriceExclusive ?? "",
            bin.lowerPriceInclusive
          ) <= 0
      );
    },
    { message: "Profile bins must not overlap; wire ordering is irrelevant" }
  );

export const DatasetManifestSchema = z
  .object({
    ...common,
    datasetId: IdentifierSchema,
    provider: IdentifierSchema,
    entitlementPolicyId: IdentifierSchema,
    instrumentUniverse: ids().min(1),
    startAtInclusive: TimestampSchema,
    endAtExclusive: TimestampSchema,
    captureTime: TimestampSchema,
    dataVintageId: IdentifierSchema.nullable(),
    dataVintageStatus: z.enum(["available", "unavailable"]),
    asOfAt: TimestampSchema,
    adjustmentMethod: z.enum([
      "unadjusted",
      "split-adjusted",
      "total-return",
      "provider-defined",
    ]),
    calendar: IdentifierSchema.nullable(),
    contentHash: DigestSchema,
    storageRef: IdentifierSchema,
    retentionPolicy: IdentifierSchema,
    sources: z.array(SourceIdentitySchema).min(1).max(512),
    gammaProvenance: GammaProvenanceSchema.nullable(),
    // Presence selects a closed archival historical branch. Bounds are the actual
    // provider terminal window, NOT certified coverage; no legacy null calendar.
    historicalSemantics: z
      .object({
        profile: z.literal("vertex-ibkr-historical-bars-v1"),
        intervalSemantics: z.literal(
          "provider-terminal-window-not-certified-market-coverage"
        ),
        marketCoverage: z.literal("unqualified"),
        calendarQualification: z.literal("unqualified"),
        pointInTime: z.literal(false),
        researchAdmission: z.literal("unqualified"),
        rowSemantics: z.literal("sdk-decoded-bar-bits-v1"),
        adjustment: z.enum([
          "split-adjusted-not-dividend-adjusted",
          "split-and-dividend-adjusted",
        ]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => {
      if (value.historicalSemantics === undefined) {
        if (value.calendar === null) return false;
      } else {
        if (
          value.calendar !== null ||
          value.provider !== "ibkr" ||
          value.dataVintageId !== null ||
          value.dataVintageStatus !== "unavailable" ||
          value.gammaProvenance !== null ||
          value.sources.length !== 1 ||
          value.sources[0]?.provider !== "ibkr"
        )
          return false;
        if (
          value.adjustmentMethod !==
          (value.historicalSemantics.adjustment ===
          "split-adjusted-not-dividend-adjusted"
            ? "split-adjusted"
            : "provider-defined")
        )
          return false;
      }
      return (
        timesOrdered(value.startAtInclusive, value.endAtExclusive) &&
        compareTimes(value.asOfAt, value.captureTime) <= 0 &&
        compareTimes(value.endAtExclusive, value.captureTime) <= 0 &&
        (value.dataVintageStatus === "available"
          ? value.dataVintageId !== null
          : value.dataVintageId === null)
      );
    },
    {
      message:
        "Dataset interval, vintage, or availability cutoff is inconsistent",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

// No signed storage URLs or credentials embedded in source URIs. Storage refs
// are opaque catalog identities; the adapter resolves them with scoped access.
const SourceUriSchema = z
  .string()
  .url()
  .max(2048)
  .regex(/^[^\ud800-\udfff]*$/u)
  .refine(
    (value) => {
      try {
        const uri = new URL(value);
        return (
          uri.protocol === "https:" &&
          !uri.username &&
          !uri.password &&
          !uri.search &&
          !uri.hash
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Expected a public HTTPS source URI without credentials/query/fragment",
    }
  );

export const ResearchEvidenceSchema = z
  .object({
    ...common,
    evidenceId: IdentifierSchema,
    collectionId: IdentifierSchema,
    snapshotId: IdentifierSchema,
    sourceType: z.enum([
      "paper",
      "transcript",
      "article",
      "dataset",
      "derived-analysis",
    ]),
    sourceUri: SourceUriSchema,
    sourceIdentity: SourceIdentitySchema,
    sourceLocator: ShortTextSchema,
    attribution: ShortTextSchema,
    publishedAt: TimestampSchema.nullable(),
    capturedAt: TimestampSchema,
    contentHash: DigestSchema,
    claim: TextSchema,
    method: TextSchema,
    limitations: z.array(TextSchema).max(64),
    acceptanceStatus: z.enum([
      "unreviewed",
      "accepted",
      "rejected",
      "superseded",
    ]),
    rightsPolicyId: IdentifierSchema,
    untrustedContent: z.literal(true),
  })
  .strict()
  .refine(
    (value) => {
      return (
        value.sourceIdentity.contentHash === value.contentHash &&
        (value.publishedAt === null ||
          compareTimes(value.publishedAt, value.capturedAt) <= 0)
      );
    },
    { message: "Evidence identity or publication chronology mismatch" }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

const DuplicateMappingSchema = z
  .object({
    sourceId: IdentifierSchema,
    canonicalSourceId: IdentifierSchema,
    contentHash: DigestSchema,
  })
  .strict();
const UnavailableSourceSchema = z
  .object({
    sourceId: IdentifierSchema,
    reason: z.enum([
      "not-found",
      "rights-denied",
      "provider-unavailable",
      "unsupported-format",
      "unknown",
    ]),
  })
  .strict();

export const KnowledgeImportSchema = z
  .object({
    ...common,
    collectionId: IdentifierSchema,
    snapshotId: IdentifierSchema,
    sourceIdentities: z.array(SourceIdentitySchema).max(512),
    contentHashes: z.array(DigestSchema).max(512),
    duplicateMappings: z.array(DuplicateMappingSchema).max(512),
    unavailableSources: z.array(UnavailableSourceSchema).max(512),
    transcriptQuality: z.enum([
      "human-verified",
      "machine-generated",
      "partial",
      "unavailable",
      "not-applicable",
      "unknown",
    ]),
    retrievalScope: z.literal("collection-only"),
    rightsPolicyId: IdentifierSchema,
    replacementScope: z.literal("collection-snapshot"),
    contentClass: z.enum([
      "raw-transcript",
      "editorial-summary",
      "derived-embedding",
      "paper",
      "article",
    ]),
    untrustedContent: z.literal(true),
  })
  .strict()
  .refine(
    (value) => {
      const byId = new Map(
        value.sourceIdentities.map((source) => [source.sourceId, source])
      );
      const hashes = new Set(value.contentHashes);
      const unavailable = value.unavailableSources.map(
        (source) => source.sourceId
      );
      const duplicates = value.duplicateMappings.map(
        (source) => source.sourceId
      );
      return (
        byId.size === value.sourceIdentities.length &&
        hashes.size === value.contentHashes.length &&
        new Set(unavailable).size === unavailable.length &&
        unavailable.every((id) => !byId.has(id)) &&
        new Set(duplicates).size === duplicates.length &&
        value.sourceIdentities.every((source) =>
          hashes.has(source.contentHash)
        ) &&
        value.contentHashes.every((hash) =>
          value.sourceIdentities.some((source) => source.contentHash === hash)
        ) &&
        value.duplicateMappings.every(
          (mapping) =>
            mapping.sourceId !== mapping.canonicalSourceId &&
            byId.get(mapping.sourceId)?.contentHash === mapping.contentHash &&
            byId.get(mapping.canonicalSourceId)?.contentHash ===
              mapping.contentHash
        )
      );
    },
    {
      message:
        "Collection source and duplicate bindings must preserve identity",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export const DataRequirementSchema = z
  .object({
    kind: z.enum([
      "quotes",
      "candles",
      "trade-flow",
      "volume-profile",
      "fundamentals",
      "macro-vintages",
      "option-chain",
      "corporate-actions",
    ]),
    maximumAgeMs: SafeIntegerSchema,
    pointInTimeRequired: z.boolean(),
    entitlementPolicyId: IdentifierSchema,
  })
  .strict();
export const DeterministicRuleSchema = z
  .object({
    ruleId: IdentifierSchema,
    featureId: IdentifierSchema,
    operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
    threshold: DecimalStringSchema,
    lookbackBars: SafeIntegerSchema.min(1).max(100_000),
  })
  .strict();
export const CostModelSchema = z
  .object({
    commissionPerUnit: NonnegativeDecimalSchema,
    spreadBps: NonnegativeDecimalSchema,
    slippageBps: NonnegativeDecimalSchema,
    borrowAnnualBps: NonnegativeDecimalSchema,
    impactModel: z.enum(["fixed-bps", "participation-capped"]),
    maximumParticipationBps: PositiveDecimalSchema.refine(
      (value) => compareDecimals(value, "10000") <= 0,
      { message: "Participation exceeds 100%" }
    ),
  })
  .strict();
export const StrategySpecSchema = z
  .object({
    ...common,
    strategyId: IdentifierSchema,
    version: VersionSchema,
    sleeve: z.enum(["wheel", "fundamental", "swing", "macro", "quant"]),
    hypothesis: TextSchema,
    universe: ids().min(1),
    signalSchedule: z
      .object({
        calendar: IdentifierSchema,
        timezone: z.literal("UTC"),
        interval: z.enum(["bar-close", "session-close", "weekly", "monthly"]),
      })
      .strict(),
    entryRules: z.array(DeterministicRuleSchema).min(1).max(64),
    exitRules: z.array(DeterministicRuleSchema).min(1).max(64),
    riskLimits: z
      .object({
        maximumLoss: PositiveDecimalSchema,
        maximumNotional: PositiveDecimalSchema,
        maximumPositions: SafeIntegerSchema.min(1),
      })
      .strict(),
    requiredData: z.array(DataRequirementSchema).min(1).max(32),
    costModel: CostModelSchema,
    codeDigest: DigestSchema,
  })
  .strict()
  .readonly()
  .transform(freezeValidatedArtifact);

export const TimeWindowSchema = z
  .object({
    startAtInclusive: TimestampSchema,
    endAtExclusive: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => timesOrdered(value.startAtInclusive, value.endAtExclusive),
    { message: "Invalid time window" }
  );
const LeakageCheckSchema = z
  .object({
    kind: z.enum([
      "look-ahead",
      "survivorship",
      "point-in-time",
      "overlap",
      "multiple-testing",
    ]),
    status: z.enum(["passed", "failed", "not-run", "unknown"]),
    evidenceId: IdentifierSchema.nullable(),
  })
  .strict()
  .refine((value) => value.status !== "passed" || value.evidenceId !== null, {
    message: "Passing leakage checks require evidence",
  });
export const BacktestRunSchema = z
  .object({
    ...common,
    runId: IdentifierSchema,
    strategyVersion: IdentifierSchema,
    datasetManifestIds: ids().min(1),
    seed: SafeIntegerSchema,
    engineVersion: VersionSchema,
    trainingWindow: TimeWindowSchema,
    testWindow: TimeWindowSchema,
    benchmark: IdentifierSchema,
    transactionCosts: CostModelSchema,
    slippageModel: z.enum(["fixed-bps", "participation-capped"]),
    resultsRef: IdentifierSchema.nullable(),
    leakageChecks: z.array(LeakageCheckSchema).max(5),
    reviewStatus: z.enum(["unreviewed", "accepted", "rejected", "incomplete"]),
    validationMode: z.enum(["historical", "walk-forward", "paper-forward"]),
    forwardSampleCount: SafeIntegerSchema,
    gammaProvenance: GammaProvenanceSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => {
      if (
        compareTimes(
          value.trainingWindow.endAtExclusive,
          value.testWindow.startAtInclusive
        ) > 0
      )
        return false;
      if (
        new Set(value.leakageChecks.map((check) => check.kind)).size !==
        value.leakageChecks.length
      )
        return false;
      if (value.reviewStatus !== "accepted") return true;
      return (
        value.resultsRef !== null &&
        value.leakageChecks.length === 5 &&
        value.leakageChecks.every((check) => check.status === "passed")
      );
    },
    { message: "Backtest windows or acceptance evidence are incomplete" }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export const TradeIntentSchema = z
  .object({
    ...common,
    intentId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    correlationId: IdentifierSchema,
    proposalOnly: z.literal(true),
    executionAuthorized: z.literal(false),
    strategyVersion: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.enum(["research", "paper"]),
    instrumentId: IdentifierSchema,
    side: z.enum(["buy", "sell"]),
    quantity: PositiveDecimalSchema,
    orderType: z.enum(["market", "limit", "stop", "stop-limit"]),
    limitPrice: PositiveDecimalSchema.nullable(),
    stopPrice: PositiveDecimalSchema.nullable(),
    tickSize: PositiveDecimalSchema,
    timeInForce: z.enum(["DAY", "GTC", "IOC", "FOK"]),
    quoteAsOf: TimestampSchema,
    referenceQuote: QuoteSchema,
    proposedAt: TimestampSchema,
    reasonEvidenceIds: ids().min(1),
    maxLossBudget: PositiveDecimalSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => {
      const needsLimit =
        value.orderType === "limit" || value.orderType === "stop-limit";
      const needsStop =
        value.orderType === "stop" || value.orderType === "stop-limit";
      if (
        needsLimit !== (value.limitPrice !== null) ||
        needsStop !== (value.stopPrice !== null)
      )
        return false;
      if (
        value.limitPrice !== null &&
        !isTickAligned(value.limitPrice, value.tickSize)
      )
        return false;
      if (
        value.stopPrice !== null &&
        !isTickAligned(value.stopPrice, value.tickSize)
      )
        return false;
      const quote = value.referenceQuote;
      const entitlement = quote.source.entitlement;
      const age = timeDifference(value.proposedAt, quote.sourceTimestamp);
      const maxAge = millisecondsToNanoseconds(quote.source.freshness.maxAgeMs);
      return (
        quote.instrumentId === value.instrumentId &&
        compareTimes(value.quoteAsOf, quote.sourceTimestamp) === 0 &&
        quote.source.dataKind === "real" &&
        quote.source.freshness.status === "fresh" &&
        age !== null &&
        maxAge !== null &&
        age >= 0n &&
        age <= maxAge &&
        compareTimes(quote.source.freshness.evaluatedAt, value.proposedAt) <=
          0 &&
        entitlement.status === "granted" &&
        entitlement.expiresAt !== null &&
        compareTimes(entitlement.checkedAt, value.proposedAt) <= 0 &&
        timesOrdered(value.proposedAt, entitlement.expiresAt) &&
        timesOrdered(value.proposedAt, value.expiresAt)
      );
    },
    {
      message:
        "Proposal requires fresh entitled real data and valid nonexecutable terms",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

const ExposureCheckSchema = z
  .object({
    checkId: IdentifierSchema,
    status: z.enum(["passed", "failed", "unknown", "not-run"]),
    observed: NonnegativeDecimalSchema.nullable(),
    limit: PositiveDecimalSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "passed" ||
      (value.observed !== null &&
        compareDecimals(value.observed, value.limit) <= 0),
    { message: "Exposure result contradicts its limit" }
  );
export const RiskDecisionSchema = z
  .object({
    ...common,
    intentId: IdentifierSchema,
    policyVersion: VersionSchema,
    portfolioSnapshotId: IdentifierSchema,
    freshnessCheck: FreshnessSchema,
    cashReservationId: IdentifierSchema.nullable(),
    exposureChecks: z.array(ExposureCheckSchema).max(64),
    decision: z.enum([
      "blocked",
      "rejected",
      "requires-human-review",
      "research-accepted",
      "paper-eligible",
    ]),
    reasonCodes: ids().min(1),
    authorizationExpiry: z.null(),
    liveAuthorization: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) => {
      if (
        value.decision !== "paper-eligible" &&
        value.decision !== "research-accepted"
      )
        return true;
      return (
        value.freshnessCheck.status === "fresh" &&
        value.exposureChecks.length > 0 &&
        value.exposureChecks.every((check) => check.status === "passed")
      );
    },
    {
      message:
        "Research eligibility needs complete checks; it never authorizes execution",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export const ExecutionReceiptSchema = z
  .object({
    ...common,
    intentId: IdentifierSchema,
    submissionKey: IdentifierSchema,
    brokerOrderRef: IdentifierSchema.nullable(),
    environment: z.enum(["paper", "live"]),
    observationOnly: z.literal(true),
    status: z.enum([
      "unknown",
      "not-submitted",
      "submitted",
      "partially-filled",
      "filled",
      "cancelled",
      "rejected",
    ]),
    totalQuantity: PositiveDecimalSchema,
    filledQuantity: NonnegativeDecimalSchema,
    remainingQuantity: NonnegativeDecimalSchema,
    lastReconciledAt: TimestampSchema,
    errorClass: z
      .enum(["unknown-outcome", "rejected", "transport", "reconciliation"])
      .nullable(),
    auditEventIds: ids().min(1),
  })
  .strict()
  .refine(
    (value) => {
      if (
        ![
          value.filledQuantity,
          value.remainingQuantity,
          value.totalQuantity,
        ].every((amount) => NonnegativeDecimalSchema.safeParse(amount).success)
      )
        return false;
      const filled = decimalUnits(value.filledQuantity);
      const remaining = decimalUnits(value.remainingQuantity);
      if (filled + remaining !== decimalUnits(value.totalQuantity))
        return false;
      if (value.status === "unknown")
        return value.errorClass === "unknown-outcome";
      if (value.errorClass === "unknown-outcome") return false;
      if (value.status === "not-submitted" || value.status === "rejected")
        return filled === 0n;
      if (value.brokerOrderRef === null) return false;
      if (value.status === "filled") return remaining === 0n;
      if (value.status === "partially-filled")
        return filled > 0n && remaining > 0n;
      if (value.status === "submitted") return filled === 0n;
      return true;
    },
    {
      message:
        "Receipt must preserve unknown outcomes and exact fill arithmetic",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

const AgentErrorSchema = z
  .object({
    code: z.enum([
      "model-unavailable",
      "provider-unavailable",
      "budget-exhausted",
      "validation-failed",
      "permission-denied",
      "cancelled",
    ]),
    retryable: z.boolean(),
  })
  .strict();
export const AgentRunSchema = z
  .object({
    ...common,
    runId: IdentifierSchema,
    agentRole: z.enum([
      "research",
      "paper-to-strategy",
      "backtest-review",
      "knowledge-import",
    ]),
    taskContract: IdentifierSchema,
    allowedTools: z
      .array(
        z.enum([
          "read-evidence",
          "search-authorized-corpus",
          "propose-strategy",
          "request-backtest",
          "write-research-artifact",
        ])
      )
      .max(5),
    modelVersion: IdentifierSchema.nullable(),
    inputEvidenceIds: ids(),
    outputArtifactIds: ids(),
    tokenBudget: SafeIntegerSchema,
    costBudgetUsd: NonnegativeDecimalSchema,
    status: z.enum([
      "queued",
      "running",
      "blocked",
      "failed",
      "cancelled",
      "completed",
    ]),
    errors: z.array(AgentErrorSchema).max(32),
    approvalRequests: z
      .array(
        z
          .object({
            requestId: IdentifierSchema,
            kind: z.enum(["research-review", "rights-review"]),
          })
          .strict()
      )
      .max(32),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "completed" ||
      (value.errors.length === 0 && value.outputArtifactIds.length > 0),
    { message: "Completed research requires outputs without unresolved errors" }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export const ModuleStatusSchema = z.enum([
  "unknown",
  "disabled",
  "incompatible",
  "unavailable",
  "candidate",
  "shadow",
  "active-read-only",
  "draining",
  "retired",
]);
export const ModuleManifestSchema = z
  .object({
    ...common,
    moduleId: IdentifierSchema,
    version: VersionSchema,
    inputSchemaVersion: SchemaVersionSchema,
    outputSchemaVersion: SchemaVersionSchema,
    capabilities: z
      .array(
        z.enum([
          "research",
          "market-data-read",
          "knowledge-import",
          "backtest",
          "chart-render",
          "broker-status-read",
        ])
      )
      .min(1)
      .max(6),
    dataRequirements: z.array(DataRequirementSchema).max(32),
    supportedInstruments: z
      .array(z.enum(["equity", "etf", "option", "future", "forex", "index"]))
      .max(6),
    riskPolicyVersion: VersionSchema,
    artifactDigest: DigestSchema,
    lifecycleState: ModuleStatusSchema,
    runtime: z.enum(["civet-cloudflare", "python-external", "rust-external"]),
    reasonCodes: ids(),
  })
  .strict()
  .readonly()
  .transform(freezeValidatedArtifact);

export const BrokerRecoveryStatusSchema = z
  .object({
    ...common,
    statusId: IdentifierSchema,
    gatewayId: IdentifierSchema,
    environment: z.enum(["paper", "live"]),
    observedAt: TimestampSchema,
    infrastructure: z.enum([
      "unavailable",
      "blocked",
      "timeout",
      "failed",
      "observed",
      "unknown",
    ]),
    brokerHandshake: z.enum([
      "not-attempted",
      "unavailable",
      "disconnected",
      "authenticated",
      "unknown",
    ]),
    recovery: z.enum([
      "disabled",
      "human-required",
      "requested",
      "in-progress",
      "failed",
      "completed",
      "unknown",
    ]),
    trading: z.literal("disabled"),
    reasonCodes: ids().min(1),
    lastHumanRequestId: IdentifierSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => {
      return (
        !["requested", "in-progress", "completed"].includes(value.recovery) ||
        value.lastHumanRequestId !== null
      );
    },
    {
      message:
        "Recovery lifecycle requires an explicit human request reference",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

// Structural confirmation is NOT proof of a human or permission. A future
// authenticated handler must bind the one-time challenge to the actor, gateway,
// environment and expected status, enforce expiry and consume it atomically.
export const RecoveryRequestSchema = z
  .object({
    ...common,
    requestId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    correlationId: IdentifierSchema,
    gatewayId: IdentifierSchema,
    expectedStatusId: IdentifierSchema,
    environment: z.enum(["paper", "live"]),
    action: z.literal("request-human-recovery"),
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    executionAuthorized: z.literal(false),
    confirmation: z
      .object({
        kind: z.literal("human"),
        actorId: IdentifierSchema,
        challengeId: IdentifierSchema,
        confirmedAt: TimestampSchema,
        statement: z.literal(RECOVERY_CONFIRMATION),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => {
      const confirmationAge = timeDifference(
        value.requestedAt,
        value.confirmation.confirmedAt
      );
      const confirmationExpiry = timeDifference(
        value.expiresAt,
        value.confirmation.confirmedAt
      );
      return (
        confirmationAge !== null &&
        confirmationExpiry !== null &&
        confirmationAge >= 0n &&
        confirmationAge <= 300_000_000_000n &&
        timesOrdered(value.requestedAt, value.expiresAt) &&
        confirmationExpiry <= 300_000_000_000n
      );
    },
    {
      message:
        "Human recovery confirmation must be current and expires within five minutes",
    }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

const eventCommon = {
  ...common,
  eventId: z.string().regex(/^event-[0-9a-f]{64}$/),
  occurredAt: TimestampSchema,
  receivedAt: TimestampSchema,
  effectiveAt: TimestampSchema,
  correlationId: IdentifierSchema,
  causationId: IdentifierSchema.nullable(),
  actorId: IdentifierSchema,
  moduleId: IdentifierSchema,
  moduleVersion: VersionSchema,
  environment: z.enum(["research", "paper", "live"]),
  idempotencyKey: IdentifierSchema,
};
export const EventEnvelopeSchema = z
  .discriminatedUnion("eventType", [
    z
      .object({
        ...eventCommon,
        eventType: z.literal("dataset.recorded"),
        payload: DatasetManifestSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("research.recorded"),
        payload: ResearchEvidenceSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("knowledge.imported"),
        payload: KnowledgeImportSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("strategy.recorded"),
        payload: StrategySpecSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("backtest.recorded"),
        payload: BacktestRunSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("trade.proposed"),
        payload: TradeIntentSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("risk.evaluated"),
        payload: RiskDecisionSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("execution.observed"),
        payload: ExecutionReceiptSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("agent.recorded"),
        payload: AgentRunSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("module.recorded"),
        payload: ModuleManifestSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("quote.observed"),
        payload: QuoteSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("candle.observed"),
        payload: CandleSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("trade-flow.observed"),
        payload: TradeFlowSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("volume-profile.observed"),
        payload: VolumeProfileSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("broker-status.observed"),
        payload: BrokerRecoveryStatusSchema,
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        eventType: z.literal("recovery.requested"),
        payload: RecoveryRequestSchema,
      })
      .strict(),
  ])
  .refine(
    (value) => {
      if (compareTimes(value.receivedAt, value.occurredAt) < 0) return false;
      if (value.eventType === "trade.proposed")
        return value.environment === value.payload.environment;
      if (
        value.eventType === "execution.observed" ||
        value.eventType === "broker-status.observed" ||
        value.eventType === "recovery.requested"
      ) {
        return value.environment === value.payload.environment;
      }
      return true;
    },
    { message: "Event delivery chronology or environment mismatch" }
  )
  .readonly()
  .transform(freezeValidatedArtifact);

export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
export type GammaProvenance = z.infer<typeof GammaProvenanceSchema>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type Entitlement = z.infer<typeof EntitlementSchema>;
export type MarketDataSource = z.infer<typeof MarketDataSourceSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Candle = z.infer<typeof CandleSchema>;
export type TradeFlow = z.infer<typeof TradeFlowSchema>;
export type VolumeProfileBin = z.infer<typeof VolumeProfileBinSchema>;
export type VolumeProfile = z.infer<typeof VolumeProfileSchema>;
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
export type KnowledgeImport = z.infer<typeof KnowledgeImportSchema>;
export type DataRequirement = z.infer<typeof DataRequirementSchema>;
export type DeterministicRule = z.infer<typeof DeterministicRuleSchema>;
export type CostModel = z.infer<typeof CostModelSchema>;
export type StrategySpec = z.infer<typeof StrategySpecSchema>;
export type TimeWindow = z.infer<typeof TimeWindowSchema>;
export type BacktestRun = z.infer<typeof BacktestRunSchema>;
export type TradeIntent = z.infer<typeof TradeIntentSchema>;
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type BrokerRecoveryStatus = z.infer<typeof BrokerRecoveryStatusSchema>;
export type RecoveryRequest = z.infer<typeof RecoveryRequestSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// receivedAt is consumer-local delivery metadata; every other field, including
// effective/occurred timestamps and producer idempotency key, is immutable.
export const computeEventId = async (input: EventEnvelope): Promise<string> => {
  canonicalArtifactJson(input);
  const {
    eventId: _eventId,
    receivedAt: _receivedAt,
    ...identity
  } = EventEnvelopeSchema.parse(input);
  return `event-${await hashArtifact(identity)}`;
};

export const parseReplayableEventEnvelope = async (
  input: unknown
): Promise<EventEnvelope> => {
  canonicalArtifactJson(input);
  const event = EventEnvelopeSchema.parse(input);
  if (event.eventId !== (await computeEventId(event)))
    throw new TypeError("Event content identity mismatch");
  return event;
};

export const VERTEX_CONTRACT_SCHEMAS = {
  SchemaVersion: SchemaVersionSchema,
  Identifier: IdentifierSchema,
  Digest: DigestSchema,
  Version: VersionSchema,
  Timestamp: TimestampSchema,
  DecimalString: DecimalStringSchema,
  NonnegativeDecimal: NonnegativeDecimalSchema,
  PositiveDecimal: PositiveDecimalSchema,
  SourceIdentity: SourceIdentitySchema,
  GammaProvenance: GammaProvenanceSchema,
  Freshness: FreshnessSchema,
  Entitlement: EntitlementSchema,
  MarketDataSource: MarketDataSourceSchema,
  Quote: QuoteSchema,
  Candle: CandleSchema,
  TradeFlow: TradeFlowSchema,
  VolumeProfileBin: VolumeProfileBinSchema,
  VolumeProfile: VolumeProfileSchema,
  DatasetManifest: DatasetManifestSchema,
  ResearchEvidence: ResearchEvidenceSchema,
  KnowledgeImport: KnowledgeImportSchema,
  DataRequirement: DataRequirementSchema,
  DeterministicRule: DeterministicRuleSchema,
  CostModel: CostModelSchema,
  StrategySpec: StrategySpecSchema,
  TimeWindow: TimeWindowSchema,
  BacktestRun: BacktestRunSchema,
  TradeIntent: TradeIntentSchema,
  RiskDecision: RiskDecisionSchema,
  ExecutionReceipt: ExecutionReceiptSchema,
  AgentRun: AgentRunSchema,
  ModuleStatus: ModuleStatusSchema,
  ModuleManifest: ModuleManifestSchema,
  BrokerRecoveryStatus: BrokerRecoveryStatusSchema,
  RecoveryRequest: RecoveryRequestSchema,
  EventEnvelope: EventEnvelopeSchema,
} as const;

// Plain JSON data only: zod attaches a non-enumerable `~standard` member to
// generated JSON Schema, which artifact canonicalization rightly rejects.
const plainInputJsonSchema = (
  schema: z.ZodType
): z.core.JSONSchema.JSONSchema =>
  JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io: "input" }))
  ) as z.core.JSONSchema.JSONSchema;

export const buildVertexContractDocument = () => ({
  schemaVersion: VERTEX_SCHEMA_VERSION,
  source: "@darkfactory/api/vertex",
  hashProfile: VERTEX_HASH_PROFILE,
  compatibility:
    "Exact schema version only; no implicit coercion, stripping, upgrade or defaults.",
  authorization:
    "Schemas are data validation, never permission. All proposals and risk results deny execution. Human recovery requires authenticated, one-time server-bound challenge verification.",
  hashSemantics:
    "SHA-256 lowercase hex over UTF-8. Structured JSON uses lexicographic Unicode code-point object keys, compact separators, unescaped Unicode and safe integers; decimals are strings. Arrays retain order. Strings hash raw UTF-8; Uint8Array hashes exact original bytes. Original Gamma artifact hashes must be verified against original bytes, not converted Vertex records. Dataset contentHash binds the stored dataset bytes, not the manifest. Hash format validation does not prove artifact integrity.",
  timestampSemantics:
    "Proleptic Gregorian calendar, four-digit astronomical years 0000-9999 (year zero is a leap year). Require YYYY-MM-DDTHH:mm:ss, optional 1-9 fractional digits, then uppercase Z or signed HH:mm offset (hours 00-23, minutes 00-59; either signed zero offset denotes UTC). Reject invalid calendar dates, leap seconds, hour 24, missing seconds and excess precision. Compare exact signed epoch nanoseconds; scale millisecond bounds by 1000000 using integer arithmetic. Offset-equivalent spellings denote equal instants, including before 1970. Preserve original source strings for hashing; never normalize or truncate them.",
  eventIdentity:
    "event- plus SHA-256 of the validated envelope excluding eventId and receivedAt. Producers persist occurredAt/effectiveAt/idempotencyKey; consumers deduplicate eventId and reject idempotency-key reuse with changed content. Use parseReplayableEventEnvelope to reject noncanonical source graphs and verify identity. Parsed event graphs and readonly public artifacts are deeply frozen, including every nested object and array.",
  chartSemantics:
    "Renderer-neutral observations, not orders. Collections may arrive in any order; use explicit IDs/timestamps. Volume bins are half-open and non-overlapping. Never infer aggressor side. Always display synthetic/real, entitlement and freshness labels.",
  refinementPolicy:
    "JSON Schema covers structural validation. runtimeInvariants describe additional source-Zod checks; native adapters must implement them and replay the shared fixtures. JSON Schema alone is not full acceptance. No adapter may authorize trades. Identifier arrays must be unique. Every integer excludes negative zero before hashing. Every string contains only Unicode scalar values. Artifact graphs contain only dense undecorated arrays and plain records with enumerable string data properties; reject cycles, hidden/symbol keys, accessors and unsupported values.",
  runtimeInvariants: {
    Timestamp: [
      "Follow timestampSemantics exactly; lexical JSON Schema alone does not prove Gregorian calendar validity. All temporal ordering, equality and age checks use exact epoch nanoseconds without rewriting source strings.",
    ],
    PositiveDecimal: [
      "Exact fixed-point value is greater than zero; no binary float conversion.",
    ],
    GammaProvenance: [
      "replayManifestId is replay-manifest- plus first 24 lowercase hex characters of manifestHash; original artifact integrity still requires hash verification.",
    ],
    Freshness: [
      "missing requires observedAt=null; fresh/stale require observedAt; age=evaluatedAt-observedAt must be nonnegative; fresh iff age<=maxAgeMs; stale iff age>maxAgeMs; unknown never proves freshness.",
    ],
    Entitlement: [
      "granted requires expiresAt>checkedAt; expired requires nonnull expiresAt<=checkedAt; unknown and denied never prove entitlement.",
    ],
    MarketDataSource: [
      "synthetic requires nonnull syntheticReason; real requires syntheticReason=null.",
    ],
    Quote: [
      "bid<=ask; sourceTimestamp<=receivedAt<=freshness.evaluatedAt; freshness.observedAt and sourceTimestamp denote the same instant.",
    ],
    Candle: [
      "startAtInclusive<endAtExclusive; low<=open<=high and low<=close<=high.",
    ],
    TradeFlow: [
      "sourceTimestamp<=receivedAt; unknown aggressor remains unknown.",
    ],
    VolumeProfileBin: ["lowerPriceInclusive<upperPriceExclusive."],
    VolumeProfile: [
      "startAtInclusive<endAtExclusive; sorting bins by lower boundary must produce disjoint half-open ranges; retain original array order.",
    ],
    DatasetManifest: [
      "startAtInclusive<endAtExclusive<=captureTime; asOfAt<=captureTime; available vintage requires dataVintageId and unavailable requires null.",
    ],
    ResearchEvidence: [
      "sourceIdentity.contentHash=contentHash; publishedAt is null or <=capturedAt; sourceUri is public HTTPS with no userinfo/query/fragment; use canonical public permalinks.",
    ],
    KnowledgeImport: [
      "source IDs, content hashes, unavailable IDs and duplicate mapping source IDs are individually unique; unavailable IDs cannot be present sources; declared content hashes exactly cover sources; both sides of each non-self duplicate mapping exist and have its hash; do not merge equal-content source identities.",
    ],
    CostModel: ["maximumParticipationBps is positive and <=10000."],
    TimeWindow: ["startAtInclusive<endAtExclusive."],
    BacktestRun: [
      "trainingWindow.endAtExclusive<=testWindow.startAtInclusive; leakage check kinds unique; accepted requires resultsRef and all five evidenced passed checks.",
    ],
    TradeIntent: [
      "limitPrice required only for limit/stop-limit; stopPrice required only for stop/stop-limit; applicable prices are positive exact multiples of positive tickSize; quote instrument matches and quoteAsOf/sourceTimestamp denote the same instant; source real/fresh and entitlement granted; quote age at proposedAt within maxAgeMs; freshness.evaluatedAt and entitlement.checkedAt<=proposedAt<entitlement.expiresAt; proposedAt<expiresAt; proposalOnly=true and executionAuthorized=false.",
    ],
    RiskDecision: [
      "research-accepted/paper-eligible require fresh data and nonempty all-passed exposure checks; passed exposure observed nonnull and <=limit; authorizationExpiry=null and both authorization flags false.",
    ],
    ExecutionReceipt: [
      "filled+remaining=total using exact decimals; unknown requires unknown-outcome and all other statuses forbid that error; not-submitted/rejected require zero filled; other observed known statuses require brokerOrderRef; filled requires zero remaining; partially-filled requires both positive; submitted requires zero filled. Observation only.",
    ],
    AgentRun: [
      "completed requires nonempty outputArtifactIds and no errors; token and USD budgets remain separately enforced by the future worker.",
    ],
    BrokerRecoveryStatus: [
      "requested/in-progress/completed recovery requires lastHumanRequestId; infrastructure observation and even authenticated handshake never enable trading.",
    ],
    RecoveryRequest: [
      "confirmedAt<=requestedAt<expiresAt; requestedAt-confirmedAt<=300000ms and expiresAt-confirmedAt<=300000ms; future handler must verify/consume actor-bound challenge, not trust this structural declaration.",
    ],
    EventEnvelope: [
      "receivedAt>=occurredAt; environment matches payload for trade proposals, execution observations, broker status and recovery requests; verify computed content identity separately; array ordering remains hash-significant.",
    ],
  },
  schemas: Object.fromEntries(
    Object.entries(VERTEX_CONTRACT_SCHEMAS).map(([name, schema]) => [
      name,
      plainInputJsonSchema(schema),
    ])
  ),
});
