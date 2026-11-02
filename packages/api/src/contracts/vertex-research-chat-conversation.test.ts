import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import {
  VertexResearchChatAgentReferenceMessageSchema,
  VertexResearchChatTranscriptMessageSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatSendMessageInputSchema,
} from "./vertex-research-chat.ts";
import {
  VertexResearchChatAdvisoryProfileSchema,
  VertexResearchChatReadResponseContentOutputSchema,
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
} from "./vertex-research-chat-conversation.ts";
import {
  VertexResearchChatPlanInputSchema,
  VertexResearchChatApproveInputSchema,
} from "./vertex-research-chat-execution.ts";

// Synthetic PURE DTO data only. No original source, authority, publication,
// caller access, provider readiness, live response or deletion guarantee fixture.
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const astral = "\u{10400}";
const at = "2026-09-25T00:00:00.000Z";
const end = "2026-09-25T01:00:00.000Z";
const record = { schemaVersion: "1.0.0", executionAuthorized: false };
const scope = { accountAlias: "synthetic-research", environment: "research" };
const artifact = (artifactId: string) => ({ artifactId, artifactSha256: hash });
const reference = () => ({
  ...record,
  threadId: "thread",
  messageId: "agent-2",
  sequence: "2",
  author: { kind: "agent", participantId: "expert", runId: "run" },
  kind: "advisory-reference",
  parentMessageId: "human-1",
  replyToMessageId: "human-1",
  response: {
    responseRequestId: "response",
    planId: "plan",
    planSha256: hash,
    requestSha256: hash,
    contextSha256: hash,
    snapshotRevision: "2",
    contextStartSequence: "1",
    jobId: "job",
    traceId: "trace",
    eventId: "event",
    runArtifact: artifact("run"),
    advisoryArtifact: artifact("advisory"),
    fenceAcknowledgementsSha256: hash,
  },
  recordedAt: at,
});
const human = () => ({
  ...record,
  threadId: "thread",
  messageId: "human-1",
  sequence: "1",
  author: { kind: "user", actorId: "owner" },
  kind: "statement",
  body: "Synthetic human statement.",
  citations: [],
  recordedAt: at,
});
const transcript = () => ({
  ...record,
  thread: {
    ...record,
    ...scope,
    threadId: "thread",
    title: "Synthetic",
    ownerActorId: "owner",
    participantIds: ["expert"],
    createdAt: at,
    updatedAt: at,
    revision: "3",
  },
  snapshotRevision: "3",
  highWaterSequence: "2",
  items: [human(), reference()],
  nextCursor: null,
});
const claim = (text = "Synthetic claim.", quote = "Synthetic quote.") => ({
  text,
  kind: "hypothesis",
  citations: [
    {
      evidence_id: "evidence",
      source_id: "source",
      source_snapshot_id: "source-snapshot",
      content_hash: hash,
      excerpt_digest: hash,
      quote,
    },
  ],
});
const advisory = () => ({
  profile: "vertex-research-chat-advisory-v1",
  responseRequestId: "response",
  planId: "plan",
  planSha256: hash,
  runId: "run",
  traceId: "trace",
  taskContract: "task",
  modelVersion: "model",
  modelUseRequestSha256: hash,
  responseSha256: hash,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    completionCostUsd: "0.01",
  },
  output: {
    claims: [claim()],
    proposals: [
      {
        proposal_id: "proposal",
        kind: "backtest-request",
        title: "Synthetic title",
        rationale: claim(),
        execution_authorized: false,
      },
    ],
    execution_authorized: false,
  },
  executionAuthorized: false,
});
const content = (profile = advisory()) => {
  const bytes = new TextEncoder().encode(canonicalArtifactJson(profile));
  const sha256 = createHash("sha256").update(bytes).digest("hex"),
    ref = reference();
  ref.response.advisoryArtifact.artifactSha256 = sha256;
  return {
    ...record,
    reference: ref,
    checkedAt: at,
    status: "available",
    notAfter: end,
    profile,
    sha256,
    byteLength: bytes.byteLength,
  };
};
const request = () => ({
  ...scope,
  threadId: "thread",
  parentMessageId: "human-1",
  participantId: "expert",
  snapshotRevision: "2",
  contextStartSequence: "1",
  retrievalQuery: "Synthetic bounded research query",
  idempotencyKey: "original-key",
});
const prepared = () => ({
  ...record,
  status: "prepared",
  preview: {
    responseRequestId: "response",
    planId: "plan",
    planSha256: hash,
    request: request(),
    context: {
      messageIds: ["human-1"],
      snapshotRevision: "2",
      contextStartSequence: "1",
      highWaterSequence: "1",
      messageCount: 1,
      sha256: hash,
      byteLength: 128,
    },
    expert: {
      participantId: "expert",
      configurationSha256: hash,
      modelVersion: "model",
    },
    inputs: {
      tokenizeInput: { sha256: hash, byteLength: 256 },
      completionInput: { sha256: hash, byteLength: 512 },
    },
    corpus: {
      collectionId: "collection",
      snapshotId: "snapshot",
      reviewPins: [
        {
          collectionId: "collection",
          evidenceId: "evidence",
          artifactId: "evidence-artifact",
          artifactSha256: hash,
          reviewId: "review",
          reviewVersion: "1.0.0",
          rightsPolicyId: "rights",
          rightsVersion: "1.0.0",
        },
      ],
    },
    model: {
      providerId: "provider",
      modelVersion: "model",
      servedModel: "served-model",
      modelPolicySha256: hash,
      destination: { scheme: "https", hostname: "synthetic.invalid", port: "" },
      tokenizeEndpoint: {
        ...artifact("tokenize"),
        endpointId: "tokenize-endpoint",
      },
      completionEndpoint: {
        ...artifact("completion"),
        endpointId: "completion-endpoint",
      },
    },
    retention: {
      policyId: "retention",
      policyVersion: "1.0.0",
      artifact: artifact("retention-artifact"),
      rules: [
        { kind: "context", cleanupTrigger: "response-attempt-terminal" },
        { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
        { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
      ],
      earlierCleanupTriggers: ["revocation", "rights-expiry"],
      readNotAfter: end,
      guaranteedDeletionDeadline: null,
    },
    storage: {
      storageProfileSha256: hash,
      backendDeploymentId: "storage",
      evidence: artifact("storage-evidence"),
      namespace: "vertex/chat-copy/v1",
      createSemantics: "conditional-create-no-overwrite",
      readSemantics: "exact-bound-current-bytes-or-fenced",
      fenceSemantics: "conditional-permanent-tombstone-no-resurrection",
      retainedVersions: "no-application-readable-prior-content-version",
      claimScope: "application-managed-copy-namespace-only",
      excludedClaims: [
        "provider",
        "backups",
        "physical-media",
        "RAM",
        "exports",
      ],
    },
    checkedAt: at,
    notAfter: end,
  },
});

describe("pure conversation DTO boundaries, never authority", () => {
  const schemas = {
    profile: VertexResearchChatAdvisoryProfileSchema,
    content: VertexResearchChatReadResponseContentOutputSchema,
  };

  it("accepts available native astral claim2000/title200/quote1000 codepoint boundaries", () => {
    const profile = advisory();
    profile.output.claims[0]!.text = astral.repeat(2000);
    profile.output.claims[0]!.citations[0]!.quote = astral.repeat(1000);
    profile.output.proposals[0]!.title = astral.repeat(200);
    profile.output.proposals[0]!.rationale.text = astral.repeat(2000);
    const value = content(profile),
      parsed = schemas.content.parse(value);
    expect(parsed.status).toBe("available");
    if (parsed.status === "available") {
      const output = parsed.profile.output;
      expect(Array.from(output.claims[0]!.text)).toHaveLength(2000);
      expect(output.claims[0]?.text).toHaveLength(4000);
      expect(Array.from(output.proposals[0]!.title)).toHaveLength(200);
      expect(output.proposals[0]?.title).toHaveLength(400);
      expect(Object.keys(parsed.profile)).toHaveLength(13);
      expect(Object.isFrozen(output.claims[0]?.citations[0])).toBe(true);
      return expect(Object.isFrozen(parsed.reference.response)).toBe(true);
    }
    return;
  });

  it.each(["claim", "title", "quote", "rationale"] as const)(
    "rejects native %s codepoint limit plus one",
    (field) => {
      const profile = advisory();
      if (field === "claim")
        profile.output.claims[0]!.text = astral.repeat(2001);
      if (field === "title")
        profile.output.proposals[0]!.title = astral.repeat(201);
      if (field === "quote")
        profile.output.claims[0]!.citations[0]!.quote = astral.repeat(1001);
      if (field === "rationale")
        profile.output.proposals[0]!.rationale.text = astral.repeat(2001);
      return expect(schemas.content.safeParse(content(profile)).success).toBe(
        false
      );
    }
  );

  it("keeps human limits at8000 UTF16 units, independently of native codepoints", () => {
    const value = {
      ...scope,
      threadId: "thread",
      expectedRevision: "1",
      idempotencyKey: "human-key",
      body: astral.repeat(4000),
      requestedParticipantIds: [],
      mode: "discuss",
    };
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse(value).success
    ).toBe(true);
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...value,
        body: astral.repeat(4001),
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatTranscriptMessageSchema.safeParse({
        ...human(),
        body: astral.repeat(4000),
      }).success
    ).toBe(true);
    return expect(
      VertexResearchChatTranscriptMessageSchema.safeParse({
        ...human(),
        body: astral.repeat(4001),
      }).success
    ).toBe(false);
  });

  it("rejects raw private extras and camelcase native substitutions", () => {
    const profile = advisory(),
      ref = reference(),
      claimValue = claim();
    expect(
      schemas.profile.safeParse({ ...profile, personaText: "private input" })
        .success
    ).toBe(false);
    expect(
      schemas.profile.safeParse({
        ...profile,
        output: { ...profile.output, human_context: [] },
      }).success
    ).toBe(false);
    expect(
      schemas.profile.safeParse({
        ...profile,
        output: {
          ...profile.output,
          claims: [
            {
              ...claimValue,
              citations: [
                {
                  evidenceId: "evidence",
                  sourceId: "source",
                  sourceSnapshotId: "snapshot",
                  contentHash: hash,
                  excerptDigest: hash,
                  quote: "quote",
                },
              ],
            },
          ],
        },
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse({
        ...ref,
        body: "No answer body here.",
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse({
        ...ref,
        citations: [],
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatTranscriptMessageSchema.safeParse({
        ...human(),
        author: ref.author,
      }).success
    ).toBe(false);
  });

  it.each([
    "responseRequestId",
    "planId",
    "planSha256",
    "runId",
    "traceId",
  ] as const)(
    "rejects available profile/reference %s identity drift",
    (field) => {
      const profile = advisory();
      profile[field] =
        field === "planSha256" ? otherHash : "different-identity";
      return expect(schemas.content.safeParse(content(profile)).success).toBe(
        false
      );
    }
  );

  it("rejects reference advisory hash drift, byte drift and elapsed deadline", () => {
    const value = content();
    expect(
      schemas.content.safeParse({ ...value, sha256: otherHash }).success
    ).toBe(false);
    expect(
      schemas.content.safeParse({ ...value, byteLength: value.byteLength + 1 })
        .success
    ).toBe(false);
    return expect(
      schemas.content.safeParse({ ...value, notAfter: value.checkedAt }).success
    ).toBe(false);
  });

  it("allows bodyless historical reference and unavailable content without current readiness claims", () => {
    const ref = reference(),
      page = transcript();
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse(ref).success
    ).toBe(true);
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse(page).success
    ).toBe(true);
    expect(
      schemas.content.safeParse({
        ...record,
        reference: ref,
        checkedAt: at,
        status: "unavailable",
        reasonCodes: ["deadline"],
      }).success
    ).toBe(true);
    return expect(Object.hasOwn(ref, "body")).toBe(false);
  });

  it("rejects foreign human owner, unselected agent, chronology gap and wrong chronological parent", () => {
    const page = transcript(),
      ref = reference();
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...page,
        items: [
          { ...human(), author: { kind: "user", actorId: "other-owner" } },
          ref,
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...page,
        items: [
          human(),
          { ...ref, author: { ...ref.author, participantId: "other-expert" } },
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...page,
        items: [human(), { ...ref, sequence: "3" }],
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...page,
        items: [human(), { ...ref, parentMessageId: "other-human" }],
      }).success
    ).toBe(false);
  });

  it("keeps original response-to separate from a later chronological parent", () => {
    const ref = reference();
    ref.sequence = "3";
    ref.parentMessageId = "human-2";
    const page = {
      ...transcript(),
      thread: { ...transcript().thread, revision: "4" },
      snapshotRevision: "4",
      highWaterSequence: "3",
      items: [
        human(),
        { ...human(), messageId: "human-2", sequence: "2" },
        ref,
      ],
    };
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse(page).success
    ).toBe(true);
    return expect(ref.replyToMessageId).toBe("human-1");
  });

  it("rejects agent run mismatch and invalid original bounded context", () => {
    const ref = reference();
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse({
        ...ref,
        author: { ...ref.author, runId: "other-run" },
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse({
        ...ref,
        response: { ...ref.response, snapshotRevision: "3" },
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse({
        ...ref,
        sequence: "18",
        response: {
          ...ref.response,
          snapshotRevision: "18",
          contextStartSequence: "1",
        },
      }).success
    ).toBe(false);
  });

  it("canonical preflight rejects accessor without invoking it, hidden keys, symbols and cycles", () => {
    const accessed = { count: 0 },
      getter = reference(),
      hidden = reference(),
      symbolic = reference(),
      cyclic = reference();
    Object.defineProperty(getter, "body", {
      enumerable: true,
      get: () => {
        const text = "untrusted";
        accessed.count += 1;
        return text;
      },
    });
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "untrusted",
    });
    Object.defineProperty(symbolic, Symbol("untrusted"), {
      enumerable: true,
      value: "untrusted",
    });
    Object.defineProperty(cyclic, "cycle", { enumerable: true, value: cyclic });
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse(getter).success
    ).toBe(false);
    expect(accessed.count).toBe(0);
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse(hidden).success
    ).toBe(false);
    expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse(symbolic).success
    ).toBe(false);
    return expect(
      VertexResearchChatAgentReferenceMessageSchema.safeParse(cyclic).success
    ).toBe(false);
  });

  it("aliases exact original prepare/approve input parsers and accepts explicit original preview metadata", () => {
    const value = prepared(),
      parsed = VertexResearchChatPrepareResponseOutputSchema.parse(value);
    expect(VertexResearchChatPrepareResponseInputSchema).toBe(
      VertexResearchChatPlanInputSchema
    );
    expect(VertexResearchChatApproveAndRequestResponseInputSchema).toBe(
      VertexResearchChatApproveInputSchema
    );
    expect(parsed.status).toBe("prepared");
    if (parsed.status === "prepared") {
      const preview = parsed.preview;
      expect(preview.request).toEqual(value.preview.request);
      expect(preview.retention.guaranteedDeletionDeadline).toBeNull();
      expect(Object.isFrozen(preview.corpus.reviewPins[0])).toBe(true);
      return expect(Object.isFrozen(preview.request)).toBe(true);
    }
    return;
  });

  it.each([
    "parent",
    "snapshot",
    "start",
    "count",
    "expert",
    "model",
    "review",
    "deadline",
  ] as const)("rejects preview original binding %s drift", (field) => {
    const value = prepared(),
      preview = value.preview;
    if (field === "parent") preview.request.parentMessageId = "other-human";
    if (field === "snapshot") preview.request.snapshotRevision = "3";
    if (field === "start") preview.context.contextStartSequence = "2";
    if (field === "count") preview.context.messageCount = 2;
    if (field === "expert") preview.expert.participantId = "other-expert";
    if (field === "model") preview.model.modelVersion = "other-model";
    if (field === "review")
      preview.corpus.reviewPins[0]!.collectionId = "other-corpus";
    if (field === "deadline") preview.retention.readNotAfter = at;
    return expect(
      VertexResearchChatPrepareResponseOutputSchema.safeParse(value).success
    ).toBe(false);
  });

  it("rejects bulk/private consent extras and invented deletion guarantee", () => {
    const value = prepared(),
      preview = value.preview;
    expect(
      VertexResearchChatPrepareResponseOutputSchema.safeParse({
        ...value,
        preview: {
          ...preview,
          expert: { ...preview.expert, personaText: "private persona" },
        },
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatPrepareResponseOutputSchema.safeParse({
        ...value,
        preview: {
          ...preview,
          model: {
            ...preview.model,
            destination: {
              ...preview.model.destination,
              url: "https://synthetic.invalid/private",
            },
          },
        },
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatPrepareResponseOutputSchema.safeParse({
        ...value,
        preview: {
          ...preview,
          retention: { ...preview.retention, guaranteedDeletionDeadline: end },
        },
      }).success
    ).toBe(false);
  });

  it("binds appended reference to selector and exact sequence plus one", () => {
    const value = {
      ...record,
      selector: { ...scope, threadId: "thread", responseRequestId: "response" },
      status: "appended",
      message: reference(),
      threadRevision: "3",
    };
    expect(
      VertexResearchChatAppendResponseOutputSchema.safeParse(value).success
    ).toBe(true);
    expect(
      VertexResearchChatAppendResponseOutputSchema.safeParse({
        ...value,
        threadRevision: "4",
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatAppendResponseOutputSchema.safeParse({
        ...value,
        selector: { ...value.selector, responseRequestId: "other-response" },
      }).success
    ).toBe(false);
  });
});
