import { spawn, spawnSync } from "node:child_process";
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
      '#!/usr/bin/env bash\necho collect >> "$HOME/order.log"\ngrep SigIgn "/proc/$$/status" > "$HOME/collect-signals.log"\nls -d "$GOLIVE_DATA_DIR".refresh.* >> "$HOME/work-at-collect.log" 2>/dev/null\necho "args:$* key:$VERTEX_AGENT_API_KEY data:${GOLIVE_DATA_DIR#"$HOME"/} chains:${GOLIVE_CHAIN_STORE#"$HOME"/} python:${GOLIVE_PYTHON#"$HOME"/} cwd:${PWD#"$HOME"/}"\n'
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
const DATA = ".local/share/vertex/golive-data";
const COLLECT_LINE = `args:run vertex:golive:collect key:${KEY} data:${DATA} chains:.local/share/vertex/option-chain python:.local/share/vertex/nautilus-venv/bin/python cwd:runner`;
const FETCH =
  "run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 python research/backtests/qc-ports/fetch_data.py";

/** The New York calendar date `offset` days from today, YYYY-MM-DD. */
const nyDay = (offset = 0): string => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  const day = new Date(`${today}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
};
/** Runs `run` again when New York midnight passed during it, so `today` is the wrapper's day too. */
const onOneNewYorkDay = <T>(run: (today: string) => T): T => {
  for (;;) {
    const today = nyDay();
    const result = run(today);
    if (nyDay() === today) {
      return result;
    }
  }
};
/** The work directories of the refresh that exist beside the data directory `data` of `root`. */
const workDirectories = (root: string, data = DATA): string[] => {
  const parent = join(root, data, "..");
  const prefix = `${data.split("/").at(-1)}.refresh.`;
  return existsSync(parent)
    ? readdirSync(parent).filter((name) => name.startsWith(prefix))
    : [];
};
const endOf = (root: string): string =>
  log(root, "uv-args.log").trim().split(" --end ")[1] ?? "";

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
    const wrapper = read("vertex-golive-drafts-run");
    expect(wrapper).toContain(
      'REFRESH_TIMEOUT="${GOLIVE_REFRESH_TIMEOUT:-600}"'
    );
    expect(wrapper).toContain('timeout -k 10 "$REFRESH_TIMEOUT"');
  });

  it("the wrapper refreshes the data through uv before the collect, and the work directory is gone before the collect", () => {
    onOneNewYorkDay((today) => {
      const root = home();
      const result = runWrapper(root);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(log(root, "order.log")).toBe("refresh\ncollect\n");
      const args = log(root, "uv-args.log").trim();
      const shape = new RegExp(
        `^${FETCH.replaceAll(".", "\\.")} --out ${root}/${DATA}\\.refresh\\.[A-Za-z0-9]{6} --end (\\d{4}-\\d{2}-\\d{2})$`
      );
      expect(args).toMatch(shape);
      // --end is exclusive: the fetch ends on the last session before today in New York.
      expect([today, nyDay()]).toContain(shape.exec(args)?.[1]);
      // The fetched file moved into the data directory. The script ends in exec, where no EXIT
      // trap runs, so the work directory must be gone when the collect starts.
      expect(log(root, `${DATA}/SPY.csv`)).toBe("fresh\n");
      expect(log(root, "work-at-collect.log")).toBe("");
      expect(workDirectories(root)).toEqual([]);
    });
  });

  it.each([
    ["today", 0],
    ["tomorrow", 1],
    ["a far day", 400],
  ] as const)(
    "--trading-day %s refreshes with --end today in New York: the bar of today is never fetched",
    (_name, offset) => {
      onOneNewYorkDay((today) => {
        const root = home();
        const result = runWrapper(root, {}, ["--trading-day", nyDay(offset)]);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        if (nyDay() === today) {
          expect(endOf(root)).toBe(today);
          expect(log(root, "order.log")).toBe("refresh\ncollect\n");
        }
      });
    }
  );

  it.each([
    ["--trading-day <day>", (day: string) => ["--trading-day", day]],
    ["--trading-day=<day>", (day: string) => [`--trading-day=${day}`]],
  ] as const)(
    "a past trading day (%s) does not refresh: the fetch would cut the data back; the collect runs",
    (_name, args) => {
      onOneNewYorkDay((today) => {
        const root = home();
        mkdirSync(join(root, DATA), { recursive: true });
        writeFileSync(join(root, DATA, "SPY.csv"), "old\n");
        const past = nyDay(-1);
        const result = runWrapper(root, {}, args(past));
        expect(result.status).toBe(0);
        if (nyDay() === today) {
          expect(result.stderr).toBe(
            `vertex-golive-drafts-run: the data refresh is skipped for a past trading day (${past} is before ${today}, today in New York): a fetch that ends there would cut ${root}/${DATA} back to that day; the collect runs on the data that is there\n`
          );
        }
        expect(existsSync(join(root, "uv-args.log"))).toBe(false);
        expect(log(root, "order.log")).toBe("collect\n");
        expect(log(root, `${DATA}/SPY.csv`)).toBe("old\n");
        expect(workDirectories(root)).toEqual([]);
        expect(result.stdout).toContain(
          `args:run vertex:golive:collect ${args(past).join(" ")} key:`
        );
      });
    }
  );

  it("the refresh reads today's date in New York time and reports a date it cannot trust", () => {
    expect(read("vertex-golive-drafts-run")).toContain(
      "TZ=America/New_York date '+%F %Z'"
    );
    // Without the zone data `date` answers in UTC, which is a day ahead in the New York evening.
    // The fake date is found first: the wrapper's PATH starts with the bun directory.
    const root = home();
    const fake = join(root, ".local/share/mise/installs/bun/9.8.7/bin/date");
    writeFileSync(fake, "#!/bin/bash\necho '2026-12-01 America'\n");
    chmodSync(fake, 0o755);
    const result = runWrapper(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      `vertex-golive-drafts-run: the data refresh failed: today's date in New York could not be read (date answered '2026-12-01 America'); ${root}/${DATA} is unchanged and the collect runs on it\n`
    );
    expect(log(root, "order.log")).toBe("collect\n");
  });

  it("a move of the fetched files that fails midway is reported as a possible mix, not as unchanged, and the collect runs", () => {
    // QQQ.csv is a directory in the data directory, so mv moves SPY.csv and fails on QQQ.csv.
    const root = home({
      uv: 'out="${@: -3:1}"; echo new > "$out/SPY.csv"; echo new > "$out/QQQ.csv"',
    });
    mkdirSync(join(root, DATA, "QQQ.csv"), { recursive: true });
    writeFileSync(join(root, DATA, "SPY.csv"), "old\n");
    const result = runWrapper(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `vertex-golive-drafts-run: the data refresh fetched the files and the move into ${root}/${DATA} failed (exit 1); the directory may hold a mix of old and new files and the collect runs on it (the generator refuses the day when a series it reads has no value of the last data day)\n`
    );
    expect(result.stderr).not.toContain("unchanged");
    expect(log(root, `${DATA}/SPY.csv`)).toBe("new\n");
    expect(log(root, "order.log")).toBe("refresh\ncollect\n");
    expect(log(root, "work-at-collect.log")).toBe("");
    expect(workDirectories(root)).toEqual([]);
    expect(result.stdout.trim()).toBe(COLLECT_LINE);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)(
    "%s during the fetch stops the fetch, removes the work directory and runs no collect",
    async (signal, code) => {
      const root = home({
        uv: 'echo $$ > "$HOME/uv.pid"; exec sleep 30',
      });
      const child = spawn("bash", [WRAPPER], {
        env: {
          GOLIVE_RUNNER_DIR: join(root, "runner"),
          HOME: root,
          VERTEX_ORIGIN: "https://v",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (status) => resolve(status));
      });
      for (let tries = 0; !existsSync(join(root, "uv.pid")); tries += 1) {
        expect(tries).toBeLessThan(200);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(workDirectories(root)).toHaveLength(1);
      child.kill(signal);
      expect(await exited).toBe(code);
      expect(workDirectories(root)).toEqual([]);
      expect(stderr).toBe(
        `vertex-golive-drafts-run: stopped by ${signal} before the collect; nothing was posted\n`
      );
      expect(log(root, "order.log")).toBe("refresh\n");
      // The fetch itself is gone: its process no longer exists.
      const pid = Number(log(root, "uv.pid"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  );

  it("the collect starts with the signal handling of the caller: the traps of the refresh end before the exec", () => {
    // The fake bun records the signals it ignores (SigIgn of /proc). Run by itself it gives the
    // value of a script that inherited nothing; run by the wrapper it must give the same.
    const root = home();
    spawnSync(join(root, ".local/share/mise/installs/bun/9.8.7/bin/bun"), [], {
      env: {
        GOLIVE_DATA_DIR: join(root, DATA),
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
    });
    const alone = log(root, "collect-signals.log");
    expect(alone).toMatch(/^SigIgn:\s+[0-9a-f]{16}\n$/u);
    rmSync(join(root, "collect-signals.log"));
    runWrapper(root);
    expect(log(root, "collect-signals.log")).toBe(alone);
    const script = read("vertex-golive-drafts-run");
    expect(script.indexOf("trap - EXIT INT TERM HUP")).toBeGreaterThan(
      script.indexOf('refresh_data "$today"')
    );
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
    const refresh = script.indexOf('refresh_data "$today"');
    expect(refresh).toBeGreaterThan(0);
    expect(refresh).toBeLessThan(script.indexOf('VERTEX_AGENT_API_KEY="$('));
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

  it("the default data directory is the generator's own copy, never the shared research dataset", () => {
    // The refresh replaces files in the data directory. The shared qc-ports dataset pins the
    // inputs of other backtests (SOURCES.json, SHA256SUMS), so it must not be the default.
    const wrapper = read("vertex-golive-drafts-run");
    expect(wrapper).toContain(
      'export GOLIVE_DATA_DIR="${GOLIVE_DATA_DIR:-$HOME/.local/share/vertex/golive-data}"'
    );
    expect(wrapper).not.toMatch(
      /:-\$HOME\/Documents\/reports\/vertex-qc-ports/u
    );
    expect(COLLECT_LINE).toContain("data:.local/share/vertex/golive-data ");
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
    // A relative path would be the runner checkout for the refresh and services/research for
    // the generator: two different directories.
    [
      "GOLIVE_DATA_DIR is relative",
      {},
      { GOLIVE_DATA_DIR: "data" },
      "GOLIVE_DATA_DIR must be an absolute path below /, not 'data'",
    ],
    [
      "GOLIVE_DATA_DIR is /",
      {},
      { GOLIVE_DATA_DIR: "/" },
      "GOLIVE_DATA_DIR must be an absolute path below /, not '/'",
    ],
    [
      "GOLIVE_CHAIN_STORE is relative",
      {},
      { GOLIVE_CHAIN_STORE: "./chains" },
      "GOLIVE_CHAIN_STORE must be an absolute path below /, not './chains'",
    ],
    // The unit allows 1200 s for the refresh and the collect (TimeoutStartSec).
    [
      "GOLIVE_REFRESH_TIMEOUT is above 600",
      {},
      { GOLIVE_REFRESH_TIMEOUT: "601" },
      "GOLIVE_REFRESH_TIMEOUT must be a whole number of seconds from 1 to 600, not '601'",
    ],
    [
      "GOLIVE_REFRESH_TIMEOUT is 0 (no timeout)",
      {},
      { GOLIVE_REFRESH_TIMEOUT: "0" },
      "GOLIVE_REFRESH_TIMEOUT must be a whole number of seconds from 1 to 600, not '0'",
    ],
    [
      "GOLIVE_REFRESH_TIMEOUT has a unit",
      {},
      { GOLIVE_REFRESH_TIMEOUT: "20m" },
      "GOLIVE_REFRESH_TIMEOUT must be a whole number of seconds from 1 to 600, not '20m'",
    ],
  ] as const)(
    "the wrapper runs nothing and exits 64 when %s, without printing the key",
    (_name, setup, env, message) => {
      const root = home(setup);
      const result = runWrapper(root, env);
      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("nothing was run");
      expect(result.stderr).not.toContain(KEY);
      // No refresh and no collect, and nothing written in the runner checkout.
      expect(existsSync(join(root, "order.log"))).toBe(false);
      expect(readdirSync(join(root, "runner"))).toEqual([".bun-version"]);
    }
  );

  it("a GOLIVE_REFRESH_TIMEOUT of 600 is accepted", () => {
    const root = home();
    const result = runWrapper(root, { GOLIVE_REFRESH_TIMEOUT: "600" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(log(root, "order.log")).toBe("refresh\ncollect\n");
  });
});
