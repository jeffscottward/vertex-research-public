import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertUnitTemplate,
  parseDeploymentHostConfig,
  renderHostUnit,
} from "./service.ts";
import type { DeploymentPolicy, ReleaseManifest } from "./contract.ts";

const template = () =>
  readFile(
    new URL("./systemd/vertex-host.service.in", import.meta.url),
    "utf8"
  );
const manifest = {
  releaseId: "synthetic-release",
  pythonRelativePath: "runtime/python",
} as ReleaseManifest;
const policy = {
  releasesRoot: "/synthetic/releases",
  stateRoot: "/synthetic/state",
  hostConfigPath: "/synthetic/config/host.json",
  sandboxCgroupPath: "/sys/fs/cgroup/system.slice/vertex-host.service",
  controlEgressAddresses: ["192.0.2.1", "2001:db8::1"],
} as DeploymentPolicy;
const identity = {
  user: "synthetic_vertex",
  group: "synthetic_vertex",
  uid: 1999,
  gid: 1999,
};
const hostConfig = {
  format: "vertex-host-v1",
  releaseId: "synthetic-release",
  instanceId: "synthetic:instance",
  accountAlias: "synthetic:account",
  environment: "research",
  liveExecution: false,
  startupMode: "initialize",
  journalIdentity: null,
  journalPath: null,
  drainRequestPath: "/synthetic/state/request.json",
  drainReceiptPath: "/synthetic/state/drain.json",
  readinessReceiptPath: "/synthetic/state/ready.json",
  ownerLockPath: "/synthetic/state/host.owner",
  sandbox: {
    cgroup_root: policy.sandboxCgroupPath,
    rootfs: "/synthetic/releases/synthetic-release/rootfs",
    bwrap_path: "/synthetic/releases/synthetic-release/runtime/bwrap",
    bwrap_sha256: "a".repeat(64),
  },
  nativeAdmin: null,
  contractBundle: {
    path: "/synthetic/releases/synthetic-release/contract.json",
    sha256: "a".repeat(64),
  },
  control: {
    origin: "https://control.example.invalid",
    credentialRef: "synthetic:control-credential",
  },
};

describe("reviewed service unit", () => {
  it("launches the explicit Python module/config and delegates only the reviewed sandbox", async () => {
    const text = renderHostUnit(await template(), manifest, policy, identity);
    expect(text).toContain(
      "ExecStart=/synthetic/releases/synthetic-release/runtime/python -I -B -m vertex_host --config /synthetic/config/host.json"
    );
    expect(text).toContain("User=synthetic_vertex");
    expect(text).toContain("Delegate=cpu memory pids");
    expect(text).toContain("DelegateSubgroup=host");
    expect(text).toContain(
      "ReadWritePaths=/synthetic/state /sys/fs/cgroup/system.slice/vertex-host.service"
    );
    expect(text).toContain("IPAddressDeny=any");
    expect(text).toContain("IPAddressAllow=192.0.2.1");
    expect(text).not.toContain("[Install]");
    return expect(text).not.toContain("@");
  });
  it.each([
    ["Restart=no", "Restart=always"],
    ["SendSIGKILL=no", "SendSIGKILL=yes"],
    ["TimeoutStopSec=infinity", "TimeoutStopSec=30"],
    ["NoNewPrivileges=yes", "NoNewPrivileges=no"],
    ["IPAddressDeny=any", "IPAddressDeny="],
    [
      "Environment=VERTEX_LIVE_EXECUTION=disabled",
      "Environment=VERTEX_LIVE_EXECUTION=enabled",
    ],
    [
      "ExecStart=@PYTHON@ -I -B -m vertex_host --config @HOST_CONFIG@",
      "ExecStart=/bin/sh -c start",
    ],
  ])("rejects weakening %s", async (before, after) => {
    const source = await template();
    return expect(() =>
      assertUnitTemplate(source.replace(before, after))
    ).toThrow();
  });
  it("rejects extra commands and environment loaders", async () => {
    const source = await template();
    for (const directive of [
      "ExecStartPre=/bin/sh -c anything",
      "EnvironmentFile=/etc/unreviewed.env",
      "LoadCredential=secret:/etc/secret",
      "Restart=no",
    ]) {
      expect(() => assertUnitTemplate(`${source}\n${directive}\n`)).toThrow();
    }
  });
  return it("refuses root or interpolated service identities", async () => {
    const source = await template();
    expect(() =>
      renderHostUnit(source, manifest, policy, { ...identity, uid: 0 })
    ).toThrow("service-identity");
    return expect(() =>
      renderHostUnit(source, manifest, policy, {
        ...identity,
        user: "name\nExecStart=/bin/sh",
      })
    ).toThrow("service-identity");
  });
});

describe("nonlive host configuration projection", () => {
  it("accepts explicit reference-only nonlive research identity", () => {
    return expect(parseDeploymentHostConfig(hostConfig).liveExecution).toBe(
      false
    );
  });
  return it.each([
    { liveExecution: true },
    { environment: "live" },
    { journalPath: "/synthetic/state/journal.sqlite" },
    {
      control: {
        origin: "http://control.example.invalid",
        credentialRef: "synthetic:credential",
      },
    },
    {
      control: {
        origin: "https://user:password@control.example.invalid",
        credentialRef: "synthetic:credential",
      },
    },
  ])("rejects unsafe configuration", (changes) => {
    return expect(() =>
      parseDeploymentHostConfig({ ...hostConfig, ...changes })
    ).toThrow();
  });
});
