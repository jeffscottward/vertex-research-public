import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentRunSchema,
  BacktestRunSchema,
  BrokerRecoveryStatusSchema,
  CandleSchema,
  DatasetManifestSchema,
  DataRequirementSchema,
  DecimalStringSchema,
  EventEnvelopeSchema,
  EntitlementSchema,
  ExecutionReceiptSchema,
  FreshnessSchema,
  GammaProvenanceSchema,
  KnowledgeImportSchema,
  ModuleManifestSchema,
  ModuleStatusSchema,
  QuoteSchema,
  RecoveryRequestSchema,
  ResearchEvidenceSchema,
  RiskDecisionSchema,
  StrategySpecSchema,
  TimeWindowSchema,
  TimestampSchema,
  TradeFlowSchema,
  TradeIntentSchema,
  VolumeProfileSchema,
  buildVertexContractDocument,
  computeEventId,
  parseReplayableEventEnvelope,
} from "./contracts/vertex.ts";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
  verifyArtifactHash,
} from "@darkfactory/shared/vertex";

const digest = "a".repeat(64);
const timestamp = "2026-09-21T14:00:00Z";
const later = "2026-09-21T14:00:01Z";
const sourceIdentity = {
  provider: "fixture-provider",
  sourceId: "source-1",
  snapshotId: "snapshot-1",
  contentHash: digest,
};
const freshness = {
  status: "fresh",
  observedAt: timestamp,
  evaluatedAt: later,
  maxAgeMs: 5000,
};
const source = {
  identity: sourceIdentity,
  dataKind: "real",
  syntheticReason: null,
  providerTimezone: "America/New_York",
  entitlement: {
    policyId: "fixture-entitlement",
    status: "granted",
    checkedAt: timestamp,
    expiresAt: "2026-09-22T14:00:00Z",
  },
  freshness,
};
const quote = {
  schemaVersion: "1.0.0",
  quoteId: "quote-1",
  instrumentId: "fixture-instrument",
  currency: "USD",
  bid: "100",
  ask: "101",
  bidSize: "10",
  askSize: "12",
  lastPrice: null,
  sourceTimestamp: timestamp,
  receivedAt: later,
  source,
};
const intent = {
  schemaVersion: "1.0.0",
  intentId: "intent-1",
  idempotencyKey: "proposal-1",
  correlationId: "research-1",
  proposalOnly: true,
  executionAuthorized: false,
  strategyVersion: "strategy-1.0.0",
  accountAlias: "fixture-paper",
  environment: "paper",
  instrumentId: "fixture-instrument",
  side: "buy",
  quantity: "1",
  orderType: "limit",
  limitPrice: "100.5",
  stopPrice: null,
  tickSize: "0.01",
  timeInForce: "DAY",
  quoteAsOf: timestamp,
  referenceQuote: quote,
  proposedAt: later,
  reasonEvidenceIds: ["evidence-1"],
  maxLossBudget: "20",
  expiresAt: "2026-09-21T14:00:04Z",
};
const manifest = {
  schemaVersion: "1.0.0",
  datasetId: "dataset-1",
  provider: "fixture-provider",
  entitlementPolicyId: "fixture-entitlement",
  instrumentUniverse: ["fixture-instrument"],
  startAtInclusive: "2026-09-20T14:00:00Z",
  endAtExclusive: timestamp,
  captureTime: later,
  dataVintageId: "vintage-1",
  dataVintageStatus: "available",
  asOfAt: timestamp,
  adjustmentMethod: "unadjusted",
  calendar: "XNYS",
  contentHash: digest,
  storageRef: "artifact-1",
  retentionPolicy: "fixture-retention",
  sources: [sourceIdentity],
  gammaProvenance: null,
};
const recovery = {
  schemaVersion: "1.0.0",
  requestId: "request-1",
  idempotencyKey: "recovery-1",
  correlationId: "incident-1",
  gatewayId: "gateway-1",
  expectedStatusId: "status-1",
  environment: "paper",
  action: "request-human-recovery",
  requestedAt: later,
  expiresAt: "2026-09-21T14:02:00Z",
  executionAuthorized: false,
  confirmation: {
    kind: "human",
    actorId: "fixture-operator",
    challengeId: "challenge-1",
    confirmedAt: timestamp,
    statement: "I request IBKR recovery only; this does not authorize trading.",
  },
};
const receipt = {
  schemaVersion: "1.0.0",
  intentId: "intent-1",
  submissionKey: "submission-1",
  brokerOrderRef: null,
  environment: "paper",
  observationOnly: true,
  status: "unknown",
  totalQuantity: "3",
  filledQuantity: "1",
  remainingQuantity: "2",
  lastReconciledAt: later,
  errorClass: "unknown-outcome",
  auditEventIds: ["audit-1"],
};
const brokerStatus = {
  schemaVersion: "1.0.0",
  statusId: "status-1",
  gatewayId: "gateway-1",
  observedAt: later,
  environment: "paper",
  infrastructure: "observed",
  brokerHandshake: "not-attempted",
  recovery: "disabled",
  trading: "disabled",
  reasonCodes: ["handshake-not-observed"],
  lastHumanRequestId: null,
};
const event = {
  schemaVersion: "1.0.0",
  eventId: `event-${"0".repeat(64)}`,
  eventType: "dataset.recorded",
  occurredAt: later,
  receivedAt: later,
  effectiveAt: timestamp,
  correlationId: "research-1",
  causationId: null,
  actorId: "fixture-agent",
  moduleId: "fixture-module",
  moduleVersion: "1.0.0",
  environment: "research",
  idempotencyKey: "dataset-observation-1",
  payload: manifest,
};

describe("Vertex public research contracts", () => {
  it("preserves exact decimal strings and rejects noncanonical or nonfinite prices", () => {
    expect(
      DecimalStringSchema.parse("9007199254740993.000000000000000001")
    ).toBe("9007199254740993.000000000000000001");
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      "NaN",
      "Infinity",
      "1e3",
      "01",
      "-0",
      "1.0",
      " 1",
      ".5",
    ]) {
      expect(DecimalStringSchema.safeParse(value).success).toBe(false);
    }
    return expect(DecimalStringSchema.parse("-0.5")).toBe("-0.5");
  });

  it("rejects final line terminators in canonical decimal, digest and identity fields", () => {
    for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      expect(DecimalStringSchema.safeParse(`1${terminator}`).success).toBe(
        false
      );
      expect(
        QuoteSchema.safeParse({ ...quote, bid: `100${terminator}` }).success
      ).toBe(false);
      expect(
        DatasetManifestSchema.safeParse({
          ...manifest,
          contentHash: `${digest}${terminator}`,
        }).success
      ).toBe(false);
      expect(
        DatasetManifestSchema.safeParse({
          ...manifest,
          storageRef: `artifact-1${terminator}`,
        }).success
      ).toBe(false);
    }
    return;
  });

  it("requires timezone-aware timestamps and explicit vintage availability", () => {
    expect(DatasetManifestSchema.parse(manifest)).toEqual(manifest);
    for (const changed of [
      { captureTime: "2026-09-21T14:00:01" },
      { captureTime: "2026-02-30T14:00:00Z" },
      { dataVintageId: null },
      { dataVintageStatus: "unknown" },
      { endAtExclusive: manifest.startAtInclusive },
      { asOfAt: "2026-09-22T14:00:00Z" },
      { contentHash: "ABC" },
    ]) {
      expect(
        DatasetManifestSchema.safeParse({ ...manifest, ...changed }).success
      ).toBe(false);
    }
    return expect(
      DatasetManifestSchema.safeParse({
        ...manifest,
        dataVintageId: null,
        dataVintageStatus: "unavailable",
      }).success
    ).toBe(true);
  });

  it("preserves the nanosecond timestamp profile and computes exact signed epochs", () => {
    const instants = [
      ["1970-01-01T00:00:00Z", 0n],
      ["1970-01-01T00:00:00.000000001Z", 1n],
      ["1969-12-31T23:59:59.999999999Z", -1n],
      ["1969-12-31T23:59:59.123456Z", -876544000n],
      ["1970-01-01T01:30:00.000000001+01:30", 1n],
      ["1969-12-31T22:30:00.000000001-01:30", 1n],
      ["1970-01-01T00:00:00.1-00:00", 100000000n],
      ["2000-03-01T00:00:00Z", 951868800000000000n],
      ["1900-03-01T00:00:00Z", -2203891200000000000n],
      ["0001-01-01T00:00:00Z", -62135596800000000000n],
      ["0000-01-01T00:00:00Z", -62167219200000000000n],
      ["9999-12-31T23:59:59.999999999Z", 253402300799999999999n],
    ] as const;
    for (const [value, epoch] of instants) {
      expect(TimestampSchema.parse(value)).toBe(value);
      expect(timestampToEpochNanoseconds(value)).toBe(epoch);
    }
    for (let precision = 1; precision <= 9; precision += 1) {
      expect(
        TimestampSchema.safeParse(
          `2026-09-21T14:00:00.${"1".repeat(precision)}Z`
        ).success
      ).toBe(true);
    }
    return;
  });

  it("rejects calendar normalization, missing seconds, excess precision and invalid offsets", () => {
    for (const value of [
      "2026-09-21T14:00Z",
      "2026-09-21T14:00+01:00",
      "2026-09-21T14:00:00",
      "2026-09-21T14:00:00.Z",
      "2026-09-21T14:00:00.1234567890Z",
      "2026-02-29T14:00:00Z",
      "2026-02-30T14:00:00+01:00",
      "1900-02-29T00:00:00Z",
      "2026-04-31T14:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-01-32T00:00:00Z",
      "2026-09-21T24:00:00Z",
      "2026-09-21T14:60:00Z",
      "2026-09-21T14:00:60Z",
      "2026-09-21T14:00:00+24:00",
      "2026-09-21T14:00:00-01:60",
      "2026-09-21T14:00:00+0100",
      "2026-09-21T14:00:00+01",
      "2026-09-21T14:00:00z",
      "2026-09-21T14:00:00Z\n",
    ]) {
      expect(TimestampSchema.safeParse(value).success).toBe(false);
      expect(() => timestampToEpochNanoseconds(value)).toThrow(TypeError);
      expect(
        FreshnessSchema.safeParse({ ...freshness, evaluatedAt: value }).success
      ).toBe(false);
      expect(
        TimeWindowSchema.safeParse({
          startAtInclusive: value,
          endAtExclusive: later,
        }).success
      ).toBe(false);
    }
    expect(TimestampSchema.safeParse("2000-02-29T00:00:00Z").success).toBe(
      true
    );
    expect(TimestampSchema.safeParse("0000-02-29T00:00:00Z").success).toBe(
      true
    );
    expect(TimestampSchema.safeParse("2026-09-21T14:00:00+23:59").success).toBe(
      true
    );
    return expect(
      TimestampSchema.safeParse("2026-09-21T14:00:00-23:59").success
    ).toBe(true);
  });

  it("orders microseconds and nanoseconds rather than truncated milliseconds", () => {
    for (const [early, late] of [
      ["2026-09-21T14:00:00.000001Z", "2026-09-21T14:00:00.000002Z"],
      ["2026-09-21T14:00:00.000000001Z", "2026-09-21T14:00:00.000000002Z"],
      ["1969-12-31T23:59:59.999999998Z", "1969-12-31T23:59:59.999999999Z"],
    ]) {
      expect(
        TimeWindowSchema.safeParse({
          startAtInclusive: early,
          endAtExclusive: late,
        }).success
      ).toBe(true);
      expect(
        TimeWindowSchema.safeParse({
          startAtInclusive: late,
          endAtExclusive: early,
        }).success
      ).toBe(false);
      expect(
        FreshnessSchema.safeParse({
          ...freshness,
          observedAt: late,
          evaluatedAt: early,
        }).success
      ).toBe(false);
      expect(
        EventEnvelopeSchema.safeParse({
          ...event,
          occurredAt: late,
          receivedAt: early,
        }).success
      ).toBe(false);
      expect(
        EntitlementSchema.safeParse({
          ...source.entitlement,
          checkedAt: early,
          expiresAt: late,
        }).success
      ).toBe(true);
      expect(
        EntitlementSchema.safeParse({
          ...source.entitlement,
          status: "expired",
          checkedAt: early,
          expiresAt: late,
        }).success
      ).toBe(false);
      expect(
        RecoveryRequestSchema.safeParse({
          ...recovery,
          requestedAt: early,
          expiresAt: late,
          confirmation: { ...recovery.confirmation, confirmedAt: early },
        }).success
      ).toBe(true);
      expect(
        DatasetManifestSchema.safeParse({
          ...manifest,
          startAtInclusive: "0000-01-01T00:00:00Z",
          asOfAt: early,
          endAtExclusive: late,
          captureTime: early,
        }).success
      ).toBe(false);
    }
    expect(
      FreshnessSchema.safeParse({
        ...freshness,
        observedAt: "2026-09-21T14:00:00.0009Z",
        evaluatedAt: "2026-09-21T14:00:00.0001Z",
      }).success
    ).toBe(false);
    const boundary = {
      ...freshness,
      observedAt: timestamp,
      evaluatedAt: "2026-09-21T14:00:05.000000001Z",
    };
    expect(FreshnessSchema.safeParse(boundary).success).toBe(false);
    expect(
      FreshnessSchema.safeParse({ ...boundary, status: "stale" }).success
    ).toBe(true);
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        proposedAt: boundary.evaluatedAt,
        expiresAt: "2026-09-21T14:00:06Z",
      }).success
    ).toBe(false);
    return expect(
      RecoveryRequestSchema.safeParse({
        ...recovery,
        expiresAt: "2026-09-21T14:05:00.000000001Z",
      }).success
    ).toBe(false);
  });

  it("compares equivalent offset instants without rewriting hash-significant strings", async () => {
    const offset = "2026-09-21T15:30:00.000000000+01:30";
    expect(timestampToEpochNanoseconds(offset)).toBe(
      timestampToEpochNanoseconds(timestamp)
    );
    expect(
      TimeWindowSchema.safeParse({
        startAtInclusive: timestamp,
        endAtExclusive: offset,
      }).success
    ).toBe(false);
    expect(
      FreshnessSchema.safeParse({
        ...freshness,
        observedAt: offset,
        evaluatedAt: timestamp,
        maxAgeMs: 0,
      }).success
    ).toBe(true);
    expect(
      EntitlementSchema.safeParse({
        ...source.entitlement,
        checkedAt: timestamp,
        expiresAt: offset,
      }).success
    ).toBe(false);
    expect(
      EntitlementSchema.safeParse({
        ...source.entitlement,
        status: "expired",
        checkedAt: timestamp,
        expiresAt: offset,
      }).success
    ).toBe(true);
    expect(
      QuoteSchema.safeParse({ ...quote, sourceTimestamp: offset }).success
    ).toBe(true);
    expect(
      TradeIntentSchema.safeParse({ ...intent, quoteAsOf: offset }).success
    ).toBe(true);
    expect(
      EventEnvelopeSchema.safeParse({
        ...event,
        occurredAt: offset,
        receivedAt: timestamp,
      }).success
    ).toBe(true);
    const original = EventEnvelopeSchema.parse(event);
    const equivalent = EventEnvelopeSchema.parse({
      ...event,
      effectiveAt: offset,
    });
    expect(equivalent.effectiveAt).toBe(offset);
    return expect(await computeEventId(equivalent)).not.toBe(
      await computeEventId(original)
    );
  });

  it("rejects negative zero counters before canonical hashing", () => {
    const negativeZero = JSON.parse("-0");
    expect(Object.is(negativeZero, -0)).toBe(true);
    expect(
      FreshnessSchema.safeParse({ ...freshness, maxAgeMs: negativeZero })
        .success
    ).toBe(false);
    expect(
      DataRequirementSchema.safeParse({
        kind: "quotes",
        maximumAgeMs: negativeZero,
        pointInTimeRequired: true,
        entitlementPolicyId: "policy-1",
      }).success
    ).toBe(false);
    return expect(
      QuoteSchema.safeParse({
        ...quote,
        source: {
          ...source,
          freshness: { ...freshness, maxAgeMs: negativeZero },
        },
      }).success
    ).toBe(false);
  });

  it("rejects lone surrogate text while retaining ordinary Unicode scalar text", () => {
    const strategy = {
      schemaVersion: "1.0.0",
      strategyId: "strategy-1",
      version: "1.0.0",
      sleeve: "quant",
      hypothesis: "Fixture café 𐐀",
      universe: ["fixture-instrument"],
      signalSchedule: {
        calendar: "XNYS",
        timezone: "UTC",
        interval: "bar-close",
      },
      entryRules: [
        {
          ruleId: "entry-1",
          featureId: "fixture-feature",
          operator: "gt",
          threshold: "1",
          lookbackBars: 1,
        },
      ],
      exitRules: [
        {
          ruleId: "exit-1",
          featureId: "fixture-feature",
          operator: "lt",
          threshold: "0",
          lookbackBars: 1,
        },
      ],
      riskLimits: {
        maximumLoss: "1",
        maximumNotional: "1",
        maximumPositions: 1,
      },
      requiredData: [
        {
          kind: "candles",
          maximumAgeMs: 1,
          pointInTimeRequired: true,
          entitlementPolicyId: "entitlement-1",
        },
      ],
      costModel: {
        commissionPerUnit: "0",
        spreadBps: "0",
        slippageBps: "0",
        borrowAnnualBps: "0",
        impactModel: "fixed-bps",
        maximumParticipationBps: "1",
      },
      codeDigest: digest,
    };
    const parsed = StrategySpecSchema.parse(strategy);
    expect(() => canonicalArtifactJson(parsed)).not.toThrow();
    expect(Object.isFrozen(parsed.entryRules)).toBe(true);
    expect(Object.isFrozen(parsed.entryRules[0])).toBe(true);
    expect(Object.isFrozen(parsed.riskLimits)).toBe(true);
    for (const hypothesis of ["\ud800", "\udfff"]) {
      expect(
        StrategySpecSchema.safeParse({ ...strategy, hypothesis }).success
      ).toBe(false);
    }
    return;
  });

  it("retains but does not relabel stale and missing observations as fresh", () => {
    const stale = { ...freshness, evaluatedAt: "2026-09-21T14:00:06Z" };
    expect(FreshnessSchema.safeParse(stale).success).toBe(false);
    expect(
      FreshnessSchema.safeParse({ ...stale, status: "stale" }).success
    ).toBe(true);
    expect(
      FreshnessSchema.safeParse({ ...freshness, observedAt: null }).success
    ).toBe(false);
    expect(
      FreshnessSchema.safeParse({
        ...freshness,
        status: "missing",
        observedAt: null,
      }).success
    ).toBe(true);
    expect(
      FreshnessSchema.safeParse({ ...freshness, status: "missing" }).success
    ).toBe(false);
    return expect(
      FreshnessSchema.safeParse({
        ...freshness,
        observedAt: "2026-09-21T14:00:02Z",
      }).success
    ).toBe(false);
  });

  it("rejects unknown statuses, future schemas, and secret-bearing extra fields", () => {
    expect(ModuleStatusSchema.safeParse("mystery").success).toBe(false);
    expect(
      QuoteSchema.safeParse({ ...quote, schemaVersion: "2.0.0" }).success
    ).toBe(false);
    for (const key of [
      "apiKey",
      "password",
      "token",
      "cookies",
      "raw",
      "authorization",
    ]) {
      expect(
        QuoteSchema.safeParse({ ...quote, [key]: "forbidden" }).success
      ).toBe(false);
      expect(
        QuoteSchema.safeParse({
          ...quote,
          source: { ...source, [key]: "forbidden" },
        }).success
      ).toBe(false);
      expect(
        QuoteSchema.safeParse({
          ...quote,
          source: {
            ...source,
            identity: { ...sourceIdentity, [key]: "forbidden" },
          },
        }).success
      ).toBe(false);
    }
    return;
  });

  it("requires real, entitled, fresh, instrument-bound data for nonexecutable proposals", () => {
    expect(TradeIntentSchema.parse(intent).executionAuthorized).toBe(false);
    for (const changed of [
      { environment: "live" },
      { executionAuthorized: true },
      { proposalOnly: false },
      { instrumentId: "other-instrument" },
      { quoteAsOf: later },
      { proposedAt: "2026-09-21T14:00:06Z", expiresAt: "2026-09-21T14:00:07Z" },
      { expiresAt: timestamp },
      { limitPrice: "100.005" },
      { quantity: "0" },
      { stopPrice: "99" },
      { orderType: "market" },
      {
        referenceQuote: {
          ...quote,
          source: {
            ...source,
            dataKind: "synthetic",
            syntheticReason: "fixture",
          },
        },
      },
      {
        referenceQuote: {
          ...quote,
          source: {
            ...source,
            entitlement: { ...source.entitlement, status: "unknown" },
          },
        },
      },
      {
        referenceQuote: {
          ...quote,
          source: {
            ...source,
            freshness: { ...freshness, status: "missing", observedAt: null },
          },
        },
      },
    ]) {
      expect(
        TradeIntentSchema.safeParse({ ...intent, ...changed }).success
      ).toBe(false);
    }
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        orderType: "market",
        limitPrice: null,
      }).success
    ).toBe(true);
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        orderType: "stop-limit",
        stopPrice: "99",
      }).success
    ).toBe(true);
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        orderType: "stop",
        limitPrice: null,
        stopPrice: "99",
      }).success
    ).toBe(true);
    for (const orderType of ["stop", "stop-limit"]) {
      const proposal = {
        ...intent,
        orderType,
        limitPrice: orderType === "stop" ? null : intent.limitPrice,
      };
      expect(
        TradeIntentSchema.safeParse({ ...proposal, stopPrice: "99.005" })
          .success
      ).toBe(false);
      expect(
        TradeIntentSchema.safeParse({ ...proposal, stopPrice: "NaN" }).success
      ).toBe(false);
      expect(
        TradeIntentSchema.safeParse({ ...proposal, stopPrice: null }).success
      ).toBe(false);
    }
    return;
  });

  it("separates chart ordering from order execution and prevents malformed candles", () => {
    const candle = {
      schemaVersion: "1.0.0",
      candleId: "bar-1",
      instrumentId: "fixture-instrument",
      currency: "USD",
      startAtInclusive: timestamp,
      endAtExclusive: later,
      open: "100",
      high: "102",
      low: "99",
      close: "101",
      volume: "20",
      interval: "1s",
      source,
    };
    expect(CandleSchema.safeParse(candle).success).toBe(true);
    expect(CandleSchema.safeParse({ ...candle, high: "100" }).success).toBe(
      false
    );
    expect(CandleSchema.safeParse({ ...candle, volume: "-1" }).success).toBe(
      false
    );
    const flow = {
      schemaVersion: "1.0.0",
      flowId: "flow-1",
      instrumentId: "fixture-instrument",
      currency: "USD",
      sourceTimestamp: timestamp,
      receivedAt: later,
      price: "100",
      quantity: "2",
      aggressor: "unknown",
      source,
    };
    expect(TradeFlowSchema.safeParse(flow).success).toBe(true);
    expect(
      TradeFlowSchema.safeParse({ ...flow, aggressor: "guessed-buy" }).success
    ).toBe(false);
    const bins = [
      {
        lowerPriceInclusive: "101",
        upperPriceExclusive: "102",
        buyVolume: "3",
        sellVolume: "2",
        unknownVolume: "1",
      },
      {
        lowerPriceInclusive: "100",
        upperPriceExclusive: "101",
        buyVolume: "1",
        sellVolume: "2",
        unknownVolume: "0",
      },
    ];
    const profile = {
      schemaVersion: "1.0.0",
      profileId: "profile-1",
      instrumentId: "fixture-instrument",
      currency: "USD",
      startAtInclusive: timestamp,
      endAtExclusive: later,
      bins,
      source,
    };
    expect(VolumeProfileSchema.parse(profile).bins).toEqual(bins);
    expect(
      VolumeProfileSchema.safeParse({ ...profile, bins: [...bins, bins[0]] })
        .success
    ).toBe(false);
    expect(
      VolumeProfileSchema.safeParse({
        ...profile,
        bins: [bins[0], { ...bins[1], upperPriceExclusive: "101.5" }],
      }).success
    ).toBe(false);
    expect(
      VolumeProfileSchema.safeParse({ ...profile, endAtExclusive: timestamp })
        .success
    ).toBe(false);
    expect(
      VolumeProfileSchema.safeParse({
        ...profile,
        startAtInclusive: later,
        endAtExclusive: timestamp,
      }).success
    ).toBe(false);
    return expect(
      VolumeProfileSchema.safeParse({ ...profile, startAtInclusive: "invalid" })
        .success
    ).toBe(false);
  });

  it("never promotes a risk result to execution permission", () => {
    const risk = {
      schemaVersion: "1.0.0",
      intentId: "intent-1",
      policyVersion: "1.0.0",
      portfolioSnapshotId: "portfolio-1",
      freshnessCheck: freshness,
      cashReservationId: null,
      exposureChecks: [],
      decision: "requires-human-review",
      reasonCodes: ["human-review-required"],
      authorizationExpiry: null,
      liveAuthorization: false,
      executionAuthorized: false,
    };
    expect(RiskDecisionSchema.safeParse(risk).success).toBe(true);
    for (const changed of [
      { decision: "authorized" },
      { liveAuthorization: true },
      { executionAuthorized: true },
      { authorizationExpiry: later },
    ]) {
      expect(
        RiskDecisionSchema.safeParse({ ...risk, ...changed }).success
      ).toBe(false);
    }
    expect(
      RiskDecisionSchema.safeParse({
        ...risk,
        decision: "paper-eligible",
        freshnessCheck: { ...freshness, status: "unknown" },
      }).success
    ).toBe(false);
    const check = {
      checkId: "exposure-1",
      status: "passed",
      observed: "9007199254740993.000000000000000001",
      limit: "9007199254740993.000000000000000001",
    };
    for (const decision of ["research-accepted", "paper-eligible"]) {
      const eligible = { ...risk, decision, exposureChecks: [check] };
      const parsed = RiskDecisionSchema.parse(eligible);
      expect(parsed.decision).toBe(decision);
      expect(parsed.executionAuthorized).toBe(false);
      expect(parsed.liveAuthorization).toBe(false);
      expect(parsed.authorizationExpiry).toBeNull();
      expect(Object.isFrozen(parsed.exposureChecks[0])).toBe(true);
      expect(
        RiskDecisionSchema.safeParse({ ...eligible, exposureChecks: [] })
          .success
      ).toBe(false);
      for (const status of ["failed", "unknown", "not-run"]) {
        expect(
          RiskDecisionSchema.safeParse({
            ...eligible,
            exposureChecks: [{ ...check, status }],
          }).success
        ).toBe(false);
        expect(
          RiskDecisionSchema.safeParse({
            ...risk,
            exposureChecks: [{ ...check, status, observed: null }],
          }).success
        ).toBe(true);
      }
      for (const observed of [
        null,
        "9007199254740993.000000000000000002",
        "NaN",
      ]) {
        expect(
          RiskDecisionSchema.safeParse({
            ...eligible,
            exposureChecks: [{ ...check, observed }],
          }).success
        ).toBe(false);
      }
      expect(
        RiskDecisionSchema.safeParse({
          ...eligible,
          exposureChecks: [{ ...check, observed: "0" }],
        }).success
      ).toBe(true);
    }
    return;
  });

  it("preserves unknown broker outcomes and validates partial fill arithmetic", () => {
    expect(ExecutionReceiptSchema.parse(receipt).status).toBe("unknown");
    expect(
      ExecutionReceiptSchema.safeParse({ ...receipt, status: "filled" }).success
    ).toBe(false);
    expect(
      ExecutionReceiptSchema.safeParse({ ...receipt, remainingQuantity: "3" })
        .success
    ).toBe(false);
    expect(
      ExecutionReceiptSchema.safeParse({
        ...receipt,
        status: "partially-filled",
        brokerOrderRef: "broker-ref",
        errorClass: null,
      }).success
    ).toBe(true);
    return expect(
      ExecutionReceiptSchema.safeParse({ ...receipt, errorClass: null }).success
    ).toBe(false);
  });

  it("requires status-specific broker evidence and exact fill quantities without granting authority", () => {
    const known = {
      ...receipt,
      errorClass: null,
      brokerOrderRef: "fixture-broker-order",
    };
    for (const status of ["not-submitted", "rejected"]) {
      const unfilled = {
        ...known,
        status,
        brokerOrderRef: null,
        filledQuantity: "0",
        remainingQuantity: "3",
      };
      expect(ExecutionReceiptSchema.parse(unfilled).observationOnly).toBe(true);
      expect(
        ExecutionReceiptSchema.safeParse({
          ...unfilled,
          filledQuantity: "1",
          remainingQuantity: "2",
        }).success
      ).toBe(false);
    }
    for (const status of [
      "submitted",
      "partially-filled",
      "filled",
      "cancelled",
    ]) {
      expect(
        ExecutionReceiptSchema.safeParse({
          ...known,
          status,
          brokerOrderRef: null,
        }).success
      ).toBe(false);
    }
    const filled = {
      ...known,
      status: "filled",
      filledQuantity: "3",
      remainingQuantity: "0",
    };
    expect(ExecutionReceiptSchema.parse(filled).remainingQuantity).toBe("0");
    expect(
      ExecutionReceiptSchema.safeParse({ ...known, status: "filled" }).success
    ).toBe(false);
    expect(
      ExecutionReceiptSchema.safeParse({
        ...known,
        status: "partially-filled",
        filledQuantity: "0",
        remainingQuantity: "3",
      }).success
    ).toBe(false);
    expect(
      ExecutionReceiptSchema.safeParse({
        ...filled,
        status: "partially-filled",
      }).success
    ).toBe(false);
    const submitted = {
      ...known,
      status: "submitted",
      filledQuantity: "0",
      remainingQuantity: "3",
    };
    expect(ExecutionReceiptSchema.parse(submitted).status).toBe("submitted");
    expect(
      ExecutionReceiptSchema.safeParse({ ...known, status: "submitted" })
        .success
    ).toBe(false);
    expect(
      ExecutionReceiptSchema.parse({ ...known, status: "cancelled" })
        .filledQuantity
    ).toBe("1");
    expect(
      ExecutionReceiptSchema.parse({
        ...known,
        status: "partially-filled",
        totalQuantity: "0.3",
        filledQuantity: "0.1",
        remainingQuantity: "0.2",
      }).totalQuantity
    ).toBe("0.3");
    for (const field of [
      "filledQuantity",
      "remainingQuantity",
      "totalQuantity",
    ]) {
      for (const value of ["NaN", "1.0", "-1", "1e3"]) {
        expect(
          ExecutionReceiptSchema.safeParse({ ...known, [field]: value }).success
        ).toBe(false);
      }
    }
    return;
  });

  it("requires explicit human-only bounded recovery without claiming authentication", () => {
    expect(RecoveryRequestSchema.safeParse(recovery).success).toBe(true);
    for (const changed of [
      { confirmation: { ...recovery.confirmation, kind: "agent" } },
      {
        confirmation: { ...recovery.confirmation, statement: "approve trades" },
      },
      { expiresAt: "2026-09-21T15:00:00Z" },
      { executionAuthorized: true },
      { password: "forbidden" },
      { action: "restart-and-trade" },
    ]) {
      expect(
        RecoveryRequestSchema.safeParse({ ...recovery, ...changed }).success
      ).toBe(false);
    }
    expect(BrokerRecoveryStatusSchema.parse(brokerStatus).trading).toBe(
      "disabled"
    );
    for (const recoveryState of ["requested", "in-progress", "completed"]) {
      expect(
        BrokerRecoveryStatusSchema.safeParse({
          ...brokerStatus,
          recovery: recoveryState,
        }).success
      ).toBe(false);
      const observed = BrokerRecoveryStatusSchema.parse({
        ...brokerStatus,
        recovery: recoveryState,
        lastHumanRequestId: recovery.requestId,
        brokerHandshake: "authenticated",
      });
      expect(observed.lastHumanRequestId).toBe(recovery.requestId);
      expect(observed.trading).toBe("disabled");
    }
    return;
  });

  it("keeps matching content hashes distinct by collection source identity", () => {
    const imported = {
      schemaVersion: "1.0.0",
      collectionId: "collection-1",
      snapshotId: "collection-snapshot-1",
      sourceIdentities: [
        sourceIdentity,
        { ...sourceIdentity, sourceId: "source-2" },
      ],
      contentHashes: [digest],
      duplicateMappings: [
        {
          sourceId: "source-2",
          canonicalSourceId: "source-1",
          contentHash: digest,
        },
      ],
      unavailableSources: [],
      transcriptQuality: "unknown",
      retrievalScope: "collection-only",
      rightsPolicyId: "rights-1",
      replacementScope: "collection-snapshot",
      contentClass: "raw-transcript",
      untrustedContent: true,
    };
    expect(KnowledgeImportSchema.parse(imported).sourceIdentities).toHaveLength(
      2
    );
    expect(
      KnowledgeImportSchema.safeParse({
        ...imported,
        sourceIdentities: [sourceIdentity, sourceIdentity],
      }).success
    ).toBe(false);
    expect(
      KnowledgeImportSchema.safeParse({
        ...imported,
        contentHashes: ["b".repeat(64)],
      }).success
    ).toBe(false);
    expect(
      KnowledgeImportSchema.safeParse({
        ...imported,
        retrievalScope: "all-collections",
      }).success
    ).toBe(false);
    const unavailable = {
      sourceId: "source-unavailable",
      reason: "provider-unavailable",
    };
    const incomplete = KnowledgeImportSchema.parse({
      ...imported,
      unavailableSources: [unavailable],
    });
    expect(incomplete.unavailableSources).toEqual([unavailable]);
    expect(incomplete.sourceIdentities).toHaveLength(2);
    expect(Object.isFrozen(incomplete.unavailableSources[0])).toBe(true);
    expect(
      KnowledgeImportSchema.safeParse({
        ...imported,
        unavailableSources: [unavailable, unavailable],
      }).success
    ).toBe(false);
    return expect(
      KnowledgeImportSchema.safeParse({
        ...imported,
        unavailableSources: [
          { ...unavailable, sourceId: sourceIdentity.sourceId },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects incomplete public reports rather than inventing required research data", () => {
    for (const schema of [
      ResearchEvidenceSchema,
      StrategySpecSchema,
      BacktestRunSchema,
      AgentRunSchema,
      ModuleManifestSchema,
    ]) {
      expect(schema.safeParse({ schemaVersion: "1.0.0" }).success).toBe(false);
    }
    return;
  });

  it("binds attributed evidence to immutable source bytes and rejects secret-bearing URLs", () => {
    const evidence = {
      schemaVersion: "1.0.0",
      evidenceId: "evidence-1",
      collectionId: "collection-1",
      snapshotId: "collection-snapshot-1",
      sourceType: "paper",
      sourceUri: "https://example.test/paper",
      sourceIdentity,
      sourceLocator: "page 3",
      attribution: "Fictional fixture author",
      publishedAt: timestamp,
      capturedAt: later,
      contentHash: digest,
      claim: "A testable hypothesis.",
      method: "Out-of-sample study.",
      limitations: ["Fixture only."],
      acceptanceStatus: "unreviewed",
      rightsPolicyId: "fixture-rights",
      untrustedContent: true,
    };
    expect(ResearchEvidenceSchema.safeParse(evidence).success).toBe(true);
    for (const sourceUri of [
      "not a URL",
      "https://example.test/paper?token=forbidden",
      "https://user:password@example.test/paper",
      "file:///private",
    ]) {
      expect(
        ResearchEvidenceSchema.safeParse({ ...evidence, sourceUri }).success
      ).toBe(false);
    }
    expect(
      ResearchEvidenceSchema.safeParse({
        ...evidence,
        contentHash: "b".repeat(64),
      }).success
    ).toBe(false);
    expect(
      ResearchEvidenceSchema.safeParse({ ...evidence, untrustedContent: false })
        .success
    ).toBe(false);
    const gamma = {
      schemaVersion: "1.0.0",
      replaySchemaVersion: 2,
      sourceTradeRunId: "gamma-run-1",
      replayManifestId: `replay-manifest-${digest.slice(0, 24)}`,
      manifestHash: digest,
      inputHash: digest,
      outputHash: digest,
    };
    expect(GammaProvenanceSchema.safeParse(gamma).success).toBe(true);
    expect(
      GammaProvenanceSchema.safeParse({ ...gamma, replaySchemaVersion: 3 })
        .success
    ).toBe(false);
    expect(
      GammaProvenanceSchema.safeParse({
        ...gamma,
        manifestHash: "b".repeat(64),
      }).success
    ).toBe(false);
    return expect(
      Object.isFrozen(DatasetManifestSchema.parse(manifest).sources[0])
    ).toBe(true);
  });

  it("keeps deterministic strategy rules separate from prompts and costs explicit", () => {
    const costModel = {
      commissionPerUnit: "0.01",
      spreadBps: "2",
      slippageBps: "1",
      borrowAnnualBps: "100",
      impactModel: "participation-capped",
      maximumParticipationBps: "500",
    };
    const strategy = {
      schemaVersion: "1.0.0",
      strategyId: "strategy-1",
      version: "1.0.0",
      sleeve: "quant",
      hypothesis: "Fictional deterministic fixture.",
      universe: ["fixture-instrument"],
      signalSchedule: {
        calendar: "XNYS",
        timezone: "UTC",
        interval: "bar-close",
      },
      entryRules: [
        {
          ruleId: "entry-1",
          featureId: "fixture-feature",
          operator: "gt",
          threshold: "1",
          lookbackBars: 5,
        },
      ],
      exitRules: [
        {
          ruleId: "exit-1",
          featureId: "fixture-feature",
          operator: "lt",
          threshold: "0",
          lookbackBars: 5,
        },
      ],
      riskLimits: {
        maximumLoss: "100",
        maximumNotional: "1000",
        maximumPositions: 1,
      },
      requiredData: [
        {
          kind: "candles",
          maximumAgeMs: 5000,
          pointInTimeRequired: true,
          entitlementPolicyId: "entitlement-1",
        },
      ],
      costModel,
      codeDigest: digest,
    };
    expect(StrategySpecSchema.safeParse(strategy).success).toBe(true);
    expect(
      StrategySpecSchema.safeParse({
        ...strategy,
        entryRules: ["Buy when the model is confident"],
      }).success
    ).toBe(false);
    expect(
      StrategySpecSchema.safeParse({
        ...strategy,
        costModel: { ...costModel, slippageBps: Number.POSITIVE_INFINITY },
      }).success
    ).toBe(false);
    expect(
      StrategySpecSchema.safeParse({
        ...strategy,
        costModel: { ...costModel, maximumParticipationBps: "10001" },
      }).success
    ).toBe(false);
    const backtest = {
      schemaVersion: "1.0.0",
      runId: "backtest-1",
      strategyVersion: "strategy-1.0.0",
      datasetManifestIds: ["dataset-1"],
      seed: 0,
      engineVersion: "1.0.0",
      trainingWindow: {
        startAtInclusive: "2026-01-01T00:00:00Z",
        endAtExclusive: "2026-06-01T00:00:00Z",
      },
      testWindow: {
        startAtInclusive: "2026-06-01T00:00:00Z",
        endAtExclusive: timestamp,
      },
      benchmark: "fixture-benchmark",
      transactionCosts: costModel,
      slippageModel: "participation-capped",
      resultsRef: null,
      leakageChecks: [],
      reviewStatus: "unreviewed",
      validationMode: "walk-forward",
      forwardSampleCount: 0,
      gammaProvenance: null,
    };
    expect(BacktestRunSchema.safeParse(backtest).success).toBe(true);
    expect(
      BacktestRunSchema.safeParse({
        ...backtest,
        testWindow: backtest.trainingWindow,
      }).success
    ).toBe(false);
    expect(
      BacktestRunSchema.safeParse({ ...backtest, reviewStatus: "accepted" })
        .success
    ).toBe(false);
    expect(
      BacktestRunSchema.safeParse({ ...backtest, seed: Number.NaN }).success
    ).toBe(false);
    expect(BacktestRunSchema.safeParse({ ...backtest, seed: -0 }).success).toBe(
      false
    );
    expect(
      BacktestRunSchema.safeParse({ ...backtest, forwardSampleCount: -0 })
        .success
    ).toBe(false);
    expect(
      BacktestRunSchema.safeParse({
        ...backtest,
        trainingWindow: {
          ...backtest.trainingWindow,
          endAtExclusive: "2026-06-01T00:00:00.000000002Z",
        },
        testWindow: {
          ...backtest.testWindow,
          startAtInclusive: "2026-06-01T00:00:00.000000001Z",
        },
      }).success
    ).toBe(false);
    const leakageChecks = [
      "look-ahead",
      "survivorship",
      "point-in-time",
      "overlap",
      "multiple-testing",
    ].map((kind) => ({
      kind,
      status: "passed",
      evidenceId: "evidence-1",
    }));
    expect(
      BacktestRunSchema.safeParse({
        ...backtest,
        leakageChecks,
        resultsRef: "result-1",
        reviewStatus: "accepted",
      }).success
    ).toBe(true);
    return expect(
      BacktestRunSchema.safeParse({
        ...backtest,
        leakageChecks: [leakageChecks[0], leakageChecks[0]],
      }).success
    ).toBe(false);
  });

  it("enforces separate model budgets and read-only module capabilities", () => {
    const run = {
      schemaVersion: "1.0.0",
      runId: "agent-1",
      agentRole: "research",
      taskContract: "research-1",
      allowedTools: ["read-evidence"],
      modelVersion: null,
      inputEvidenceIds: [],
      outputArtifactIds: [],
      tokenBudget: 0,
      costBudgetUsd: "0",
      status: "blocked",
      errors: [{ code: "model-unavailable", retryable: false }],
      approvalRequests: [],
      executionAuthorized: false,
    };
    expect(AgentRunSchema.safeParse(run).success).toBe(true);
    expect(AgentRunSchema.safeParse({ ...run, tokenBudget: -0 }).success).toBe(
      false
    );
    for (const changed of [
      { tokenBudget: -1 },
      { tokenBudget: Number.POSITIVE_INFINITY },
      { tokenBudget: 0.5 },
      { costBudgetUsd: "NaN" },
      { costBudgetUsd: "-1" },
      { allowedTools: ["submit-order"] },
      { status: "completed" },
    ]) {
      expect(AgentRunSchema.safeParse({ ...run, ...changed }).success).toBe(
        false
      );
    }
    expect(
      AgentRunSchema.safeParse({ ...run, status: "completed", errors: [] })
        .success
    ).toBe(false);
    const completed = AgentRunSchema.parse({
      ...run,
      status: "completed",
      errors: [],
      outputArtifactIds: ["artifact-1"],
    });
    expect(completed.outputArtifactIds).toEqual(["artifact-1"]);
    expect(completed.executionAuthorized).toBe(false);
    expect(Object.isFrozen(completed.outputArtifactIds)).toBe(true);
    const module = {
      schemaVersion: "1.0.0",
      moduleId: "module-1",
      version: "1.0.0",
      inputSchemaVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
      capabilities: ["research"],
      dataRequirements: [],
      supportedInstruments: ["equity"],
      riskPolicyVersion: "1.0.0",
      artifactDigest: digest,
      lifecycleState: "disabled",
      runtime: "python-external",
      reasonCodes: ["not-configured"],
    };
    expect(ModuleManifestSchema.safeParse(module).success).toBe(true);
    expect(
      ModuleManifestSchema.safeParse({
        ...module,
        outputSchemaVersion: "2.0.0",
      }).success
    ).toBe(false);
    return expect(
      ModuleManifestSchema.safeParse({
        ...module,
        capabilities: ["trade-live"],
      }).success
    ).toBe(false);
  });

  it("reports malformed numeric values as validation failures without throwing", () => {
    for (const value of ["NaN", "Infinity", "1e9", "01", "1.0"]) {
      expect(QuoteSchema.safeParse({ ...quote, bid: value }).success).toBe(
        false
      );
      expect(
        TradeIntentSchema.safeParse({ ...intent, quantity: value }).success
      ).toBe(false);
      expect(
        TradeIntentSchema.safeParse({ ...intent, tickSize: value }).success
      ).toBe(false);
    }
    return;
  });

  it("uses Gamma-compatible canonical UTF-8 JSON hashes on the strict integer/decimal wire domain", async () => {
    expect(canonicalArtifactJson({ b: "café", a: "1.25" })).toBe(
      '{"a":"1.25","b":"café"}'
    );
    expect(await hashArtifact({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    expect(await hashArtifact("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(
      await verifyArtifactHash(
        new TextEncoder().encode("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      )
    ).toBe(true);
    expect(await verifyArtifactHash("changed", digest)).toBe(false);
    expect(await verifyArtifactHash("abc", "invalid")).toBe(false);
    for (const value of [
      { a: Number.POSITIVE_INFINITY },
      { a: undefined },
      { a: 1.2 },
      { a: -0 },
      new Date(timestamp),
    ]) {
      expect(() => canonicalArtifactJson(value)).toThrow();
    }
    expect(() => canonicalArtifactJson({ value: "\ud800" })).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalArtifactJson(cycle)).toThrow();
    expect(() => canonicalArtifactJson(new Array(2))).toThrow();
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "hidden",
    });
    expect(() => canonicalArtifactJson(accessor)).toThrow();
    const symbols = { [Symbol("hidden")]: "hidden" };
    return expect(() => canonicalArtifactJson(symbols)).toThrow();
  });

  it("replays event identity across object-key and delivery-time changes, not payload mutation", async () => {
    const parsed = EventEnvelopeSchema.parse(event);
    const eventId = await computeEventId(parsed);
    const sealed = { ...parsed, eventId };
    expect((await parseReplayableEventEnvelope(sealed)).eventId).toBe(eventId);
    const { payload, ...headers } = sealed;
    const redelivered = {
      payload,
      ...headers,
      receivedAt: "2026-09-21T15:00:00Z",
    };
    expect((await parseReplayableEventEnvelope(redelivered)).eventId).toBe(
      eventId
    );
    await expect(
      parseReplayableEventEnvelope({
        ...sealed,
        payload: { ...manifest, storageRef: "changed" },
      })
    ).rejects.toThrow();
    expect(
      EventEnvelopeSchema.safeParse({ ...sealed, eventType: "trade.submitted" })
        .success
    ).toBe(false);
    return expect(
      EventEnvelopeSchema.safeParse({ ...sealed, schemaVersion: "9.0.0" })
        .success
    ).toBe(false);
  });

  it("binds proposal and broker lifecycle events to their payload environment and immutable identity", async () => {
    for (const [eventType, payload] of [
      ["trade.proposed", intent],
      ["execution.observed", receipt],
      ["broker-status.observed", brokerStatus],
      ["recovery.requested", recovery],
    ] as const) {
      const input = { ...event, eventType, environment: "paper", payload };
      const parsed = EventEnvelopeSchema.parse(input);
      const eventId = await computeEventId(parsed);
      const verified = await parseReplayableEventEnvelope({
        ...input,
        eventId,
      });
      expect(verified.eventType).toBe(eventType);
      expect(verified.environment).toBe("paper");
      expect(Object.isFrozen(verified.payload)).toBe(true);
      expect(
        EventEnvelopeSchema.safeParse({ ...input, environment: "live" }).success
      ).toBe(false);
      expect(
        EventEnvelopeSchema.safeParse({ ...input, environment: "research" })
          .success
      ).toBe(false);
      await expect(
        parseReplayableEventEnvelope({
          ...input,
          eventId,
          idempotencyKey: "changed-producer-key",
        })
      ).rejects.toThrow("Event content identity mismatch");
      await expect(
        parseReplayableEventEnvelope({ ...input, eventId, effectiveAt: later })
      ).rejects.toThrow("Event content identity mismatch");
      const redelivered = await parseReplayableEventEnvelope({
        ...input,
        eventId,
        receivedAt: "2026-09-21T14:00:01.000000001Z",
      });
      expect(redelivered.eventId).toBe(eventId);
    }
    return;
  });

  it("deeply freezes parsed and verified arrays and objects without freezing caller data", async () => {
    const expectFrozenGraph = (node: unknown): void => {
      if (node !== null && typeof node === "object") {
        expect(Object.isFrozen(node)).toBe(true);
        for (const child of Object.values(node)) expectFrozenGraph(child);
      }
    };
    const caller = structuredClone(event);
    const parsed = EventEnvelopeSchema.parse(caller);
    if (parsed.eventType !== "dataset.recorded")
      throw new Error("Unexpected fixture type");
    expectTypeOf(parsed.payload.instrumentUniverse).toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf(parsed.payload.sources).toEqualTypeOf<
      readonly {
        readonly provider: string;
        readonly sourceId: string;
        readonly snapshotId: string;
        readonly contentHash: string;
      }[]
    >();
    expect(Object.isFrozen(parsed.payload.instrumentUniverse)).toBe(true);
    expect(Object.isFrozen(parsed.payload.sources)).toBe(true);
    expect(Object.isFrozen(DatasetManifestSchema.parse(manifest).sources)).toBe(
      true
    );
    expect(Object.isFrozen(caller.payload.instrumentUniverse)).toBe(false);
    const eventId = await computeEventId(parsed);
    const pending = parseReplayableEventEnvelope({ ...caller, eventId });
    caller.payload.instrumentUniverse.push("caller-mutation");
    caller.payload.sources[0]!.sourceId = "caller-source-mutation";
    const verified = await pending;
    if (verified.eventType !== "dataset.recorded")
      throw new Error("Unexpected fixture type");
    const bytes = canonicalArtifactJson(verified);
    expectFrozenGraph(verified);
    expect(Reflect.set(verified.payload.instrumentUniverse, 0, "changed")).toBe(
      false
    );
    expect(
      Reflect.set(verified.payload.sources[0]!, "sourceId", "changed")
    ).toBe(false);
    expect(() =>
      Array.prototype.push.call(verified.payload.sources, sourceIdentity)
    ).toThrow(TypeError);
    expect(canonicalArtifactJson(verified)).toBe(bytes);
    expect(await computeEventId(verified)).toBe(eventId);

    const quoteEvent = EventEnvelopeSchema.parse({
      ...event,
      eventType: "quote.observed",
      payload: quote,
    });
    const quoteId = await computeEventId(quoteEvent);
    const verifiedQuote = await parseReplayableEventEnvelope({
      ...quoteEvent,
      eventId: quoteId,
    });
    if (verifiedQuote.eventType !== "quote.observed")
      throw new Error("Unexpected fixture type");
    expectFrozenGraph(verifiedQuote);
    expect(Reflect.set(verifiedQuote.payload, "bid", "0")).toBe(false);
    expect(
      Reflect.set(verifiedQuote.payload.source.entitlement, "status", "denied")
    ).toBe(false);
    expect(
      Reflect.set(verifiedQuote.payload.source.freshness, "maxAgeMs", 0)
    ).toBe(false);
    expect(await computeEventId(verifiedQuote)).toBe(quoteId);
    const profile = {
      schemaVersion: "1.0.0",
      profileId: "profile-1",
      instrumentId: "fixture-instrument",
      currency: "USD",
      startAtInclusive: timestamp,
      endAtExclusive: later,
      source,
      bins: [
        {
          lowerPriceInclusive: "100",
          upperPriceExclusive: "101",
          buyVolume: "1",
          sellVolume: "2",
          unknownVolume: "0",
        },
      ],
    };
    const profileEvent = EventEnvelopeSchema.parse({
      ...event,
      eventType: "volume-profile.observed",
      payload: profile,
    });
    const profileId = await computeEventId(profileEvent);
    const verifiedProfile = await parseReplayableEventEnvelope({
      ...profileEvent,
      eventId: profileId,
    });
    if (verifiedProfile.eventType !== "volume-profile.observed")
      throw new Error("Unexpected fixture type");
    expectFrozenGraph(verifiedProfile);
    expect(
      Reflect.set(verifiedProfile.payload.bins[0]!, "buyVolume", "9")
    ).toBe(false);
    expect(() =>
      Array.prototype.pop.call(verifiedProfile.payload.bins)
    ).toThrow(TypeError);
    return expect(await computeEventId(verifiedProfile)).toBe(profileId);
  });

  it("rejects unsupported event graphs rather than hashing a sanitized replacement", async () => {
    const failOnAccess = () => {
      throw new Error("Accessor invoked");
    };
    const accessor = Object.defineProperty({ ...event }, "payload", {
      enumerable: true,
      get: failOnAccess,
    });
    const cycle: Record<string, unknown> = { ...event };
    cycle["payload"] = cycle;
    const sparse = { ...manifest, instrumentUniverse: new Array(1) };
    const decorated = [...manifest.instrumentUniverse];
    Object.defineProperty(decorated, "hidden", { value: { mutable: true } });
    for (const value of [
      accessor,
      cycle,
      { ...event, [Symbol("hidden")]: true },
      { ...event, payload: sparse },
      { ...event, payload: { ...manifest, instrumentUniverse: decorated } },
      { ...event, payload: Object.assign(new Date(timestamp), manifest) },
      { ...event, payload: { ...manifest, contentHash: undefined } },
    ]) {
      await expect(parseReplayableEventEnvelope(value)).rejects.toThrow(
        TypeError
      );
      await expect(computeEventId(value as never)).rejects.toThrow(TypeError);
    }
    const hidden = Object.defineProperty({ ...event }, "hidden", {
      value: { mutable: true },
    });
    expect(() => deepFreezeArtifact(hidden)).toThrow(TypeError);
    expect(() => deepFreezeArtifact(cycle)).toThrow(TypeError);
    const leaf = { values: ["retained"] };
    const graph = Object.freeze({ left: leaf, right: leaf });
    const frozen = deepFreezeArtifact(graph);
    expect(frozen.left).toBe(frozen.right);
    expect(Object.isFrozen(frozen.left)).toBe(true);
    return expect(Object.isFrozen(frozen.left.values)).toBe(true);
  });

  it("publishes the same machine-readable contract document as the Zod source", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../../../docs/vertex-contracts.json", import.meta.url),
        "utf8"
      )
    );
    return expect(document).toEqual(buildVertexContractDocument());
  });
});
