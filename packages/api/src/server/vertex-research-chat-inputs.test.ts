import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  VertexResearchChatExpertConfigurationV1Schema,
  VertexResearchChatInputPolicyV1Schema,
} from "../contracts/vertex-research-chat-execution.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import { VertexRuntimeModelDescriptorSchema } from "./vertex-runtime-model-evidence.ts";
import {
  assertResearchChatMeasuredTokens,
  canonicalResearchChatInputJson,
  prepareResearchChatInputs,
  researchChatAdvisorySchema,
  type ResearchChatEndpointPolicy,
  type ResearchChatProducerInput,
} from "./vertex-research-chat-inputs.ts";
import {
  researchParityPython,
  researchParityPythonSkip,
  researchParityPythonSkipNote,
} from "./research-python.test-support.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
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
const fixture = async (
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

describe("pure exact one-expert input producer", () => {
  it("matches Python provider-body bytes/schema and legacy identity, not policy metadata, without optional SDKs or network", async ({
    skip,
  }) => {
    skip(researchParityPythonSkip, researchParityPythonSkipNote);
    const input = await fixture(),
      prepared = await prepareResearchChatInputs(input);
    const python = researchParityPython;
    const result = spawnSync(
      python,
      [
        resolve(root, "services/research/adapters/tests/test_chat_inputs.py"),
        "--mirror",
      ],
      {
        cwd: resolve(root, "services/research"),
        env: {
          ...process.env,
          PYTHONPATH: resolve(root, "services/research"),
          PYTHONDONTWRITEBYTECODE: "1",
        },
        input: canonicalResearchChatInputJson(
          Object.fromEntries(
            Object.entries(input).filter(([key]) => !key.endsWith("Bytes"))
          )
        ),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1_048_576,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const mirror = JSON.parse(result.stdout);
    expect(mirror.fields).toEqual({
      runId: prepared.fields["runId"],
      traceId: prepared.fields["traceId"],
      expiresAt: prepared.fields["expiresAt"],
    });
    expect(
      VertexResearchChatInputPolicyV1Schema.safeParse(
        prepared.fields["inputPolicy"]
      ).success
    ).toBe(true);
    for (const key of ["context", "tokenizeInput", "completionInput"] as const)
      expect(Buffer.from(prepared[key]).toString("base64")).toBe(mirror[key]);
    return expect(researchChatAdvisorySchema()).toEqual(mirror.schema);
  });
  it("binds full validated nonsecret DTOs and original selected pins without copying policy or human plaintext", async () => {
    const input = await fixture(),
      prepared = await prepareResearchChatInputs(input);
    const policy = VertexResearchChatInputPolicyV1Schema.parse(
      prepared.fields["inputPolicy"]
    );
    expect(policy).toEqual({
      modelPolicySha256: sha(canonicalResearchChatInputJson(input.modelPolicy)),
      modelPolicy: input.modelPolicyPin,
      endpointPolicySha256: {
        "model-tokenize": sha(
          canonicalResearchChatInputJson(input.endpoints[0])
        ),
        "model-completion": sha(
          canonicalResearchChatInputJson(input.endpoints[1])
        ),
      },
      modelDescriptorSha256: sha(canonicalArtifactJson(input.modelDescriptor)),
      modelDescriptor: input.modelDescriptorPin,
    });
    expect(Object.isFrozen(prepared.fields["inputPolicy"])).toBe(true);
    expect(Object.isFrozen(policy.endpointPolicySha256)).toBe(true);
    const metadata = canonicalArtifactJson(prepared.fields);
    for (const text of [
      input.request.retrievalQuery,
      input.evidence[0]!.excerpt,
      input.humanContext.messages[0]!.body,
      input.endpoints[0].origin,
      input.endpoints[0].credential_reference_id,
      input.modelPolicy.model_revision,
    ])
      expect(metadata).not.toContain(text);
    expect(
      input.selection.artifacts
        .filter((entry) => entry.role === "model")
        .map((entry) => entry.artifact)
    ).toEqual([input.modelDescriptorPin]);
    return expect(
      input.selection.artifacts.find(
        (entry) => entry.artifact.artifactId === input.modelPolicyPin.artifactId
      )!.role
    ).toBe("tool-config");
  });
  it.each([
    "model-revision",
    "chat-template",
    "serving-manifest",
    "pricing-source",
    "model-policy",
    "descriptor-pricing",
  ])(
    "binds immutable %s policy and configuration-derived provider bytes",
    async (name) => {
      const original = await fixture(),
        before = await prepareResearchChatInputs(original);
      const changed = await fixture(
        ({ modelPolicy, manifest, descriptorPricing }) => {
          if (name === "model-revision") {
            manifest.model_revision = "9".repeat(40);
            modelPolicy.model_revision = manifest.model_revision;
          }
          if (name === "chat-template") {
            manifest.chat_template_sha256 = "9".repeat(64);
            modelPolicy.chat_template_sha256 = manifest.chat_template_sha256;
          }
          if (name === "serving-manifest")
            manifest.runtime_image_sha256 = "9".repeat(64);
          if (name === "pricing-source")
            modelPolicy.pricing_source_artifact_id = "other-pricing-source";
          if (name === "model-policy")
            modelPolicy.policy_id = "other-model-policy";
          if (name === "descriptor-pricing")
            return (descriptorPricing.completionBaseUsd = "0.002");
          return;
        }
      );
      const after = await prepareResearchChatInputs(changed);
      const beforePolicy = VertexResearchChatInputPolicyV1Schema.parse(
        before.fields["inputPolicy"]
      );
      const afterPolicy = VertexResearchChatInputPolicyV1Schema.parse(
        after.fields["inputPolicy"]
      );
      if (name === "descriptor-pricing") {
        expect(afterPolicy.modelPolicy).toEqual(beforePolicy.modelPolicy);
        expect(afterPolicy.modelDescriptorSha256).not.toBe(
          beforePolicy.modelDescriptorSha256
        );
        expect(changed.participantConfiguration).toEqual(
          original.participantConfiguration
        );
        for (const key of [
          "context",
          "tokenizeInput",
          "completionInput",
        ] as const)
          expect(after[key]).toEqual(before[key]);
      } else {
        expect(afterPolicy.modelPolicySha256).not.toBe(
          beforePolicy.modelPolicySha256
        );
        expect(afterPolicy.modelPolicy).toEqual(changed.modelPolicyPin);
        expect(afterPolicy.modelPolicy).not.toEqual(beforePolicy.modelPolicy);
        expect(changed.configuration.modelPolicy).toEqual(
          afterPolicy.modelPolicy
        );
        expect(changed.participantConfiguration.artifactSha256).toBe(
          sha(canonicalArtifactJson(changed.configuration))
        );
        expect(changed.participantConfiguration.artifactSha256).not.toBe(
          original.participantConfiguration.artifactSha256
        );
        expect(changed.humanContext.participant_config_sha256).toBe(
          changed.participantConfiguration.artifactSha256
        );
        expect(changed.humanContext.participant_config_sha256).not.toBe(
          original.humanContext.participant_config_sha256
        );
        expect(JSON.parse(new TextDecoder().decode(after.context))).toEqual(
          changed.humanContext
        );
        for (const key of [
          "context",
          "tokenizeInput",
          "completionInput",
        ] as const)
          expect(after[key]).not.toEqual(before[key]);
        for (const key of ["tokenizeInput", "completionInput"] as const) {
          const body = JSON.parse(new TextDecoder().decode(after[key]));
          const inert = JSON.parse(body.messages[1].content);
          expect(inert.data.human_context).toEqual(changed.humanContext);
          expect(inert.data.human_context.participant_config_sha256).toBe(
            changed.participantConfiguration.artifactSha256
          );
        }
      }
      expect(canonicalArtifactJson(after.fields["inputPolicy"])).not.toBe(
        canonicalArtifactJson(before.fields["inputPolicy"])
      );
      // The owner compares every re-resolved field. Neither changed config/body
      // descriptors nor equal bodies with changed descriptor metadata bypass pins.
      return expect(
        Object.entries(after.fields).every(
          ([key, value]) =>
            canonicalArtifactJson(value) ===
            canonicalArtifactJson(before.fields[key])
        )
      ).toBe(false);
    }
  );
  it.each(["model-tokenize", "model-completion"])(
    "pins all %s routing, credential and policy fields; rejects unpinned mutations",
    async (operation) => {
      const original = await fixture();
      const index = operation === "model-tokenize" ? 0 : 1;
      for (const [key, value] of Object.entries({
        origin: "https://other.example.com",
        credential_reference_id: "other-reference",
        credential_header: "X-Other",
        credential_prefix: "Other ",
        policy_id: "other-policy",
        source_reference: "other-source",
        timeout_ms: 1001,
        maximum_response_bytes: 999_999,
      })) {
        const changed: any = structuredClone(original);
        changed.endpoints[index][key] = value;
        await expect(prepareResearchChatInputs(changed)).rejects.toThrow();
      }
      const before = await prepareResearchChatInputs(original);
      const repinned = await prepareResearchChatInputs(
        await fixture(({ endpoints }) => {
          return (endpoints[index].source_reference = "repinned-source");
        })
      );
      const beforePolicy = VertexResearchChatInputPolicyV1Schema.parse(
        before.fields["inputPolicy"]
      );
      const afterPolicy = VertexResearchChatInputPolicyV1Schema.parse(
        repinned.fields["inputPolicy"]
      );
      expect(
        afterPolicy.endpointPolicySha256[
          operation as "model-tokenize" | "model-completion"
        ]
      ).not.toBe(
        beforePolicy.endpointPolicySha256[
          operation as "model-tokenize" | "model-completion"
        ]
      );
      // Valid endpoint repinning also changes the configuration hash carried by
      // human context; it cannot honestly retain the identical provider body.
      return expect(repinned.completionInput).not.toEqual(
        before.completionInput
      );
    }
  );
  it.each([
    "modelPolicyBytes",
    "tokenizePolicyBytes",
    "completionPolicyBytes",
    "modelDescriptorBytes",
    "servingManifestBytes",
    "pricingBytes",
  ])(
    "requires original selected %s bytes and rejects alteration or omission",
    async (key) => {
      const altered: any = structuredClone(await fixture());
      altered[key][0] += altered[key][0] % 2 === 0 ? 1 : -1; // flip lowest bit
      await expect(prepareResearchChatInputs(altered)).rejects.toThrow();
      const missing: any = structuredClone(await fixture());
      delete missing[key];
      return await expect(prepareResearchChatInputs(missing)).rejects.toThrow();
    }
  );
  it.each([
    "missing-credential",
    "reference-hash",
    "capability-hash",
    "capability-operation",
    "duplicate-capability",
    "endpoint-binding",
    "model-role",
    "descriptor-role",
    "duplicate-model",
    "manifest-role",
    "pricing-role",
    "manifest-content",
    "pricing-content",
  ])("rejects unbound selected policy provenance: %s", async (name) => {
    const input: any = structuredClone(await fixture());
    if (name === "missing-credential")
      input.selection.references = input.selection.references.filter(
        (entry: any) => entry.kind !== "secret-reference"
      );
    if (name === "reference-hash")
      input.selection.references[0].referenceSha256 = "0".repeat(64);
    if (name === "capability-hash")
      input.selection.providerCapabilities[0].endpointSha256 = "0".repeat(64);
    if (name === "capability-operation")
      input.selection.providerCapabilities[0].operation = "other-operation";
    if (name === "duplicate-capability")
      input.selection.providerCapabilities.push({
        ...input.selection.providerCapabilities[0],
        capabilityId: "other-capability",
      });
    if (name === "endpoint-binding")
      input.selection.artifacts.find(
        (entry: any) => entry.bindingId === "tokenize"
      ).bindingId = "other-tokenize";
    if (name === "model-role")
      input.selection.artifacts.find(
        (entry: any) => entry.bindingId === "model-policy"
      ).role = "provider-config";
    if (name === "descriptor-role")
      input.selection.artifacts[0].role = "tool-config";
    if (name === "duplicate-model")
      input.selection.artifacts.push({
        bindingId: "other-model",
        role: "model",
        artifact: pin("other-model", "9".repeat(64)),
      });
    if (name === "manifest-role")
      input.selection.artifacts.find(
        (entry: any) => entry.bindingId === "manifest"
      ).role = "provider-config";
    if (name === "pricing-role")
      input.selection.artifacts.find(
        (entry: any) => entry.bindingId === "prices"
      ).role = "provider-config";
    if (name === "manifest-content" || name === "pricing-content") {
      const key =
        name === "manifest-content" ? "servingManifestBytes" : "pricingBytes";
      const document = JSON.parse(new TextDecoder().decode(input[key]));
      document.model_version = "other-model";
      input[key] = new TextEncoder().encode(
        canonicalResearchChatInputJson(document)
      );
      const digest = sha(canonicalResearchChatInputJson(document));
      input.selection.artifacts.find(
        (entry: any) =>
          entry.bindingId ===
          (name === "manifest-content" ? "manifest" : "prices")
      ).artifact.artifactSha256 = digest;
      if (name === "manifest-content") {
        input.modelPolicy.serving_manifest_sha256 = digest;
        input.modelPolicyBytes = new TextEncoder().encode(
          canonicalResearchChatInputJson(input.modelPolicy)
        );
        input.modelPolicyPin.artifactSha256 = sha(
          canonicalResearchChatInputJson(input.modelPolicy)
        );
      }
    }
    return await expect(prepareResearchChatInputs(input)).rejects.toThrow();
  });
  it.each(["different-dto", "unknown-field", "noncanonical", "duplicate-key"])(
    "rejects %s even when original-byte hash matches selected ModelPolicy pin",
    async (name) => {
      const input: any = structuredClone(await fixture());
      let text = canonicalResearchChatInputJson(input.modelPolicy);
      if (name === "different-dto")
        text = canonicalResearchChatInputJson({
          ...input.modelPolicy,
          policy_id: "other-policy",
        });
      if (name === "unknown-field")
        text = canonicalResearchChatInputJson({
          ...input.modelPolicy,
          authorized: true,
        });
      if (name === "noncanonical") text += "\n";
      if (name === "duplicate-key")
        text = text.replace(
          '"policy_id":"policy"',
          '"policy_id":"ignored","policy_id":"policy"'
        );
      input.modelPolicyBytes = new TextEncoder().encode(text);
      input.modelPolicyPin.artifactSha256 = sha(text);
      return await expect(prepareResearchChatInputs(input)).rejects.toThrow();
    }
  );
  it("keeps exact descriptor pin authoritative independently of DTO digest", async () => {
    const original = await fixture(),
      before = await prepareResearchChatInputs(original);
    const changed: any = structuredClone(original);
    changed.modelDescriptorPin.artifactId = "different-descriptor-artifact";
    const after = await prepareResearchChatInputs(changed);
    const previous = VertexResearchChatInputPolicyV1Schema.parse(
      before.fields["inputPolicy"]
    );
    const next = VertexResearchChatInputPolicyV1Schema.parse(
      after.fields["inputPolicy"]
    );
    expect(next.modelDescriptorSha256).toBe(previous.modelDescriptorSha256);
    expect(next.modelDescriptor).toEqual(changed.modelDescriptorPin);
    expect(canonicalArtifactJson(next)).not.toBe(
      canonicalArtifactJson(previous)
    );
    return expect(after.completionInput).toEqual(before.completionInput);
  });
  it("rejects caller policy injection and accessor byte suppliers without invoking them", async () => {
    const input = await fixture();
    await expect(
      prepareResearchChatInputs({
        ...input,
        inputPolicy: { authorized: true },
      } as any)
    ).rejects.toThrow();
    let invoked = false;
    const getter = Object.defineProperty({ ...input }, "modelPolicyBytes", {
      enumerable: true,
      get: () => {
        invoked = true;
        return input.modelPolicyBytes;
      },
    });
    await expect(prepareResearchChatInputs(getter)).rejects.toThrow();
    return expect(invoked).toBe(false);
  });
  it("preserves exact complete schema, omitted completion tools and tokenizer null", async () => {
    const prepared = await prepareResearchChatInputs(await fixture());
    const tokenize = JSON.parse(Buffer.from(prepared.tokenizeInput).toString()),
      complete = JSON.parse(Buffer.from(prepared.completionInput).toString());
    expect(Object.keys(complete).sort()).toEqual(
      [
        "model",
        "messages",
        "store",
        "max_completion_tokens",
        "response_format",
        "stream",
        "n",
        "tool_choice",
        "add_generation_prompt",
        "continue_final_message",
        "add_special_tokens",
        "chat_template_kwargs",
        "truncate_prompt_tokens",
        "skip_special_tokens",
      ].sort()
    );
    expect("tools" in complete).toBe(false);
    expect(tokenize.tools).toBeNull();
    expect(complete.messages).toEqual(tokenize.messages);
    expect(complete.messages).toHaveLength(2);
    expect(complete.messages.map((value: any) => value.role)).toEqual([
      "system",
      "user",
    ]);
    const text = complete.messages[1].content;
    expect(text).toContain('"captured_ns":1800000000000000001');
    expect(text).toContain('"accepted_review_revision":9007199254740993');
    expect(text).toContain('"published_ns":null');
    const payload = JSON.parse(text);
    expect(payload.inert_tool_names).toEqual([]);
    expect(payload.data.human_context).toEqual(
      JSON.parse(Buffer.from(prepared.context).toString())
    );
    expect(payload.data.evidence).toHaveLength(1);
    expect(payload.data.prior_analyses).toEqual([]);
    expect(payload.data.tool_results).toEqual([]);
    expect(complete.max_completion_tokens).toBe(128);
    return expect(Object.keys(prepared.fields).sort()).toEqual([
      "expiresAt",
      "inputPolicy",
      "runId",
      "traceId",
    ]);
  });
  it("uses Unicode scalar ordering and rejects float/lossy/custom JSON", () => {
    expect(
      canonicalResearchChatInputJson({
        "\u{10000}": 9007199254740993n,
        "\ue000": null,
        z: '雪\n\t"',
      })
    ).toBe('{"z":"雪\\n\\t\\"","\ue000":null,"\u{10000}":9007199254740993}');
    for (const value of [
      0.25,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      9_007_199_254_740_992,
      undefined,
      "\ud800",
      new Date(0),
      [1, undefined],
      { x: 1, [Symbol("x")]: 2 },
    ]) {
      expect(() => canonicalResearchChatInputJson(value)).toThrow();
    }
    let called = false;
    const value = Object.defineProperty({}, "x", {
      enumerable: true,
      get: () => {
        called = true;
        return 1;
      },
    });
    expect(() => canonicalResearchChatInputJson(value)).toThrow();
    expect(called).toBe(false);
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => canonicalResearchChatInputJson(cycle)).toThrow();
    // All constants in the copied pinned response schema are integer-valued.
    return expect(() =>
      canonicalResearchChatInputJson(researchChatAdvisorySchema())
    ).not.toThrow();
  });
  it("keeps fixed output after measurement and rejects prompt/total infeasibility", async () => {
    const input = await fixture(),
      before = await prepareResearchChatInputs(input);
    expect(() => assertResearchChatMeasuredTokens(input, 200)).not.toThrow();
    expect(
      input.budgets.attemptTokens -
        input.configuration.provider.maximumOutputTokens
    ).not.toBe(200);
    expect(await prepareResearchChatInputs(input)).toEqual(before);
    expect(() => assertResearchChatMeasuredTokens(input, 1001)).toThrow();
    expect(() =>
      assertResearchChatMeasuredTokens(
        { ...input, budgets: { ...input.budgets, attemptTokens: 250 } },
        200
      )
    ).toThrow();
    return await expect(
      prepareResearchChatInputs({
        ...input,
        budgets: { ...input.budgets, attemptTokens: 1100 },
      })
    ).rejects.toThrow();
  });
  it.each([
    "excerpt",
    "unsafe-ns",
    "float-ns",
    "review",
    "owner",
    "response",
    "model",
    "tokenizer",
    "endpoint",
    "origin",
    "ips",
    "oversized",
    "pin",
    "zero-tokenize",
    "cost",
    "expired",
    "configuration",
  ])("rejects %s mismatches without inventing defaults", async (name) => {
    const input: any = structuredClone(await fixture());
    if (name === "excerpt")
      input.evidence[0].excerpt = "Rewritten source excerpt.";
    if (name === "unsafe-ns")
      input.evidence[0].captured_ns = 1_800_000_000_000_000_000;
    if (name === "float-ns") input.evidence[0].captured_ns = 0.5;
    if (name === "review")
      input.evidence[0].accepted_review_id = "other-review";
    if (name === "owner") input.ownerActorId = "other-owner";
    if (name === "response") input.responseRequestId = "other-response";
    if (name === "model") input.modelPolicy.model_version = "other-model";
    if (name === "tokenizer")
      input.modelPolicy.tokenizer_sha256 = "9".repeat(64);
    if (name === "endpoint") input.endpoints[0].path = "/wrong";
    if (name === "origin")
      input.endpoints[0].origin = "https://other.example.com";
    if (name === "ips") input.endpoints[0].allowed_ip_addresses = ["192.0.2.2"];
    if (name === "oversized") input.endpoints[1].maximum_request_bytes = 10;
    if (name === "pin")
      input.selection.artifacts[0].artifact.artifactSha256 = "9".repeat(64);
    if (name === "zero-tokenize") input.budgets.tokenizeCostUsd = "0";
    if (name === "cost") input.budgets.completionCostUsd = "0.00001";
    if (name === "expired")
      input.identity.expiresAt = "2028-01-15T08:01:00.000000123Z";
    if (name === "configuration")
      input.configuration.personaText =
        "Changed without its original configuration digest.";
    return await expect(prepareResearchChatInputs(input)).rejects.toThrow();
  });
  it("detaches inputs before asynchronous hashing and keeps review revision distinct from semver", async () => {
    const input: any = structuredClone(await fixture());
    const expected = await prepareResearchChatInputs(input);
    const pending = prepareResearchChatInputs(input);
    input.selection.research.tokenBudget = 1;
    input.evidence[0].accepted_review_revision = 0n;
    input.modelPolicyBytes.fill(0);
    input.tokenizePolicyBytes.fill(0);
    input.modelDescriptorBytes.fill(0);
    expect(await pending).toEqual(expected);
    return expect(input.configuration.reviewPins[0].reviewVersion).toBe(
      "1.0.0"
    );
  });
  it("rejects oversized graphs and ignored agent context rather than truncate", async () => {
    expect(() =>
      canonicalResearchChatInputJson({ body: "x".repeat(1_048_576) })
    ).toThrow();
    const input: any = structuredClone(await fixture());
    input.humanContext.messages[0].author = {
      kind: "agent",
      actor_id: "owner",
    };
    return await expect(prepareResearchChatInputs(input)).rejects.toThrow();
  });
});
