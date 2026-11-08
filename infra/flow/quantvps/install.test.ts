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

// The QuantVPS route for the flow pipeline sampled collection. The units are copies of the live
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
  const service = read("vertex-flow.service");
  const timer = read("vertex-flow.timer");

  it("runs the installed bundle with the Autopilot Node", () => {
    expect(directives(service, "ExecStart")).toEqual([
      "/opt/vertex-autopilot/bin/node /opt/vertex-flow/vertex-flow-tick.mjs",
    ]);
    expect(directives(service, "WorkingDirectory")).toEqual([
      "/opt/vertex-flow",
    ]);
    expect(read("install.sh")).toContain("bundle=vertex-flow-tick.mjs");
  });

  it("reads settings from environment files only", () => {
    expect(directives(service, "EnvironmentFile")).toEqual([
      "/etc/vertex-autopilot/autopilot.env",
    ]);
    for (const text of [service, timer]) {
      expect(directives(text, "Environment")).toEqual([]);
    }
  });

  it("starts every minute and lets systemd skip overlapping runs", () => {
    expect(directives(timer, "OnCalendar")).toEqual(["*-*-* *:*:00"]);
    expect(directives(timer, "AccuracySec")).toEqual(["1s"]);
    expect(directives(timer, "Persistent")).toEqual(["false"]);
    expect(directives(timer, "RandomizedDelaySec")).toEqual([]);
    expect(directives(service, "Type")).toEqual(["oneshot"]);
    expect(directives(service, "TimeoutStartSec")).toEqual(["170"]);
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

  // A fake QuantVPS root with the Autopilot Node and environment files.
  const fakeHost = (options: { node: boolean }): FakeHost => {
    const base = mkdtempSync(join(tmpdir(), "flow-install-"));
    temps.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "etc/vertex-autopilot"), { recursive: true });
    writeFileSync(join(root, "etc/vertex-autopilot/autopilot.env"), "");
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
        VERTEX_FLOW_ALLOW_DIRTY: "1",
        VERTEX_FLOW_SSH: join(host.base, "ssh"),
        VERTEX_INSTALL_ROOT: host.root,
        VERTEX_SYSTEMCTL: join(host.base, "systemctl"),
      },
    });

  it("installs the bundle, the units, then enables the timer", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ node: true });
    const first = install(host);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const app = join(host.root, "opt/vertex-flow");
    const units = join(host.root, "etc/systemd/system");
    expect(readFileSync(join(app, "SOURCE_SHA"), "utf8")).toMatch(
      new RegExp(`^${headSha}(-dirty)?\\n$`, "u")
    );
    expect(readFileSync(join(app, "vertex-flow-tick.mjs"), "utf8")).toContain(
      "// scripts/flow/tick.ts"
    );
    for (const name of ["vertex-flow.service", "vertex-flow.timer"]) {
      expect(readFileSync(join(units, name), "utf8")).toBe(read(name));
    }
    expect(readFileSync(host.calls, "utf8").trim().split("\n")).toEqual([
      "daemon-reload",
      "enable --now vertex-flow.timer",
      "is-active --quiet vertex-flow.timer",
    ]);
    expect(first.stdout).toMatch(/^installed [0-9a-f]{40}/mu);

    // The same build again keeps no backup, so *.prev never becomes the current build.
    expect(install(host).status).toBe(0);
    expect(existsSync(join(app, "vertex-flow-tick.mjs.prev"))).toBe(false);

    // A changed bundle keeps the replaced pair for rollback.
    writeFileSync(join(app, "vertex-flow-tick.mjs"), "// older\n");
    writeFileSync(join(app, "SOURCE_SHA"), "older\n");
    expect(install(host).status).toBe(0);
    expect(readFileSync(join(app, "vertex-flow-tick.mjs.prev"), "utf8")).toBe(
      "// older\n"
    );
    expect(readFileSync(join(app, "SOURCE_SHA.prev"), "utf8")).toBe("older\n");
  });

  it("stops before any change when the Autopilot Node is missing", {
    timeout: 60_000,
  }, () => {
    const host = fakeHost({ node: false });
    const result = install(host);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("install the Autopilot tick first");
    expect(existsSync(join(host.root, "opt/vertex-flow"))).toBe(false);
    expect(existsSync(host.calls)).toBe(false);
  });

  it("builds only into a relative folder with --build-only", {
    timeout: 60_000,
  }, () => {
    const base = mkdtempSync(join(tmpdir(), "flow-build-"));
    temps.push(base);
    const result = spawnSync("bash", [script, "--build-only", "out"], {
      cwd: base,
      encoding: "utf8",
      env: { ...process.env, VERTEX_FLOW_ALLOW_DIRTY: "1" },
    });
    expect(result.status).toBe(0);
    for (const name of [
      "vertex-flow-tick.mjs",
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
