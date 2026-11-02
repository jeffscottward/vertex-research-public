// Internal ports only. Public validation MUST be supplied by the authoritative
// API Civet contracts. This package never imports API/DB/auth or recreates Zod.
export type PolicyScope = Readonly<{
  accountAlias: string;
  environment: "research" | "paper";
}>;
export type PolicyPrincipal = Readonly<{ actorId: string }>;
export type CapabilityState =
  | "disabled"
  | "unknown"
  | "incompatible"
  | "unavailable"
  | "ready";
export type ArtifactPin = Readonly<{
  artifactId: string;
  artifactSha256: string;
  contractName: string;
  schemaVersion: string;
}>;
export type ModulePin = Readonly<{
  moduleId: string;
  version: string;
  codeSha256: string;
  contractSha256: string;
  artifact: ArtifactPin;
  enabled: boolean;
  capabilities: readonly string[];
  requiredComponents: readonly string[];
}>;
export type PolicyPin = Readonly<{
  role: string;
  policyId: string;
  version: string;
  artifact: ArtifactPin;
}>;
export type ReferenceMetadata = PolicyScope &
  Readonly<{
    referenceId: string;
    referenceSha256: string;
    logicalName: string;
    kind: "secret-reference" | "nonsecret-reference";
    ownerService: string;
    permissions: readonly string[];
    entitlementPolicyId: string | null;
    rotationOwner: string;
    requiredWhen: readonly string[];
    legacyAliases: readonly string[];
    verificationState: "unknown" | "unavailable" | "incompatible" | "verified";
    lastVerifiedAt: string | null;
    expiresAt: string;
    exposure: "server-only";
  }>;
export type ResearchTool =
  | "read-evidence"
  | "search-authorized-corpus"
  | "propose-strategy"
  | "request-backtest"
  | "write-research-artifact";
export type PolicySelection = PolicyScope &
  Readonly<{
    schemaVersion: string;
    selectionId: string;
    selectionSha256: string;
    revision: string;
    issuedAt: string;
    expiresAt: string;
    sourcePins: readonly Readonly<{
      sourceId: string;
      revision: string;
      sourceSha256: string;
      provenanceArtifact: ArtifactPin;
    }>[];
    modules: readonly ModulePin[];
    policies: readonly PolicyPin[];
    configuration: readonly Readonly<{
      group: string;
      state: CapabilityState;
      referenceIds: readonly string[];
      reasonCodes: readonly string[];
      provenanceSourceIds: readonly string[];
    }>[];
    references: readonly ReferenceMetadata[];
    providerCapabilities: readonly Readonly<{
      capabilityId: string;
      providerId: string;
      endpointReferenceId: string;
      endpointSha256: string;
      modelVersion: string | null;
      operation: string;
      state: CapabilityState;
      rightsPolicyId: string;
      rightsPolicyVersion: string;
      observedAt: string;
      expiresAt: string;
      evidenceArtifact: ArtifactPin;
    }>[];
    artifacts: readonly Readonly<{
      bindingId: string;
      role: string;
      artifact: ArtifactPin;
    }>[];
    review: Readonly<{
      policyId: string;
      version: string;
      reviewVersion: string;
      ttlMilliseconds: number;
      requiredComponents: readonly string[];
    }> | null;
    research: Readonly<{
      moduleId: string;
      taskContract: string;
      modelVersion: string;
      modelCapabilityId: string;
      tokenBudget: number;
      costBudgetUsd: string;
      rightsPolicyId: string;
      allowedTools: readonly ResearchTool[];
      requiredComponents: readonly string[];
    }> | null;
    simulation: Readonly<{
      moduleId: string;
      simulatorId: string;
      maximumLoss: string;
      maximumNotional: string;
      ttlMilliseconds: number;
      requiredComponents: readonly string[];
      capitalAuthority: "native-owner-only";
    }> | null;
    readOnly: true;
    nativeRearmAllowed: false;
    cloudCapitalAuthority: false;
  }>;
export type SelectionLookup = PolicyScope &
  Readonly<{ selectionId: string; selectionSha256: string }>;
export type PolicyHead = PolicyScope &
  Readonly<{
    revision: string;
    selectionId: string | null;
    selectionSha256: string | null;
    state: "disabled" | "active-read-only" | "draining";
    updatedAt: string;
  }>;
export type OwnershipPin = PolicyScope &
  Readonly<{
    holderId: string;
    holderKind: "job" | "open-position";
    ownerServiceId: string;
    ownerEpoch: string;
    selectionId: string;
    selectionSha256: string;
    module: ModulePin;
    pinnedAt: string;
    releasedAt: string | null;
  }>;
export type ComponentEvidence = PolicyScope &
  Readonly<{
    evidenceId: string;
    componentId: string;
    selectionId: string;
    selectionSha256: string;
    state: CapabilityState;
    codeSha256: string;
    contractSha256: string;
    observedAt: string;
    expiresAt: string;
    reasonCodes: readonly string[];
  }>;
export interface PolicyBoundaryRecords {
  RuntimePolicySelection: PolicySelection;
  PolicySelectionLookup: SelectionLookup;
  RuntimePolicyHead: PolicyHead;
  RuntimeOwnershipPin: OwnershipPin;
  RuntimeComponentEvidence: ComponentEvidence;
}
export type PolicyBoundary = Readonly<{
  // RuntimePolicySelection MUST verify the digest, not only the shape.
  validate: <K extends keyof PolicyBoundaryRecords>(
    name: K,
    value: unknown
  ) => Promise<PolicyBoundaryRecords[K]>;
  encode: (value: unknown) => Uint8Array;
  digest: (bytes: Uint8Array) => Promise<string>;
  epochNanoseconds: (timestamp: string) => bigint;
}>;
export type PolicyOperation =
  | "stage"
  | "activate"
  | "rollback"
  | "drain"
  | "revoke"
  | "pin"
  | "release";
export type PrivilegeRequest = Readonly<{
  principal: PolicyPrincipal;
  scope: PolicyScope;
  operation: PolicyOperation;
  selectionId: string;
  selectionSha256: string;
  expectedRevision: string;
  commandId: string;
  requestSha256: string;
  now: string;
}>;
export type PolicyAuthorization = Readonly<{
  // Reuse the current Vertex authorization repository; this is NOT another ACL.
  authorize: (
    request: Readonly<{
      principal: PolicyPrincipal;
      scope: PolicyScope;
      collectionId: null;
      resourceId: string;
      action: "read";
      now: string;
    }>
  ) => Promise<boolean>;
}>;
export type PolicyHistory = Readonly<{
  commandId: string;
  requestSha256: string;
  operation: PolicyOperation;
  actorId: string;
  scope: PolicyScope;
  selectionId: string;
  selectionSha256: string;
  previousHead: PolicyHead;
  head: PolicyHead;
  recordedAt: string;
}>;
export type PolicyRevocation = Readonly<{
  selectionId: string;
  selectionSha256: string;
  recordedAt: string;
  actorId: string;
  commandId: string;
}>;
export type PolicyTransaction = Readonly<{
  getHead: () => Promise<PolicyHead | null>;
  putHead: (head: PolicyHead) => Promise<void>;
  getSelection: (selectionId: string) => Promise<PolicySelection | null>;
  insertSelection: (
    selection: PolicySelection
  ) => Promise<"recorded" | "duplicate">;
  getHistory: (commandId: string) => Promise<PolicyHistory | null>;
  appendHistory: (history: PolicyHistory) => Promise<void>;
  wasActivated: (
    selectionId: string,
    selectionSha256: string
  ) => Promise<boolean>;
  getRevocation: (selectionId: string) => Promise<PolicyRevocation | null>;
  revokeSelection: (revocation: PolicyRevocation) => Promise<void>;
  getPin: (holderId: string) => Promise<OwnershipPin | null>;
  putPin: (pin: OwnershipPin) => Promise<void>;
  listPins: (selectionId: string) => Promise<readonly OwnershipPin[]>;
}>;
export type PolicyStore = Readonly<{
  // Entire callback is atomic, scope locked and serialized with other writes.
  // No callback escapes; thrown errors roll back every row/history/head change.
  transaction: <T>(
    scope: PolicyScope,
    operation: (tx: PolicyTransaction) => Promise<T>
  ) => Promise<T>;
}>;
export type PolicyPorts = Readonly<{
  store: PolicyStore;
  boundary: PolicyBoundary;
  clock: Readonly<{ now: () => string }>;
  authorization: PolicyAuthorization;
  privilegedAuthorization: Readonly<{
    authorize: (request: PrivilegeRequest) => Promise<boolean>;
  }>;
  readiness: Readonly<{
    // Trusted configured component observation; no request-authored evidence.
    observe: (
      selection: PolicySelection,
      componentIds: readonly string[],
      signal?: AbortSignal
    ) => Promise<readonly unknown[]>;
    // Checks exact current rights/policy/entitlement revisions, never credentials.
    currentAuthority: (
      selection: PolicySelection,
      now: string,
      signal?: AbortSignal
    ) => Promise<boolean>;
  }>;
  ownership: Readonly<{
    // Exact native ownership proof for open positions; current worker lease for
    // jobs. False/throw denies. Configuration cannot fabricate native ownership.
    authorize: (
      principal: PolicyPrincipal,
      pin: OwnershipPin,
      operation: "pin" | "release",
      now: string
    ) => Promise<boolean>;
  }>;
}>;
export type PolicyMutation = SelectionLookup &
  Readonly<{
    principal: PolicyPrincipal;
    commandId: string;
    expectedRevision: string;
  }>;
export type PolicyMutationResult = Readonly<{
  status: "recorded" | "duplicate";
  head: PolicyHead;
}>;
export type PolicyLifecycleSnapshot = Readonly<{
  selection: PolicySelection;
  head: PolicyHead;
  everActivated: boolean;
  revoked: boolean;
  activePins: readonly OwnershipPin[];
}>;
export type PolicyRegistry = Readonly<{
  stage: (
    input: PolicyMutation & Readonly<{ selection: unknown }>
  ) => Promise<PolicyMutationResult>;
  activate: (input: PolicyMutation) => Promise<PolicyMutationResult>;
  rollback: (input: PolicyMutation) => Promise<PolicyMutationResult>;
  drain: (input: PolicyMutation) => Promise<PolicyMutationResult>;
  revoke: (input: PolicyMutation) => Promise<PolicyMutationResult>;
  pin: (
    input: PolicyMutation &
      Readonly<{
        holderId: string;
        holderKind: "job" | "open-position";
        ownerServiceId: string;
        ownerEpoch: string;
        moduleId: string;
      }>
  ) => Promise<PolicyMutationResult>;
  release: (
    input: PolicyMutation & Readonly<{ holderId: string }>
  ) => Promise<PolicyMutationResult>;
  readHead: (
    principal: PolicyPrincipal,
    scope: PolicyScope
  ) => Promise<PolicyHead>;
  readSelection: (
    principal: PolicyPrincipal,
    lookup: SelectionLookup
  ) => Promise<PolicySelection>;
  readLifecycle: (
    principal: PolicyPrincipal,
    lookup: SelectionLookup
  ) => Promise<PolicyLifecycleSnapshot>;
  materialize: (
    principal: PolicyPrincipal,
    lookup: SelectionLookup,
    consumerServiceId: string,
    holderId?: string
  ) => Promise<PolicySelection>;
}>;
export class PolicyRegistryError extends Error {
  readonly code:
    | "invalid"
    | "denied"
    | "conflict"
    | "unavailable"
    | "incompatible"
    | "stale"
    | "integrity";
  constructor(code: PolicyRegistryError["code"]) {
    super(`Vertex policy ${code}`);
    this.name = "PolicyRegistryError";
    this.code = code;
  }
}
