import {
  canonicalArtifactJson,
  hashArtifact,
  RECOVERY_CONFIRMATION,
} from "../../packages/shared/src/vertex/index.ts";
import { computeEventId } from "../../packages/api/src/contracts/vertex.ts";
import type { EventEnvelope } from "../../packages/api/src/contracts/vertex.ts";
import {
  computeExecutionProjectionHash,
  computePortfolioGenesisHash,
} from "../../packages/api/src/contracts/vertex-control.ts";
import type {
  ExecutionProjection,
  PortfolioSnapshot,
} from "../../packages/api/src/contracts/vertex-control.ts";
import { buildNativeFactsFixtures } from "./native-facts-fixtures.ts";
import {
  buildWorkerByteCapacityFixtures,
  buildWorkerFixtures,
} from "./worker-fixtures.ts";
import { buildPolicyFixtures } from "./policy-fixtures.ts";
import {
  buildModelEpochCapacityFixtures,
  buildModelEpochFixtures,
} from "./model-epoch-fixtures.ts";

export interface ContractFixture {
  name: string;
  contract: string;
  payload: unknown;
  valid: boolean;
}
export interface NativeContractFixtures {
  fixtureFormat: "vertex-native-contract-fixtures-v1";
  schemaVersion: "1.0.0";
  cases: ContractFixture[];
  rawByteReject: { name: string; hex: string }[];
  codec: {
    name: string;
    value: unknown;
    canonicalUtf8: string;
    sha256: string;
  }[];
  timestamps: { timestamp: string; epochNanoseconds: string | null }[];
}

// Entirely synthetic, offline, nonexecutable observations. This module performs
// no generation on import. The explicit function may be exported by the parent
// fixture runner later; no fixture bundle has been produced during authoring.
export const buildNativeContractFixtures =
  async (): Promise<NativeContractFixtures> => {
    const hash = "a".repeat(64);
    const zeroHash = "0".repeat(64);
    const t = "2026-09-22T12:00:00.000000001Z";
    const received = "2026-09-22T12:00:00.000000002Z";
    const evaluated = "2026-09-22T12:00:00.000000003Z";
    const later = "2026-09-22T12:00:01Z";
    const expires = "2026-09-22T12:01:00Z";
    const before = "2026-09-22T11:59:00Z";
    const schemaVersion = "1.0.0";
    const identity = {
      provider: "synthetic-provider",
      sourceId: "source-1",
      snapshotId: "snapshot-1",
      contentHash: hash,
    };
    const gamma = {
      schemaVersion,
      replaySchemaVersion: 2,
      sourceTradeRunId: "gamma-run",
      replayManifestId: `replay-manifest-${hash.slice(0, 24)}`,
      manifestHash: hash,
      inputHash: hash,
      outputHash: hash,
    };
    const freshness = {
      status: "fresh",
      observedAt: t,
      evaluatedAt: evaluated,
      maxAgeMs: 1000,
    };
    const entitlement = {
      policyId: "synthetic-rights",
      status: "granted",
      checkedAt: before,
      expiresAt: expires,
    };
    const source = {
      identity,
      dataKind: "real",
      syntheticReason: null,
      providerTimezone: "UTC",
      entitlement,
      freshness,
    };
    const market = {
      schemaVersion,
      instrumentId: "synthetic-equity",
      currency: "USD",
      source,
    };
    const quote = {
      ...market,
      quoteId: "quote-1",
      bid: "9",
      ask: "10",
      bidSize: "2",
      askSize: "3",
      lastPrice: null,
      sourceTimestamp: t,
      receivedAt: received,
    };
    const window = { startAtInclusive: before, endAtExclusive: t };
    const candle = {
      ...market,
      ...window,
      candleId: "candle-1",
      interval: "1m",
      open: "9",
      high: "11",
      low: "8",
      close: "10",
      volume: "10",
    };
    const flow = {
      ...market,
      flowId: "flow-1",
      sourceTimestamp: t,
      receivedAt: received,
      price: "10",
      quantity: "1",
      aggressor: "unknown",
    };
    const bin = {
      lowerPriceInclusive: "9",
      upperPriceExclusive: "10",
      buyVolume: "1",
      sellVolume: "2",
      unknownVolume: "0",
    };
    const profile = {
      ...market,
      ...window,
      profileId: "profile-1",
      bins: [bin],
    };
    const dataset = {
      schemaVersion,
      datasetId: "dataset-1",
      provider: "synthetic-provider",
      entitlementPolicyId: "synthetic-rights",
      instrumentUniverse: ["synthetic-equity"],
      ...window,
      captureTime: later,
      dataVintageId: "vintage-1",
      dataVintageStatus: "available",
      asOfAt: t,
      adjustmentMethod: "unadjusted",
      calendar: "XNYS",
      contentHash: hash,
      storageRef: "storage-1",
      retentionPolicy: "retention-1",
      sources: [identity],
      gammaProvenance: gamma,
    };
    const evidence = {
      schemaVersion,
      evidenceId: "evidence-1",
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      sourceType: "paper",
      sourceUri: "https://example.invalid/paper",
      sourceIdentity: identity,
      sourceLocator: "page-1",
      attribution: "Synthetic author",
      publishedAt: before,
      capturedAt: t,
      contentHash: hash,
      claim: "Synthetic claim",
      method: "Synthetic method",
      limitations: [],
      acceptanceStatus: "unreviewed",
      rightsPolicyId: "synthetic-rights",
      untrustedContent: true,
    };
    const knowledge = {
      schemaVersion,
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      sourceIdentities: [identity, { ...identity, sourceId: "source-2" }],
      contentHashes: [hash],
      duplicateMappings: [
        {
          sourceId: "source-2",
          canonicalSourceId: "source-1",
          contentHash: hash,
        },
      ],
      unavailableSources: [{ sourceId: "unavailable-1", reason: "not-found" }],
      transcriptQuality: "not-applicable",
      retrievalScope: "collection-only",
      rightsPolicyId: "synthetic-rights",
      replacementScope: "collection-snapshot",
      contentClass: "paper",
      untrustedContent: true,
    };
    const requirement = {
      kind: "quotes",
      maximumAgeMs: 1000,
      pointInTimeRequired: true,
      entitlementPolicyId: "synthetic-rights",
    };
    const rule = {
      ruleId: "rule-1",
      featureId: "feature-1",
      operator: "gt",
      threshold: "0",
      lookbackBars: 1,
    };
    const costs = {
      commissionPerUnit: "0",
      spreadBps: "1",
      slippageBps: "1",
      borrowAnnualBps: "0",
      impactModel: "fixed-bps",
      maximumParticipationBps: "10000",
    };
    const strategy = {
      schemaVersion,
      strategyId: "strategy-1",
      version: "1.0.0",
      sleeve: "quant",
      hypothesis: "Synthetic hypothesis",
      universe: ["synthetic-equity"],
      signalSchedule: {
        calendar: "XNYS",
        timezone: "UTC",
        interval: "bar-close",
      },
      entryRules: [rule],
      exitRules: [{ ...rule, ruleId: "rule-2" }],
      riskLimits: {
        maximumLoss: "1",
        maximumNotional: "10",
        maximumPositions: 1,
      },
      requiredData: [requirement],
      costModel: costs,
      codeDigest: hash,
    };
    const backtest = {
      schemaVersion,
      runId: "backtest-1",
      strategyVersion: "strategy-1.0.0",
      datasetManifestIds: ["dataset-1"],
      seed: 1,
      engineVersion: "1.0.0",
      trainingWindow: window,
      testWindow: { startAtInclusive: t, endAtExclusive: expires },
      benchmark: "synthetic-benchmark",
      transactionCosts: costs,
      slippageModel: "fixed-bps",
      resultsRef: "results-1",
      leakageChecks: [
        "look-ahead",
        "survivorship",
        "point-in-time",
        "overlap",
        "multiple-testing",
      ].map((kind) => ({ kind, status: "passed", evidenceId: "evidence-1" })),
      reviewStatus: "accepted",
      validationMode: "historical",
      forwardSampleCount: 0,
      gammaProvenance: gamma,
    };
    const intent = {
      schemaVersion,
      intentId: "intent-1",
      idempotencyKey: "intent-key",
      correlationId: "correlation-1",
      proposalOnly: true,
      executionAuthorized: false,
      strategyVersion: "strategy-1.0.0",
      accountAlias: "synthetic-paper",
      environment: "paper",
      instrumentId: "synthetic-equity",
      side: "buy",
      quantity: "1",
      orderType: "limit",
      limitPrice: "10",
      stopPrice: null,
      tickSize: "0.01",
      timeInForce: "DAY",
      quoteAsOf: t,
      referenceQuote: quote,
      proposedAt: evaluated,
      reasonEvidenceIds: ["evidence-1"],
      maxLossBudget: "1",
      expiresAt: expires,
    };
    const risk = {
      schemaVersion,
      intentId: "intent-1",
      policyVersion: "1.0.0",
      portfolioSnapshotId: "portfolio-1",
      freshnessCheck: freshness,
      cashReservationId: null,
      exposureChecks: [
        { checkId: "check-1", status: "passed", observed: "1", limit: "2" },
      ],
      decision: "paper-eligible",
      reasonCodes: ["synthetic-checks"],
      authorizationExpiry: null,
      liveAuthorization: false,
      executionAuthorized: false,
    };
    const receipt = {
      schemaVersion,
      intentId: "intent-1",
      submissionKey: "submission-1",
      brokerOrderRef: null,
      environment: "paper",
      observationOnly: true,
      status: "unknown",
      totalQuantity: "3",
      filledQuantity: "1",
      remainingQuantity: "2",
      lastReconciledAt: received,
      errorClass: "unknown-outcome",
      auditEventIds: ["audit-1"],
    };
    const agent = {
      schemaVersion,
      runId: "agent-1",
      agentRole: "research",
      taskContract: "research-task",
      allowedTools: ["read-evidence"],
      modelVersion: null,
      inputEvidenceIds: ["evidence-1"],
      outputArtifactIds: ["artifact-1"],
      tokenBudget: 100,
      costBudgetUsd: "1",
      status: "completed",
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    };
    const module = {
      schemaVersion,
      moduleId: "module-1",
      version: "1.0.0",
      inputSchemaVersion: schemaVersion,
      outputSchemaVersion: schemaVersion,
      capabilities: ["research"],
      dataRequirements: [requirement],
      supportedInstruments: ["equity"],
      riskPolicyVersion: "1.0.0",
      artifactDigest: hash,
      lifecycleState: "active-read-only",
      runtime: "python-external",
      reasonCodes: [],
    };
    const broker = {
      schemaVersion,
      statusId: "status-1",
      gatewayId: "gateway-1",
      environment: "paper",
      observedAt: t,
      infrastructure: "observed",
      brokerHandshake: "unknown",
      recovery: "disabled",
      trading: "disabled",
      reasonCodes: ["synthetic-observation"],
      lastHumanRequestId: null,
    };
    const recovery = {
      schemaVersion,
      requestId: "request-1",
      idempotencyKey: "recovery-key",
      correlationId: "correlation-1",
      gatewayId: "gateway-1",
      expectedStatusId: "status-1",
      environment: "paper",
      action: "request-human-recovery",
      requestedAt: received,
      expiresAt: expires,
      executionAuthorized: false,
      confirmation: {
        kind: "human",
        actorId: "synthetic-reviewer",
        challengeId: "challenge-1",
        confirmedAt: t,
        statement: RECOVERY_CONFIRMATION,
      },
    };
    const scope = {
      accountAlias: "synthetic-paper",
      environment: "paper",
      streamId: "stream-1",
      ownerEpoch: "1",
    };
    const continuity = {
      ...scope,
      highWaterSequence: "1",
      highWaterEventHash: hash,
      lastOccurredAt: t,
      lastReceivedAt: received,
      evaluatedAt: evaluated,
      freshness,
      state: "continuous",
      expectedNextSequence: "2",
      receivedSequence: null,
      newRiskInhibited: true,
      authoritative: false,
    };
    const portfolio = {
      schemaVersion,
      snapshotId: "portfolio-1",
      ...scope,
      sequence: "1",
      sourceEventHash: hash,
      sourceKind: "paper-simulation",
      asOfAt: t,
      receivedAt: received,
      currency: "USD",
      cash: "10",
      netAssetValue: "20",
      positions: [
        {
          instrumentId: "synthetic-equity",
          quantity: "1",
          marketValue: "10",
          costBasis: "9",
          currency: "USD",
          priceAsOf: t,
          sleeveId: "sleeve-1",
        },
      ],
      lots: [
        {
          lotId: "lot-1",
          instrumentId: "synthetic-equity",
          quantity: "1",
          unitCost: "9",
          currency: "USD",
          openedAt: t,
          sourceEventId: "source-event",
        },
      ],
      reservations: [
        {
          reservationId: "reservation-1",
          submissionKey: "submission-1",
          instrumentId: null,
          cashAmount: "1",
          shareQuantity: "0",
          currency: "USD",
          state: "reserved",
          sourceEventId: "source-event",
          authoritative: false,
        },
      ],
      sleeveAllocations: [
        {
          sleeveId: "sleeve-1",
          allocatedAmount: "10",
          currency: "USD",
          sourceEventId: "source-event",
          authoritative: false,
        },
      ],
      continuity,
      observationOnly: true,
      executionAuthorized: false,
      researchNotionalIncluded: false,
    };
    const review = {
      schemaVersion,
      reviewId: "review-1",
      accountAlias: scope.accountAlias,
      environment: "paper",
      collectionId: null,
      artifactId: "intent-1",
      artifactSha256: hash,
      reviewVersion: "1.0.0",
      decision: "accepted",
      purpose: "paper-simulation",
      actorId: "synthetic-reviewer",
      reviewedAt: t,
      expiresAt: expires,
      policyVersion: "1.0.0",
      strategyVersion: "strategy-1.0.0",
      supersedesReviewId: null,
      executionAuthorized: false,
    };
    const admission = {
      schemaVersion,
      admissionId: "admission-1",
      admissionKind: "PAPER-SIMULATION",
      ...scope,
      simulatorId: "synthetic-simulator",
      intentId: "intent-1",
      intentSha256: hash,
      reviewedArtifactSha256: hash,
      reviewId: "review-1",
      reviewVersion: "1.0.0",
      actorId: "synthetic-reviewer",
      policyVersion: "1.0.0",
      strategyVersion: "strategy-1.0.0",
      portfolioSnapshotId: "portfolio-1",
      portfolioSequence: "1",
      maximumLoss: "1",
      maximumNotional: "10",
      admittedAt: t,
      expiresAt: expires,
      idempotencyKey: "admission-key",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
      executionAuthorized: false,
    };
    const projection = {
      schemaVersion,
      projectionId: "projection-1",
      ...scope,
      sequence: "1",
      previousEventHash: null,
      eventHash: zeroHash,
      occurredAt: t,
      receivedAt: received,
      actorId: "synthetic-reviewer",
      policyVersion: "1.0.0",
      strategyVersion: "strategy-1.0.0",
      reviewedArtifactSha256: hash,
      admissionId: "admission-1",
      expiresAt: expires,
      idempotencyKey: "projection-key",
      sourceKind: "paper-simulation",
      receipt,
      authoritative: false,
      reservationAuthority: "native-owner-only",
    };
    projection.eventHash = await computeExecutionProjectionHash(
      projection as ExecutionProjection
    );
    const event = {
      schemaVersion,
      eventId: `event-${zeroHash}`,
      occurredAt: t,
      receivedAt: received,
      effectiveAt: t,
      correlationId: "correlation-1",
      causationId: null,
      actorId: "synthetic-reviewer",
      moduleId: "module-1",
      moduleVersion: "1.0.0",
      environment: "paper",
      idempotencyKey: "event-key",
      eventType: "quote.observed",
      payload: quote,
    };
    event.eventId = await computeEventId(event as EventEnvelope);
    const genesis = structuredClone(portfolio);
    const genesisHash = await computePortfolioGenesisHash(
      genesis as PortfolioSnapshot
    );
    genesis.sourceEventHash = genesisHash;
    genesis.continuity.highWaterEventHash = genesisHash;
    const good: Record<string, unknown> = {
      SchemaVersion: schemaVersion,
      Identifier: "identity-1",
      Digest: hash,
      Version: "1.0.0",
      Timestamp: t,
      DecimalString: "-0.000000000000000001",
      NonnegativeDecimal: "0",
      PositiveDecimal: "0.000000000000000001",
      SourceIdentity: identity,
      GammaProvenance: gamma,
      Freshness: freshness,
      Entitlement: entitlement,
      MarketDataSource: source,
      Quote: quote,
      Candle: candle,
      TradeFlow: flow,
      VolumeProfileBin: bin,
      VolumeProfile: profile,
      DatasetManifest: dataset,
      ResearchEvidence: evidence,
      KnowledgeImport: knowledge,
      DataRequirement: requirement,
      DeterministicRule: rule,
      CostModel: costs,
      StrategySpec: strategy,
      TimeWindow: window,
      BacktestRun: backtest,
      TradeIntent: intent,
      RiskDecision: risk,
      ExecutionReceipt: receipt,
      AgentRun: agent,
      ModuleStatus: "active-read-only",
      ModuleManifest: module,
      BrokerRecoveryStatus: broker,
      RecoveryRequest: recovery,
      EventEnvelope: event,
      ProjectionContinuity: continuity,
      PortfolioSnapshot: portfolio,
      AcceptedReview: review,
      PaperSimulationAdmission: admission,
      ExecutionProjection: projection,
      PortfolioGenesis: genesis,
    };
    const cases: ContractFixture[] = Object.entries(good).map(
      ([contract, payload]) => ({
        name: `${contract}/valid`,
        contract,
        payload: structuredClone(payload),
        valid: true,
      })
    );
    const add = (
      contract: string,
      name: string,
      payload: unknown,
      valid = false
    ): void => {
      cases.push({
        name: `${contract}/${name}`,
        contract,
        payload: structuredClone(payload),
        valid,
      });
    };
    const change = (
      contract: string,
      path: string,
      value: unknown,
      name = path,
      valid = false
    ): void => {
      const payload = structuredClone(good[contract]) as Record<
        string,
        unknown
      >;
      const parts = path.split(".");
      let object = payload;
      for (const part of parts.slice(0, -1))
        object = object[part] as Record<string, unknown>;
      object[parts.at(-1)!] = value;
      add(contract, name, payload, valid);
    };
    const eventContracts: Record<string, string> = {
      "dataset.recorded": "DatasetManifest",
      "research.recorded": "ResearchEvidence",
      "knowledge.imported": "KnowledgeImport",
      "strategy.recorded": "StrategySpec",
      "backtest.recorded": "BacktestRun",
      "trade.proposed": "TradeIntent",
      "risk.evaluated": "RiskDecision",
      "execution.observed": "ExecutionReceipt",
      "agent.recorded": "AgentRun",
      "module.recorded": "ModuleManifest",
      "quote.observed": "Quote",
      "candle.observed": "Candle",
      "trade-flow.observed": "TradeFlow",
      "volume-profile.observed": "VolumeProfile",
      "broker-status.observed": "BrokerRecoveryStatus",
      "recovery.requested": "RecoveryRequest",
    };
    for (const [eventType, contract] of Object.entries(eventContracts)) {
      const envelope = {
        ...event,
        eventType,
        payload: structuredClone(good[contract]),
      } as EventEnvelope;
      const sealed = { ...envelope, eventId: await computeEventId(envelope) };
      add("EventEnvelope", `branch-${eventType}`, sealed, true);
      if (
        [
          "trade.proposed",
          "execution.observed",
          "broker-status.observed",
          "recovery.requested",
        ].includes(eventType)
      ) {
        add("EventEnvelope", `scope-${eventType}`, {
          ...sealed,
          environment: "research",
        });
      }
    }
    for (const [contract, payload] of Object.entries(good)) {
      add(
        contract,
        "wrong-type",
        typeof payload === "string" ? {} : "not-an-object"
      );
      if (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload)
      ) {
        add(contract, "unknown-field", { ...payload, unsupportedField: true });
        const missing = { ...payload } as Record<string, unknown>;
        delete missing[Object.keys(missing)[0]!];
        add(contract, "missing-field", missing);
      }
    }
    add("Timestamp", "calendar-invalid", "2026-02-29T00:00:00Z");
    add("Timestamp", "year-zero-leap", "0000-02-29T00:00:00Z", true);
    add("Timestamp", "trailing-line", "1970-01-01T00:00:00Z\n");
    add("Timestamp", "too-precise", "1970-01-01T00:00:00.0000000001Z");
    add("Timestamp", "offset-equivalent", "1969-12-31T23:00:00-01:00", true);
    add("PositiveDecimal", "zero", "0");
    add("DecimalString", "trailing-zero", "1.0");
    add("DecimalString", "exponent", "1e3");
    add("DecimalString", "negative-zero", "-0");
    change(
      "GammaProvenance",
      "replayManifestId",
      `replay-manifest-${zeroHash.slice(0, 24)}`
    );
    change("Freshness", "status", "stale");
    change("Freshness", "observedAt", null);
    change("Freshness", "evaluatedAt", "2026-02-30T00:00:00Z");
    add(
      "Freshness",
      "nanosecond-stale",
      { ...freshness, maxAgeMs: 0, status: "stale" },
      true
    );
    add(
      "Freshness",
      "missing",
      { ...freshness, observedAt: null, status: "missing" },
      true
    );
    change("Entitlement", "expiresAt", before);
    change("Entitlement", "checkedAt", "2026-02-30T00:00:00Z");
    change("MarketDataSource", "dataKind", "synthetic");
    change("Quote", "bid", "11");
    change("Quote", "receivedAt", before);
    change("Quote", "source.freshness.observedAt", before);
    change("Quote", "source.entitlement.checkedAt", "2026-02-30T00:00:00Z");
    change("Candle", "low", "10");
    change("Candle", "endAtExclusive", before);
    change("TradeFlow", "quantity", "0");
    change("TradeFlow", "receivedAt", before);
    change("VolumeProfileBin", "upperPriceExclusive", "0");
    change("VolumeProfile", "bins", [
      bin,
      { ...bin, lowerPriceInclusive: "9.5" },
    ]);
    change(
      "VolumeProfile",
      "bins",
      [{ ...bin, lowerPriceInclusive: "10", upperPriceExclusive: "11" }, bin],
      "unordered-touching-bins",
      true
    );
    change("DatasetManifest", "instrumentUniverse", [
      "synthetic-equity",
      "synthetic-equity",
    ]);
    change(
      "DatasetManifest",
      "gammaProvenance.replayManifestId",
      `replay-manifest-${zeroHash.slice(0, 24)}`
    );
    change("DatasetManifest", "dataVintageId", null);
    change("DatasetManifest", "captureTime", before);
    change(
      "ResearchEvidence",
      "sourceUri",
      "https://example.invalid/paper?token=synthetic"
    );
    change("ResearchEvidence", "contentHash", zeroHash);
    change("ResearchEvidence", "publishedAt", expires);
    change("KnowledgeImport", "sourceIdentities", [identity, identity]);
    change("KnowledgeImport", "contentHashes", [hash, hash]);
    change(
      "KnowledgeImport",
      "contentHashes",
      [hash, zeroHash],
      "unbound-content-hash"
    );
    change("KnowledgeImport", "unavailableSources", [
      { sourceId: "source-1", reason: "not-found" },
    ]);
    change(
      "KnowledgeImport",
      "duplicateMappings.0.canonicalSourceId",
      "missing-source"
    );
    change(
      "KnowledgeImport",
      "duplicateMappings.0.sourceId",
      "source-1",
      "self-duplicate"
    );
    change("KnowledgeImport", "duplicateMappings.0.contentHash", zeroHash);
    change(
      "KnowledgeImport",
      "sourceIdentities.1.contentHash",
      zeroHash,
      "unlisted-source-hash"
    );
    change("CostModel", "maximumParticipationBps", "0");
    change(
      "CostModel",
      "maximumParticipationBps",
      "10000.000000000000000001",
      "participation-over-cap"
    );
    change("StrategySpec", "riskLimits.maximumLoss", "0");
    change("StrategySpec", "universe", [
      "synthetic-equity",
      "synthetic-equity",
    ]);
    change("BacktestRun", "leakageChecks.0.evidenceId", null);
    change("BacktestRun", "leakageChecks.1.kind", "look-ahead");
    change("BacktestRun", "trainingWindow.endAtExclusive", later);
    change("TradeIntent", "limitPrice", "10.001");
    change("TradeIntent", "orderType", "market");
    change("TradeIntent", "quantity", "0");
    change("TradeIntent", "referenceQuote.source.freshness.maxAgeMs", 0);
    change("TradeIntent", "reasonEvidenceIds", ["evidence-1", "evidence-1"]);
    change("TradeIntent", "executionAuthorized", true);
    change("RiskDecision", "exposureChecks.0.observed", "3");
    change("RiskDecision", "exposureChecks.0.limit", "0");
    change("RiskDecision", "executionAuthorized", true);
    change("ExecutionReceipt", "remainingQuantity", "1");
    change("ExecutionReceipt", "errorClass", null);
    for (const status of [
      "not-submitted",
      "submitted",
      "partially-filled",
      "filled",
      "cancelled",
      "rejected",
    ]) {
      const known = {
        ...receipt,
        status,
        errorClass: null,
        brokerOrderRef: "synthetic-order",
        filledQuantity: "0",
        remainingQuantity: "3",
      };
      if (status === "filled") {
        known.filledQuantity = "3";
        known.remainingQuantity = "0";
      }
      if (status === "partially-filled") {
        known.filledQuantity = "1";
        known.remainingQuantity = "2";
      }
      add("ExecutionReceipt", `status-${status}`, known, true);
      add("ExecutionReceipt", `unknown-error-${status}`, {
        ...known,
        errorClass: "unknown-outcome",
      });
    }
    change("ExecutionReceipt", "status", "submitted");
    change("ExecutionReceipt", "observationOnly", false);
    change("AgentRun", "outputArtifactIds", []);
    change("AgentRun", "inputEvidenceIds", ["evidence-1", "evidence-1"]);
    change("ModuleManifest", "reasonCodes", ["reason-1", "reason-1"]);
    change("BrokerRecoveryStatus", "recovery", "completed");
    change("RecoveryRequest", "expiresAt", "2026-09-22T12:05:00.000000002Z");
    change("RecoveryRequest", "confirmation.confirmedAt", expires);
    change("ProjectionContinuity", "expectedNextSequence", "3");
    change("ProjectionContinuity", "ownerEpoch", "0");
    change("ProjectionContinuity", "lastOccurredAt", "2026-02-30T00:00:00Z");
    change(
      "ProjectionContinuity",
      "freshness.evaluatedAt",
      "2026-09-22T12:00:00.000000003+00:00",
      "literal-spelling-binding"
    );
    change("PortfolioSnapshot", "positions", [
      portfolio.positions[0],
      portfolio.positions[0],
    ]);
    change("PortfolioSnapshot", "lots.0.openedAt", "2026-02-30T00:00:00Z");
    change("PortfolioSnapshot", "sourceKind", "source-unavailable");
    change("PortfolioSnapshot", "continuity.ownerEpoch", "2");
    change("AcceptedReview", "supersedesReviewId", "review-1");
    change("AcceptedReview", "expiresAt", t);
    change("PaperSimulationAdmission", "maximumLoss", "0");
    change("PaperSimulationAdmission", "intentSha256", zeroHash);
    change("PaperSimulationAdmission", "portfolioSequence", "0");
    change("PaperSimulationAdmission", "brokerSubmissionAllowed", true);
    change("EventEnvelope", "eventId", `event-${zeroHash}`);
    change(
      "EventEnvelope",
      "receivedAt",
      later,
      "consumer-receipt-time-excluded",
      true
    );
    change(
      "EventEnvelope",
      "occurredAt",
      "2026-09-22T12:00:00Z",
      "producer-time-is-bound"
    );
    change("EventEnvelope", "effectiveAt", before, "effective-time-is-bound");
    change("ExecutionProjection", "eventHash", zeroHash);
    change("ExecutionProjection", "receivedAt", later, "receipt-time-is-bound");
    change(
      "ExecutionProjection",
      "receipt.auditEventIds",
      ["audit-2"],
      "nested-receipt-is-bound"
    );
    add("PortfolioGenesis", "unsealed-observation-is-not-genesis", portfolio);
    change("PortfolioGenesis", "cash", "11", "capital-is-hash-bound");
    change(
      "PortfolioGenesis",
      "sourceKind",
      "broker-observation",
      "paper-source-required"
    );
    change(
      "PortfolioGenesis",
      "positions.0.quantity",
      "2",
      "positions-are-hash-bound"
    );
    change(
      "PortfolioGenesis",
      "continuity.freshness.maxAgeMs",
      1001,
      "nested-freshness-is-hash-bound"
    );
    const laterGenesis = structuredClone(genesis);
    laterGenesis.receivedAt = evaluated;
    laterGenesis.continuity.lastReceivedAt = evaluated;
    add(
      "PortfolioGenesis",
      "consumer-receipt-time-is-hash-bound",
      laterGenesis
    );
    const secondObservation = structuredClone(genesis);
    secondObservation.sequence = "2";
    secondObservation.continuity.highWaterSequence = "2";
    secondObservation.continuity.expectedNextSequence = "3";
    add(
      "PortfolioSnapshot",
      "ordinary-second-observation",
      secondObservation,
      true
    );
    add("PortfolioGenesis", "initial-sequence-required", secondObservation);
    const rawByteReject = [
      {
        name: "duplicate-key",
        hex: Buffer.from('{"x":1,"x":2}', "utf8").toString("hex"),
      },
      { name: "negative-zero", hex: Buffer.from("-0", "utf8").toString("hex") },
      {
        name: "unsafe-integer",
        hex: Buffer.from("9007199254740992", "utf8").toString("hex"),
      },
      { name: "fraction", hex: Buffer.from("0.5", "utf8").toString("hex") },
      {
        name: "lone-surrogate",
        hex: Buffer.from('"\\ud800"', "utf8").toString("hex"),
      },
      { name: "malformed-utf8", hex: "22c32822" },
      {
        name: "trailing-data",
        hex: Buffer.from("true false", "utf8").toString("hex"),
      },
      { name: "utf8-bom", hex: "efbbbf7b7d" },
    ];
    const codec: NativeContractFixtures["codec"] = [];
    for (const value of [
      null,
      true,
      0,
      -9_007_199_254_740_991,
      9_007_199_254_740_991,
      "é",
      { 𐀀: 1, "\ue000": 2, a: 'line\nquote"' },
      ["1", null, false],
    ]) {
      const canonicalUtf8 = canonicalArtifactJson(value);
      codec.push({
        name: `canonical-${codec.length + 1}`,
        value,
        canonicalUtf8,
        sha256: await hashArtifact(canonicalUtf8),
      });
    }
    const timestamps = [
      { timestamp: "1970-01-01T00:00:00Z", epochNanoseconds: "0" },
      { timestamp: "1970-01-01T00:00:00.000000001Z", epochNanoseconds: "1" },
      { timestamp: "1969-12-31T23:59:59.999999999Z", epochNanoseconds: "-1" },
      { timestamp: "1969-12-31T23:00:00-01:00", epochNanoseconds: "0" },
      {
        timestamp: "1970-01-01T00:00:00-00:01",
        epochNanoseconds: "60000000000",
      },
      {
        timestamp: "0000-01-01T00:00:00Z",
        epochNanoseconds: "-62167219200000000000",
      },
      { timestamp: "2026-02-29T00:00:00Z", epochNanoseconds: null },
      { timestamp: "1900-02-29T00:00:00Z", epochNanoseconds: null },
      { timestamp: "1970-01-01T24:00:00Z", epochNanoseconds: null },
      { timestamp: "1970-01-01T00:00:60Z", epochNanoseconds: null },
      { timestamp: "1970-01-01T00:00:00.0000000001Z", epochNanoseconds: null },
    ];
    // WHATWG source parity, not a narrower hand-written host/URL policy.
    const sourceUris: { name: string; value: string; valid: boolean }[] = [
      { name: "idna", value: "https://bücher.example/paper", valid: true },
      {
        name: "punycode",
        value: "https://xn--bcher-kva.example/paper",
        valid: true,
      },
      {
        name: "percent-host",
        value: "https://%65xample.invalid/paper",
        valid: true,
      },
      { name: "ipv4", value: "https://127.0.0.1/paper", valid: true },
      { name: "legacy-ipv4", value: "https://0x7f000001/paper", valid: true },
      { name: "ipv6", value: "https://[2001:db8::1]/paper", valid: true },
      {
        name: "mixed-case-scheme",
        value: "HTTPS://EXAMPLE.INVALID/paper",
        valid: true,
      },
      {
        name: "recovered-no-slashes",
        value: "https:example.invalid/paper",
        valid: true,
      },
      {
        name: "recovered-one-slash",
        value: "https:/example.invalid/paper",
        valid: true,
      },
      {
        name: "recovered-many-slashes",
        value: "https:////example.invalid/paper",
        valid: true,
      },
      {
        name: "recovered-backslashes",
        value: "https:\\\\example.invalid\\paper",
        valid: true,
      },
      {
        name: "trimmed-whitespace",
        value: " \thttps://example.invalid/paper\r\n",
        valid: true,
      },
      {
        name: "empty-query",
        value: "https://example.invalid/paper?",
        valid: true,
      },
      {
        name: "empty-fragment",
        value: "https://example.invalid/paper#",
        valid: true,
      },
      {
        name: "empty-userinfo",
        value: "https://@example.invalid/paper",
        valid: true,
      },
      {
        name: "encoded-path-markers",
        value: "https://example.invalid/%3F%23%40",
        valid: true,
      },
      {
        name: "userinfo",
        value: "https://user@example.invalid/paper",
        valid: false,
      },
      {
        name: "password",
        value: "https://:secret@example.invalid/paper",
        valid: false,
      },
      {
        name: "query",
        value: "https://example.invalid/paper?a=b",
        valid: false,
      },
      {
        name: "fragment",
        value: "https://example.invalid/paper#part",
        valid: false,
      },
      { name: "http", value: "http://example.invalid/paper", valid: false },
      { name: "missing-host", value: "https://", valid: false },
      {
        name: "invalid-port",
        value: "https://example.invalid:99999/paper",
        valid: false,
      },
      {
        name: "invalid-percent-host",
        value: "https://%zz.example/paper",
        valid: false,
      },
      {
        name: "invalid-ipv6",
        value: "https://[2001:db8::zz]/paper",
        valid: false,
      },
    ];
    for (const uri of sourceUris)
      add(
        "ResearchEvidence",
        `uri-${uri.name}`,
        { ...evidence, sourceUri: uri.value },
        uri.valid
      );
    cases.push(...(await buildNativeFactsFixtures()).cases);
    cases.push(...buildWorkerFixtures(cases));
    cases.push(...(await buildPolicyFixtures()));
    cases.push(...(await buildModelEpochFixtures(cases)));
    return {
      fixtureFormat: "vertex-native-contract-fixtures-v1",
      schemaVersion,
      cases,
      rawByteReject,
      codec,
      timestamps,
    };
  };

// Opt-in capacity vectors exercise the authoritative maximum collection sizes
// without checked-in multi-megabyte payload literals. Deferred runners may
// append these to an explicitly pinned fixture document when requested.
export const buildNativeCapacityFixtures = async (): Promise<
  ContractFixture[]
> => {
  const document = await buildNativeContractFixtures();
  const known = (contract: string): Record<string, unknown> => {
    return structuredClone(
      document.cases.find((test) => test.contract === contract && test.valid)
        ?.payload
    ) as Record<string, unknown>;
  };
  const knowledge = known("KnowledgeImport");
  const identity = (
    knowledge["sourceIdentities"] as Record<string, unknown>[]
  )[0]!;
  knowledge["sourceIdentities"] = Array.from({ length: 512 }, (_, index) => ({
    ...identity,
    sourceId: `source-${index}`,
  }));
  knowledge["contentHashes"] = [identity["contentHash"]];
  knowledge["duplicateMappings"] = Array.from({ length: 512 }, (_, index) => ({
    sourceId: `source-${index}`,
    canonicalSourceId: `source-${(index + 1) % 512}`,
    contentHash: identity["contentHash"],
  }));
  knowledge["unavailableSources"] = Array.from({ length: 512 }, (_, index) => ({
    sourceId: `absent-${index}`,
    reason: "not-found",
  }));
  const portfolio = known("PortfolioSnapshot");
  const expand = (
    field: string,
    identityField: string,
    count: number
  ): void => {
    const original = (portfolio[field] as Record<string, unknown>[])[0]!;
    portfolio[field] = Array.from({ length: count }, (_, index) => ({
      ...original,
      [identityField]: `capacity-${index}`,
    }));
  };
  expand("positions", "instrumentId", 10_000);
  expand("lots", "lotId", 20_000);
  expand("reservations", "reservationId", 10_000);
  expand("sleeveAllocations", "sleeveId", 128);
  return [
    {
      name: "KnowledgeImport/maximum-relational-joins",
      contract: "KnowledgeImport",
      payload: knowledge,
      valid: true,
    },
    {
      name: "PortfolioSnapshot/maximum-collections",
      contract: "PortfolioSnapshot",
      payload: portfolio,
      valid: true,
    },
    ...buildWorkerByteCapacityFixtures(document.cases),
    ...buildModelEpochCapacityFixtures(document.cases),
  ];
};
