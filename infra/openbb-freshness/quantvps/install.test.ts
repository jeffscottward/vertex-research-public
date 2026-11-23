import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = (name: string): string =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));
const read = (name: string): string => readFileSync(here(name), "utf8");
const script = here("install.sh");
const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();

const directives = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

describe("QuantVPS openbb-freshness units", () => {
  const service = read("vertex-openbb-freshness.service");
  const timer = read("vertex-openbb-freshness.timer");
  const keyDropIn = read("vertex-openbb-freshness.service.d/agent-key.conf");
  const alertDropIn = read(
    "vertex-openbb-freshness.service.d/alert-route.conf"
  );

  it("runs the installed bundle with the Autopilot Node and hardened directives", () => {
    expect(directives(service, "ExecStart")).toEqual([
      "/opt/vertex-autopilot/bin/node /opt/vertex-openbb-freshness/vertex-price-freshness-tick.mjs",
    ]);
    expect(directives(service, "WorkingDirectory")).toEqual([
      "/opt/vertex-openbb-freshness",
    ]);
    expect(directives(service, "TimeoutStartSec")).toEqual(["120"]);
    expect(directives(service, "NoNewPrivileges")).toEqual(["yes"]);
    expect(directives(service, "ProtectSystem")).toEqual(["strict"]);
    expect(directives(service, "DynamicUser")).toEqual(["yes"]);
    expect(directives(service, "ProtectHome")).toEqual(["yes"]);
    expect(directives(service, "RestrictNamespaces")).toEqual(["yes"]);
    expect(directives(service, "SystemCallFilter")).toEqual([
      "@system-service",
    ]);
    expect(read("install.sh")).toContain(
      "bundle=vertex-price-freshness-tick.mjs"
    );
  });

  it("reads settings from environment files only", () => {
    expect(directives(service, "EnvironmentFile")).toEqual([
      "/etc/vertex-autopilot/autopilot.env",
    ]);
    expect(directives(keyDropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-openbb-freshness/agent-key.env",
    ]);
    expect(directives(alertDropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-openbb-freshness/alert.env",
    ]);
    for (const text of [service, timer, keyDropIn, alertDropIn])
      expect(directives(text, "Environment")).toEqual([]);
  });

  it("runs hourly 06..23:15 America/New_York every day with Persistent=true", () => {
    expect(directives(timer, "OnCalendar")).toEqual([
      "*-*-* 06..23:15:00 America/New_York",
    ]);
    expect(directives(timer, "Persistent")).toEqual(["true"]);
  });
});

interface FakeHost {
  base: string;
  calls: string;
  root: string;
}

describe("install.sh", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0))
      rmSync(dir, { force: true, recursive: true });
  });

  const executable = (path: string, body: string): void => {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  const fakeHost = (options: {
    alertMode?: number;
    alertText?: string;
    keyMode?: number;
    keyText?: string;
    node: boolean;
  }): FakeHost => {
    const base = mkdtempSync(join(tmpdir(), "openbb-freshness-install-"));
    temps.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "etc/vertex-autopilot"), { recursive: true });
    writeFileSync(join(root, "etc/vertex-autopilot/autopilot.env"), "");
    if (options.alertMode !== undefined) {
      const alertEnv = join(root, "etc/vertex-openbb-freshness/alert.env");
      mkdirSync(join(root, "etc/vertex-openbb-freshness"), { recursive: true });
      writeFileSync(
        alertEnv,
        options.alertText ??
          "VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post\nVERTEX_ALERT_CHANNEL=omp-alerts\n"
      );
      chmodSync(alertEnv, options.alertMode);
    }
    if (options.keyMode !== undefined) {
      const keyEnv = join(root, "etc/vertex-openbb-freshness/agent-key.env");
      mkdirSync(join(root, "etc/vertex-openbb-freshness"), { recursive: true });
      writeFileSync(
        keyEnv,
        options.keyText ?? "VERTEX_AGENT_API_KEY=fake-key\n"
      );
      chmodSync(keyEnv, options.keyMode);
    }
    if (options.node) {
      const bin = join(root, "opt/vertex-autopilot/bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync(process.execPath, join(bin, "node"));
    }
    const calls = join(base, "systemctl.log");
    const fakeSystemctl = join(base, "systemctl");
    executable(fakeSystemctl, `echo "$*" >> ${JSON.stringify(calls)}`);
    const fakeSsh = join(base, "ssh");
    executable(
      fakeSsh,
      `VERTEX_INSTALL_ROOT=${JSON.stringify(root)} VERTEX_SYSTEMCTL=${JSON.stringify(fakeSystemctl)} exec bash -c "$*"`
    );
    return { base, calls, root };
  };

  const runInstall = (args: string[], host?: FakeHost) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        VERTEX_OPENBB_FRESHNESS_ALLOW_DIRTY: "1",
        ...(host === undefined
          ? {}
          : { VERTEX_OPENBB_FRESHNESS_SSH: join(host.base, "ssh") }),
      },
    });

  it("supports --build-only without touching SSH", () => {
    const out = mkdtempSync(join(tmpdir(), "openbb-freshness-build-"));
    temps.push(out);
    const res = runInstall(["--build-only", out]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(out, "vertex-price-freshness-tick.mjs"))).toBe(true);
    expect(readFileSync(join(out, "SOURCE_SHA"), "utf8").trim()).toMatch(
      new RegExp(`^${headSha}(-dirty)?$`, "u")
    );
  });

  it("installs units and both drop-ins (mode 0644), then symmetrically removes drop-ins when env files are removed", () => {
    const host = fakeHost({ alertMode: 0o600, keyMode: 0o600, node: true });
    const first = runInstall([], host);
    expect(first.status, first.stderr).toBe(0);

    const dropDir = join(
      host.root,
      "etc/systemd/system/vertex-openbb-freshness.service.d"
    );
    expect(statSync(join(dropDir, "agent-key.conf")).mode % 0o1000).toBe(0o644);
    expect(statSync(join(dropDir, "alert-route.conf")).mode % 0o1000).toBe(
      0o644
    );
    expect(readFileSync(host.calls, "utf8")).toContain(
      "enable --now vertex-openbb-freshness.timer"
    );

    // Remove both optional env files and re-run install: both drop-ins must be removed.
    rmSync(join(host.root, "etc/vertex-openbb-freshness/agent-key.env"));
    rmSync(join(host.root, "etc/vertex-openbb-freshness/alert.env"));
    const second = runInstall([], host);
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(join(dropDir, "agent-key.conf"))).toBe(false);
    expect(existsSync(join(dropDir, "alert-route.conf"))).toBe(false);
  });

  it("rejects insecure permissions, symlinks, whitespace-only values, and missing required keys for both env files, and keeps .prev backups", () => {
    const badMode = fakeHost({ alertMode: 0o644, node: true });
    expect(runInstall([], badMode).status).toBe(1);

    const badKeyMode = fakeHost({ keyMode: 0o644, node: true });
    expect(runInstall([], badKeyMode).status).toBe(1);

    const missingChannel = fakeHost({
      alertMode: 0o600,
      alertText: "VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post\n",
      node: true,
    });
    expect(runInstall([], missingChannel).status).toBe(1);

    const whitespaceChannel = fakeHost({
      alertMode: 0o600,
      alertText:
        "VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post\nVERTEX_ALERT_CHANNEL=   \n",
      node: true,
    });
    expect(runInstall([], whitespaceChannel).status).toBe(1);

    const missingKey = fakeHost({
      keyMode: 0o600,
      keyText: "VERTEX_AGENT_API_KEY=   \n",
      node: true,
    });
    expect(runInstall([], missingKey).status).toBe(1);

    // Valid symlink and dangling symlink are both rejected for alert.env and agent-key.env
    const symHost = fakeHost({ node: true });
    mkdirSync(join(symHost.root, "etc/vertex-openbb-freshness"), {
      recursive: true,
    });
    const target = join(symHost.base, "real-alert.env");
    writeFileSync(
      target,
      "VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post\nVERTEX_ALERT_CHANNEL=omp-alerts\n"
    );
    chmodSync(target, 0o600);
    symlinkSync(
      target,
      join(symHost.root, "etc/vertex-openbb-freshness/alert.env")
    );
    expect(runInstall([], symHost).status).toBe(1);

    const danglingHost = fakeHost({ node: true });
    mkdirSync(join(danglingHost.root, "etc/vertex-openbb-freshness"), {
      recursive: true,
    });
    symlinkSync(
      join(danglingHost.base, "missing-key.env"),
      join(danglingHost.root, "etc/vertex-openbb-freshness/agent-key.env")
    );
    expect(runInstall([], danglingHost).status).toBe(1);

    // Replacing a changed installed bundle saves *.prev backups
    const backupHost = fakeHost({ node: true });
    expect(runInstall([], backupHost).status).toBe(0);
    const appDir = join(backupHost.root, "opt/vertex-openbb-freshness");
    writeFileSync(join(appDir, "vertex-price-freshness-tick.mjs"), "// old\n");
    writeFileSync(join(appDir, "SOURCE_SHA"), "oldsha\n");
    expect(runInstall([], backupHost).status).toBe(0);
    expect(
      readFileSync(join(appDir, "vertex-price-freshness-tick.mjs.prev"), "utf8")
    ).toBe("// old\n");
    expect(readFileSync(join(appDir, "SOURCE_SHA.prev"), "utf8")).toBe(
      "oldsha\n"
    );

    const badUsage = runInstall(["--unknown"]);
    expect(badUsage.status).toBe(2);
  });
});
