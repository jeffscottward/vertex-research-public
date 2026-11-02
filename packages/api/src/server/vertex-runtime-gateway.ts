import type { Database } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  withTransactionReadScope,
  VertexStoreError,
  type VertexClock,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  BrokerRecoveryStatusSchema,
  EventEnvelopeSchema,
  IdentifierSchema,
} from "../contracts/vertex.ts";
import type { VertexExperienceDependencies } from "./vertex-experience-core.ts";
import type { VertexRuntimePolicy } from "./vertex-runtime-policy.ts";
import { vertexPolicyTransactionDatabase } from "./vertex-runtime-policy-artifacts.ts";
import { present } from "./present.ts";

export type VertexRuntimeGatewayBinding = Readonly<{
  accountAlias: string;
  environment: "paper";
  gatewayId: string;
  observationBindingId: string;
  producerActorId: string;
  maximumAgeMilliseconds: number;
}>;
export type VertexRuntimeGatewayOptions = Readonly<{
  db: Database;
  policy: VertexRuntimePolicy;
  consumerServiceId: string;
  clock: VertexClock;
  bindings: readonly VertexRuntimeGatewayBinding[];
  signal?: AbortSignal;
}>;
const unavailable = (): never => {
  throw new VertexStoreError("unavailable");
};

// Observes a recorded status only. No network handshake, recovery, credential
// probe, broker transport or trading command is reachable from this adapter.
export const createVertexRuntimeGateway = (
  options: VertexRuntimeGatewayOptions
): NonNullable<VertexExperienceDependencies["gateway"]> => {
  const bindings = options.bindings.map((raw) => {
    const binding = Object.freeze(structuredClone(raw));
    for (const value of [
      binding.accountAlias,
      binding.gatewayId,
      binding.observationBindingId,
      binding.producerActorId,
    ])
      IdentifierSchema.parse(value);
    if (
      binding.environment !== "paper" ||
      !Number.isSafeInteger(binding.maximumAgeMilliseconds) ||
      binding.maximumAgeMilliseconds < 1 ||
      binding.maximumAgeMilliseconds > 300_000
    )
      throw new TypeError("Invalid Vertex runtime configuration");
    return binding;
  });
  if (bindings.length > 128)
    throw new TypeError("Invalid Vertex runtime configuration");
  const select = (gatewayId: string, environment: "paper" | "live") => {
    const found = bindings.filter(
      (entry) =>
        entry.gatewayId === gatewayId && entry.environment === environment
    );
    return found.length === 1 ? present(found[0]) : null;
  };
  return Object.freeze({
    // Ambiguous bindings stay hidden here, as resolveScope refuses them.
    listBindings: () =>
      Promise.resolve(
        bindings
          .filter(
            (binding) =>
              select(binding.gatewayId, binding.environment) === binding
          )
          .map((binding) =>
            Object.freeze({
              gatewayId: binding.gatewayId,
              environment: binding.environment,
              accountAlias: binding.accountAlias,
            })
          )
      ),
    // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
    resolveScope: async (gatewayId, environment) => {
      const selected = select(gatewayId, environment);
      return selected
        ? Object.freeze({
            accountAlias: selected.accountAlias,
            environment: selected.environment,
          })
        : null;
    },
    readStatus: async (principal, gatewayId, environment, signal) => {
      try {
        if (signal?.aborted || options.signal?.aborted) return unavailable();
        const binding = select(gatewayId, environment);
        if (!binding) return unavailable();
        const scope = {
          accountAlias: binding.accountAlias,
          environment: binding.environment,
        };
        const head = await options.policy.registry.readHead(principal, scope);
        if (
          head.state !== "active-read-only" ||
          !head.selectionId ||
          !head.selectionSha256
        )
          return unavailable();
        const lookup = {
          ...scope,
          selectionId: head.selectionId,
          selectionSha256: head.selectionSha256,
        };
        return options.db.transaction(
          withTransactionReadScope(async (tx) => {
            const selection = await options.policy.materializeForTransaction(
              tx,
              principal,
              lookup,
              options.consumerServiceId
            );
            const pin = selection.artifacts.find(
              (entry) =>
                entry.bindingId === binding.observationBindingId &&
                entry.role === "broker-observation"
            );
            if (pin?.artifact.contractName !== "EventEnvelope")
              return unavailable();
            const bytes = await options.policy.readSelectedArtifact(
              tx,
              principal,
              scope,
              pin.artifact
            );
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes
            );
            const event = EventEnvelopeSchema.parse(JSON.parse(decoded));
            if (
              canonicalArtifactJson(event) !== decoded ||
              event.eventType !== "broker-status.observed" ||
              event.environment !== environment ||
              event.actorId !== binding.producerActorId
            )
              return unavailable();
            const status = BrokerRecoveryStatusSchema.parse(event.payload);
            const now = timestampToEpochNanoseconds(options.clock.now());
            const observed = timestampToEpochNanoseconds(status.observedAt);
            if (
              status.gatewayId !== gatewayId ||
              status.environment !== environment ||
              observed > now ||
              now - observed >
                BigInt(binding.maximumAgeMilliseconds) * 1_000_000n ||
              timestampToEpochNanoseconds(event.receivedAt) > now ||
              timestampToEpochNanoseconds(event.occurredAt) < observed
            )
              return unavailable();
            const authorization = createVertexAuthorization(
              vertexPolicyTransactionDatabase(tx),
              { clock: options.clock }
            );
            if (
              !(await authorization.authorize({
                principal,
                scope,
                collectionId: null,
                resourceId: gatewayId,
                action: "read",
                now: options.clock.now(),
              }))
            )
              return unavailable();
            if (
              !(await authorization.authorize({
                principal: { actorId: binding.producerActorId },
                scope,
                collectionId: null,
                resourceId: gatewayId,
                action: "publish",
                now: options.clock.now(),
              }))
            )
              return unavailable();
            await options.policy.materializeForTransaction(
              tx,
              principal,
              lookup,
              options.consumerServiceId
            );
            if (
              signal?.aborted ||
              options.signal?.aborted ||
              timestampToEpochNanoseconds(options.clock.now()) - observed >
                BigInt(binding.maximumAgeMilliseconds) * 1_000_000n
            )
              return unavailable();
            return status;
          })
        );
      } catch {
        return unavailable();
      }
    },
  });
};
