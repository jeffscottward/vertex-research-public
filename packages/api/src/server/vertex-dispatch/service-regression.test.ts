import { describe, expect, it, vi } from "vitest";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import {
  isVertexWorkerPath,
  VERTEX_WORKER_METHOD_DEFINITIONS,
  VERTEX_WORKER_METHODS,
  VERTEX_WORKER_REQUEST_MAX_BYTES,
} from "../../contracts/vertex-worker-rpc.ts";
import { VertexWorkerServiceError } from "../vertex-worker-auth.ts";
import { createVertexWorkerService } from "../vertex-worker-service.ts";

// Kept under this worker's owned source directory; no regression is executed
// before the final integrated validation phase.
const at = "2026-09-22T12:00:00.000Z";
const scope = { accountAlias: "account-1", environment: "research" as const };
const identity: WorkerServiceIdentity = {
  grantId: "grant-1",
  servicePrincipalId: "service-1",
  scope,
  expiresAt: "2026-09-22T13:00:00.000Z",
};
// Public deterministic fixture, NOT an issued credential.
const token = "fixture-worker-opaque-token-0123456789abcdefghijklmnopqrs";
const canonicalToken = btoa(token)
  .replace(/[=]/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const context = {
  headers: new Headers({ authorization: `Bearer ${canonicalToken}` }),
};
const statusInput = { ...scope, jobId: "job-1" };
const result = {
  status: "unknown" as const,
  jobId: "job-1",
  state: "unknown" as const,
  lease: null,
  outputArtifactIds: [],
  reason: "unavailable" as const,
};
const fixture = () => {
  const authenticate = vi.fn<VertexWorkerStore["authenticate"]>(
    async () => identity
  );
  const invoke = vi.fn<VertexWorkerStore["invoke"]>(async () => result);
  const claim = vi.fn(async () => ({
    status: "accepted" as const,
    leases: [],
  }));
  const service = createVertexWorkerService({
    store: { authenticate, invoke },
    claim,
    clock: { now: () => at },
  });
  return { authenticate, invoke, claim, service };
};

describe("bounded worker same-oRPC service", () => {
  it("exports only exact known method paths and explicit input/output schemas", () => {
    expect(VERTEX_WORKER_METHODS).toContain("currentPaperAdmission");
    for (const method of VERTEX_WORKER_METHODS) {
      expect(VERTEX_WORKER_METHOD_DEFINITIONS[method].input).toBeDefined();
      expect(VERTEX_WORKER_METHOD_DEFINITIONS[method].output).toBeDefined();
      expect(isVertexWorkerPath(`/api/orpc/vertexWorker/${method}`)).toBe(true);
    }
    for (const path of [
      "/api/orpc/vertexWorker",
      "/api/orpc/vertexWorker/status/",
      "/api/orpc/vertexWorker/status/anything",
      "/api/orpc/vertexWorker/%73tatus",
      "/api/orpc/vertexWorker/issueGrant",
    ]) {
      expect(isVertexWorkerPath(path)).toBe(false);
    }
  });
  it("authenticates only SHA256 digest plus exact operation/scope, never ambient user flags", async () => {
    const f = fixture();
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).resolves.toEqual(result);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalToken)
        )
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    expect(f.authenticate).toHaveBeenCalledWith(digest, scope, "status");
    expect(f.invoke).toHaveBeenCalledWith(identity, "status", statusInput);
    expect(JSON.stringify(f.authenticate.mock.calls)).not.toContain(
      canonicalToken
    );
    return await expect(
      f.service.invoke(
        { headers: new Headers({ "x-user-id": "admin", "x-admin": "true" }) },
        "status",
        statusInput
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it.each([
    "Bearer short",
    "Basic fixture",
    "Bearer abc, Bearer def",
    `Bearer ${"a".repeat(42)}`,
    `Bearer ${"a".repeat(172)}`,
    `Bearer ${"A".repeat(42)}B`,
  ])(
    "rejects weak, combined or noncanonical bearer format %s",
    async (authorization) => {
      const f = fixture();
      await expect(
        f.service.invoke(
          { headers: new Headers({ authorization }) },
          "status",
          statusInput
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(f.authenticate).not.toHaveBeenCalled();
      return expect(f.invoke).not.toHaveBeenCalled();
    }
  );
  it("rejects expired/stale or wrong-scope identities and never caches authorization", async () => {
    const f = fixture();
    f.authenticate.mockResolvedValueOnce({ ...identity, expiresAt: at });
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    f.authenticate.mockResolvedValueOnce({
      ...identity,
      scope: { ...scope, accountAlias: "other-account" },
    });
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.invoke).not.toHaveBeenCalled();
    f.authenticate.mockResolvedValueOnce(identity);
    await f.service.invoke(context, "status", statusInput);
    f.authenticate.mockRejectedValueOnce(
      new Error("revoked grant private detail")
    );
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Worker authentication required",
    });
    expect(f.authenticate).toHaveBeenCalledTimes(4);
    return expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("maps transaction-time grant revocation to a fixed secret-safe service error", async () => {
    const f = fixture();
    f.invoke.mockRejectedValue(
      Object.assign(new Error("credential-sensitive database detail"), {
        code: "denied",
      })
    );
    return await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({
      name: "VertexWorkerServiceError",
      code: "FORBIDDEN",
      message: "Worker operation denied",
    });
  });
  it("keeps conflict and unknown outcome distinct and forwards no upstream cause", async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(
      Object.assign(new Error("conflicting token private detail"), {
        code: "conflict",
      })
    );
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Worker identity or lease conflict",
    });
    f.invoke.mockResolvedValueOnce(result);
    expect(await f.service.invoke(context, "status", statusInput)).toEqual(
      result
    );
    const error = new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
    return expect(error).not.toHaveProperty("cause");
  });
  it("rejects oversize, extra authority flags and accessor graphs before database access", async () => {
    const f = fixture();
    await expect(
      f.service.invoke(context, "status", {
        ...statusInput,
        token: "x".repeat(VERTEX_WORKER_REQUEST_MAX_BYTES),
      })
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(
      f.service.invoke(context, "status", { ...statusInput, admin: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const accessor = Object.defineProperty({ ...scope }, "jobId", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not execute");
      },
    });
    await expect(
      f.service.invoke(context, "status", accessor)
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    return expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("bounds and validates every output rather than forwarding database objects", async () => {
    const f = fixture();
    f.invoke.mockResolvedValueOnce({
      ...result,
      privateToken: "do-not-return",
    });
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    f.invoke.mockResolvedValueOnce({
      ...result,
      outputArtifactIds: Array.from(
        { length: 65 },
        (_, index) => `artifact-${index}`
      ),
    });
    await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    f.invoke.mockResolvedValueOnce({ ...result, jobId: "conflicting-job" });
    return await expect(
      f.service.invoke(context, "status", statusInput)
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("rejects noncanonical base64 and decoded artifacts above one MiB before authentication", async () => {
    const f = fixture();
    const staged = {
      ...scope,
      jobId: "job-1",
      leaseId: "worker-1",
      leaseEpoch: "1",
      collectionId: null,
      artifactId: "artifact-1",
      contentBase64: "AB==",
      contentSha256: "a".repeat(64),
      canonicalSha256: null,
      contentType: "application/octet-stream",
      rightsPolicyId: "rights-1",
      rightsVersion: "1",
      lineageArtifactIds: [],
    };
    await expect(
      f.service.invoke(context, "stageArtifact", staged)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const oversized = btoa("a".repeat(1_048_577));
    await expect(
      f.service.invoke(context, "stageArtifact", {
        ...staged,
        contentBase64: oversized,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.authenticate).not.toHaveBeenCalled();
    return expect(f.invoke).not.toHaveBeenCalled();
  });
  return it("routes claim only through the shared dispatcher and returns admission not completion", async () => {
    const f = fixture();
    const input = {
      ...scope,
      workerInstanceId: "worker-1",
      kinds: ["research-run"],
      limit: 1,
      leaseDurationMs: 1000,
    };
    expect(await f.service.invoke(context, "claim", input)).toEqual({
      status: "accepted",
      leases: [],
    });
    expect(f.claim).toHaveBeenCalledWith(identity, input, {});
    expect(f.invoke).not.toHaveBeenCalled();
    return expect(f.authenticate).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/),
      scope,
      "claim"
    );
  });
});
