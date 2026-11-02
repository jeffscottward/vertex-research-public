import { describe, expect, it } from "vitest";
import {
  VertexResearchChatDebateConfigurationV1Schema,
  VertexResearchChatDebateStepV1Schema,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
} from "./vertex-research-chat-debate.ts";
import { VertexResearchChatRequestResponseInputSchema } from "./vertex-research-chat-response.ts";

const configuration = {
  profile: "vertex-research-chat-debate-configuration-v1",
  accountAlias: "synthetic",
  environment: "research",
  configurationId: "bounded-debate",
  participantIds: ["expert-a", "expert-b"],
  synthesizerId: "expert-a",
  turnTokens: 4096,
  turnCostUsd: "1",
  aggregateTokens: 20_480,
  aggregateCostUsd: "5",
  expiresAt: "2030-01-01T00:00:00Z",
};

describe("stepwise debate candidate contracts are bounded data, never authority", () => {
  it("requires exactly two distinct speakers and an explicitly selected member synthesizer", () => {
    expect(
      VertexResearchChatDebateConfigurationV1Schema.parse(configuration)
    ).toEqual(configuration);
    for (const changed of [
      { participantIds: ["expert-a", "expert-a"] },
      { participantIds: ["expert-a", "expert-b", "expert-c"] },
      { synthesizerId: "moderator" },
      { synthesizerId: null },
      { participantIds: ["first-mate", "expert-b"] },
    ]) {
      expect(
        VertexResearchChatDebateConfigurationV1Schema.safeParse({
          ...configuration,
          ...changed,
        }).success
      ).toBe(false);
    }
  });
  it("rejects insufficient aggregate token and exact USD ceilings rather than truncating", () => {
    for (const changed of [
      { aggregateTokens: 20_479 },
      { aggregateCostUsd: "4.999999999999999999" },
    ]) {
      expect(
        VertexResearchChatDebateConfigurationV1Schema.safeParse({
          ...configuration,
          ...changed,
        }).success
      ).toBe(false);
    }
  });
  it("requires all earlier published predecessor pins and never accepts future approval", () => {
    const first = {
      profile: "vertex-research-chat-debate-step-v1",
      runKey: "synthetic-run",
      ordinal: 1,
      predecessors: [],
    };
    expect(VertexResearchChatDebateStepV1Schema.parse(first)).toEqual(first);
    for (const changed of [
      { ordinal: 2 },
      { ordinal: 6 },
      { approved: true },
      { synthesizeAutomatically: true },
    ]) {
      expect(
        VertexResearchChatDebateStepV1Schema.safeParse({
          ...first,
          ...changed,
        }).success
      ).toBe(false);
    }
  });
  it("keeps the strict original request path closed to derived extensions", () => {
    const request = {
      accountAlias: "synthetic",
      environment: "research",
      threadId: "thread-a",
      parentMessageId: "human-a",
      participantId: "expert-a",
      snapshotRevision: "2",
      contextStartSequence: "1",
      retrievalQuery: "Compare the supplied research evidence.",
      idempotencyKey: "step-one",
    };
    const debate = {
      profile: "vertex-research-chat-debate-step-v1",
      runKey: "synthetic-run",
      ordinal: 1,
      predecessors: [],
    };
    expect(VertexResearchChatRequestResponseInputSchema.parse(request)).toEqual(
      request
    );
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse({
        ...request,
        debate,
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatDebateStepInputSchema.parse({ ...request, debate })
    ).toEqual({ ...request, debate });
    expect(
      VertexResearchChatDebateStepInputSchema.safeParse({
        ...request,
        debate,
        derived_context: {},
      }).success
    ).toBe(false);
  });
  it("rejects fabricated readiness, reordered schedules, charges or expired run metadata", () => {
    const {
      profile,
      configurationId,
      accountAlias,
      environment,
      expiresAt,
      ...runConfiguration
    } = configuration;
    const selector = {
      accountAlias,
      environment,
      threadId: "thread-a",
      runKey: "synthetic-run",
    };
    const value = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      status: "available",
      selector,
      debateRunId: "debate-a",
      ...runConfiguration,
      configuration: {
        artifactId: "debate-config",
        artifactSha256: "a".repeat(64),
        contractName: "ResearchChatDebateConfiguration",
        schemaVersion: "1.0.0",
      },
      humanWindowSha256: "b".repeat(64),
      collectionId: "collection-a",
      snapshotId: "snapshot-a",
      chargedTokens: "0",
      chargedUsdUnits: "0",
      steps: [],
      nextStep: {
        profile: "vertex-research-chat-debate-step-v1",
        runKey: selector.runKey,
        ordinal: 1,
        predecessors: [],
      },
      complete: false,
      checkedAt: "2029-01-01T00:00:00Z",
      notAfter: expiresAt,
    };
    expect(VertexResearchChatReadDebateRunOutputSchema.parse(value)).toEqual(
      value
    );
    for (const changed of [
      { complete: true },
      { chargedTokens: "1" },
      { chargedUsdUnits: "1" },
      { nextStep: { ...value.nextStep, runKey: "other-run" } },
      { notAfter: value.checkedAt },
    ]) {
      expect(
        VertexResearchChatReadDebateRunOutputSchema.safeParse({
          ...value,
          ...changed,
        }).success
      ).toBe(false);
    }
  });
});
