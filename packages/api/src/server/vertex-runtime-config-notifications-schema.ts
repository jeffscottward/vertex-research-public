import { z } from "zod";
import { DigestSchema, IdentifierSchema } from "../contracts/vertex.ts";

const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const Version = z.string().regex(/^[1-9][0-9]{0,29}$/);
const Milliseconds = z
  .number()
  .int()
  .min(0)
  .max(253_402_300_799_999)
  .refine((value) => !Object.is(value, -0));
const scope = {
  accountAlias: IdentifierSchema,
  environment: z.enum(["research", "paper"]),
};
const VertexRuntimeNotificationBindingSchema = z
  .object({
    ...scope,
    tenantKey: Key,
    recipientKey: Key,
    recipientRef: Key,
    channel: z.enum(["phone", "email"]),
    purpose: z.enum(["market-alert", "research-update", "operational-alert"]),
    destinationRef: Key,
  })
  .strict();
const Principal = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      actorId: IdentifierSchema,
      tenantKey: Key,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker"),
      actorId: IdentifierSchema,
      tenantKey: Key,
      grantId: IdentifierSchema,
      ...scope,
    })
    .strict(),
]);
const Permission = z
  .object({
    principal: Principal,
    binding: VertexRuntimeNotificationBindingSchema,
    operations: z
      .array(z.enum(["list", "resolve", "delivery-read"]))
      .min(1)
      .max(3),
  })
  .strict();
const SendGrant = z
  .object({
    principal: Principal,
    binding: VertexRuntimeNotificationBindingSchema,
    grantId: Key,
    version: Version,
    consentId: Key,
    consentVersion: Version,
    configurationRef: Key,
  })
  .strict();
const Administration = z
  .object({
    // Worker send identity never becomes recipient consent/admin authority.
    actorId: IdentifierSchema,
    tenantKey: Key,
    action: z.enum([
      "issue-consent",
      "revoke-consent",
      "issue-grant",
      "revoke-grant",
    ]),
    binding: VertexRuntimeNotificationBindingSchema,
    authorityId: Key,
    version: Version,
    expectedVersion: Version.nullable(),
    valueSha256: DigestSchema,
    expiresAt: Milliseconds,
  })
  .strict();
const Admission = z
  .object({
    principal: Principal,
    binding: VertexRuntimeNotificationBindingSchema,
    operations: z
      .array(z.enum(["admit", "observe", "record-outcome"]))
      .min(1)
      .max(3),
  })
  .strict();
const Registration = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("ntfy"),
      binding: VertexRuntimeNotificationBindingSchema,
      configurationRef: Key,
      enabled: z.boolean(),
      expiresAt: Milliseconds,
      origin: z.string().max(512),
      destinationBinding: z.literal("VERTEX_NOTIFICATION_PHONE_DESTINATION"),
      credentialBinding: z
        .literal("VERTEX_NOTIFICATION_PHONE_TOKEN")
        .nullable(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("email"),
      binding: VertexRuntimeNotificationBindingSchema,
      configurationRef: Key,
      enabled: z.boolean(),
      expiresAt: Milliseconds,
      destinationBinding: z.literal("VERTEX_NOTIFICATION_EMAIL_DESTINATION"),
      emailPortBinding: z.literal("VERTEX_NOTIFICATION_EMAIL_PORT"),
    })
    .strict(),
]);
const ProviderConfiguration = z
  .object({
    enabled: z.boolean(),
    allowedNtfyOrigins: z.array(z.string().max(512)).max(16),
    registrations: z.array(Registration).max(32),
  })
  .strict();
const Dispatcher = z
  .object({
    dryRun: z.boolean(),
    routes: z
      .array(
        z
          .object({
            eventType: z.string().min(1).max(128),
            kind: z.enum([
              "market-alert",
              "research-completed",
              "research-failed",
              "operational-alert",
            ]),
            ttlMilliseconds: z.number().int().min(1).max(86_400_000),
          })
          .strict()
      )
      .max(128),
  })
  .strict();

// No topic, destination address, credential, bearer or arbitrary environment
// key is representable in JSON. Every authority domain is explicit and separate.
// Empty arrays and enabled:false confer no authority; no defaults are applied.
export const VertexRuntimeNotificationsConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    timeoutMs: z.number().int().min(1).max(30_000),
    sessions: z
      .array(z.object({ actorId: IdentifierSchema, tenantKey: Key }).strict())
      .max(128),
    workers: z
      .array(
        z
          .object({
            actorId: IdentifierSchema,
            tenantKey: Key,
            grantId: IdentifierSchema,
            ...scope,
            grantSha256: DigestSchema,
          })
          .strict()
      )
      .max(128),
    permissions: z.array(Permission).max(256),
    sendGrants: z.array(SendGrant).max(256),
    administration: z.array(Administration).max(256),
    admissions: z.array(Admission).max(256),
    configuration: ProviderConfiguration.nullable(),
    dispatcher: Dispatcher.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const reject = () =>
      ctx.addIssue({
        code: "custom",
        message: "Invalid notification configuration",
      });
    if (
      new Set(value.sessions.map((entry) => entry.actorId)).size !==
      value.sessions.length
    )
      reject();
    if (
      new Set(
        value.workers.map((entry) =>
          JSON.stringify([entry.grantId, entry.accountAlias, entry.environment])
        )
      ).size !== value.workers.length
    )
      reject();
    if (
      new Set(
        value.dispatcher?.routes.map((route) =>
          JSON.stringify([route.eventType, route.kind])
        )
      ).size !== (value.dispatcher?.routes.length ?? 0)
    )
      reject();
    for (const entry of [
      ...value.permissions,
      ...value.sendGrants,
      ...value.admissions,
    ]) {
      if (entry.principal.tenantKey !== entry.binding.tenantKey) reject();
      if (entry.principal.kind === "session") {
        if (
          !value.sessions.some(
            (session) =>
              session.actorId === entry.principal.actorId &&
              session.tenantKey === entry.principal.tenantKey
          )
        )
          reject();
      } else {
        const principal = entry.principal;
        if (
          principal.accountAlias !== entry.binding.accountAlias ||
          principal.environment !== entry.binding.environment ||
          !value.workers.some(
            (worker) =>
              worker.actorId === principal.actorId &&
              worker.tenantKey === principal.tenantKey &&
              worker.grantId === principal.grantId &&
              worker.accountAlias === principal.accountAlias &&
              worker.environment === principal.environment
          )
        )
          reject();
      }
    }
    for (const entry of value.administration) {
      if (
        entry.tenantKey !== entry.binding.tenantKey ||
        !value.sessions.some(
          (session) =>
            session.actorId === entry.actorId &&
            session.tenantKey === entry.tenantKey
        )
      )
        reject();
    }
    const registrations = value.configuration?.registrations ?? [];
    if (
      new Set(registrations.map((entry) => entry.configurationRef)).size !==
      registrations.length
    )
      reject();
    if (
      new Set(registrations.map((entry) => entry.binding.destinationRef))
        .size !== registrations.length
    )
      reject();
    for (const entry of registrations) {
      if ((entry.provider === "ntfy") !== (entry.binding.channel === "phone"))
        reject();
    }
    // The durable notification store has this four-part scope, not an account
    // field. Never let its independent admission permission straddle accounts.
    const admissionScopes = new Map<string, string>();
    for (const entry of [
      ...value.permissions,
      ...value.sendGrants,
      ...value.administration,
      ...value.admissions,
      ...registrations,
    ]) {
      const binding = entry.binding;
      const key = JSON.stringify([
        binding.tenantKey,
        binding.recipientKey,
        binding.channel,
        binding.purpose,
      ]);
      const account = JSON.stringify([
        binding.accountAlias,
        binding.environment,
      ]);
      if (admissionScopes.has(key) && admissionScopes.get(key) !== account)
        reject();
      admissionScopes.set(key, account);
    }
  });
export type VertexRuntimeNotificationsConfiguration = z.infer<
  typeof VertexRuntimeNotificationsConfigurationSchema
>;
