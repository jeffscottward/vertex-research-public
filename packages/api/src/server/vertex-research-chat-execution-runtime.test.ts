import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import {
  canonicalVertexResearchChatHumanContextV1,
  parseVertexResearchChatHumanContextV1,
} from "../contracts/vertex-research-chat-context.ts";
import { VertexResearchChatExpertConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import {
  prepareResearchChatInputs,
  type ResearchChatProducerInput,
} from "./vertex-research-chat-inputs.ts";
import {
  createVertexResearchChatExecutionRuntime,
  researchChatAcceptedReviewRevision,
} from "./vertex-research-chat-execution-runtime.ts";
import {
  compositionFixture,
  owner,
  reviewer,
  scope,
  AT,
  LATER,
  END,
  SENTINELS,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  researchParityPython,
  researchParityPythonSkip,
  researchParityPythonSkipNote,
} from "./research-python.test-support.ts";

// Authored but not run by the integration writer. These use real owners and
// actual producer; only SQL, object storage, clock and admin identity are doubles.
// This is NOT a worker/chat answer, provider call or deployment qualification.
const metadataTables = [
  "vertex_research_chat_execution_plans",
  "vertex_research_chat_storage_reviews",
  "vertex_research_chat_execution_approvals",
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const expectedInputs = async (
  f: Awaited<ReturnType<typeof compositionFixture>>,
  plan: Record<string, unknown>
) => {
  const message = f.table("vertex_research_chat_messages")[0]!["payload"];
  const config = VertexResearchChatExpertConfigurationV1Schema.parse(
    f.config.value
  );
  const humanContext = parseVertexResearchChatHumanContextV1({
    schema_version: "1.0.0",
    kind: "research-chat-human-context",
    account_alias: scope.accountAlias,
    environment: "research",
    owner_actor_id: owner.actorId,
    response_request_id: f.responseRequestId,
    thread_id: f.request.threadId,
    parent_message_id: f.request.parentMessageId,
    participant_id: f.request.participantId,
    participant_config_sha256: f.config.pin.artifactSha256,
    participant_label: config.participantLabel,
    persona_text: config.personaText,
    snapshot_revision: "2",
    high_water_sequence: "1",
    start_sequence: "1",
    messages: [
      {
        message_id: message.messageId,
        sequence: message.sequence,
        record_sha256: await hashArtifact(message),
        author: { kind: "user", actor_id: owner.actorId },
        body: message.body,
      },
    ],
  });
  const byId = (id: string): Uint8Array => {
    const found = [...f.objects.values()].find((entry) => entry.id === id);
    if (!found) throw new Error("Missing original fixture object");
    return new Uint8Array(found.body);
  };
  const e = f.corpus.value;
  const input = {
    ownerActorId: owner.actorId,
    responseRequestId: f.responseRequestId,
    request: f.request,
    humanContext,
    configuration: config,
    participantConfiguration: f.config.pin,
    selection: {
      accountAlias: scope.accountAlias,
      environment: "research",
      selectionId: f.selection.selectionId,
      selectionSha256: f.selection.selectionSha256,
      expiresAt: f.selection.expiresAt,
      research: f.selection.research,
      artifacts: f.selection.artifacts,
      references: f.selection.references,
      providerCapabilities: f.selection.providerCapabilities,
    },
    evidence: [
      {
        evidence_id: e["evidenceId"],
        collection_id: e["collectionId"],
        snapshot_id: e["snapshotId"],
        source_id: e["sourceIdentity"].sourceId,
        source_snapshot_id: e["sourceIdentity"].snapshotId,
        source_uri: e["sourceUri"],
        locator: e["sourceLocator"],
        attribution: e["attribution"],
        content_hash: e["contentHash"],
        excerpt_digest: await hashArtifact(
          new TextEncoder().encode(e["claim"])
        ),
        excerpt: e["claim"],
        rights_policy_id: e["rightsPolicyId"],
        captured_ns: timestampToEpochNanoseconds(e["capturedAt"]),
        published_ns: null,
        valid_until_ns: timestampToEpochNanoseconds(END),
        artifact_digest: f.corpus.pin.artifactSha256,
        accepted_review_id: f.corpusReview.reviewId,
        accepted_review_revision: researchChatAcceptedReviewRevision(
          f.corpusReview.reviewVersion
        ),
        untrusted_content: true,
      },
    ],
    modelPolicy: f.modelPolicy.value,
    modelPolicyPin: f.modelPolicy.pin,
    endpoints: [f.tokenize.value, f.completion.value],
    modelDescriptor: f.descriptor.value,
    modelDescriptorPin: f.descriptor.pin,
    modelPolicyBytes: f.modelPolicy.body,
    tokenizePolicyBytes: f.tokenize.body,
    completionPolicyBytes: f.completion.body,
    modelDescriptorBytes: f.descriptor.body,
    servingManifestBytes: byId("serving-manifest"),
    pricingBytes: byId("prices"),
    budgets: config.budgets,
    identity: {
      runId: plan["runId"],
      traceId: plan["traceId"],
      expiresAt: plan["expiresAt"],
    },
    // Fixture rows are structurally untyped; the producer validates them at runtime.
  } as unknown as ResearchChatProducerInput;
  return {
    input,
    prepared: await prepareResearchChatInputs(input),
    humanContext,
  };
};

describe("concrete one-expert plan to private review to exact owner approval", () => {
  it("persists all three actual owner records with exact producer bytes and no plaintext copies", async () => {
    const f = await compositionFixture();
    const originalObjects = new Map(
      [...f.objects].map(([key, value]) => [
        key,
        Buffer.from(value.body).toString("base64"),
      ])
    );
    const outbox = canonicalArtifactJson(f.table("vertex_outbox")),
      receipts = canonicalArtifactJson(f.table("vertex_command_receipts"));
    const jobs = canonicalArtifactJson(f.table("vertex_worker_jobs"));
    const queryOffset = f.calls.length;
    const plan = await f.runtime.planResearchChatResponse(owner, f.request);
    const expected = await expectedInputs(f, plan);
    expect(plan).toMatchObject({
      ownerActorId: owner.actorId,
      responseRequestId: f.responseRequestId,
      participantConfiguration: f.config.pin,
      selectionId: f.selection.selectionId,
      selectionSha256: f.selection.selectionSha256,
      collectionId: "corpus",
      snapshotId: "snapshot",
      reviewPins: f.config.value["reviewPins"],
      plannedAt: AT,
      expiresAt: END,
      executionAuthorized: false,
    });
    expect(plan["inputPolicy"]).toEqual({
      modelPolicySha256: f.modelPolicy.pin.artifactSha256,
      modelPolicy: f.modelPolicy.pin,
      modelDescriptorSha256: f.descriptor.pin.artifactSha256,
      modelDescriptor: f.descriptor.pin,
      endpointPolicySha256: {
        "model-tokenize": f.tokenize.pin.artifactSha256,
        "model-completion": f.completion.pin.artifactSha256,
      },
    });
    expect(plan["runId"]).toBe(
      `chat-run-${await hashArtifact({ responseRequestId: f.responseRequestId, purpose: "one-expert-run" })}`
    );
    expect(plan["traceId"]).toBe(
      `chat-trace-${await hashArtifact({ responseRequestId: f.responseRequestId, purpose: "one-expert-trace" })}`
    );
    for (const key of ["context", "tokenizeInput", "completionInput"] as const)
      expect(plan[key]).toEqual({
        sha256: await hashArtifact(expected.prepared[key]),
        byteLength: expected.prepared[key].byteLength,
      });
    expect(new TextDecoder().decode(expected.prepared.context)).toBe(
      canonicalVertexResearchChatHumanContextV1(expected.humanContext)
    );
    const completion = JSON.parse(
      new TextDecoder().decode(expected.prepared.completionInput)
    );
    const inert = JSON.parse(completion.messages[1].content);
    expect(inert.data.evidence[0]).toMatchObject({
      excerpt: SENTINELS.excerpt,
      content_hash: f.corpus.value["contentHash"],
      artifact_digest: f.corpus.pin.artifactSha256,
      accepted_review_id: f.corpusReview.reviewId,
    });
    expect(inert.data.evidence[0].excerpt_digest).not.toBe(
      f.corpus.value["contentHash"]
    );
    expect(inert.data.evidence[0].excerpt_digest).not.toBe(
      f.corpus.pin.artifactSha256
    );
    expect(completion.tools).toBeUndefined();
    expect(Object.keys(completion)).toHaveLength(14);
    const review = await f.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      f.reviewInput(plan)
    );
    expect(review).toMatchObject({
      actorId: reviewer.actorId,
      ownerActorId: owner.actorId,
      planSha256: plan["planSha256"],
      responseRequestId: plan["responseRequestId"],
      decision: "accepted",
      purpose: "storage-qualification",
    });
    // Clock changes between PLAN and APPROVE; no random ids, no renewed expiry.
    f.state.at = LATER;
    const approval = await f.runtime.approveResearchChatResponse(
      owner,
      f.approveInput(plan)
    );
    expect(approval).toMatchObject({
      planId: plan["planId"],
      planSha256: plan["planSha256"],
      storageReviewId: review["reviewId"],
      approvedAt: LATER,
      executionAuthorized: false,
    });
    expect(await f.runtime.planResearchChatResponse(owner, f.request)).toEqual(
      plan
    );
    expect(
      await f.runtime.approveResearchChatResponse(owner, f.approveInput(plan))
    ).toEqual(approval);
    for (const name of metadataTables) expect(f.table(name)).toHaveLength(1);
    const persisted = canonicalArtifactJson(
      metadataTables.flatMap((name) => f.table(name))
    );
    const commandWrites = canonicalArtifactJson(
      f.calls
        .slice(queryOffset)
        .filter((q) => /^(insert|update)/.test(q.sql))
        .map((q) => q.params)
    );
    for (const sentinel of Object.values(SENTINELS)) {
      expect(persisted).not.toContain(sentinel);
      expect(commandWrites).not.toContain(sentinel);
    }
    for (const field of [
      '"retrievalQuery"',
      '"human_context"',
      '"messages"',
      '"completionInputBytes"',
    ])
      expect(persisted).not.toContain(field);
    expect(canonicalArtifactJson(f.table("vertex_outbox"))).toBe(outbox);
    expect(canonicalArtifactJson(f.table("vertex_command_receipts"))).toBe(
      receipts
    );
    expect(canonicalArtifactJson(f.table("vertex_worker_jobs"))).toBe(jobs);
    return expect(
      new Map(
        [...f.objects].map(([key, value]) => [
          key,
          Buffer.from(value.body).toString("base64"),
        ])
      )
    ).toEqual(originalObjects);
  });
  it("keeps exact original human prefix after a later human append", async () => {
    const f = await compositionFixture(),
      plan = await f.runtime.planResearchChatResponse(owner, f.request);
    await f.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      f.reviewInput(plan)
    );
    f.state.at = LATER;
    await f.append("2", "later-original");
    expect(
      await f.runtime.approveResearchChatResponse(owner, f.approveInput(plan))
    ).toMatchObject({ planSha256: plan["planSha256"], snapshotRevision: "2" });
    expect(f.table("vertex_research_chat_messages")).toHaveLength(2);
    return expect(
      f.table("vertex_research_chat_execution_plans")[0]!["payload"].context
    ).toEqual(plan["context"]);
  });
  it("rejects a changed request echo before reading source or using query bytes", async () => {
    const f = await compositionFixture(),
      plan = await f.runtime.planResearchChatResponse(owner, f.request);
    await f.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      f.reviewInput(plan)
    );
    const reads: string[] = [];
    f.state.afterRead = (id) => {
      reads.push(id);
    };
    await expect(
      f.runtime.approveResearchChatResponse(owner, {
        ...f.approveInput(plan),
        request: {
          ...f.request,
          retrievalQuery: "Different unauthorized query echo",
        },
      })
    ).rejects.toThrow();
    expect(reads).toEqual([]);
    return expect(
      f.table("vertex_research_chat_execution_approvals")
    ).toHaveLength(0);
  });
  it("rejects changed original model bytes rather than reconstructing a policy", async () => {
    const f = await compositionFixture(),
      plan = await f.runtime.planResearchChatResponse(owner, f.request);
    await f.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      f.reviewInput(plan)
    );
    f.objects.get(f.modelPolicy.key)!.body = new TextEncoder().encode(
      canonicalArtifactJson({
        ...f.modelPolicy.value,
        model_revision: "f".repeat(40),
      })
    );
    await expect(
      f.runtime.approveResearchChatResponse(owner, f.approveInput(plan))
    ).rejects.toThrow();
    return expect(
      f.table("vertex_research_chat_execution_approvals")
    ).toHaveLength(0);
  });
  it("fails when the source exists only in the account-private namespace", async () => {
    const f = await compositionFixture();
    const original = f.objects.get(f.corpus.key)!;
    f.objects.set(
      vertexQualifiedObjectKey(
        scope,
        null,
        "manifest",
        f.corpus.pin.artifactSha256
      ),
      { id: original.id, body: new Uint8Array(original.body) }
    );
    f.objects.delete(f.corpus.key);
    await expect(
      f.runtime.planResearchChatResponse(owner, f.request)
    ).rejects.toThrow();
    return expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(
      0
    );
  });
  it("does not fabricate corpus authority when the accepted overlay link is missing", async () => {
    const f = await compositionFixture();
    f.table("vertex_reviewed_artifact_links").length = 0;
    await expect(
      f.runtime.planResearchChatResponse(owner, f.request)
    ).rejects.toThrow();
    return expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(
      0
    );
  });
  it("rolls back plan and approval if their final insert crosses immutable expiry", async () => ({
    ...(await (async () => {
      const results = {};
      for (const stage of ["plan", "approval"] as const) {
        const f = await compositionFixture();
        let plan: Record<string, unknown> | undefined;
        if (stage === "approval") {
          plan = await f.runtime.planResearchChatResponse(owner, f.request);
          await f.runtime.recordResearchChatStorageQualificationReview(
            reviewer,
            f.reviewInput(plan)
          );
        }
        const target =
          stage === "plan"
            ? "vertex_research_chat_execution_plans"
            : "vertex_research_chat_execution_approvals";
        f.state.afterQuery = (q) => {
          if (q.sql.startsWith(`insert into "${target}"`))
            return (f.state.at = END);
          return;
        };
        await expect(
          stage === "plan"
            ? f.runtime.planResearchChatResponse(owner, f.request)
            : f.runtime.approveResearchChatResponse(
                owner,
                f.approveInput(plan!)
              )
        ).rejects.toThrow();
        Object.assign(results, expect(f.table(target)).toHaveLength(0));
      }
      return results;
    })()),
  }));
  it.each(["owner-context-grant", "private-review"] as const)(
    "rolls back when %s alone expires during the approval INSERT",
    async (target) => {
      const f = await compositionFixture();
      if (target === "owner-context-grant") {
        const resourceId = `research-chat-context-use:${f.responseRequestId}`;
        const grantId = `grant-${await hashArtifact({ actorId: owner.actorId, resourceId, actions: ["publish"], collectionId: null })}`;
        await f.authorization.issueGrant({
          principal: { actorId: "fixture-grant-admin" },
          grantId,
          granteeActorId: owner.actorId,
          scope,
          collectionId: null,
          resourceId,
          actions: ["publish"],
          version: "2.0.0",
          expectedVersion: "1.0.0",
          validFrom: AT,
          expiresAt: LATER,
        });
      }
      const plan = await f.runtime.planResearchChatResponse(owner, f.request);
      expect(plan["expiresAt"]).toBe(END);
      await f.runtime.recordResearchChatStorageQualificationReview(reviewer, {
        ...f.reviewInput(plan),
        expiresAt: target === "private-review" ? LATER : END,
      });
      f.state.afterQuery = (query) => {
        if (
          query.sql.startsWith(
            'insert into "vertex_research_chat_execution_approvals"'
          )
        )
          return (f.state.at = LATER);
        return;
      };
      await expect(
        f.runtime.approveResearchChatResponse(owner, f.approveInput(plan))
      ).rejects.toThrow();
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        0
      );
      expect(f.table("vertex_research_chat_storage_reviews")).toHaveLength(1);
      return expect(
        f.table("vertex_research_chat_execution_plans")
      ).toHaveLength(1);
    }
  );
  it("denies expiry during original policy I/O and denies expired approval replay", async () => {
    const f = await compositionFixture();
    f.state.afterRead = (id) => {
      if (id === "model-policy") return (f.state.at = END);
      return;
    };
    await expect(
      f.runtime.planResearchChatResponse(owner, f.request)
    ).rejects.toThrow();
    expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(0);
    const g = await compositionFixture(),
      plan = await g.runtime.planResearchChatResponse(owner, g.request);
    await g.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      g.reviewInput(plan)
    );
    await g.runtime.approveResearchChatResponse(owner, g.approveInput(plan));
    g.state.at = END;
    await expect(
      g.runtime.approveResearchChatResponse(owner, g.approveInput(plan))
    ).rejects.toThrow();
    return expect(
      g.table("vertex_research_chat_execution_approvals")
    ).toHaveLength(1);
  });
  it("never upgrades a settled unavailable response key", async () => {
    const f = await compositionFixture();
    const { accountAlias, environment, ...input } = f.request;
    const unavailable = await f.store.requestResearchChatResponse({
      principal: owner,
      scope,
      ...input,
    });
    const original = canonicalArtifactJson(f.table("vertex_command_receipts"));
    expect(unavailable).toMatchObject({ status: "unavailable", jobId: null });
    await expect(
      f.runtime.planResearchChatResponse(owner, f.request)
    ).rejects.toThrow();
    expect(canonicalArtifactJson(f.table("vertex_command_receipts"))).toBe(
      original
    );
    return expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(
      0
    );
  });
  it("requires separate exact request review permission and configured independent reviewer", async () => {
    const f = await compositionFixture(),
      plan = await f.runtime.planResearchChatResponse(owner, f.request);
    await expect(
      f.runtime.recordResearchChatStorageQualificationReview(
        owner,
        f.reviewInput(plan)
      )
    ).rejects.toThrow();
    const other = createVertexResearchChatExecutionRuntime({
      ...f.runtimeOptions,
      storage: { ...f.runtimeOptions.storage, reviewerActorId: owner.actorId },
    });
    await expect(
      other.recordResearchChatStorageQualificationReview(
        reviewer,
        f.reviewInput(plan)
      )
    ).rejects.toThrow();
    return expect(f.table("vertex_research_chat_storage_reviews")).toHaveLength(
      0
    );
  });
  it("requires explicit modelPolicy and every distinct budget in private configuration", async () => {
    const f = await compositionFixture();
    for (const key of ["modelPolicy", "budgets"]) {
      const copy = { ...f.config.value };
      delete copy[key];
      expect(
        VertexResearchChatExpertConfigurationV1Schema.safeParse(copy).success
      ).toBe(false);
    }
    for (const key of Object.keys(f.config.value["budgets"])) {
      const budgets = { ...f.config.value["budgets"] };
      delete budgets[key];

      expect(
        VertexResearchChatExpertConfigurationV1Schema.safeParse({
          ...f.config.value,
          budgets,
        }).success
      ).toBe(false);
    }
  });
});

describe("existing Python accepted-review representation parity (no model SDK)", () => {
  it("matches the real _revision for multi-digit components and exact rejection bounds", ({
    skip,
  }) => {
    skip(researchParityPythonSkip, researchParityPythonSkipNote);
    const versions = [
      "1.0.0",
      "12.34.5",
      "0.0.0",
      "123.45.678",
      "1234.56.789",
      "99999999.9.9",
      "01.002.3",
      "1.2",
      "1.2.a",
      "1.2.3\n",
      "١.2.3",
    ];
    const program = [
      "import json,sys",
      "from vertex_control.adapters import _revision",
      "out=[]",
      "for value in json.load(sys.stdin):",
      " try: out.append(str(_revision(value)))",
      " except Exception: out.append(None)",
      "print(json.dumps(out))",
    ].join("\n");
    const result = spawnSync(researchParityPython, ["-c", program], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: resolve(root, "services/control-client"),
        PYTHONDONTWRITEBYTECODE: "1",
      },
      input: JSON.stringify(versions),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8192,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return expect(
      versions.map((value) => {
        try {
          return researchChatAcceptedReviewRevision(value).toString();
        } catch {
          return null;
        }
      })
    ).toEqual(JSON.parse(result.stdout));
  });
});
