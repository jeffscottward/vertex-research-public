import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Transaction } from "../../../db/src/server/client.ts";
import {
  evaluateCurrentModelUse,
  modelUseHash,
} from "../../../config/src/vertex/model-use.ts";
import { reserveModelUseBudget } from "../../../db/src/server/vertex-model-use-budget.ts";
import { createVertexModelUseStoreForTransaction } from "../../../db/src/server/vertex-model-use-store.ts";
import {
  ModelUseGrantSchema,
  ModelUseProofSchema,
  ModelUseRequestSchema,
  parseModelUseRequest,
} from "./vertex-model-use.ts";
import {
  modelUseBoundary,
  modelUseFixture,
} from "./vertex-model-use.test-support.ts";
import { fixtureAt, fixtureExpires } from "./vertex-policy.test-support.ts";

// Source authored only. No test/runtime imports, database or model effects run.
const driver = (
  responses: readonly (readonly Record<string, unknown>[])[] = []
) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  let index = 0;
  const tx = {
    execute: async (query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      return { rows: responses[index++] ?? [] };
    },
  } as unknown as Transaction;
  return { tx, queries };
};

describe("independent current model-use permission", () => {
  it("binds request identity, actual input digest and explicit tokenize/completion operations", async () => {
    const { request } = await modelUseFixture();
    expect(await parseModelUseRequest(request)).toEqual(request);
    await expect(
      parseModelUseRequest({ ...request, inputSha256: "b".repeat(64) })
    ).rejects.toThrow("digest mismatch");
    expect(
      ModelUseRequestSchema.safeParse({ ...request, operation: "read" }).success
    ).toBe(false);
    expect(
      ModelUseRequestSchema.safeParse({ ...request, inputTokens: null }).success
    ).toBe(false);
    expect(
      ModelUseRequestSchema.safeParse({
        ...request,
        operation: "model-tokenize",
        maximumOutputTokens: 1,
      }).success
    ).toBe(false);
    return expect(
      ModelUseRequestSchema.safeParse({ ...request, credential: "forbidden" })
        .success
    ).toBe(false);
  });

  it("never promotes a storage grant or absent independent grant into model authority", async () => {
    const { request, current, principal } = await modelUseFixture();
    const proof = await evaluateCurrentModelUse(
      modelUseBoundary,
      principal,
      request,
      null,
      current,
      fixtureAt
    );
    expect(proof.decision).toBe("denied");
    expect(proof.externalDispatchAllowed).toBe(false);
    return expect(proof.validUntil).toBe(fixtureAt);
  });

  it("issues only exact current proof and never dispatches without DB aggregate admission", async () => {
    const { request, grant, current, principal } = await modelUseFixture();
    const proof = await evaluateCurrentModelUse(
      modelUseBoundary,
      principal,
      request,
      grant,
      current,
      fixtureAt
    );
    expect(proof.decision).toBe("allowed");
    expect(proof.externalDispatchAllowed).toBe(false);
    expect(proof.currentEvidenceSha256).toBe(
      await modelUseHash(modelUseBoundary, request.evidence)
    );
    expect(proof.requestSha256).toBe(request.requestSha256);
    expect(proof.grantRevision).toBe("1");
    expect(proof.validUntil).toBe(fixtureExpires);
    return expect(
      ModelUseProofSchema.safeParse({
        ...proof,
        decision: "denied",
        externalDispatchAllowed: true,
      }).success
    ).toBe(false);
  });

  it("rejects stale grant, newer review, changed original bytes, scope and tokenizer aliases", async () => {
    const { request, grant, current, principal } = await modelUseFixture();
    for (const changed of [
      { ...current, lease: { ...current.lease, leaseEpoch: "2" } },
      {
        ...current,
        selection: { ...current.selection, tokenizerSha256: "b".repeat(64) },
      },
      {
        ...current,
        evidence: current.evidence.map((entry) => ({
          ...entry,
          reviewId: "newer-review",
        })),
      },
      {
        ...current,
        evidence: current.evidence.map((entry) => ({
          ...entry,
          originalArtifactSha256: "b".repeat(64),
        })),
      },
      { ...current, authenticatedActorId: "different-service" },
    ]) {
      expect(
        (
          await evaluateCurrentModelUse(
            modelUseBoundary,
            principal,
            request,
            grant,
            changed,
            fixtureAt
          )
        ).decision
      ).toBe("denied");
    }
    expect(
      (
        await evaluateCurrentModelUse(
          modelUseBoundary,
          principal,
          request,
          { ...grant, status: "revoked" },
          current,
          fixtureAt
        )
      ).decision
    ).toBe("denied");
    return expect(
      (
        await evaluateCurrentModelUse(
          modelUseBoundary,
          principal,
          request,
          grant,
          current,
          fixtureExpires
        )
      ).decision
    ).toBe("denied");
  });

  it("requires exact current privacy and reserved request bounds instead of reusable true", async () => {
    const { request, grant, current, principal } = await modelUseFixture();
    expect(
      (
        await evaluateCurrentModelUse(
          modelUseBoundary,
          principal,
          request,
          grant,
          { ...current, budget: undefined } as unknown as typeof current,
          fixtureAt
        )
      ).decision
    ).toBe("denied");
    expect(
      (
        await evaluateCurrentModelUse(
          modelUseBoundary,
          principal,
          request,
          grant,
          {
            ...current,
            privacy: { ...current.privacy, requestSha256: "b".repeat(64) },
          },
          fixtureAt
        )
      ).decision
    ).toBe("denied");
    return expect(
      (
        await evaluateCurrentModelUse(
          modelUseBoundary,
          principal,
          request,
          grant,
          {
            ...current,
            budget: { ...current.budget!, maximumOutputTokens: 3 },
          },
          fixtureAt
        )
      ).decision
    ).toBe("denied");
  });

  it("allows privileged revocation metadata after expiry without reviving permission", async () => {
    const { grant } = await modelUseFixture();
    expect(
      ModelUseGrantSchema.safeParse({
        ...grant,
        status: "revoked",
        issuedAt: "2026-09-23T12:00:00Z",
      }).success
    ).toBe(true);
    return expect(
      ModelUseGrantSchema.safeParse({
        ...grant,
        status: "granted",
        issuedAt: "2026-09-23T12:00:00Z",
      }).success
    ).toBe(false);
  });

  it("charges durable aggregate and whole-job ceilings before allowing one external attempt", async () => {
    const { request, grant, current } = await modelUseFixture();
    const db = driver([
      [],
      [{ tokens: "0", cost: "0" }],
      [],
      [{ revision: "1" }],
      [],
    ]);
    const result = await reserveModelUseBudget(
      db.tx,
      modelUseBoundary,
      request,
      grant,
      current.budgetAdmission,
      fixtureAt
    );
    expect(result.externalDispatchAllowed).toBe(true);
    const writes = db.queries.filter((query) => query.sql.startsWith("insert"));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.sql).toContain("vertex_model_use_budget_windows");
    expect(writes[1]?.sql).toContain("vertex_model_use_budget_reservations");
    expect(writes[1]?.params).toContain("110");
    expect(writes[1]?.params).toContain(
      modelUseBoundary.decimalUnits(grant.maximumCostUsd).toString()
    );
    return expect(db.queries[1]?.sql).not.toContain("expires_at_ns");
  });

  it("retains uncertain and expired prior charges rather than crediting the next request", async () => {
    const { request, grant, current } = await modelUseFixture();
    const db = driver([[], [{ tokens: "991", cost: "0" }]]);
    await expect(
      reserveModelUseBudget(
        db.tx,
        modelUseBoundary,
        request,
        grant,
        current.budgetAdmission,
        fixtureAt
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(db.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
    return expect(
      db.queries.some((query) =>
        /delete|released_at|expires_at_ns >/.test(query.sql)
      )
    ).toBe(false);
  });

  it("same exact admitted request rechecks but cannot dispatch or reserve twice", async () => {
    const { request, grant, current } = await modelUseFixture();
    const first = driver([
      [],
      [{ tokens: "0", cost: "0" }],
      [],
      [{ revision: "1" }],
      [],
    ]);
    await reserveModelUseBudget(
      first.tx,
      modelUseBoundary,
      request,
      grant,
      current.budgetAdmission,
      fixtureAt
    );
    const insert = first.queries.find((query) =>
      query.sql.startsWith("insert into vertex_model_use_budget_reservations")
    )!;
    const body = JSON.parse(insert.params[16] as string);
    const row = {
      payload: body,
      record_hash: await modelUseHash(modelUseBoundary, body),
      window_id: body.windowId,
      request_id: request.requestId,
      grant_id: request.grantId,
      grant_version: request.grantVersion,
      lease_id: request.leaseId,
      lease_epoch: request.leaseEpoch,
      selection_sha256: request.selectionSha256,
      token_charge: "110",
      cost_charge_units: modelUseBoundary
        .decimalUnits(grant.maximumCostUsd)
        .toString(),
      reservation_id: body.reservation.reservationId,
    };
    const second = driver([[row]]);
    expect(
      (
        await reserveModelUseBudget(
          second.tx,
          modelUseBoundary,
          request,
          grant,
          current.budgetAdmission,
          fixtureAt
        )
      ).externalDispatchAllowed
    ).toBe(false);
    return expect(second.queries).toHaveLength(1);
  });

  it("requires separate privileged issue authorization and optimistic revision", async () => {
    const { grant } = await modelUseFixture();
    const db = driver();
    const repository = createVertexModelUseStoreForTransaction(db.tx, {
      boundary: modelUseBoundary,
      clock: { now: () => fixtureAt },
      authorization: { authorize: async () => true },
      privilegedAuthorization: { authorize: async () => false },
      currentUseContext: async () => null,
    });
    await expect(
      repository.issueGrant({
        principal: { actorId: grant.issuedByActorId },
        grant,
        expectedRevision: null,
        commandId: "synthetic-issue",
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      db.queries.every((query) => !query.sql.startsWith("insert"))
    ).toBe(true);
  });
});
