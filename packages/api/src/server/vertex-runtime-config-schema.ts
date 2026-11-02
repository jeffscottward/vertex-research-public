import { z } from "zod";
import {
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
  type DeepReadonly,
} from "@darkfactory/shared/vertex";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  VersionSchema,
} from "../contracts/vertex.ts";
import {
  PolicyArtifactPinSchema,
  PolicyHeadRevisionSchema,
  PolicyRevisionSchema,
} from "../contracts/vertex-policy.ts";
import { WorkerKindSchema } from "../contracts/vertex-worker.ts";
import { VertexNativeEmitterBindingSchema } from "./vertex-runtime-native.ts";
import { RecipeRouteSchema } from "./vertex-runtime-recipe-build.ts";
import { VertexRuntimeNotificationsConfigurationSchema } from "./vertex-runtime-config-notifications-schema.ts";

export const VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES = 131_072;
const scope = {
  accountAlias: IdentifierSchema,
  environment: z.enum(["research", "paper"]),
};
const window = { validFrom: TimestampSchema, expiresAt: TimestampSchema };
const ordered = (value: { validFrom: string; expiresAt: string }): boolean =>
  timestampToEpochNanoseconds(value.validFrom) <
  timestampToEpochNanoseconds(value.expiresAt);
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;
const key = (values: readonly unknown[]): string => JSON.stringify(values);
const administration = { ...scope, actorId: IdentifierSchema, ...window };
const policyAdministration = z
  .object({
    ...administration,
    operation: z.enum([
      "stage",
      "activate",
      "rollback",
      "drain",
      "revoke",
      "pin",
      "release",
    ]),
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    expectedRevision: PolicyHeadRevisionSchema,
    commandId: IdentifierSchema,
    requestSha256: DigestSchema,
  })
  .strict()
  .refine(ordered);
const workerAdministration = z
  .object({
    ...administration,
    action: z.enum(["issue", "revoke"]),
    grantId: IdentifierSchema,
    recordSha256: DigestSchema,
    previousRecordSha256: DigestSchema.nullable(),
    authorizationSha256: DigestSchema,
  })
  .strict()
  .refine(ordered)
  .refine(
    (value) =>
      value.action !== "revoke" ||
      value.previousRecordSha256 === value.recordSha256
  );
const modelAdministration = z
  .object({
    ...administration,
    operation: z.enum(["issue-model-use", "revoke-model-use"]),
    grantId: IdentifierSchema,
    grantVersion: VersionSchema,
    grantSha256: DigestSchema,
    expectedRevision: PolicyRevisionSchema.nullable(),
    commandId: IdentifierSchema,
    requestSha256: DigestSchema,
  })
  .strict()
  .refine(ordered);
const componentBase = {
  ...scope,
  componentId: IdentifierSchema,
  moduleId: IdentifierSchema,
  servicePrincipalId: IdentifierSchema,
  grantId: IdentifierSchema,
  maximumAgeMilliseconds: z.number().int().min(1).max(300_000),
};
const component = z.discriminatedUnion("source", [
  z
    .object({
      ...componentBase,
      source: z.literal("worker-job"),
      jobId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      ...componentBase,
      source: z.literal("host-object"),
      principal: z.object({ actorId: IdentifierSchema }).strict(),
      evidence: PolicyArtifactPinSchema,
      rightsPolicyId: IdentifierSchema,
      rightsVersion: VersionSchema,
    })
    .strict(),
]);
const jobModule = z
  .object({
    ...scope,
    kind: WorkerKindSchema,
    consumerServiceId: IdentifierSchema,
    moduleId: IdentifierSchema,
  })
  .strict();
const policy = z
  .object({
    consumerServiceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,143}$/),
    components: z
      .array(component)
      .max(256)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([value.accountAlias, value.environment, value.componentId])
          )
        )
      ),
    jobModules: z
      .array(jobModule)
      .max(256)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.environment,
              value.consumerServiceId,
              value.kind,
            ])
          )
        )
      ),
    administration: z
      .array(policyAdministration)
      .max(128)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.environment,
              value.actorId,
              value.operation,
              value.commandId,
            ])
          )
        )
      ),
  })
  .strict();
const worker = z
  .object({
    routes: z
      .array(RecipeRouteSchema)
      .max(128)
      .refine((values) => unique(values.map((value) => value.taskContract))),
    emitterBindings: z
      .array(VertexNativeEmitterBindingSchema.refine(ordered))
      .max(256)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.servicePrincipalId,
              value.streamId,
              value.ownerEpoch,
            ])
          )
        )
      ),
    administration: z
      .array(workerAdministration)
      .max(128)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.environment,
              value.actorId,
              value.action,
              value.grantId,
            ])
          )
        )
      ),
  })
  .strict();
const requestEvidence = z
  .object({
    ...scope,
    jobId: IdentifierSchema,
    requestSha256: DigestSchema,
    inputArtifactId: IdentifierSchema,
    inputCollectionId: IdentifierSchema.nullable(),
    privacyDecision: PolicyArtifactPinSchema,
    privacyIssuerActorId: IdentifierSchema,
  })
  .strict();
const modelUse = z
  .object({
    requestEvidence: z
      .array(requestEvidence)
      .max(256)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.environment,
              value.jobId,
              value.requestSha256,
            ])
          )
        )
      ),
    administration: z
      .array(modelAdministration)
      .max(128)
      .refine((values) =>
        unique(
          values.map((value) =>
            key([
              value.accountAlias,
              value.environment,
              value.actorId,
              value.operation,
              value.commandId,
            ])
          )
        )
      ),
  })
  .strict();
const nanoseconds = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const positiveNanoseconds = z.string().regex(/^[1-9][0-9]{0,29}$/);
const enrolledKey = z
  .object({
    keyId: IdentifierSchema,
    actorId: IdentifierSchema,
    // Raw Ed25519 public keys only. Private/JWK/PEM/URL key material is rejected.
    publicKeyBase64: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
    roles: z
      .array(z.enum(["approval", "status"]))
      .min(1)
      .max(2)
      .refine(unique),
    notBeforeNs: nanoseconds,
    expiresNs: positiveNanoseconds,
  })
  .strict()
  .refine((value) => BigInt(value.notBeforeNs) < BigInt(value.expiresNs));
const scopedGrant = z
  .object({
    grantId: IdentifierSchema,
    keyId: IdentifierSchema,
    actorId: IdentifierSchema,
    requestingActorId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    simulatorId: IdentifierSchema,
    streamId: IdentifierSchema,
    journalIdentity: IdentifierSchema,
    action: z.enum(["owner-epoch-transition", "native-outbox-replay"]),
    notBeforeNs: nanoseconds,
    expiresNs: positiveNanoseconds,
    revoked: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.actorId !== value.requestingActorId &&
      BigInt(value.notBeforeNs) < BigInt(value.expiresNs)
  );
const authority = z
  .object({
    configuredAtNs: nanoseconds,
    validUntilNs: positiveNanoseconds,
    policy: z
      .object({
        policyId: IdentifierSchema,
        policySha256: DigestSchema,
        policyVersion: VersionSchema,
        accountAlias: IdentifierSchema,
        environment: z.literal("paper"),
        simulatorId: IdentifierSchema,
        currency: z.string().regex(/^[A-Z]{3}$/),
        maximumApprovalTtlNs: positiveNanoseconds.refine(
          (value) => BigInt(value) <= 86_400_000_000_000n
        ),
        maximumStatusAgeNs: positiveNanoseconds.refine(
          (value) => BigInt(value) <= 300_000_000_000n
        ),
      })
      .strict(),
    keys: z
      .array(enrolledKey)
      .min(2)
      .max(64)
      .refine(
        (values) =>
          unique(values.map((value) => value.keyId)) &&
          unique(values.map((value) => value.publicKeyBase64))
      ),
    statusKeyId: IdentifierSchema,
    currentStatusBase64: z
      .string()
      .min(4)
      .max(87_384)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      ),
    currentStatusSha256: DigestSchema,
    minimumStatusRevision: positiveNanoseconds,
    grants: z
      .array(scopedGrant)
      .max(256)
      .refine((values) => unique(values.map((value) => value.grantId))),
  })
  .strict()
  .refine((value) => {
    return (
      BigInt(value.configuredAtNs) < BigInt(value.validUntilNs) &&
      value.keys.some(
        (entry) =>
          entry.keyId === value.statusKeyId && entry.roles.includes("status")
      ) &&
      value.grants.every(
        (grant) =>
          grant.accountAlias === value.policy.accountAlias &&
          grant.simulatorId === value.policy.simulatorId &&
          value.keys.some(
            (entry) =>
              entry.keyId === grant.keyId &&
              entry.keyId !== value.statusKeyId &&
              entry.actorId === grant.actorId &&
              entry.roles.includes("approval") &&
              BigInt(entry.notBeforeNs) <= BigInt(grant.notBeforeNs) &&
              BigInt(grant.expiresNs) <= BigInt(entry.expiresNs)
          )
      )
    );
  });
const gateway = z
  .object({
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    gatewayId: IdentifierSchema,
    observationBindingId: IdentifierSchema,
    producerActorId: IdentifierSchema,
    maximumAgeMilliseconds: z.number().int().min(1).max(300_000),
  })
  .strict();

// This is configuration of evidence selection, NOT a public request contract.
// Every supplied nested object is strict; there is no arbitrary metadata bag,
// executable expression, import specifier, key grant default or ready flag.
export const VertexRuntimeConfigurationSchema = z
  .object({
    format: z.literal("vertex-runtime-configuration-v1"),
    policy: policy.optional(),
    worker: worker.optional(),
    modelUse: modelUse.optional(),
    nativeEpoch: z.object({ authority }).strict().optional(),
    gateway: z
      .array(gateway)
      .max(128)
      .refine((values) =>
        unique(
          values.map((value) => key([value.accountAlias, value.gatewayId]))
        )
      )
      .optional(),
    notifications: VertexRuntimeNotificationsConfigurationSchema.optional(),
  })
  .strict()
  .refine((value) => {
    return (
      !!(value.policy || value.notifications) &&
      (!(
        value.worker ||
        value.modelUse ||
        value.gateway ||
        value.nativeEpoch
      ) ||
        !!value.policy) &&
      (!value.nativeEpoch || !!value.worker)
    );
  });
export type VertexRuntimeConfiguration = z.infer<
  typeof VertexRuntimeConfigurationSchema
>;

// Bound before parsing. Reject duplicate property spellings (including escaped
// aliases) and excessive nesting before JSON.parse can allocate an input tree.
// JSON.parse remains the grammar authority; this scan grants no input validity.
const boundedJson = (source: string): unknown => {
  if (
    source.length === 0 ||
    source.length > VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES ||
    new TextEncoder().encode(source).byteLength >
      VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES
  )
    throw new TypeError("Invalid Vertex runtime configuration");
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] =
    [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index++;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index++;
        index++;
      }
      if (index >= source.length)
        throw new TypeError("Invalid Vertex runtime configuration");
      const frame = stack.at(-1);
      if (frame?.object && frame.keyExpected) {
        const property: unknown = JSON.parse(source.slice(start, index + 1));
        if (
          typeof property !== "string" ||
          frame.keys.has(property) ||
          ["__proto__", "prototype", "constructor"].includes(property)
        )
          throw new TypeError("Invalid Vertex runtime configuration");
        frame.keys.add(property);
        frame.keyExpected = false;
      }
    } else if (character === "{" || character === "[") {
      stack.push({
        object: character === "{",
        keyExpected: character === "{",
        keys: new Set<string>(),
      });
      if (stack.length > 16)
        throw new TypeError("Invalid Vertex runtime configuration");
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.object) frame.keyExpected = true;
    }
  }
  return JSON.parse(source);
};

export const parseVertexRuntimeConfiguration = (
  configuration: unknown
): DeepReadonly<VertexRuntimeConfiguration> | null => {
  if (typeof configuration !== "string") return null;
  try {
    const parsed = VertexRuntimeConfigurationSchema.safeParse(
      boundedJson(configuration)
    );
    return parsed.success ? deepFreezeArtifact(parsed.data) : null;
  } catch {
    // Never disclose a malformed value, parse path, key material or binding name.
    return null;
  }
};
