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

// The rig units for the go-live draft collection are the files to install in ~/.config/systemd/user
// and ~/.local/bin. The wrapper runs against a fake bun and a fake Python in a temp home, so no test
// reads a plan, runs the generator or posts anything.
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const values = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

const WRAPPER = fileURLToPath(
  new URL("./vertex-golive-drafts-run", import.meta.url)
);
const DEFAULT_RUNNER = "Github/trading/vertex-research-public-ticks-runner";
const KEY = "secret-write-key";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

type Home = Readonly<{
  bun?: boolean;
  keyMode?: number | null;
  python?: boolean;
  runner?: string;
}>;

/** A temp home with the runner checkout, the pinned bun, the Python and the key file. */
const home = (setup: Home = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "golive-units-"));
  roots.push(root);
  const runner = setup.runner ?? "runner";
  mkdirSync(join(root, runner), { recursive: true });
  writeFileSync(join(root, runner, ".bun-version"), "9.8.7\n");
  if (setup.bun !== false) {
    const bin = join(root, ".local/share/mise/installs/bun/9.8.7/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "bun"),
      '#!/usr/bin/env bash\necho "args:$* key:$VERTEX_AGENT_API_KEY data:${GOLIVE_DATA_DIR#"$HOME"/} chains:${GOLIVE_CHAIN_STORE#"$HOME"/} python:${GOLIVE_PYTHON#"$HOME"/} cwd:${PWD#"$HOME"/}"\n'
    );
    chmodSync(join(bin, "bun"), 0o755);
  }
  if (setup.python !== false) {
    const bin = join(root, ".local/share/vertex/nautilus-venv/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "python"), "#!/usr/bin/env bash\n");
    chmodSync(join(bin, "python"), 0o755);
  }
  if (setup.keyMode !== null) {
    mkdirSync(join(root, ".config/vertex"), { recursive: true });
    const key = join(root, ".config/vertex/sector-rotation-key");
    writeFileSync(key, `${KEY}\r\n`);
    chmodSync(key, setup.keyMode ?? 0o600);
  }
  return root;
};

const runWrapper = (
  root: string,
  env: Record<string, string> = {},
  args: readonly string[] = []
) =>
  spawnSync("bash", [WRAPPER, ...args], {
    encoding: "utf8",
    env: {
      GOLIVE_RUNNER_DIR: join(root, "runner"),
      HOME: root,
      VERTEX_ORIGIN: "https://v",
      ...env,
    },
  });

describe("vertex-golive-drafts units", () => {
  it("the timer runs before the open and after each chain snapshot, on weekdays in New York time", () => {
    const timer = read("vertex-golive-drafts.timer");
    expect(values(timer, "OnCalendar")).toEqual(
      ["07:15", "12:40", "15:40"].map(
        (time) => `Mon..Fri *-*-* ${time}:00 America/New_York`
      )
    );
    expect(values(timer, "Persistent")).toEqual(["true"]);
    expect(values(timer, "WantedBy")).toEqual(["timers.target"]);
    // Each later run starts after a snapshot run of infra/option-chain has started.
    const snapshots = values(
      readFileSync(
        fileURLToPath(
          new URL("../option-chain/vertex-option-chain.timer", import.meta.url)
        ),
        "utf8"
      ),
      "OnCalendar"
    );
    expect(snapshots).toEqual(
      ["12:30", "15:30"].map(
        (time) => `Mon..Fri *-*-* ${time}:00 America/New_York`
      )
    );
  });

  it("the service runs the wrapper once, with nonsecret settings from its environment file", () => {
    const service = read("vertex-golive-drafts.service");
    expect(values(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-golive-drafts-run",
    ]);
    expect(values(service, "EnvironmentFile")).toEqual([
      "-%h/.config/vertex/golive-drafts.env",
    ]);
    expect(values(service, "Type")).toEqual(["oneshot"]);
    // A WorkingDirectory here would fail at chdir when only GOLIVE_RUNNER_DIR names the checkout.
    expect(values(service, "WorkingDirectory")).toEqual([]);
    expect(values(service, "NoNewPrivileges")).toEqual(["yes"]);
  });

  it("the wrapper runs the collect script with the key from its file and the default directories", () => {
    const result = runWrapper(home());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `args:run vertex:golive:collect key:${KEY} data:Documents/reports/vertex-qc-ports/data chains:.local/share/vertex/option-chain python:.local/share/vertex/nautilus-venv/bin/python cwd:runner`
    );
  });

  it("the wrapper passes its arguments on and takes the directories, the Python and the key file from the environment", () => {
    const root = home({ keyMode: null, python: false });
    writeFileSync(join(root, "other-key"), `${KEY}\n`);
    chmodSync(join(root, "other-key"), 0o600);
    writeFileSync(join(root, "python"), "#!/usr/bin/env bash\n");
    chmodSync(join(root, "python"), 0o755);
    const result = runWrapper(
      root,
      {
        GOLIVE_CHAIN_STORE: join(root, "chains"),
        GOLIVE_DATA_DIR: join(root, "data"),
        GOLIVE_KEY_FILE: join(root, "other-key"),
        GOLIVE_PYTHON: join(root, "python"),
      },
      ["--dry-run", "--trading-day", "2026-12-01"]
    );
    expect(result.stdout.trim()).toBe(
      `args:run vertex:golive:collect --dry-run --trading-day 2026-12-01 key:${KEY} data:data chains:chains python:python cwd:runner`
    );
  });

  it("the wrapper defaults to the public ticks runner checkout", () => {
    const root = home({ runner: DEFAULT_RUNNER });
    const result = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { HOME: root, VERTEX_ORIGIN: "https://v" },
    });
    expect(result.stdout.trim()).toContain(`cwd:${DEFAULT_RUNNER}`);
  });

  it("the wrapper exits 127 with a message when the pinned bun or the Python is not installed", () => {
    const noBun = home({ bun: false });
    const first = runWrapper(noBun);
    expect(first.status).toBe(127);
    expect(first.stdout).toBe("");
    expect(first.stderr).toContain(
      `the pinned bun is not installed (${noBun}/.local/share/mise/installs/bun/9.8.7/bin/bun); run mise install in ${noBun}/runner`
    );
    const noPython = home({ python: false });
    const second = runWrapper(noPython);
    expect(second.status).toBe(127);
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain(
      `no Python at ${noPython}/.local/share/vertex/nautilus-venv/bin/python; set GOLIVE_PYTHON`
    );
  });

  it.each([
    [
      "VERTEX_ORIGIN is not set",
      {},
      { VERTEX_ORIGIN: "" },
      "VERTEX_ORIGIN or the key file",
    ],
    [
      "the key file is missing",
      { keyMode: null },
      {},
      "VERTEX_ORIGIN or the key file",
    ],
    [
      "the key file is readable by others",
      { keyMode: 0o644 },
      {},
      "must have mode 0600",
    ],
  ] as const)(
    "the wrapper runs nothing and exits 64 when %s, without printing the key",
    (_name, setup, env, message) => {
      const result = runWrapper(home(setup), env);
      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("nothing was run");
      expect(result.stderr).not.toContain(KEY);
    }
  );
});
