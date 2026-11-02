import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, rename, symlink } from "node:fs/promises";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  deploymentPolicySchema,
  digestSchema,
  parseBoundedJson,
  referenceSchema,
  releaseFailure,
  releaseIdSchema,
  releaseManifestSchema,
  signedReceiptSchema,
  type ResolvedServiceIdentity,
} from "./contract.ts";
import {
  authorizeHostRelease,
  sha256,
  type PublicKeyResolver,
} from "./authority.ts";
import {
  assertManifestInventory,
  runHostRelease,
  type CurrentRelease,
  type ReleaseContext,
  type ReleasePorts,
} from "./release.ts";
import {
  bindHostConfiguration,
  parseDeploymentHostConfig,
  renderHostUnit,
} from "./service.ts";
import {
  assertSafeParents,
  assertSealedRelease,
  atomicWrite,
  exclusiveFileLock,
  fingerprintFile,
  pathExists,
  readSafeFile,
  syncDirectory,
} from "./filesystem.ts";

const activeRecordSchema = z
  .object({
    format: z.literal("vertex-host-active-release-v1"),
    releaseId: releaseIdSchema,
    manifestSha256: digestSchema,
    configSha256: digestSchema,
    unitSha256: digestSchema,
    instanceId: referenceSchema,
    accountAlias: referenceSchema,
    environment: z.enum(["research", "paper"]),
    journalIdentity: referenceSchema.nullable(),
    journalPath: z.string().nullable(),
  })
  .strict();

const readyReceiptSchema = z
  .object({
    format: z.literal("vertex-host-ready-v1"),
    releaseId: releaseIdSchema,
    instanceId: referenceSchema,
    accountAlias: referenceSchema,
    environment: z.enum(["research", "paper"]),
    journalIdentity: referenceSchema.nullable(),
    liveExecution: z.literal(false),
    startupMode: z.enum(["initialize", "restore"]),
    status: z.enum(["ready", "unavailable", "draining"]),
    observedAtNs: z.string().regex(/^[1-9][0-9]{0,29}$/),
    processId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reasonCodes: z.array(z.string().regex(/^[a-z0-9-]{1,100}$/)).max(64),
  })
  .strict();

export type LocalReleaseInput = Readonly<{
  request: unknown;
  policyBytes: Uint8Array;
  manifestBytes: Uint8Array;
  hostConfigBytes: Uint8Array;
  unitTemplateBytes: Uint8Array;
  approvalReceipt: unknown;
  hostTrustReceipt: unknown;
  resolvePublicKey: PublicKeyResolver;
  resolveServiceIdentity: (
    userRef: string,
    groupRef: string
  ) => Promise<ResolvedServiceIdentity>;
}>;

type UnitObservation = Readonly<{
  state: "active" | "inactive" | "transition";
  pid: number;
}>;

// No module entrypoint, implicit environment loader, SSH client, password/login,
// package manager, shell, account creation, or unit enablement exists here.
// A release authority must explicitly compose this operation with key/identity
// reference resolvers and supply the exact reviewed candidate bytes.
export const runLocalHostRelease = async (input: LocalReleaseInput) => {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.getuid?.() !== 0
  )
    releaseFailure("local-release-identity");
  const policyBytes = Buffer.from(input.policyBytes);
  const manifestBytes = Buffer.from(input.manifestBytes);
  const hostConfigBytes = Buffer.from(input.hostConfigBytes);
  const templateBytes = Buffer.from(input.unitTemplateBytes);
  const policy = deploymentPolicySchema.parse(
    parseBoundedJson(policyBytes, 32_768)
  );
  const approval = signedReceiptSchema.parse(input.approvalReceipt);
  const trust = signedReceiptSchema.parse(input.hostTrustReceipt);
  if (
    sha256(hostConfigBytes) !== policy.hostConfigSha256 ||
    sha256(templateBytes) !== policy.unitTemplateSha256
  )
    releaseFailure("service-input-digest");
  const candidateConfig = parseDeploymentHostConfig(
    parseBoundedJson(hostConfigBytes, 262_144)
  );
  let identity: ResolvedServiceIdentity | undefined;
  let unitBytes: Buffer | undefined;
  let preservedJournal: Readonly<Record<string, string>> | undefined;
  let startRequestedAtNs: bigint | undefined;
  const resolvedIdentity = (): ResolvedServiceIdentity =>
    identity ?? releaseFailure("unresolved-identity");
  const state = () => ({ path: policy.stateRoot, uid: resolvedIdentity().uid });

  const systemctl = async (args: readonly string[]): Promise<string> => {
    const binary = await fingerprintFile(policy.systemctlPath, 0);
    if (binary.split(":").at(-1) !== policy.systemctlSha256)
      releaseFailure("systemctl-digest");
    return new Promise((resolve, reject) => {
      return execFile(
        policy.systemctlPath,
        ["--no-pager", "--no-ask-password", ...args],
        {
          env: {
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin",
            SYSTEMD_PAGER: "",
            SYSTEMD_COLORS: "0",
          },
          timeout: 30_000,
          maxBuffer: 65_536,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => {
          if (error && !(args[0] === "show" && error.code === 4)) {
            return reject(new Error("vertex-host-release:systemctl-failed"));
          }
          return resolve(stdout);
        }
      );
    });
  };

  const observeUnit = async (): Promise<UnitObservation> => {
    const output = await systemctl([
      "show",
      policy.unitName,
      "--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload",
    ]);
    const properties = new Map(
      output
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)] as const;
        })
    );
    if (!["loaded", "not-found"].includes(properties.get("LoadState") ?? ""))
      releaseFailure("unit-load-state");
    const fragment = properties.get("FragmentPath");
    if (
      (fragment && fragment !== policy.unitPath) ||
      properties.get("DropInPaths")
    )
      releaseFailure("unit-override");
    const pidText = properties.get("MainPID");
    if (!(pidText && /^(?:0|[1-9][0-9]*)$/.test(pidText)))
      releaseFailure("unit-observation");
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid)) releaseFailure("unit-observation");
    const active = properties.get("ActiveState");
    const sub = properties.get("SubState");
    if (
      active === "active" &&
      pid > 0 &&
      sub === "running" &&
      properties.get("NeedDaemonReload") === "no"
    )
      return { state: "active", pid };
    if (
      (active === "inactive" || active === "failed") &&
      (sub === "dead" || sub === "failed") &&
      pid === 0
    )
      return { state: "inactive", pid: 0 };
    return { state: "transition", pid };
  };

  const assertInactive = async (): Promise<void> => {
    if ((await observeUnit()).state !== "inactive")
      releaseFailure("owner-still-active");
  };

  const journalSnapshot = async (
    environment: "research" | "paper"
  ): Promise<Readonly<Record<string, string>>> => {
    const snapshot: Record<string, string> = {};
    if (environment === "research") return snapshot;
    for (const suffix of ["", ".owner", "-wal", "-shm", "-journal"]) {
      const path = `${policy.journalPath}${suffix}`;
      if (await pathExists(path))
        snapshot[suffix] = await fingerprintFile(path, state().uid, state());
    }
    return snapshot;
  };

  const assertPreserved = async (context: ReleaseContext): Promise<void> => {
    if (
      !preservedJournal ||
      JSON.stringify(await journalSnapshot(context.manifest.mode)) !==
        JSON.stringify(preservedJournal)
    )
      releaseFailure("journal-drift");
  };

  const readLog = async (): Promise<readonly Record<string, unknown>[]> => {
    if (!(await pathExists(policy.operationLogPath))) return [];
    const bytes = await readSafeFile(policy.operationLogPath, 16_777_216);
    return bytes
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = parseBoundedJson(Buffer.from(line), 4096);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          return releaseFailure("operation-log");
        return parsed as Record<string, unknown>;
      });
  };

  const ports: ReleasePorts = {
    withExclusiveLock: (work) => exclusiveFileLock(policy.lockPath, work),
    authorize: async (context) => {
      const machine = await readSafeFile(policy.machineIdentityPath, 4096);
      const publicHostKey = await readSafeFile(
        policy.sshHostPublicKeyPath,
        16_384
      );
      const [keyType, keyData] = publicHostKey
        .toString("utf8")
        .trim()
        .split(/\s+/);
      if (
        keyType === undefined ||
        keyData === undefined ||
        ![
          "ssh-ed25519",
          "ssh-rsa",
          "ecdsa-sha2-nistp256",
          "ecdsa-sha2-nistp384",
          "ecdsa-sha2-nistp521",
        ].includes(keyType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(keyData)
      )
        releaseFailure("host-public-key");
      const sshHostKeyFingerprint = `SHA256:${createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/[=]+$/, "")}`;
      await authorizeHostRelease(
        {
          request: context.request,
          policy: context.policy,
          machineIdentitySha256: sha256(machine),
          sshHostKeyFingerprint,
          approval,
          hostTrust: trust,
          nowMs: Date.now(),
        },
        input.resolvePublicKey
      );
      if (!identity) {
        identity = await input.resolveServiceIdentity(
          policy.serviceUserRef,
          policy.serviceGroupRef
        );
        unitBytes = Buffer.from(
          renderHostUnit(
            templateBytes.toString("utf8"),
            context.manifest,
            policy,
            identity
          )
        );
      }
      return await assertSafeParents(`${policy.stateRoot}/.ownership`, state());
    },
    loadCurrent: async () => {
      const observed = await observeUnit();
      if (!(await pathExists(policy.activeRecordPath))) {
        if (await pathExists(policy.activeLinkPath))
          releaseFailure("unrecorded-release");
        if (observed.state !== "inactive") releaseFailure("unrecorded-owner");
        return null;
      }
      const record = activeRecordSchema.parse(
        parseBoundedJson(await readSafeFile(policy.activeRecordPath, 16_384))
      );
      const root = posix.join(policy.releasesRoot, record.releaseId);
      const bytes = await readSafeFile(
        posix.join(root, "release-manifest.json"),
        16_777_216
      );
      if (sha256(bytes) !== record.manifestSha256)
        releaseFailure("current-manifest-drift");
      const manifest = releaseManifestSchema.parse(
        parseBoundedJson(bytes, 16_777_216)
      );
      assertManifestInventory(manifest);
      if (
        manifest.releaseId !== record.releaseId ||
        manifest.mode !== record.environment ||
        observed.state === "transition"
      )
        releaseFailure("current-state");
      await assertSafeParents(policy.activeLinkPath);
      const link = await lstat(policy.activeLinkPath);
      if (
        !link.isSymbolicLink() ||
        link.uid !== 0 ||
        (await readlink(policy.activeLinkPath)) !== root
      )
        releaseFailure("active-pointer");
      const { format: _format, releaseId: _releaseId, ...current } = record;
      return { ...current, manifest, state: observed.state } as CurrentRelease;
    },
    verifyCurrent: async (context) => {
      if (!context.current) return;
      if (context.current.state !== "active")
        releaseFailure("inactive-owner-requires-reviewed-recovery");
      const currentConfigBytes = await readSafeFile(
        policy.hostConfigPath,
        262_144
      );
      const currentConfig = parseDeploymentHostConfig(
        parseBoundedJson(currentConfigBytes)
      );
      if (
        sha256(currentConfigBytes) !== context.current.configSha256 ||
        sha256(await readSafeFile(policy.unitPath, 16_384)) !==
          context.current.unitSha256
      )
        releaseFailure("current-service-drift");
      if (
        currentConfig.instanceId !== context.current.instanceId ||
        currentConfig.releaseId !== context.current.manifest.releaseId ||
        currentConfig.accountAlias !== context.current.accountAlias ||
        currentConfig.environment !== context.current.environment ||
        currentConfig.journalIdentity !== context.current.journalIdentity ||
        currentConfig.journalPath !== context.current.journalPath ||
        currentConfig.drainRequestPath !== policy.drainRequestPath ||
        currentConfig.drainReceiptPath !== policy.drainReceiptPath ||
        currentConfig.readinessReceiptPath !== policy.readinessReceiptPath ||
        currentConfig.ownerLockPath !== policy.ownerLockPath ||
        currentConfig.sandbox.cgroup_root !== policy.sandboxCgroupPath
      )
        releaseFailure("current-config-drift");
      return await assertSealedRelease(
        posix.join(policy.releasesRoot, context.current.manifest.releaseId),
        context.current.manifest,
        context.current.manifestSha256
      );
    },
    verifyCandidate: async (context) => {
      if (context.request.action === "drain") {
        if (sha256(hostConfigBytes) !== context.current?.configSha256)
          releaseFailure("drain-config");
        return;
      }
      bindHostConfiguration(
        candidateConfig,
        context.manifest,
        policy,
        context.current
      );
      await assertSealedRelease(
        posix.join(policy.releasesRoot, context.manifest.releaseId),
        context.manifest,
        context.request.targetManifestSha256
      );
      if (
        !context.current &&
        context.manifest.mode === "paper" &&
        Object.keys(await journalSnapshot("paper")).length !== 0
      )
        return releaseFailure("existing-journal-initialize");
      return;
    },
    ensureUnusedRequest: async (context) => {
      const records = await readLog();
      if (
        records.some(
          (record) => record["requestId"] === context.request.requestId
        )
      )
        releaseFailure("request-replay");
      const previous = records.at(-1);
      if (previous && previous["phase"] !== "completed")
        return releaseFailure(
          "interrupted-operation-requires-reviewed-recovery"
        );
      return;
    },
    record: async (phase, context) => {
      await assertSafeParents(policy.operationLogPath);
      const file = await open(
        policy.operationLogPath,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== 0 ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0
        )
          releaseFailure("operation-log-owner");
        const row = {
          format: "vertex-host-operation-v1",
          requestId: context.request.requestId,
          action: context.request.action,
          phase,
          hostRef: policy.hostRef,
          releaseId: context.manifest.releaseId,
          manifestSha256: context.request.targetManifestSha256,
          policySha256: context.request.policySha256,
        };
        await file.writeFile(`${JSON.stringify(row)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      return await syncDirectory(posix.dirname(policy.operationLogPath));
    },
    requestDrain: async (context) => {
      const current = context.current;
      if (!current || (await observeUnit()).state !== "active")
        releaseFailure("drain-owner");
      const request = {
        format: "vertex-host-drain-request-v1",
        requestId: context.request.requestId,
        releaseId: current.manifest.releaseId,
        instanceId: current.instanceId,
      };
      await atomicWrite(
        policy.drainRequestPath,
        Buffer.from(JSON.stringify(request)),
        context.request.requestId,
        0o640,
        { uid: 0, gid: resolvedIdentity().gid },
        state()
      );
      await systemctl([
        "kill",
        "--kill-whom=main",
        "--signal=SIGTERM",
        policy.unitName,
      ]);
    },
    waitForDrain: async () => {
      const deadline = performance.now() + policy.drainTimeoutMs;
      while (performance.now() < deadline) {
        if ((await observeUnit()).state === "inactive") {
          const receipt = parseBoundedJson(
            await readSafeFile(
              policy.drainReceiptPath,
              16_384,
              state().uid,
              state()
            )
          );
          return { receipt, inactive: true };
        }
        await delay(100);
      }
      return releaseFailure("drain-timeout-no-force-stop");
    },
    preserve: async (context, receipt) => {
      await assertInactive();
      preservedJournal = await journalSnapshot(context.manifest.mode);
      if (
        context.current &&
        context.manifest.mode === "paper" &&
        !preservedJournal[""]
      )
        releaseFailure("journal-missing");
      const evidence = {
        format: "vertex-host-preservation-v1",
        requestId: context.request.requestId,
        previous: context.current,
        receipt,
        journalFiles: preservedJournal,
      };
      await atomicWrite(
        `${policy.activeRecordPath}.${context.request.requestId}.preserved`,
        Buffer.from(JSON.stringify(evidence)),
        context.request.requestId
      );
      if (context.current) {
        await atomicWrite(
          `${policy.hostConfigPath}.${context.request.requestId}.previous`,
          await readSafeFile(policy.hostConfigPath, 262_144),
          context.request.requestId
        );
        return await atomicWrite(
          `${policy.unitPath}.${context.request.requestId}.previous`,
          await readSafeFile(policy.unitPath, 16_384),
          context.request.requestId
        );
      }
      return;
    },
    activate: async (context) => {
      await assertInactive();
      await assertPreserved(context);
      if (!(unitBytes && identity)) releaseFailure("service-unresolved");
      await atomicWrite(
        policy.hostConfigPath,
        hostConfigBytes,
        context.request.requestId,
        0o640,
        { uid: 0, gid: identity.gid }
      );
      await atomicWrite(
        policy.unitPath,
        unitBytes,
        context.request.requestId,
        0o644
      );
      await assertSafeParents(policy.activeLinkPath);
      const pending = `${policy.activeLinkPath}.${context.request.requestId}.pending`;
      await symlink(
        posix.join(policy.releasesRoot, context.manifest.releaseId),
        pending
      );
      await rename(pending, policy.activeLinkPath);
      await syncDirectory(posix.dirname(policy.activeLinkPath));
      const record = {
        format: "vertex-host-active-release-v1",
        releaseId: context.manifest.releaseId,
        manifestSha256: context.request.targetManifestSha256,
        configSha256: policy.hostConfigSha256,
        unitSha256: sha256(unitBytes),
        instanceId: candidateConfig.instanceId,
        accountAlias: candidateConfig.accountAlias,
        environment: candidateConfig.environment,
        journalIdentity: candidateConfig.journalIdentity,
        journalPath: candidateConfig.journalPath,
      };
      await atomicWrite(
        policy.activeRecordPath,
        Buffer.from(JSON.stringify(record)),
        context.request.requestId
      );
      await systemctl(["daemon-reload"]);
      return await assertInactive();
    },
    start: async (context) => {
      await assertInactive();
      await assertPreserved(context);
      startRequestedAtNs = BigInt(Date.now()) * 1_000_000n;
      await systemctl(["start", policy.unitName]);
    },
    confirmStarted: async (context) => {
      const deadline = performance.now() + policy.startTimeoutMs;
      while (performance.now() < deadline) {
        const observed = await observeUnit();
        if (
          observed.state === "active" &&
          (await pathExists(policy.readinessReceiptPath))
        ) {
          const ready = readyReceiptSchema.parse(
            parseBoundedJson(
              await readSafeFile(
                policy.readinessReceiptPath,
                16_384,
                state().uid,
                state()
              )
            )
          );
          const matches =
            ready.releaseId === context.manifest.releaseId &&
            ready.instanceId === candidateConfig.instanceId &&
            ready.accountAlias === candidateConfig.accountAlias &&
            ready.environment === candidateConfig.environment &&
            ready.journalIdentity === candidateConfig.journalIdentity &&
            ready.startupMode === candidateConfig.startupMode &&
            ready.processId === observed.pid &&
            startRequestedAtNs !== undefined &&
            BigInt(ready.observedAtNs) >= startRequestedAtNs;
          if (
            matches &&
            ready.status === "ready" &&
            ready.reasonCodes.length === 0
          ) {
            if ((await observeUnit()).pid !== observed.pid)
              releaseFailure("readiness-process-drift");
            return;
          }
        }
        if (observed.state === "inactive")
          releaseFailure("start-failed-no-automatic-rollback");
        await delay(100);
      }
      return releaseFailure("start-timeout-no-automatic-rollback");
    },
  };
  return await runHostRelease(
    { request: input.request, policyBytes, manifestBytes },
    ports
  );
};
