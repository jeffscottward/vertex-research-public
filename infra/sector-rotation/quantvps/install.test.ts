import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The QuantVPS route for the sector rotation collection. The units are copies of the live
// files; the install runs against a fake ssh that executes the remote step in a temp root,
// so no test reaches QuantVPS or calls systemctl.
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

describe("QuantVPS units", () => {
  const service = read("vertex-sector-rotation.service");
  const timer = read("vertex-sector-rotation.timer");
  const dropIn = read("vertex-sector-rotation.service.d/alert-route.conf");
  const keyDropIn = read("vertex-sector-rotation.service.d/agent-key.conf");

  it("runs the installed bundle with the Autopilot Node", () => {
    expect(directives(service, "ExecStart")).toEqual([
      "/opt/vertex-autopilot/bin/node /opt/vertex-sector-rotation/vertex-sector-rotation-tick.mjs",
    ]);
    expect(directives(service, "WorkingDirectory")).toEqual([
      "/opt/vertex-sector-rotation",
    ]);
    expect(read("install.sh")).toContain(
      "bundle=vertex-sector-rotation-tick.mjs"
    );
  });

  it("reads settings from environment files only", () => {
    expect(directives(service, "EnvironmentFile")).toEqual([
      "/etc/vertex-autopilot/autopilot.env",
    ]);
    expect(directives(dropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-sector-rotation/alert.env",
    ]);
    // A drop-in's EnvironmentFile is read after the unit's, so this key replaces the Autopilot key.
    expect(directives(keyDropIn, "EnvironmentFile")).toEqual([
      "/etc/vertex-sector-rotation/agent-key.env",
    ]);
    for (const text of [service, timer, dropIn, keyDropIn]) {
      expect(directives(text, "Environment")).toEqual([]);
    }
  });

  it("keeps the schedule of the user timer", () => {
    const userTimer = readFileSync(
      fileURLToPath(
        new URL("../vertex-sector-rotation.timer", import.meta.url)
      ),
      "utf8"
    );
    expect(directives(timer, "OnCalendar")).toEqual([
      "Mon..Fri *-*-* 16:50:00 America/New_York",
      "Mon..Fri *-*-* 18:40:00 America/New_York",
    ]);
    expect(directives(timer, "OnCalendar")).toEqual(
      directives(userTimer, "OnCalendar")
    );
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
    for (const dir of temps.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  const executable = (path: string, body: string): void => {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // A fake QuantVPS root with the Autopilot Node and environment files. keyMode writes the key
  // file with that mode; without it there is no key file.
  const fakeHost = (options: {
    alertEnv: boolean;
    keyMode?: number;
    node: boolean;
  }): FakeHost => {
    const base = mkdtempSync(join(tmpdir(), "rrg-install-"));
    temps.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "etc/vertex-autopilot"), { recursive: true });
    writeFileSync(join(root, "etc/vertex-autopilot/autopilot.env"), "");
    if (options.alertEnv) {
      mkdirSync(join(root, "etc/vertex-sector-rotation"), { recursive: true });
      writeFileSync(join(root, "etc/vertex-sector-rotation/alert.env"), "");
    }
    if (options.keyMode !== undefined) {
      const keyEnv = join(root, "etc/vertex-sector-rotation/agent-key.env");
      mkdirSync(join(root, "etc/vertex-sector-rotation"), { recursive: true });
      writeFileSync(keyEnv, "");
      chmodSync(keyEnv, options.keyMode);
    }
    if (options.node) {
      mkdirSync(join(root, "opt/vertex-autopilot/bin"), { recursive: true });
      executable(
        join(root, "opt/vertex-autopilot/bin/node"),
        '[ "$1" = --check ] && [ -s "$2" ]'
      );
    }
    const calls = join(base, "systemctl.log");
    executable(join(base, "systemctl"), `echo "$*" >> "${calls}"`);
    // The fake ssh gets the remote command as its only argument and runs it here.
    executable(join(base, "ssh"), 'exec bash -c "$1"');
    return { base, calls, root };
  };

  const install = (host: FakeHost) =>
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        VERTEX_INSTALL_ROOT: host.root,
        VERTEX_SECTOR_ROTATION_ALLOW_DIRTY: "1",
        VERTEX_SECTOR_ROTATION_SSH: join(host.base, "ssh"),
        VERTEX_SYSTEMCTL: join(host.base, "systemctl"),
      },
    });

  it("installs the bundle, the units, the key drop-in and the chat route, then enables the timer", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ alertEnv: true, keyMode: 0o600, node: true });
    const first = install(host);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const app = join(host.root, "opt/vertex-sector-rotation");
    const units = join(host.root, "etc/systemd/system");
    expect(readFileSync(join(app, "SOURCE_SHA"), "utf8")).toMatch(
      new RegExp(`^${headSha}(-dirty)?\\n$`, "u")
    );
    expect(
      readFileSync(join(app, "vertex-sector-rotation-tick.mjs"), "utf8")
    ).toContain("// scripts/sector-rotation/tick.ts");
    for (const name of [
      "vertex-sector-rotation.service",
      "vertex-sector-rotation.timer",
      "vertex-sector-rotation.service.d/agent-key.conf",
      "vertex-sector-rotation.service.d/alert-route.conf",
    ]) {
      expect(readFileSync(join(units, name), "utf8")).toBe(read(name));
    }
    for (const [name, mode] of [
      ["alert-route.conf", /600$/u],
      ["agent-key.conf", /644$/u],
    ] as const) {
      expect(
        statSync(
          join(units, "vertex-sector-rotation.service.d", name)
        ).mode.toString(8)
      ).toMatch(mode);
    }
    expect(readFileSync(host.calls, "utf8").trim().split("\n")).toEqual([
      "daemon-reload",
      "enable --now vertex-sector-rotation.timer",
      "is-active --quiet vertex-sector-rotation.timer",
    ]);
    expect(first.stdout).toMatch(/^installed [0-9a-f]{40}/mu);

    // The same build again keeps no backup, so *.prev never becomes the current build.
    expect(install(host).status).toBe(0);
    expect(existsSync(join(app, "vertex-sector-rotation-tick.mjs.prev"))).toBe(
      false
    );

    // A changed bundle keeps the replaced pair for rollback.
    writeFileSync(join(app, "vertex-sector-rotation-tick.mjs"), "// older\n");
    writeFileSync(join(app, "SOURCE_SHA"), "older\n");
    expect(install(host).status).toBe(0);
    expect(
      readFileSync(join(app, "vertex-sector-rotation-tick.mjs.prev"), "utf8")
    ).toBe("// older\n");
    expect(readFileSync(join(app, "SOURCE_SHA.prev"), "utf8")).toBe("older\n");
  });

  it("skips both drop-ins when their environment files are missing", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ alertEnv: false, node: true });
    const result = install(host);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("chat alert route not installed");
    expect(result.stdout).toContain("the service uses the Autopilot key");
    expect(
      existsSync(
        join(host.root, "etc/systemd/system/vertex-sector-rotation.service.d")
      )
    ).toBe(false);
  });

  it("removes the key drop-in when the key file is gone", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ alertEnv: true, keyMode: 0o600, node: true });
    const dropIns = join(
      host.root,
      "etc/systemd/system/vertex-sector-rotation.service.d"
    );
    expect(install(host).status).toBe(0);
    expect(existsSync(join(dropIns, "agent-key.conf"))).toBe(true);
    rmSync(join(host.root, "etc/vertex-sector-rotation/agent-key.env"));
    const again = install(host);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("the service uses the Autopilot key");
    expect(existsSync(join(dropIns, "agent-key.conf"))).toBe(false);
    expect(existsSync(join(dropIns, "alert-route.conf"))).toBe(true);
  });

  it("stops before any change when the key file is readable by others", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ alertEnv: true, keyMode: 0o644, node: true });
    const result = install(host);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "agent-key.env must be a regular file with mode 0600"
    );
    expect(existsSync(join(host.root, "opt/vertex-sector-rotation"))).toBe(
      false
    );
    expect(existsSync(host.calls)).toBe(false);
  });

  it("stops before any change when the Autopilot Node is missing", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ alertEnv: true, node: false });
    const result = install(host);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("install the Autopilot tick first");
    expect(existsSync(join(host.root, "opt/vertex-sector-rotation"))).toBe(
      false
    );
    expect(existsSync(host.calls)).toBe(false);
  });

  it("builds only into a relative folder with --build-only", {
    timeout: 60_000,
  }, () => {
    const base = mkdtempSync(join(tmpdir(), "rrg-build-"));
    temps.push(base);
    const result = spawnSync("bash", [script, "--build-only", "out"], {
      cwd: base,
      encoding: "utf8",
      env: { ...process.env, VERTEX_SECTOR_ROTATION_ALLOW_DIRTY: "1" },
    });
    expect(result.status).toBe(0);
    for (const name of [
      "vertex-sector-rotation-tick.mjs",
      "SOURCE_SHA",
      "remote-install.sh",
    ]) {
      expect(existsSync(join(base, "out", name))).toBe(true);
    }
  });

  it("rejects unknown arguments", () => {
    const result = spawnSync("bash", [script, "--bogus"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--build-only DIR");
  });
});
