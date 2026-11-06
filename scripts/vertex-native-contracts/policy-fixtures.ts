import { computeRuntimePolicySelectionHash } from "../../packages/api/src/contracts/vertex-policy.ts";
import type { RuntimePolicySelection } from "../../packages/api/src/contracts/vertex-policy.ts";
import type { ContractFixture } from "./contract-fixture.ts";
import { canonicalJsonSha256 } from "./generate.ts";

// All references are synthetic opaque identifiers, never secret values or live
// permission. Configuration declarations cannot authorize native risk rearm.
export const buildPolicyFixtures = async (): Promise<ContractFixture[]> => {
  const hash = "a".repeat(64);
  const zero = "0".repeat(64);
  const t = "2026-09-22T12:00:00.000000001Z";
  const expires = "2026-09-22T12:01:00Z";
  const later = "2026-09-22T12:02:00Z";
  const scope = { accountAlias: "synthetic-paper", environment: "paper" };
  const artifact = {
    artifactId: "artifact-1",
    artifactSha256: hash,
    contractName: "SyntheticPolicy",
    schemaVersion: "1.0.0",
  };
  const module = {
    moduleId: "module-1",
    version: "1.0.0",
    codeSha256: hash,
    contractSha256: hash,
    artifact,
    enabled: true,
    capabilities: ["research", "paper-simulation"],
    requiredComponents: ["component-1"],
  };
  const roles = [
    "risk",
    "licensing-rights",
    "review",
    "capital",
    "cost",
    "calendar",
    "retention",
    "provider-budget",
    "tool",
  ];
  const policies = roles.map((role) => ({
    role,
    policyId: `policy-${role}`,
    version: "1.0.0",
    artifact,
  }));
  const groups = [
    "broker-execution",
    "quantvps-transport",
    "options-analytics",
    "fundamentals-news",
    "historical-quant-data",
    "models-agent-tools",
    "storage-queue-audit",
  ];
  const reference = {
    referenceId: "reference-1",
    referenceSha256: hash,
    logicalName: "synthetic-model-endpoint",
    kind: "nonsecret-reference",
    ownerService: "research-service",
    ...scope,
    permissions: ["read"],
    entitlementPolicyId: "policy-licensing-rights",
    rotationOwner: "rotation-owner",
    requiredWhen: ["research"],
    legacyAliases: ["SYNTHETIC_ENDPOINT"],
    verificationState: "verified",
    lastVerifiedAt: t,
    expiresAt: later,
    exposure: "server-only",
  };
  const capability = {
    capabilityId: "capability-1",
    providerId: "synthetic-provider",
    endpointReferenceId: reference.referenceId,
    endpointSha256: hash,
    modelVersion: "model-1",
    operation: "research",
    state: "ready",
    rightsPolicyId: "policy-licensing-rights",
    rightsPolicyVersion: "1.0.0",
    observedAt: t,
    expiresAt: later,
    evidenceArtifact: artifact,
  };
  const selection = {
    schemaVersion: "1.0.0",
    selectionId: "selection-1",
    selectionSha256: zero,
    ...scope,
    revision: "1",
    issuedAt: t,
    expiresAt: expires,
    sourcePins: [
      {
        sourceId: "source-1",
        revision: "source-v1",
        sourceSha256: hash,
        provenanceArtifact: artifact,
      },
    ],
    modules: [module],
    policies,
    configuration: groups.map((group) => ({
      group,
      state: "ready",
      referenceIds: [reference.referenceId],
      reasonCodes: [],
      provenanceSourceIds: ["source-1"],
    })),
    references: [reference],
    providerCapabilities: [capability],
    artifacts: [
      { bindingId: "binding-1", role: "model", artifact },
      { bindingId: "binding-2", role: "endpoint", artifact },
    ],
    review: {
      policyId: "policy-review",
      version: "1.0.0",
      reviewVersion: "1.0.0",
      ttlMilliseconds: 1000,
      requiredComponents: ["component-1"],
    },
    research: {
      moduleId: module.moduleId,
      taskContract: "research-task",
      modelVersion: "model-1",
      modelCapabilityId: capability.capabilityId,
      tokenBudget: 100,
      costBudgetUsd: "1",
      rightsPolicyId: "policy-licensing-rights",
      allowedTools: ["read-evidence"],
      requiredComponents: ["component-1"],
    },
    simulation: {
      moduleId: module.moduleId,
      simulatorId: "simulator-1",
      maximumLoss: "1",
      maximumNotional: "10",
      ttlMilliseconds: 1000,
      requiredComponents: ["component-1"],
      capitalAuthority: "native-owner-only",
    },
    readOnly: true,
    nativeRearmAllowed: false,
    cloudCapitalAuthority: false,
  };
  selection.selectionSha256 = await computeRuntimePolicySelectionHash(
    selection as RuntimePolicySelection
  );
  const lookup = {
    ...scope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
  };
  const good: Record<string, Record<string, unknown>> = {
    RuntimePolicySelection: selection,
    PolicySelectionLookup: lookup,
    RuntimePolicyHead: {
      ...lookup,
      revision: "1",
      state: "active-read-only",
      updatedAt: t,
    },
    RuntimeOwnershipPin: {
      ...lookup,
      holderId: "job-1",
      holderKind: "job",
      ownerServiceId: "native-owner",
      ownerEpoch: "1",
      module,
      pinnedAt: t,
      releasedAt: null,
    },
    RuntimeComponentEvidence: {
      evidenceId: "evidence-1",
      componentId: "component-1",
      ...lookup,
      state: "ready",
      codeSha256: hash,
      contractSha256: hash,
      observedAt: t,
      expiresAt: expires,
      reasonCodes: [],
    },
  };
  const cases: ContractFixture[] = [];
  const add = async (
    contract: string,
    name: string,
    input: unknown,
    valid = false
  ): Promise<void> => {
    const payload = structuredClone(input);
    if (contract === "RuntimePolicySelection" && valid) {
      const record = payload as RuntimePolicySelection;
      Object.assign(record, {
        selectionSha256: await computeRuntimePolicySelectionHash(record),
      });
    }
    cases.push({ name: `${contract}/${name}`, contract, payload, valid });
  };
  const change = async (
    contract: string,
    path: string,
    value: unknown,
    name = path,
    valid = false
  ): Promise<void> => {
    const payload = structuredClone(good[contract])!;
    const parts = path.split(".");
    let current = payload;
    for (const field of parts.slice(0, -1))
      current = current[field] as Record<string, unknown>;
    current[parts.at(-1)!] = value;
    await add(contract, name, payload, valid);
  };
  for (const [contract, payload] of Object.entries(good)) {
    await add(contract, "valid", payload, true);
    await add(contract, "wrong-root", null);
    await add(contract, "unknown-field", { ...payload, unsupported: true });
    const missing = { ...payload };
    delete missing[Object.keys(missing)[0]!];
    await add(contract, "missing-field", missing);
  }
  await change(
    "RuntimePolicySelection",
    "selectionSha256",
    zero,
    "content-hash-required"
  );
  await change("RuntimePolicySelection", "revision", "0");
  await change("RuntimePolicySelection", "expiresAt", t);
  await change("RuntimePolicySelection", "issuedAt", "2026-02-30T00:00:00Z");
  await change("RuntimePolicySelection", "sourcePins", [
    selection.sourcePins[0],
    selection.sourcePins[0],
  ]);
  await change("RuntimePolicySelection", "modules", [module, module]);
  await change("RuntimePolicySelection", "policies", [
    ...policies,
    policies[0],
  ]);
  await change("RuntimePolicySelection", "configuration.1.group", groups[0]);
  await change("RuntimePolicySelection", "references", [reference, reference]);
  await change("RuntimePolicySelection", "providerCapabilities", [
    capability,
    capability,
  ]);
  await change("RuntimePolicySelection", "artifacts.1.bindingId", "binding-1");
  await change("RuntimePolicySelection", "configuration.0.referenceIds", [
    "missing-reference",
  ]);
  await change(
    "RuntimePolicySelection",
    "configuration.0.provenanceSourceIds",
    ["missing-source"]
  );
  await change("RuntimePolicySelection", "configuration.0.reasonCodes", [
    "reason-1",
    "reason-1",
  ]);
  await change(
    "RuntimePolicySelection",
    "references.0.accountAlias",
    "other-paper"
  );
  await change(
    "RuntimePolicySelection",
    "references.0.environment",
    "research"
  );
  await change(
    "RuntimePolicySelection",
    "references.0.expiresAt",
    "2026-09-22T12:00:59.999999999Z"
  );
  await change("RuntimePolicySelection", "references.0.permissions", [
    "read",
    "read",
  ]);
  await change("RuntimePolicySelection", "references.0.requiredWhen", [
    "research",
    "research",
  ]);
  await change("RuntimePolicySelection", "references.0.lastVerifiedAt", null);
  await change(
    "RuntimePolicySelection",
    "references.0.lastVerifiedAt",
    "2026-02-30T00:00:00Z",
    "invalid-reference-calendar"
  );
  await change("RuntimePolicySelection", "references.0.legacyAliases", [
    "not-canonical",
  ]);
  await change(
    "RuntimePolicySelection",
    "providerCapabilities.0.endpointReferenceId",
    "missing-reference"
  );
  // Rehash the structurally valid invalid body directly: the source hash helper
  // parses refinements first, and a stale hash would not isolate this join.
  const endpointMismatch = structuredClone(selection);
  endpointMismatch.providerCapabilities[0]!.endpointSha256 = zero;
  const endpointMismatchBody = { ...endpointMismatch } as Partial<
    typeof endpointMismatch
  >;
  delete endpointMismatchBody.selectionSha256;
  endpointMismatch.selectionSha256 =
    await canonicalJsonSha256(endpointMismatchBody);
  await add(
    "RuntimePolicySelection",
    "endpoint-reference-digest-mismatch-rehashed",
    endpointMismatch
  );
  await change(
    "RuntimePolicySelection",
    "providerCapabilities",
    [capability, { ...capability, capabilityId: "capability-2" }],
    "shared-reference-digest-valid",
    true
  );
  await change(
    "RuntimePolicySelection",
    "providerCapabilities.0.rightsPolicyId",
    "wrong-policy"
  );
  await change(
    "RuntimePolicySelection",
    "providerCapabilities.0.rightsPolicyVersion",
    "2.0.0"
  );
  await change("RuntimePolicySelection", "providerCapabilities.0.expiresAt", t);
  await change("RuntimePolicySelection", "review.policyId", "wrong-policy");
  await change("RuntimePolicySelection", "review.version", "2.0.0");
  await change("RuntimePolicySelection", "research.moduleId", "missing-module");
  await change(
    "RuntimePolicySelection",
    "research.modelCapabilityId",
    "missing-capability"
  );
  await change(
    "RuntimePolicySelection",
    "research.modelVersion",
    "other-model"
  );
  await change(
    "RuntimePolicySelection",
    "research.rightsPolicyId",
    "wrong-rights"
  );
  await change("RuntimePolicySelection", "research.costBudgetUsd", "-1");
  await change("RuntimePolicySelection", "research.requiredComponents", [
    "component-1",
    "component-1",
  ]);
  await change(
    "RuntimePolicySelection",
    "simulation.moduleId",
    "missing-module"
  );
  await change("RuntimePolicySelection", "simulation.maximumLoss", "0");
  await change("RuntimePolicySelection", "simulation.maximumNotional", "0");
  await change("RuntimePolicySelection", "simulation.requiredComponents", [
    "component-1",
    "component-1",
  ]);
  for (const role of [
    "licensing-rights",
    "review",
    "tool",
    "provider-budget",
    "risk",
    "capital",
    "cost",
    "calendar",
  ]) {
    await change(
      "RuntimePolicySelection",
      "policies",
      policies.filter((pin) => pin.role !== role),
      `missing-role-${role}`
    );
  }
  await change("RuntimePolicySelection", "modules.0.capabilities", [
    "research",
    "research",
  ]);
  await change("RuntimePolicySelection", "modules.0.requiredComponents", [
    "component-1",
    "component-1",
  ]);
  await change("RuntimePolicySelection", "nativeRearmAllowed", true);
  await change("RuntimePolicySelection", "cloudCapitalAuthority", true);
  // No new inferred gates: source declarations may explicitly be unknown or
  // disabled; runtime readiness/authenticated origin is a separate authority.
  await change(
    "RuntimePolicySelection",
    "modules.0.enabled",
    false,
    "disabled-module-is-a-declaration",
    true
  );
  await change(
    "RuntimePolicySelection",
    "providerCapabilities.0.state",
    "unknown",
    "unknown-capability-is-a-declaration",
    true
  );
  const researchOnly = structuredClone(selection) as unknown as Record<
    string,
    unknown
  >;
  researchOnly["environment"] = "research";
  researchOnly["references"] = [{ ...reference, environment: "research" }];
  researchOnly["simulation"] = null;
  await add("RuntimePolicySelection", "research-only", researchOnly, true);
  await add("RuntimePolicySelection", "research-cannot-simulate", {
    ...researchOnly,
    simulation: selection.simulation,
  });
  await add(
    "RuntimePolicySelection",
    "null-optional-configurations",
    { ...selection, review: null, research: null, simulation: null },
    true
  );
  await change("RuntimePolicyHead", "selectionId", null);
  await add(
    "RuntimePolicyHead",
    "disabled-unselected",
    {
      ...scope,
      revision: "0",
      state: "disabled",
      selectionId: null,
      selectionSha256: null,
      updatedAt: t,
    },
    true
  );
  await change("RuntimePolicyHead", "updatedAt", "2026-02-30T00:00:00Z");
  await change("RuntimeOwnershipPin", "ownerEpoch", "0");
  await change("RuntimeOwnershipPin", "releasedAt", "2026-09-22T12:00:00Z");
  await change(
    "RuntimeOwnershipPin",
    "releasedAt",
    t,
    "equal-release-time",
    true
  );
  await change("RuntimeOwnershipPin", "module.requiredComponents", [
    "component-1",
    "component-1",
  ]);
  await change("RuntimeComponentEvidence", "expiresAt", t);
  await change("RuntimeComponentEvidence", "reasonCodes", [
    "reason-1",
    "reason-1",
  ]);
  await change(
    "RuntimeComponentEvidence",
    "observedAt",
    "2026-02-30T00:00:00Z"
  );
  return cases;
};
