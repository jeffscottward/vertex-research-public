import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const referenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/);
export const absolutePathSchema = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9._/-]+$/)
  .refine(
    (value) =>
      !value
        .split("/")
        .slice(1)
        .some((part) => !part || part === "." || part === "..")
  );
const relativePathSchema = z
  .string()
  .max(384)
  .regex(/^[A-Za-z0-9_+./-]+$/)
  .refine(
    (value) =>
      !(
        value.startsWith("/") ||
        value.split("/").some((part) => !part || part === "." || part === "..")
      )
  );
export const releaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
const requestIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const timestampSchema = z.string().datetime({ offset: false });
const integerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const releaseManifestSchema = z
  .object({
    format: z.literal("vertex-host-release-v1"),
    releaseId: releaseIdSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    platform: z.literal("linux-x86_64"),
    pythonVersion: z.literal("3.12.11"),
    mode: z.enum(["research", "paper"]),
    liveExecution: z.literal(false),
    pythonRelativePath: relativePathSchema,
    hostEntrypointRelativePath: relativePathSchema,
    contractAuthorityRelativePath: relativePathSchema,
    dependencyLockRelativePath: relativePathSchema,
    toolchainManifestRelativePath: relativePathSchema,
    journal: z
      .object({
        format: z.literal("vertex-execution-journal-v1"),
        authorityRelativePath: relativePathSchema,
        authoritySha256: digestSchema,
      })
      .strict(),
    directories: z.array(relativePathSchema).max(50_000),
    files: z
      .array(
        z
          .object({
            path: relativePathSchema,
            sha256: digestSchema,
            size: integerSchema.max(2_147_483_648),
            mode: z.enum(["0444", "0555"]),
          })
          .strict()
      )
      .min(1)
      .max(50_000),
  })
  .strict();

export const deploymentPolicySchema = z
  .object({
    format: z.literal("vertex-host-deployment-policy-v1"),
    hostRef: referenceSchema,
    // References are resolved locally, never environment-expanded or executed.
    serviceUserRef: referenceSchema,
    serviceGroupRef: referenceSchema,
    releaseApprovalKeyRef: referenceSchema,
    hostTrustKeyRef: referenceSchema,
    machineIdentityPath: absolutePathSchema,
    sshHostPublicKeyPath: absolutePathSchema,
    releasesRoot: absolutePathSchema,
    activeLinkPath: absolutePathSchema,
    stateRoot: absolutePathSchema,
    sandboxCgroupPath: absolutePathSchema,
    ownerLockPath: absolutePathSchema,
    operationLogPath: absolutePathSchema,
    activeRecordPath: absolutePathSchema,
    lockPath: absolutePathSchema,
    hostConfigPath: absolutePathSchema,
    hostConfigSha256: digestSchema,
    journalPath: absolutePathSchema,
    drainRequestPath: absolutePathSchema,
    readinessReceiptPath: absolutePathSchema,
    drainReceiptPath: absolutePathSchema,
    unitPath: absolutePathSchema,
    unitTemplateSha256: digestSchema,
    unitName: z.string().regex(/^vertex-host(?:-[a-z0-9-]{1,40})?\.service$/),
    systemctlPath: absolutePathSchema,
    systemctlSha256: digestSchema,
    controlEgressAddresses: z
      .array(z.union([z.ipv4(), z.ipv6()]))
      .min(1)
      .max(16),
    drainTimeoutMs: integerSchema.min(1000).max(3_600_000),
    startTimeoutMs: integerSchema.min(1000).max(300_000),
  })
  .strict();

export const releaseRequestSchema = z
  .object({
    format: z.literal("vertex-host-release-request-v1"),
    requestId: requestIdSchema,
    action: z.enum(["release", "drain", "rollback"]),
    targetManifestSha256: digestSchema,
    currentManifestSha256: digestSchema.nullable(),
    policySha256: digestSchema,
  })
  .strict();

export const approvalPayloadSchema = releaseRequestSchema
  .extend({
    hostRef: referenceSchema,
    approvedByRef: referenceSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    humanApproved: z.literal(true),
  })
  .strict();

export const hostTrustPayloadSchema = z
  .object({
    format: z.literal("vertex-host-trust-v1"),
    hostRef: referenceSchema,
    machineIdentitySha256: digestSchema,
    sshHostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    evidenceRef: referenceSchema,
    verifiedByRef: referenceSchema,
    consoleVerified: z.literal(true),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const signedReceiptSchema = z
  .object({
    format: z.literal("vertex-ed25519-receipt-v1"),
    keyRef: referenceSchema,
    payloadBase64: z
      .string()
      .min(4)
      .max(65_536)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signatureBase64: z
      .string()
      .length(88)
      .regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

export const drainReceiptSchema = z
  .object({
    format: z.literal("vertex-host-drain-v1"),
    requestId: requestIdSchema,
    releaseId: releaseIdSchema,
    instanceId: referenceSchema,
    accountAlias: referenceSchema,
    environment: z.enum(["research", "paper"]),
    ownerEpoch: z
      .string()
      .regex(/^[1-9][0-9]{0,39}$/)
      .nullable(),
    journalSequence: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,39})$/)
      .nullable(),
    journalHeadSha256: digestSchema.nullable(),
    journalIdentity: referenceSchema.nullable(),
    journalSchema: z.literal("vertex-execution-journal-v1").nullable(),
    projectionPending: z.boolean(),
    activeJobs: z.literal(0),
    admissionsClosed: z.literal(true),
    pendingDispatch: integerSchema,
    ownerFenceReleased: z.literal(true),
    completedAtNs: z.string().regex(/^[1-9][0-9]{0,29}$/),
    outcome: z.enum(["drained", "pending-publications"]),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type DeploymentPolicy = z.infer<typeof deploymentPolicySchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type DrainReceipt = z.infer<typeof drainReceiptSchema>;
export type SignedReceipt = z.infer<typeof signedReceiptSchema>;
export type ResolvedServiceIdentity = Readonly<{
  user: string;
  group: string;
  uid: number;
  gid: number;
}>;

export const releaseFailure: (code: string) => never = (code) => {
  throw new Error(`vertex-host-release:${code}`);
};

export const parseBoundedJson = (
  bytes: Uint8Array,
  maximum = 1_048_576
): unknown => {
  if (bytes.length === 0 || bytes.length > maximum)
    releaseFailure("input-size");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    return releaseFailure("input-json");
  }
};
