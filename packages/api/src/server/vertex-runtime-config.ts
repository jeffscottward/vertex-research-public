import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import type { VertexClock } from "@darkfactory/db/server/vertex";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { IdentifierSchema, TimestampSchema } from "../contracts/vertex.ts";
import type { ApiContextDependencies } from "./context.ts";
import type { VertexPlatformRequestOptions } from "./vertex-runtime.ts";
import { parseVertexRuntimeConfiguration } from "./vertex-runtime-config-schema.ts";
import {
  buildVertexRuntimeConfiguredNotifications,
  type VertexRuntimeWorkerBindings,
  type VertexRuntimeServerContext,
} from "./vertex-runtime-config-notifications.ts";

export type VertexRuntimeConfiguredGroups = Pick<
  VertexPlatformRequestOptions<VertexRuntimeServerContext>,
  "policy" | "worker" | "modelUse" | "nativeEpoch" | "notifications" | "gateway"
>;
type PolicyPrivilege = Parameters<
  NonNullable<
    NonNullable<
      VertexRuntimeConfiguredGroups["policy"]
    >["privilegedAuthorization"]
  >["authorize"]
>[0];
type ModelPrivilege = Parameters<
  NonNullable<
    VertexRuntimeConfiguredGroups["modelUse"]
  >["privilegedAuthorization"]["authorize"]
>[0];
type WorkerAdministration = NonNullable<
  VertexRuntimeConfiguredGroups["worker"]
>["authorizeGrantAdministration"];
export type VertexRuntimeConfigurationInput = Readonly<{
  configuration: unknown;
  // Enumerated Worker references, NOT env, process.env, OMP config or a resolver.
  bindings: VertexRuntimeWorkerBindings;
  db: Database;
  requireSession: ApiContextDependencies["requireSession"];
  requestHeaders: Headers;
  signal?: AbortSignal;
  clock?: VertexClock;
  fetcher?: NotificationFetch;
}>;
export type VertexRuntimeConfigurationResult = Readonly<{
  status: "enabled" | "disabled";
  options: VertexRuntimeConfiguredGroups;
}>;
const disabled: VertexRuntimeConfigurationResult = Object.freeze({
  status: "disabled",
  options: Object.freeze({}),
});
const sameScope = (
  left: { accountAlias: string; environment: string },
  right: { accountAlias: string; environment: string }
): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
const current = (
  value: { validFrom: string; expiresAt: string },
  now: string
): boolean =>
  timestampToEpochNanoseconds(value.validFrom) <=
    timestampToEpochNanoseconds(now) &&
  timestampToEpochNanoseconds(now) <
    timestampToEpochNanoseconds(value.expiresAt);

// All trust enters through the existing server AuthAdapter.requireSession.
// Ignore every callback context/RPC actor object. Re-authenticate the captured
// request headers on EVERY security decision; never cache an authority result.
const sessionPrincipal = (
  input: VertexRuntimeConfigurationInput,
  clock: VertexClock
): (() => Promise<SafePrincipal | null>) => {
  const requestHeaders = new Headers(input.requestHeaders);
  const requireSession = input.requireSession;
  const signal = input.signal;
  return async () => {
    try {
      if (signal?.aborted) return null;
      const session = await requireSession(new Headers(requestHeaders));
      const principal = session.principal;
      if (
        signal?.aborted ||
        principal.status !== "active" ||
        session.user.status !== "active" ||
        session.user.id !== principal.userId ||
        session.session.userId !== principal.userId ||
        !IdentifierSchema.safeParse(principal.userId).success
      )
        return null;
      const expires = session.session.expiresAt.getTime();
      if (
        !Number.isSafeInteger(expires) ||
        BigInt(expires) * 1_000_000n <=
          timestampToEpochNanoseconds(TimestampSchema.parse(clock.now()))
      )
        return null;
      return Object.freeze({
        userId: principal.userId,
        role: principal.role,
        status: principal.status,
      });
    } catch {
      return null;
    }
  };
};

// Inert, request-local composition. No session, database, storage, clock, crypto
// verification, enrollment, grant activation, provider fetch or send occurs here.
// Existing policy/model/native adapters validate the CURRENT persisted evidence
// when used; JSON supplies pins, never a replacement readiness/authority fact.
export const createVertexRuntimeConfiguredOptions = (
  input: VertexRuntimeConfigurationInput
): VertexRuntimeConfigurationResult => {
  const configuration = parseVertexRuntimeConfiguration(input.configuration);
  if (!configuration) return disabled;
  try {
    const clock: VertexClock = input.clock ?? {
      now: () => new Date().toISOString(),
    };
    const serverPrincipal = sessionPrincipal(input, clock);
    const policy = configuration.policy;
    const worker = configuration.worker;
    const modelUse = configuration.modelUse;
    const options: VertexRuntimeConfiguredGroups = {
      ...(policy
        ? {
            policy: {
              consumerServiceId: policy.consumerServiceId,
              components: policy.components,
              jobModules: policy.jobModules,
              privilegedAuthorization: {
                authorize: async (request: PolicyPrivilege) => {
                  try {
                    const principal = await serverPrincipal();
                    if (
                      !principal ||
                      principal.userId !== request.principal.actorId ||
                      input.signal?.aborted
                    )
                      return false;
                    const now = TimestampSchema.parse(clock.now());
                    return policy.administration.some(
                      (entry) =>
                        entry.actorId === principal.userId &&
                        sameScope(entry, request.scope) &&
                        entry.operation === request.operation &&
                        entry.selectionId === request.selectionId &&
                        entry.selectionSha256 === request.selectionSha256 &&
                        entry.expectedRevision === request.expectedRevision &&
                        entry.commandId === request.commandId &&
                        entry.requestSha256 === request.requestSha256 &&
                        current(entry, now)
                    );
                  } catch {
                    return false;
                  }
                },
              },
            },
          }
        : {}),
      ...(worker
        ? {
            worker: {
              routes: worker.routes,
              emitterBindings: worker.emitterBindings,
              serverPrincipal: async (_context: unknown) => serverPrincipal(),
              authorizeGrantAdministration: async (
                _context: unknown,
                action: Parameters<WorkerAdministration>[1],
                scope: Parameters<WorkerAdministration>[2],
                grantId: string,
                details: Parameters<WorkerAdministration>[4]
              ) => {
                try {
                  const principal = await serverPrincipal();
                  if (!(principal && details) || input.signal?.aborted)
                    return false;
                  const now = TimestampSchema.parse(clock.now());
                  // The store supplies canonical proposed/current grant hashes under
                  // its existing scope transaction lock. A commitment binds the exact
                  // grant AND credential verifier without exposing either in config.
                  return worker.administration.some(
                    (entry) =>
                      entry.actorId === principal.userId &&
                      sameScope(entry, scope) &&
                      entry.action === action &&
                      entry.grantId === grantId &&
                      entry.recordSha256 === details.recordSha256 &&
                      entry.previousRecordSha256 ===
                        details.previousRecordSha256 &&
                      entry.authorizationSha256 ===
                        details.authorizationSha256 &&
                      current(entry, now)
                  );
                } catch {
                  return false;
                }
              },
            },
          }
        : {}),
      ...(modelUse
        ? {
            modelUse: {
              requestEvidence: modelUse.requestEvidence,
              privilegedAuthorization: {
                authorize: async (request: ModelPrivilege) => {
                  try {
                    if (input.signal?.aborted) return false;
                    const grantSha256 = await hashArtifact(request.grant);
                    const principal = await serverPrincipal();
                    if (
                      !principal ||
                      principal.userId !== request.principal.actorId ||
                      input.signal?.aborted
                    )
                      return false;
                    const now = TimestampSchema.parse(clock.now());
                    return modelUse.administration.some(
                      (entry) =>
                        entry.actorId === principal.userId &&
                        sameScope(entry, request.grant) &&
                        entry.operation === request.operation &&
                        entry.grantId === request.grant.grantId &&
                        entry.grantVersion === request.grant.grantVersion &&
                        entry.grantSha256 === grantSha256 &&
                        entry.expectedRevision === request.expectedRevision &&
                        entry.commandId === request.commandId &&
                        entry.requestSha256 === request.requestSha256 &&
                        current(entry, now)
                    );
                  } catch {
                    return false;
                  }
                },
              },
            },
          }
        : {}),
      ...(configuration.nativeEpoch
        ? { nativeEpoch: configuration.nativeEpoch }
        : {}),
      ...(configuration.gateway ? { gateway: configuration.gateway } : {}),
      ...(configuration.notifications
        ? {
            notifications: buildVertexRuntimeConfiguredNotifications({
              configuration: configuration.notifications,
              bindings: input.bindings,
              db: input.db,
              serverPrincipal,
              clock,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(input.fetcher === undefined
                ? {}
                : { fetcher: input.fetcher }),
            }),
          }
        : {}),
    };
    return Object.freeze({
      status: "enabled",
      options: Object.freeze(options),
    });
  } catch {
    // One bad group disables the entire snapshot. Do not silently activate the
    // remaining groups or expose configuration/secret-derived parse diagnostics.
    return disabled;
  }
};
