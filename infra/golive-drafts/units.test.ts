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
// reads a plan, runs the generator, fetches data or posts anything: the uv of the data refresh is a
// fake too, and the wrapper looks for uv under HOME only.
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
  /** The body of the fake uv after its record lines; `null` installs no uv. */
  uv?: string | null;
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
      '#!/usr/bin/env bash\necho collect >> "$HOME/order.log"\necho "args:$* key:$VERTEX_AGENT_API_KEY data:${GOLIVE_DATA_DIR#"$HOME"/} chains:${GOLIVE_CHAIN_STORE#"$HOME"/} python:${GOLIVE_PYTHON#"$HOME"/} cwd:${PWD#"$HOME"/}"\n'
    );
    chmodSync(join(bin, "bun"), 0o755);
  }
  if (setup.python !== false) {
    const bin = join(root, ".local/share/vertex/nautilus-venv/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "python"), "#!/usr/bin/env bash\n");
    chmodSync(join(bin, "python"), 0o755);
  }
  if (setup.uv !== null) {
    // Records its arguments and its whole environment, then writes one file to --out.
    const bin = join(root, ".local/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "uv"),
      `#!/usr/bin/env bash\necho refresh >> "$HOME/order.log"\necho "$*" > "$HOME/uv-args.log"\nenv > "$HOME/uv-env.log"\n${
        setup.uv ??
        'out=""; previous=""; for a in "$@"; do [[ "$previous" == "--out" ]] && out="$a"; previous="$a"; done; echo fresh > "$out/SPY.csv"'
      }\n`
    );
    chmodSync(join(bin, "uv"), 0o755);
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

const log = (root: string, name: string): string =>
  readFileSync(join(root, name), "utf8");
const DATA = "Documents/reports/vertex-qc-ports/data";
const COLLECT_LINE = `args:run vertex:golive:collect key:${KEY} data:${DATA} chains:.local/share/vertex/option-chain python:.local/share/vertex/nautilus-venv/bin/python cwd:runner`;
const FETCH =
  "run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 python research/backtests/qc-ports/fetch_data.py";

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

  it("the service does not restart, names no other unit and outlasts the bounded data refresh", () => {
    const service = read("vertex-golive-drafts.service");
    const timer = read("vertex-golive-drafts.timer");
    const keys = (text: string): string[] =>
      text
        .split("\n")
        .filter((line) => /^[A-Za-z]+=/.test(line))
        .map((line) => line.slice(0, line.indexOf("=")));
    expect(keys(service)).toEqual([
      "Description",
      "After",
      "Type",
      "EnvironmentFile",
      "ExecStart",
      "TimeoutStartSec",
      "NoNewPrivileges",
    ]);
    expect(values(service, "After")).toEqual(["network-online.target"]);
    // No Unit= in the timer: it starts the service of its own name only.
    expect(keys(timer)).toEqual([
      "Description",
      "OnCalendar",
      "OnCalendar",
      "OnCalendar",
      "AccuracySec",
      "Persistent",
      "WantedBy",
    ]);
    // 600 s of refresh, 10 s to kill it, and the 300 s the collect had before.
    expect(
      Number(values(service, "TimeoutStartSec")[0])
    ).toBeGreaterThanOrEqual(910);
    expect(read("vertex-golive-drafts-run")).toContain(
      'timeout -k 10 "${GOLIVE_REFRESH_TIMEOUT:-600}"'
    );
  });

  it("the wrapper refreshes the data through uv before the collect, ending before the trading day", () => {
    const root = home();
    const result = runWrapper(root, {}, ["--trading-day", "2026-12-01"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(log(root, "order.log")).toBe("refresh\ncollect\n");
    const args = log(root, "uv-args.log").trim();
    expect(args).toMatch(
      new RegExp(
        `^${FETCH.replaceAll(".", "\\.")} --out ${root}/${DATA}\\.refresh\\.[A-Za-z0-9]{6} --end 2026-12-01$`
      )
    );
    // The fetched file moved into the data directory and the work directory is gone.
    expect(log(root, `${DATA}/SPY.csv`)).toBe("fresh\n");
    const work = spawnSync("bash", [
      "-c",
      `ls -d ${root}/Documents/reports/vertex-qc-ports/data.refresh.* 2>/dev/null`,
    ]);
    expect(work.stdout.toString()).toBe("");
  });

  it("the refresh ends today in New York when no trading day is given", () => {
    const root = home();
    runWrapper(root);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date());
    const end = log(root, "uv-args.log").trim().split(" --end ")[1] ?? "";
    // A run across New York midnight may see the day after.
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect([today, next.toISOString().slice(0, 10)]).toContain(end);
  });

  it("the refresh gets HOME and PATH only: no write key, also when the caller's environment has one", () => {
    const root = home();
    const result = runWrapper(root, {
      SOME_OTHER_SETTING: "x",
      VERTEX_AGENT_API_KEY: "key-of-the-caller",
    });
    expect(result.status).toBe(0);
    const env = log(root, "uv-env.log");
    expect(env).not.toContain(KEY);
    expect(env).not.toContain("key-of-the-caller");
    expect(env).not.toContain("VERTEX_AGENT_API_KEY");
    const names = env
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")))
      // bash sets these itself in the fake.
      .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
      .sort();
    expect(names).toEqual(["HOME", "PATH"]);
    // The collect still gets the key of the file.
    expect(result.stdout.trim()).toBe(COLLECT_LINE);
    // The key is read after the refresh, and the fetch starts from an empty environment.
    const script = read("vertex-golive-drafts-run");
    expect(script.indexOf('refresh_data "$@"')).toBeLessThan(
      script.indexOf('VERTEX_AGENT_API_KEY="$(')
    );
    expect(script).toContain('env -i "${settings[@]}" timeout');
  });

  it("the refresh gets the two IBKR history settings when both are set", () => {
    const root = home();
    runWrapper(root, {
      VERTEX_DEPLOY_STATUS_TOKEN: "t",
      VERTEX_HISTORY_URL: "https://h",
    });
    const env = log(root, "uv-env.log");
    expect(env).toContain("VERTEX_HISTORY_URL=https://h\n");
    expect(env).toContain("VERTEX_DEPLOY_STATUS_TOKEN=t\n");
  });

  it("GOLIVE_SKIP_REFRESH=1 skips the refresh, says so and runs the collect", () => {
    const root = home();
    const result = runWrapper(root, { GOLIVE_SKIP_REFRESH: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      "vertex-golive-drafts-run: data refresh skipped (GOLIVE_SKIP_REFRESH=1)\n"
    );
    expect(log(root, "order.log")).toBe("collect\n");
    expect(result.stdout.trim()).toBe(COLLECT_LINE);
  });

  it.each([
    [
      "fails",
      {
        uv: 'echo partial > "${@: -3:1}/SPY.csv"; echo "no data for SPY" >&2; exit 3',
      },
      {},
      "the data refresh failed (exit 3)",
    ],
    [
      "times out",
      { uv: "exec sleep 20" },
      { GOLIVE_REFRESH_TIMEOUT: "1" },
      "the data refresh timed out after 1 s",
    ],
    ["has no uv", { uv: null }, {}, "the data refresh failed (exit 127)"],
  ] as const)(
    "a refresh that %s is reported on stderr, leaves the old data and does not stop the collect",
    (_name, setup, env, message) => {
      const root = home(setup);
      mkdirSync(join(root, DATA), { recursive: true });
      writeFileSync(join(root, DATA, "SPY.csv"), "old\n");
      const result = runWrapper(root, env);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`vertex-golive-drafts-run: ${message}`);
      expect(result.stderr).toContain(
        `${root}/${DATA} is unchanged and the collect runs on it`
      );
      expect(result.stderr).not.toContain(KEY);
      expect(log(root, `${DATA}/SPY.csv`)).toBe("old\n");
      expect(log(root, "order.log").endsWith("collect\n")).toBe(true);
      expect(result.stdout.trim()).toBe(COLLECT_LINE);
    }
  );

  it("the wrapper runs the collect script with the key from its file and the default directories", () => {
    const result = runWrapper(home());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(COLLECT_LINE);
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
