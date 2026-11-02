import {
  PolicyRegistryError,
  type PolicyBoundary,
  type PolicyScope,
  type PolicySelection,
  type PolicyPorts,
  type PolicyPrincipal,
  type ModulePin,
  type ComponentEvidence,
  type CapabilityState,
  type ReferenceMetadata,
} from "./ports.ts";

export const policyFail = (code: PolicyRegistryError["code"]): never => {
  throw new PolicyRegistryError(code);
};
export const policyIdentifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    return policyFail("invalid");
  return value;
};
export const policyRevision = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(value))
    return policyFail("invalid");
  return BigInt(value);
};
export const policyScope = (value: PolicyScope): PolicyScope => {
  if (!(value && ["research", "paper"].includes(value.environment)))
    return policyFail("invalid");
  return Object.freeze({
    accountAlias: policyIdentifier(value.accountAlias),
    environment: value.environment,
  });
};
export const samePolicyScope = (
  left: PolicyScope,
  right: PolicyScope
): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
export const policyCapture = <T>(boundary: PolicyBoundary, value: T): T => {
  try {
    const bytes = boundary.encode(value);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1_048_576)
      return policyFail("invalid");
    return structuredClone(value);
  } catch {
    return policyFail("invalid");
  }
};
export const policyHash = async (
  boundary: PolicyBoundary,
  value: unknown
): Promise<string> => {
  const bytes = boundary.encode(value);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1_048_576)
    return policyFail("invalid");
  const digest = await boundary.digest(new Uint8Array(bytes));
  if (!/^[0-9a-f]{64}$/.test(digest)) return policyFail("integrity");
  return digest;
};
export const policyNow = (
  ports: Pick<PolicyPorts, "clock" | "boundary">
): string => {
  try {
    const now = ports.clock.now();
    ports.boundary.epochNanoseconds(now);
    return now;
  } catch {
    return policyFail("unavailable");
  }
};
export const currentSelection = (
  boundary: PolicyBoundary,
  value: PolicySelection,
  now: string
): boolean =>
  boundary.epochNanoseconds(value.issuedAt) <= boundary.epochNanoseconds(now) &&
  boundary.epochNanoseconds(now) < boundary.epochNanoseconds(value.expiresAt);
export const requirePolicyRead = async (
  ports: Pick<PolicyPorts, "authorization">,
  principal: PolicyPrincipal,
  scope: PolicyScope,
  resourceId: string,
  now: string
): Promise<void> => {
  policyIdentifier(principal.actorId);
  let allowed = false;
  try {
    allowed =
      (await ports.authorization.authorize({
        principal,
        scope,
        collectionId: null,
        resourceId,
        action: "read",
        now,
      })) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) policyFail("denied");
};
export const currentPolicyAuthority = async (
  ports: Pick<PolicyPorts, "readiness">,
  selection: PolicySelection,
  now: string,
  signal?: AbortSignal
): Promise<boolean> => {
  if (signal?.aborted) return false;
  try {
    return (
      (await ports.readiness.currentAuthority(selection, now, signal)) ===
        true && !signal?.aborted
    );
  } catch {
    return false;
  }
};

export type CapabilityAssessment = Readonly<{
  state: CapabilityState;
  reasonCodes: readonly string[];
  evidence: readonly ComponentEvidence[];
}>;
export const assessPolicyComponents = async (
  ports: Pick<PolicyPorts, "boundary" | "clock" | "readiness">,
  selection: PolicySelection,
  components: readonly string[],
  module?: ModulePin,
  signal?: AbortSignal
): Promise<CapabilityAssessment> => {
  const result = (
    state: CapabilityState,
    reason: string,
    observed: readonly ComponentEvidence[] = []
  ): CapabilityAssessment =>
    Object.freeze({
      state,
      reasonCodes: Object.freeze([reason]),
      evidence: Object.freeze([...observed]),
    });
  if (module && !module.enabled) return result("disabled", "module-disabled");
  if (components.length === 0)
    return result("unknown", "components-not-configured");
  const now = policyNow(ports);
  if (!currentSelection(ports.boundary, selection, now))
    return result("unavailable", "selection-expired");
  if (!(await currentPolicyAuthority(ports, selection, now, signal)))
    return result("unavailable", "current-authority-unavailable");
  let raw: readonly unknown[];
  try {
    raw = await ports.readiness.observe(
      selection,
      [...new Set(components)],
      signal
    );
  } catch {
    return result("unavailable", "component-observation-unavailable");
  }
  if (signal?.aborted || !Array.isArray(raw) || raw.length > 256)
    return result("unavailable", "component-observation-unavailable");
  const evidence: ComponentEvidence[] = [];
  for (const entry of raw) {
    try {
      evidence.push(
        await ports.boundary.validate(
          "RuntimeComponentEvidence",
          policyCapture(ports.boundary, entry)
        )
      );
    } catch {
      return result("incompatible", "invalid-component-evidence");
    }
  }
  if (
    new Set(evidence.map((entry) => entry.componentId)).size !== evidence.length
  )
    return result("incompatible", "ambiguous-component-evidence");
  const at = ports.boundary.epochNanoseconds(policyNow(ports));
  for (const component of components) {
    const entry = evidence.find(
      (candidate) => candidate.componentId === component
    );
    if (!entry) return result("unknown", "component-not-observed", evidence);
    if (
      !samePolicyScope(entry, selection) ||
      entry.selectionId !== selection.selectionId ||
      entry.selectionSha256 !== selection.selectionSha256
    )
      return result("incompatible", "component-selection-mismatch", evidence);
    const owners = module?.requiredComponents.includes(component)
      ? [module]
      : selection.modules.filter((pin) =>
          pin.requiredComponents.includes(component)
        );
    if (
      !owners.some(
        (pin) =>
          pin.enabled &&
          pin.codeSha256 === entry.codeSha256 &&
          pin.contractSha256 === entry.contractSha256
      )
    )
      return result(
        "incompatible",
        "component-code-contract-mismatch",
        evidence
      );
    if (
      ports.boundary.epochNanoseconds(entry.observedAt) > at ||
      ports.boundary.epochNanoseconds(entry.expiresAt) <= at
    )
      return result("unavailable", "component-evidence-stale", evidence);
    if (entry.state !== "ready")
      return result(
        entry.state,
        entry.reasonCodes[0] ?? "component-not-ready",
        evidence
      );
  }
  const completedAt = policyNow(ports);
  if (
    !(
      currentSelection(ports.boundary, selection, completedAt) &&
      (await currentPolicyAuthority(ports, selection, completedAt, signal))
    )
  )
    return result(
      "unavailable",
      "authority-changed-during-observation",
      evidence
    );
  const completedNs = ports.boundary.epochNanoseconds(policyNow(ports));
  if (
    evidence.some(
      (entry) =>
        components.includes(entry.componentId) &&
        ports.boundary.epochNanoseconds(entry.expiresAt) <= completedNs
    )
  )
    return result("unavailable", "component-evidence-stale", evidence);
  return result("ready", "exact-components-current", evidence);
};

// This is metadata lookup, NOT secret resolution. The caller must still use a
// service-authenticated resolver enforcing current scope, permissions and expiry.
export const leastPrivilegeReferences = (
  ports: Pick<PolicyPorts, "clock" | "boundary">,
  selection: PolicySelection,
  serviceId: string,
  permissions: readonly string[]
): readonly ReferenceMetadata[] => {
  policyIdentifier(serviceId);
  const at = ports.boundary.epochNanoseconds(policyNow(ports));
  return Object.freeze(
    selection.references.filter(
      (reference) =>
        reference.ownerService === serviceId &&
        samePolicyScope(reference, selection) &&
        reference.exposure === "server-only" &&
        permissions.every((permission) =>
          reference.permissions.includes(permission)
        ) &&
        ports.boundary.epochNanoseconds(reference.expiresAt) > at
    )
  );
};
