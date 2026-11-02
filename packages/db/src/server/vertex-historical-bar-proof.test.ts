import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { describe, expect, it } from "vitest";
import { verifyHistoricalBarResult } from "./vertex-historical-bar-proof.ts";
import type { PersistenceContext } from "./vertex-persistence-core.ts";

// Entirely synthetic originals and review labels. This seam reconstructs bytes,
// rational conversions and modeled joins; it cannot authenticate actual reviews,
// qualify data/rights, run rc5, establish SQL isolation or certify native fills.
// No database, native runtime, broker, object store or service is constructed.
const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const hash = (value: unknown) => hashArtifact(encode(value));
const ctx = {
  encode,
  digest: (bytes: Uint8Array) => hashArtifact(bytes),
  hash,
} as PersistenceContext;
const bytesBase64 = (value: unknown) =>
  Buffer.from(encode(value)).toString("base64");
const embedded = async (value: unknown) => ({
  bytesBase64: bytesBase64(value),
  sha256: await hash(value),
});
const epoch = (value: string) => timestampToEpochNanoseconds(value).toString();
const researchClass =
  "limited-retrospective-adjusted-bar-simulation-nonpromotion";
const restrictions = [
  "historical-vintage-unavailable",
  "point-in-time-unavailable",
  "market-coverage-unqualified",
  "survivorship-unqualified",
  "corporate-action-cash-accounting-unavailable",
  "independent-oos-unavailable",
  "modeled-liquidity-not-observed-executable-pnl",
  "retrospective-result-not-promotion-evidence",
];
const assumptions = {
  format: "vertex-rc5-adjusted-bar-round-trip-assumptions-v1",
  barExecution: "rc5-external-LAST-L1_MBP",
  path: "native-O-H-L-C-adaptive-disabled",
  decisionTiming: "on_bar-after-current-bar-path-native-command-drain",
  fill: "native-FOK-market-default-limit-probability-1-slippage-probability-0-seed-0",
  fee: "reviewed-fixed-USD-per-fill-charge-each-fill",
  slippage: "explicit-zero-additional-slippage-not-calibrated",
  volume:
    "rc5-BarTickSizes-quarter-remainder-instrument-increments-liquidity-consumption",
  participation: "reviewed-source-bar-volume-cap-before-FOK-not-path-liquidity",
  latency: "explicit-native-static-zero-base-insert-update-cancel-nanoseconds",
  ledgerPrecision: "whole-adjusted-share-units-USD-cent-native-prices-and-fees",
  shareBasis:
    "fixed-hypothetical-retrieval-adjusted-share-units-no-old-share-cash-accounting",
  adjustments: "provider-retrieval-adjustment-not-PIT-not-total-return",
  coverage: "preserve-nonobserved-gaps-no-completeness-inference",
  revisions: "originals-retained-overlapping-or-reordered-replay-unavailable",
};
const fixture = async (
  openBits = "3ff2000000000000",
  interval = "1m",
  providerWindow: { startNs?: string; endNs?: string } = {}
) => {
  const daily = interval === "1d";
  const dates = daily
    ? ["2026-09-21", "2026-09-22"]
    : ["2026-09-22", "2026-09-22"];
  const starts = daily
    ? [epoch("2026-09-21T12:00:00Z"), epoch("2026-09-22T12:00:00Z")]
    : [epoch("2026-09-22T12:00:00Z"), epoch("2026-09-22T12:02:00Z")];
  const ends = starts.map((value) =>
    (BigInt(value) + (daily ? 21_600_000_000_000n : 60_000_000_000n)).toString()
  );
  // Construct terminal originals BEFORE hashing the capture and every dependent
  // manifest/interpretation/review/model/lineage. Bounds tests must not succeed
  // merely because a mutation left an unrelated stale digest behind.
  const provider_window = {
    start: { unix_ns: providerWindow.startNs ?? starts[0]!, offset_seconds: 0 },
    end: { unix_ns: providerWindow.endNs ?? ends[1]!, offset_seconds: 0 },
  };
  const available = ends.map((value) => (BigInt(value) + 1n).toString());
  const acquired = epoch("2026-09-23T12:00:00Z");
  const plannedAt = "2026-09-23T12:01:00Z";
  const records = starts.map((start, ordinal) => ({
    ordinal,
    provider_timestamp:
      interval === "1m"
        ? {
            kind: "datetime",
            value: { unix_ns: start },
            sdk_decoded_label: `synthetic-minute-${ordinal}`,
          }
        : { kind: "date", value: null, sdk_decoded_label: dates[ordinal] },
    acquired_unix_ns: acquired,
    open_f64_bits: openBits,
    high_f64_bits: "3ff6000000000000",
    low_f64_bits: "3ff0000000000000",
    close_f64_bits: "3ff4000000000000",
    volume_f64_bits: "4004000000000000",
    wap_f64_bits: "3ff4000000000000",
    trade_count: 2,
  }));
  const calendar = {
    format: "vertex-qualified-dated-sessions-v1",
    calendarId: "synthetic-calendar",
    version: "1.0.0",
    timezone: "UTC",
    dateLabelConvention: "session-close-local-date",
    sessions: daily
      ? starts.map((startNs, ordinal) => ({
          sessionDate: dates[ordinal],
          startNs,
          endNs: ends[ordinal],
          sourceLocator: "synthetic-session-not-exchange-evidence",
        }))
      : [
          {
            sessionDate: dates[0],
            startNs: starts[0],
            endNs: epoch("2026-09-22T12:04:00Z"),
            sourceLocator: "synthetic-session-not-exchange-evidence",
          },
        ],
  };
  const capture = {
    format: "synthetic-original-capture",
    provider_window,
    request: {
      kind: {
        bar_size: interval === "1m" ? "1 min" : "1 day",
        what_to_show: "TRADES",
      },
    },
    qualified_contract: {
      decoded_contract: {
        contract_id: 1,
        symbol: "SYNTHETIC",
        currency: "USD",
      },
      semantics: {
        price_magnifier: 1,
        volume_unit: "lots",
        size_unit: "shares",
        timezone: "UTC",
      },
      qualification_capture: {
        sha256: await hash({ synthetic: "qualification" }),
      },
    },
    acquisition: { finished_unix_ns: acquired },
    records,
    limitations: ["synthetic-original-not-market-data"],
  };
  const captureSha256 = await hash(capture);
  const source = {
    provider: "ibkr",
    sourceId: "ibkr-conid-1",
    snapshotId: `ibkr-capture-${captureSha256}`,
    contentHash: captureSha256,
  };
  const content = { format: "vertex-ibkr-historical-bars-v1", source };
  const manifest = {
    contentHash: await hash(content),
    instrumentUniverse: ["ibkr-conid-1"],
    entitlementPolicyId: "synthetic-rights",
  };
  const manifestSha256 = await hash(manifest);
  const requestSha256 = await hash(capture.request);
  const rules = {
    format: "vertex-historical-bar-interpretation-v1",
    instrumentId: "ibkr-conid-1.RESEARCH",
    manifestSha256,
    contentSha256: manifest.contentHash,
    captureSha256,
    requestSha256,
    qualificationSha256:
      capture.qualified_contract.qualification_capture.sha256,
    calendar: await embedded(calendar),
    interval,
    labelConvention: interval === "1m" ? "interval-start" : "dated-session",
    numericTransform: {
      format: "ieee754-exact-rational-half-even-fixed-v1",
      sourcePriceMagnifier: 1,
      sourceVolumeUnit: "lots",
      targetVolumeUnit: "retrieval-adjusted-share-units",
      priceScale: { numerator: "1", denominator: "1" },
      volumeScale: { numerator: "10", denominator: "1" },
      pricePrecision: 2,
      volumePrecision: 0,
    },
    availability: {
      format: "modeled-interval-close-plus-delay-v1",
      delayNs: "1",
    },
    assumptions,
  };
  const interpretation = await embedded(rules);
  const engine = {
    identity: "vertex-nautilus-historical-bar-research",
    version: "1.0.0",
    digest: await hash({ synthetic: "runner-and-strategy-source" }),
  };
  const native = {
    format: "vertex-nautilus-historical-bars-v1",
    issuedNs: acquired,
    expiresNs: epoch("2026-09-24T12:00:00Z"),
    distribution: {
      buildSha256: await hash({ synthetic: "distribution-not-executable" }),
    },
    instrument: {
      id: rules.instrumentId,
      rawSymbol: "SYNTHETIC",
      currency: "USD",
      lotSize: "1",
      pricePrecision: 2,
      priceIncrement: "0.01",
    },
    interpretation,
  };
  const nativeHash = await hash(native);
  const cost = {
    commissionPerUnit: "0.01",
    spreadBps: "0",
    slippageBps: "0",
    borrowAnnualBps: "0",
    impactModel: "participation-capped",
    maximumParticipationBps: "1000",
  };
  const strategy = {
    codeDigest: engine.digest,
    universe: manifest.instrumentUniverse,
    costModel: cost,
    signalSchedule: {
      calendar: calendar.calendarId,
      interval: interval === "1m" ? "bar-close" : "session-close",
    },
    entryRules: [
      {
        ruleId: "historical-entry",
        featureId: "modeled-bar-available-ns",
        operator: "gte",
        threshold: available[0],
        lookbackBars: 1,
      },
    ],
    exitRules: [
      {
        ruleId: "historical-exit",
        featureId: "modeled-bar-available-ns",
        operator: "gte",
        threshold: available[1],
        lookbackBars: 1,
      },
    ],
    requiredData: [
      {
        kind: "candles",
        pointInTimeRequired: false,
        entitlementPolicyId: manifest.entitlementPolicyId,
        maximumAgeMs: 1,
      },
    ],
    riskLimits: {
      maximumPositions: 1,
      maximumNotional: "2",
      maximumLoss: "2.02",
    },
  };
  const strategySha256 = await hash(strategy);
  const planned = {
    strategyVersion: "synthetic-strategy-version",
    engineVersion: engine.version,
    validationMode: "historical",
    forwardSampleCount: 0,
    gammaProvenance: null,
    transactionCosts: cost,
    slippageModel: cost.impactModel,
    testWindow: {
      startAtInclusive: daily ? "2026-09-21T12:00:00Z" : "2026-09-22T12:00:00Z",
      endAtExclusive: daily ? "2026-09-22T18:01:00Z" : "2026-09-22T12:04:00Z",
    },
    leakageChecks: [
      "look-ahead",
      "multiple-testing",
      "overlap",
      "point-in-time",
      "survivorship",
    ].map((kind) => ({ kind, status: "not-run", evidenceId: null })),
  };
  const plannedSha256 = await hash(planned);
  const coreModel = {
    strategy_digest: strategySha256,
    strategy_code_digest: engine.digest,
    assumptions_digest: await hash(assumptions),
    engine_digest: engine.digest,
    instrument_id: rules.instrumentId,
    quantity: "1",
    initial_cash: "100",
    commission_per_fill: "0.01",
    slippage_per_unit: "0",
    enter_not_before_ns: available[0]!,
    exit_not_before_ns: available[1]!,
  };
  const coreHash = await hash({
    format: "vertex-historical-bar-scientific-core-v1",
    ...coreModel,
    nativeConfigurationSha256: nativeHash,
  });
  const required = [
    ...new Set([
      manifestSha256,
      manifest.contentHash,
      captureSha256,
      interpretation.sha256,
      rules.calendar.sha256,
      engine.digest,
      nativeHash,
      coreHash,
    ]),
  ];
  const evidence = await Promise.all(
    required.map(async (contentHash, ordinal) => {
      const original = {
        evidenceId: `synthetic-evidence-${ordinal}`,
        contentHash,
        capturedAt: "2026-09-23T12:00:01Z",
        sourceIdentity: source,
        acceptanceStatus: "unreviewed",
        limitations: ["synthetic-not-review-authority"],
      };
      return { artifactSha256: await hash(original), evidence: original };
    })
  );
  const reviewPins = evidence.map((item, ordinal) => ({
    collectionId: "synthetic-collection",
    evidenceId: item.evidence.evidenceId,
    artifactId: `synthetic-evidence-original-${ordinal}`,
    artifactSha256: item.artifactSha256,
    reviewId: `synthetic-review-label-${ordinal}`,
    reviewVersion: "1.0.0",
    rightsPolicyId: "synthetic-rights",
    rightsVersion: "1.0.0",
  }));
  const capturePin = reviewPins[required.indexOf(captureSha256)]!;
  const model = {
    ...coreModel,
    review_digest: evidence[required.indexOf(coreHash)]!.artifactSha256,
    evidence_template_bytes: bytesBase64({
      synthetic: "not-a-reviewed-template",
    }),
    native_configuration_bytes: bytesBase64(native),
  };
  const recipe = {
    format: "vertex-host-backtest-recipe-v3",
    strategy: {
      artifactId: "synthetic-strategy-version",
      sha256: strategySha256,
    },
    run: { artifactId: "synthetic-run", sha256: plannedSha256 },
    datasets: [
      {
        manifest: { artifactId: "synthetic-manifest", sha256: manifestSha256 },
        content: {
          artifactId: "synthetic-content",
          sha256: manifest.contentHash,
        },
        contentFormat: "vertex-ibkr-historical-bars-v1",
        declaredEvents: records.length,
        collectionId: null,
        reviewPins: [capturePin],
      },
    ],
    evidence: reviewPins.map((pin) => ({
      artifactId: pin.artifactId,
      sha256: pin.artifactSha256,
    })),
    reviewPins,
    model,
    plannedAt,
    publication: {
      actorId: "synthetic-actor",
      collectionId: "synthetic-collection",
      snapshotId: "synthetic-snapshot",
      rightsPolicyId: "synthetic-rights",
      rightsVersion: "1.0.0",
    },
  };
  const lineage = {
    format: "vertex-historical-bar-lineage-inputs-v1",
    researchClass,
    promotionEligible: false,
    reviewPins,
    modelDigest: await hash(model),
    interpretationDigest: interpretation.sha256,
    codePin: {
      identity: "vertex-adjusted-bar-round-trip",
      version: "1.0.0",
      digest: engine.digest,
    },
    enginePin: engine,
    strategyVersionId: planned.strategyVersion,
  };
  const budget = { network_allowed: false, execution_allowed: false };
  const descriptor = {
    pin: engine,
    supported_formats: ["vertex-ibkr-historical-bars-v1"],
    modeled_assumptions: [
      "commission",
      "slippage",
      "bar-path",
      "bar-volume",
      "replay-availability",
      "adjusted-share-basis",
    ],
    simulation_only: true,
  };
  // Expected fractions are hand-authored, not calculated with the implementation
  // under test: 1.125=9/8 ties down, 1.375=11/8 ties up, 2.5 lots*10=25.
  const value = (
    sourceF64Bits: string,
    modeledDecimal: string,
    numerator: string,
    denominator: string,
    roundingChanged: boolean
  ) => ({
    sourceF64Bits,
    modeledDecimal,
    scaledExactNumerator: numerator,
    scaledExactDenominator: denominator,
    roundingChanged,
  });
  const modeledBars = await Promise.all(
    records.map(async (original, ordinal) => ({
      ordinal,
      sourceRowSha256: await hash(original),
      captureSha256,
      providerTimestamp: original.provider_timestamp,
      acquiredNs: acquired,
      qualifiedStartNs: starts[ordinal],
      qualifiedEndNs: ends[ordinal],
      modeledAvailableNs: available[ordinal],
      sessionDate: dates[ordinal],
      values: {
        open: value(openBits, "1.12", "9", "8", true),
        high: value(original.high_f64_bits, "1.38", "11", "8", true),
        low: value(original.low_f64_bits, "1.00", "1", "1", false),
        close: value(original.close_f64_bits, "1.25", "5", "4", false),
        volume: value(original.volume_f64_bits, "25", "25", "1", false),
      },
      originalWapF64Bits: original.wap_f64_bits,
      originalTradeCount: original.trade_count,
      availabilityIsObserved: false,
    }))
  );
  const qualification = {
    interpretationSha256: interpretation.sha256,
    calendarSha256: rules.calendar.sha256,
    adjustment: "split-adjusted-not-dividend-adjusted",
    sourceTimezoneLabel: "UTC",
    qualifiedTimezone: "UTC",
    gaps: [
      {
        afterOrdinal: 0,
        startNs: ends[0],
        endNs: starts[1],
        classification: "nonobserved-time-not-certified-missing-bars",
      },
    ],
    originalLimitations: capture.limitations,
    marketCoverage: "unqualified",
    historicalVintage: "unavailable",
    sourceResponseComplete: true,
    captureComplete: true,
  };
  const decisions = modeledBars.map((row, index) => ({
    ordinal: row.ordinal,
    clientOrderId: index === 0 ? "VERTEX-ENTRY" : "VERTEX-EXIT",
    barEventId: `bar-${row.ordinal}-${row.sourceRowSha256}`,
    sourceRowSha256: row.sourceRowSha256,
    modeledDecisionNs: row.modeledAvailableNs,
    timing: assumptions.decisionTiming,
    side: index === 0 ? "buy" : "sell",
    quantity: model.quantity,
    shareBasis: assumptions.shareBasis,
  }));
  const simulatedFills = modeledBars.map((row, index) => ({
    ordinal: row.ordinal,
    clientOrderId: decisions[index]!.clientOrderId,
    barEventId: decisions[index]!.barEventId,
    sourceRowSha256: row.sourceRowSha256,
    modeledFillEventNs: row.modeledAvailableNs,
    sourceAcquiredNs: row.acquiredNs,
    sourceProviderTimestamp: row.providerTimestamp,
    sourceObservation: false,
    shareBasis: assumptions.shareBasis,
    side: decisions[index]!.side,
    quantity: "1",
    commission: "0.01",
    currency: "USD",
    nativeFillInitNs: row.modeledAvailableNs,
    tradeId: `synthetic-trade-${index}`,
    price: index === 0 ? "1.12" : "1.38",
  }));
  const economics = {
    format: "vertex-nautilus-historical-bar-economics-v1",
    researchClass,
    metricScope: "limited-retrospective",
    promotionEligible: false,
    pointInTime: false,
    executionAuthorized: false,
    model: engine.identity,
    modelVersion: engine.version,
    reviewDigest: model.review_digest,
    scientificCoreSha256: coreHash,
    nativeConfigurationSha256: nativeHash,
    distributionBuildSha256: native.distribution.buildSha256,
    runnerSha256: engine.digest,
    assumptions,
    modeledBars,
    sourceQualification: qualification,
    decisions,
    simulatedFills,
    closedRoundTrip: true,
    nativeResult: {
      iterations: "2",
      totalOrders: "2",
      totalPositions: "1",
      modeledLedgerEndingBalance: "100.24",
    },
    metrics: {
      "modeled-adjusted-unit-gross-pnl": "0.26",
      "modeled-adjusted-unit-net-pnl": "0.24",
      "modeled-total-commission": "0.02",
    },
  };
  const lineageDigest = await hash({
    format: "vertex-historical-bar-lineage-v1",
    researchClass,
    strategyDigest: strategySha256,
    runDigest: plannedSha256,
    datasetManifestDigests: [manifestSha256],
    evidenceDigests: evidence.map((item) => item.artifactSha256),
    lineage,
    budget,
    engineDescriptor: descriptor,
    originalCaptureSha256: captureSha256,
    qualification,
    plannedAt,
    promotionEligible: false,
    executionAuthorized: false,
  });
  const result = {
    format: "vertex-historical-bar-results-v1",
    researchClass,
    economicsOrigin: "native-retrospective-adjusted-bar-simulation",
    promotionEligible: false,
    pointInTimeEnforced: false,
    dataComplete: false,
    executionAuthorized: false,
    forwardAssessment: null,
    restrictions: [...restrictions],
    strategyDigest: strategySha256,
    enginePin: engine,
    datasetContentDigests: [manifest.contentHash],
    assumptionDigest: model.assumptions_digest,
    economics,
    lineageDigest,
    economicsSimulated: true,
    incidentCodes: [...restrictions],
    evidenceDigests: evidence.map((item) => item.artifactSha256),
    sandbox: { synthetic: "no-process-or-containment-claim" },
  };
  return {
    recipe: { ...recipe, lineage, budget, descriptor },
    lineage,
    budget,
    descriptor,
    result,
    planned,
    plannedSha256,
    strategy,
    strategySha256,
    admittedAt: "2026-09-23T12:02:00Z",
    dataset: {
      manifest,
      manifestSha256,
      content,
      capture,
      captureSha256,
      requestSha256,
    },
    evidence,
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Mutation {
  change: (input: Fixture) => void;
  label: string;
}
const mutations: Mutation[] = [
  {
    label: "half-even tie changed to half-up",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.values.open.modeledDecimal =
        "1.13");
    },
  },
  {
    label: "rounded decimal substituted for exact binary rational",
    change: (f) => {
      f.result.economics.modeledBars[0]!.values.open.scaledExactNumerator =
        "112";
      return (f.result.economics
        .modeledBars[0]!.values.open.scaledExactDenominator = "100");
    },
  },
  {
    label: "unrecorded rounding residual",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.values.high.roundingChanged =
        false);
    },
  },
  {
    label: "lots confused with adjusted shares",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.values.volume.modeledDecimal =
        "2.5");
    },
  },
  {
    label: "source row digest replaced",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.sourceRowSha256 = "0".repeat(
        64
      ));
    },
  },
  {
    label: "acquisition confused with modeled availability",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.acquiredNs =
        f.result.economics.modeledBars[0]!.modeledAvailableNs!);
    },
  },
  {
    label: "nanosecond delay erased",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.modeledAvailableNs =
        f.result.economics.modeledBars[0]!.qualifiedEndNs);
    },
  },
  {
    label: "modeled availability claimed observed",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.availabilityIsObserved = true);
    },
  },
  {
    label: "original WAP discarded",
    change: (f) => {
      return (f.result.economics.modeledBars[0]!.originalWapF64Bits =
        "0000000000000000");
    },
  },
  {
    label: "nonobserved gap hidden",
    change: (f) => {
      return (f.result.economics.sourceQualification.gaps = []);
    },
  },
  {
    label: "capture qualification relabeled complete market coverage",
    change: (f) => {
      return (f.result.economics.sourceQualification.marketCoverage =
        "complete");
    },
  },
  {
    label: "promoted result",
    change: (f) => {
      return (f.result.promotionEligible = true);
    },
  },
  {
    label: "point-in-time result",
    change: (f) => {
      return (f.result.pointInTimeEnforced = true);
    },
  },
  {
    label: "complete dataset result",
    change: (f) => {
      return (f.result.dataComplete = true);
    },
  },
  {
    label: "execution-authorized result",
    change: (f) => {
      return (f.result.executionAuthorized = true);
    },
  },
  {
    label: "promoted economics",
    change: (f) => {
      return (f.result.economics.promotionEligible = true);
    },
  },
  {
    label: "point-in-time economics",
    change: (f) => {
      return (f.result.economics.pointInTime = true);
    },
  },
  {
    label: "leakage check claimed passed",
    change: (f) => {
      return (f.planned.leakageChecks[0]!.status = "passed");
    },
  },
  {
    label: "network-enabled budget",
    change: (f) => {
      return (f.budget.network_allowed = true);
    },
  },
  {
    label: "wildcard descriptor",
    change: (f) => {
      return (f.descriptor.supported_formats = ["*"]);
    },
  },
  {
    label: "altered native runner",
    change: (f) => {
      return (f.result.economics.runnerSha256 = "0".repeat(64));
    },
  },
  {
    label: "unbound lineage digest",
    change: (f) => {
      return (f.result.lineageDigest = "0".repeat(64));
    },
  },
  {
    label: "round-trip flag contradicts fills",
    change: (f) => {
      return (f.result.economics.closedRoundTrip = false);
    },
  },
  {
    label: "native iteration count contradicts retained rows",
    change: (f) => {
      return (f.result.economics.nativeResult.iterations = "3");
    },
  },
  {
    label: "planning after admission",
    change: (f) => {
      return (f.admittedAt = "2026-09-23T12:00:59Z");
    },
  },
  {
    label: "source acquisition ends before the bar",
    change: (f) => {
      return (f.dataset.capture.acquisition.finished_unix_ns = epoch(
        "2026-09-22T12:00:59Z"
      ));
    },
  },
  {
    label: "decision time separated from source bar",
    change: (f) => {
      return (f.result.economics.decisions[0]!.modeledDecisionNs = "1");
    },
  },
  {
    label: "fill acquisition time forged",
    change: (f) => {
      return (f.result.economics.simulatedFills[0]!.sourceAcquiredNs = "1");
    },
  },
  {
    label: "fill claimed observed",
    change: (f) => {
      return (f.result.economics.simulatedFills[0]!.sourceObservation = true);
    },
  },
  {
    label: "duplicate native trade identity",
    change: (f) => {
      return (f.result.economics.simulatedFills[1]!.tradeId =
        f.result.economics.simulatedFills[0]!.tradeId);
    },
  },
  {
    label: "commission omitted",
    change: (f) => {
      return (f.result.economics.simulatedFills[0]!.commission = "0");
    },
  },
  {
    label: "gross PnL rounded incorrectly",
    change: (f) => {
      return (f.result.economics.metrics["modeled-adjusted-unit-gross-pnl"] =
        "0.25");
    },
  },
  {
    label: "net PnL excludes fees",
    change: (f) => {
      return (f.result.economics.metrics["modeled-adjusted-unit-net-pnl"] =
        "0.26");
    },
  },
  {
    label: "ledger does not reconcile",
    change: (f) => {
      return (f.result.economics.nativeResult.modeledLedgerEndingBalance =
        "100.25");
    },
  },
];

describe("offline synthetic historical-Bar v3 reconstruction", () => {
  it("reconstructs hand-authored binary64 fractions, preserved clocks, gaps and a cent-exact modeled ledger", async () => {
    const input = await fixture();
    await expect(verifyHistoricalBarResult(ctx, input)).resolves.toMatchObject({
      availability: "available",
      closedRoundTrip: true,
      metrics: input.result.economics.metrics,
    });
    expect(Object.keys(ctx).sort()).toEqual(["digest", "encode", "hash"]);
    expect(input.result.economics.modeledBars[0]!.values.open).toMatchObject({
      modeledDecimal: "1.12",
      scaledExactNumerator: "9",
      scaledExactDenominator: "8",
      roundingChanged: true,
    });
    expect(
      input.result.economics.modeledBars[0]!.values.high.modeledDecimal
    ).toBe("1.38");
    expect(
      input.result.economics.modeledBars[0]!.values.volume.modeledDecimal
    ).toBe("25");
    return expect(input.result).toMatchObject({
      promotionEligible: false,
      pointInTimeEnforced: false,
      dataComplete: false,
      executionAuthorized: false,
    });
  });
  it("returns only fully qualified original modeled decimal strings after reconstruction", async () => {
    const input = await fixture();
    input.result.economics.metrics = {
      "modeled-adjusted-unit-gross-pnl": "0.2600",
      "modeled-adjusted-unit-net-pnl": "0.240000",
      "modeled-total-commission": "0.020",
    };
    const outcome = await verifyHistoricalBarResult(ctx, input);
    expect(outcome).toEqual({
      availability: "available",
      closedRoundTrip: true,
      currency: "USD",
      metricScope: "limited-retrospective",
      researchClass,
      shareBasis: assumptions.shareBasis,
      promotionEligible: false,
      pointInTimeEnforced: false,
      dataComplete: false,
      restrictions,
      metrics: {
        "modeled-adjusted-unit-gross-pnl": "0.2600",
        "modeled-adjusted-unit-net-pnl": "0.240000",
        "modeled-total-commission": "0.020",
      },
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.restrictions)).toBe(true);
    if (outcome.availability !== "available")
      throw new Error("expected reconstructed closed round trip");
    expect(Object.isFrozen(outcome.metrics)).toBe(true);
    input.result.economics.metrics["modeled-adjusted-unit-net-pnl"] = "999";
    input.result.restrictions.pop();
    expect(outcome.metrics["modeled-adjusted-unit-net-pnl"]).toBe("0.240000");
    return expect(outcome.restrictions).toEqual(restrictions);
  });
  it("returns qualified unavailability without fabricated zero metrics for an unclosed round trip", async () => {
    const input = await fixture();
    input.result.economics.simulatedFills = [];
    input.result.economics.decisions = [];
    input.result.economics.closedRoundTrip = false;
    input.result.economics.nativeResult.totalOrders = "0";
    input.result.economics.nativeResult.totalPositions = "0";
    input.result.economics.nativeResult.modeledLedgerEndingBalance = "100";
    Object.assign(input.result.economics, { metrics: {} });
    input.result.economicsSimulated = false;
    input.result.incidentCodes = [
      ...restrictions,
      "historical-native-round-trip-unfilled",
    ];
    await expect(verifyHistoricalBarResult(ctx, input)).resolves.toEqual({
      availability: "unavailable",
      reason: "round-trip-not-closed",
      closedRoundTrip: false,
      currency: "USD",
      metricScope: "limited-retrospective",
      researchClass,
      shareBasis: assumptions.shareBasis,
      promotionEligible: false,
      pointInTimeEnforced: false,
      dataComplete: false,
      restrictions,
    });
    Object.assign(input.result.economics, {
      metrics: { "modeled-adjusted-unit-net-pnl": "0" },
    });
    return await expect(
      verifyHistoricalBarResult(ctx, input)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it.each(mutations)("rejects $label", async ({ change }) => {
    const input = await fixture();
    change(input);
    return await expect(
      verifyHistoricalBarResult(ctx, input)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it.each([
    "bff2000000000000",
    "7ff0000000000000",
    "7ff8000000000000",
    "0000000000000000",
    "0000000000000001",
    "3FF2000000000000",
  ])(
    "rejects unsupported original price bits %s through the exported proof seam",
    async (bits) => {
      return await expect(
        verifyHistoricalBarResult(ctx, await fixture(bits))
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  it("denies missing coverage rather than treating synthetic review labels as authority", async () => {
    const input = await fixture();
    input.evidence.pop();
    await expect(verifyHistoricalBarResult(ctx, input)).rejects.toMatchObject({
      code: "denied",
    });
    const noPins = await fixture();
    noPins.recipe.reviewPins = [];
    return await expect(
      verifyHistoricalBarResult(ctx, noPins)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("denies review originals captured after planning", async () => {
    const input = await fixture();
    input.evidence[0]!.evidence.capturedAt = "2026-09-23T12:01:00.000001Z";
    return await expect(
      verifyHistoricalBarResult(ctx, input)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects capture review source identity substitution", async () => {
    const input = await fixture();
    const capture = input.evidence.find(
      (item) => item.evidence.contentHash === input.dataset.captureSha256
    )!;
    capture.evidence.sourceIdentity = {
      ...capture.evidence.sourceIdentity,
      snapshotId: "foreign-synthetic-snapshot",
    };
    return await expect(
      verifyHistoricalBarResult(ctx, input)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("reconstructs synthetic daily sessions wholly contained in the original terminal window", async () => {
    return await expect(
      verifyHistoricalBarResult(ctx, await fixture("3ff2000000000000", "1d"))
    ).resolves.toMatchObject({
      availability: "available",
      closedRoundTrip: true,
    });
  });
  it("rejects daily labels without matching reconstructed session clocks", async () => {
    const input = await fixture("3ff2000000000000", "1d");
    input.result.economics.modeledBars[0]!.qualifiedEndNs = epoch(
      "2026-09-21T12:01:00Z"
    );
    return await expect(
      verifyHistoricalBarResult(ctx, input)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it.each([
    {
      label: "minute start before terminal start",
      interval: "1m",
      window: { startNs: epoch("2026-09-22T12:00:00.000000001Z") },
    },
    {
      label: "minute end after terminal end",
      interval: "1m",
      window: { endNs: epoch("2026-09-22T12:02:59.999999999Z") },
    },
    {
      label: "daily session start before terminal start",
      interval: "1d",
      window: { startNs: epoch("2026-09-21T12:00:00.000000001Z") },
    },
    {
      label: "daily session end after terminal end",
      interval: "1d",
      window: { endNs: epoch("2026-09-22T17:59:59.999999999Z") },
    },
  ])(
    "rejects $label even with consistently resealed original provenance",
    async ({ interval, window }) => {
      const input = await fixture("3ff2000000000000", interval, window);
      expect(input.dataset.captureSha256).toBe(
        await hash(input.dataset.capture)
      );
      expect(input.dataset.manifestSha256).toBe(
        await hash(input.dataset.manifest)
      );
      expect(input.dataset.manifest.contentHash).toBe(
        await hash(input.dataset.content)
      );
      expect(input.lineage.modelDigest).toBe(await hash(input.recipe.model));
      return await expect(
        verifyHistoricalBarResult(ctx, input)
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  return it("rejects noncanonical and hash-mismatched embedded originals", async () => {
    const noncanonical = await fixture();
    const original = Buffer.from(
      noncanonical.recipe.model.native_configuration_bytes,
      "base64"
    ).toString("utf8");
    noncanonical.recipe.model.native_configuration_bytes = Buffer.from(
      ` ${original}`
    ).toString("base64");
    await expect(
      verifyHistoricalBarResult(ctx, noncanonical)
    ).rejects.toMatchObject({ code: "integrity" });
    const mismatched = await fixture();
    const native = JSON.parse(
      Buffer.from(
        mismatched.recipe.model.native_configuration_bytes,
        "base64"
      ).toString("utf8")
    );
    native.interpretation.sha256 = "0".repeat(64);
    mismatched.recipe.model.native_configuration_bytes = bytesBase64(native);
    return await expect(
      verifyHistoricalBarResult(ctx, mismatched)
    ).rejects.toMatchObject({ code: "integrity" });
  });
});
