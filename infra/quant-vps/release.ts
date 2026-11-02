import { posix } from "node:path";
import {
  deploymentPolicySchema,
  drainReceiptSchema,
  parseBoundedJson,
  releaseFailure,
  releaseManifestSchema,
  releaseRequestSchema,
  type DeploymentPolicy,
  type DrainReceipt,
  type ReleaseManifest,
  type ReleaseRequest,
} from "./contract.ts";
import { sha256 } from "./authority.ts";

export type CurrentRelease = Readonly<{
  manifest: ReleaseManifest;
  manifestSha256: string;
  configSha256: string;
  unitSha256: string;
  instanceId: string;
  accountAlias: string;
  environment: "research" | "paper";
  journalIdentity: string | null;
  journalPath: string | null;
  state: "active" | "inactive";
}>;
export type ReleaseContext = Readonly<{
  request: ReleaseRequest;
  policy: DeploymentPolicy;
  manifest: ReleaseManifest;
  current: CurrentRelease | null;
}>;
export type ReleasePhase =
  | "admitted"
  | "drain-requested"
  | "drained"
  | "preserved"
  | "activated"
  | "started"
  | "completed"
  | "interrupted";
export interface ReleasePorts {
  withExclusiveLock: <T>(work: () => Promise<T>) => Promise<T>;
  authorize: (context: ReleaseContext) => Promise<void>;
  loadCurrent: (policy: DeploymentPolicy) => Promise<CurrentRelease | null>;
  verifyCandidate: (context: ReleaseContext) => Promise<void>;
  verifyCurrent: (context: ReleaseContext) => Promise<void>;
  ensureUnusedRequest: (context: ReleaseContext) => Promise<void>;
  record: (phase: ReleasePhase, context: ReleaseContext) => Promise<void>;
  requestDrain: (context: ReleaseContext) => Promise<void>;
  waitForDrain: (
    context: ReleaseContext
  ) => Promise<Readonly<{ receipt: unknown; inactive: boolean }>>;
  preserve: (
    context: ReleaseContext,
    receipt: DrainReceipt | null
  ) => Promise<void>;
  activate: (context: ReleaseContext) => Promise<void>;
  start: (context: ReleaseContext) => Promise<void>;
  confirmStarted: (context: ReleaseContext) => Promise<void>;
}

const within = (parent: string, child: string): boolean =>
  child.startsWith(`${parent}/`);
export const assertDeploymentLayout = (policy: DeploymentPolicy): void => {
  const mutable = [
    policy.stateRoot,
    policy.hostConfigPath,
    policy.unitPath,
    policy.activeLinkPath,
    policy.activeRecordPath,
    policy.operationLogPath,
    policy.lockPath,
  ];
  if (
    policy.releasesRoot === "/" ||
    mutable.some(
      (path) =>
        path === policy.releasesRoot ||
        within(policy.releasesRoot, path) ||
        within(path, policy.releasesRoot)
    )
  )
    releaseFailure("mutable-release-layout");
  if (
    ![
      policy.journalPath,
      policy.ownerLockPath,
      policy.drainRequestPath,
      policy.drainReceiptPath,
      policy.readinessReceiptPath,
    ].every((path) => within(policy.stateRoot, path))
  )
    releaseFailure("state-layout");
  const files = [
    policy.journalPath,
    policy.ownerLockPath,
    policy.drainRequestPath,
    policy.drainReceiptPath,
    policy.readinessReceiptPath,
    policy.hostConfigPath,
    policy.unitPath,
    policy.activeLinkPath,
    policy.activeRecordPath,
    policy.operationLogPath,
    policy.lockPath,
  ];
  if (
    new Set(files).size !== files.length ||
    files.some((path) =>
      files.some((other) => other !== path && within(other, path))
    )
  )
    releaseFailure("overlapping-paths");
  if (
    [
      policy.hostConfigPath,
      policy.unitPath,
      policy.operationLogPath,
      policy.activeRecordPath,
      policy.lockPath,
      policy.activeLinkPath,
    ].some((path) => within(policy.stateRoot, path))
  )
    releaseFailure("service-writable-authority");
  if (posix.basename(policy.unitPath) !== policy.unitName)
    releaseFailure("unit-name");
  if (
    policy.sandboxCgroupPath !==
    `/sys/fs/cgroup/system.slice/${policy.unitName}`
  )
    releaseFailure("sandbox-delegation-scope");
  if (
    new Set(policy.controlEgressAddresses).size !==
      policy.controlEgressAddresses.length ||
    policy.controlEgressAddresses.some((address) =>
      ["0.0.0.0", "::"].includes(address)
    )
  )
    releaseFailure("egress-scope");
};

export const assertManifestInventory = (manifest: ReleaseManifest): void => {
  const paths = manifest.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.includes("release-manifest.json")
  )
    releaseFailure("manifest-inventory");
  const directories = new Set(manifest.directories);
  if (
    directories.size !== manifest.directories.length ||
    directories.has("release-manifest.json") ||
    paths.some((path) => directories.has(path))
  )
    releaseFailure("manifest-directories");
  for (const path of [...paths, ...directories]) {
    const parent = posix.dirname(path);
    if (parent !== "." && !directories.has(parent))
      releaseFailure("manifest-parent");
  }
  const roles = [
    manifest.pythonRelativePath,
    manifest.hostEntrypointRelativePath,
    manifest.contractAuthorityRelativePath,
    manifest.dependencyLockRelativePath,
    manifest.toolchainManifestRelativePath,
    manifest.journal.authorityRelativePath,
  ];
  if (
    new Set(roles).size !== roles.length ||
    roles.some((path) => !paths.includes(path))
  )
    releaseFailure("manifest-role");
  if (
    manifest.files.find((file) => file.path === manifest.pythonRelativePath)
      ?.mode !== "0555"
  )
    releaseFailure("python-mode");
  if (
    manifest.files.find(
      (file) => file.path === manifest.journal.authorityRelativePath
    )?.sha256 !== manifest.journal.authoritySha256
  )
    releaseFailure("journal-authority");
  if (
    manifest.files.reduce((total, file) => total + file.size, 0) >
    16_000_000_000
  )
    releaseFailure("release-size");
};

export const assertCompatibleJournal = (
  current: ReleaseManifest,
  target: ReleaseManifest
): void => {
  // Schema transformations belong to a separate explicitly reviewed maintenance
  // operation. A release, including rollback, never rewrites or restores a DB.
  if (
    current.journal.format !== target.journal.format ||
    current.journal.authoritySha256 !== target.journal.authoritySha256
  )
    releaseFailure("journal-incompatible");
  if (current.mode !== target.mode) releaseFailure("environment-switch");
};

export const assertDrainReceipt = (
  input: unknown,
  requestId: string,
  current: CurrentRelease
): DrainReceipt => {
  const receipt = drainReceiptSchema.parse(input);
  if (
    receipt.requestId !== requestId ||
    receipt.releaseId !== current.manifest.releaseId ||
    receipt.instanceId !== current.instanceId ||
    receipt.accountAlias !== current.accountAlias ||
    receipt.environment !== current.environment ||
    receipt.journalIdentity !== current.journalIdentity
  )
    releaseFailure("drain-identity");
  if (
    receipt.outcome !== "drained" ||
    receipt.projectionPending ||
    receipt.pendingDispatch !== 0
  )
    releaseFailure("drain-incomplete");
  if (current.environment === "paper") {
    if (
      receipt.ownerEpoch === null ||
      receipt.journalSequence === null ||
      receipt.journalHeadSha256 === null ||
      receipt.journalSchema !== current.manifest.journal.format ||
      receipt.journalIdentity === null
    )
      releaseFailure("drain-journal");
  } else if (
    [
      receipt.ownerEpoch,
      receipt.journalSequence,
      receipt.journalHeadSha256,
      receipt.journalIdentity,
      receipt.journalSchema,
    ].some((value) => value !== null)
  )
    releaseFailure("research-journal");
  return receipt;
};

export const runHostRelease = async (
  input: Readonly<{
    request: unknown;
    policyBytes: Uint8Array;
    manifestBytes: Uint8Array;
  }>,
  ports: ReleasePorts
): Promise<
  Readonly<{
    format: "vertex-host-release-result-v1";
    requestId: string;
    action: ReleaseRequest["action"];
    releaseId: string;
    status: "completed";
  }>
> => {
  const request = releaseRequestSchema.parse(input.request);
  // Snapshot caller-owned data before the first await; identity is exact bytes.
  const policyBytes = Uint8Array.from(input.policyBytes);
  const manifestBytes = Uint8Array.from(input.manifestBytes);
  if (sha256(policyBytes) !== request.policySha256)
    releaseFailure("policy-digest");
  if (sha256(manifestBytes) !== request.targetManifestSha256)
    releaseFailure("manifest-digest");
  const policy = deploymentPolicySchema.parse(
    parseBoundedJson(policyBytes, 32_768)
  );
  const manifest = releaseManifestSchema.parse(
    parseBoundedJson(manifestBytes, 16_777_216)
  );
  assertDeploymentLayout(policy);
  assertManifestInventory(manifest);
  const initial: ReleaseContext = { request, policy, manifest, current: null };
  await ports.authorize(initial);
  return ports.withExclusiveLock(async () => {
    const current = await ports.loadCurrent(policy);
    const context: ReleaseContext = { request, policy, manifest, current };
    if ((current?.manifestSha256 ?? null) !== request.currentManifestSha256)
      releaseFailure("current-release-drift");
    if (request.action !== "release" && !current)
      releaseFailure("current-release-required");
    if (current) {
      assertCompatibleJournal(current.manifest, manifest);
      if (
        current.environment !== manifest.mode ||
        current.journalPath !==
          (manifest.mode === "paper" ? policy.journalPath : null)
      )
        releaseFailure("journal-location-drift");
      if (
        request.action === "drain" &&
        request.targetManifestSha256 !== current.manifestSha256
      )
        releaseFailure("drain-target");
      if (
        request.action !== "drain" &&
        manifest.releaseId === current.manifest.releaseId
      )
        releaseFailure("release-reuse");
    }
    await ports.authorize(context);
    await ports.ensureUnusedRequest(context);
    await ports.verifyCurrent(context);
    await ports.verifyCandidate(context);
    await ports.record("admitted", context);
    try {
      let receipt: DrainReceipt | null = null;
      if (current) {
        // Authorization is checked again at the first process side effect.
        await ports.authorize(context);
        await ports.record("drain-requested", context);
        await ports.requestDrain(context);
        const observed = await ports.waitForDrain(context);
        if (!observed.inactive) releaseFailure("owner-still-active");
        receipt = assertDrainReceipt(
          observed.receipt,
          request.requestId,
          current
        );
        await ports.record("drained", context);
      }
      if (request.action !== "drain") {
        await ports.authorize(context);
        await ports.preserve(context, receipt);
        await ports.record("preserved", context);
        await ports.verifyCandidate(context);
        await ports.activate(context);
        await ports.record("activated", context);
        await ports.authorize(context);
        await ports.start(context);
        await ports.confirmStarted(context);
        await ports.record("started", context);
      }
      await ports.record("completed", context);
      return {
        format: "vertex-host-release-result-v1",
        requestId: request.requestId,
        action: request.action,
        releaseId: manifest.releaseId,
        status: "completed",
      };
    } catch (error) {
      // Never stop/kill a process, restore a pointer, downgrade a journal, retry
      // an uncertain command, or restart the previous release in compensation.
      await ports.record("interrupted", context);
      throw error;
    }
  });
};
