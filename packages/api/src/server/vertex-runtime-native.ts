import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  VertexStoreError,
  type VertexClock,
  type VertexPrincipal,
  type VertexScope,
} from "@darkfactory/db/server/vertex";
import type { VertexWorkerOptions } from "@darkfactory/db/server/vertex-worker";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { IdentifierSchema, TimestampSchema } from "../contracts/vertex.ts";
import {
  WorkerEpochSchema,
  WorkerLeaseSchema,
  WorkerServiceGrantSchema,
} from "../contracts/vertex-worker.ts";
import { parseRuntimePolicySelection } from "../contracts/vertex-policy.ts";
import {
  NativeOutboxReplayGrantSchema,
  parsePortfolioEpochTransition,
  type NativeOutboxReplayGrant,
} from "../contracts/vertex-worker-epoch.ts";
import { canonicalRecord, decodeBase64 } from "./vertex-runtime-epoch-bytes.ts";
import { present } from "./present.ts";

// This is a SERVER configuration-reference value, never an RPC field. Its hash
// must be explicitly selected by the immutable policy's nonsecret reference.
export const VertexNativeEmitterBindingSchema = z
  .object({
    format: z.literal("vertex-native-emitter-binding-v1"),
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    referenceId: IdentifierSchema,
    servicePrincipalId: IdentifierSchema,
    actorId: IdentifierSchema,
    streamId: IdentifierSchema,
    ownerEpoch: WorkerEpochSchema,
    validFrom: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type VertexNativeEmitterBinding = z.infer<
  typeof VertexNativeEmitterBindingSchema
>;
export type VertexRuntimeNativeOptions = Readonly<{
  clock: VertexClock;
  signal?: AbortSignal;
  emitterBindings: readonly VertexNativeEmitterBinding[];
  policySelection: VertexWorkerOptions["policySelection"];
}>;
const unavailable = (): never => {
  throw new VertexStoreError("unavailable");
};
const denied = (): never => {
  throw new VertexStoreError("denied");
};
const ns = timestampToEpochNanoseconds;
const current = (start: string, end: string, now: string): boolean =>
  ns(start) <= ns(now) && ns(now) < ns(end);
const txAuthorization = (tx: Transaction, clock: VertexClock) => {
  // Only authorize() is exposed from this wrapper. No nested transaction, pool
  // creation, client release, grant issuance or bearer authentication occurs.
  return createVertexAuthorization(
    {
      execute: tx.execute.bind(tx),
      transaction: async (
        operation: (value: Transaction) => Promise<unknown>
      ) => operation(tx),
    } as unknown as Database,
    { clock }
  );
};

// Structural emitter-resolution precheck only. Historical bytes are never
// current authority: the replay verifier and State atomic audit/CAS remain
// mandatory before any projection or retained transition can be persisted.
export const vertexRuntimeReplayHeadCandidate = async (
  head: Readonly<Record<string, unknown>> | undefined,
  replay: NativeOutboxReplayGrant,
  command: Readonly<Record<string, unknown>>
): Promise<boolean> => {
  try {
    if (
      canonicalArtifactJson(command["grant"]) !== canonicalArtifactJson(replay)
    )
      return false;
    if (replay.retainedEpochTransitionSha256 === null) {
      return (
        command["retainedEpochTransitionBase64"] === null &&
        ((!head && replay.startingSequence === "0") ||
          (!!head && head["owner_epoch"] === replay.priorOwnerEpoch))
      );
    }
    if (!head || replay.startingSequence !== "0") return false;
    const bytes = decodeBase64(command["retainedEpochTransitionBase64"]);
    if ((await hashArtifact(bytes)) !== replay.retainedEpochTransitionSha256)
      return false;
    const transition = await parsePortfolioEpochTransition(
      canonicalRecord(bytes)
    );
    if (
      transition.snapshot.accountAlias !== replay.accountAlias ||
      transition.snapshot.environment !== replay.environment ||
      transition.snapshot.streamId !== replay.streamId ||
      transition.snapshot.ownerEpoch !== replay.priorOwnerEpoch ||
      transition.journalIdentity !== replay.journalIdentity
    )
      return false;
    const first = Array.isArray(command["rows"]) ? command["rows"][0] : null;
    if (first?.kind !== "portfolio-genesis") return false;
    const snapshotBytes = decodeBase64(first.projectionBase64);
    const snapshotText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(snapshotBytes);
    if (
      snapshotText !== canonicalArtifactJson(transition.snapshot) ||
      (await hashArtifact(snapshotBytes)) !==
        replay.rows[0]?.projectionRawSha256
    )
      return false;
    if (
      replay.rows[0]?.projectionId !== transition.snapshot.snapshotId ||
      replay.rows[0]?.eventHash !== transition.snapshot.sourceEventHash ||
      replay.rows[0]?.sequence !== "1"
    )
      return false;
    // A retained exact retry may already be at the old epoch. State verifies
    // existing immutable transition/rows rather than rolling its head back.
    if (head["owner_epoch"] === replay.priorOwnerEpoch) return true;
    return (
      head["owner_epoch"] === transition.priorOwnerEpoch &&
      head["high_water_sequence"] === transition.priorProjectionSequence &&
      head["high_water_event_hash"] === transition.priorProjectionHash
    );
  } catch {
    return false;
  }
};

export const createVertexRuntimeNativeProjectionPrincipal = (
  options: VertexRuntimeNativeOptions
): VertexWorkerOptions["nativeProjectionPrincipal"] => {
  // Snapshot ordinary data only. No database or object call during composition.
  const bindings = options.emitterBindings.map((value) =>
    Object.freeze(
      VertexNativeEmitterBindingSchema.parse(structuredClone(value))
    )
  );
  if (bindings.length > 256)
    throw new TypeError("Invalid Vertex runtime configuration");
  return async (
    tx,
    identity,
    rawLease,
    operation,
    projection
  ): Promise<VertexPrincipal> => {
    try {
      if (options.signal?.aborted) return unavailable();
      if (
        ![
          "publishGenesis",
          "publishPortfolioSnapshot",
          "publishEpochTransition",
          "publishOrderProjection",
          "publishNativeFacts",
          "replayNativeOutbox",
        ].includes(operation)
      )
        return denied();
      const lease = WorkerLeaseSchema.parse(rawLease);
      const scope: VertexScope = {
        accountAlias: lease.accountAlias,
        environment: lease.environment,
      };
      const at = TimestampSchema.parse(options.clock.now());
      if (
        scope.environment !== "paper" ||
        identity.scope.accountAlias !== scope.accountAlias ||
        identity.scope.environment !== scope.environment ||
        !["native-bootstrap", "paper-simulation"].includes(lease.kind) ||
        ns(lease.leaseExpiresAt) <= ns(at) ||
        ns(lease.deadlineAt) <= ns(at)
      )
        return denied();
      // Replay alone receives the full already-validated command in the existing
      // projection slot. Parse its grant, not the complete 8MiB row batch again.
      const replay =
        operation === "replayNativeOutbox"
          ? NativeOutboxReplayGrantSchema.parse(projection["grant"])
          : null;
      if (replay && lease.kind !== "native-bootstrap") return denied();
      const subject = replay ?? projection;
      const streamId = IdentifierSchema.parse(subject.streamId);
      const ownerEpoch = WorkerEpochSchema.parse(
        replay ? replay.currentOwnerEpoch : projection["ownerEpoch"]
      );
      if (
        subject.accountAlias !== scope.accountAlias ||
        subject.environment !== scope.environment
      )
        return denied();
      const candidates = bindings.filter(
        (value) =>
          value.accountAlias === scope.accountAlias &&
          value.servicePrincipalId === identity.servicePrincipalId &&
          value.streamId === streamId &&
          value.ownerEpoch === ownerEpoch
      );
      if (candidates.length !== 1) return unavailable();
      const binding = present(candidates[0]);
      if (!current(binding.validFrom, binding.expiresAt, at)) return denied();
      const jobs = (
        await tx.execute(
          sql`select payload, state, grant_id, worker_instance_id, lease_epoch, lease_id from vertex_worker_jobs where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and job_id = ${lease.jobId} limit 1`
        )
      ).rows as Record<string, unknown>[];
      const job = jobs[0];
      if (
        job?.["state"] !== "running" ||
        job["grant_id"] !== identity.grantId ||
        job["worker_instance_id"] !== lease.leaseId ||
        job["lease_id"] !== lease.leaseId ||
        job["lease_epoch"] !== lease.leaseEpoch ||
        canonicalArtifactJson(job["payload"]) !== canonicalArtifactJson(lease)
      )
        return denied();
      const grants = (
        await tx.execute(
          sql`select payload, record_hash, revoked_at from vertex_worker_service_grants where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and grant_id = ${identity.grantId} limit 1`
        )
      ).rows as Record<string, unknown>[];
      const grantRow = grants[0];
      if (!grantRow || grantRow["revoked_at"] !== null) return denied();
      const grant = WorkerServiceGrantSchema.parse(grantRow["payload"]);
      if (
        (await hashArtifact(grant)) !== grantRow["record_hash"] ||
        grant.revokedAt !== null ||
        grant.servicePrincipalId !== identity.servicePrincipalId ||
        grant.accountAlias !== scope.accountAlias ||
        grant.environment !== scope.environment ||
        !grant.operations.some((value) => value === operation) ||
        !current(grant.issuedAt, grant.expiresAt, at)
      )
        return denied();
      const selection = await parseRuntimePolicySelection(
        await options.policySelection(
          tx,
          { actorId: lease.researchPrincipalId },
          {
            ...scope,
            selectionId: lease.policySelectionId,
            selectionSha256: lease.policySelectionSha256,
          },
          identity.servicePrincipalId,
          lease.jobId
        )
      );
      const reference = selection.references.find(
        (value) => value.referenceId === binding.referenceId
      );
      if (
        reference?.kind !== "nonsecret-reference" ||
        reference.ownerService !== identity.servicePrincipalId ||
        reference.referenceSha256 !== (await hashArtifact(binding)) ||
        reference.accountAlias !== scope.accountAlias ||
        reference.environment !== scope.environment ||
        reference.exposure !== "server-only" ||
        !reference.permissions.includes("native-project") ||
        ns(reference.expiresAt) <= ns(at)
      )
        return denied();
      const heads = (
        await tx.execute(
          sql`select owner_epoch, high_water_sequence, high_water_event_hash from vertex_projection_heads where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and stream_id = ${streamId} limit 1`
        )
      ).rows as Record<string, unknown>[];
      const head = heads[0];
      // Epoch transition verification owns the exact old-head CAS, restored
      // snapshot and independently signed approval. This only resolves emitter.
      if (replay) {
        // Only an exact retained predecessor may reach the current verifier.
        // This does not assert signature authority or pretend owner3 is owner2.
        if (!(await vertexRuntimeReplayHeadCandidate(head, replay, projection)))
          return denied();
      } else if (operation === "publishGenesis") {
        if (head && head["owner_epoch"] !== ownerEpoch) return denied();
      } else if (operation === "publishEpochTransition") {
        // The transition store independently authenticates an exact duplicate.
        if (!head || BigInt(String(head["owner_epoch"])) > BigInt(ownerEpoch))
          return denied();
      } else if (!head || head["owner_epoch"] !== ownerEpoch) return denied();
      const principal = Object.freeze({ actorId: binding.actorId });
      if (replay && replay.serviceActorId !== principal.actorId)
        return denied();
      if (
        !replay &&
        projection["actorId"] !== undefined &&
        projection["actorId"] !== principal.actorId
      )
        return denied();
      const authorization = txAuthorization(tx, options.clock);
      // A research user or a valid service token has no implied native identity.
      // The separately enrolled emitter needs its own current exact grant.
      const allowed = await authorization.authorize({
        principal,
        scope,
        collectionId: null,
        resourceId: streamId,
        action: "project",
        now: options.clock.now(),
      });
      const completedAt = options.clock.now();
      if (
        allowed !== true ||
        options.signal?.aborted ||
        !current(binding.validFrom, binding.expiresAt, completedAt) ||
        !current(selection.issuedAt, selection.expiresAt, completedAt) ||
        ns(reference.expiresAt) <= ns(completedAt) ||
        ns(grant.expiresAt) <= ns(completedAt) ||
        ns(lease.leaseExpiresAt) <= ns(completedAt)
      )
        return denied();
      return principal;
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      return unavailable();
    }
  };
};
