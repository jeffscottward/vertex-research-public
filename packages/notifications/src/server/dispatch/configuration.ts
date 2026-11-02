import type { NotificationEmailPort } from "@darkfactory/email/server";
import type { NtfyNotificationConfiguration } from "../ntfy.ts";
import type { EmailNotificationConfiguration } from "../email.ts";
import type {
  NotificationConfigurationResolver,
  NotificationRecipientBinding,
  NotificationRecipientGrant,
} from "./contracts.ts";
import {
  notificationBinding,
  notificationFields,
  notificationKey,
  notificationMilliseconds,
  snapshotNotificationRecipientGrant,
} from "./validation.ts";

// These are nonsecret immutable references, not raw destinations or credentials.
// Runtime application composition supplies them explicitly; no process.env,
// dotenv, OMP configuration, global fetch or provider SDK discovery is used.
export type NotificationConfigurationRegistration =
  NotificationRecipientBinding &
    Readonly<{
      configurationRef: string;
      enabled: boolean;
      expiresAt: number;
      provider: "ntfy" | "email";
      origin: string | null;
      credentialRef: string | null;
      emailPortRef: string | null;
    }>;
export type NotificationConfigurationResolverOptions<Context> = Readonly<{
  enabled?: boolean | undefined;
  registrations: readonly NotificationConfigurationRegistration[];
  allowedNtfyOrigins: readonly string[];
  clock: Readonly<{ now: () => number }>;
  // The authorization policy must authenticate Context and observe current
  // configuration revocation/readiness. A request flag is not authorization.
  authorize: (
    context: Context,
    grant: NotificationRecipientGrant,
    registration: NotificationConfigurationRegistration,
    signal: AbortSignal
  ) => Promise<boolean>;
  // Resolve only this registered immutable destination reference at send time.
  resolveDestination: (
    context: Context,
    reference: string,
    signal: AbortSignal
  ) => Promise<string | null>;
  resolveCredential?: (
    context: Context,
    reference: string,
    signal: AbortSignal
  ) => Promise<string | null>;
  resolveEmailPort?: (
    context: Context,
    reference: string,
    signal: AbortSignal
  ) => Promise<NotificationEmailPort | null>;
}>;
const sameBinding = (
  a: NotificationRecipientBinding,
  b: NotificationRecipientBinding
): boolean =>
  JSON.stringify(notificationBinding(a)) ===
  JSON.stringify(notificationBinding(b));
const registrationKeys = [
  "tenantKey",
  "accountAlias",
  "environment",
  "recipientKey",
  "recipientRef",
  "channel",
  "purpose",
  "destinationRef",
  "configurationRef",
  "enabled",
  "expiresAt",
  "provider",
  "origin",
  "credentialRef",
  "emailPortRef",
] as const;
const origin = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("Notification configuration invalid");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("Notification configuration invalid");
  return value;
};
const snapshotRegistration = (
  raw: unknown
): NotificationConfigurationRegistration => {
  const value = notificationFields(raw, registrationKeys);
  const binding = notificationBinding(
    value as unknown as NotificationRecipientBinding
  );
  if (typeof value["enabled"] !== "boolean")
    throw new Error("Notification configuration invalid");
  const shared = {
    ...binding,
    configurationRef: notificationKey(value["configurationRef"]),
    enabled: value["enabled"],
    expiresAt: notificationMilliseconds(value["expiresAt"]),
  };
  if (
    value["provider"] === "ntfy" &&
    binding.channel === "phone" &&
    value["emailPortRef"] === null
  ) {
    return Object.freeze({
      ...shared,
      provider: "ntfy",
      origin: origin(value["origin"]),
      credentialRef:
        value["credentialRef"] === null
          ? null
          : notificationKey(value["credentialRef"]),
      emailPortRef: null,
    });
  }
  if (
    value["provider"] === "email" &&
    binding.channel === "email" &&
    value["origin"] === null &&
    value["credentialRef"] === null
  ) {
    return Object.freeze({
      ...shared,
      provider: "email",
      origin: null,
      credentialRef: null,
      emailPortRef: notificationKey(value["emailPortRef"]),
    });
  }
  throw new Error("Notification configuration invalid");
};

export const createNotificationConfigurationResolver = <Context>(
  options: NotificationConfigurationResolverOptions<Context>
): NotificationConfigurationResolver<Context> => {
  const enabled = options.enabled === true;
  // A malformed or duplicate registration disables the entire configuration set;
  // it never selects an arbitrary first/latest registration.
  let registrations: readonly NotificationConfigurationRegistration[] = [];
  let allowedOrigins = new Set<string>();
  let configured = false;
  try {
    if (
      !Array.isArray(options.registrations) ||
      options.registrations.length > 1024 ||
      !Array.isArray(options.allowedNtfyOrigins) ||
      options.allowedNtfyOrigins.length > 32
    )
      throw new Error("Notification configuration invalid");
    registrations = Object.freeze(
      options.registrations.map(snapshotRegistration)
    );
    const keys = registrations.map((item) =>
      JSON.stringify([
        item.tenantKey,
        item.accountAlias,
        item.environment,
        item.recipientKey,
        item.channel,
        item.purpose,
        item.destinationRef,
        item.configurationRef,
      ])
    );
    if (new Set(keys).size !== keys.length)
      throw new Error("Notification configuration invalid");
    allowedOrigins = new Set(options.allowedNtfyOrigins.map(origin));
    configured =
      typeof options.clock?.now === "function" &&
      typeof options.authorize === "function" &&
      typeof options.resolveDestination === "function";
  } catch {
    configured = false;
  }
  const find = async (
    context: Context,
    input: NotificationRecipientGrant,
    signal: AbortSignal
  ): Promise<NotificationConfigurationRegistration | null> => {
    if (!(enabled && configured) || signal.aborted) return null;
    const grant = snapshotNotificationRecipientGrant(input);
    const matches = registrations.filter(
      (item) =>
        item.configurationRef === grant.configurationRef &&
        sameBinding(item, grant)
    );
    const [selected] = matches;
    if (matches.length !== 1 || selected === undefined) return null;
    const now = notificationMilliseconds(options.clock.now());
    if (
      !selected.enabled ||
      selected.expiresAt <= now ||
      grant.expiresAt <= now ||
      grant.validFrom > now
    )
      return null;
    if (
      selected.provider === "ntfy" &&
      (selected.origin === null ||
        !allowedOrigins.has(selected.origin) ||
        (selected.credentialRef !== null &&
          typeof options.resolveCredential !== "function"))
    )
      return null;
    if (
      selected.provider === "email" &&
      typeof options.resolveEmailPort !== "function"
    )
      return null;
    if (
      (await options.authorize(context, grant, selected, signal)) !== true ||
      signal.aborted
    )
      return null;
    // Authorization may outlast the grant even while the configuration remains
    // valid. Recheck both deadlines before readiness or private resolution.
    const authorizedAt = notificationMilliseconds(options.clock.now());
    if (
      authorizedAt < now ||
      selected.expiresAt <= authorizedAt ||
      grant.expiresAt <= authorizedAt
    )
      return null;
    return selected;
  };
  return Object.freeze<NotificationConfigurationResolver<Context>>({
    readiness: async (
      context,
      grant,
      signal
    ): Promise<"ready" | "disabled" | "unavailable"> => {
      if (!enabled) return "disabled";
      try {
        return (await find(context, grant, signal)) ? "ready" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
    resolvePhone: async (
      context,
      grant,
      signal
    ): Promise<NtfyNotificationConfiguration | null> => {
      try {
        const selected = await find(context, grant, signal);
        if (selected?.provider !== "ntfy" || selected.origin === null)
          return null;
        const ntfyOrigin = selected.origin;
        const topic = await options.resolveDestination(
          context,
          selected.destinationRef,
          signal
        );
        let bearerToken: string | null = null;
        if (selected.credentialRef !== null) {
          if (typeof options.resolveCredential !== "function") return null;
          bearerToken = await options.resolveCredential(
            context,
            selected.credentialRef,
            signal
          );
        }
        if (
          topic === null ||
          (selected.credentialRef !== null && bearerToken === null) ||
          signal.aborted ||
          !(await find(context, grant, signal))
        )
          return null;
        return Object.freeze({
          enabled: true,
          tenantKey: grant.tenantKey,
          recipientKey: grant.recipientKey,
          origin: ntfyOrigin,
          topic,
          bearerToken,
        });
      } catch {
        return null;
      }
    },
    resolveEmail: async (
      context,
      grant,
      signal
    ): Promise<EmailNotificationConfiguration | null> => {
      try {
        const selected = await find(context, grant, signal);
        if (
          selected?.provider !== "email" ||
          selected.emailPortRef === null ||
          typeof options.resolveEmailPort !== "function"
        )
          return null;
        const to = await options.resolveDestination(
          context,
          selected.destinationRef,
          signal
        );
        const port = await options.resolveEmailPort(
          context,
          selected.emailPortRef,
          signal
        );
        if (
          to === null ||
          port === null ||
          signal.aborted ||
          !(await find(context, grant, signal))
        )
          return null;
        return Object.freeze({
          enabled: true,
          tenantKey: grant.tenantKey,
          recipientKey: grant.recipientKey,
          to,
          port,
        });
      } catch {
        return null;
      }
    },
  });
};
