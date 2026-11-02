import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  SENTINELS,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  WorkerReadArtifactOutputSchema,
  WorkerStageArtifactOutputSchema,
  WorkerResultSchema,
} from "../contracts/vertex-worker.ts";
import {
  TIMEOUT,
  answerText,
  base64,
  closures,
  complete,
  consumedCompletion,
  copyCalls,
  decoder,
  effects,
  encoder,
  inputIds,
  inputOnlyClosure,
  job,
  jsonBytes,
  noOrdinaryAdvisory,
  observations,
  origins,
  outputOwner,
  providerExtra,
  publicationInput,
  publishedOutput,
  reviewModel,
  stageAdvisory,
  unbase64,
} from "./vertex-research-chat-output-runtime.test-support.ts";

// SOURCE ONLY: no executions/results claimed. All positive authority is issued
// by the actual fixture owners. Only SQL/object/R2/provider/clock boundaries are
// synthetic; pre-existing selected technical history remains explicitly so.
// Raw authenticated-worker response bytes are NOT provider attestation. This
// suite does not append chat messages, activate providers or qualify erasure.
describe("actual governed advisory, original publication and independent terminal fence ownership", () => {
  it(
    "consumes admitted bytes, writes only governed fourth copy, publishes exact public run and waits for all three real fence ACKs",
    async () => {
      const f = await chatWorkerFixture(),
        human = canonicalArtifactJson(f.table("vertex_research_chat_messages")),
        consumed = await consumedCompletion(f);
      const publication = await publishedOutput(f, consumed);
      noOrdinaryAdvisory(f);
      expect(copyCalls(f, "create")).toHaveLength(4);
      expect(f.table(origins)).toHaveLength(1);
      expect(
        f.table("vertex_research_chat_copy_content_bindings")
      ).toHaveLength(4);
      expect(Object.keys(consumed.decoded.profile).sort()).toEqual(
        [
          "profile",
          "responseRequestId",
          "planId",
          "planSha256",
          "runId",
          "traceId",
          "taskContract",
          "modelVersion",
          "modelUseRequestSha256",
          "responseSha256",
          "usage",
          "output",
          "executionAuthorized",
        ].sort()
      );
      expect(await hashArtifact(consumed.responseBytes)).toBe(
        consumed.decoded.responseSha256
      );
      expect(decoder.decode(consumed.decoded.bytes)).not.toContain(
        providerExtra
      );
      const workerRead = WorkerReadArtifactOutputSchema.parse(
        await f.worker.invoke(f.identity, "readArtifact", {
          ...f.fence,
          collectionId: null,
          artifactId: f.recipe.copies.advisory.copyId,
        })
      );
      expect(workerRead.canonicalSha256).toBe(consumed.contentSha256);
      expect(unbase64(workerRead.contentBase64)).toEqual(
        consumed.decoded.bytes
      );
      const ordinary = f.ordinaryWrites
        .map((key) => decoder.decode(f.objects.get(key)!.body))
        .join("\n");
      const metadata = canonicalArtifactJson([
        f.table(origins),
        f.table("vertex_worker_agent_publications"),
        f.table("vertex_research_chat_model_dispatches"),
      ]);
      for (const text of [
        answerText,
        providerExtra,
        SENTINELS.human,
        SENTINELS.query,
        SENTINELS.persona,
      ]) {
        expect(ordinary).not.toContain(text);
        expect(metadata).not.toContain(text);
      }
      expect(
        await outputOwner(f).readPrivateDeliverySource(
          owner,
          scope,
          f.responseRequestId
        )
      ).toBeNull();
      const terminal = await complete(f, "succeeded", [f.plan.runId]);
      expect(terminal).toMatchObject({
        state: "succeeded",
        outputArtifactIds: [f.plan.runId],
      });
      inputOnlyClosure(f);
      expect(
        await outputOwner(f).readPrivateDeliverySource(
          owner,
          scope,
          f.responseRequestId
        )
      ).toBeNull();
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      await expect(
        f.worker.invoke(f.identity, "readArtifact", {
          ...f.fence,
          collectionId: null,
          artifactId: f.recipe.copies.advisory.copyId,
        })
      ).rejects.toThrow();
      const cleaner = await f.grantCleanup(),
        cleaned = await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector);
      expect(cleaned).toHaveLength(3);
      expect(cleaned.every((entry) => entry.status === "fenced")).toBe(true);
      expect(
        copyCalls(f, "fence")
          .map((call) => call.copyId)
          .sort()
      ).toEqual(inputIds(f).sort());
      const source = await outputOwner(f).readPrivateDeliverySource(
        owner,
        scope,
        f.responseRequestId
      );
      expect(source).not.toBeNull();
      expect(source!.run).toEqual(publication.run);
      expect(source!.runArtifact).toEqual(publication.publish.artifact);
      expect(source!.advisoryArtifact).toEqual(
        publication.publish.advisoryProfileArtifact
      );
      const realAcks = f
        .table(observations)
        .filter((row) => row["operation"] === "fence");
      expect(realAcks).toHaveLength(3);
      for (const ack of source!.inputFenceAcknowledgements)
        expect(
          realAcks.find((row) => row["copy_id"] === ack["copyId"])!["payload"]
        ).toEqual(ack);
      expect(Object.keys(source!).sort()).toEqual(
        [
          "run",
          "runArtifact",
          "advisoryArtifact",
          "inputFenceAcknowledgements",
        ].sort()
      );
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      expect(
        canonicalArtifactJson(f.table("vertex_research_chat_messages"))
      ).toBe(human);
      expect(consumed.providerCalls).toEqual([
        "model-tokenize",
        "model-completion",
      ]);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(2);
      return expect(
        f.table("vertex_model_use_budget_reservations")
      ).toHaveLength(2);
    },
    TIMEOUT
  );
  it(
    "owner continuation survives the old worker lease deadline but not the original plan deadline",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await publishedOutput(f, consumed);
      await complete(f, "succeeded", [f.plan.runId]);
      const cleaner = await f.grantCleanup();
      await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector);
      expect(timestampToEpochNanoseconds(f.lease.leaseExpiresAt)).toBeLessThan(
        timestampToEpochNanoseconds(f.plan.expiresAt)
      );
      f.state.at = f.lease.leaseExpiresAt;
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      expect(
        await outputOwner(f).readPrivateDeliverySource(
          owner,
          scope,
          f.responseRequestId
        )
      ).not.toBeNull();
      await expect(
        f.worker.invoke(f.identity, "readArtifact", {
          ...f.fence,
          collectionId: null,
          artifactId: f.recipe.copies.advisory.copyId,
        })
      ).rejects.toThrow();
      f.state.at = f.plan.expiresAt;
      await expect(
        outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).rejects.toThrow();
      return expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
    },
    TIMEOUT
  );
  it(
    "unknown-before advisory create keeps one durable intent and never repeats CREATE or returns a false stage ACK",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f),
        id = f.recipe.copies.advisory.copyId;
      f.copies.state.createMode = "unknown-before";
      await expect(
        f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
      ).rejects.toThrow();
      expect(
        f
          .table(effects)
          .filter(
            (row) => row["copy_id"] === id && row["operation"] === "create"
          )
      ).toHaveLength(1);
      expect(
        f.table(observations).filter((row) => row["copy_id"] === id)
      ).toHaveLength(0);
      f.copies.state.createMode = "normal";
      await expect(
        f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
      ).rejects.toThrow();
      expect(copyCalls(f, "create", id)).toHaveLength(1);
      expect(f.table(origins)).toHaveLength(1);
      await expect(
        outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).rejects.toThrow();
      await expect(complete(f, "succeeded", [])).rejects.toThrow();
      expect(job(f)["state"]).toBe("running");
      noOrdinaryAdvisory(f);
      return expect(consumed.providerCalls).toHaveLength(2);
    },
    TIMEOUT
  );
  it(
    "unknown-after advisory create can reconcile the SAME actual object without another CREATE",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f),
        id = f.recipe.copies.advisory.copyId;
      f.copies.state.createMode = "unknown-after";
      f.copies.state.inspectMissing = true;
      await expect(
        f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
      ).rejects.toThrow();
      expect(
        f.table(observations).filter((row) => row["copy_id"] === id)
      ).toHaveLength(0);
      f.copies.state.createMode = "normal";
      f.copies.state.inspectMissing = false;
      const reconciled = WorkerStageArtifactOutputSchema.parse(
        await f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
      );
      expect(reconciled.status).toBe("duplicate");
      expect(copyCalls(f, "create", id)).toHaveLength(1);
      expect(
        f
          .table(observations)
          .filter(
            (row) => row["copy_id"] === id && row["operation"] === "create"
          )
      ).toHaveLength(1);
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      return noOrdinaryAdvisory(f);
    },
    TIMEOUT
  );
  it(
    "rejects raw response, usage, request, proof and retained-hash substitutions before any advisory intent",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      const badUsage = structuredClone(consumed.native);
      badUsage.usage.prompt_tokens += 1;
      badUsage.usage.total_tokens += 1;
      const changed = await f.completionRequest(38);
      const attempts = [
        {
          ...consumed.stage,
          chatCompletion: {
            ...consumed.stage.chatCompletion!,
            responseBase64: base64(
              encoder.encode(`${decoder.decode(consumed.responseBytes)}\n`)
            ),
          },
        },
        {
          ...consumed.stage,
          chatCompletion: {
            ...consumed.stage.chatCompletion!,
            responseBase64: base64(jsonBytes(badUsage)),
          },
        },
        {
          ...consumed.stage,
          chatCompletion: {
            ...consumed.stage.chatCompletion!,
            request: changed,
          },
        },
        {
          ...consumed.stage,
          chatCompletion: {
            ...consumed.stage.chatCompletion!,
            proof: consumed.before,
          },
        },
        {
          ...consumed.stage,
          chatCompletion: {
            ...consumed.stage.chatCompletion!,
            proof: { ...consumed.after, currentEvidenceSha256: "a".repeat(64) },
          },
        },
        {
          ...consumed.stage,
          contentSha256: "b".repeat(64),
          canonicalSha256: "b".repeat(64),
        },
        { ...consumed.stage, lineageArtifactIds: [] },
        { ...consumed.stage, rightsVersion: "unowned-rights-version" },
        {
          ...consumed.stage,
          contentBase64: base64(
            jsonBytes({
              ...consumed.decoded.profile,
              responseSha256: "c".repeat(64),
            })
          ),
        },
      ];
      for (const attempted of attempts)
        await expect(
          f.worker.invoke(f.identity, "stageArtifact", attempted)
        ).rejects.toThrow();
      expect(f.table(origins)).toHaveLength(0);
      expect(
        copyCalls(f, "create", f.recipe.copies.advisory.copyId)
      ).toHaveLength(0);
      return noOrdinaryAdvisory(f);
    },
    TIMEOUT
  );
  for (const firstDispatch of [true, false])
    it(
      `requires the genuine ${firstDispatch ? "first-dispatch" : "post-return"} original audit row`,
      async () => {
        const f = await chatWorkerFixture(),
          consumed = await consumedCompletion(f);
        const audit = f
          .table("vertex_model_use_proof_audits")
          .find(
            (row) =>
              row["request_id"] === consumed.request.requestId &&
              row["payload"].externalDispatchAllowed === firstDispatch
          )!;
        expect(audit).toBeDefined();
        audit["record_hash"] = "d".repeat(64); // Negative external SQL corruption only.
        await expect(
          f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
        ).rejects.toThrow();
        expect(
          copyCalls(f, "create", f.recipe.copies.advisory.copyId)
        ).toHaveLength(0);
        return expect(f.table(origins)).toHaveLength(0);
      },
      TIMEOUT
    );
  it(
    "cannot route retained answer bytes into arbitrary IDs, wrong collection, missing extension or the public-run sink",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await stageAdvisory(f, consumed);
      const before = f.ordinaryWrites.length,
        { chatCompletion: omittedExtension, ...withoutExtension } =
          consumed.stage;
      expect(omittedExtension).toBeDefined();
      const attempts = [
        { ...consumed.stage, artifactId: "arbitrary-answer-sink" },
        { ...withoutExtension, artifactId: "arbitrary-ordinary-answer-sink" },
        { ...consumed.stage, collectionId: null },
        withoutExtension,
        {
          ...withoutExtension,
          artifactId: f.plan.runId,
          lineageArtifactIds: [],
        },
        { ...consumed.stage, artifactId: f.plan.runId, lineageArtifactIds: [] },
      ];
      for (const attempted of attempts)
        await expect(
          f.worker.invoke(f.identity, "stageArtifact", attempted)
        ).rejects.toThrow();
      expect(f.ordinaryWrites).toHaveLength(before);
      expect(
        f
          .table("vertex_worker_stages")
          .some((row) => row["artifact_id"] === f.plan.runId)
      ).toBe(false);
      noOrdinaryAdvisory(f);
      return await expect(
        f.worker.invoke(f.identity, "readArtifact", {
          ...f.fence,
          collectionId: f.plan.collectionId,
          artifactId: f.recipe.copies.advisory.copyId,
        })
      ).rejects.toThrow();
    },
    TIMEOUT
  );
  it(
    "an original deadline crossed after the external CREATE cannot settle a live output ACK or reopen either domain",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f),
        id = f.recipe.copies.advisory.copyId;
      f.copies.state.afterCreate = async (binding) => {
        if (binding.copyId === id) f.state.at = f.plan.expiresAt;
        return;
      };
      await expect(
        f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
      ).rejects.toThrow();
      expect(copyCalls(f, "create", id)).toHaveLength(1);
      expect(
        f
          .table(effects)
          .filter(
            (row) => row["copy_id"] === id && row["operation"] === "create"
          )
      ).toHaveLength(1);
      expect(
        f
          .table(observations)
          .filter(
            (row) => row["copy_id"] === id && row["operation"] === "create"
          )
      ).toHaveLength(0);
      expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
      await expect(
        outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).rejects.toThrow();
      return noOrdinaryAdvisory(f);
    },
    TIMEOUT
  );
  it(
    "lost actual publication ACK followed by unknown[] preserves public provenance and owned outputs without reopening",
    async () => {
      const f = await chatWorkerFixture(),
        consumed = await consumedCompletion(f);
      await stageAdvisory(f, consumed);
      const publication = await publicationInput(f, consumed);
      await f.worker.invoke(f.identity, "stageArtifact", publication.stage);
      let loseAcknowledgement = true;
      f.state.afterCommit = () => {
        if (
          loseAcknowledgement &&
          f
            .table("vertex_worker_agent_publications")
            .some((row) => row["run_id"] === f.plan.runId)
        ) {
          loseAcknowledgement = false;
          throw new Error("Synthetic lost publication commit acknowledgement");
        }
        return;
      };
      await expect(
        f.worker.invoke(f.identity, "publishAgent", publication.publish)
      ).rejects.toThrow();
      f.state.afterCommit = () => ({});
      expect(loseAcknowledgement).toBe(false);
      const durable = structuredClone(
        f
          .table("vertex_worker_agent_publications")
          .find((row) => row["run_id"] === f.plan.runId)!
      );
      expect(job(f)["output_artifact_ids"]).toEqual([f.plan.runId]);
      const terminal = await complete(f, "unknown", []);
      expect(terminal).toMatchObject({
        state: "unknown",
        outputArtifactIds: [f.plan.runId],
      });
      const status = WorkerResultSchema.parse(
        await f.worker.invoke(f.identity, "status", {
          ...scope,
          jobId: f.lease.jobId,
        })
      );
      expect(status.outputArtifactIds).toEqual([f.plan.runId]);
      inputOnlyClosure(f);
      expect(
        f
          .table("vertex_worker_agent_publications")
          .find((row) => row["run_id"] === f.plan.runId)
      ).toEqual(durable);
      const cleaner = await f.grantCleanup();
      await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector);
      expect(
        await outputOwner(f).readPrivateDeliverySource(
          owner,
          scope,
          f.responseRequestId
        )
      ).toBeNull();
      expect(
        await outputOwner(f).readAdvisory(owner, scope, f.responseRequestId)
      ).toEqual(consumed.decoded.bytes);
      await expect(complete(f, "succeeded", [f.plan.runId])).rejects.toThrow();
      await expect(f.modelUseRequest(consumed.request)).rejects.toThrow();
      expect(consumed.providerCalls).toEqual([
        "model-tokenize",
        "model-completion",
      ]);
      return expect(
        f.table("vertex_research_chat_model_dispatches")
      ).toHaveLength(2);
    },
    TIMEOUT
  );
  for (const permission of [
    "stageArtifact",
    "publishAgent",
    "complete",
  ] as const)
    it(
      `missing ORIGINAL service ${permission} permission prevents new model budgets and dispatch`,
      async () => {
        const f = await chatWorkerFixture({
          omitServiceOperation: permission,
        });
        await Promise.allSettled([reviewModel(f, f.tokenizeRequest)]);
        const [result] = await Promise.allSettled([
          f.modelUseRequest(f.tokenizeRequest),
        ]);
        if (result!.status === "fulfilled")
          expect(result!.value).toMatchObject({
            decision: "denied",
            externalDispatchAllowed: false,
          });
        expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(0);
        expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(
          0
        );
        return expect(f.table(closures)).toHaveLength(0);
      },
      TIMEOUT
    );
  it(
    "missing concrete output worker port denies model admission without a substitute ready callback",
    async () => {
      const f = await chatWorkerFixture({ omitOutputOwner: true });
      await Promise.allSettled([reviewModel(f, f.tokenizeRequest)]);
      const [result] = await Promise.allSettled([
        f.modelUseRequest(f.tokenizeRequest),
      ]);
      if (result!.status === "fulfilled")
        expect(result!.value.externalDispatchAllowed).toBe(false);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(0);
      return expect(
        f.table("vertex_research_chat_model_dispatches")
      ).toHaveLength(0);
    },
    TIMEOUT
  );
});
