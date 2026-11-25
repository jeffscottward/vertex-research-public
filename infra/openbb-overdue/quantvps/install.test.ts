import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

describe("QuantVPS openbb-overdue units", () => {
  const service = read("vertex-openbb-overdue.service");
  const timer = read("vertex-openbb-overdue.timer");
  const keyDropIn = read("vertex-openbb-overdue.service.d/agent-key.conf");
  const alertDropIn = read("vertex-openbb-overdue.service.d/alert-route.conf");

  it("runs the installed bundle with the Autopilot Node and hardened directives", () => {
    expect(directives(service, "ExecStart")).toEqual([
      "/opt/vertex-autopilot/bin/node /opt/vertex-openbb-overdue/vertex-openbb-overdue-tick.mjs",
    ]);
    expect(directives(service, "WorkingDirectory")).toEqual([
      "/opt/vertex-openbb-overdue",
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
      "bundle=vertex-openbb-overdue-tick.mjs"
    );
  });

  it("reads settings from environment files only", () => {
    expect(directives(service, "EnvironmentFile")).toEqual([
      "/etc/vertex-autopilot/autopilot.env",
    ]);
    expect(directives(keyDropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-openbb-overdue/agent-key.env",
    ]);
    expect(directives(alertDropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-openbb-overdue/alert.env",
    ]);
    for (const text of [service, timer, keyDropIn, alertDropIn])
      expect(directives(text, "Environment")).toEqual([]);
  });

  it("runs every 15 minutes America/New_York with Persistent=true", () => {
    expect(directives(timer, "OnCalendar")).toEqual([
      "*-*-* *:00/15:00 America/New_York",
    ]);
    expect(directives(timer, "Persistent")).toEqual(["true"]);
  });
});

interface FakeHost {
  base: string;
  calls: string;
  root: string;
}

describe("openbb-overdue install.sh", () => {
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
    const base = mkdtempSync(join(tmpdir(), "openbb-overdue-install-"));
    temps.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "etc/vertex-autopilot"), { recursive: true });
    writeFileSync(join(root, "etc/vertex-autopilot/autopilot.env"), "");
    if (options.alertMode !== undefined) {
      const alertEnv = join(root, "etc/vertex-openbb-overdue/alert.env");
      mkdirSync(join(root, "etc/vertex-openbb-overdue"), { recursive: true });
      writeFileSync(
        alertEnv,
        options.alertText ??
          "VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post\nVERTEX_ALERT_CHANNEL=omp-alerts\n"
      );
      chmodSync(alertEnv, options.alertMode);
    }
    if (options.keyMode !== undefined) {
      const keyEnv = join(root, "etc/vertex-openbb-overdue/agent-key.env");
      mkdirSync(join(root, "etc/vertex-openbb-overdue"), { recursive: true });
      writeFileSync(
        keyEnv,
        options.keyText ?? "VERTEX_AGENT_API_KEY=vertex-test-key\n"
      );
      chmodSync(keyEnv, options.keyMode);
    }
    if (options.node) {
      mkdirSync(join(root, "opt/vertex-autopilot/bin"), { recursive: true });
      symlinkSync(
        process.execPath,
        join(root, "opt/vertex-autopilot/bin/node")
      );
    }
    const calls = join(base, "systemctl.calls");
    executable(
      join(base, "fake-systemctl"),
      `printf '%s\\n' "$*" >>"${calls}"\nexit 0`
    );
    return { base, calls, root };
  };

  it("builds a parseable Node ESM bundle and installs with optional drop-ins and rollback .prev", () => {
    const host = fakeHost({ alertMode: 0o600, keyMode: 0o600, node: true });
    const stageDir = join(host.base, "stage");
    const built = spawnSync("bash", [script, "--build-only", stageDir], {
      encoding: "utf8",
      env: { ...process.env, VERTEX_OPENBB_OVERDUE_ALLOW_DIRTY: "1" },
    });
    expect(built.status, built.stderr).toBe(0);
    expect(readFileSync(join(stageDir, "SOURCE_SHA"), "utf8").trim()).toContain(
      headSha
    );

    const runRemote = () =>
      spawnSync("bash", [join(stageDir, "remote-install.sh"), stageDir], {
        encoding: "utf8",
        env: {
          ...process.env,
          VERTEX_INSTALL_ROOT: host.root,
          VERTEX_SYSTEMCTL: join(host.base, "fake-systemctl"),
        },
      });

    const first = runRemote();
    expect(first.status, first.stderr).toBe(0);
    expect(
      existsSync(
        join(
          host.root,
          "etc/systemd/system/vertex-openbb-overdue.service.d/alert-route.conf"
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          host.root,
          "etc/systemd/system/vertex-openbb-overdue.service.d/agent-key.conf"
        )
      )
    ).toBe(true);
    expect(readFileSync(host.calls, "utf8")).toContain(
      "enable --now vertex-openbb-overdue.timer"
    );

    // Modifying installed bundle creates .prev on reinstall; removing env files removes drop-ins
    writeFileSync(
      join(
        host.root,
        "opt/vertex-openbb-overdue/vertex-openbb-overdue-tick.mjs"
      ),
      "// old\n"
    );
    rmSync(join(host.root, "etc/vertex-openbb-overdue/alert.env"));
    rmSync(join(host.root, "etc/vertex-openbb-overdue/agent-key.env"));
    const second = runRemote();
    expect(second.status, second.stderr).toBe(0);
    expect(
      existsSync(
        join(
          host.root,
          "opt/vertex-openbb-overdue/vertex-openbb-overdue-tick.mjs.prev"
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          host.root,
          "etc/systemd/system/vertex-openbb-overdue.service.d/alert-route.conf"
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(
          host.root,
          "etc/systemd/system/vertex-openbb-overdue.service.d/agent-key.conf"
        )
      )
    ).toBe(false);
  });

  it("refuses world-readable alert.env or missing Autopilot node", () => {
    const badMode = fakeHost({ alertMode: 0o644, node: true });
    const stageDir = join(badMode.base, "stage");
    const built = spawnSync("bash", [script, "--build-only", stageDir], {
      encoding: "utf8",
      env: { ...process.env, VERTEX_OPENBB_OVERDUE_ALLOW_DIRTY: "1" },
    });
    expect(built.status, built.stderr).toBe(0);
    const failMode = spawnSync(
      "bash",
      [join(stageDir, "remote-install.sh"), stageDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERTEX_INSTALL_ROOT: badMode.root,
          VERTEX_SYSTEMCTL: join(badMode.base, "fake-systemctl"),
        },
      }
    );
    expect(failMode.status).toBe(1);
    expect(failMode.stderr).toContain("mode 0600");

    const noNode = fakeHost({ node: false });
    const failNode = spawnSync(
      "bash",
      [join(stageDir, "remote-install.sh"), stageDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERTEX_INSTALL_ROOT: noNode.root,
          VERTEX_SYSTEMCTL: join(noNode.base, "fake-systemctl"),
        },
      }
    );
    expect(failNode.status).toBe(1);
    expect(failNode.stderr).toContain("missing");
  });
});
