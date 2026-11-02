import { hashArtifact } from "@darkfactory/shared/vertex";
import { VertexResearchChatNativeEvidenceConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import {
  RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL,
  RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER,
  researchChatNativeEvidenceToolSchema,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import type { lifecycleFixture } from "../../../db/src/server/vertex-research-chat-copy-lifecycle.test-support.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect } from "vitest";
import { handleApiRequest } from "./handler.ts";
import type { ApiContext } from "./context.ts";
import { VERTEX_CONTRACT_SCHEMAS } from "../contracts/vertex.ts";
import { VERTEX_CONTROL_CONTRACT_SCHEMAS } from "../contracts/vertex-control.ts";
import {
  VERTEX_WORKER_CONTRACT_SCHEMAS,
  WorkerOperationSchema,
} from "../contracts/vertex-worker.ts";
import {
  VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  ModelUseRequestSchema,
  computeModelUseRequestHash,
} from "../contracts/vertex-model-use.ts";
import { VERTEX_POLICY_CONTRACT_SCHEMAS } from "../contracts/vertex-policy.ts";
import {
  base64,
  revokeGrant,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import { mutableClone } from "./mutable-clone.test-support.ts";

// Only selected external historical documents are supplied here. Consent,
// storage qualification, copy writes, admission, grants and reviews remain owners.
export const nativeHistoricalInputs = async (
  f: Awaited<ReturnType<typeof lifecycleFixture>>
) => {
  const selected = mutableClone(f.selection);
  selected.research = {
    ...selected.research!,
    allowedTools: ["read-evidence"],
  };
  const manifestPin = selected.artifacts.find(
    (entry) => entry.artifact.artifactId === "serving-manifest"
  )!.artifact;
  const historical = [...f.objects.values()].find(
    (entry) => entry.id === manifestPin.artifactId
  )!;
  const originalManifest = JSON.parse(
    new TextDecoder().decode(historical.body)
  );
  const serving = await f.artifact(
    "native-serving-manifest",
    {
      ...originalManifest,
      profile: "vertex-exact-vllm-native-evidence-serving-v1",
      adapter_policy:
        "no-lora-no-prompt-adapters-native-single-tool-no-truncation",
      protocol: RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL,
      serializerProfile: RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER,
      allowedTools: ["read_reviewed_evidence"],
      toolSchema: researchChatNativeEvidenceToolSchema(),
    },
    "NativeEvidenceServingManifest"
  );
  const modelPolicy = await f.artifact(
    "native-model-policy",
    {
      ...f.modelPolicy.value,
      serving_manifest_sha256: serving.pin.artifactSha256,
    },
    "ModelPolicy"
  );
  const operationCeilings = ([1, 2] as const).flatMap((phaseOrdinal) => [
    {
      phaseOrdinal,
      operation: "model-tokenize",
      maximumInputTokens: 128,
      maximumOutputTokens: 0,
      maximumCostUsd: "0.01",
    },
    {
      phaseOrdinal,
      operation: "model-completion",
      maximumInputTokens: 128,
      maximumOutputTokens: 128,
      maximumCostUsd: "0.1",
    },
  ]);
  const { mode: _mode, ...common } = f.config.value as typeof f.config.value & {
    mode?: string;
  };
  const configuration =
    VertexResearchChatNativeEvidenceConfigurationV1Schema.parse({
      ...common,
      format: "vertex-research-chat-native-evidence-configuration-v1",
      modelPolicy: modelPolicy.pin,
      nativeEvidence: {
        profile: RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL,
        toolName: "read_reviewed_evidence",
        maximumCalls: 1,
        phaseCount: 2,
        derivationProfile: "reviewed-evidence-single-projection-v1",
        serializerProfile: RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER,
        nativeCapability: serving.pin,
        operationCeilings,
        aggregateTokens: 768,
        aggregateCostUsd: "0.22",
        maximumIntermediateBytes: 262_144,
      },
    });
  const config = await f.artifact(
    "native-first-mate-config",
    configuration,
    "ResearchChatNativeEvidenceConfiguration"
  );
  const retentionPin = selected.policies.find(
    (entry) => entry.role === "retention"
  )!.artifact;
  const oldRetention = JSON.parse(
    new TextDecoder().decode(
      [...f.objects.values()].find(
        (entry) => entry.id === retentionPin.artifactId
      )!.body
    )
  );
  const retention = await f.artifact(
    "native-retention",
    {
      ...oldRetention,
      format: "vertex-research-chat-native-evidence-retention-policy-v1",
      rules: [
        ...oldRetention.rules,
        {
          kind: "native-intermediate",
          cleanupTrigger: "response-attempt-terminal",
        },
      ],
      nativeIntermediatePurposes: [
        "evidenceBundle",
        "phaseOneResponse",
        "toolResult",
        "phaseTwoTokenizeInput",
        "phaseTwoCompletionInput",
      ],
    },
    "VertexResearchChatCopyRetentionPolicy"
  );
  selected.policies = selected.policies.map((entry) =>
    entry.role === "retention" ? { ...entry, artifact: retention.pin } : entry
  );
  selected.artifacts = selected.artifacts.filter(
    (entry) =>
      !["serving-manifest", f.modelPolicy.pin.artifactId].includes(
        entry.artifact.artifactId
      )
  );
  selected.artifacts.push(
    {
      bindingId: serving.pin.artifactId,
      role: "tool-config",
      artifact: serving.pin,
    },
    {
      bindingId: modelPolicy.pin.artifactId,
      role: "tool-config",
      artifact: modelPolicy.pin,
    }
  );
  return { config, modelPolicy, selection: selected, serving };
};

export const nativeProtocolFixture = async (options = {}) => {
  const { chatWorkerFixture } = await import(
    "./vertex-research-chat-worker-runtime.test-support.ts"
  );
  return chatWorkerFixture({
    nativeEvidence: true,
    rendezvous: true,
    rightsObservation: true,
    participantId: "first-mate",
    admissionPath: "conversation",
    frozenRightsAtExecution: true,
    ...options,
  });
};

export const nativeTables = {
  phases: "vertex_research_chat_native_phases",
  candidates: "vertex_research_chat_native_model_privacy_candidates",
  dispatches: "vertex_research_chat_native_model_dispatches",
  charges: "vertex_model_use_budget_reservations",
} as const;
type NativeFixture = Awaited<ReturnType<typeof nativeProtocolFixture>>;
export type NativeScenario =
  | "positive"
  | "budget-exhaustion"
  | "invalid-call"
  | "multiple-calls"
  | "undelivered-citation"
  | "further-call"
  | "forged-proof"
  | "forged-final-proof"
  | "missing-phase-one-audit"
  | "unknown-outcome"
  | "missing-authority"
  | "reused-authority"
  | "revocation"
  | "expiry"
  | "phase-drift"
  | "input-drift";
const schemas = {
  ...VERTEX_CONTRACT_SCHEMAS,
  ...VERTEX_CONTROL_CONTRACT_SCHEMAS,
  ...VERTEX_WORKER_CONTRACT_SCHEMAS,
  ...VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  ...VERTEX_POLICY_CONTRACT_SCHEMAS,
};
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from the Python native-evidence subprocess and oRPC test responses; shapes are asserted by schemas and expectations
type SubprocessJson = any;
const rpc = async (context: ApiContext, path: string, input: unknown) => {
  const response = await handleApiRequest(
    new Request(`https://test.invalid/api/orpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    context
  );
  if (!response.ok) {
    const allowedMethods = [
      ...WorkerOperationSchema.options.map(
        (method) => `vertexWorker/${method}`
      ),
      "vertex/researchChat/readNativeModelPrivacyReviewRequest",
      "vertex/researchChat/recordNativeModelPrivacyReview",
    ];
    const method = allowedMethods.includes(path) ? path : "unlisted";
    const allowedCodes = [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PRECONDITION_FAILED",
      "PAYLOAD_TOO_LARGE",
      "UNPROCESSABLE_CONTENT",
      "TOO_MANY_REQUESTS",
      "INTERNAL_SERVER_ERROR",
      "NOT_IMPLEMENTED",
      "BAD_GATEWAY",
      "SERVICE_UNAVAILABLE",
      "GATEWAY_TIMEOUT",
    ];
    let code = "unavailable";
    try {
      const text = await response.text();
      const body = text.length <= 8192 ? JSON.parse(text) : null;
      const candidate = body?.json?.code ?? body?.code;
      if (typeof candidate === "string" && allowedCodes.includes(candidate))
        code = candidate;
    } catch (e) {
      if (typeof e !== "object" || e === null) {
        throw e;
      }
    }
    throw Object.assign(
      new Error(
        `Native composed owner denied (${method}; HTTP ${response.status}; ${code})`
      ),
      { status: response.status }
    );
  }
  return ((await response.json()) as { json: SubprocessJson }).json;
};
const reviewerContext = (f: NativeFixture): ApiContext =>
  ({
    requireSession: async () => ({
      principal: {
        userId: f.privacyReviewer.actorId,
        role: "member",
        status: "active",
      },
    }),
    vertexModelPrivacyReviewer: f.privacy,
    vertexResearchChatConversation: f.runtime.conversation,
    vertexExperience: {
      store: f.store,
      authorization: f.authorization,
      clock: f.clock,
    },
  }) as unknown as ApiContext;
const nativeWorkerRpc = (f: NativeFixture, method: string, input: unknown) =>
  rpc(
    {
      vertexWorker: {
        store: f.worker,
        clock: f.clock,
        claim: async () => {
          throw new Error("No second worker claim");
        },
      },
      workerRequest: {
        headers: new Headers({ authorization: `Bearer ${f.workerToken}` }),
      },
    } as unknown as ApiContext,
    `vertexWorker/${method}`,
    input
  );

// Fresh Python process uses the real selected handler, SDK invocation and worker
// protocol. Parent services only real worker RPC and authenticated reviewer RPC.
export const consumeNativeEvidence = async (
  f: NativeFixture,
  scenario: NativeScenario = "positive"
) => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url)),
    artifacts: Record<string, string> = {};
  for (const binding of f.selection.artifacts) {
    const object = [...f.objects.values()].find(
      (entry) => entry.id === binding.artifact.artifactId
    );
    if (object) artifacts[binding.artifact.artifactId] = base64(object.body);
  }
  const rightsAdmin = f.grantAdmin;
  await f.grant(rightsAdmin.actorId, "endpoint-policy", ["manage-rights"]);
  await f.store.putRights(rightsAdmin, f.scope, null, {
    policyId: "endpoint-policy",
    version: "1.0.0",
    status: "granted",
    allowedUses: ["read"],
    checkedAt: f.clock.now(),
    expiresAt: f.lease.leaseExpiresAt,
    retentionUntil: null,
  });
  await f.grant(
    f.request.participantId === "first-mate"
      ? f.tokenizeRequest.researchPrincipalId
      : "",
    "endpoint-policy",
    ["read"]
  );
  const child = spawn(
    process.env["VERTEX_NATIVE_EVIDENCE_TEST_PYTHON"] ?? "python3",
    [
      resolve(
        root,
        "services/research/adapters/tests/native_evidence_stdio.py"
      ),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: ["research", "control-client", "market-data", "execution"]
          .map((name) => resolve(root, "services", name))
          .join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const allowedSignals = [
    "SIGTERM",
    "SIGKILL",
    "SIGINT",
    "SIGABRT",
    "SIGSEGV",
    "SIGBUS",
    "SIGHUP",
  ];
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolveExit({
          code,
          signal:
            signal === null
              ? null
              : allowedSignals.includes(signal)
                ? signal
                : "other",
        })
      );
    }
  );
  child.stderr.resume();
  let timeout = false,
    done: SubprocessJson = null,
    denied: { method: string; status: number | null } | null = null;
  let schemaCalls = 0,
    messages = 0;
  let lastCompletedRPC: string | null = null,
    inFlightRPC: string | null = null,
    lastKnownPhase: 1 | 2 | null = null;
  const timer = setTimeout(() => {
    timeout = true;
    return child.kill("SIGKILL");
  }, 120_000);
  const reviewed: SubprocessJson[] = [],
    requests: SubprocessJson[] = [],
    methods: string[] = [],
    prepared: SubprocessJson[] = [];
  const finalFaults: string[] = [];
  child.stdin.write(
    `${JSON.stringify({
      selection: f.selection,
      artifacts,
      recipe: f.recipe,
      lease: f.lease,
      at: f.state.at,
      scenario,
    })}\n`
  );
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (++messages > 1024)
        throw new Error("Native subprocess message cap exceeded");
      if (message.kind === "done") {
        done = message;
        break;
      }
      let value: unknown;
      try {
        if (message.kind === "validate") {
          if (++schemaCalls > 512)
            throw new Error("Native schema-validation cap exceeded");
          const schema = schemas[message.name as keyof typeof schemas];
          if (message.version !== "1.0.0" || schema === undefined)
            throw new Error("Native schema missing");
          schema.parse(message.value);
          value = true;
        } else {
          expect(message.kind).toBe("worker");
          methods.push(message.method);
          if (methods.length > 512)
            throw new Error("Native worker-RPC cap exceeded");
          if (
            scenario === "input-drift" &&
            prepared.length === 1 &&
            message.method === "prepareModelPrivacyReview"
          ) {
            const {
              requestId: _id,
              requestSha256: _hash,
              ...prior
            } = message.value;
            const body = { ...prior, inputSha256: "0".repeat(64) };
            const changed = ModelUseRequestSchema.parse({
              ...body,
              requestId: `model-use-${await hashArtifact(body)}`,
              requestSha256: "0".repeat(64),
            });
            message.value = {
              ...changed,
              requestSha256: await computeModelUseRequestHash(changed),
            };
          }
          if (
            scenario === "forged-proof" &&
            message.method === "prepareNativeEvidencePhaseTwo"
          ) {
            message.value = {
              ...message.value,
              proof: {
                ...message.value.proof,
                checkedAt: "2026-09-24T11:59:59.000000001Z",
              },
            };
          }
          if (
            message.method === "stageArtifact" &&
            message.value.chatCompletion !== undefined
          ) {
            if (scenario === "forged-final-proof") {
              expect(reviewed).toHaveLength(4);
              message.value = {
                ...message.value,
                chatCompletion: {
                  ...message.value.chatCompletion,
                  proof: {
                    ...message.value.chatCompletion.proof,
                    checkedAt: "2026-09-24T11:59:59.000000001Z",
                  },
                },
              };
              finalFaults.push(scenario);
            }
            if (scenario === "missing-phase-one-audit") {
              expect(reviewed).toHaveLength(4);
              const phase = f
                .table(nativeTables.phases)
                .find((row) => row["phase_ordinal"] === 2)!["payload"];
              const audits = f.table("vertex_model_use_proof_audits");
              const matching = audits.filter(
                (row) =>
                  row["request_sha256"] ===
                    phase.derivation.phaseOneRequestSha256 &&
                  row["record_hash"] === phase.derivation.phaseOneProofSha256
              );
              expect(matching).toHaveLength(1);
              // External SQL corruption/lost-row fault after both real provider
              // responses. No replacement proof or authority result is supplied.
              audits.splice(audits.indexOf(matching[0]!), 1);
              finalFaults.push(scenario);
            }
          }
          inFlightRPC = WorkerOperationSchema.options.some(
            (method) => method === message.method
          )
            ? `vertexWorker/${message.method}`
            : "unlisted";
          value = await nativeWorkerRpc(f, message.method, message.value);
          lastCompletedRPC = inFlightRPC;
          inFlightRPC = null;
          if (message.method === "prepareNativeEvidencePhaseTwo")
            prepared.push(value);
          if (message.method === "prepareModelPrivacyReview")
            requests.push(message.value);
          if (
            message.method === "readModelPrivacyReview" &&
            (value as { status: string }).status === "pending"
          ) {
            const phaseRows = f.table(nativeTables.phases).filter((row) => {
              const phase = row["payload"],
                operation = message.value.operation;
              return (
                phase[
                  operation === "model-tokenize"
                    ? "tokenizeInput"
                    : "completionInput"
                ].sha256 === message.value.inputSha256
              );
            });
            expect(phaseRows).toHaveLength(1);
            const phase = phaseRows[0]!["payload"],
              nativePhase = {
                phaseOrdinal: phase.phaseOrdinal,
                phaseSha256: phase.phaseSha256,
              };
            if (phase.phaseOrdinal === 2 && scenario === "revocation")
              await revokeGrant(
                f,
                "chat-privacy-policy",
                f.privacyReviewer.actorId
              );
            if (phase.phaseOrdinal === 2 && scenario === "expiry")
              f.state.at = "2026-09-25T12:00:00.000000001Z";
            if (phase.phaseOrdinal === 2 && scenario !== "missing-authority")
              await f.grant(
                f.privacyReviewer.actorId,
                `research-chat-model-privacy:${f.responseRequestId}:phase-2:${message.value.operation}`,
                ["review"]
              );
            const selector = {
              ...f.scope,
              responseRequestId: f.responseRequestId,
              operation: message.value.operation,
              nativePhase:
                scenario === "phase-drift" && phase.phaseOrdinal === 2
                  ? { ...nativePhase, phaseSha256: "0".repeat(64) }
                  : nativePhase,
            };
            inFlightRPC =
              "vertex/researchChat/readNativeModelPrivacyReviewRequest";
            const output = await rpc(
              reviewerContext(f),
              "vertex/researchChat/readNativeModelPrivacyReviewRequest",
              selector
            );
            lastCompletedRPC = inFlightRPC;
            inFlightRPC = null;
            const candidate = output.candidate;
            expect(candidate.request).toEqual(message.value);
            expect(candidate.nativePhase).toEqual(nativePhase);
            if (
              candidate.nativePhase.phaseOrdinal === 1 ||
              candidate.nativePhase.phaseOrdinal === 2
            )
              lastKnownPhase = candidate.nativePhase.phaseOrdinal;
            const review = {
              ...f.privacyInput(candidate.request),
              nativePhase,
              expiresAt: candidate.expiresAt,
              idempotencyKey: `native-review-${phase.phaseOrdinal}-${candidate.request.operation}`,
            };
            const submitted =
              phase.phaseOrdinal === 2 && scenario === "reused-authority"
                ? {
                    candidateId: candidate.candidateId,
                    review: reviewed[0].review,
                  }
                : { candidateId: candidate.candidateId, review };
            inFlightRPC = "vertex/researchChat/recordNativeModelPrivacyReview";
            await rpc(
              reviewerContext(f),
              "vertex/researchChat/recordNativeModelPrivacyReview",
              submitted
            );
            lastCompletedRPC = inFlightRPC;
            inFlightRPC = null;
            reviewed.push({ candidateId: candidate.candidateId, review });
          }
        }
        child.stdin.write(`${JSON.stringify({ ok: true, value })}\n`);
      } catch (error) {
        // Preserve owner denial, never turn it into an accepted review/proof.
        denied = {
          method:
            message.kind === "validate"
              ? `schema:${message.name}`
              : message.method,
          status:
            typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : null,
        };
        if (
          scenario === "positive" ||
          message.kind === "validate" ||
          denied.status === null ||
          ![400, 401, 403, 409, 422, 503].includes(denied.status)
        )
          throw error;
        child.stdin.write(`${JSON.stringify({ ok: false, effect: "none" })}\n`);
      }
    }
    child.stdin.end();
    const exit = await exited;
    const completionDiagnostic = JSON.stringify({
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: timeout,
      doneSeen: done !== null,
      lastCompletedRPC,
      inFlightRPC,
      lastKnownPhase,
      counters: {
        messages,
        schemaValidations: schemaCalls,
        workerRPCs: methods.length,
        acceptedReviews: reviewed.length,
        phaseTwoMaterializations: prepared.length,
      },
    });
    expect(exit.code, completionDiagnostic).toBe(0);
    expect(timeout, completionDiagnostic).toBe(false);
    expect(done, completionDiagnostic).not.toBeNull();
    return {
      ...done,
      reviewed,
      requests,
      methods,
      prepared,
      denied,
      finalFaults,
    };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
};
