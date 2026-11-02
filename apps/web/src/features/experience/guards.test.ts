import { describe, expect, it, vi } from "vitest";
import { hashArtifact } from "@darkfactory/shared/vertex";
import {
  computeNativeFactProjectionHash,
  type NativeFactProjection,
  type AgentRun,
  type BrokerRecoveryStatus,
  type VertexPortfolioRead,
} from "@darkfactory/api/vertex";
import { guardExperienceServices } from "./guards.ts";
import type {
  ExperienceServices,
  ImmutableArtifact,
  ResearchProposalCommand,
} from "./ports.ts";

const scope = { accountAlias: "account-a", environment: "research" } as const;
const signal = () => new AbortController().signal;
const run = (): AgentRun => ({
  schemaVersion: "1.0.0",
  runId: "run-a",
  agentRole: "research",
  taskContract: "research-v1",
  allowedTools: ["read-evidence"],
  modelVersion: null,
  inputEvidenceIds: ["evidence-a"],
  outputArtifactIds: [],
  tokenBudget: 100,
  costBudgetUsd: "1",
  status: "queued",
  errors: [],
  approvalRequests: [],
  executionAuthorized: false,
});
const seal = async <T>(
  artifactId: string,
  value: T
): Promise<ImmutableArtifact<T>> => ({
  artifactId,
  sha256: await hashArtifact(value),
  value,
});
const proposal = (): ResearchProposalCommand => ({
  ...scope,
  question: "What evidence supports this claim?",
  collectionId: "collection-a",
  evidenceIds: ["evidence-a"],
  role: "research",
  idempotencyKey: "request-a",
  proposalOnly: true,
  executionAuthorized: false,
});
const services = (): ExperienceServices => {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unavailable fixture port");
  };
  return {
    reads: {
      scopes: unavailable,
      gateways: unavailable,
      portfolio: unavailable,
      continuity: unavailable,
      inbox: unavailable,
      strategies: unavailable,
      dossier: unavailable,
      agents: unavailable,
      agent: unavailable,
      audit: unavailable,
      gateway: unavailable,
    },
    reviews: null,
    jobs: null,
  };
};
const nativeProjection = async (): Promise<NativeFactProjection> => {
  const value: NativeFactProjection = {
    schemaVersion: "1.0.0",
    projectionId: "native-fact-a",
    accountAlias: "account-a",
    environment: "paper",
    streamId: "owner-stream",
    ownerEpoch: "1",
    sequence: "2",
    proofJournalSequence: "2",
    proofJournalHeadHash: "c".repeat(64),
    factOrdinal: 0,
    previousEventHash: "a".repeat(64),
    eventHash: "0".repeat(64),
    occurredAt: "2026-09-22T10:00:00Z",
    receivedAt: "2026-09-22T10:00:01Z",
    expiresAt: "2026-09-22T11:00:00Z",
    actorId: "owner-a",
    policyVersion: "1.0.0",
    idempotencyKey: "native-request-a",
    sourceKind: "paper-simulation",
    proof: {
      artifactId: "proof-a",
      sha256: "b".repeat(64),
      sourceEventId: "journal-event-a",
    },
    fact: {
      kind: "cash-settlement",
      settlementId: "settlement-a",
      currency: "USD",
      cashDelta: "0.000000000000000001",
      fillEventIds: ["fill-a"],
    },
    authoritative: false,
    reservationAuthority: "native-owner-only",
    executionAuthorized: false,
  };
  return { ...value, eventHash: await computeNativeFactProjectionHash(value) };
};

describe("experience injected service guards (source-authored; execution deferred)", () => {
  it("preserves disabled mutations rather than manufacturing services", () => {
    const guarded = guardExperienceServices(services());
    expect(guarded.reviews).toBeNull();
    return expect(guarded.jobs).toBeNull();
  });

  it("accepts only the requested immutable agent artifact and canonical hash", async () => {
    const value = await seal("artifact-run-a", run());
    const base = services();
    const read = vi.fn(async () => value);
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, agent: read },
    });
    const input = { ...scope, artifactId: "artifact-run-a" };
    await expect(guarded.reads.agent(input, signal())).resolves.toEqual(value);
    expect(read).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    read.mockResolvedValue({ ...value, artifactId: "different-artifact" });
    await expect(guarded.reads.agent(input, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    read.mockResolvedValue({ ...value, sha256: "0".repeat(64) });
    return await expect(
      guarded.reads.agent(input, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects altered canonical run data even when the artifact identity is unchanged", async () => {
    const value = await seal("artifact-run-a", run());
    const base = services();
    const altered = { ...value, value: { ...value.value, costBudgetUsd: "2" } };
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, agents: async () => [altered] },
    });
    return await expect(
      guarded.reads.agents(scope, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("bounds collections and rejects duplicate immutable identities", async () => {
    const value = await seal("artifact-run-a", run());
    const base = services();
    const read = vi.fn(async () => [value, value]);
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, agents: read },
    });
    await expect(guarded.reads.agents(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    read.mockResolvedValue(Array.from({ length: 513 }, () => value));
    return await expect(
      guarded.reads.agents(scope, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("retains explicit portfolio unavailability instead of substituting zero holdings", async () => {
    const base = services();
    const unavailable: VertexPortfolioRead = {
      status: "unavailable",
      reason: "source-unavailable",
      executionAuthorized: false,
    };
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, portfolio: async () => unavailable },
    });
    return await expect(
      guarded.reads.portfolio(scope, signal())
    ).resolves.toEqual(unavailable);
  });

  it("binds gateway environment and identity even for an authenticated observation", async () => {
    const base = services();
    const value: BrokerRecoveryStatus = {
      schemaVersion: "1.0.0",
      statusId: "status-a",
      gatewayId: "gateway-a",
      environment: "paper",
      observedAt: "2026-09-22T10:00:00Z",
      infrastructure: "observed",
      brokerHandshake: "authenticated",
      recovery: "disabled",
      trading: "disabled",
      reasonCodes: ["read-only-not-ready", "trading-disabled"],
      lastHumanRequestId: null,
    };
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, gateway: async () => value },
    });
    await expect(
      guarded.reads.gateway(
        { gatewayId: "gateway-b", environment: "paper" },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
    return await expect(
      guarded.reads.gateway(
        { gatewayId: "gateway-a", environment: "live" },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("admits a queued research acknowledgement only with the exact role and evidence inputs", async () => {
    const value = await seal("artifact-run-a", run());
    const base = services();
    const proposeResearch = vi.fn(async () => value);
    const proposeSimulation = vi.fn(async (): Promise<never> => {
      throw new Error("No simulation");
    });
    const guarded = guardExperienceServices({
      ...base,
      jobs: { proposeResearch, proposeSimulation },
    });
    await expect(
      guarded.jobs!.proposeResearch(proposal(), signal())
    ).resolves.toEqual(value);
    const completed = await seal("artifact-run-b", {
      ...run(),
      status: "completed" as const,
      outputArtifactIds: ["output-a"],
    });
    proposeResearch.mockResolvedValue(completed);
    await expect(
      guarded.jobs!.proposeResearch(proposal(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    const missing = await seal("artifact-run-c", {
      ...run(),
      inputEvidenceIds: [],
    });
    proposeResearch.mockResolvedValue(missing);
    return await expect(
      guarded.jobs!.proposeResearch(proposal(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("does not dispatch live research or any job with elevated authority flags", async () => {
    const base = services();
    const proposeResearch = vi.fn(async () => seal("artifact-a", run()));
    const proposeSimulation = vi.fn(async (): Promise<never> => {
      throw new Error("No simulation");
    });
    const guarded = guardExperienceServices({
      ...base,
      jobs: { proposeResearch, proposeSimulation },
    });
    await expect(
      guarded.jobs!.proposeResearch(
        { ...proposal(), environment: "live" },
        signal()
      )
    ).rejects.toMatchObject({ kind: "denied" });
    expect(proposeResearch).not.toHaveBeenCalled();
    const unsafe = {
      accountAlias: "account-a",
      environment: "paper",
      admissionId: "admission-a",
      reviewId: "review-a",
      reviewVersion: "1.0.0",
      intentId: "intent-a",
      intentSha256: "0".repeat(64),
      strategyVersion: "strategy-artifact-a",
      idempotencyKey: "request-a",
      simulationOnly: true,
      brokerSubmissionAllowed: true,
      liveAuthorization: false,
    };
    await expect(
      guarded.jobs!.proposeSimulation(unsafe as never, signal())
    ).rejects.toMatchObject({ kind: "denied" });
    return expect(proposeSimulation).not.toHaveBeenCalled();
  });

  it("rejects over-bound audit streams before hashing or showing a partial journal", async () => {
    const base = services();
    const guarded = guardExperienceServices({
      ...base,
      reads: {
        ...base.reads,
        audit: async () => Array.from({ length: 501 }, () => ({}) as never),
      },
    });
    return await expect(
      guarded.reads.audit(scope, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("accepts exact native fact projections without inventing an order receipt", async () => {
    const base = services();
    const fact = await nativeProjection();
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, audit: async () => [fact] },
    });
    const result = await guarded.reads.audit(
      { accountAlias: "account-a", environment: "paper" },
      signal()
    );
    expect(result).toEqual([fact]);
    expect(result[0]).not.toHaveProperty("receipt");
    expect(result[0]).not.toHaveProperty("strategyVersion");
    return expect(result[0]).toHaveProperty("proof.artifactId", "proof-a");
  });

  it("rejects native fact hash changes including receivedAt and preserves account scope", async () => {
    const base = services();
    const fact = await nativeProjection();
    const read = vi.fn(async () => [fact]);
    const guarded = guardExperienceServices({
      ...base,
      reads: { ...base.reads, audit: read },
    });
    const paper = { accountAlias: "account-a", environment: "paper" } as const;
    read.mockResolvedValue([{ ...fact, receivedAt: "2026-09-22T10:00:02Z" }]);
    await expect(guarded.reads.audit(paper, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    read.mockResolvedValue([
      { ...fact, proof: { ...fact.proof, sha256: "c".repeat(64) } },
    ]);
    await expect(guarded.reads.audit(paper, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    read.mockResolvedValue([fact]);
    await expect(
      guarded.reads.audit({ ...paper, accountAlias: "other-account" }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    return await expect(
      guarded.reads.audit({ ...paper, environment: "live" }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  return it("rejects native and order hybrids, unsupported fact kinds and elevated authority", async () => {
    const base = services();
    const fact = await nativeProjection();
    for (const invalid of [
      { ...fact, receipt: {} },
      { ...fact, strategyVersion: "fake-order" },
      { ...fact, fact: { kind: "unsupported" } },
      { ...fact, authoritative: true },
    ]) {
      const guarded = guardExperienceServices({
        ...base,
        reads: { ...base.reads, audit: async () => [invalid as never] },
      });
      await expect(
        guarded.reads.audit(
          { accountAlias: "account-a", environment: "paper" },
          signal()
        )
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });
});
