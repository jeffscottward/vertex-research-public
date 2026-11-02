import { describe, expect, it } from "vitest";
import {
  WorkerBootstrapPayloadSchema,
  WorkerClaimInputSchema,
  WorkerCurrentRightsInputSchema,
  WorkerLeaseSchema,
  WorkerPermissionSchema,
  WorkerPublishCollectionInputSchema,
  WorkerServiceGrantSchema,
} from "./vertex-worker.ts";

// Regression source only: user deferred execution until full implementation.
const scope = { accountAlias: "account-a", environment: "paper" };
const sha = "a".repeat(64);
const lease = {
  schemaVersion: "1.0.0",
  jobId: "job-a",
  eventId: "event-a",
  kind: "native-bootstrap",
  researchPrincipalId: "actor-a",
  ...scope,
  payloadArtifactId: "payload-a",
  payloadSha256: sha,
  policySelectionId: "selection-a",
  policySelectionSha256: sha,
  deadlineAt: "2026-09-22T12:10:00.000000001Z",
  leaseId: "worker-a",
  leaseEpoch: "9007199254740993",
  leaseExpiresAt: "2026-09-22T12:10:00.000000001Z",
  attempt: 1,
};

describe("authoritative bounded worker wire", () => {
  it("retains exact nanosecond and lease-epoch values outside binary64", () => {
    const parsed = WorkerLeaseSchema.parse(lease);
    expect(parsed.leaseEpoch).toBe("9007199254740993");
    expect(parsed.deadlineAt).toBe(lease.deadlineAt);
    return expect(Object.isFrozen(parsed)).toBe(true);
  });
  it("rejects lease one nanosecond beyond its job deadline", () => {
    return expect(
      WorkerLeaseSchema.safeParse({
        ...lease,
        leaseExpiresAt: "2026-09-22T12:10:00.000000002Z",
      }).success
    ).toBe(false);
  });
  it.each([0, -1, 33, 1.5])("rejects out-of-bounds attempt %s", (attempt) => {
    return expect(
      WorkerLeaseSchema.safeParse({ ...lease, attempt }).success
    ).toBe(false);
  });
  it.each(["0", "01", "1e3", "-1"])(
    "rejects nonpositive or noncanonical lease epoch %s",
    (leaseEpoch) => {
      return expect(
        WorkerLeaseSchema.safeParse({ ...lease, leaseEpoch }).success
      ).toBe(false);
    }
  );
  it("does not admit live execution or caller-authored privilege flags", () => {
    expect(
      WorkerLeaseSchema.safeParse({ ...lease, environment: "live" }).success
    ).toBe(false);
    expect(
      WorkerLeaseSchema.safeParse({ ...lease, isAdmin: true }).success
    ).toBe(false);
    return expect(
      WorkerLeaseSchema.safeParse({ ...lease, executionAuthorized: true })
        .success
    ).toBe(false);
  });
  it("uses an explicit bootstrap kind and independent permission, not research impersonation", () => {
    expect(WorkerPermissionSchema.parse("native-bootstrap")).toBe(
      "native-bootstrap"
    );
    expect(
      WorkerClaimInputSchema.safeParse({
        ...scope,
        workerInstanceId: "worker-a",
        kinds: [
          "research-run",
          "dataset-ingest",
          "knowledge-import",
          "backtest",
          "paper-simulation",
          "native-bootstrap",
        ],
        limit: 16,
        leaseDurationMs: 300_000,
      }).success
    ).toBe(true);
    return expect(
      WorkerBootstrapPayloadSchema.safeParse({
        format: "vertex-native-bootstrap-job-v1",
        journalIdentity: "journal-a",
        simulatorId: "sim-a",
        streamId: "stream-a",
        selectionId: "selection-a",
        selectionSha256: sha,
        mode: "initialize",
        initialCash: "100000",
      }).success
    ).toBe(false);
  });
  it("keeps storage rights separate from model-use authorization", () => {
    const input = {
      ...scope,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      collectionId: null,
      policyId: "policy-a",
    };
    expect(
      WorkerCurrentRightsInputSchema.safeParse({ ...input, use: "derive" })
        .success
    ).toBe(true);
    expect(
      WorkerCurrentRightsInputSchema.safeParse({
        ...input,
        use: "model-tokenize",
      }).success
    ).toBe(false);
    return expect(
      WorkerCurrentRightsInputSchema.safeParse({
        ...input,
        use: "model-completion",
      }).success
    ).toBe(false);
  });
  it("rejects collection publication without exact reconstruction and rights pins", () => {
    return expect(
      WorkerPublishCollectionInputSchema.safeParse({
        ...scope,
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        collectionId: "collection-a",
        expectedActiveSnapshotId: null,
        imports: [],
        evidence: [],
        datasets: [],
        idempotencyKey: "publication-a",
      }).success
    ).toBe(false);
  });
  it("requires strictly increasing grant lifetime even at submillisecond precision", () => {
    const grant = {
      grantId: "grant-a",
      servicePrincipalId: "service-a",
      ...scope,
      operations: ["claim"],
      issuedAt: lease.deadlineAt,
      expiresAt: lease.deadlineAt,
      revokedAt: null,
    };
    expect(WorkerServiceGrantSchema.safeParse(grant).success).toBe(false);
    return expect(
      WorkerServiceGrantSchema.safeParse({
        ...grant,
        expiresAt: "2026-09-22T12:10:00.000000002Z",
      }).success
    ).toBe(true);
  });
});
