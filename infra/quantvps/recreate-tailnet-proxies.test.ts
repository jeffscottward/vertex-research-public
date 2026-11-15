import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
// vertex-web-tailnet reads its Caddyfile from a mounted DIRECTORY that holds only the committed
// template, so a replaced file is visible in the container and no host value is in the mount.
const caddyMount = "-v /opt/vertex-web-tailnet/caddy:/etc/caddy:ro";
const template = readFileSync(here("./Caddyfile"), "utf8");
const literal = "old file with literal host values\n";
const webDir = "opt/vertex-web-tailnet";
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

interface Fake {
  readonly args?: readonly string[];
  readonly hosts?: string | null;
  /** Content of the installed caddy/Caddyfile; null leaves the old single-file layout. */
  readonly installed?: string | null;
  readonly mounts?: string;
  /** Content of Caddyfile.prev, the file that a stopped --caddyfile-only run left. */
  readonly prev?: string;
  readonly reloadRc?: number;
  /** Exit code of `docker run -d`. */
  readonly runRc?: number;
  /** False: the container has other host values than /etc/vertex/hosts.env. */
  readonly sameHosts?: boolean;
  /** What `docker inspect` reports for State.Running and RestartCount after the start. */
  readonly state?: string;
  readonly validateRc?: number;
}

const setup = (containerInode: string, options: Fake) => {
  const hosts = options.hosts === undefined ? validHosts : options.hosts;
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
    writeFileSync(join(root, file), literal);
  }
  if (typeof options.installed === "string") {
    rmSync(join(root, webDir, "Caddyfile"));
    mkdirSync(join(root, webDir, "caddy"));
    writeFileSync(join(root, webDir, "caddy/Caddyfile"), options.installed);
  }
  if (options.prev !== undefined) {
    writeFileSync(join(root, webDir, "Caddyfile.prev"), options.prev);
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
    [
      `echo "docker $*" >> ${log}`,
      'case "$1 $*" in',
      `  "run run -d"*) exit ${options.runRc ?? 0} ;;`,
      `  run*"caddy validate"*) exit ${options.validateRc ?? 0} ;;`,
      // The reload records the file that the container would load at that moment.
      `  exec*"caddy reload"*) echo "loaded $(cat ${root}/${webDir}/caddy/Caddyfile | sha256sum | cut -d' ' -f1)" >> ${log}; exit ${options.reloadRc ?? 0} ;;`,
      `  exec*"sh -c"*) exit ${options.sameHosts === false ? 1 : 0} ;;`,
      `  exec*) echo ${containerInode} ;;`,
      `  inspect*RestartCount*) echo "${options.state ?? "true 0"}" ;;`,
      `  inspect*) echo "${options.mounts ?? ""}" ;;`,
      "esac",
      "exit 0",
    ].join("\n")
  );
  fake(
    bin,
    "systemctl",
    `echo "systemctl $*" >> ${log}; [ "$1" = show ] && echo yes; exit 0`
  );
  fake(bin, "stat", "echo 111");
  return { bin, log, root };
};

const run = (containerInode: string, options: Fake = {}) => {
  const env = setup(containerInode, options);
  const sock = join(env.root, "var/run/tailscale/tailscaled.sock");
  const bound = spawnSync("python3", [
    "-c",
    `import socket;socket.socket(socket.AF_UNIX).bind(${JSON.stringify(sock)})`,
  ]);
  if (bound.status !== 0) {
    throw new Error(`socket setup failed: ${bound.stderr}`);
  }
  const result = spawnSync("bash", [script, ...(options.args ?? [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env["PATH"] ?? ""}`,
      VERTEX_TAILNET_ROOT: env.root,
      VERTEX_TAILNET_SETTLE_SECONDS: "0",
      VERTEX_TAILNET_SSH: "bash -s",
    },
  });
  const calls = existsSync(env.log) ? readFileSync(env.log, "utf8") : "";
  const web = join(env.root, webDir);
  return { ...result, calls, root: env.root, web };
};

const reloadOnly: Fake = {
  args: ["--caddyfile-only"],
  installed: "older template\n",
  mounts: `/opt/vertex-web-tailnet/caddy:/etc/caddy ${dirMount.slice(0, -3)} `,
};
const hostValues = /quant-vps-host|100\.64\.0\.10/u;
const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
/** The docker subcommands of a run, without duplicates. */
const verbs = (calls: string): string[] => [
  ...new Set(
    callsOf(calls, "docker ").map((line) =>
      line.startsWith("docker run --rm")
        ? "run --rm"
        : (line.split(" ")[1] ?? "")
    )
  ),
];
function callsOf(calls: string, prefix: string): string[] {
  return calls.split("\n").filter((line) => line.startsWith(prefix));
}

describe("recreate-tailnet-proxies", () => {
  it("installs the drop-in and recreates both proxies with the directory mount", () => {
    const result = run("111");
    expect(result.stdout).toContain("drop-in ok: RuntimeDirectoryPreserve=yes");
    expect(result.stdout).toContain("vertex-web-tailnet inode ok (111)");
    expect(result.stdout).toContain("vertex-status-tailnet inode ok (111)");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("systemctl daemon-reload");
    expect(result.calls).not.toMatch(/systemctl (re)?start|systemctl stop/);
    const runs = callsOf(result.calls, "docker run -d");
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
    expect(web).toContain(caddyMount);
    expect(web).not.toContain("/opt/vertex-web-tailnet/Caddyfile");
    const status = runs.find((line) => line.includes("vertex-status-tailnet"));
    for (const flag of [
      "--security-opt no-new-privileges",
      "--memory 64m",
      "--env-file /opt/vertex-status/token.env",
      "-v /opt/vertex-status/private-v2:/srv:ro",
    ]) {
      expect(status).toContain(flag);
    }
    // Only these docker calls, and only on the two proxies.
    for (const line of callsOf(result.calls, "docker ")) {
      expect(line).toMatch(
        /^docker (rm -f|run -d --name|exec|inspect -f \S+ \S+) vertex-(web|status)-tailnet( |$)|^docker run --rm --network none |^docker image inspect caddy:2-alpine$/u
      );
    }
    expect(result.stdout + result.stderr).not.toMatch(hostValues);
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

  it("checks the committed Caddyfile first and installs it alone in the mounted directory", () => {
    const result = run("111");
    expect(result.status).toBe(0);
    const docker = callsOf(result.calls, "docker ");
    expect(result.stdout).toMatch(/^caddyfile checked: sha256=[0-9a-f]{64}$/mu);
    expect(docker[0]).toBe("docker image inspect caddy:2-alpine");
    expect(docker[1]).toContain("docker run --rm --network none");
    expect(docker[1]).toContain("--env-file /etc/vertex/hosts.env");
    expect(docker[1]).toContain(
      "-v /opt/vertex-web-tailnet/staging:/etc/caddy:ro caddy:2-alpine caddy validate"
    );
    expect(callsOf(result.calls, "docker run --rm")).toHaveLength(1);
    expect(readdirSync(join(result.web, "caddy"))).toEqual(["Caddyfile"]);
    expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
      template
    );
    // The old file with literal host values is a backup outside the mount.
    const rest = readdirSync(result.web).filter((name) => name !== "caddy");
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatch(/^Caddyfile\.bak-\d{8}T\d{6}Z-literal$/u);
    expect(readFileSync(join(result.web, rest[0] ?? ""), "utf8")).toBe(literal);
  });

  it("exits 6 and keeps the old file in place when the new container does not stay up", () => {
    const result = run("111", { state: "false 3" });
    expect(result.status).toBe(6);
    expect(result.stdout).toContain("vertex-web-tailnet DID NOT STAY UP");
    // The status proxy is not touched, and the rollback source is still at its old path.
    expect(result.calls).not.toContain("vertex-status-tailnet");
    expect(readFileSync(join(result.web, "Caddyfile"), "utf8")).toBe(literal);
  });

  it("changes nothing (exit 3) when the committed Caddyfile does not validate", () => {
    const result = run("111", { validateRc: 1 });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "committed Caddyfile does not validate; nothing changed"
    );
    expect(verbs(result.calls)).toEqual(["image", "run --rm"]);
    expect(result.calls).not.toContain("systemctl");
    expect(readdirSync(result.web)).toEqual(["Caddyfile"]);
    expect(
      existsSync(join(result.root, "etc/systemd/system/tailscaled.service.d"))
    ).toBe(false);
  });

  describe("--caddyfile-only", () => {
    it("installs a changed Caddyfile with a reload and recreates nothing", () => {
      const result = run("111", reloadOnly);
      expect(result.stdout).toContain("caddyfile installed and reloaded=");
      expect(result.status).toBe(0);
      expect(callsOf(result.calls, "docker run --rm")).toHaveLength(1);
      expect(
        callsOf(result.calls, "docker exec vertex-web-tailnet caddy reload")
      ).toEqual([
        "docker exec vertex-web-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock",
      ]);
      expect(verbs(result.calls)).toEqual([
        "inspect",
        "exec",
        "image",
        "run --rm",
      ]);
      expect(result.calls).not.toContain("systemctl");
      // The reload loads the committed file, not the replaced one.
      expect(callsOf(result.calls, "loaded ")).toEqual([
        `loaded ${sha256(template)}`,
      ]);
      expect(result.stdout + result.stderr).not.toMatch(hostValues);
      expect(result.calls).not.toContain("vertex-status-tailnet");
      expect(readdirSync(join(result.web, "caddy"))).toEqual(["Caddyfile"]);
      expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
        template
      );
      // The replaced file and the staging directory are gone after a good reload.
      expect(readdirSync(result.web)).toEqual(["caddy"]);
    });

    it("changes nothing (exit 3) when the container has other host values", () => {
      const result = run("111", { ...reloadOnly, sameHosts: false });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain(
        "does not have the host values of /etc/vertex/hosts.env; run the full recreate; nothing changed"
      );
      expect(result.calls).not.toMatch(/docker run|caddy reload/u);
      expect(result.calls).toContain(
        "sh quant-vps-host.example-tailnet.ts.net 100.64.0.10"
      );
      expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
        "older template\n"
      );
    });

    it("only repeats the reload when the installed Caddyfile equals the committed one", () => {
      // A run that stopped between the install and the reload left the new file with the
      // old config; the next run must load it.
      const result = run("111", { ...reloadOnly, installed: template });
      expect(result.stdout).toContain("caddyfile unchanged; reload confirmed=");
      expect(result.status).toBe(0);
      expect(verbs(result.calls)).toEqual(["inspect", "exec"]);
      expect(result.calls).not.toContain("systemctl");
      expect(
        callsOf(result.calls, "docker exec vertex-web-tailnet caddy reload")
      ).toHaveLength(1);
      expect(readdirSync(result.web)).toEqual(["caddy"]);
      const failed = run("111", {
        ...reloadOnly,
        installed: template,
        reloadRc: 1,
      });
      expect(failed.status).toBe(7);
      expect(readFileSync(join(failed.web, "caddy/Caddyfile"), "utf8")).toBe(
        template
      );
    });

    it("changes nothing (exit 3) while the container has the single-file mount", () => {
      const result = run("111", {
        ...reloadOnly,
        installed: null,
        mounts: `/opt/vertex-web-tailnet/Caddyfile:/etc/caddy/Caddyfile ${dirMount.slice(0, -3)} `,
      });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("run the full recreate; nothing changed");
      expect(verbs(result.calls)).toEqual(["inspect"]);
      expect(readdirSync(result.web)).toEqual(["Caddyfile"]);
    });

    it("changes nothing (exit 3) when the committed Caddyfile does not validate", () => {
      const result = run("111", { ...reloadOnly, validateRc: 1 });
      expect(result.status).toBe(3);
      expect(result.calls).not.toContain("caddy reload");
      expect(readdirSync(result.web)).toEqual(["caddy"]);
      expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
        "older template\n"
      );
    });

    it("puts the old file back (exit 7) when the reload fails", () => {
      const result = run("111", { ...reloadOnly, reloadRc: 1 });
      expect(result.status).toBe(7);
      expect(result.stdout).toContain("RELOAD FAILED");
      expect(readdirSync(result.web)).toEqual(["caddy"]);
      expect(readdirSync(join(result.web, "caddy"))).toEqual(["Caddyfile"]);
      expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
        "older template\n"
      );
    });
  });

  it("keeps the file of the running config across a run that stopped before its reload", () => {
    // An earlier run installed the committed file and stopped; Caddyfile.prev is the file of
    // the config that still runs. A failed reload must put that file back.
    const stopped = { ...reloadOnly, installed: template, prev: "running\n" };
    const failed = run("111", { ...stopped, reloadRc: 1 });
    expect(failed.status).toBe(7);
    expect(readdirSync(failed.web)).toEqual(["caddy"]);
    expect(readFileSync(join(failed.web, "caddy/Caddyfile"), "utf8")).toBe(
      "running\n"
    );
    const good = run("111", stopped);
    expect(good.status).toBe(0);
    expect(readdirSync(good.web)).toEqual(["caddy"]);
    expect(readFileSync(join(good.web, "caddy/Caddyfile"), "utf8")).toBe(
      template
    );
  });

  it("changes nothing (exit 3) in --caddyfile-only while the container is not running", () => {
    const result = run("111", { ...reloadOnly, state: "false 0" });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("vertex-web-tailnet is not running");
    expect(verbs(result.calls)).toEqual(["inspect"]);
  });

  it("recreates a proxy that already has the directory form without a literal backup", () => {
    const result = run("111", { installed: "older template\n" });
    expect(result.status).toBe(0);
    expect(callsOf(result.calls, "docker run -d")).toHaveLength(2);
    expect(readdirSync(result.web)).toEqual(["caddy"]);
    expect(readFileSync(join(result.web, "caddy/Caddyfile"), "utf8")).toBe(
      template
    );
  });

  it("exits 6 and leaves the status proxy alone when the web container does not start", () => {
    const result = run("111", { runRc: 125 });
    expect(result.status).toBe(6);
    expect(result.stdout).toContain("CONTAINER RUN FAILED; proxy is down");
    expect(result.calls).not.toContain("vertex-status-tailnet");
    expect(readFileSync(join(result.web, "Caddyfile"), "utf8")).toBe(literal);
  });

  it("rejects an unknown argument (exit 2) and prints the program with --dry-run", () => {
    const unknown = run("111", { args: ["--caddyfile-only", "--force"] });
    expect(unknown.status).toBe(2);
    expect(unknown.calls).toBe("");
    const dry = run("111", { args: ["--dry-run", "--caddyfile-only"] });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/^MODE=caddyfile$/mu);
    expect(dry.calls).toBe("");
    expect(run("111", { args: ["--dry-run"] }).stdout).toMatch(/^MODE=full$/mu);
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
    const result = run("111", { hosts });
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
