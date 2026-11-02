import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  type VertexClock,
  type VertexPrincipal,
} from "@darkfactory/db/server/vertex";
import type { VertexWorkerOptions } from "@darkfactory/db/server/vertex-worker";
import type {
  PolicySelection,
  SelectionLookup,
} from "@darkfactory/config/vertex";
import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { WorkerBootstrapCommandSchema } from "../contracts/vertex-worker.ts";
import { vertexActor } from "./vertex-experience-core.ts";
import { vertexPolicyTransactionDatabase } from "./vertex-runtime-policy-artifacts.ts";
import { IdentifierSchema } from "../contracts/vertex.ts";

export const vertexNativeBootstrapPermissionResource = async (
  journalIdentity: string
): Promise<string> => {
  return `native-bootstrap:${await hashArtifact({ journalIdentity: IdentifierSchema.parse(journalIdentity) })}`;
};

export type VertexRuntimeBootstrapOptions = Readonly<{
  clock: VertexClock;
  signal?: AbortSignal;
  consumerServiceId: string;
  // This adapter receives the server's session context, never a worker token or
  // RPC actorId. The application retains ownership of session authentication.
  serverPrincipal: (context: unknown) => Promise<SafePrincipal | null>;
  materialize: (
    tx: Transaction,
    principal: VertexPrincipal,
    lookup: SelectionLookup,
    consumerServiceId: string
  ) => Promise<PolicySelection>;
}>;
export const createVertexRuntimeBootstrapAuthorization = (
  options: VertexRuntimeBootstrapOptions
): Pick<
  VertexWorkerOptions,
  "authorizeBootstrapEnqueue" | "authorizeNativeBootstrap"
> => {
  const authorizeNativeBootstrap: VertexWorkerOptions["authorizeNativeBootstrap"] =
    async (tx, principal, scope, raw) => {
      try {
        if (options.signal?.aborted || scope.environment !== "paper")
          return false;
        const command = WorkerBootstrapCommandSchema.parse(raw);
        const at = options.clock.now();
        if (
          command.researchPrincipalId !== principal.actorId ||
          command.accountAlias !== scope.accountAlias ||
          command.environment !== scope.environment ||
          timestampToEpochNanoseconds(command.issuedAt) >
            timestampToEpochNanoseconds(at) ||
          timestampToEpochNanoseconds(command.deadlineAt) <=
            timestampToEpochNanoseconds(at)
        )
          return false;
        const authorization = createVertexAuthorization(
          vertexPolicyTransactionDatabase(tx),
          { clock: options.clock }
        );
        const resourceId = await vertexNativeBootstrapPermissionResource(
          command.payload.journalIdentity
        );
        // Dedicated resource grant, not the worker service bearer, review approval,
        // account-read grant, policy-read grant or capital approval. No wildcard.
        if (
          !(await authorization.authorize({
            principal,
            scope,
            collectionId: null,
            resourceId,
            action: "publish",
            now: at,
          }))
        )
          return false;
        const selection = await options.materialize(
          tx,
          principal,
          {
            accountAlias: scope.accountAlias,
            environment: "paper",
            selectionId: command.policySelectionId,
            selectionSha256: command.policySelectionSha256,
          },
          options.consumerServiceId
        );
        const rights = selection.policies.find(
          (pin) => pin.role === "licensing-rights"
        );
        if (
          !selection.simulation ||
          selection.simulation.simulatorId !== command.payload.simulatorId ||
          !rights ||
          rights.policyId !== command.rightsPolicyId ||
          rights.version !== command.rightsVersion
        )
          return false;
        return (
          !options.signal?.aborted &&
          timestampToEpochNanoseconds(command.deadlineAt) >
            timestampToEpochNanoseconds(options.clock.now()) &&
          (await authorization.authorize({
            principal,
            scope,
            collectionId: null,
            resourceId,
            action: "publish",
            now: options.clock.now(),
          }))
        );
      } catch {
        return false;
      }
    };
  return Object.freeze({
    authorizeNativeBootstrap,
    authorizeBootstrapEnqueue: async (context, tx, scope, command) => {
      try {
        if (options.signal?.aborted) return false;
        const principal = await options.serverPrincipal(context);
        if (!principal) return false;
        const actor = vertexActor(principal);
        if (actor.actorId !== command["researchPrincipalId"]) return false;
        return authorizeNativeBootstrap(tx, actor, scope, command);
      } catch {
        return false;
      }
    },
  });
};
