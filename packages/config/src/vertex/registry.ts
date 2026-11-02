import {
  PolicyRegistryError,
  type PolicyRegistry,
  type PolicyPorts,
  type PolicyHead,
  type PolicyScope,
  type PolicyPrincipal,
  type PolicyMutation,
  type PolicyMutationResult,
  type PolicyOperation,
  type PolicySelection,
  type SelectionLookup,
  type PolicyTransaction,
} from "./ports.ts";
import {
  currentPolicyAuthority,
  currentSelection,
  policyCapture,
  policyFail,
  policyHash,
  policyIdentifier,
  policyNow,
  policyRevision,
  policyScope,
  requirePolicyRead,
  samePolicyScope,
} from "./policy.ts";
import { activationHead, applyOwnershipMutation } from "./lifecycle.ts";

export const createRuntimePolicyRegistry = (
  ports: PolicyPorts
): PolicyRegistry => {
  const fn = (value: unknown): boolean => typeof value === "function";
  if (
    !(
      fn(ports?.store?.transaction) &&
      fn(ports.boundary?.validate) &&
      fn(ports.boundary?.encode) &&
      fn(ports.boundary?.digest) &&
      fn(ports.boundary?.epochNanoseconds) &&
      fn(ports.clock?.now) &&
      fn(ports.authorization?.authorize) &&
      fn(ports.privilegedAuthorization?.authorize) &&
      fn(ports.readiness?.observe) &&
      fn(ports.readiness?.currentAuthority) &&
      fn(ports.ownership?.authorize)
    )
  )
    policyFail("unavailable");
  const emptyHead = (scope: PolicyScope, now: string): PolicyHead => ({
    ...scope,
    revision: "0",
    selectionId: null,
    selectionSha256: null,
    state: "disabled",
    updatedAt: now,
  });
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PolicyRegistryError) throw error;
      return policyFail("unavailable");
    }
  };
  const authorize = async (
    principal: PolicyPrincipal,
    scope: PolicyScope,
    resourceId: string,
    now: string
  ): Promise<void> => {
    await requirePolicyRead(ports, principal, scope, "account-scope", now);
    await requirePolicyRead(ports, principal, scope, resourceId, now);
  };
  const selected = async (
    tx: PolicyTransaction,
    lookup: SelectionLookup
  ): Promise<PolicySelection> => {
    const stored = await tx.getSelection(lookup.selectionId);
    if (!stored) return policyFail("unavailable");
    const value = await ports.boundary.validate(
      "RuntimePolicySelection",
      stored
    );
    if (
      !samePolicyScope(value, lookup) ||
      value.selectionId !== lookup.selectionId ||
      value.selectionSha256 !== lookup.selectionSha256
    )
      return policyFail("integrity");
    return value;
  };
  const mutate = async (
    operation: PolicyOperation,
    raw: PolicyMutation & Readonly<Record<string, unknown>>
  ): Promise<PolicyMutationResult> =>
    safe(async () => {
      const input = policyCapture(ports.boundary, raw);
      const scope = policyScope(input);
      const lookup = await ports.boundary.validate("PolicySelectionLookup", {
        ...scope,
        selectionId: input.selectionId,
        selectionSha256: input.selectionSha256,
      });
      policyIdentifier(input.commandId);
      policyIdentifier(input.principal.actorId);
      policyRevision(input.expectedRevision);
      const requestSha256 = await policyHash(ports.boundary, {
        operation,
        ...input,
      });
      return ports.store.transaction(scope, async (tx) => {
        const now = policyNow(ports);
        const privilege = async (): Promise<void> => {
          const at = policyNow(ports);
          await authorize(input.principal, scope, input.selectionId, at);
          let allowed = false;
          try {
            allowed =
              (await ports.privilegedAuthorization.authorize({
                principal: input.principal,
                scope,
                operation,
                selectionId: lookup.selectionId,
                selectionSha256: lookup.selectionSha256,
                expectedRevision: input.expectedRevision,
                commandId: input.commandId,
                requestSha256,
                now: at,
              })) === true;
          } catch {
            allowed = false;
          }
          if (!allowed) policyFail("denied");
        };
        await privilege();
        const receipt = await tx.getHistory(input.commandId);
        if (receipt) {
          if (
            receipt.requestSha256 !== requestSha256 ||
            receipt.actorId !== input.principal.actorId ||
            receipt.operation !== operation
          )
            return policyFail("conflict");
          // Duplicate delivery returns the original committed result, never performs
          // a second activation or restores old authority after revocation.
          return Object.freeze({ status: "duplicate", head: receipt.head });
        }
        const previous = await ports.boundary.validate(
          "RuntimePolicyHead",
          (await tx.getHead()) ?? emptyHead(scope, now)
        );
        if (
          !samePolicyScope(previous, scope) ||
          previous.revision !== input.expectedRevision
        )
          return policyFail("conflict");
        let selection: PolicySelection;
        if (operation === "stage") {
          selection = await ports.boundary.validate(
            "RuntimePolicySelection",
            input["selection"]
          );
          if (
            !samePolicyScope(selection, lookup) ||
            selection.selectionId !== lookup.selectionId ||
            selection.selectionSha256 !== lookup.selectionSha256
          )
            return policyFail("integrity");
          if (!currentSelection(ports.boundary, selection, now))
            return policyFail("stale");
          await tx.insertSelection(selection);
        } else {
          selection = await selected(tx, lookup);
        }
        let next: PolicyHead = previous;
        if (operation === "activate" || operation === "rollback") {
          next = await activationHead(
            ports,
            tx,
            previous,
            selection,
            operation,
            now
          );
        } else if (operation === "drain") {
          if (
            previous.selectionId !== selection.selectionId ||
            previous.selectionSha256 !== selection.selectionSha256 ||
            previous.state !== "active-read-only"
          )
            return policyFail("conflict");
          next = { ...previous, state: "draining" };
        } else if (operation === "revoke") {
          if (await tx.getRevocation(selection.selectionId))
            return policyFail("conflict");
          await tx.revokeSelection({
            selectionId: selection.selectionId,
            selectionSha256: selection.selectionSha256,
            recordedAt: now,
            actorId: input.principal.actorId,
            commandId: input.commandId,
          });
          // Pins remain historical/native-owned. No cancellation, spending,
          // liquidation, rearming or ownership transfer is caused by this update.
          if (previous.selectionId === selection.selectionId)
            next = { ...previous, state: "disabled" };
        } else if (operation === "pin" || operation === "release") {
          await applyOwnershipMutation(
            ports,
            tx,
            previous,
            selection,
            input,
            operation,
            now
          );
        }
        const nextRevision = policyRevision(previous.revision) + 1n;
        if (nextRevision.toString().length > 30) return policyFail("conflict");
        // Recheck current authenticated privilege after readiness/ownership IO.
        // Both checks occur inside the same serialized store transaction.
        await privilege();
        if (
          ["activate", "rollback", "pin"].includes(operation) &&
          !(
            currentSelection(ports.boundary, selection, policyNow(ports)) &&
            (await currentPolicyAuthority(ports, selection, policyNow(ports)))
          )
        )
          return policyFail("stale");
        const head = await ports.boundary.validate("RuntimePolicyHead", {
          ...next,
          revision: nextRevision.toString(),
          updatedAt: policyNow(ports),
        });
        await tx.putHead(head);
        await tx.appendHistory({
          commandId: input.commandId,
          requestSha256,
          operation,
          actorId: input.principal.actorId,
          scope,
          selectionId: selection.selectionId,
          selectionSha256: selection.selectionSha256,
          previousHead: previous,
          head,
          recordedAt: head.updatedAt,
        });
        return Object.freeze({ status: "recorded", head });
      });
    });
  const readSelection = async (
    principal: PolicyPrincipal,
    raw: SelectionLookup
  ): Promise<PolicySelection> =>
    safe(async () => {
      const lookup = await ports.boundary.validate(
        "PolicySelectionLookup",
        policyCapture(ports.boundary, raw)
      );
      return ports.store.transaction(policyScope(lookup), async (tx) => {
        await authorize(
          principal,
          lookup,
          lookup.selectionId,
          policyNow(ports)
        );
        return selected(tx, lookup);
      });
    });
  const readHead = async (
    principal: PolicyPrincipal,
    raw: PolicyScope
  ): Promise<PolicyHead> =>
    safe(async () => {
      const scope = policyScope(policyCapture(ports.boundary, raw));
      return await ports.store.transaction(scope, async (tx) => {
        const now = policyNow(ports);
        await authorize(principal, scope, "runtime-policy", now);
        return ports.boundary.validate(
          "RuntimePolicyHead",
          (await tx.getHead()) ?? emptyHead(scope, now)
        );
      });
    });
  const materialize = async (
    principal: PolicyPrincipal,
    raw: SelectionLookup,
    consumerServiceId: string,
    holderId?: string
  ): Promise<PolicySelection> =>
    safe(async () => {
      const lookup = await ports.boundary.validate(
        "PolicySelectionLookup",
        policyCapture(ports.boundary, raw)
      );
      policyIdentifier(consumerServiceId);
      if (holderId !== undefined) policyIdentifier(holderId);
      return ports.store.transaction(policyScope(lookup), async (tx) => {
        const now = policyNow(ports);
        await authorize(principal, lookup, lookup.selectionId, now);
        const selection = await selected(tx, lookup);
        if (
          (await tx.getRevocation(selection.selectionId)) ||
          !currentSelection(ports.boundary, selection, now) ||
          !(await currentPolicyAuthority(ports, selection, now))
        )
          return policyFail("stale");
        const head = await tx.getHead();
        if (holderId === undefined) {
          if (
            head?.state !== "active-read-only" ||
            head.selectionId !== selection.selectionId ||
            head.selectionSha256 !== selection.selectionSha256
          )
            return policyFail("unavailable");
          // Server-authenticated read grant is also service-specific. Possession of
          // a selection ID or reference ID is never service identity.
          await requirePolicyRead(
            ports,
            principal,
            lookup,
            `policy-consumer:${consumerServiceId}`,
            now
          );
        } else {
          const pin = await tx.getPin(holderId);
          if (
            !pin ||
            pin.releasedAt !== null ||
            pin.selectionId !== selection.selectionId ||
            pin.selectionSha256 !== selection.selectionSha256 ||
            pin.ownerServiceId !== consumerServiceId
          )
            return policyFail("denied");
          let owner = false;
          try {
            owner =
              (await ports.ownership.authorize(principal, pin, "pin", now)) ===
              true;
          } catch {
            owner = false;
          }
          if (!owner) return policyFail("denied");
        }
        // Exact original immutable bytes/shape are retained. Metadata may include
        // other scoped references; a resolver MUST use leastPrivilegeReferences.
        return selection;
      });
    });
  const readLifecycle: PolicyRegistry["readLifecycle"] = async (
    principal,
    raw
  ) =>
    safe(async () => {
      const lookup = await ports.boundary.validate(
        "PolicySelectionLookup",
        policyCapture(ports.boundary, raw)
      );
      return ports.store.transaction(policyScope(lookup), async (tx) => {
        const now = policyNow(ports);
        await authorize(principal, lookup, lookup.selectionId, now);
        const selection = await selected(tx, lookup);
        const head = await ports.boundary.validate(
          "RuntimePolicyHead",
          (await tx.getHead()) ?? emptyHead(lookup, now)
        );
        const everActivated = await tx.wasActivated(
          selection.selectionId,
          selection.selectionSha256
        );
        const revoked =
          (await tx.getRevocation(selection.selectionId)) !== null;
        const activePins = (await tx.listPins(selection.selectionId)).filter(
          (pin) => pin.releasedAt === null
        );
        return Object.freeze({
          selection,
          head,
          everActivated,
          revoked,
          activePins: Object.freeze(activePins),
        });
      });
    });
  return Object.freeze({
    stage: (input) => mutate("stage", input),
    activate: (input) => mutate("activate", input),
    rollback: (input) => mutate("rollback", input),
    drain: (input) => mutate("drain", input),
    revoke: (input) => mutate("revoke", input),
    pin: (input) => mutate("pin", input),
    release: (input) => mutate("release", input),
    readHead,
    readSelection,
    readLifecycle,
    materialize,
  });
};
