import type {
  PolicyPorts,
  PolicyRegistry,
  PolicyPrincipal,
  PolicySelection,
  SelectionLookup,
  ResearchTool,
  ModulePin,
  CapabilityState,
} from "./ports.ts";
import {
  assessPolicyComponents,
  currentPolicyAuthority,
  currentSelection,
  policyNow,
} from "./policy.ts";

// Structurally compatible with VertexExperienceDependencies without creating an
// API -> config -> API dependency cycle. They carry no authority flag.
export type BindingScope = Readonly<{
  accountAlias: string;
  environment: "research" | "paper" | "live";
}>;
export type ReviewBinding = Readonly<{
  version: string;
  reviewVersion: string;
  ttlMilliseconds: number;
}>;
export type ResearchBinding = Readonly<{
  available: (scope: BindingScope, signal?: AbortSignal) => Promise<boolean>;
  taskContract: string;
  modelVersion: string;
  tokenBudget: number;
  costBudgetUsd: string;
  rightsPolicyId: string;
  allowedTools: readonly ResearchTool[];
}>;
export type SimulationBinding = Readonly<{
  available: (scope: BindingScope, signal?: AbortSignal) => Promise<boolean>;
  simulatorId: string;
  maximumLoss: string;
  maximumNotional: string;
  ttlMilliseconds: number;
}>;
export type BindingContext = Readonly<{
  ports: PolicyPorts;
  registry: PolicyRegistry;
  principal: PolicyPrincipal;
  lookup: SelectionLookup;
  consumerServiceId: string;
}>;
export type BindingResult<T> = Readonly<{
  state: CapabilityState;
  reasonCodes: readonly string[];
  binding?: T;
}>;
const unavailable = <T>(reason: string): BindingResult<T> =>
  Object.freeze({ state: "unavailable", reasonCodes: Object.freeze([reason]) });
const disabled = <T>(): BindingResult<T> =>
  Object.freeze({
    state: "disabled",
    reasonCodes: Object.freeze(["binding-not-configured"]),
  });
const resolve = async (
  context: BindingContext
): Promise<PolicySelection | null> => {
  try {
    return await context.registry.materialize(
      context.principal,
      context.lookup,
      context.consumerServiceId
    );
  } catch {
    return null;
  }
};
const ttl = (
  context: BindingContext,
  selection: PolicySelection,
  configured: number
): number => {
  const remaining =
    context.ports.boundary.epochNanoseconds(selection.expiresAt) -
    context.ports.boundary.epochNanoseconds(policyNow(context.ports));
  return Math.min(configured, Number(remaining / 1_000_000n));
};
const availability =
  (
    context: BindingContext,
    expected: PolicySelection,
    components: readonly string[],
    module: ModulePin
  ) =>
  async (scope: BindingScope, signal?: AbortSignal): Promise<boolean> => {
    if (
      signal?.aborted ||
      scope.accountAlias !== expected.accountAlias ||
      scope.environment !== expected.environment
    )
      return false;
    const selection = await resolve(context);
    if (
      !selection ||
      selection.selectionId !== expected.selectionId ||
      selection.selectionSha256 !== expected.selectionSha256
    )
      return false;
    return (
      (
        await assessPolicyComponents(
          context.ports,
          selection,
          components,
          module,
          signal
        )
      ).state === "ready"
    );
  };

// Build per request AFTER authenticated scope resolution. The existing review
// port has no async available callback, so it must never be cached installation-wide.
export const buildVertexReviewPolicy = async (
  context: BindingContext
): Promise<BindingResult<ReviewBinding>> => {
  const selection = await resolve(context);
  if (!selection) return unavailable("selection-unavailable");
  if (!selection.review) return disabled();
  const assessment = await assessPolicyComponents(
    context.ports,
    selection,
    selection.review.requiredComponents
  );
  if (assessment.state !== "ready")
    return Object.freeze({
      state: assessment.state,
      reasonCodes: assessment.reasonCodes,
    });
  const duration = ttl(context, selection, selection.review.ttlMilliseconds);
  if (duration < 1) return unavailable("selection-expired");
  return Object.freeze({
    state: "ready",
    reasonCodes: [],
    binding: Object.freeze({
      version: selection.review.version,
      reviewVersion: selection.review.reviewVersion,
      ttlMilliseconds: duration,
    }),
  });
};

export const buildVertexResearchBinding = async (
  context: BindingContext
): Promise<BindingResult<ResearchBinding>> => {
  const selection = await resolve(context);
  if (!selection) return unavailable("selection-unavailable");
  const configured = selection.research;
  if (!configured) return disabled();
  const module = selection.modules.find(
    (candidate) => candidate.moduleId === configured.moduleId
  );
  if (!module)
    return Object.freeze({
      state: "incompatible",
      reasonCodes: ["module-pin-missing"],
    });
  const components = [
    ...new Set([
      ...module.requiredComponents,
      ...configured.requiredComponents,
    ]),
  ];
  const assessment = await assessPolicyComponents(
    context.ports,
    selection,
    components,
    module
  );
  if (assessment.state !== "ready")
    return Object.freeze({
      state: assessment.state,
      reasonCodes: assessment.reasonCodes,
    });
  const selectedModelCurrent = (candidate: PolicySelection): boolean => {
    const fact = candidate.providerCapabilities.find(
      (entry) => entry.capabilityId === configured.modelCapabilityId
    );
    const at = context.ports.boundary.epochNanoseconds(
      policyNow(context.ports)
    );
    return (
      !!fact &&
      fact.state === "ready" &&
      fact.modelVersion === configured.modelVersion &&
      fact.rightsPolicyId === configured.rightsPolicyId &&
      context.ports.boundary.epochNanoseconds(fact.observedAt) <= at &&
      at < context.ports.boundary.epochNanoseconds(fact.expiresAt)
    );
  };
  if (!selectedModelCurrent(selection))
    return unavailable("selected-model-evidence-unavailable");
  const available = availability(context, selection, components, module);
  return Object.freeze({
    state: "ready",
    reasonCodes: [],
    binding: Object.freeze({
      taskContract: configured.taskContract,
      modelVersion: configured.modelVersion,
      tokenBudget: configured.tokenBudget,
      costBudgetUsd: configured.costBudgetUsd,
      rightsPolicyId: configured.rightsPolicyId,
      allowedTools: configured.allowedTools,
      available: async (scope: BindingScope, signal?: AbortSignal) =>
        selectedModelCurrent(selection) && (await available(scope, signal)),
    }),
  });
};

export const buildVertexSimulationBinding = async (
  context: BindingContext
): Promise<BindingResult<SimulationBinding>> => {
  const selection = await resolve(context);
  if (!selection) return unavailable("selection-unavailable");
  const configured = selection.simulation;
  if (!configured) return disabled();
  if (selection.environment !== "paper")
    return Object.freeze({
      state: "incompatible",
      reasonCodes: ["paper-simulation-only"],
    });
  const module = selection.modules.find(
    (candidate) => candidate.moduleId === configured.moduleId
  );
  if (!module)
    return Object.freeze({
      state: "incompatible",
      reasonCodes: ["module-pin-missing"],
    });
  const components = [
    ...new Set([
      ...module.requiredComponents,
      ...configured.requiredComponents,
    ]),
  ];
  const assessment = await assessPolicyComponents(
    context.ports,
    selection,
    components,
    module
  );
  if (assessment.state !== "ready")
    return Object.freeze({
      state: assessment.state,
      reasonCodes: assessment.reasonCodes,
    });
  const duration = ttl(context, selection, configured.ttlMilliseconds);
  if (duration < 1) return unavailable("selection-expired");
  return Object.freeze({
    state: "ready",
    reasonCodes: [],
    binding: Object.freeze({
      simulatorId: configured.simulatorId,
      maximumLoss: configured.maximumLoss,
      maximumNotional: configured.maximumNotional,
      ttlMilliseconds: duration,
      available: availability(context, selection, components, module),
    }),
  });
};

export const evaluateRuntimeModules = async (
  context: BindingContext
): Promise<
  readonly Readonly<{
    module: ModulePin;
    state:
      | "disabled"
      | "unknown"
      | "incompatible"
      | "unavailable"
      | "candidate"
      | "active-read-only"
      | "draining"
      | "retired";
    reasonCodes: readonly string[];
  }>[]
> => {
  const lifecycle = await context.registry.readLifecycle(
    context.principal,
    context.lookup
  );
  const { selection, head } = lifecycle;
  const current =
    head.selectionId === selection.selectionId &&
    head.selectionSha256 === selection.selectionSha256;
  return Promise.all(
    selection.modules.map(async (module) => {
      if (!module.enabled)
        return Object.freeze({
          module,
          state: "disabled" as const,
          reasonCodes: ["module-disabled"],
        });
      if (!current && lifecycle.everActivated) {
        const retained = lifecycle.activePins.some(
          (pin) => pin.module.moduleId === module.moduleId
        );
        return Object.freeze({
          module,
          state: retained ? ("draining" as const) : ("retired" as const),
          reasonCodes: [
            retained ? "old-owner-pins-retained" : "historical-version-retired",
          ],
        });
      }
      if (lifecycle.revoked || (current && head.state === "disabled"))
        return Object.freeze({
          module,
          state: "disabled" as const,
          reasonCodes: ["policy-selection-revoked-or-disabled"],
        });
      if (current && head.state === "draining")
        return Object.freeze({
          module,
          state: "draining" as const,
          reasonCodes: ["new-admission-stopped-existing-pins-retained"],
        });
      if (
        !(
          currentSelection(
            context.ports.boundary,
            selection,
            policyNow(context.ports)
          ) &&
          (await currentPolicyAuthority(
            context.ports,
            selection,
            policyNow(context.ports)
          ))
        )
      )
        return Object.freeze({
          module,
          state: "unavailable" as const,
          reasonCodes: ["selection-authority-unavailable"],
        });
      const assessment = await assessPolicyComponents(
        context.ports,
        selection,
        module.requiredComponents,
        module
      );
      if (assessment.state !== "ready")
        return Object.freeze({
          module,
          state: assessment.state,
          reasonCodes: assessment.reasonCodes,
        });
      return Object.freeze({
        module,
        state: current
          ? head.state === "active-read-only"
            ? ("active-read-only" as const)
            : ("disabled" as const)
          : ("candidate" as const),
        reasonCodes: [
          current ? "current-policy-head" : "not-selected-for-new-work",
        ],
      });
    })
  );
};
