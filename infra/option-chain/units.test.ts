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

// The rig units for the option-chain snapshot are copies of the installed files in
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
  new URL("./vertex-option-chain-run", import.meta.url)
);
const DEFAULT_RUNNER = "Github/trading/vertex-research-public-ticks-runner";
const SNAPSHOT_ARGS =
  "run --no-project --python 3.12 --with yfinance==0.2.66 --exclude-newer 2026-11-11T00:00:00Z " +
  "python research/backtests/option-chain/snapshot.py --store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const runWrapper = (env: Record<string, string>, runner = "runner"): string => {
  const root = mkdtempSync(join(tmpdir(), "option-chain-units-"));
  roots.push(root);
  const shims = join(root, ".local/share/mise/shims");
  mkdirSync(shims, { recursive: true });
  mkdirSync(join(root, runner), { recursive: true });
  writeFileSync(
    join(shims, "uv"),
    '#!/usr/bin/env bash\necho "args:${*//"$HOME"/HOME} cwd:${PWD#"$HOME"/}"\n'
  );
  chmodSync(join(shims, "uv"), 0o755);
  const result = spawnSync("bash", [WRAPPER], {
    encoding: "utf8",
    env: {
      HOME: root,
      ...(runner === DEFAULT_RUNNER
        ? {}
        : { OPTION_CHAIN_RUNNER_DIR: join(root, runner) }),
      ...env,
    },
  });
  return result.stdout.trim();
};

describe("vertex-option-chain units", () => {
  it("the timer runs at 12:30 and 15:30 on weekdays in New York time", () => {
    const timer = read("vertex-option-chain.timer");
    expect(values(timer, "OnCalendar")).toEqual(
      ["12:30", "15:30"].map(
        (time) => `Mon..Fri *-*-* ${time}:00 America/New_York`
      )
    );
    expect(values(timer, "Persistent")).toEqual(["true"]);
  });

  it("the service runs the wrapper, which owns the runner checkout path", () => {
    const service = read("vertex-option-chain.service");
    expect(values(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-option-chain-run",
    ]);
    // A WorkingDirectory here would fail at chdir when only OPTION_CHAIN_RUNNER_DIR names the checkout.
    expect(values(service, "WorkingDirectory")).toEqual([]);
    expect(values(service, "Type")).toEqual(["oneshot"]);
  });

  it("the wrapper runs the snapshot with the pinned yfinance into the default store", () => {
    expect(runWrapper({})).toBe(
      `args:${SNAPSHOT_ARGS} HOME/.local/share/vertex/option-chain cwd:runner`
    );
  });

  it("the wrapper defaults to the public ticks runner checkout", () => {
    expect(runWrapper({}, DEFAULT_RUNNER)).toBe(
      `args:${SNAPSHOT_ARGS} HOME/.local/share/vertex/option-chain cwd:${DEFAULT_RUNNER}`
    );
  });

  it("the wrapper writes to OPTION_CHAIN_STORE when it is set", () => {
    expect(runWrapper({ OPTION_CHAIN_STORE: "/data/chains" })).toBe(
      `args:${SNAPSHOT_ARGS} /data/chains cwd:runner`
    );
  });

  it("the wrapper exits 127 with a message when uv is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "option-chain-units-"));
    roots.push(root);
    mkdirSync(join(root, "runner"));
    const result = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { HOME: root, OPTION_CHAIN_RUNNER_DIR: join(root, "runner") },
    });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `uv is not installed (${root}/.local/share/mise/shims/uv); run mise use -g uv`
    );
  });
});
