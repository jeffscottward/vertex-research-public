import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  VertexResearchChatExpertConfigurationV1Schema,
  VertexResearchChatPlanV1Schema,
} from "../contracts/vertex-research-chat-execution.ts";
import {
  ModelUseRequestSchema,
  computeModelUseRequestHash,
  parseModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import { VertexRuntimeModelDescriptorSchema } from "./vertex-runtime-model-evidence.ts";
import {
  canonicalResearchChatInputJson,
  prepareResearchChatInputs,
  type ResearchChatEndpointPolicy,
  type ResearchChatProducerInput,
} from "./vertex-research-chat-inputs.ts";
import {
  decodeResearchChatAdvisoryOutput,
  type ResearchChatAdvisoryOutputInput,
} from "./vertex-research-chat-output-parser.ts";

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
// Source-adapted existing pure-input fixture, not an authorization fixture.
// Uses the actual original producer for completion14/schema/evidence bytes.
// No Python/SDK/network/DB/storage execution is part of these pure scenarios.
const pin = (
  artifactId: string,
  artifactSha256: string,
  contractName = "SyntheticPrivatePolicy"
) => ({
  artifactId,
  artifactSha256,
  contractName,
  schemaVersion: "1.0.0" as const,
});
const endpoint = (
  endpoint_id: string,
  operation: ResearchChatEndpointPolicy["operation"],
  path: string
): ResearchChatEndpointPolicy => ({
  endpoint_id,
  operation,
  path,
  provider: "provider",
  origin: "https://model.example.com",
  method: "POST",
  credential_reference_id: "synthetic-secret-reference",
  credential_header: "Authorization",
  credential_prefix: "Bearer ",
  allowed_query_keys: [],
  policy_id: "endpoint-policy",
  source_reference: "source",
  maximum_request_bytes: 1_000_000,
  maximum_response_bytes: 1_000_000,
  timeout_ms: 1000,
  allowed_ip_addresses: ["93.184.216.34"],
});
const producerFixture = async (
  mutate?: (policies: any) => void
): Promise<ResearchChatProducerInput> => {
  const expiresAt = "2027-01-15T08:01:00.000000123Z",
    later = "2027-01-15T09:00:00.000000123Z";
  const tokenizerArtifact = pin("tokenizer", "b".repeat(64));
  const modelPolicy = {
    policy_id: "policy",
    model_version: "model-version",
    served_model: "served-model",
    backend: "vllm-0.9.2" as const,
    model_revision: "a".repeat(40),
    tokenizer_sha256: "b".repeat(64),
    chat_template_sha256: "c".repeat(64),
    serving_manifest_sha256: "",
    tokenize_endpoint_id: "tokenize",
    completion_endpoint_id: "complete",
    pricing_source_artifact_id: "prices",
    input_usd_per_million: "1",
    output_usd_per_million: "2",
    maximum_context_tokens: 4096,
  };
  const endpoints: [ResearchChatEndpointPolicy, ResearchChatEndpointPolicy] = [
    endpoint("tokenize", "model-tokenize", "/tokenize"),
    endpoint("complete", "model-completion", "/v1/chat/completions"),
  ];
  const manifest = {
    profile: "vertex-exact-vllm-serving-v1",
    model_version: modelPolicy.model_version,
    served_model: modelPolicy.served_model,
    model_revision: modelPolicy.model_revision,
    tokenizer_sha256: modelPolicy.tokenizer_sha256,
    chat_template_sha256: modelPolicy.chat_template_sha256,
    backend: modelPolicy.backend,
    runtime_image_sha256: "8".repeat(64),
    replica_policy: "immutable-identical-no-hot-swap",
    template_policy: "reviewed-pure-no-clock-random-or-external-state",
    input_profile: "text-only-decoder-only-no-documents",
    adapter_policy: "no-lora-no-prompt-adapters-no-tools-no-truncation",
    tokenize_authentication: "authenticated-reverse-proxy-both-paths",
    pricing_profile:
      "all-prompt-and-completion-token-ids-single-rate-no-cache-discount",
  };
  const price = {
    profile: "vertex-model-price-v1",
    model_version: modelPolicy.model_version,
    input_usd_per_million: modelPolicy.input_usd_per_million,
    output_usd_per_million: modelPolicy.output_usd_per_million,
    rounding: "ceil-aggregate-to-1e-18-usd",
  };
  const descriptorPricing = {
    currency: "USD",
    basis: "conservative-input-byte-output-token-ceiling",
    tokenizationBaseUsd: "0.001",
    tokenizationInputByteUsd: "0.000000001",
    completionBaseUsd: "0.001",
    completionInputByteUsd: "0.000000001",
    outputTokenUsd: "0.0001",
    expiresAt: later,
  };
  mutate?.({ modelPolicy, endpoints, manifest, price, descriptorPricing });
  const bytes = (value: unknown) =>
    new TextEncoder().encode(canonicalResearchChatInputJson(value));
  const servingManifestBytes = bytes(manifest),
    pricingBytes = bytes(price);
  modelPolicy.serving_manifest_sha256 = sha(
    canonicalResearchChatInputJson(manifest)
  );
  const modelPolicyBytes = bytes(modelPolicy),
    tokenizePolicyBytes = bytes(endpoints[0]),
    completionPolicyBytes = bytes(endpoints[1]);
  const modelPolicyPin = pin(
    "model-policy",
    sha(canonicalResearchChatInputJson(modelPolicy))
  );
  const tokenizeEndpoint = pin(
      "tokenize-endpoint",
      sha(canonicalResearchChatInputJson(endpoints[0]))
    ),
    completionEndpoint = pin(
      "completion-endpoint",
      sha(canonicalResearchChatInputJson(endpoints[1]))
    );
  const config = VertexResearchChatExpertConfigurationV1Schema.parse({
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-expert-configuration-v1",
    accountAlias: "fixture",
    environment: "research",
    participantId: "expert",
    participantLabel: "Synthetic Researcher",
    personaText: "Untrusted synthetic persona.",
    collectionId: "collection",
    snapshotId: "snapshot",
    taskContract: "research-task",
    modelPolicy: modelPolicyPin,
    budgets: {
      requestTokens: 2000,
      attemptTokens: 1500,
      requestCostUsd: "1",
      attemptCostUsd: "0.5",
      tokenizeCostUsd: "0.01",
      completionCostUsd: "0.1",
    },
    provider: {
      providerId: "provider",
      modelVersion: "model-version",
      servedModel: "served-model",
      tokenizerArtifact,
      tokenizeEndpoint,
      completionEndpoint,
      maximumInputTokens: 1000,
      maximumOutputTokens: 128,
      maximumCostUsd: "0.4",
    },
    reviewPins: [
      {
        collectionId: "collection",
        evidenceId: "evidence",
        artifactId: "evidence-artifact",
        artifactSha256: "d".repeat(64),
        reviewId: "review",
        reviewVersion: "1.0.0",
        rightsPolicyId: "rights",
        rightsVersion: "1.0.0",
      },
    ],
    advisoryMaximumBytes: 20_000,
    expiresAt: later,
  });
  const participantConfiguration = pin(
    "expert-config",
    await hashArtifact(config),
    "ResearchChatExpertConfiguration"
  );
  const modelDescriptor = VertexRuntimeModelDescriptorSchema.parse({
    format: "vertex-model-binding-v1",
    accountAlias: "fixture",
    environment: "research",
    providerId: "provider",
    modelVersion: "model-version",
    tokenizerArtifactId: "tokenizer",
    tokenizerSha256: "b".repeat(64),
    endpointReferenceId: "complete",
    endpointSha256: completionEndpoint.artifactSha256,
    modelUsePolicyVersion: "1.0.0",
    expiresAt: later,
    pricing: descriptorPricing,
  });
  const modelDescriptorPin = pin(
    "model-descriptor",
    await hashArtifact(modelDescriptor)
  );
  const modelDescriptorBytes = new TextEncoder().encode(
    canonicalArtifactJson(modelDescriptor)
  );
  const references = [
    ...endpoints.map((item, index) => ({
      referenceId: item.endpoint_id,
      referenceSha256:
        index === 0
          ? tokenizeEndpoint.artifactSha256
          : completionEndpoint.artifactSha256,
      kind: "nonsecret-reference" as const,
    })),
    ...Array.from(
      new Set(endpoints.map((item) => item.credential_reference_id)),
      (referenceId) => ({
        referenceId,
        referenceSha256: "9".repeat(64),
        kind: "secret-reference" as const,
      })
    ),
  ].map((item) => ({
    ...item,
    logicalName: item.referenceId,
    ownerService: "research-worker",
    accountAlias: "fixture",
    environment: "research" as const,
    permissions: ["read"],
    entitlementPolicyId: null,
    rotationOwner: "fixture-owner",
    requiredWhen: [],
    legacyAliases: [],
    verificationState: "unknown" as const,
    lastVerifiedAt: null,
    expiresAt: later,
    exposure: "server-only" as const,
  }));
  const providerCapabilities = endpoints.map((item, index) => ({
    capabilityId: `capability-${index}`,
    providerId: item.provider,
    endpointReferenceId: item.endpoint_id,
    endpointSha256:
      index === 0
        ? tokenizeEndpoint.artifactSha256
        : completionEndpoint.artifactSha256,
    modelVersion: modelPolicy.model_version,
    operation: item.operation,
    state: "unknown" as const,
    rightsPolicyId: "rights",
    rightsPolicyVersion: "1.0.0",
    observedAt: expiresAt,
    expiresAt: later,
    evidenceArtifact: pin(`fact-${index}`, "7".repeat(64)),
  }));
  const humanContext = parseVertexResearchChatHumanContextV1({
    schema_version: "1.0.0",
    kind: "research-chat-human-context",
    account_alias: "fixture",
    environment: "research",
    owner_actor_id: "owner",
    response_request_id: "response",
    thread_id: "thread",
    parent_message_id: "message",
    participant_id: "expert",
    participant_config_sha256: participantConfiguration.artifactSha256,
    participant_label: config.participantLabel,
    persona_text: config.personaText,
    snapshot_revision: "9007199254740994",
    high_water_sequence: "9007199254740993",
    start_sequence: "9007199254740993",
    messages: [
      {
        message_id: "message",
        sequence: "9007199254740993",
        record_sha256: "b".repeat(64),
        author: { kind: "user", actor_id: "owner" },
        body: 'Literal e\u0301 / 雪 / 𝄞 and quotes " remain data.',
      },
    ],
  });
  const excerpt =
    "Original bounded excerpt 雪 e\u0301 𝄞. Human messages are not corpus evidence.";
  return {
    ownerActorId: "owner",
    responseRequestId: "response",
    humanContext,
    configuration: config,
    participantConfiguration,
    request: {
      accountAlias: "fixture",
      environment: "research",
      threadId: "thread",
      parentMessageId: "message",
      participantId: "expert",
      snapshotRevision: humanContext.snapshot_revision,
      contextStartSequence: humanContext.start_sequence,
      retrievalQuery: "Explain this synthetic research evidence.",
      idempotencyKey: "request-key",
    },
    selection: {
      accountAlias: "fixture",
      environment: "research",
      selectionId: "selection",
      selectionSha256: "a".repeat(64),
      expiresAt: later,
      research: {
        moduleId: "research-module",
        taskContract: "research-task",
        modelVersion: "model-version",
        modelCapabilityId: "model-capability",
        tokenBudget: 3000,
        costBudgetUsd: "2",
        rightsPolicyId: "rights",
        allowedTools: [],
        requiredComponents: ["worker"],
      },
      references,
      providerCapabilities,
      artifacts: [
        { bindingId: "model", role: "model", artifact: modelDescriptorPin },
        {
          bindingId: "model-policy",
          role: "tool-config",
          artifact: modelPolicyPin,
        },
        {
          bindingId: "tokenizer",
          role: "tokenizer",
          artifact: tokenizerArtifact,
        },
        { bindingId: "tokenize", role: "endpoint", artifact: tokenizeEndpoint },
        {
          bindingId: "complete",
          role: "endpoint",
          artifact: completionEndpoint,
        },
        {
          bindingId: "manifest",
          role: "tool-config",
          artifact: pin(
            "serving-manifest",
            modelPolicy.serving_manifest_sha256
          ),
        },
        {
          bindingId: "prices",
          role: "tool-config",
          artifact: pin(
            modelPolicy.pricing_source_artifact_id,
            sha(canonicalResearchChatInputJson(price))
          ),
        },
      ],
    },
    evidence: [
      {
        evidence_id: "evidence",
        collection_id: "collection",
        snapshot_id: "snapshot",
        source_id: "source",
        source_snapshot_id: "source-snapshot",
        source_uri: "https://example.com/research",
        locator: "paragraph-1",
        attribution: "Synthetic source",
        content_hash: "c".repeat(64),
        excerpt_digest: sha(excerpt),
        excerpt,
        rights_policy_id: "rights",
        captured_ns: 1_800_000_000_000_000_001n,
        published_ns: null,
        valid_until_ns: timestampToEpochNanoseconds(later),
        artifact_digest: "d".repeat(64),
        accepted_review_id: "review",
        accepted_review_revision: 9_007_199_254_740_993n,
        untrusted_content: true,
      },
    ],
    modelPolicy,
    modelPolicyPin,
    endpoints,
    modelDescriptor,
    modelDescriptorPin,
    modelPolicyBytes,
    tokenizePolicyBytes,
    completionPolicyBytes,
    modelDescriptorBytes,
    servingManifestBytes,
    pricingBytes,
    budgets: {
      requestTokens: 2000,
      attemptTokens: 1500,
      requestCostUsd: "1",
      attemptCostUsd: "0.5",
      tokenizeCostUsd: "0.01",
      completionCostUsd: "0.1",
    },
    identity: { runId: "run", traceId: "trace", expiresAt },
  };
};

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalResearchChatInputJson(value));
const rawBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesSha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
interface Fixture {
  input: ResearchChatAdvisoryOutputInput;
  original: ResearchChatProducerInput;
  response: any;
  content: any;
}
const resealRequest = async (f: Fixture): Promise<void> => {
  const request = ModelUseRequestSchema.parse(f.input.request);
  f.input = {
    ...f.input,
    request: await parseModelUseRequest({
      ...request,
      requestSha256: await computeModelUseRequestHash(request),
    }),
  };
};
const setResponse = (f: Fixture): void => {
  f.response.choices[0].message.content = canonicalResearchChatInputJson(
    f.content
  );
  f.input = { ...f.input, responseBytes: encode(f.response) };
};
const changeCompletion = async (
  f: Fixture,
  mutate: (body: any, envelope: any) => void
): Promise<void> => {
  const body = JSON.parse(
      new TextDecoder().decode(f.input.completionInputBytes)
    ),
    envelope = JSON.parse(body.messages[1].content);
  // JSON.parse is used only in test setup. Restore exact native integer fields
  // from the original producer fixture before resealing mutated approved bytes.
  envelope.data.evidence = structuredClone(f.original.evidence);
  mutate(body, envelope);
  body.messages[1].content = canonicalResearchChatInputJson(envelope);
  const completionInputBytes = encode(body),
    sha256 = bytesSha(completionInputBytes),
    byteLength = completionInputBytes.byteLength;
  f.input = {
    ...f.input,
    completionInputBytes,
    plan: { ...f.input.plan, completionInput: { sha256, byteLength } },
    request: {
      ...f.input.request,
      inputSha256: sha256,
      inputBytes: byteLength,
    },
  };
  await resealRequest(f);
};
const changeConfiguration = async (
  f: Fixture,
  mutate: (config: any) => void
): Promise<void> => {
  const config = structuredClone(f.input.configuration);
  mutate(config);
  const configuration =
    VertexResearchChatExpertConfigurationV1Schema.parse(config);
  f.input = {
    ...f.input,
    configuration,
    plan: {
      ...f.input.plan,
      participantConfiguration: {
        ...f.input.plan.participantConfiguration,
        artifactSha256: await hashArtifact(configuration),
      },
      provider: configuration.provider,
      reviewPins: configuration.reviewPins,
      advisoryMaximumBytes: configuration.advisoryMaximumBytes,
    },
  };
};
const fixture = async (mutate?: (policies: any) => void): Promise<Fixture> => {
  const original = await producerFixture(mutate),
    prepared = await prepareResearchChatInputs(original);
  const configuration = original.configuration,
    provider = configuration.provider,
    human = original.humanContext;
  const bytesPin = (bytes: Uint8Array) => ({
    sha256: bytesSha(bytes),
    byteLength: bytes.byteLength,
  });
  const plan = VertexResearchChatPlanV1Schema.parse({
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-plan-v1",
    accountAlias: "fixture",
    environment: "research",
    ownerActorId: "owner",
    responseRequestId: "response",
    threadId: "thread",
    parentMessageId: "message",
    participantId: "expert",
    snapshotRevision: human.snapshot_revision,
    contextStartSequence: human.start_sequence,
    idempotencyKey: "request-key",
    requestSha256: await hashArtifact(original.request),
    planId: "plan",
    planSha256: "a".repeat(64),
    plannedAt: "2027-01-15T08:00:00.000000123Z",
    expiresAt: original.identity.expiresAt,
    participantConfiguration: original.participantConfiguration,
    collectionId: configuration.collectionId,
    snapshotId: configuration.snapshotId,
    reviewPins: configuration.reviewPins,
    selectionId: original.selection.selectionId,
    selectionSha256: original.selection.selectionSha256,
    retentionArtifact: pin("retention", "1".repeat(64)),
    retentionSha256: "2".repeat(64),
    storageEvidence: pin("storage", "3".repeat(64)),
    capabilityReferenceId: "capability",
    backendDeploymentId: "synthetic-backend",
    storageProfileSha256: "4".repeat(64),
    provider,
    inputPolicy: prepared.fields["inputPolicy"],
    context: bytesPin(prepared.context),
    tokenizeInput: bytesPin(prepared.tokenizeInput),
    completionInput: bytesPin(prepared.completionInput),
    runId: original.identity.runId,
    traceId: original.identity.traceId,
    taskContract: configuration.taskContract,
    advisoryMaximumBytes: configuration.advisoryMaximumBytes,
    executionAuthorized: false,
  });
  const request = ModelUseRequestSchema.parse({
    schemaVersion: "1.0.0",
    requestId: "model-use-request",
    requestSha256: "0".repeat(64),
    accountAlias: "fixture",
    environment: "research",
    researchPrincipalId: "owner",
    consumerServiceId: "synthetic-worker",
    selectionId: plan.selectionId,
    selectionSha256: plan.selectionSha256,
    providerId: provider.providerId,
    modelVersion: provider.modelVersion,
    tokenizerArtifactId: provider.tokenizerArtifact.artifactId,
    tokenizerSha256: provider.tokenizerArtifact.artifactSha256,
    endpointReferenceId: original.modelPolicy.completion_endpoint_id,
    endpointSha256: provider.completionEndpoint.artifactSha256,
    modelUsePolicyVersion: "1.0.0",
    jobId: "synthetic-job",
    leaseId: "synthetic-lease",
    leaseEpoch: "1",
    grantId: "synthetic-grant",
    grantVersion: "1.0.0",
    operation: "model-completion",
    purpose: "research",
    tools: [],
    evidence: configuration.reviewPins.map(
      ({ collectionId: _collection, evidenceId: _id, ...ref }) => ref
    ),
    inputSha256: plan.completionInput.sha256,
    inputBytes: plan.completionInput.byteLength,
    inputTokens: 128,
    maximumOutputTokens: provider.maximumOutputTokens,
    maximumCostUsd: configuration.budgets.completionCostUsd,
    deadlineAt: plan.expiresAt,
  });
  const source = original.evidence[0]!;
  const citation = {
    evidence_id: source.evidence_id,
    source_id: source.source_id,
    source_snapshot_id: source.source_snapshot_id,
    content_hash: source.content_hash,
    excerpt_digest: source.excerpt_digest,
    quote: "Original bounded excerpt 雪 e\u0301 𝄞.",
  };
  const claim = {
    text: "The supplied excerpt is bounded.",
    kind: "fact",
    citations: [citation],
  };
  const content = {
    output: {
      claims: [claim],
      proposals: [
        {
          proposal_id: "proposal",
          kind: "backtest-request",
          title: "Evaluate the hypothesis",
          rationale: { ...claim, kind: "hypothesis" },
          execution_authorized: false,
        },
      ],
      execution_authorized: false,
    },
    tool_requests: [],
  };
  const response = {
    model: original.modelPolicy.served_model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "",
          refusal: null,
          tool_calls: [],
        },
      },
    ],
    usage: { prompt_tokens: 128, completion_tokens: 10, total_tokens: 138 },
    id: "ignored-provider-id",
    private_debug: {
      human_context: "PROVIDER-LEFTOVER-NEVER-RETAIN",
      fullRunResult: "NEVER",
    },
  };
  const f: Fixture = {
    original,
    response,
    content,
    input: {
      plan,
      configuration,
      request,
      responseBytes: new Uint8Array(),
      completionInputBytes: prepared.completionInput,
      modelPolicy: original.modelPolicy,
    },
  };
  await resealRequest(f);
  setResponse(f);
  return f;
};
const rejects = async (f: Fixture): Promise<void> => {
  await expect(decodeResearchChatAdvisoryOutput(f.input)).rejects.toThrow(
    "Invalid research chat advisory output"
  );
};

describe("pure original-byte research chat advisory parser", () => {
  it("retains exact frozen keys, native output and measured canonical usage only", async () => {
    const f = await fixture(),
      before = Buffer.from(f.input.completionInputBytes).toString("base64");
    const result = await decodeResearchChatAdvisoryOutput(f.input),
      retained = new TextDecoder().decode(result.bytes);
    expect(Object.keys(result.profile).sort()).toEqual(
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
    expect(result.profile["profile"]).toBe("vertex-research-chat-advisory-v1");
    expect(result.profile["output"]).toEqual(f.content.output);
    expect(result.usage).toEqual({
      inputTokens: 128,
      outputTokens: 10,
      totalTokens: 138,
      completionCostUsd: "0.000148",
    });
    expect(result.profile["usage"]).toEqual(result.usage);
    expect(result.profile["modelUseRequestSha256"]).toBe(
      f.input.request.requestSha256
    );
    expect(result.responseSha256).toBe(bytesSha(f.input.responseBytes));
    expect(result.profile["responseSha256"]).toBe(result.responseSha256);
    expect(result.profile["executionAuthorized"]).toBe(false);
    expect(retained).toBe(canonicalArtifactJson(result.profile));
    expect(result.bytes.byteLength).toBeLessThanOrEqual(
      f.input.plan.advisoryMaximumBytes
    );
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile["output"])).toBe(true);
    expect(Buffer.from(f.input.completionInputBytes).toString("base64")).toBe(
      before
    );
    for (const forbidden of [
      f.original.configuration.personaText,
      f.original.request.retrievalQuery,
      f.original.evidence[0]!.excerpt,
      f.original.humanContext.messages[0]!.body,
      "PROVIDER-LEFTOVER-NEVER-RETAIN",
      "fullRunResult",
      "source_uri",
    ])
      expect(retained).not.toContain(forbidden);
    const body = JSON.parse(
      new TextDecoder().decode(f.input.completionInputBytes)
    );
    expect(Object.keys(body)).toHaveLength(14);
    expect(body).not.toHaveProperty("tools");
    return expect(
      body.response_format.json_schema.schema.properties.tool_requests.items
    ).toBe(false);
  });
  it("rounds aggregate exact per-million USD upward to one 1e-18 unit", async () => {
    const f = await fixture(({ modelPolicy, price }: any) => {
      modelPolicy.input_usd_per_million = "0.000000000000000001";
      modelPolicy.output_usd_per_million = "0.000000000000000002";
      price.input_usd_per_million = modelPolicy.input_usd_per_million;
      return (price.output_usd_per_million =
        modelPolicy.output_usd_per_million);
    });
    return expect(
      (await decodeResearchChatAdvisoryOutput(f.input)).usage.completionCostUsd
    ).toBe("0.000000000000000001");
  });
  it("uses raw response bytes, not reserialized response, for the digest", async () => {
    const f = await fixture(),
      compact = bytesSha(f.input.responseBytes);
    f.input = {
      ...f.input,
      responseBytes: rawBytes(JSON.stringify(f.response, null, 2)),
    };
    const result = await decodeResearchChatAdvisoryOutput(f.input);
    expect(result.responseSha256).toBe(bytesSha(f.input.responseBytes));
    return expect(result.responseSha256).not.toBe(compact);
  });
  it("accepts bounded hidden exact decimals without retaining/coercing them", async () => {
    const f = await fixture();
    f.input = {
      ...f.input,
      responseBytes: rawBytes(
        new TextDecoder()
          .decode(f.input.responseBytes)
          .replace('"id":', '"timing":0.125,"large":9007199254740993,"id":')
      ),
    };
    const result = await decodeResearchChatAdvisoryOutput(f.input);
    expect(result.profile).not.toHaveProperty("timing");
    return expect(result.profile).not.toHaveProperty("large");
  });
  it("matches native Unicode code-point text limits rather than UTF-16 truncation", async () => {
    const f = await fixture();
    f.content.output.claims[0].text = "𝄞".repeat(2000);
    setResponse(f);
    return expect(
      (await decodeResearchChatAdvisoryOutput(f.input)).profile["output"]
    ).toEqual(f.content.output);
  });
  it("allows zero measured output and empty proposals without reallocating the fixed cap", async () => {
    const f = await fixture();
    f.response.usage.completion_tokens = 0;
    f.response.usage.total_tokens = 128;
    f.content.output.proposals = [];
    setResponse(f);
    const result = await decodeResearchChatAdvisoryOutput(f.input);
    expect(result.usage).toEqual({
      inputTokens: 128,
      outputTokens: 0,
      totalTokens: 128,
      completionCostUsd: "0.000128",
    });
    return expect(f.input.request.maximumOutputTokens).toBe(128);
  });
  it("rejects original model context smaller than the fixed input/output reservation", async () => {
    const f = await fixture(),
      modelPolicy = { ...f.input.modelPolicy, maximum_context_tokens: 1000 };
    const modelPolicySha256 = sha(canonicalResearchChatInputJson(modelPolicy));
    await changeConfiguration(f, (config) => {
      return (config.modelPolicy.artifactSha256 = modelPolicySha256);
    });
    f.input = {
      ...f.input,
      modelPolicy,
      plan: {
        ...f.input.plan,
        inputPolicy: {
          ...f.input.plan.inputPolicy,
          modelPolicySha256,
          modelPolicy: f.input.configuration.modelPolicy,
        },
      },
    };
    return await rejects(f);
  });
  it("rejects measured input beyond the original input bound even when usage agrees", async () => {
    const f = await fixture();
    f.input = {
      ...f.input,
      request: { ...f.input.request, inputTokens: 1001 },
    };
    await resealRequest(f);
    f.response.usage.prompt_tokens = 1001;
    f.response.usage.total_tokens = 1011;
    setResponse(f);
    return await rejects(f);
  });
  it.each([
    [
      "wrong model",
      (f: Fixture) => {
        f.response.model = "other";
      },
    ],
    [
      "input not measured",
      (f: Fixture) => {
        f.response.usage.prompt_tokens = 129;
        f.response.usage.total_tokens = 139;
      },
    ],
    [
      "output above fixed cap",
      (f: Fixture) => {
        f.response.usage.completion_tokens = 129;
        f.response.usage.total_tokens = 257;
      },
    ],
    [
      "total mismatch",
      (f: Fixture) => {
        f.response.usage.total_tokens = 137;
      },
    ],
    [
      "negative output",
      (f: Fixture) => {
        f.response.usage.completion_tokens = -1;
        f.response.usage.total_tokens = 127;
      },
    ],
    [
      "string usage",
      (f: Fixture) => {
        f.response.usage.prompt_tokens = "128";
      },
    ],
    [
      "unsafe usage",
      (f: Fixture) => {
        return (f.response.usage.total_tokens = Number.MAX_SAFE_INTEGER + 1);
      },
    ],
    [
      "multiple choices",
      (f: Fixture) => {
        f.response.choices.push(structuredClone(f.response.choices[0]));
      },
    ],
    [
      "no choices",
      (f: Fixture) => {
        return (f.response.choices = []);
      },
    ],
    [
      "truncated finish",
      (f: Fixture) => {
        f.response.choices[0].finish_reason = "length";
      },
    ],
    [
      "tool-call finish",
      (f: Fixture) => {
        f.response.choices[0].finish_reason = "tool_calls";
      },
    ],
    [
      "nonassistant role",
      (f: Fixture) => {
        f.response.choices[0].message.role = "tool";
      },
    ],
    [
      "refusal",
      (f: Fixture) => {
        f.response.choices[0].message.refusal = "No";
      },
    ],
    [
      "native tool calls",
      (f: Fixture) => {
        return (f.response.choices[0].message.tool_calls = [{ id: "tool" }]);
      },
    ],
    [
      "native function call",
      (f: Fixture) => {
        return (f.response.choices[0].message.function_call = { name: "tool" });
      },
    ],
  ] as const)("rejects response %s", async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    // Do not rewrite choices here: this case intentionally includes zero choices.
    if (f.response.choices[0])
      f.response.choices[0].message.content = canonicalResearchChatInputJson(
        f.content
      );
    f.input = {
      ...f.input,
      responseBytes: rawBytes(JSON.stringify(f.response)),
    };
    return await rejects(f);
  });
  it.each([
    [
      "missing output",
      (f: Fixture) => {
        delete f.content.output;
      },
    ],
    [
      "null output",
      (f: Fixture) => {
        f.content.output = null;
      },
    ],
    [
      "unapproved content property",
      (f: Fixture) => {
        f.content.human_context = "hidden";
      },
    ],
    [
      "tool request",
      (f: Fixture) => {
        return (f.content.tool_requests = [
          { call_id: "x", name: "read-evidence", arguments: {} },
        ]);
      },
    ],
    [
      "zero claims",
      (f: Fixture) => {
        f.content.output.claims = [];
      },
    ],
    [
      "thirteen claims",
      (f: Fixture) => {
        return (f.content.output.claims = Array.from({ length: 13 }, () =>
          structuredClone(f.content.output.claims[0])
        ));
      },
    ],
    [
      "empty text",
      (f: Fixture) => {
        f.content.output.claims[0].text = "";
      },
    ],
    [
      "long text",
      (f: Fixture) => {
        f.content.output.claims[0].text = "x".repeat(2001);
      },
    ],
    [
      "control text",
      (f: Fixture) => {
        f.content.output.claims[0].text = "unsafe\u0001";
      },
    ],
    [
      "unsupported kind",
      (f: Fixture) => {
        f.content.output.claims[0].kind = "instruction";
      },
    ],
    [
      "no citations",
      (f: Fixture) => {
        f.content.output.claims[0].citations = [];
      },
    ],
    [
      "duplicate citation",
      (f: Fixture) => {
        f.content.output.claims[0].citations.push(
          structuredClone(f.content.output.claims[0].citations[0])
        );
      },
    ],
    [
      "ninth citation",
      (f: Fixture) => {
        return (f.content.output.claims[0].citations = Array.from(
          { length: 9 },
          () => structuredClone(f.content.output.claims[0].citations[0])
        ));
      },
    ],
    [
      "wrong evidence",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].evidence_id = "unknown";
      },
    ],
    [
      "wrong source",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].source_id = "unknown";
      },
    ],
    [
      "wrong snapshot",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].source_snapshot_id = "unknown";
      },
    ],
    [
      "wrong content digest",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].content_hash = "f".repeat(64);
      },
    ],
    [
      "wrong excerpt digest",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].excerpt_digest = "f".repeat(64);
      },
    ],
    [
      "empty quote",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].quote = "";
      },
    ],
    [
      "wrong quote",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].quote = "Invented quote";
      },
    ],
    [
      "long quote",
      (f: Fixture) => {
        return (f.content.output.claims[0].citations[0].quote = "x".repeat(
          1001
        ));
      },
    ],
    [
      "full evidence projection",
      (f: Fixture) => {
        f.content.output.claims[0].citations[0].excerpt = "copied corpus";
      },
    ],
    [
      "execution output",
      (f: Fixture) => {
        f.content.output.execution_authorized = true;
      },
    ],
    [
      "execution proposal",
      (f: Fixture) => {
        f.content.output.proposals[0].execution_authorized = true;
      },
    ],
    [
      "invalid proposal kind",
      (f: Fixture) => {
        f.content.output.proposals[0].kind = "place-order";
      },
    ],
    [
      "invalid proposal identity",
      (f: Fixture) => {
        f.content.output.proposals[0].proposal_id = "invalid id";
      },
    ],
    [
      "duplicate proposal",
      (f: Fixture) => {
        f.content.output.proposals.push(
          structuredClone(f.content.output.proposals[0])
        );
      },
    ],
    [
      "ninth proposal",
      (f: Fixture) => {
        return (f.content.output.proposals = Array.from(
          { length: 9 },
          (_, index) => ({
            ...f.content.output.proposals[0],
            proposal_id: `proposal-${index}`,
          })
        ));
      },
    ],
    [
      "long proposal title",
      (f: Fixture) => {
        f.content.output.proposals[0].title = "x".repeat(201);
      },
    ],
    [
      "uncited rationale",
      (f: Fixture) => {
        f.content.output.proposals[0].rationale.citations = [];
      },
    ],
    [
      "camelcase native output",
      (f: Fixture) => {
        delete f.content.output.execution_authorized;
        f.content.output.executionAuthorized = false;
      },
    ],
  ] as const)("rejects advisory %s", async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    setResponse(f);
    return await rejects(f);
  });
  it.each([
    [
      "raw duplicate",
      (s: string) => s.replace('"model":', '"model":"wrong","model":'),
    ],
    [
      "escaped duplicate",
      (s: string) => s.replace('"model":', '"\\u006dodel":"wrong","model":'),
    ],
    [
      "nested duplicate",
      (s: string) =>
        s.replace('"prompt_tokens":', '"prompt_tokens":128,"prompt_tokens":'),
    ],
    [
      "float usage",
      (s: string) => s.replace('"prompt_tokens":128', '"prompt_tokens":128.0'),
    ],
    [
      "nonfinite",
      (s: string) => s.replace('"prompt_tokens":128', '"prompt_tokens":NaN'),
    ],
    [
      "overflow exponent",
      (s: string) => s.replace('"id":', '"hidden":1e300,"id":'),
    ],
    [
      "too precise decimal",
      (s: string) => s.replace('"id":', '"hidden":0.0000000000000000001,"id":'),
    ],
    [
      "invalid Unicode key",
      (s: string) => s.replace('"id":', '"\\ud800":"hidden","id":'),
    ],
    ["trailing garbage", (s: string) => `${s} true`],
  ] as const)("rejects bounded JSON %s", async (_name, transform) => {
    const f = await fixture();
    f.input = {
      ...f.input,
      responseBytes: rawBytes(
        transform(new TextDecoder().decode(f.input.responseBytes))
      ),
    };
    return await rejects(f);
  });
  it.each([
    [
      "duplicate content key",
      (s: string) =>
        s.replace('"tool_requests":', '"tool_requests":[],"tool_requests":'),
    ],
    [
      "content surrogate",
      (s: string) =>
        s.replace('"The supplied excerpt is bounded."', '"\\ud800"'),
    ],
    [
      "numeric string coercion",
      (s: string) => s.replace('"The supplied excerpt is bounded."', "1.0"),
    ],
    ["content markdown wrapper", (s: string) => `\`\`\`json\n${s}\n\`\`\``],
  ] as const)("rejects decoded %s", async (_name, transform) => {
    const f = await fixture();
    f.response.choices[0].message.content = transform(
      f.response.choices[0].message.content
    );
    f.input = {
      ...f.input,
      responseBytes: rawBytes(JSON.stringify(f.response)),
    };
    return await rejects(f);
  });
  it.each(["raw bytes", "content bytes", "depth", "nodes", "utf8"] as const)(
    "rejects %s limit violations",
    async (kind) => {
      const f = await fixture();
      if (kind === "raw bytes")
        f.input = {
          ...f.input,
          responseBytes: rawBytes(" ".repeat(1_048_577)),
        };
      if (kind === "content bytes") {
        f.response.choices[0].message.content = " ".repeat(500_001);
        f.input = {
          ...f.input,
          responseBytes: rawBytes(JSON.stringify(f.response)),
        };
      }
      if (kind === "depth") {
        const nested = `${"[".repeat(25)}0${"]".repeat(25)}`;
        f.input = {
          ...f.input,
          responseBytes: rawBytes(
            new TextDecoder()
              .decode(f.input.responseBytes)
              .replace('"id":', `"hidden":${nested},"id":`)
          ),
        };
      }
      if (kind === "nodes") {
        f.response.hidden = Array.from({ length: 100_001 }, () => null);
        f.input = {
          ...f.input,
          responseBytes: rawBytes(JSON.stringify(f.response)),
        };
      }
      if (kind === "utf8")
        f.input = { ...f.input, responseBytes: new Uint8Array([0xc3, 0x28]) };
      return await rejects(f);
    }
  );
  it("rejects a retained profile beyond the original smaller advisory cap", async () => {
    const f = await fixture();
    await changeConfiguration(f, (config) => {
      return (config.advisoryMaximumBytes = 100);
    });
    return await rejects(f);
  });
  it("rejects retained bytes above 262144 even when original cap is larger", async () => {
    const f = await fixture();
    await changeConfiguration(f, (config) => {
      return (config.advisoryMaximumBytes = 1_048_576);
    });
    await changeCompletion(f, (_body, envelope) => {
      const excerpt = "x".repeat(1007);
      envelope.data.evidence[0].excerpt = excerpt;
      return (envelope.data.evidence[0].excerpt_digest = sha(excerpt));
    });
    const excerptDigest = sha("x".repeat(1007)),
      base = f.content.output.claims[0].citations[0];
    const large = {
      text: "𝄞".repeat(2000),
      kind: "fact",
      citations: Array.from({ length: 8 }, (_, index) => ({
        ...base,
        excerpt_digest: excerptDigest,
        quote: "x".repeat(1000 - index),
      })),
    };
    f.content.output.claims = Array.from({ length: 12 }, () =>
      structuredClone(large)
    );
    f.content.output.proposals = Array.from({ length: 8 }, (_, index) => ({
      proposal_id: `p-${index}`,
      kind: "backtest-request",
      title: "x",
      rationale: structuredClone(large),
      execution_authorized: false,
    }));
    setResponse(f);
    expect(
      rawBytes(f.response.choices[0].message.content).byteLength
    ).toBeLessThan(500_000);
    expect(f.input.responseBytes.byteLength).toBeLessThan(1_048_576);
    return await rejects(f);
  });
  it.each([
    [
      "request digest",
      async (f: Fixture) => {
        return (f.input = {
          ...f.input,
          request: { ...f.input.request, requestSha256: "f".repeat(64) },
        });
      },
    ],
    [
      "completion digest",
      async (f: Fixture) => {
        return (f.input = { ...f.input, completionInputBytes: rawBytes("{}") });
      },
    ],
    [
      "configuration digest",
      async (f: Fixture) => {
        return (f.input = {
          ...f.input,
          configuration: { ...f.input.configuration, personaText: "changed" },
        });
      },
    ],
    [
      "model policy digest",
      async (f: Fixture) => {
        return (f.input = {
          ...f.input,
          modelPolicy: { ...f.input.modelPolicy, input_usd_per_million: "3" },
        });
      },
    ],
    [
      "request evidence",
      async (f: Fixture) => {
        f.input = { ...f.input, request: { ...f.input.request, evidence: [] } };
        return await resealRequest(f);
      },
    ],
    [
      "request endpoint",
      async (f: Fixture) => {
        f.input = {
          ...f.input,
          request: { ...f.input.request, endpointReferenceId: "wrong" },
        };
        return await resealRequest(f);
      },
    ],
    [
      "request output cap",
      async (f: Fixture) => {
        f.input = {
          ...f.input,
          request: { ...f.input.request, maximumOutputTokens: 127 },
        };
        return await resealRequest(f);
      },
    ],
    [
      "request completion budget",
      async (f: Fixture) => {
        f.input = {
          ...f.input,
          request: { ...f.input.request, maximumCostUsd: "0.01" },
        };
        return await resealRequest(f);
      },
    ],
  ] as const)("rejects original %s mismatch", async (_name, mutate) => {
    const f = await fixture();
    await mutate(f);
    return await rejects(f);
  });
  it.each([
    [
      "request tokens",
      (config: any) => {
        config.budgets.requestTokens = 1400;
      },
    ],
    [
      "attempt tokens",
      (config: any) => {
        config.budgets.attemptTokens = 1000;
      },
    ],
    [
      "request cost",
      (config: any) => {
        config.budgets.requestCostUsd = "0.4";
      },
    ],
    [
      "attempt cost",
      (config: any) => {
        config.budgets.attemptCostUsd = "0.05";
      },
    ],
    [
      "tokenize cost",
      (config: any) => {
        config.budgets.tokenizeCostUsd = "0.31";
      },
    ],
    [
      "completion cost",
      (config: any) => {
        config.budgets.completionCostUsd = "0.000001";
      },
    ],
    [
      "provider cost",
      (config: any) => {
        config.provider.maximumCostUsd = "0.05";
      },
    ],
  ] as const)(
    "rejects inconsistent original %s budget",
    async (_name, mutate) => {
      const f = await fixture();
      await changeConfiguration(f, mutate);
      f.input = {
        ...f.input,
        request: {
          ...f.input.request,
          maximumCostUsd: f.input.configuration.budgets.completionCostUsd,
        },
      };
      await resealRequest(f);
      return await rejects(f);
    }
  );
  it.each([
    [
      "missing response_format",
      (body: any, _envelope: any) => {
        delete body.response_format;
      },
    ],
    [
      "tools key injected",
      (body: any, _envelope: any) => {
        body.tools = null;
      },
    ],
    [
      "changed fixed completion cap",
      (body: any, _envelope: any) => {
        body.max_completion_tokens = 127;
      },
    ],
    [
      "schema unsupported keyword",
      (body: any, envelope: any) => {
        body.response_format.json_schema.schema.$ref = "#";
        return (envelope.response_contract =
          body.response_format.json_schema.schema);
      },
    ],
    [
      "schema unsupported unused branch",
      (body: any, envelope: any) => {
        body.response_format.json_schema.schema.properties.output.anyOf[1] = {
          type: "null",
          title: "unsupported",
        };
        return (envelope.response_contract =
          body.response_format.json_schema.schema);
      },
    ],
    [
      "schema not strict",
      (body: any, _envelope: any) => {
        body.response_format.json_schema.strict = false;
      },
    ],
    [
      "schema excludes actual fact",
      (body: any, envelope: any) => {
        body.response_format.json_schema.schema.properties.output.anyOf[0].properties.claims.items.properties.kind.enum =
          ["limitation"];
        return (envelope.response_contract =
          body.response_format.json_schema.schema);
      },
    ],
    [
      "envelope schema mismatch",
      (_body: any, envelope: any) => {
        envelope.response_contract = false;
      },
    ],
    [
      "evidence identity mismatch",
      (_body: any, envelope: any) => {
        envelope.data.evidence[0].evidence_id = "other";
      },
    ],
    [
      "original excerpt digest mismatch",
      (_body: any, envelope: any) => {
        envelope.data.evidence[0].excerpt = "tampered";
      },
    ],
    [
      "original evidence extra property",
      (_body: any, envelope: any) => {
        envelope.data.evidence[0].authorization = true;
      },
    ],
    [
      "original evidence missing",
      (_body: any, envelope: any) => {
        return (envelope.data.evidence = []);
      },
    ],
    [
      "original evidence integer overflow",
      (_body: any, envelope: any) => {
        return (envelope.data.evidence[0].valid_until_ns = 2n ** 127n);
      },
    ],
    [
      "original evidence expires before plan",
      (_body: any, envelope: any) => {
        return (envelope.data.evidence[0].valid_until_ns =
          envelope.data.evidence[0].captured_ns + 1n);
      },
    ],
  ] as const)(
    "validates original approved input %s, never substitutes a schema",
    async (_name, mutate) => {
      const f = await fixture();
      await changeCompletion(f, mutate);
      return await rejects(f);
    }
  );
  it("rejects duplicate keys in original completion bytes despite matching byte pins", async () => {
    const f = await fixture(),
      original = new TextDecoder().decode(f.input.completionInputBytes);
    const completionInputBytes = rawBytes(
        original.replace('"model":', '"model":"served-model","model":')
      ),
      sha256 = bytesSha(completionInputBytes);
    f.input = {
      ...f.input,
      completionInputBytes,
      plan: {
        ...f.input.plan,
        completionInput: {
          sha256,
          byteLength: completionInputBytes.byteLength,
        },
      },
      request: {
        ...f.input.request,
        inputSha256: sha256,
        inputBytes: completionInputBytes.byteLength,
      },
    };
    await resealRequest(f);
    return await rejects(f);
  });
  it("does not invoke accessors as data sources", async () => {
    const f = await fixture();
    let reads = 0;
    const input = { ...f.input };
    Object.defineProperty(input, "modelPolicy", {
      enumerable: true,
      get: () => {
        reads += 1;
        return f.input.modelPolicy;
      },
    });
    await expect(decodeResearchChatAdvisoryOutput(input)).rejects.toThrow(
      "Invalid research chat advisory output"
    );
    return expect(reads).toBe(0);
  });
});
