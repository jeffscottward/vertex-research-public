import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

// The rig units for the daily engine comparison driver are copies of the installed files in
// ~/.config/systemd/user and ~/.local/bin. The wrapper runs against a fake bun in a temp home, so
// no test calls Vertex.
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const values = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const DEFAULT_RUNNER = "Github/trading/vertex-research-public-driver-runner";

type Setup = Readonly<{
  env?: Record<string, string>;
  runner?: string;
  bun?: boolean;
  reportScript?: boolean;
  driverExit?: number;
  reportExit?: number;
  keyMode?: number;
}>;

const runWrapper = (setup: Setup = {}) => {
  const runner = setup.runner ?? "runner";
  const root = mkdtempSync(join(tmpdir(), "ecd-units-"));
  roots.push(root);
  const bin = join(root, ".local/share/mise/installs/bun/9.8.7/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, runner), { recursive: true });
  writeFileSync(join(root, runner, ".bun-version"), "9.8.7\n");
  writeFileSync(
    join(root, runner, "package.json"),
    setup.reportScript === false
      ? '{"scripts": {}}\n'
      : '{"scripts": {"vertex:engine-comparison-report": "x"}}\n'
  );
  if (setup.bun !== false) {
    writeFileSync(
      join(bin, "bun"),
      [
        "#!/usr/bin/env bash",
        'echo "args:$* key:${VERTEX_AGENT_API_KEY:-none} keyfile:${VERTEX_AGENT_KEY_FILE:-none} cwd:${PWD#"$HOME"/}"',
        `if [[ "$2" == scripts/vertex-engine-comparison-driver.ts ]]; then exit ${setup.driverExit ?? 0}; fi`,
        `exit ${setup.reportExit ?? 0}`,
        "",
      ].join("\n")
    );
    chmodSync(join(bin, "bun"), 0o755);
  }
  writeFileSync(join(root, "key"), "secret-key\n", { mode: 0o600 });
  writeFileSync(join(root, "read-key"), "read-key\n", { mode: 0o600 });
  if (setup.keyMode !== undefined) chmodSync(join(root, "key"), setup.keyMode);
  const result = spawnSync(
    "bash",
    [
      fileURLToPath(
        new URL("./vertex-engine-comparison-driver-run", import.meta.url)
      ),
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        VERTEX_DRIVER_KEY_FILE: join(root, "key"),
        VERTEX_DRIVER_REPORT_OUT: join(root, "report"),
        VERTEX_DRIVER_REPORT_WAIT_S: "0",
        VERTEX_ORIGIN: "https://v",
        ...(runner === DEFAULT_RUNNER
          ? {}
          : { VERTEX_DRIVER_RUNNER_DIR: join(root, runner) }),
        ...Object.fromEntries(
          Object.entries(setup.env ?? {}).map(([key, value]) => [
            key,
            value === "READ_KEY" ? join(root, "read-key") : value,
          ])
        ),
      },
    }
  );
  return {
    root,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout.trim().split("\n"),
  };
};

describe("vertex-engine-comparison-driver units", () => {
  it("the timer runs once a day before the New York open", () => {
    const timer = read("vertex-engine-comparison-driver.timer");
    expect(values(timer, "OnCalendar")).toEqual([
      "*-*-* 06:15:00 America/New_York",
    ]);
    expect(values(timer, "Persistent")).toEqual(["true"]);
  });

  it("the service is a research-only oneshot of the wrapper", () => {
    const service = read("vertex-engine-comparison-driver.service");
    expect(values(service, "Type")).toEqual(["oneshot"]);
    expect(values(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-engine-comparison-driver-run",
    ]);
    expect(values(service, "EnvironmentFile")).toEqual([
      "%h/.config/vertex/engine-comparison-driver.env",
    ]);
    expect(values(service, "WorkingDirectory")).toEqual([]);
    expect(values(service, "NoNewPrivileges")).toEqual(["yes"]);
    expect(values(service, "UMask")).toEqual(["0077"]);
    expect(values(service, "TimeoutStartSec")).toEqual(["7200"]);
  });

  it("runs the driver with the key, then the report with the key file only", () => {
    const run = runWrapper();
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([
      "args:--no-env-file scripts/vertex-engine-comparison-driver.ts key:secret-key keyfile:none cwd:runner",
      `args:run vertex:engine-comparison-report -- --out ${run.root}/report key:none keyfile:${run.root}/key cwd:runner`,
    ]);
  });

  it("defaults to the driver runner checkout", () => {
    const run = runWrapper({ runner: DEFAULT_RUNNER });
    expect(run.stdout[0]).toBe(
      `args:--no-env-file scripts/vertex-engine-comparison-driver.ts key:secret-key keyfile:none cwd:${DEFAULT_RUNNER}`
    );
  });

  it("still rebuilds the report when the driver failed, and keeps the driver's exit code", () => {
    const run = runWrapper({ driverExit: 1, reportExit: 4 });
    expect(run.status).toBe(1);
    expect(run.stdout).toHaveLength(2);
  });

  it("returns the report's exit code when the driver succeeded", () => {
    expect(runWrapper({ reportExit: 4 }).status).toBe(4);
  });

  it("skips the report when no output folder is set", () => {
    const run = runWrapper({ env: { VERTEX_DRIVER_REPORT_OUT: "" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toHaveLength(2);
    expect(run.stdout[1]).toContain("report not rebuilt");
  });

  it("exits 3 when the checkout has no report script yet, unless the driver failed", () => {
    const run = runWrapper({ reportScript: false });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("no vertex:engine-comparison-report script");
    expect(runWrapper({ driverExit: 1, reportScript: false }).status).toBe(1);
  });

  it("skips the report when the driver refused its configuration", () => {
    const run = runWrapper({ driverExit: 2 });
    expect(run.status).toBe(2);
    expect(run.stdout).toHaveLength(1);
  });

  it("gives the report its own key file when one is set", () => {
    const run = runWrapper({
      env: { VERTEX_DRIVER_REPORT_KEY_FILE: "READ_KEY" },
    });
    expect(run.stdout[1]).toContain(`keyfile:${run.root}/read-key`);
  });

  it("refuses a key file others can read and a bad report wait", () => {
    const loose = runWrapper({ keyMode: 0o644 });
    expect(loose.status).toBe(2);
    expect(loose.stderr).toContain("readable by its owner only");
    const wait = runWrapper({ env: { VERTEX_DRIVER_REPORT_WAIT_S: "10m" } });
    expect(wait.status).toBe(2);
    expect(wait.stderr).toContain("whole number of seconds");
  });

  it("refuses to run without the origin or a readable key file", () => {
    for (const env of [
      { VERTEX_ORIGIN: "" },
      { VERTEX_DRIVER_KEY_FILE: "" },
      { VERTEX_DRIVER_KEY_FILE: "/nonexistent/key" },
    ]) {
      const run = runWrapper({ env });
      expect(run.status).toBe(2);
      expect(run.stdout).toEqual([""]);
      expect(run.stderr).toContain("operator write key");
    }
  });

  it("exits 127 when the pinned bun is not installed", () => {
    const run = runWrapper({ bun: false });
    expect(run.status).toBe(127);
    expect(run.stderr).toContain("the pinned bun is not installed");
  });
});
