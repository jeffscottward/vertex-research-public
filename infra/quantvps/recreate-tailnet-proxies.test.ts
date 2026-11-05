import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The tailnet Caddy proxies must mount the tailscaled socket DIRECTORY so that they survive a
// tailscaled restart. The remote program runs locally against fake docker/systemctl/stat
// commands, so no test reaches QuantVPS or changes a container.
const here = (name: string): string =>
  fileURLToPath(new URL(name, import.meta.url));
const script = here("./recreate-tailnet-proxies.sh");
const fileMount =
  "/var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock";
const dirMount = "/var/run/tailscale:/var/run/tailscale:ro";
// Placeholder host config; the real values live only in /etc/vertex/hosts.env on QuantVPS.
const validHosts =
  "VERTEX_TAILNET_HOST=quant-vps-host.example-tailnet.ts.net\nVERTEX_TAILNET_IPV4=100.64.0.10\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const fake = (bin: string, name: string, body: string): void => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

const setup = (containerInode: string, hosts: string | null) => {
  const root = mkdtempSync(join(tmpdir(), "vtx-tailnet-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const file of [
    "opt/vertex-web-tailnet/Caddyfile",
    "opt/vertex-status/Caddyfile.tailnet",
    "opt/vertex-status/token.env",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x\n");
  }
  if (hosts !== null) {
    mkdirSync(join(root, "etc/vertex"), { recursive: true });
    writeFileSync(join(root, "etc/vertex/hosts.env"), hosts);
  }
  mkdirSync(join(root, "var/run/tailscale"), { recursive: true });
  mkdirSync(join(root, "opt/vertex-status/private-v2"), { recursive: true });
  const log = join(root, "calls.log");
  fake(
    bin,
    "docker",
    `echo "docker $*" >> ${log}; [ "$1" = exec ] && echo ${containerInode}; exit 0`
  );
  fake(
    bin,
    "systemctl",
    `echo "systemctl $*" >> ${log}; [ "$1" = show ] && echo yes; exit 0`
  );
  fake(bin, "stat", "echo 111");
  return { bin, log, root };
};

const run = (containerInode: string, hosts: string | null = validHosts) => {
  const env = setup(containerInode, hosts);
  const sock = join(env.root, "var/run/tailscale/tailscaled.sock");
  const bound = spawnSync("python3", [
    "-c",
    `import socket;socket.socket(socket.AF_UNIX).bind(${JSON.stringify(sock)})`,
  ]);
  if (bound.status !== 0) {
    throw new Error(`socket setup failed: ${bound.stderr}`);
  }
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env["PATH"] ?? ""}`,
      VERTEX_TAILNET_ROOT: env.root,
      VERTEX_TAILNET_SSH: "bash -s",
    },
  });
  const calls = existsSync(env.log) ? readFileSync(env.log, "utf8") : "";
  return { ...result, calls, root: env.root };
};

describe("recreate-tailnet-proxies", () => {
  it("installs the drop-in and recreates both proxies with the directory mount", () => {
    const result = run("111");
    expect(result.stdout).toContain("drop-in ok: RuntimeDirectoryPreserve=yes");
    expect(result.stdout).toContain("vertex-web-tailnet inode ok (111)");
    expect(result.stdout).toContain("vertex-status-tailnet inode ok (111)");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("systemctl daemon-reload");
    expect(result.calls).not.toMatch(/systemctl (re)?start|systemctl stop/);
    const runs = result.calls
      .split("\n")
      .filter((line) => line.startsWith("docker run"));
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line).toContain(dirMount);
      expect(line).not.toContain(fileMount);
      for (const flag of [
        "--read-only",
        "--cap-drop ALL",
        "--cap-add NET_BIND_SERVICE",
        "--restart unless-stopped",
        "--network host",
      ]) {
        expect(line).toContain(flag);
      }
    }
    const web = runs.find((line) => line.includes("vertex-web-tailnet"));
    expect(web).toContain("--env-file /etc/vertex/hosts.env");
    const status = runs.find((line) => line.includes("vertex-status-tailnet"));
    for (const flag of [
      "--security-opt no-new-privileges",
      "--memory 64m",
      "--env-file /opt/vertex-status/token.env",
      "-v /opt/vertex-status/private-v2:/srv:ro",
    ]) {
      expect(status).toContain(flag);
    }
    for (const line of result.calls.split("\n")) {
      if (line.startsWith("docker ")) {
        expect(line).toMatch(/vertex-(web|status)-tailnet/);
      }
    }
    expect(
      readFileSync(
        join(
          result.root,
          "etc/systemd/system/tailscaled.service.d/10-vertex-preserve-runtime-dir.conf"
        ),
        "utf8"
      )
    ).toBe(
      readFileSync(here("./tailscaled-preserve-runtime-dir.conf"), "utf8")
    );
  });

  it("exits 4 when a container does not see the host socket inode", () => {
    const result = run("999");
    expect(result.stdout).toContain("inode MISMATCH");
    expect(result.status).toBe(4);
  });

  it.each([
    ["no host config file", null],
    [
      "an empty host name",
      "VERTEX_TAILNET_HOST=\nVERTEX_TAILNET_IPV4=100.64.0.10\n",
    ],
    [
      "a host outside ts.net",
      "VERTEX_TAILNET_HOST=evil.example.com\nVERTEX_TAILNET_IPV4=100.64.0.10\n",
    ],
    [
      "a non-tailnet IPv4",
      "VERTEX_TAILNET_HOST=quant-vps-host.example-tailnet.ts.net\nVERTEX_TAILNET_IPV4=0.0.0.0\n",
    ],
  ])("changes nothing (exit 3) with %s", (_name, hosts) => {
    const result = run("111", hosts);
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /VERTEX_TAILNET_(HOST|IPV4) missing or malformed in \/etc\/vertex\/hosts\.env; nothing changed/u
    );
    expect(result.calls).toBe("");
  });

  it("keeps every install script on the directory mount", () => {
    const install = readFileSync(
      here("../quant-vps/status/install-tailnet.sh"),
      "utf8"
    );
    expect(install).toContain(dirMount);
    expect(install).not.toContain(fileMount);
    expect(install).toContain("RuntimeDirectoryPreserve=yes");
    expect(
      readFileSync(here("./tailscaled-preserve-runtime-dir.conf"), "utf8")
    ).toMatch(/^RuntimeDirectoryPreserve=yes$/m);
  });
});
