import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  LATER,
  reviewer,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { WorkerResultSchema } from "../contracts/vertex-worker.ts";
import {
  TIMEOUT,
  closures,
  complete,
  consumedCompletion,
  copyCalls,
  inputOnlyClosure,
  job,
  noOrdinaryAdvisory,
  observations,
  originalChatReadGrant,
  origins,
  outputOwner,
  publishedOutput,
  shortenChatReadGrant,
  stageAdvisory,
} from "./vertex-research-chat-output-runtime.test-support.ts";

// SOURCE ONLY: no executions/results claimed. All positive authority is issued
// by the actual fixture owners. Only SQL/object/R2/provider/clock boundaries are
// synthetic; pre-existing selected technical history remains explicitly so.
// Raw authenticated-worker response bytes are NOT provider attestation. This
// suite does not append chat messages, activate providers or qualify erasure.
describe("actual governed advisory, original publication and independent terminal fence ownership", () => {
  it(
    "private caller denial is not owner-family revocation and cleanup authority is never inherited",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await publishedOutput(f, consumed);
      await complete(f, "succeeded", [f.plan.runId]);
      const privateReader = { actorId: "other-private-output-reader" };
      await f.grant(privateReader.actorId, "account-scope", ["read"]);
      await f.grant(privateReader.actorId, "research-chat", ["read"]);
      const before = canonicalArtifactJson(f.table(closures)),
        fences = copyCalls(f, "fence").length;
      await expect(
        outputOwner(f).readAdvisory(privateReader, scope, f.responseRequestId)
      ).rejects.toThrow();
      await expect(
        outputOwner(f).readPrivateDeliverySource(
          privateReader,
          scope,
          f.responseRequestId
        )
      ).rejects.toThrow();
      for (const principal of [
        owner,
        { actorId: f.identity.servicePrincipalId },
        { actorId: "fixture-grant-admin" },
      ])
        await expect(
          f.runtime.drainApprovedCopyCleanup(principal, f.selector)
        ).rejects.toThrow();
      expect(canonicalArtifactJson(f.table(closures))).toBe(before);
      expect(copyCalls(f, "fence")).toHaveLength(fences);
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      const cleaner = await f.grantCleanup();
      return expect(
        (await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)).every(
          (entry) => entry.status === "fenced"
        )
      ).toBe(true);
    },
    TIMEOUT
  );
  for (const mode of ["unknown-before", "unknown-after"] as const)
    it(
      `one ${mode} input fence is never a fabricated eligibility ACK`,
      async () => {
        const f = await chatWorkerFixture(),
          consumed = await consumedCompletion(f);
        await publishedOutput(f, consumed);
        await complete(f, "succeeded", [f.plan.runId]);
        let completedFences = 0;
        f.copies.state.afterFence = async () => {
          completedFences += 1;
          if (completedFences === (mode === "unknown-before" ? 2 : 3))
            f.copies.state.fenceMode = mode;
          return;
        };
        const cleaner = await f.grantCleanup(),
          first = await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector);
        expect(first.filter((entry) => entry.status === "fenced")).toHaveLength(
          2
        );
        expect(
          first.filter((entry) => entry.status === "unknown")
        ).toHaveLength(1);
        expect(
          f.table(observations).filter((row) => row["operation"] === "fence")
        ).toHaveLength(2);
        expect(
          await outputOwner(f).readPrivateDeliverySource(
            owner,
            scope,
            f.responseRequestId
          )
        ).toBeNull();
        f.copies.state.fenceMode = "normal";
        f.copies.state.afterFence = async () => undefined;
        const replay = await f.runtime.drainApprovedCopyCleanup(
          cleaner,
          f.selector
        );
        expect(copyCalls(f, "fence")).toHaveLength(3);
        const source = await outputOwner(f).readPrivateDeliverySource(
          owner,
          scope,
          f.responseRequestId
        );
        if (mode === "unknown-before") {
          expect(
            replay.filter((entry) => entry.status === "unknown")
          ).toHaveLength(1);
          expect(source).toBeNull();
        } else {
          expect(replay.every((entry) => entry.status === "fenced")).toBe(true);
          expect(source!.inputFenceAcknowledgements).toHaveLength(3);
        }
        return expect(
          await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
        ).toEqual(consumed.decoded.bytes);
      },
      TIMEOUT
    );
  for (const bound of ["storage-review", "corpus-review"] as const)
    it(
      `retained advisory cannot outlive its ORIGINAL ${bound} deadline`,
      async () => {
        const f = await chatWorkerFixture(
            bound === "storage-review"
              ? { storageReviewExpiresAt: LATER }
              : { corpusReviewExpiresAt: LATER }
          ),
          consumed = await consumedCompletion(f);
        await stageAdvisory(f, consumed);
        expect(
          await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
        ).toEqual(consumed.decoded.bytes);
        f.state.at = LATER;
        await expect(
          outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
        ).rejects.toThrow();
        expect(
          f
            .table(closures)
            .map((row) => row["domain"])
            .sort()
        ).toEqual(["derived", "inputs"]);
        return expect(
          f
            .table(closures)
            .some(
              (row) =>
                row["payload"].cause ===
                (bound === "storage-review"
                  ? "storage-review-expired"
                  : "corpus-review-expired")
            )
        ).toBe(true);
      },
      TIMEOUT
    );
  for (const domain of ["corpus", "private"] as const)
    it(
      `actual ${domain} rights expiry closes retained visibility without extending prior approval`,
      async () => {
        const f = await chatWorkerFixture(),
          consumed = await consumedCompletion(f);
        await stageAdvisory(f, consumed);
        f.state.at = LATER;
        const previous =
          domain === "corpus"
            ? f.corpus.metadata.rights
            : f.config.metadata.rights;
        await f.store.putRights(
          { actorId: "fixture-grant-admin" },
          scope,
          domain === "corpus" ? f.plan.collectionId : null,
          {
            ...previous,
            version: "2.0.0",
            status: "expired",
            checkedAt: LATER,
            expiresAt: LATER,
          }
        );
        await expect(
          outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
        ).rejects.toThrow();
        expect(
          f
            .table(closures)
            .map((row) => row["domain"])
            .sort()
        ).toEqual(["derived", "inputs"]);
        return expect(
          f
            .table(closures)
            .some((row) => row["payload"].cause === "rights-expiry")
        ).toBe(true);
      },
      TIMEOUT
    );
  it(
    "a genuine superseding storage review cannot upgrade the retained original approval",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await stageAdvisory(f, consumed);
      const original = f.table("vertex_research_chat_storage_reviews")[0]!;
      f.state.at = LATER;
      await f.runtime.recordResearchChatStorageQualificationReview(reviewer, {
        ...f.reviewInput(f.plan),
        expectedReviewId: original["review_id"],
        decision: "accepted",
        idempotencyKey: "new-storage-review-after-output",
      });
      await expect(
        outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).rejects.toThrow();
      expect(
        f
          .table(closures)
          .some(
            (row) =>
              row["domain"] === "derived" &&
              row["payload"].cause === "storage-review-superseded"
          )
      ).toBe(true);
      return expect(
        f.table("vertex_research_chat_execution_approvals")
      ).toHaveLength(1);
    },
    TIMEOUT
  );
});

describe("original caller read privilege is not global chat-family authority", () => {
  const readMethods = ["advisory", "delivery-source"] as const;
  for (const method of readMethods)
    for (const phase of ["final-metadata", "final-commit"] as const)
      it(
        `${method} denies a genuinely shortened caller grant expiring at ${phase} without closing original domains`,
        async () => {
          const f = await chatWorkerFixture(),
            consumed = await consumedCompletion(f);
          if (method === "advisory") {
            await stageAdvisory(f, consumed);
          } else {
            await publishedOutput(f, consumed);
            await complete(f, "succeeded", [f.plan.runId]);
            const cleaner = await f.grantCleanup();
            expect(
              (
                await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)
              ).every((entry) => entry.status === "fenced")
            ).toBe(true);
            inputOnlyClosure(f);
          }
          await shortenChatReadGrant(f);
          const invokeRead = async () => {
            return method === "advisory"
              ? outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
              : outputOwner(f).readPrivateDeliverySource(
                  owner,
                  scope,
                  f.responseRequestId
                );
          };
          // Positive control uses the same genuinely issued shorter CURRENT grant.
          expect(await invokeRead()).not.toBeNull();
          const originalClosures = canonicalArtifactJson(f.table(closures)),
            originalFamily = canonicalArtifactJson(
              f.table("vertex_research_chat_copy_closures")
            );
          let readStorage = false,
            observedFinalMetadata = false,
            crossed = false,
            fenceReads = 0;
          f.copies.state.afterRead = async (binding) => {
            if (binding.copyId === f.recipe.copies.advisory.copyId)
              readStorage = true;
            return;
          };
          f.state.afterQuery = (query) => {
            const text = query.sql.replaceAll('"', "");
            if (
              method === "advisory" &&
              readStorage &&
              text.includes(`from ${origins}`)
            )
              observedFinalMetadata = true;
            if (
              method === "delivery-source" &&
              text.includes(`from ${observations}`) &&
              (text.includes("operation = 'fence'") ||
                query.params.includes("fence"))
            ) {
              fenceReads += 1;
              if (fenceReads === 3) observedFinalMetadata = true;
            }
            if (
              phase === "final-metadata" &&
              observedFinalMetadata &&
              !crossed
            ) {
              crossed = true;
              return (f.state.at = LATER);
            }
            return;
          };
          f.state.afterCommit = () => {
            if (phase === "final-commit" && observedFinalMetadata && !crossed) {
              crossed = true;
              return (f.state.at = LATER);
            }
            return;
          };
          try {
            await expect(invokeRead()).rejects.toThrow();
          } finally {
            f.state.afterQuery = () => {
              f.state.afterCommit = () => {
                f.copies.state.afterRead = async () => undefined;
              };
            };
          }
          expect(observedFinalMetadata).toBe(true);
          expect(crossed).toBe(true);
          if (method === "advisory") {
            expect(readStorage).toBe(true);
          } else expect(fenceReads).toBe(3);
          expect(timestampToEpochNanoseconds(f.state.at)).toBeLessThan(
            timestampToEpochNanoseconds(f.plan.expiresAt)
          );
          expect(timestampToEpochNanoseconds(f.state.at)).toBeLessThan(
            timestampToEpochNanoseconds(f.lease.leaseExpiresAt)
          );
          expect(canonicalArtifactJson(f.table(closures))).toBe(
            originalClosures
          );
          expect(
            canonicalArtifactJson(f.table("vertex_research_chat_copy_closures"))
          ).toBe(originalFamily);
          expect(f.table(closures).map((row) => row["domain"])).toEqual(
            method === "advisory" ? [] : ["inputs"]
          );
          await expect(invokeRead()).rejects.toThrow();
          expect(canonicalArtifactJson(f.table(closures))).toBe(
            originalClosures
          );
          expect(f.table(origins)).toHaveLength(1);
          return noOrdinaryAdvisory(f);
        },
        TIMEOUT
      );

  return it(
    "a genuine owner chat-read revoke cannot roll back expired-worker unknown state or input-only closure",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await stageAdvisory(f, consumed);
      const original = originalChatReadGrant(f),
        originalApprovals = canonicalArtifactJson(
          f.table("vertex_research_chat_execution_approvals")
        );
      expect(
        await f.authorization.revokeGrant({
          principal: { actorId: original.recordedByActorId },
          scope,
          collectionId: null,
          grantId: original.grantId,
          expectedVersion: "1.0.0",
          version: "2.0.0",
        })
      ).toBe("recorded");
      const revoked = f
        .table("vertex_grant_versions")
        .find(
          (row) =>
            row["grant_id"] === original.grantId && row["version"] === "2.0.0"
        )!;
      expect(revoked["payload"].status).toBe("revoked");
      const contextBinding = f
        .table("vertex_grant_bindings")
        .find(
          (row) =>
            row["grantee_actor_id"] === owner.actorId &&
            row["resource_id"] ===
              `research-chat-context-use:${f.responseRequestId}`
        )!;
      const context = f
        .table("vertex_grant_versions")
        .find(
          (row) =>
            row["grant_id"] === contextBinding["grant_id"] &&
            row["version"] === "1.0.0"
        )!["payload"];
      f.state.at = f.lease.leaseExpiresAt;
      expect(context.status).toBe("granted");
      for (const expiresAt of [
        context.expiresAt,
        f.corpus.metadata.rights.expiresAt,
        f.config.metadata.rights.expiresAt,
        f.plan.expiresAt,
      ])
        expect(timestampToEpochNanoseconds(expiresAt)).toBeGreaterThan(
          timestampToEpochNanoseconds(f.state.at)
        );
      expect(f.table(closures)).toHaveLength(0);
      const externalCalls = structuredClone(f.copies.calls),
        dispatches = canonicalArtifactJson(
          f.table("vertex_research_chat_model_dispatches")
        );
      const status = WorkerResultSchema.parse(
        await f.worker.invoke(f.identity, "status", {
          ...scope,
          jobId: f.lease.jobId,
        })
      );
      expect(status.state).toBe("unknown");
      expect(job(f)["state"]).toBe("unknown");
      inputOnlyClosure(f);
      expect(f.table(closures)[0]!["payload"].cause).toBe(
        "response-attempt-terminal"
      );
      expect(f.copies.calls).toEqual(externalCalls);
      expect(
        canonicalArtifactJson(f.table("vertex_research_chat_model_dispatches"))
      ).toBe(dispatches);
      expect(
        canonicalArtifactJson(
          f.table("vertex_research_chat_execution_approvals")
        )
      ).toBe(originalApprovals);
      await expect(
        outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).rejects.toThrow();
      inputOnlyClosure(f);
      const repeated = WorkerResultSchema.parse(
        await f.worker.invoke(f.identity, "status", {
          ...scope,
          jobId: f.lease.jobId,
        })
      );
      expect(repeated.state).toBe("unknown");
      inputOnlyClosure(f);
      expect(f.table(origins)).toHaveLength(1);
      return expect(consumed.providerCalls).toEqual([
        "model-tokenize",
        "model-completion",
      ]);
    },
    TIMEOUT
  );
});
