import { posix } from "node:path";
import { z } from "zod";
import {
  absolutePathSchema,
  digestSchema,
  referenceSchema,
  releaseFailure,
  releaseIdSchema,
  type DeploymentPolicy,
  type ReleaseManifest,
  type ResolvedServiceIdentity,
} from "./contract.ts";
import type { CurrentRelease } from "./release.ts";

// The host owns its complete parser. This projection requires deployment fields
// while retaining no credential values; the exact whole config is digest-bound.
const deploymentConfigSchema = z
  .object({
    format: z.literal("vertex-host-v1"),
    releaseId: releaseIdSchema,
    instanceId: referenceSchema,
    accountAlias: referenceSchema,
    environment: z.enum(["research", "paper"]),
    liveExecution: z.literal(false),
    startupMode: z.enum(["initialize", "restore"]),
    journalIdentity: referenceSchema.nullable(),
    journalPath: absolutePathSchema.nullable(),
    drainRequestPath: absolutePathSchema,
    drainReceiptPath: absolutePathSchema,
    readinessReceiptPath: absolutePathSchema,
    ownerLockPath: absolutePathSchema,
    nativeAdmin: z
      .object({
        socketPath: absolutePathSchema,
        operatorUid: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        requestTimeoutSeconds: z.number().positive().max(300),
      })
      .strict()
      .nullable(),
    sandbox: z
      .object({
        cgroup_root: absolutePathSchema,
        rootfs: absolutePathSchema,
        bwrap_path: absolutePathSchema,
        bwrap_sha256: digestSchema,
      })
      .passthrough(),
    contractBundle: z
      .object({ path: absolutePathSchema, sha256: digestSchema })
      .passthrough(),
    control: z
      .object({ origin: z.string().url(), credentialRef: referenceSchema })
      .passthrough(),
  })
  .passthrough();
export type DeploymentHostConfig = z.infer<typeof deploymentConfigSchema>;

export const parseDeploymentHostConfig = (
  input: unknown
): DeploymentHostConfig => {
  const config = deploymentConfigSchema.parse(input);
  const origin = new URL(config.control.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  )
    releaseFailure("control-origin");
  if (
    config.environment === "paper" &&
    !(config.journalPath && config.journalIdentity)
  )
    releaseFailure("paper-journal");
  if (
    config.environment === "research" &&
    (config.journalPath !== null || config.journalIdentity !== null)
  )
    releaseFailure("research-journal");
  return config;
};

export const bindHostConfiguration = (
  config: DeploymentHostConfig,
  manifest: ReleaseManifest,
  policy: DeploymentPolicy,
  current: CurrentRelease | null
): void => {
  const root = posix.join(policy.releasesRoot, manifest.releaseId);
  if (
    config.releaseId !== manifest.releaseId ||
    config.environment !== manifest.mode ||
    config.drainRequestPath !== policy.drainRequestPath ||
    config.drainReceiptPath !== policy.drainReceiptPath ||
    config.readinessReceiptPath !== policy.readinessReceiptPath ||
    config.journalPath !==
      (manifest.mode === "paper" ? policy.journalPath : null)
  )
    releaseFailure("host-configuration-binding");
  if (
    config.ownerLockPath !== policy.ownerLockPath ||
    config.sandbox.cgroup_root !== policy.sandboxCgroupPath ||
    !config.sandbox.rootfs.startsWith(`${root}/`) ||
    !config.sandbox.bwrap_path.startsWith(`${root}/`)
  )
    releaseFailure("sandbox-binding");
  const socketPath = config.nativeAdmin?.socketPath;
  if (
    socketPath !== undefined &&
    (!socketPath.startsWith(`${policy.stateRoot}/`) ||
      [
        policy.journalPath,
        policy.ownerLockPath,
        policy.drainRequestPath,
        policy.drainReceiptPath,
        policy.readinessReceiptPath,
      ].some(
        (path) =>
          socketPath === path ||
          socketPath.startsWith(`${path}/`) ||
          path.startsWith(`${socketPath}/`)
      ))
  )
    releaseFailure("native-admin-socket-scope");
  const sandboxBinary = manifest.files.find(
    (file) => posix.join(root, file.path) === config.sandbox.bwrap_path
  );
  if (
    !sandboxBinary ||
    sandboxBinary.sha256 !== config.sandbox.bwrap_sha256 ||
    sandboxBinary.mode !== "0555"
  )
    releaseFailure("sandbox-binary-binding");
  const bundle = manifest.files.find(
    (file) => file.path === manifest.contractAuthorityRelativePath
  );
  if (
    !bundle ||
    config.contractBundle.path !== posix.join(root, bundle.path) ||
    config.contractBundle.sha256 !== bundle.sha256
  )
    releaseFailure("contract-authority-binding");
  if (current) {
    if (
      config.accountAlias !== current.accountAlias ||
      config.journalIdentity !== current.journalIdentity ||
      (config.environment === "paper" && config.startupMode !== "restore") ||
      config.instanceId === current.instanceId
    )
      releaseFailure("restore-binding");
  } else if (
    config.environment === "paper" &&
    config.startupMode !== "initialize"
  )
    releaseFailure("initialize-required");
};

// Policy signatures cannot weaken the authored no-live service profile. A future
// unit capability change needs source review, not merely an altered template.
export const assertUnitTemplate = (template: string): void => {
  const unitKeys = new Set([
    "Description",
    "After",
    "RequiresMountsFor",
    "ConditionPathIsRegular",
  ]);
  const serviceKeys = new Set([
    "Type",
    "User",
    "Group",
    "WorkingDirectory",
    "ExecStart",
    "Environment",
    "UnsetEnvironment",
    "Restart",
    "KillSignal",
    "KillMode",
    "TimeoutStopSec",
    "SendSIGKILL",
    "FinalKillSignal",
    "UMask",
    "StandardInput",
    "StandardOutput",
    "StandardError",
    "NoNewPrivileges",
    "CapabilityBoundingSet",
    "AmbientCapabilities",
    "ProtectSystem",
    "ProtectHome",
    "PrivateTmp",
    "PrivateDevices",
    "PrivateNetwork",
    "RestrictAddressFamilies",
    "IPAddressDeny",
    "ProtectKernelTunables",
    "ProtectKernelModules",
    "ProtectKernelLogs",
    "ProtectControlGroups",
    "Delegate",
    "DelegateSubgroup",
    "ProtectClock",
    "ProtectHostname",
    "RestrictNamespaces",
    "RestrictRealtime",
    "RestrictSUIDSGID",
    "LockPersonality",
    "RemoveIPC",
    "KeyringMode",
    "SystemCallArchitectures",
    "ReadOnlyPaths",
    "ReadWritePaths",
  ]);
  const required = [
    "Type=exec",
    "User=@SERVICE_USER@",
    "Group=@SERVICE_GROUP@",
    "WorkingDirectory=@RELEASE_ROOT@",
    "ExecStart=@PYTHON@ -I -B -m vertex_host --config @HOST_CONFIG@",
    "Environment=VERTEX_LIVE_EXECUTION=disabled",
    "Environment=PYTHONNOUSERSITE=1",
    "Environment=PYTHONDONTWRITEBYTECODE=1",
    "UnsetEnvironment=PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONINSPECT LD_PRELOAD LD_LIBRARY_PATH BUN_OPTIONS NODE_OPTIONS IBKR_USERNAME IBKR_PASSWORD",
    "Restart=no",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "TimeoutStopSec=infinity",
    "SendSIGKILL=no",
    "FinalKillSignal=SIGTERM",
    "UMask=0077",
    "StandardInput=null",
    "StandardOutput=journal",
    "StandardError=journal",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "PrivateNetwork=no",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "IPAddressDeny=any",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=no",
    "Delegate=cpu memory pids",
    "DelegateSubgroup=host",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictNamespaces=user mnt pid net ipc uts cgroup",
    "RestrictRealtime=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "RemoveIPC=yes",
    "KeyringMode=private",
    "SystemCallArchitectures=native",
    "ReadOnlyPaths=@RELEASE_ROOT@ @HOST_CONFIG@",
    "ReadWritePaths=@STATE_ROOT@ @SANDBOX_CGROUP@",
    "@CONTROL_EGRESS@",
  ];
  let section = "";
  const seen = new Set<string>();
  const serviceRows: string[] = [];
  for (const row of template.split("\n")) {
    if (!row || row.startsWith("#")) continue;
    if (row === "[Unit]" || row === "[Service]") {
      if (seen.has(row)) releaseFailure("unit-section");
      seen.add(row);
      section = row;
      continue;
    }
    if (section === "[Service]" && row === "@CONTROL_EGRESS@") {
      serviceRows.push(row);
      continue;
    }
    const [key = ""] = row.split("=");
    if (
      !(
        section === "[Unit]"
          ? unitKeys
          : section === "[Service]"
            ? serviceKeys
            : new Set<string>()
      ).has(key)
    )
      releaseFailure("unit-directive");
    if (section === "[Service]") serviceRows.push(row);
  }
  if (
    seen.size !== 2 ||
    serviceRows.length !== required.length ||
    required.some(
      (row) => serviceRows.filter((value) => value === row).length !== 1
    )
  )
    releaseFailure("unit-security-profile");
};

export const renderHostUnit = (
  template: string,
  manifest: ReleaseManifest,
  policy: DeploymentPolicy,
  identity: ResolvedServiceIdentity
): string => {
  assertUnitTemplate(template);
  if (
    !(
      [identity.user, identity.group].every((value) =>
        /^[a-z_][a-z0-9_-]{0,31}$/.test(value)
      ) &&
      Number.isSafeInteger(identity.uid) &&
      Number.isSafeInteger(identity.gid)
    ) ||
    identity.uid <= 0 ||
    identity.gid <= 0
  )
    releaseFailure("service-identity");
  const releaseRoot = posix.join(policy.releasesRoot, manifest.releaseId);
  const variables: Record<string, string> = {
    SANDBOX_CGROUP: policy.sandboxCgroupPath,
    STATE_ROOT: policy.stateRoot,
    HOST_CONFIG: policy.hostConfigPath,
    PYTHON: posix.join(releaseRoot, manifest.pythonRelativePath),
    SERVICE_USER: identity.user,
    SERVICE_GROUP: identity.group,
    RELEASE_ROOT: releaseRoot,
    CONTROL_EGRESS: policy.controlEgressAddresses
      .map((address) => `IPAddressAllow=${address}`)
      .join("\n"),
  };
  const rendered = template.replace(
    /@([A-Z_]+)@/g,
    (_match, name: string) => variables[name] ?? releaseFailure("unit-template")
  );
  if (rendered.includes("@") || rendered.length > 16_384)
    releaseFailure("unit-template");
  return rendered;
};
