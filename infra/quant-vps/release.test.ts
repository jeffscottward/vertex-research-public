import { describe, expect, it } from "vitest";
import {
  assertCompatibleJournal,
  assertDeploymentLayout,
  assertDrainReceipt,
  assertManifestInventory,
  runHostRelease,
  type ReleasePorts,
} from "./release.ts";
import { sha256 } from "./authority.ts";
import type {
  DeploymentPolicy,
  ReleaseManifest,
  ReleaseRequest,
  DrainReceipt,
} from "./contract.ts";

// Synthetic identities only. These fixtures do not name a real host or account.
const digest = "a".repeat(64);
const manifest: ReleaseManifest = {
  format: "vertex-host-release-v1",
  releaseId: "synthetic-next",
  sourceCommit: "a".repeat(40),
  platform: "linux-x86_64",
  pythonVersion: "3.12.11",
  mode: "paper",
  liveExecution: false,
  pythonRelativePath: "runtime/python",
  hostEntrypointRelativePath: "host/__main__.py",
  contractAuthorityRelativePath: "contract/authority.json",
  dependencyLockRelativePath: "dependency.lock",
  toolchainManifestRelativePath: "toolchain.json",
  journal: {
    format: "vertex-execution-journal-v1",
    authorityRelativePath: "execution/journal.py",
    authoritySha256: digest,
  },
  directories: ["runtime", "host", "contract", "execution"],
  files: [
    "runtime/python",
    "host/__main__.py",
    "contract/authority.json",
    "dependency.lock",
    "toolchain.json",
    "execution/journal.py",
  ].map((path) => ({
    path,
    sha256: digest,
    size: 1,
    mode: path === "runtime/python" ? ("0555" as const) : ("0444" as const),
  })),
};
const policy: DeploymentPolicy = {
  format: "vertex-host-deployment-policy-v1",
  hostRef: "synthetic:host",
  serviceUserRef: "synthetic:user",
  serviceGroupRef: "synthetic:group",
  releaseApprovalKeyRef: "synthetic:approval",
  hostTrustKeyRef: "synthetic:trust",
  machineIdentityPath: "/synthetic/machine-id",
  sshHostPublicKeyPath: "/synthetic/ssh/host.pub",
  releasesRoot: "/synthetic/releases",
  activeLinkPath: "/synthetic/current",
  stateRoot: "/synthetic/state",
  sandboxCgroupPath: "/sys/fs/cgroup/system.slice/vertex-host.service",
  ownerLockPath: "/synthetic/state/host.owner",
  operationLogPath: "/synthetic/admin/operations.jsonl",
  lockPath: "/synthetic/admin/operation.lock",
  activeRecordPath: "/synthetic/admin/active.json",
  hostConfigPath: "/synthetic/config/host.json",
  hostConfigSha256: digest,
  journalPath: "/synthetic/state/journal.sqlite",
  drainRequestPath: "/synthetic/state/drain-request.json",
  drainReceiptPath: "/synthetic/state/drain-receipt.json",
  readinessReceiptPath: "/synthetic/state/ready.json",
  unitPath: "/synthetic/systemd/vertex-host.service",
  unitName: "vertex-host.service",
  unitTemplateSha256: digest,
  systemctlPath: "/synthetic/bin/systemctl",
  systemctlSha256: digest,
  controlEgressAddresses: ["192.0.2.1"],
  drainTimeoutMs: 1000,
  startTimeoutMs: 1000,
};
const receipt: DrainReceipt = {
  format: "vertex-host-drain-v1",
  requestId: "b".repeat(32),
  releaseId: "synthetic-old",
  instanceId: "synthetic:old-instance",
  accountAlias: "synthetic:account",
  environment: "paper",
  ownerEpoch: "9007199254740993",
  journalSequence: "9007199254740994",
  journalHeadSha256: digest,
  journalIdentity: "synthetic:journal",
  journalSchema: "vertex-execution-journal-v1",
  projectionPending: false,
  activeJobs: 0,
  admissionsClosed: true,
  pendingDispatch: 0,
  ownerFenceReleased: true,
  completedAtNs: "1790000000000000000",
  outcome: "drained",
};
const current = {
  manifest: { ...manifest, releaseId: "synthetic-old" },
  manifestSha256: "c".repeat(64),
  instanceId: receipt.instanceId,
  accountAlias: receipt.accountAlias,
  environment: "paper" as const,
  journalIdentity: receipt.journalIdentity,
  journalPath: policy.journalPath,
  configSha256: "e".repeat(64),
  unitSha256: "f".repeat(64),
  state: "active" as const,
};
const fixture = (action: ReleaseRequest["action"] = "release") => {
  const manifestBytes = Buffer.from(
    JSON.stringify(action === "drain" ? current.manifest : manifest)
  );
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const request: ReleaseRequest = {
    format: "vertex-host-release-request-v1",
    requestId: receipt.requestId,
    action,
    targetManifestSha256:
      action === "drain" ? current.manifestSha256 : sha256(manifestBytes),
    currentManifestSha256: current.manifestSha256,
    policySha256: sha256(policyBytes),
  };
  // The current digest is computed from exact fixture bytes for a drain target.
  const selectedCurrent =
    action === "drain"
      ? { ...current, manifestSha256: sha256(manifestBytes) }
      : current;
  if (action === "drain") {
    request.targetManifestSha256 = selectedCurrent.manifestSha256;
    request.currentManifestSha256 = selectedCurrent.manifestSha256;
  }
  const calls: string[] = [];
  const record = async (phase: string): Promise<void> => {
    calls.push(phase);
  };
  const ports: ReleasePorts = {
    withExclusiveLock: async (work) => work(),
    authorize: async () => record("authorize"),
    loadCurrent: async () => selectedCurrent,
    verifyCandidate: async () => record("verify-candidate"),
    verifyCurrent: async () => record("verify-current"),
    record: async (phase) => record(`record:${phase}`),
    ensureUnusedRequest: async () => record("unused"),
    requestDrain: async () => record("request-drain"),
    waitForDrain: async () => ({ receipt, inactive: true }),
    preserve: async () => record("preserve"),
    activate: async () => record("activate"),
    start: async () => record("start"),
    confirmStarted: async () => record("confirm-started"),
  };
  return { input: { request, policyBytes, manifestBytes }, ports, calls };
};

describe("reviewed local host release", () => {
  it("drains and confirms inactive before activation and never migrates a journal", async () => {
    const f = fixture();
    await runHostRelease(f.input, f.ports);
    expect(f.calls.indexOf("request-drain")).toBeLessThan(
      f.calls.indexOf("preserve")
    );
    expect(f.calls.indexOf("preserve")).toBeLessThan(
      f.calls.indexOf("activate")
    );
    return expect(f.calls.indexOf("activate")).toBeLessThan(
      f.calls.indexOf("start")
    );
  });
  it("blocks missing approval before drain or activation", async () => {
    const f = fixture();
    f.ports.authorize = async () => {
      throw new Error("denied");
    };
    await expect(runHostRelease(f.input, f.ports)).rejects.toThrow();
    expect(f.calls).not.toContain("request-drain");
    return expect(f.calls).not.toContain("activate");
  });
  it.each([
    "pending-publications",
    "outstanding-dispatch",
    "stale-request",
    "still-active",
  ])("blocks %s without switch", async (problem) => {
    const f = fixture();
    const bad = { ...receipt };
    if (problem === "pending-publications") bad.projectionPending = true;
    if (problem === "outstanding-dispatch") bad.pendingDispatch = 1;
    if (problem === "stale-request") bad.requestId = "d".repeat(32);
    f.ports.waitForDrain = async () => ({
      receipt: bad,
      inactive: problem !== "still-active",
    });
    await expect(runHostRelease(f.input, f.ports)).rejects.toThrow();
    return expect(f.calls).not.toContain("activate");
  });
  it("does not reactivate a prior release after a failed start", async () => {
    const f = fixture();
    f.ports.start = async () => {
      throw new Error("start-failed");
    };
    await expect(runHostRelease(f.input, f.ports)).rejects.toThrow();
    expect(f.calls.filter((call) => call === "activate")).toHaveLength(1);
    return expect(f.calls).toContain("record:interrupted");
  });
  it("drain-only never switches or starts", async () => {
    const f = fixture("drain");
    await runHostRelease(f.input, f.ports);
    expect(f.calls).not.toContain("activate");
    return expect(f.calls).not.toContain("start");
  });
  it("rollback refuses a journal authority change", () => {
    return expect(() =>
      assertCompatibleJournal(current.manifest, {
        ...manifest,
        journal: { ...manifest.journal, authoritySha256: "f".repeat(64) },
      })
    ).toThrow("journal-incompatible");
  });
  it("keeps decimal journal positions above JavaScript precision intact", () => {
    return expect(
      assertDrainReceipt(receipt, receipt.requestId, current).journalSequence
    ).toBe("9007199254740994");
  });
  it("rejects changed manifest bytes before authorizing", async () => {
    const f = fixture();
    f.input.manifestBytes = Buffer.from(
      JSON.stringify({ ...manifest, releaseId: "tampered" })
    );
    await expect(runHostRelease(f.input, f.ports)).rejects.toThrow(
      "manifest-digest"
    );
    return expect(f.calls).toHaveLength(0);
  });
  it("requires fresh approval again after draining before switching", async () => {
    const f = fixture();
    let approvals = 0;
    f.ports.authorize = async () => {
      if (++approvals === 4) throw new Error("expired");
      return;
    };
    await expect(runHostRelease(f.input, f.ports)).rejects.toThrow("expired");
    expect(f.calls).toContain("request-drain");
    return expect(f.calls).not.toContain("activate");
  });
  it("performs an explicitly authorized compatible rollback through the same drain gate", async () => {
    const f = fixture("rollback");
    const result = await runHostRelease(f.input, f.ports);
    expect(result.action).toBe("rollback");
    return expect(f.calls.indexOf("request-drain")).toBeLessThan(
      f.calls.indexOf("activate")
    );
  });
  it.each([
    { stateRoot: "/synthetic/releases/state" },
    { journalPath: "/synthetic/releases/journal.sqlite" },
    { unitPath: "/synthetic/state/vertex-host.service" },
    { activeRecordPath: "/synthetic/state/active.json" },
    { readinessReceiptPath: policy.drainReceiptPath },
    { sandboxCgroupPath: "/sys/fs/cgroup" },
  ])("rejects journal and deployment authority path overlap", (changes) => {
    return expect(() =>
      assertDeploymentLayout({ ...policy, ...changes })
    ).toThrow();
  });
  return it("requires exact inventory for role bytes and empty sandbox mountpoint directories", () => {
    expect(() =>
      assertManifestInventory({
        ...manifest,
        directories: [
          ...manifest.directories,
          "sandbox",
          "sandbox/proc",
          "sandbox/dev",
          "sandbox/tmp",
        ],
      })
    ).not.toThrow();
    expect(() =>
      assertManifestInventory({ ...manifest, directories: [] })
    ).toThrow("manifest-parent");
    expect(() =>
      assertManifestInventory({
        ...manifest,
        directories: [...manifest.directories, "runtime/python"],
      })
    ).toThrow("manifest-directories");
    return expect(() =>
      assertManifestInventory({ ...manifest, files: manifest.files.slice(1) })
    ).toThrow("manifest-role");
  });
});
