import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import type { VertexClock } from "@darkfactory/db/server/vertex";
import type { WorkerServiceIdentity } from "@darkfactory/db/server/vertex-worker";
import type {
  EmailNotificationConfiguration,
  NotificationFetch,
} from "@darkfactory/notifications/server";
import {
  notificationBinding,
  notificationFields,
  type NotificationConfigurationRegistration,
  type NotificationRecipientBinding,
} from "@darkfactory/notifications/server/dispatch";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
  type DeepReadonly,
} from "@darkfactory/shared/vertex";
import { sql } from "drizzle-orm";
import { WorkerServiceGrantSchema } from "../contracts/vertex-worker.ts";
import type { VertexPlatformRequestOptions } from "./vertex-runtime.ts";
import {
  VertexRuntimeNotificationsConfigurationSchema,
  type VertexRuntimeNotificationsConfiguration,
} from "./vertex-runtime-config-notifications-schema.ts";
import { present } from "./present.ts";

export type VertexRuntimeWorkerBindings = Readonly<{
  VERTEX_NOTIFICATION_PHONE_DESTINATION?: unknown;
  VERTEX_NOTIFICATION_PHONE_TOKEN?: unknown;
  VERTEX_NOTIFICATION_EMAIL_DESTINATION?: unknown;
  VERTEX_NOTIFICATION_EMAIL_PORT?: EmailNotificationConfiguration["port"];
}>;
// A public shape is not proof. Only objects present in this factory's private
// WeakMap can authenticate; these objects contain no identity or credential.
export type VertexRuntimeServerContext = Readonly<{
  kind: "session" | "worker";
}>;
export type VertexRuntimeConfiguredNotificationsOptions = Readonly<{
  configuration: DeepReadonly<VertexRuntimeNotificationsConfiguration>;
  bindings: VertexRuntimeWorkerBindings;
  db: Database;
  serverPrincipal: () => Promise<SafePrincipal | null>;
  clock: VertexClock;
  signal?: AbortSignal;
  fetcher?: NotificationFetch | undefined;
}>;
type Built = NonNullable<
  VertexPlatformRequestOptions<VertexRuntimeServerContext>["notifications"]
>;
type Principal =
  VertexRuntimeNotificationsConfiguration["permissions"][number]["principal"];
type State = Readonly<{
  principal: Principal;
  session: SafePrincipal | null;
  identity: WorkerServiceIdentity | null;
  leaseExpiresAt: string | null;
}>;
type EmailPort = EmailNotificationConfiguration["port"];
const invalid = (): never => {
  throw new TypeError("Invalid Vertex notification configuration");
};
const same = (a: unknown, b: unknown): boolean =>
  canonicalArtifactJson(a) === canonicalArtifactJson(b);
const sameBinding = (
  a: NotificationRecipientBinding,
  b: NotificationRecipientBinding
): boolean => same(notificationBinding(a), notificationBinding(b));
const scopeMatches = (
  a: Readonly<{ accountAlias: string; environment: string }>,
  b: Readonly<{ accountAlias: string; environment: string }>
): boolean =>
  a.accountAlias === b.accountAlias && a.environment === b.environment;
const safeOrigin = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password
    )
      return invalid();
    return value;
  } catch {
    return invalid();
  }
};
const bindingValue = (
  bindings: VertexRuntimeWorkerBindings,
  key: keyof VertexRuntimeWorkerBindings
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(bindings, key);
  if (!(descriptor?.enumerable && "value" in descriptor)) return invalid();
  return descriptor.value;
};
const bindingText = (
  bindings: VertexRuntimeWorkerBindings,
  key: keyof VertexRuntimeWorkerBindings,
  pattern: RegExp
): string => {
  const value = bindingValue(bindings, key);
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
};
const sessionSnapshot = (value: SafePrincipal | null): SafePrincipal | null => {
  if (value?.status !== "active" || typeof value.userId !== "string")
    return null;
  return Object.freeze({
    userId: value.userId,
    role: value.role,
    status: value.status,
  });
};

export const buildVertexRuntimeConfiguredNotifications = (
  options: VertexRuntimeConfiguredNotificationsOptions
): Built => {
  let config: DeepReadonly<VertexRuntimeNotificationsConfiguration>;
  try {
    // Canonical capture rejects prototypes/accessors before validation and keeps
    // later mutation of caller-owned JSON from changing authority.
    canonicalArtifactJson(options.configuration);
    config = deepFreezeArtifact(
      VertexRuntimeNotificationsConfigurationSchema.parse(options.configuration)
    );
  } catch {
    return invalid();
  }
  const states = new WeakMap<VertexRuntimeServerContext, State>();
  const writers = new Set<VertexRuntimeServerContext>();
  const now = (): bigint => timestampToEpochNanoseconds(options.clock.now());
  const milliseconds = (): number => Number(now() / 1_000_000n);
  const live = (): boolean => !options.signal?.aborted;
  const freshSession = async (): Promise<SafePrincipal | null> => {
    if (!live()) return null;
    try {
      const principal = sessionSnapshot(await options.serverPrincipal());
      return live() ? principal : null;
    } catch {
      return null;
    }
  };
  const workerCurrent = async (state: State): Promise<boolean> => {
    const identity = state.identity;
    const principal = state.principal;
    if (
      !(live() && identity) ||
      principal.kind !== "worker" ||
      !state.leaseExpiresAt
    )
      return false;
    try {
      const allowed = config.workers.find(
        (entry) =>
          entry.actorId === principal.actorId &&
          entry.tenantKey === principal.tenantKey &&
          entry.grantId === principal.grantId &&
          scopeMatches(entry, principal)
      );
      if (
        !allowed ||
        identity.grantId !== principal.grantId ||
        identity.servicePrincipalId !== principal.actorId ||
        !scopeMatches(identity.scope, principal)
      )
        return false;
      const rows = (
        await options.db.execute(
          sql`select grant_id, service_principal_id, account_alias, environment, issued_at_ns, expires_at_ns, revoked_at, record_hash, payload from vertex_worker_service_grants where account_alias = ${principal.accountAlias} and environment = ${principal.environment} and grant_id = ${principal.grantId} limit 2`
        )
      ).rows as Record<string, unknown>[];
      if (rows.length !== 1) return false;
      const row = present(rows[0]);
      const grant = WorkerServiceGrantSchema.parse(row["payload"]);
      const hash = await hashArtifact(grant);
      const at = now();
      return (
        live() &&
        row["record_hash"] === hash &&
        hash === allowed.grantSha256 &&
        row["grant_id"] === grant.grantId &&
        grant.grantId === identity.grantId &&
        row["service_principal_id"] === grant.servicePrincipalId &&
        grant.servicePrincipalId === identity.servicePrincipalId &&
        row["account_alias"] === grant.accountAlias &&
        row["environment"] === grant.environment &&
        scopeMatches(grant, identity.scope) &&
        row["revoked_at"] === null &&
        grant.revokedAt === null &&
        grant.operations.includes("claim") &&
        String(row["issued_at_ns"]) ===
          timestampToEpochNanoseconds(grant.issuedAt).toString() &&
        String(row["expires_at_ns"]) ===
          timestampToEpochNanoseconds(grant.expiresAt).toString() &&
        grant.expiresAt === identity.expiresAt &&
        timestampToEpochNanoseconds(grant.issuedAt) <= at &&
        at < timestampToEpochNanoseconds(grant.expiresAt) &&
        at < timestampToEpochNanoseconds(state.leaseExpiresAt)
      );
    } catch {
      return false;
    }
  };
  const current = async (
    context: VertexRuntimeServerContext
  ): Promise<State | null> => {
    if (!live()) return null;
    const state = states.get(context);
    if (!state) return null;
    if (state.principal.kind === "worker")
      return (await workerCurrent(state)) ? state : null;
    const session = await freshSession();
    return session &&
      state.session &&
      same(session, state.session) &&
      session.userId === state.principal.actorId
      ? state
      : null;
  };
  const principalMatches = (state: State, principal: Principal): boolean =>
    same(state.principal, principal);
  const canResolve = (
    state: State,
    binding: NotificationRecipientBinding
  ): boolean =>
    config.permissions.some(
      (entry) =>
        principalMatches(state, entry.principal) &&
        sameBinding(entry.binding, binding) &&
        entry.operations.includes("resolve")
    );
  const mint = (state: State): VertexRuntimeServerContext => {
    if (writers.size >= 256) return invalid();
    const context = Object.freeze({ kind: state.principal.kind });
    states.set(context, state);
    writers.add(context);
    return context;
  };

  // Only referenced finite Worker bindings are captured; no ambient process/env
  // traversal, OMP configuration, secret serialization or eager provider calls.
  const destinations = new Map<string, string>();
  const credentials = new Map<string, string>();
  const emailPorts = new Map<string, EmailPort>();
  const registrations: NotificationConfigurationRegistration[] = [];
  const allowedNtfyOrigins = (
    config.configuration?.allowedNtfyOrigins ?? []
  ).map(safeOrigin);
  for (const entry of config.configuration?.registrations ?? []) {
    if (entry.provider === "ntfy") {
      const origin = safeOrigin(entry.origin);
      if (!allowedNtfyOrigins.includes(origin)) return invalid();
      destinations.set(
        entry.binding.destinationRef,
        bindingText(
          options.bindings,
          entry.destinationBinding,
          /^[A-Za-z0-9_-]{1,128}$/
        )
      );
      if (entry.credentialBinding)
        credentials.set(
          entry.configurationRef,
          bindingText(
            options.bindings,
            entry.credentialBinding,
            /^[A-Za-z0-9._~-]{1,2048}$/
          )
        );
      registrations.push(
        Object.freeze({
          ...entry.binding,
          configurationRef: entry.configurationRef,
          enabled: entry.enabled,
          expiresAt: entry.expiresAt,
          provider: "ntfy",
          origin,
          credentialRef: entry.credentialBinding
            ? entry.configurationRef
            : null,
          emailPortRef: null,
        })
      );
    } else {
      destinations.set(
        entry.binding.destinationRef,
        bindingText(
          options.bindings,
          entry.destinationBinding,
          /^[^\s@<>\u0000-\u001f\u007f]{1,120}@[^\s@<>\u0000-\u001f\u007f]{1,120}\.[A-Za-z]{2,24}$/
        )
      );
      let port: Readonly<Record<string, unknown>>;
      try {
        port = notificationFields(
          bindingValue(options.bindings, entry.emailPortBinding),
          ["availability", "send"]
        );
      } catch {
        return invalid();
      }
      // This is an actual typed server-created port, not a callable read from
      // JSON or an environment-shaped object. Preserve its implementation.
      const supplied = options.bindings.VERTEX_NOTIFICATION_EMAIL_PORT;
      if (
        !(
          supplied &&
          ["ready", "disabled", "unavailable"].includes(
            String(port["availability"])
          )
        ) ||
        typeof port["send"] !== "function" ||
        supplied.availability !== port["availability"] ||
        supplied.send !== port["send"]
      )
        return invalid();
      emailPorts.set(
        entry.configurationRef,
        Object.freeze({
          availability: supplied.availability,
          send: supplied.send,
        })
      );
      registrations.push(
        Object.freeze({
          ...entry.binding,
          configurationRef: entry.configurationRef,
          enabled: entry.enabled,
          expiresAt: entry.expiresAt,
          provider: "email",
          origin: null,
          credentialRef: null,
          emailPortRef: entry.configurationRef,
        })
      );
    }
  }
  const registrationFor = async (
    context: VertexRuntimeServerContext,
    reference: string,
    field: "destinationRef" | "configurationRef",
    signal: AbortSignal
  ): Promise<NotificationConfigurationRegistration | null> => {
    if (
      signal.aborted ||
      config.configuration?.enabled !== true ||
      !config.enabled
    )
      return null;
    const state = await current(context);
    if (!state) return null;
    const found = registrations.find(
      (entry) =>
        entry[field] === reference &&
        entry.enabled &&
        entry.expiresAt > milliseconds() &&
        canResolve(state, entry) &&
        config.sendGrants.some(
          (pin) =>
            principalMatches(state, pin.principal) &&
            sameBinding(pin.binding, entry) &&
            pin.configurationRef === entry.configurationRef
        )
    );
    return !signal.aborted && live() ? (found ?? null) : null;
  };

  const result: Built = {
    enabled: config.enabled,
    timeoutMs: config.timeoutMs,
    fetcher: options.fetcher,
    serverContext: async (requested) => {
      const actual = await freshSession();
      if (!(actual && same(actual, sessionSnapshot(requested)))) return null;
      const tenant = config.sessions.find(
        (entry) => entry.actorId === actual.userId
      );
      if (!tenant) return null;
      return mint(
        Object.freeze({
          principal: Object.freeze({
            kind: "session",
            actorId: actual.userId,
            tenantKey: tenant.tenantKey,
          }),
          session: actual,
          identity: null,
          leaseExpiresAt: null,
        })
      );
    },
    authority: {
      authenticate: async (context) => {
        const state = await current(context);
        return state
          ? Object.freeze({
              actorId: state.principal.actorId,
              tenantKey: state.principal.tenantKey,
            })
          : null;
      },
      authorize: async (context, request) => {
        const state = await current(context);
        if (
          !state ||
          request.principal.actorId !== state.principal.actorId ||
          request.principal.tenantKey !== state.principal.tenantKey
        )
          return false;
        return config.permissions.some(
          (entry) =>
            principalMatches(state, entry.principal) &&
            scopeMatches(entry.binding, request.scope) &&
            entry.binding.purpose === request.purpose &&
            entry.operations.includes(request.operation) &&
            (request.binding === null
              ? request.operation === "list"
              : sameBinding(entry.binding, request.binding))
        );
      },
      privilegedAuthorization: {
        authorize: async (context, request) => {
          const state = await current(context);
          if (
            state?.principal.kind !== "session" ||
            request.principal.actorId !== state.principal.actorId ||
            request.principal.tenantKey !== state.principal.tenantKey
          )
            return false;
          const authorityId =
            "grantId" in request.value
              ? request.value.grantId
              : request.value.consentId;
          const digest = await hashArtifact(request.value);
          return (
            live() &&
            config.administration.some(
              (entry) =>
                entry.actorId === state.principal.actorId &&
                entry.tenantKey === state.principal.tenantKey &&
                entry.action === request.action &&
                sameBinding(entry.binding, request.value) &&
                entry.authorityId === authorityId &&
                entry.version === request.value.version &&
                entry.expectedVersion === request.expectedVersion &&
                entry.valueSha256 === digest &&
                entry.expiresAt > milliseconds()
            )
          );
        },
      },
    },
    admissionAuthorization: async (scope, operation) => {
      // This source callback has no caller context. Select only factory-minted
      // writer contexts for the exact scope, never a mutable last-principal.
      for (const context of writers) {
        const state = await current(context);
        if (!state) continue;
        if (
          config.admissions.some(
            (entry) =>
              principalMatches(state, entry.principal) &&
              entry.binding.tenantKey === scope.tenantKey &&
              entry.binding.recipientKey === scope.recipientKey &&
              entry.binding.channel === scope.channel &&
              entry.binding.purpose === scope.purpose &&
              entry.operations.includes(operation)
          )
        )
          return true;
      }
      return false;
    },
    configuration:
      config.configuration === null
        ? null
        : {
            enabled: config.configuration.enabled,
            registrations: Object.freeze(registrations),
            allowedNtfyOrigins: Object.freeze(allowedNtfyOrigins),
            authorize: async (context, grant, registration, signal) => {
              if (signal.aborted || !config.enabled) return false;
              const state = await current(context);
              if (
                !(
                  state &&
                  canResolve(state, grant) &&
                  sameBinding(grant, registration)
                )
              )
                return false;
              return config.sendGrants.some(
                (entry) =>
                  principalMatches(state, entry.principal) &&
                  sameBinding(entry.binding, grant) &&
                  entry.grantId === grant.grantId &&
                  entry.version === grant.version &&
                  entry.consentId === grant.consentId &&
                  entry.consentVersion === grant.consentVersion &&
                  entry.configurationRef === grant.configurationRef &&
                  entry.configurationRef === registration.configurationRef
              );
            },
            resolveDestination: async (context, reference, signal) => {
              const registration = await registrationFor(
                context,
                reference,
                "destinationRef",
                signal
              );
              return registration
                ? (destinations.get(reference) ?? null)
                : null;
            },
            resolveCredential: async (context, reference, signal) => {
              const registration = await registrationFor(
                context,
                reference,
                "configurationRef",
                signal
              );
              return registration?.provider === "ntfy"
                ? (credentials.get(reference) ?? null)
                : null;
            },
            resolveEmailPort: async (context, reference, signal) => {
              const registration = await registrationFor(
                context,
                reference,
                "configurationRef",
                signal
              );
              return registration?.provider === "email"
                ? (emailPorts.get(reference) ?? null)
                : null;
            },
          },
    ...(config.dispatcher
      ? {
          dispatcher: {
            routes: config.dispatcher.routes,
            dryRun: config.dispatcher.dryRun,
            contextFor: (
              identity: WorkerServiceIdentity,
              lease: Parameters<
                NonNullable<Built["dispatcher"]>["contextFor"]
              >[1]
            ) => {
              // Trusted SERVER-ONLY composition port, called with the original DB
              // identity after the established authenticated dispatcher claim path.
              // Row existence is not caller authentication. This port is never exposed
              // through RPC or administration; only its privately minted context is.
              const allowed = config.workers.find(
                (entry) =>
                  entry.actorId === identity.servicePrincipalId &&
                  entry.grantId === identity.grantId &&
                  scopeMatches(entry, identity.scope)
              );
              if (
                !(
                  live() &&
                  allowed &&
                  scopeMatches(lease.scope, identity.scope)
                ) ||
                timestampToEpochNanoseconds(lease.leaseExpiresAt) <= now()
              )
                return invalid();
              return mint(
                Object.freeze({
                  principal: Object.freeze({
                    kind: "worker",
                    actorId: allowed.actorId,
                    tenantKey: allowed.tenantKey,
                    grantId: allowed.grantId,
                    accountAlias: allowed.accountAlias,
                    environment: allowed.environment,
                  }),
                  session: null,
                  identity,
                  leaseExpiresAt: lease.leaseExpiresAt,
                })
              );
            },
          },
        }
      : {}),
  };
  return Object.freeze(result);
};
