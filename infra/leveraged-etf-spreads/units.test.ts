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

// The rig units for the leveraged ETF spread reads are copies of the files that the install puts in
// ~/.config/systemd/user and ~/.local/bin. The wrapper runs against a fake uv in a temp home, so no
// test fetches a chain.
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const values = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

const WRAPPER = fileURLToPath(
  new URL("./vertex-leveraged-etf-spreads-run", import.meta.url)
);
const DEFAULT_RUNNER = "Github/trading/vertex-research-public-spreads-runner";
const UV_ARGS =
  "run --no-project --python 3.12 --with yfinance==0.2.66 --exclude-newer 2026-11-11T00:00:00Z " +
  "python research/backtests/leveraged-etf/spread_reads.py";
const DEFAULT_STORE = "HOME/.local/share/vertex/leveraged-etf-spreads";
const DEFAULT_UNIVERSE =
  "HOME/.local/share/vertex/leveraged-etf-spreads-universe.json";
const FAKE_UV =
  '#!/usr/bin/env bash\necho "args:${*//"$HOME"/HOME} cwd:${PWD#"$HOME"/}"\nexit "${FAKE_UV_EXIT:-0}"\n';
const output = (
  cwd: string,
  store = DEFAULT_STORE,
  universe = DEFAULT_UNIVERSE
): string =>
  `args:${UV_ARGS} --store ${store} --universe ${universe} cwd:${cwd}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const runWrapper = (
  env: Record<string, string>,
  runner = "runner",
  exitCode = 0
): string => {
  const root = mkdtempSync(join(tmpdir(), "leveraged-etf-spreads-units-"));
  roots.push(root);
  const shims = join(root, ".local/share/mise/shims");
  mkdirSync(shims, { recursive: true });
  mkdirSync(join(root, runner), { recursive: true });
  writeFileSync(join(shims, "uv"), FAKE_UV);
  chmodSync(join(shims, "uv"), 0o755);
  const result = spawnSync("bash", [WRAPPER], {
    encoding: "utf8",
    env: {
      FAKE_UV_EXIT: String(exitCode),
      HOME: root,
      ...(runner === DEFAULT_RUNNER
        ? {}
        : { LEVERAGED_ETF_SPREADS_RUNNER_DIR: join(root, runner) }),
      ...env,
    },
  });
  // The unit state is the exit code of the collector: 1 marks a fault.
  expect(result.status).toBe(exitCode);
  return result.stdout.trim();
};

describe("vertex-leveraged-etf-spreads units", () => {
  it("the timer runs at 10:45, 12:45 and 14:45 on weekdays in New York time", () => {
    const timer = read("vertex-leveraged-etf-spreads.timer");
    expect(values(timer, "OnCalendar")).toEqual(
      ["10:45", "12:45", "14:45"].map(
        (time) => `Mon..Fri *-*-* ${time}:00 America/New_York`
      )
    );
    expect(values(timer, "AccuracySec")).toEqual(["30s"]);
    // A run that was missed must not start late, at another time of day.
    expect(values(timer, "Persistent")).toEqual(["false"]);
  });

  it("the service runs the wrapper, which owns the runner worktree path", () => {
    const service = read("vertex-leveraged-etf-spreads.service");
    expect(values(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-leveraged-etf-spreads-run",
    ]);
    // A WorkingDirectory here would fail at chdir when only LEVERAGED_ETF_SPREADS_RUNNER_DIR names the
    // worktree.
    expect(values(service, "WorkingDirectory")).toEqual([]);
    expect(values(service, "Type")).toEqual(["oneshot"]);
    expect(values(service, "EnvironmentFile")).toEqual([
      "-%h/.config/vertex/leveraged-etf-spreads.env",
    ]);
    expect(values(service, "NoNewPrivileges")).toEqual(["yes"]);
    expect(values(service, "TimeoutStartSec")).toEqual(["900"]);
  });

  it("the service header names the install and rollback commands", () => {
    const service = read("vertex-leveraged-etf-spreads.service");
    expect(service).toContain(
      "# systemctl --user daemon-reload && systemctl --user enable --now vertex-leveraged-etf-spreads.timer"
    );
    expect(service).toContain(
      "# systemctl --user disable --now vertex-leveraged-etf-spreads.timer"
    );
  });

  it("the wrapper runs the collector with the pinned yfinance, the default store and universe", () => {
    expect(runWrapper({})).toBe(output("runner"));
  });

  it("the wrapper defaults to the public spreads runner worktree", () => {
    expect(runWrapper({}, DEFAULT_RUNNER)).toBe(output(DEFAULT_RUNNER));
  });

  it("the wrapper changes to LEVERAGED_ETF_SPREADS_RUNNER_DIR when it is set", () => {
    expect(runWrapper({}, "other/worktree")).toBe(output("other/worktree"));
  });

  it("the wrapper writes to LEVERAGED_ETF_SPREADS_STORE when it is set", () => {
    expect(runWrapper({ LEVERAGED_ETF_SPREADS_STORE: "/data/spreads" })).toBe(
      output("runner", "/data/spreads")
    );
  });

  it("the wrapper reads LEVERAGED_ETF_SPREADS_UNIVERSE when it is set", () => {
    expect(
      runWrapper({ LEVERAGED_ETF_SPREADS_UNIVERSE: "/data/universe.json" })
    ).toBe(output("runner", DEFAULT_STORE, "/data/universe.json"));
  });

  it("the wrapper runs the uv of LEVERAGED_ETF_SPREADS_UV when it is set", () => {
    const root = mkdtempSync(join(tmpdir(), "leveraged-etf-spreads-units-"));
    roots.push(root);
    mkdirSync(join(root, "runner"));
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools/uv"), FAKE_UV);
    chmodSync(join(root, "tools/uv"), 0o755);
    // No mise shim exists in this home, so only the named uv can print the line.
    const result = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: {
        HOME: root,
        LEVERAGED_ETF_SPREADS_RUNNER_DIR: join(root, "runner"),
        LEVERAGED_ETF_SPREADS_UV: join(root, "tools/uv"),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(output("runner"));
  });

  it("the wrapper passes more arguments on to the collector", () => {
    const root = mkdtempSync(join(tmpdir(), "leveraged-etf-spreads-units-"));
    roots.push(root);
    const shims = join(root, ".local/share/mise/shims");
    mkdirSync(shims, { recursive: true });
    mkdirSync(join(root, "runner"));
    writeFileSync(join(shims, "uv"), FAKE_UV);
    chmodSync(join(shims, "uv"), 0o755);
    const result = spawnSync("bash", [WRAPPER, "--extra", "value"], {
      encoding: "utf8",
      env: {
        HOME: root,
        LEVERAGED_ETF_SPREADS_RUNNER_DIR: join(root, "runner"),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `args:${UV_ARGS} --store ${DEFAULT_STORE} --universe ${DEFAULT_UNIVERSE} --extra value cwd:runner`
    );
  });

  it("the wrapper passes the exit code of the collector through", () => {
    expect(runWrapper({}, "runner", 1)).toBe(output("runner"));
  });

  it("the wrapper exits 127 with a message when uv is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "leveraged-etf-spreads-units-"));
    roots.push(root);
    mkdirSync(join(root, "runner"));
    const result = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: {
        HOME: root,
        LEVERAGED_ETF_SPREADS_RUNNER_DIR: join(root, "runner"),
      },
    });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `uv is not installed (${root}/.local/share/mise/shims/uv); run mise use -g uv`
    );
  });
});
