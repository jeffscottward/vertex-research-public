import type {
  PolicyHead,
  PolicySelection,
  PolicyTransaction,
  PolicyPorts,
  PolicyMutation,
  OwnershipPin,
  PolicyOperation,
} from "./ports.ts";
import {
  assessPolicyComponents,
  currentPolicyAuthority,
  currentSelection,
  policyFail,
  policyHash,
  policyIdentifier,
  policyNow,
  policyRevision,
  samePolicyScope,
} from "./policy.ts";

export const requireSelectionReady = async (
  ports: PolicyPorts,
  selection: PolicySelection
): Promise<void> => {
  const enabled = selection.modules.filter((module) => module.enabled);
  if (enabled.length === 0) policyFail("unavailable");
  for (const module of enabled) {
    const readiness = await assessPolicyComponents(
      ports,
      selection,
      module.requiredComponents,
      module
    );
    if (readiness.state !== "ready")
      policyFail(
        readiness.state === "incompatible" ? "incompatible" : "unavailable"
      );
  }
  const extra = [
    ...(selection.review?.requiredComponents ?? []),
    ...(selection.research?.requiredComponents ?? []),
    ...(selection.simulation?.requiredComponents ?? []),
  ];
  if (
    extra.length > 0 &&
    (await assessPolicyComponents(ports, selection, [...new Set(extra)]))
      .state !== "ready"
  )
    policyFail("unavailable");
  const { research, simulation } = selection;
  if (research) {
    const module = enabled.find((pin) => pin.moduleId === research.moduleId);
    const capability = selection.providerCapabilities.find(
      (fact) => fact.capabilityId === research.modelCapabilityId
    );
    const at = ports.boundary.epochNanoseconds(policyNow(ports));
    if (
      !(module && capability) ||
      capability.state !== "ready" ||
      capability.modelVersion !== research.modelVersion ||
      ports.boundary.epochNanoseconds(capability.observedAt) > at ||
      ports.boundary.epochNanoseconds(capability.expiresAt) <= at
    )
      policyFail("unavailable");
  }
  if (
    simulation &&
    !enabled.some((pin) => pin.moduleId === simulation.moduleId)
  )
    policyFail("unavailable");
  if (!(await currentPolicyAuthority(ports, selection, policyNow(ports))))
    policyFail("denied");
};

export const activationHead = async (
  ports: PolicyPorts,
  tx: PolicyTransaction,
  previous: PolicyHead,
  selection: PolicySelection,
  operation: "activate" | "rollback",
  now: string
): Promise<PolicyHead> => {
  if (
    !currentSelection(ports.boundary, selection, now) ||
    (await tx.getRevocation(selection.selectionId))
  )
    policyFail("stale");
  // Replacing an admission target is explicit drain -> activate/rollback. Drain
  // stops new work but leaves all old position/job pins and journal owners intact.
  if (
    previous.selectionId !== null &&
    previous.state !== "draining" &&
    previous.state !== "disabled"
  )
    policyFail("conflict");
  if (
    operation === "rollback" &&
    !(await tx.wasActivated(selection.selectionId, selection.selectionSha256))
  )
    policyFail("conflict");
  await requireSelectionReady(ports, selection);
  return {
    ...previous,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    state: "active-read-only",
    updatedAt: now,
  };
};

export const applyOwnershipMutation = async (
  ports: PolicyPorts,
  tx: PolicyTransaction,
  previous: PolicyHead,
  selection: PolicySelection,
  input: PolicyMutation & Readonly<Record<string, unknown>>,
  operation: Extract<PolicyOperation, "pin" | "release">,
  now: string
): Promise<void> => {
  const holderId = policyIdentifier(input["holderId"]);
  const existing = await tx.getPin(holderId);
  let pin: OwnershipPin;
  if (operation === "release") {
    if (
      !existing ||
      existing.selectionId !== selection.selectionId ||
      existing.selectionSha256 !== selection.selectionSha256
    )
      return policyFail("conflict");
    pin = { ...existing, releasedAt: existing.releasedAt ?? now };
  } else {
    if (
      previous.state !== "active-read-only" ||
      previous.selectionId !== selection.selectionId ||
      previous.selectionSha256 !== selection.selectionSha256 ||
      !currentSelection(ports.boundary, selection, now) ||
      (await tx.getRevocation(selection.selectionId))
    )
      return policyFail("stale");
    if (
      input["holderKind"] !== "job" &&
      input["holderKind"] !== "open-position"
    )
      return policyFail("invalid");
    if (policyRevision(input["ownerEpoch"]) === 0n)
      return policyFail("invalid");
    const module = selection.modules.find(
      (candidate) => candidate.moduleId === input["moduleId"]
    );
    if (!module?.enabled) return policyFail("unavailable");
    if (
      (
        await assessPolicyComponents(
          ports,
          selection,
          module.requiredComponents,
          module
        )
      ).state !== "ready"
    )
      return policyFail("unavailable");
    pin = await ports.boundary.validate("RuntimeOwnershipPin", {
      accountAlias: selection.accountAlias,
      environment: selection.environment,
      holderId,
      holderKind: input["holderKind"],
      ownerServiceId: policyIdentifier(input["ownerServiceId"]),
      ownerEpoch: input["ownerEpoch"],
      selectionId: selection.selectionId,
      selectionSha256: selection.selectionSha256,
      module,
      pinnedAt: existing?.pinnedAt ?? now,
      releasedAt: null,
    });
    if (
      existing &&
      (existing.releasedAt !== null ||
        (await policyHash(ports.boundary, existing)) !==
          (await policyHash(ports.boundary, pin)))
    )
      return policyFail("conflict");
  }
  if (!samePolicyScope(pin, selection)) return policyFail("integrity");
  let owned = false;
  try {
    owned =
      (await ports.ownership.authorize(
        input.principal,
        pin,
        operation,
        now
      )) === true;
  } catch {
    owned = false;
  }
  if (!owned) return policyFail("denied");
  await tx.putPin(await ports.boundary.validate("RuntimeOwnershipPin", pin));
};
