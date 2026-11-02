// TEST SUPPORT ONLY. No runtime package export imports this file. Tests consume
// the actual authority; this is not a permissive production boundary fallback.
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "../../../shared/src/vertex/index.ts";
import {
  RuntimePolicySelectionSchema,
  VERTEX_POLICY_CONTRACT_SCHEMAS,
  computeRuntimePolicySelectionHash,
  parseRuntimePolicySelection,
} from "./vertex-policy.ts";
import {
  PolicyRegistryError,
  type PolicyBoundary,
  type PolicyBoundaryRecords,
  type PolicyPorts,
  type PolicyStore,
  type PolicyTransaction,
  type PolicySelection,
  type PolicyHead,
  type PolicyHistory,
  type PolicyRevocation,
  type OwnershipPin,
  type ComponentEvidence,
} from "../../../config/src/vertex/ports.ts";
import { createRuntimePolicyRegistry } from "../../../config/src/vertex/registry.ts";

export const fixtureAt = "2026-09-22T12:00:00.000000001Z";
export const fixtureExpires = "2026-09-22T13:00:00.000000001Z";
export const fixtureScope = {
  accountAlias: "synthetic-policy-paper",
  environment: "paper",
} as const;
export const fixturePrincipal = {
  actorId: "synthetic-policy-operator",
} as const;
export const fixtureLookup = (selection: PolicySelection) => ({
  accountAlias: selection.accountAlias,
  environment: selection.environment,
  selectionId: selection.selectionId,
  selectionSha256: selection.selectionSha256,
});
export const fixtureDigest = "a".repeat(64);
export const fixtureBoundary: PolicyBoundary = {
  validate: async <K extends keyof PolicyBoundaryRecords>(
    name: K,
    value: unknown
  ): Promise<PolicyBoundaryRecords[K]> => {
    canonicalArtifactJson(value);
    const parsed =
      name === "RuntimePolicySelection"
        ? await parseRuntimePolicySelection(value)
        : VERTEX_POLICY_CONTRACT_SCHEMAS[name].parse(value);
    return parsed as PolicyBoundaryRecords[K];
  },
  encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
  digest: (bytes) => hashArtifact(bytes),
  epochNanoseconds: timestampToEpochNanoseconds,
};
const fixtureArtifact = (id: string) => ({
  artifactId: id,
  artifactSha256: fixtureDigest,
  contractName: "SyntheticPolicyFixture",
  schemaVersion: "1.0.0",
});
export const fixtureSelection = async (
  revision = "1",
  selectionId = `selection-${revision}`
): Promise<PolicySelection> => {
  const raw = RuntimePolicySelectionSchema.parse({
    schemaVersion: "1.0.0",
    ...fixtureScope,
    selectionId,
    selectionSha256: fixtureDigest,
    revision,
    issuedAt: fixtureAt,
    expiresAt: fixtureExpires,
    sourcePins: [
      {
        sourceId: "synthetic-source",
        revision: "fixture-1",
        sourceSha256: fixtureDigest,
        provenanceArtifact: fixtureArtifact("source-artifact"),
      },
    ],
    modules: [
      {
        moduleId: "synthetic-module",
        version: "1.0.0",
        codeSha256: fixtureDigest,
        contractSha256: fixtureDigest,
        artifact: fixtureArtifact("module-artifact"),
        enabled: true,
        capabilities: ["research", "backtest"],
        requiredComponents: ["synthetic-host"],
      },
    ],
    policies: [
      "risk",
      "licensing-rights",
      "review",
      "capital",
      "cost",
      "calendar",
      "provider-budget",
      "tool",
    ].map((role) => ({
      role,
      policyId: `policy-${role}`,
      version: role === "licensing-rights" ? "2.0.0" : "1.0.0",
      artifact: fixtureArtifact(`artifact-${role}`),
    })),
    configuration: [
      "broker-execution",
      "quantvps-transport",
      "options-analytics",
      "fundamentals-news",
      "historical-quant-data",
      "models-agent-tools",
      "storage-queue-audit",
    ].map((group) => ({
      group,
      state: "unknown",
      referenceIds: [],
      reasonCodes: ["synthetic-test-only"],
      provenanceSourceIds: ["synthetic-source"],
    })),
    references: [
      {
        ...fixtureScope,
        referenceId: "synthetic-endpoint",
        referenceSha256: fixtureDigest,
        logicalName: "models.fixture.endpoint",
        kind: "nonsecret-reference",
        ownerService: "synthetic-host",
        permissions: ["research"],
        entitlementPolicyId: "policy-licensing-rights",
        rotationOwner: "synthetic-operator",
        requiredWhen: ["research"],
        legacyAliases: [],
        verificationState: "unknown",
        lastVerifiedAt: null,
        expiresAt: fixtureExpires,
        exposure: "server-only",
      },
    ],
    providerCapabilities: [
      {
        capabilityId: "synthetic-model",
        providerId: "synthetic-provider",
        endpointReferenceId: "synthetic-endpoint",
        endpointSha256: fixtureDigest,
        modelVersion: "synthetic-model-v1",
        operation: "research",
        state: "ready",
        rightsPolicyId: "policy-licensing-rights",
        rightsPolicyVersion: "2.0.0",
        observedAt: fixtureAt,
        expiresAt: fixtureExpires,
        evidenceArtifact: fixtureArtifact("model-evidence"),
      },
    ],
    artifacts: [],
    review: {
      policyId: "policy-review",
      version: "1.0.0",
      reviewVersion: "1.0.0",
      ttlMilliseconds: 1000,
      requiredComponents: ["synthetic-host"],
    },
    research: {
      moduleId: "synthetic-module",
      taskContract: "synthetic-task",
      modelVersion: "synthetic-model-v1",
      modelCapabilityId: "synthetic-model",
      tokenBudget: 1,
      costBudgetUsd: "0",
      rightsPolicyId: "policy-licensing-rights",
      allowedTools: ["read-evidence"],
      requiredComponents: ["synthetic-host"],
    },
    simulation: {
      moduleId: "synthetic-module",
      simulatorId: "synthetic-simulator",
      maximumLoss: "1",
      maximumNotional: "1",
      ttlMilliseconds: 1000,
      requiredComponents: ["synthetic-host"],
      capitalAuthority: "native-owner-only",
    },
    readOnly: true,
    nativeRearmAllowed: false,
    cloudCapitalAuthority: false,
  });
  return parseRuntimePolicySelection({
    ...raw,
    selectionSha256: await computeRuntimePolicySelectionHash(raw),
  });
};

export const fixtureHarness = () => {
  const state = {
    head: null as PolicyHead | null,
    selections: new Map<string, PolicySelection>(),
    history: new Map<string, PolicyHistory>(),
    revocations: new Map<string, PolicyRevocation>(),
    pins: new Map<string, OwnershipPin>(),
    now: fixtureAt,
    privileged: true,
    scopeRead: true,
    currentAuthority: true,
    owns: true,
    observedState: "ready" as ComponentEvidence["state"],
    observedCode: fixtureDigest,
    observationCount: 0,
    privilegeCalls: 0,
  };
  let queue = Promise.resolve();
  const store: PolicyStore = {
    transaction: async (_scope, operation) => {
      const prior = queue;
      let unlock!: () => void;
      queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await prior;
      const backup = {
        head: state.head,
        selections: new Map(state.selections),
        history: new Map(state.history),
        revocations: new Map(state.revocations),
        pins: new Map(state.pins),
      };
      const tx: PolicyTransaction = {
        getHead: async () => state.head,
        // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
        putHead: async (head) => {
          state.head = head;
        },
        getSelection: async (id) => state.selections.get(id) ?? null,
        // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
        insertSelection: async (selection) => {
          const existing = state.selections.get(selection.selectionId);
          if (
            existing &&
            existing.selectionSha256 !== selection.selectionSha256
          )
            throw new PolicyRegistryError("conflict");
          if (
            !existing &&
            [...state.selections.values()].some(
              (other) => BigInt(other.revision) >= BigInt(selection.revision)
            )
          )
            throw new PolicyRegistryError("conflict");
          state.selections.set(selection.selectionId, selection);
          return existing ? "duplicate" : "recorded";
        },
        getHistory: async (id) => state.history.get(id) ?? null,
        // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
        appendHistory: async (receipt) => {
          state.history.set(receipt.commandId, receipt);
        },
        wasActivated: async (id, sha) =>
          [...state.history.values()].some(
            (entry) =>
              ["activate", "rollback"].includes(entry.operation) &&
              entry.selectionId === id &&
              entry.selectionSha256 === sha
          ),
        getRevocation: async (id) => state.revocations.get(id) ?? null,
        // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
        revokeSelection: async (value) => {
          state.revocations.set(value.selectionId, value);
        },
        getPin: async (id) => state.pins.get(id) ?? null,
        // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
        putPin: async (pin) => {
          state.pins.set(pin.holderId, pin);
        },
        listPins: async (id) =>
          [...state.pins.values()].filter((pin) => pin.selectionId === id),
      };
      try {
        return await operation(tx);
      } catch (error) {
        Object.assign(state, backup);
        throw error;
      } finally {
        unlock();
      }
    },
  };
  const ports: PolicyPorts = {
    store,
    boundary: fixtureBoundary,
    clock: { now: () => state.now },
    authorization: { authorize: async () => state.scopeRead },
    privilegedAuthorization: {
      // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
      authorize: async () => {
        state.privilegeCalls += 1;
        return state.privileged;
      },
    },
    ownership: { authorize: async () => state.owns },
    readiness: {
      currentAuthority: async () => state.currentAuthority,
      // biome-ignore lint/suspicious/useAwait: async keeps the in-memory fake aligned with the asynchronous store port contract.
      observe: async (selection, components) => {
        state.observationCount += 1;
        return components.map((componentId) => ({
          ...fixtureScope,
          evidenceId: "synthetic-observation",
          componentId,
          selectionId: selection.selectionId,
          selectionSha256: selection.selectionSha256,
          state: state.observedState,
          codeSha256: state.observedCode,
          contractSha256: fixtureDigest,
          observedAt: fixtureAt,
          expiresAt: fixtureExpires,
          reasonCodes: [],
        }));
      },
    },
  };
  const registry = createRuntimePolicyRegistry(ports);
  const command = (
    selection: PolicySelection,
    commandId: string,
    expectedRevision = state.head?.revision ?? "0"
  ) => ({
    ...fixtureScope,
    principal: fixturePrincipal,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    commandId,
    expectedRevision,
  });
  return { state, ports, registry, command };
};
