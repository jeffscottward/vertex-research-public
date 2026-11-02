import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  createVertexPolicyStoreForTransaction,
  withTransactionReadScope,
  type VertexClock,
  type VertexPrincipal,
  type VertexScope,
  type VertexCommandPolicyGuard,
  type VertexCommandPolicyIdentity,
} from "@darkfactory/db/server/vertex";
import type { VertexWorkerOptions } from "@darkfactory/db/server/vertex-worker";
import {
  createRuntimePolicyRegistry,
  buildVertexReviewPolicy,
  buildVertexResearchBinding,
  buildVertexSimulationBinding,
  assessPolicyComponents,
  type PolicyBoundary,
  type PolicyBoundaryRecords,
  type PolicyPorts,
  type PolicyRegistry,
  type PolicyScope,
  type PolicySelection,
  type ArtifactPin,
  type OwnershipPin,
  type ReviewBinding,
  type ResearchBinding,
  type SimulationBinding,
} from "@darkfactory/config/vertex";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  VERTEX_POLICY_CONTRACT_SCHEMAS,
  PolicyArtifactPinSchema,
  parseRuntimePolicySelection,
} from "../contracts/vertex-policy.ts";
import {
  WorkerLeaseSchema,
  WorkerReadinessInputSchema,
  WorkerServiceGrantSchema,
  type WorkerLease,
} from "../contracts/vertex-worker.ts";
import {
  createVertexRuntimePolicyArtifacts,
  vertexPolicyTransactionDatabase,
  runtimePolicyFail as fail,
  runtimePolicyText as text,
  runtimePolicyRows as rows,
  runtimePolicyScopeWhere as where,
  type VertexRuntimePolicyArtifactOptions,
} from "./vertex-runtime-policy-artifacts.ts";
import { VersionSchema } from "../contracts/vertex.ts";
import {
  parseVertexResearchChatCopyRetentionPolicy,
  parseVertexResearchChatNativeCopyRetentionPolicy,
  type VertexResearchChatCopyRetentionLookup,
  type VertexResearchChatCopyRetentionObservation,
  type VertexResearchChatNativeCopyRetentionObservation,
} from "./vertex-research-chat-copy-retention.ts";
import { createVertexRuntimeModelEvidence } from "./vertex-runtime-model-evidence.ts";
import { present } from "./present.ts";

// Validation is a pure function of the record name and the exact input data:
// the schemas read no clock or random source. Results are deep-frozen, so a
// result can be shared. Policy reads validate the same stored selection many
// times per request; the cache skips the repeated parse, digest and freeze.
// Every input still passes the canonical encoder first, so inputs it rejects
// (accessors, cycles, unsafe numbers, lone surrogates) are never cached.
const VALIDATION_CACHE_LIMIT = 64;
const validationCache = new Map<string, unknown>();
const validatedRecords = new WeakMap<object, string>();
const rememberValidation = (key: string, name: string, result: unknown) => {
  if (validationCache.size >= VALIDATION_CACHE_LIMIT) {
    // Maps keep insertion order; drop the oldest entry.
    for (const oldest of validationCache.keys()) {
      validationCache.delete(oldest);
      break;
    }
  }
  validationCache.set(key, result);
  if (typeof result === "object" && result !== null)
    validatedRecords.set(result, name);
};

export const vertexRuntimePolicyBoundary: PolicyBoundary = Object.freeze({
  validate: async <K extends keyof PolicyBoundaryRecords>(
    name: K,
    value: unknown
  ): Promise<PolicyBoundaryRecords[K]> => {
    try {
      // A deep-frozen result of this validator cannot change after validation.
      if (
        typeof value === "object" &&
        value !== null &&
        validatedRecords.get(value) === name
      )
        return value as PolicyBoundaryRecords[K];
      canonicalArtifactJson(value);
      // Exact text, key order included: equal text means equal parse input.
      const key = `${name}\u0000${JSON.stringify(value)}`;
      const cached = validationCache.get(key);
      if (cached !== undefined) return cached as PolicyBoundaryRecords[K];
      const parsed =
        name === "RuntimePolicySelection"
          ? await parseRuntimePolicySelection(value)
          : VERTEX_POLICY_CONTRACT_SCHEMAS[name].parse(value);
      const result = deepFreezeArtifact(parsed);
      rememberValidation(key, name, result);
      return result as PolicyBoundaryRecords[K];
    } catch {
      return fail();
    }
  },
  encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
  digest: hashArtifact,
  epochNanoseconds: timestampToEpochNanoseconds,
});
const ns = timestampToEpochNanoseconds;
const sameScope = (left: PolicyScope, right: PolicyScope): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
const scopeOf = (
  scope: Readonly<{ accountAlias: string; environment: string }>
): PolicyScope => {
  if (
    !(
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(scope.accountAlias) &&
      ["research", "paper"].includes(scope.environment)
    )
  )
    return fail();
  return Object.freeze({
    accountAlias: scope.accountAlias,
    environment: scope.environment as PolicyScope["environment"],
  });
};
const identityOf = (
  selection: PolicySelection,
  revision: string
): VertexCommandPolicyIdentity =>
  Object.freeze({
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    selectionRevision: selection.revision,
    revision,
  });
const boundedExpiry = (
  observedAt: string,
  maximumAgeMilliseconds: number,
  ...ends: readonly string[]
): string => {
  const end = ends
    .map(ns)
    .reduce(
      (a, b) => (a < b ? a : b),
      ns(observedAt) + BigInt(maximumAgeMilliseconds) * 1_000_000n
    );
  // Floor to milliseconds; rounding must never extend an authority lifetime.
  return new Date(Number(end / 1_000_000n)).toISOString();
};

// These strict private captures narrow ONLY the new terms observation. Legacy
// selection and model-use interfaces retain their existing behavior.
const retentionIdentifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/);
const retentionDigest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const retentionPrincipalSchema = z
  .object({ actorId: retentionIdentifier })
  .strict();
const retentionLookupSchema = z
  .object({
    accountAlias: retentionIdentifier,
    environment: z.literal("research"),
    selectionId: retentionIdentifier,
    selectionSha256: retentionDigest,
  })
  .strict();
const retentionPinSchema = z
  .object({
    role: z.literal("retention"),
    policyId: retentionIdentifier,
    version: VersionSchema.refine((value) => !/\s/.test(value)),
    artifact: z
      .object({
        artifactId: retentionIdentifier,
        artifactSha256: retentionDigest,
        contractName: z.literal("VertexResearchChatCopyRetentionPolicy"),
        schemaVersion: z.literal("1.0.0"),
      })
      .strict(),
  })
  .strict();
const selectedRetentionPin = (selection: PolicySelection) => {
  const pins = selection.policies.filter((pin) => pin.role === "retention");
  if (pins.length !== 1) return fail();
  return deepFreezeArtifact(
    retentionPinSchema.parse(JSON.parse(canonicalArtifactJson(pins[0])))
  );
};

// All fields select evidence. None is a ready flag or an authority grant.
export type VertexRuntimeComponentBinding = PolicyScope &
  Readonly<{
    componentId: string;
    moduleId: string;
    servicePrincipalId: string;
    grantId: string;
    maximumAgeMilliseconds: number;
  }> &
  (
    | Readonly<{ source: "worker-job"; jobId: string }>
    | Readonly<{
        source: "host-object";
        principal: VertexPrincipal;
        evidence: ArtifactPin;
        rightsPolicyId: string;
        rightsVersion: string;
      }>
  );
export type VertexRuntimeJobModuleBinding = PolicyScope &
  Readonly<{
    kind: WorkerLease["kind"];
    consumerServiceId: string;
    moduleId: string;
  }>;
export type VertexRuntimePolicyOptions = VertexRuntimePolicyArtifactOptions &
  Readonly<{
    db: Database;
    clock: VertexClock;
    consumerServiceId: string;
    components: readonly VertexRuntimeComponentBinding[];
    jobModules: readonly VertexRuntimeJobModuleBinding[];
    // Independent authenticated policy administration, never implied by read ACL.
    // An absent callback denies every registry mutation, including stage/activate.
    privilegedAuthorization?: PolicyPorts["privilegedAuthorization"];
  }>;
export type VertexResolvedRuntimePolicy = Readonly<{
  reviewPolicy?: ReviewBinding;
  research?: ResearchBinding;
  simulation?: SimulationBinding;
  policyIdentity?: VertexCommandPolicyIdentity;
}>;

export const createVertexRuntimePolicy = (
  options: VertexRuntimePolicyOptions
) => {
  const boundary = vertexRuntimePolicyBoundary;
  const artifacts = createVertexRuntimePolicyArtifacts(options);
  const components = deepFreezeArtifact(structuredClone(options.components));
  const jobModules = deepFreezeArtifact(structuredClone(options.jobModules));
  if (
    !(
      typeof options.db?.transaction === "function" &&
      typeof options.db?.execute === "function" &&
      typeof options.clock?.now === "function" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,143}$/.test(options.consumerServiceId)
    ) ||
    components.length > 256 ||
    jobModules.length > 256
  )
    fail();
  for (const binding of components) {
    scopeOf(binding);
    if (
      !Number.isSafeInteger(binding.maximumAgeMilliseconds) ||
      binding.maximumAgeMilliseconds < 1 ||
      binding.maximumAgeMilliseconds > 300_000
    )
      fail();
    if (binding.source === "host-object")
      PolicyArtifactPinSchema.parse(binding.evidence);
  }
  const run = async <T>(
    scope: PolicyScope,
    operation: (tx: Transaction) => Promise<T>
  ): Promise<T> => {
    try {
      if (options.signal?.aborted) return fail();
      return await options.db.transaction(
        withTransactionReadScope(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
          );
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
          );
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
          );
          return operation(tx);
        })
      );
    } catch {
      return fail();
    }
  };
  const serviceGrant = async (
    tx: Transaction,
    scope: PolicyScope,
    grantId: string,
    servicePrincipalId: string,
    operations: readonly string[],
    at: string
  ) => {
    const row = (
      await rows(
        tx,
        sql`select * from vertex_worker_service_grants where ${where(scope)} and grant_id = ${grantId} limit 1`
      )
    )[0];
    if (!row) return fail();
    const grant = WorkerServiceGrantSchema.parse(row["payload"]);
    if (
      (await hashArtifact(grant)) !== row["record_hash"] ||
      !sameScope(grant, scope) ||
      grant.grantId !== grantId ||
      grant.grantId !== row["grant_id"] ||
      grant.servicePrincipalId !== servicePrincipalId ||
      grant.servicePrincipalId !== row["service_principal_id"] ||
      row["revoked_at"] !== null ||
      grant.revokedAt !== null ||
      ns(grant.issuedAt).toString() !== row["issued_at_ns"] ||
      ns(grant.expiresAt).toString() !== row["expires_at_ns"] ||
      ns(grant.issuedAt) > ns(at) ||
      ns(grant.expiresAt) <= ns(at) ||
      operations.some(
        (operation) =>
          !(grant.operations as readonly string[]).includes(operation)
      )
    )
      fail();
    return grant;
  };
  const currentJob = async (
    tx: Transaction,
    scope: PolicyScope,
    jobId: string,
    servicePrincipalId: string,
    operations: readonly string[],
    at: string
  ) => {
    const row = (
      await rows(
        tx,
        sql`select * from vertex_worker_jobs where ${where(scope)} and job_id = ${jobId} limit 1`
      )
    )[0];
    if (!(row && ["leased", "running"].includes(text(row["state"]))))
      return fail();
    const lease = WorkerLeaseSchema.parse(row["payload"]);
    if (
      !sameScope(lease, scope) ||
      lease.jobId !== jobId ||
      lease.jobId !== row["job_id"] ||
      lease.eventId !== row["event_id"] ||
      lease.leaseId !== row["lease_id"] ||
      lease.leaseId !== row["worker_instance_id"] ||
      lease.leaseEpoch !== row["lease_epoch"] ||
      lease.attempt !== row["attempt"] ||
      ns(lease.leaseExpiresAt).toString() !== row["lease_expires_at_ns"] ||
      ns(lease.deadlineAt).toString() !== row["deadline_at_ns"] ||
      ns(lease.leaseExpiresAt) <= ns(at) ||
      ns(lease.deadlineAt) <= ns(at)
    )
      fail();
    const stable = {
      kind: lease.kind,
      researchPrincipalId: lease.researchPrincipalId,
      payloadArtifactId: lease.payloadArtifactId,
      payloadSha256: lease.payloadSha256,
      policySelectionId: lease.policySelectionId,
      policySelectionSha256: lease.policySelectionSha256,
      deadlineAt: lease.deadlineAt,
    };
    const exactScope = scopeOf(scope);
    if (
      (await hashArtifact({
        scope: exactScope,
        eventId: lease.eventId,
        ...stable,
      })) !== row["binding_hash"] ||
      jobId !==
        `job-${await hashArtifact({ scope: exactScope, eventId: lease.eventId })}`
    )
      fail();
    const required =
      lease.kind === "native-bootstrap"
        ? [...operations, "native-bootstrap"]
        : operations;
    const grant = await serviceGrant(
      tx,
      scope,
      text(row["grant_id"]),
      servicePrincipalId,
      required,
      at
    );
    return { row, lease, grant };
  };
  const currentAuthority = async (
    tx: Transaction,
    selection: PolicySelection,
    at: string,
    signal?: AbortSignal
  ): Promise<boolean> => {
    try {
      if (
        options.signal?.aborted ||
        signal?.aborted ||
        ns(selection.issuedAt) > ns(at) ||
        ns(selection.expiresAt) <= ns(at)
      )
        return false;
      // Exact persisted selection digest prevents checking a caller-authored
      // subset that quietly drops expired licensing or provider dependencies.
      const store = createVertexPolicyStoreForTransaction(tx, { boundary });
      const stored = await store.transaction(scopeOf(selection), (policy) =>
        policy.getSelection(selection.selectionId)
      );
      if (!stored || stored.selectionSha256 !== selection.selectionSha256)
        return false;
      const rights = selection.policies.filter(
        (pin) => pin.role === "licensing-rights"
      );
      if (rights.length === 0) return false;
      for (const pin of rights)
        await artifacts.currentRights(
          tx,
          selection,
          pin.policyId,
          pin.version,
          at
        );
      const pins: ArtifactPin[] = [
        ...selection.sourcePins.map((entry) => entry.provenanceArtifact),
        ...selection.modules.map((entry) => entry.artifact),
        ...selection.policies.map((entry) => entry.artifact),
        ...selection.artifacts.map((entry) => entry.artifact),
        ...selection.providerCapabilities.map(
          (entry) => entry.evidenceArtifact
        ),
      ];
      const seen = new Map<string, string>();
      for (const pin of pins) {
        const key = canonicalArtifactJson(pin);
        if (seen.has(pin.artifactId) && seen.get(pin.artifactId) !== key)
          return false;
        if (!seen.has(pin.artifactId))
          await artifacts.inspect(tx, selection, pin, at);
        seen.set(pin.artifactId, key);
      }
      for (const fact of selection.providerCapabilities) {
        const right = rights.find(
          (pin) =>
            pin.policyId === fact.rightsPolicyId &&
            pin.version === fact.rightsPolicyVersion
        );
        if (
          !right ||
          ns(fact.observedAt) > ns(at) ||
          ns(fact.expiresAt) <= ns(at)
        )
          return false;
        await artifacts.currentRights(
          tx,
          selection,
          right.policyId,
          right.version,
          at
        );
      }
      for (const reference of selection.references) {
        if (
          reference.entitlementPolicyId !== null &&
          !rights.some((pin) => pin.policyId === reference.entitlementPolicyId)
        )
          return false;
      }
      if (
        selection.research &&
        !rights.some(
          (pin) => pin.policyId === present(selection.research).rightsPolicyId
        )
      )
        return false;
      if (
        selection.review &&
        !selection.policies.some(
          (pin) =>
            pin.role === "review" &&
            pin.policyId === present(selection.review).policyId &&
            pin.version === present(selection.review).version
        )
      )
        return false;
      return !signal?.aborted;
    } catch {
      return false;
    }
  };
  const compose = (tx: Transaction) => {
    const store = createVertexPolicyStoreForTransaction(tx, { boundary });
    const authorization = createVertexAuthorization(
      vertexPolicyTransactionDatabase(tx),
      { clock: options.clock }
    );
    const ownership: PolicyPorts["ownership"] = {
      authorize: async (principal, pin, _operation, at) => {
        try {
          if (pin.holderKind !== "job" || pin.releasedAt !== null) return false;
          const job = await currentJob(
            tx,
            pin,
            pin.holderId,
            pin.ownerServiceId,
            ["policySelection"],
            at
          );
          return (
            job.lease.researchPrincipalId === principal.actorId &&
            job.lease.leaseEpoch === pin.ownerEpoch &&
            job.lease.policySelectionId === pin.selectionId &&
            job.lease.policySelectionSha256 === pin.selectionSha256
          );
        } catch {
          return false;
        }
      },
    };
    const observe: PolicyPorts["readiness"]["observe"] = async (
      selection,
      ids,
      signal
    ) => {
      const evidence: PolicyBoundaryRecords["RuntimeComponentEvidence"][] = [];
      for (const componentId of ids) {
        if (signal?.aborted) return [];
        const matching = components.filter(
          (candidate) =>
            sameScope(candidate, selection) &&
            candidate.componentId === componentId
        );
        if (matching.length !== 1) continue;
        const binding = present(matching[0]);
        const module = selection.modules.find(
          (pin) =>
            pin.moduleId === binding.moduleId &&
            pin.enabled &&
            pin.requiredComponents.includes(componentId)
        );
        if (!module) continue;
        const at = options.clock.now();
        if (binding.source === "worker-job") {
          const job = await currentJob(
            tx,
            selection,
            binding.jobId,
            binding.servicePrincipalId,
            ["readiness", "policySelection"],
            at
          );
          if (
            job.grant.grantId !== binding.grantId ||
            job.lease.policySelectionId !== selection.selectionId ||
            job.lease.policySelectionSha256 !== selection.selectionSha256
          )
            continue;
          const pin = await store.transaction(scopeOf(selection), (policy) =>
            policy.getPin(binding.jobId)
          );
          if (
            !pin ||
            pin.releasedAt !== null ||
            pin.ownerServiceId !== binding.servicePrincipalId ||
            pin.ownerEpoch !== job.lease.leaseEpoch ||
            pin.selectionId !== selection.selectionId ||
            pin.selectionSha256 !== selection.selectionSha256 ||
            (await hashArtifact(pin.module)) !== (await hashArtifact(module))
          )
            continue;
          const row = (
            await rows(
              tx,
              sql`select * from vertex_worker_readiness where ${where(selection)} and job_id = ${binding.jobId} limit 1`
            )
          )[0];
          if (!row) continue;
          const receipt = WorkerReadinessInputSchema.parse(row["payload"]);
          if (
            !sameScope(receipt, selection) ||
            receipt.jobId !== binding.jobId ||
            receipt.leaseId !== job.lease.leaseId ||
            receipt.leaseEpoch !== job.lease.leaseEpoch ||
            receipt.leaseEpoch !== row["lease_epoch"] ||
            ns(receipt.observedAt).toString() !== row["observed_at_ns"] ||
            !receipt.capabilityIds.includes(componentId) ||
            receipt.state !== "ready" ||
            ns(receipt.observedAt) > ns(at) ||
            ns(at) - ns(receipt.observedAt) >=
              BigInt(binding.maximumAgeMilliseconds) * 1_000_000n
          )
            continue;
          const expiresAt = boundedExpiry(
            receipt.observedAt,
            binding.maximumAgeMilliseconds,
            job.lease.leaseExpiresAt,
            job.grant.expiresAt,
            selection.expiresAt
          );
          evidence.push(
            await boundary.validate("RuntimeComponentEvidence", {
              accountAlias: selection.accountAlias,
              environment: selection.environment,
              evidenceId: `worker-${await hashArtifact(receipt)}`,
              componentId,
              selectionId: selection.selectionId,
              selectionSha256: selection.selectionSha256,
              state: "ready",
              codeSha256: pin.module.codeSha256,
              contractSha256: pin.module.contractSha256,
              observedAt: receipt.observedAt,
              expiresAt,
              reasonCodes: ["authenticated-worker-receipt"],
            })
          );
        } else {
          // Bootstrap without circular job->policy->readiness admission: the
          // server selects immutable host bytes by hash; current independent
          // actor ACL, licensing and service grant authorize observing them.
          const grant = await serviceGrant(
            tx,
            selection,
            binding.grantId,
            binding.servicePrincipalId,
            ["readiness"],
            at
          );
          const bytes = await artifacts.readHostReceipt(
            tx,
            binding.principal,
            scopeOf(selection),
            binding.evidence,
            binding.rightsPolicyId,
            binding.rightsVersion
          );
          const receipt = await boundary.validate(
            "RuntimeComponentEvidence",
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          );
          if (
            !sameScope(receipt, selection) ||
            receipt.componentId !== componentId ||
            receipt.selectionId !== selection.selectionId ||
            receipt.selectionSha256 !== selection.selectionSha256 ||
            receipt.codeSha256 !== module.codeSha256 ||
            receipt.contractSha256 !== module.contractSha256 ||
            receipt.state !== "ready" ||
            ns(receipt.observedAt) < ns(grant.issuedAt) ||
            ns(receipt.observedAt) > ns(at) ||
            ns(receipt.expiresAt) > ns(grant.expiresAt) ||
            ns(receipt.expiresAt) <= ns(at) ||
            ns(at) - ns(receipt.observedAt) >=
              BigInt(binding.maximumAgeMilliseconds) * 1_000_000n
          )
            continue;
          await artifacts.authorize(
            tx,
            binding.principal,
            scopeOf(selection),
            `policy-consumer:${binding.servicePrincipalId}`,
            options.clock.now()
          );
          const expiresAt = boundedExpiry(
            receipt.observedAt,
            binding.maximumAgeMilliseconds,
            receipt.expiresAt,
            grant.expiresAt,
            selection.expiresAt
          );
          evidence.push(
            await boundary.validate("RuntimeComponentEvidence", {
              ...receipt,
              expiresAt,
            })
          );
        }
      }
      return Object.freeze(evidence);
    };
    const ports: PolicyPorts = Object.freeze({
      store,
      boundary,
      clock: options.clock,
      authorization,
      privilegedAuthorization: {
        authorize: async (request) =>
          (await options.privilegedAuthorization?.authorize(request)) === true,
      },
      ownership,
      readiness: {
        observe,
        currentAuthority: (selection, at, signal) =>
          currentAuthority(tx, selection, at, signal),
      },
    });
    return { ports, registry: createRuntimePolicyRegistry(ports) };
  };
  const withRegistry = async <T>(
    scope: Readonly<{ accountAlias: string; environment: string }>,
    operation: (registry: PolicyRegistry) => Promise<T>
  ): Promise<T> => run(scopeOf(scope), (tx) => operation(compose(tx).registry));
  const registry: PolicyRegistry = Object.freeze({
    stage: (input) => withRegistry(input, (local) => local.stage(input)),
    activate: (input) => withRegistry(input, (local) => local.activate(input)),
    rollback: (input) => withRegistry(input, (local) => local.rollback(input)),
    drain: (input) => withRegistry(input, (local) => local.drain(input)),
    revoke: (input) => withRegistry(input, (local) => local.revoke(input)),
    pin: (input) => withRegistry(input, (local) => local.pin(input)),
    release: (input) => withRegistry(input, (local) => local.release(input)),
    readHead: (principal, scope) =>
      withRegistry(scope, (local) => local.readHead(principal, scope)),
    readSelection: (principal, lookup) =>
      withRegistry(lookup, (local) => local.readSelection(principal, lookup)),
    readLifecycle: (principal, lookup) =>
      withRegistry(lookup, (local) => local.readLifecycle(principal, lookup)),
    materialize: (principal, lookup, consumerServiceId, holderId) =>
      withRegistry(lookup, (local) =>
        local.materialize(principal, lookup, consumerServiceId, holderId)
      ),
  });
  const materializeForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: Readonly<{
      accountAlias: string;
      environment: string;
      selectionId: string;
      selectionSha256: string;
    }>,
    consumerServiceId: string,
    holderId?: string
  ): Promise<PolicySelection> => {
    try {
      if (options.signal?.aborted) return fail();
      const lookup = await boundary.validate("PolicySelectionLookup", {
        ...scopeOf(raw),
        selectionId: raw.selectionId,
        selectionSha256: raw.selectionSha256,
      });
      return await compose(tx).registry.materialize(
        principal,
        lookup,
        consumerServiceId,
        holderId
      );
    } catch {
      return fail();
    }
  };
  const readChatCopyRetentionForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: VertexResearchChatCopyRetentionLookup,
    consumerServiceId: string,
    native: boolean
  ): Promise<
    | VertexResearchChatCopyRetentionObservation
    | VertexResearchChatNativeCopyRetentionObservation
  > => {
    try {
      // All caller data is detached before the first await. Neither a holder
      // nor an arbitrary artifact/callback may substitute for the current head.
      const actor = deepFreezeArtifact(
        retentionPrincipalSchema.parse(
          JSON.parse(canonicalArtifactJson(principal))
        )
      );
      const lookup = deepFreezeArtifact(
        retentionLookupSchema.parse(JSON.parse(canonicalArtifactJson(raw)))
      );
      const consumer = retentionIdentifier.max(143).parse(consumerServiceId);
      if (options.signal?.aborted) return fail();
      const startedAt = options.clock.now();
      let lastNs = ns(startedAt);
      const startedNs = lastNs;
      const checkedNow = (): string => {
        if (options.signal?.aborted) return fail();
        const at = options.clock.now();
        const atNs = ns(at);
        if (atNs < lastNs) return fail();
        lastNs = atNs;
        return at;
      };
      const requireSelection = (
        selection: PolicySelection,
        at: string
      ): void => {
        if (
          selection.accountAlias !== lookup.accountAlias ||
          selection.environment !== lookup.environment ||
          selection.selectionId !== lookup.selectionId ||
          selection.selectionSha256 !== lookup.selectionSha256 ||
          !selection.research ||
          ns(selection.issuedAt) > startedNs ||
          ns(selection.expiresAt) <= ns(at)
        )
          fail();
      };
      const before = await materializeForTransaction(
        tx,
        actor,
        lookup,
        consumer
      );
      requireSelection(before, checkedNow());
      const pin = selectedRetentionPin(before);
      const returned = await artifacts.readSelectedArtifact(
        tx,
        actor,
        lookup,
        pin.artifact
      );
      if (
        !(returned instanceof Uint8Array) ||
        returned.byteLength < 1 ||
        returned.byteLength > 8192
      )
        return fail();
      // Capture the exact returned bytes and parse before another await.
      const bytes = new Uint8Array(returned);
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(json);
      if (canonicalArtifactJson(value) !== json) return fail();
      const policy = native
        ? parseVertexResearchChatNativeCopyRetentionPolicy(value)
        : parseVertexResearchChatCopyRetentionPolicy(value);
      if (
        policy.accountAlias !== lookup.accountAlias ||
        policy.environment !== lookup.environment ||
        policy.policyId !== pin.policyId ||
        policy.policyVersion !== pin.version
      )
        return fail();
      checkedNow();
      if ((await hashArtifact(bytes)) !== pin.artifact.artifactSha256)
        return fail();
      checkedNow();
      // The borrowed policy transaction already holds the authorization-global
      // and policy locks. Retain primitive deadlines before final materialize:
      // a successful earlier read must not survive expiry during its awaits.
      const bounds: bigint[] = [
        ns(before.expiresAt),
        ...before.providerCapabilities.map((fact) => ns(fact.expiresAt)),
      ];
      const readGrant = createVertexRuntimeModelEvidence(options).readGrant;
      for (const resourceId of [
        "account-scope",
        lookup.selectionId,
        `policy-consumer:${consumer}`,
        pin.artifact.artifactId,
      ]) {
        const grant = await readGrant(
          tx,
          actor,
          lookup,
          null,
          resourceId,
          startedAt
        );
        bounds.push(ns(grant.expiresAt));
        checkedNow();
      }
      const retainedRights = new Set<string>();
      const retainRightsBounds = async (
        policyId: string,
        version: string
      ): Promise<void> => {
        const identity = canonicalArtifactJson([policyId, version]);
        if (retainedRights.has(identity)) return;
        const rights = await artifacts.currentRights(
          tx,
          lookup,
          policyId,
          version,
          checkedNow()
        );
        bounds.push(ns(text(rights["expiresAt"])));
        if (rights["retentionUntil"] !== null)
          bounds.push(ns(text(rights["retentionUntil"])));
        retainedRights.add(identity);
        checkedNow();
        return;
      };
      for (const rights of before.policies.filter(
        (entry) => entry.role === "licensing-rights"
      )) {
        await retainRightsBounds(rights.policyId, rights.version);
      }
      // Match currentAuthority's complete selected artifact set, not just the
      // retention document. Inspection keeps catalog/stage and rights ownership.
      const authorityPins: ArtifactPin[] = [
        ...before.sourcePins.map((entry) => entry.provenanceArtifact),
        ...before.modules.map((entry) => entry.artifact),
        ...before.policies.map((entry) => entry.artifact),
        ...before.artifacts.map((entry) => entry.artifact),
        ...before.providerCapabilities.map((entry) => entry.evidenceArtifact),
      ];
      const inspected = new Map<string, string>();
      for (const artifact of authorityPins) {
        const identity = canonicalArtifactJson(artifact);
        if (
          inspected.has(artifact.artifactId) &&
          inspected.get(artifact.artifactId) !== identity
        )
          return fail();
        if (!inspected.has(artifact.artifactId)) {
          const descriptor = await artifacts.inspect(
            tx,
            lookup,
            artifact,
            checkedNow()
          );
          await retainRightsBounds(
            descriptor.rightsPolicyId,
            descriptor.rightsVersion
          );
        }
        inspected.set(artifact.artifactId, identity);
      }
      const after = await materializeForTransaction(
        tx,
        actor,
        lookup,
        consumer
      );
      if (
        canonicalArtifactJson(selectedRetentionPin(after)) !==
          canonicalArtifactJson(pin) ||
        after.selectionId !== before.selectionId ||
        after.selectionSha256 !== before.selectionSha256
      )
        return fail();
      const checkedAt = checkedNow();
      requireSelection(after, checkedAt);
      if (bounds.some((bound) => bound <= ns(checkedAt))) return fail();
      // No await after this final clock sample: every retained authority bound
      // must still be valid at the exact metadata observation timestamp.
      // Metadata only: checkedAt is not a cleanup deadline, stable approval
      // identity, grant, readiness assessment or physical-erasure witness.
      return deepFreezeArtifact({
        profile: native
          ? ("vertex-research-chat-native-evidence-retention-observation-v1" as const)
          : ("vertex-research-chat-copy-retention-observation-v1" as const),
        accountAlias: lookup.accountAlias,
        environment: lookup.environment,
        observedByActorId: actor.actorId,
        consumerServiceId: consumer,
        selectionId: after.selectionId,
        selectionSha256: after.selectionSha256,
        policy,
        artifact: pin.artifact,
        checkedAt,
      }) as
        | VertexResearchChatCopyRetentionObservation
        | VertexResearchChatNativeCopyRetentionObservation;
    } catch {
      return fail();
    }
  };
  const readResearchChatCopyRetentionForTransaction = (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: VertexResearchChatCopyRetentionLookup,
    consumerServiceId: string
  ): Promise<VertexResearchChatCopyRetentionObservation> => {
    return readChatCopyRetentionForTransaction(
      tx,
      principal,
      raw,
      consumerServiceId,
      false
    ) as Promise<VertexResearchChatCopyRetentionObservation>;
  };
  const readResearchChatNativeCopyRetentionForTransaction = (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: VertexResearchChatCopyRetentionLookup,
    consumerServiceId: string
  ): Promise<VertexResearchChatNativeCopyRetentionObservation> => {
    return readChatCopyRetentionForTransaction(
      tx,
      principal,
      raw,
      consumerServiceId,
      true
    ) as Promise<VertexResearchChatNativeCopyRetentionObservation>;
  };
  const policySelection: VertexWorkerOptions["policySelection"] = async (
    tx,
    principal,
    raw,
    consumerServiceId,
    holderId
  ) => {
    return await materializeForTransaction(
      tx,
      principal,
      raw,
      consumerServiceId,
      holderId
    );
  };
  const pinPolicySelection: VertexWorkerOptions["pinPolicySelection"] = async (
    tx,
    principal,
    raw,
    consumerServiceId,
    holderId
  ) => {
    const lookup = await boundary.validate("PolicySelectionLookup", {
      ...scopeOf(raw),
      selectionId: raw.selectionId,
      selectionSha256: raw.selectionSha256,
    });
    const { ports, registry: local } = compose(tx);
    const at = options.clock.now();
    const job = await currentJob(
      tx,
      lookup,
      holderId,
      consumerServiceId,
      ["claim", "policySelection"],
      at
    );
    if (
      job.lease.researchPrincipalId !== principal.actorId ||
      job.lease.policySelectionId !== lookup.selectionId ||
      job.lease.policySelectionSha256 !== lookup.selectionSha256
    )
      fail();
    const source = (
      await rows(
        tx,
        sql`select * from vertex_outbox where ${where(lookup)} and event_id = ${job.lease.eventId} limit 1`
      )
    )[0];
    if (
      !source ||
      source["published_at"] !== null ||
      source["lease_owner"] !== job.lease.leaseId ||
      source["lease_fence"] !== job.lease.leaseEpoch ||
      ns(at) >= BigInt(text(source["lease_expires_at_ns"])) ||
      (await hashArtifact(source["payload"])) !== source["record_hash"]
    )
      fail();
    // Source bytes/rights are already verified by bindOutbox before insertion;
    // the row is now real and visible in this transaction, never a fake lease.
    const selection = await local.materialize(
      principal,
      lookup,
      consumerServiceId
    );
    const bindings = jobModules.filter(
      (binding) =>
        sameScope(binding, lookup) &&
        binding.kind === job.lease.kind &&
        binding.consumerServiceId === consumerServiceId
    );
    if (bindings.length !== 1) fail();
    const module = selection.modules.find(
      (pin) => pin.moduleId === present(bindings[0]).moduleId && pin.enabled
    );
    if (
      !module ||
      (
        await assessPolicyComponents(
          ports,
          selection,
          module.requiredComponents,
          module
        )
      ).state !== "ready"
    )
      fail();
    await ports.store.transaction(scopeOf(lookup), async (policy) => {
      const existing = await policy.getPin(holderId);
      const pin: OwnershipPin = {
        ...scopeOf(lookup),
        holderId,
        holderKind: "job",
        ownerServiceId: consumerServiceId,
        ownerEpoch: job.lease.leaseEpoch,
        selectionId: lookup.selectionId,
        selectionSha256: lookup.selectionSha256,
        module: present(module),
        pinnedAt: existing?.pinnedAt ?? at,
        releasedAt: null,
      };
      if (
        !(await ports.ownership.authorize(
          principal,
          pin,
          "pin",
          options.clock.now()
        ))
      )
        fail();
      return await policy.putPin(pin);
    });
    await local.materialize(principal, lookup, consumerServiceId, holderId);
    const completedAt = options.clock.now();
    if (ns(completedAt) >= BigInt(text(source["lease_expires_at_ns"]))) fail();
    // Re-read the lease after pinning; the store port returns nothing.
    await currentJob(
      tx,
      lookup,
      holderId,
      consumerServiceId,
      ["claim", "policySelection"],
      completedAt
    );
  };
  const resolvePolicy = async (
    principal: VertexPrincipal,
    rawScope: VertexScope,
    signal?: AbortSignal
  ): Promise<VertexResolvedRuntimePolicy> => {
    if (signal?.aborted || rawScope.environment === "live")
      return Object.freeze({});
    try {
      return await run(scopeOf(rawScope), async (tx) => {
        const { ports, registry: local } = compose(tx);
        const head = await local.readHead(principal, scopeOf(rawScope));
        if (
          head.state !== "active-read-only" ||
          !head.selectionId ||
          !head.selectionSha256
        )
          return Object.freeze({});
        const lookup = {
          ...scopeOf(rawScope),
          selectionId: head.selectionId,
          selectionSha256: head.selectionSha256,
        };
        const selection = await local.materialize(
          principal,
          lookup,
          options.consumerServiceId
        );
        const context = {
          ports,
          registry: local,
          principal,
          lookup,
          consumerServiceId: options.consumerServiceId,
        };
        const review = await buildVertexReviewPolicy(context);
        const research = await buildVertexResearchBinding(context);
        const simulation = await buildVertexSimulationBinding(context);
        const identity = identityOf(selection, head.revision);
        // Availability checks outlive this DB callback. Open a fresh serialized
        // read; never capture a completed transaction or installation cache.
        const available =
          (kind: "research" | "simulation") =>
          async (scope: VertexScope, abort?: AbortSignal): Promise<boolean> => {
            if (
              abort?.aborted ||
              scope.environment === "live" ||
              !sameScope(scopeOf(scope), lookup)
            )
              return false;
            const resolved = await resolvePolicy(principal, scope, abort);
            return (
              canonicalArtifactJson(resolved.policyIdentity ?? null) ===
                canonicalArtifactJson(identity) && resolved[kind] !== undefined
            );
          };
        if (
          signal?.aborted ||
          !(await currentAuthority(tx, selection, options.clock.now(), signal))
        )
          return Object.freeze({});
        return Object.freeze({
          policyIdentity: identity,
          ...(review.binding ? { reviewPolicy: review.binding } : {}),
          ...(research.binding
            ? {
                research: Object.freeze({
                  ...research.binding,
                  available: available("research"),
                }),
              }
            : {}),
          ...(simulation.binding
            ? {
                simulation: Object.freeze({
                  ...simulation.binding,
                  available: available("simulation"),
                }),
              }
            : {}),
        });
      });
    } catch {
      return Object.freeze({});
    }
  };
  const commandPolicy: VertexCommandPolicyGuard = async (tx, input) => {
    try {
      if (input.scope.environment === "live") return false;
      const { ports, registry: local } = compose(tx);
      const scope = scopeOf(input.scope);
      const head = await local.readHead(input.principal, scope);
      const pin = input.commandPolicy;
      if (
        head.state !== "active-read-only" ||
        head.revision !== pin.revision ||
        head.selectionId !== pin.selectionId ||
        head.selectionSha256 !== pin.selectionSha256
      )
        return false;
      const lookup = {
        ...scope,
        selectionId: pin.selectionId,
        selectionSha256: pin.selectionSha256,
      };
      const selection = await local.materialize(
        input.principal,
        lookup,
        options.consumerServiceId
      );
      if (
        selection.revision !== pin.selectionRevision ||
        ns(input.now) > ns(options.clock.now())
      )
        return false;
      const context = {
        ports,
        registry: local,
        principal: input.principal,
        lookup,
        consumerServiceId: options.consumerServiceId,
      };
      const binding =
        input.kind === "review"
          ? await buildVertexReviewPolicy(context)
          : input.kind === "research"
            ? await buildVertexResearchBinding(context)
            : await buildVertexSimulationBinding(context);
      return (
        binding.state === "ready" &&
        !!binding.binding &&
        (await currentAuthority(tx, selection, options.clock.now()))
      );
    } catch {
      return false;
    }
  };
  const guardedPin: VertexWorkerOptions["pinPolicySelection"] = async (
    tx,
    principal,
    lookup,
    consumerServiceId,
    holderId
  ) => {
    try {
      if (options.signal?.aborted) return fail();
      return await pinPolicySelection(
        tx,
        principal,
        lookup,
        consumerServiceId,
        holderId
      );
    } catch {
      return fail();
    }
  };
  return Object.freeze({
    registry,
    resolvePolicy,
    materializeForTransaction,
    policySelection,
    pinPolicySelection: guardedPin,
    commandPolicy,
    readSelectedArtifact: artifacts.readSelectedArtifact,
    readResearchChatCopyRetentionForTransaction,
    readResearchChatNativeCopyRetentionForTransaction,
  });
};

export type VertexRuntimePolicy = ReturnType<typeof createVertexRuntimePolicy>;
