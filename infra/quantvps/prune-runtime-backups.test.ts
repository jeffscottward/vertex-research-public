import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The retention rule for the runtime tree backups on QuantVPS. No test reaches QuantVPS: the
// remote runner is `bash -c`, so every remote command (listing, rename, delete) runs against a
// temp checkout on the test machine. Each test starts several processes, so the groups get a 30 s
// timeout, like the process tests of the other QuantVPS scripts.
const script = fileURLToPath(
  new URL("./prune-runtime-backups.sh", import.meta.url)
);
const restartScript = fileURLToPath(
  new URL("./restart-when-idle.sh", import.meta.url)
);
const stageScript = fileURLToPath(
  new URL("./stage-runtime.sh", import.meta.url)
);
const webPruneScript = fileURLToPath(
  new URL("./prune-web-backups.sh", import.meta.url)
);

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { force: true, recursive: true });
  }
  dir = "";
});

/** The n-th test timestamp (n from 0), in name order. */
const stamp = (n: number): string =>
  `202611${String(Math.floor(n / 24) + 1).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}0000Z`;
const stamps = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, n) => stamp(from + n));
const root = (): string => join(dir, "checkout");
const sha = (n: number): string => `abcdef${String(n).padStart(6, "0")}`;

/** A complete backup as a finished swap leaves it: its units, PATHS, DONE and COMPLETE. */
const addBackup = (ts: string, n: number): void => {
  const b = join(root(), `.runtime-bak-${ts}`);
  mkdirSync(join(b, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(b, "node_modules", "pkg", "index.js"), `old ${n}`);
  writeFileSync(join(b, "package.json"), "{}");
  writeFileSync(join(b, "RUNTIME_SHA"), `${sha(n)}\n`);
  writeFileSync(join(b, "PATHS"), "RUNTIME_SHA\nnode_modules\npackage.json\n");
  writeFileSync(join(b, "DONE"), "RUNTIME_SHA\nnode_modules\npackage.json\n");
  writeFileSync(join(b, "COMPLETE"), "");
};

/** A sandbox checkout with a live runtime tree and `count` complete backups. */
const sandbox = (count: number): void => {
  dir = mkdtempSync(join(tmpdir(), "prune-runtime-backups-"));
  mkdirSync(join(root(), "apps", "web"), { recursive: true });
  mkdirSync(join(root(), "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root(), "node_modules", "pkg", "index.js"), "live");
  writeFileSync(join(root(), "RUNTIME_SHA"), "fedcba000099\n");
  for (let n = 0; n < count; n += 1) {
    addBackup(stamp(n), n);
  }
};

const names = (): string[] =>
  readdirSync(root())
    .filter((name) => name.startsWith(".runtime-"))
    .sort();
const backupStamps = (): string[] =>
  names()
    .filter((name) => name.startsWith(".runtime-bak-"))
    .map((name) => name.slice(".runtime-bak-".length));
const renamed = (): string[] =>
  names().filter((name) => name.startsWith(".runtime-prune-"));

const sandboxEnv = (): Record<string, string> => ({
  VERTEX_RESTART_LOCK: join(dir, "lock"),
  VERTEX_WEB_DIR: join(root(), "apps", "web"),
  VERTEX_WEB_SSH: "bash -c",
  XDG_STATE_HOME: join(dir, "state"),
});

const run = (args: string[] = [], env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...sandboxEnv(), ...env },
  });
  const lines = result.stdout.trim().split("\n");
  return {
    last: lines.at(-1) ?? "",
    lines,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

/** The pure rule: `--plan <listing>` prints the plan lines. */
const plan = (listing: string[], args: string[] = []): string[] => {
  dir = dir || mkdtempSync(join(tmpdir(), "prune-runtime-backups-"));
  const file = join(dir, "listing");
  writeFileSync(file, `${listing.join("\n")}\n`);
  const result = spawnSync("bash", [script, "--plan", file, ...args], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim().split("\n");
};
const backupLines = (count: number): string[] =>
  stamps(0, count).map((ts) => `N d C .runtime-bak-${ts}`);
const of = (lines: string[], kind: string): string[] =>
  lines
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => line.slice(kind.length + 1));
/** The timestamps of the "  deleted <TS> (<n> s)" lines of a run. */
const deletedIn = (lines: string[]): string[] =>
  lines.flatMap(
    (line) => line.match(/^ {2}deleted (\S+) \(\d+ s\)$/)?.slice(1) ?? []
  );
const log = (): string =>
  readFileSync(join(dir, "state", "vertex-runtime-prune.log"), "utf8");

describe("rule (--plan)", { timeout: 30_000 }, () => {
  it("keeps every backup when there are 2 or fewer", () => {
    const lines = plan(backupLines(2));
    expect(of(lines, "keep")).toEqual(stamps(0, 2));
    expect(of(lines, "delete")).toEqual([]);
    expect(lines).toContain("over 0");
    expect(lines.at(-1)).toBe("plan-ok");
    expect(plan(["N d C .runtime-bak-20261101T000000Z"]).at(-1)).toBe(
      "plan-ok"
    );
    expect(plan([]).at(-1)).toBe("plan-ok");
  });

  it("previews every backup over the keep count and keeps the newest 2", () => {
    const lines = plan(backupLines(7));
    expect(of(lines, "delete")).toEqual(stamps(0, 5));
    expect(of(lines, "keep")).toEqual(stamps(5, 2));
    expect(lines).toContain("over 5");
  });

  it("orders backups by the timestamp in the name, not by listing order", () => {
    const lines = plan([...backupLines(4)].reverse());
    expect(of(lines, "delete")).toEqual(stamps(0, 2));
    expect(of(lines, "keep")).toEqual(stamps(2, 2));
  });

  it("limits an apply plan to the oldest backup and counts renamed folders that wait", () => {
    const apply = plan(backupLines(7), ["--apply"]);
    expect(of(apply, "delete")).toEqual([stamp(0)]);
    expect(of(apply, "keep")).toEqual(stamps(1, 6));
    expect(apply).toContain("over 5");
    const waiting = ["N d - .runtime-prune-20261001T000000Z"];
    const lines = plan([...backupLines(7), ...waiting], ["--apply"]);
    expect(of(lines, "delete")).toEqual([]);
    expect(lines).toContain("waiting 1");
    expect(of(lines, "leftover")).toEqual([".runtime-prune-20261001T000000Z"]);
    expect(lines.at(-1)).toBe("plan-ok");
  });

  it("stops on an unfinished swap in a backup or a failed tree", () => {
    for (const line of [
      "N d I .runtime-bak-20261201T000000Z",
      "N d I .runtime-failed-20261201T000000Z",
      "N l I .runtime-bak-20261201T000000Z",
      "N d I .runtime-bak-odd",
      "B I",
    ]) {
      const lines = plan([...backupLines(4), line]);
      expect(lines.at(-1)).not.toBe("plan-ok");
      expect(lines[0]).toMatch(/^error an unfinished runtime swap: /);
      expect(of(lines, "delete")).toEqual([]);
    }
  });

  it("never counts an UNDONE, empty or failed folder as a backup", () => {
    const lines = plan([
      ...backupLines(3),
      "N d U .runtime-bak-20261201T000000Z",
      "N d E .runtime-bak-20261202T000000Z",
      "N d C .runtime-failed-20261202T000000Z",
      "N d U .runtime-failed-20261203T000000Z",
    ]);
    expect(of(lines, "keep")).toEqual(stamps(1, 2));
    expect(of(lines, "delete")).toEqual([stamp(0)]);
    expect(of(lines, "unmanaged").sort()).toEqual([
      ".runtime-bak-20261201T000000Z UNDONE: a refused swap, put back",
      ".runtime-bak-20261202T000000Z empty: its tree went back live in a rollback",
      ".runtime-failed-20261202T000000Z failed tree of a rollback",
      ".runtime-failed-20261203T000000Z failed tree of a rollback",
    ]);
  });

  it("skips symlinks, files, other name forms and folders with both markers", () => {
    const lines = plan([
      ...backupLines(2),
      "N l C .runtime-bak-20261201T000000Z",
      "N f - .runtime-bak-20261202T000000Z",
      "N d C .runtime-bak-2026-12-03",
      "N d X .runtime-bak-20261204T000000Z",
      "N d - .runtime-prune-old",
      "N l - .runtime-prune-20261205T000000Z",
      "B C",
      "N d C .runtime-bak-20261206T000000Z extra",
    ]);
    expect(of(lines, "keep")).toEqual(stamps(0, 2));
    expect(of(lines, "skip").sort()).toEqual([
      ".runtime-bak-2026-12-03 name form",
      ".runtime-bak-20261201T000000Z not a directory",
      ".runtime-bak-20261202T000000Z not a directory",
      ".runtime-bak-20261204T000000Z both COMPLETE and UNDONE",
      ".runtime-prune-20261205T000000Z not a directory",
      ".runtime-prune-old name form",
    ]);
    expect(lines).toContain("strange 2");
    expect(lines).toContain("waiting 0");
  });

  it("blocks a backup whose renamed name exists and goes on with the next one", () => {
    const lines = plan(
      [...backupLines(5), `N f - .runtime-prune-${stamp(0)}`],
      ["--apply"]
    );
    expect(of(lines, "blocked")).toEqual([stamp(0)]);
    expect(of(lines, "delete")).toEqual([stamp(1)]);
    expect(of(lines, "keep")).toEqual(stamps(2, 3));
  });
});

describe("preview", { timeout: 30_000 }, () => {
  it("prints the plan and changes nothing", () => {
    sandbox(7);
    const before = names();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.lines[0]).toBe(
      `prune-runtime-backups: mode=preview folder=${root().replace(/^\/home\/[^/]+\//, "/home/*/")} live=fedcba000099 keep=2 limit=1`
    );
    expect(result.lines).toContain(`delete ${stamp(0)} ${sha(0)}`);
    expect(result.lines).toContain(`keep ${stamp(6)} ${sha(6)}`);
    expect(result.stdout).toContain(
      "note: 5 complete backups are over the keep count; one --apply run deletes at most 1 (the oldest first)"
    );
    expect(result.stdout).toMatch(
      /summary mode=preview backups_before=7 delete=5 over=5 leftover_folders=0 used_before_mib=\d+/
    );
    expect(result.last).toBe("PREVIEW: nothing deleted");
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(run(["--dry-run"]).last).toBe("PREVIEW: nothing deleted");
  });

  it("marks a backup at the live commit and lists folders it does not manage", () => {
    sandbox(3);
    writeFileSync(join(root(), "RUNTIME_SHA"), `${sha(2)}\n`);
    mkdirSync(join(root(), ".runtime-failed-20261205T000000Z"));
    writeFileSync(
      join(root(), ".runtime-failed-20261205T000000Z", "COMPLETE"),
      ""
    );
    mkdirSync(join(root(), ".runtime-next"));
    const result = run();
    expect(result.lines).toContain(`keep ${stamp(2)} ${sha(2)} = live`);
    expect(result.lines).toContain(
      "not managed: .runtime-failed-20261205T000000Z (failed tree of a rollback; 0 MiB with the files it shares by hard link)"
    );
    expect(result.stdout).not.toContain(".runtime-next");
  });
});

describe("--apply", { timeout: 30_000 }, () => {
  it("deletes the oldest backup over the keep count and writes the record", () => {
    sandbox(3);
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 1 backup(s)");
    expect(result.lines).toContain(`  renamed ${stamp(0)} ${sha(0)}`);
    expect(deletedIn(result.lines)).toContain(`${stamp(0)}`);
    expect(result.stdout).toMatch(
      /summary mode=apply backups_before=3 renamed=1 deleted=1 backups_after=2 over_after=0 leftover_folders=0 /
    );
    expect(backupStamps()).toEqual(stamps(1, 2));
    expect(renamed()).toEqual([]);
    expect(log()).toMatch(
      new RegExp(
        `^\\S+ delete ${stamp(0)} ${sha(0)}\\n\\S+ run renamed=1 keep=2 rc=0\\n$`
      )
    );
  });

  it("deletes one backup per run and finishes a backlog over later runs", () => {
    sandbox(7);
    const first = run(["--apply"]);
    expect(first.status).toBe(0);
    expect(first.last).toBe(
      "PRUNED: 1 backup(s); more remain (4 over the keep count, 0 renamed folder(s) wait); the next run continues"
    );
    expect(backupStamps()).toEqual(stamps(1, 6));
    for (let n = 0; n < 3; n += 1) {
      expect(run(["--apply"]).last).toContain(
        "PRUNED: 1 backup(s); more remain"
      );
    }
    expect(run(["--apply"]).last).toBe("PRUNED: 1 backup(s)");
    expect(backupStamps()).toEqual(stamps(5, 2));
    const idle = run(["--apply"]);
    expect(idle.last).toBe("PRUNED: 0 backup(s)");
    expect(idle.stdout).toContain("renamed=0 deleted=0 backups_after=2");
  });

  it("does nothing and takes no lock when no backup is over the keep count", () => {
    sandbox(2);
    const before = names();
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 0 backup(s)");
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  it("keeps the live files that a backup shares through hard links and never follows a symlink", () => {
    sandbox(3);
    const live = join(root(), "node_modules", "pkg", "index.js");
    const old = join(root(), `.runtime-bak-${stamp(0)}`, "node_modules");
    linkSync(live, join(old, "shared.js"));
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "keep.txt"), "outside");
    symlinkSync(join(dir, "outside"), join(old, "link"));
    const result = run(["--apply"]);
    expect(result.last).toBe("PRUNED: 1 backup(s)");
    expect(readFileSync(live, "utf8")).toBe("live");
    expect(readFileSync(join(dir, "outside", "keep.txt"), "utf8")).toBe(
      "outside"
    );
    expect(backupStamps()).toEqual(stamps(1, 2));
  });

  it("does not count the empty backup that a rollback leaves as one of the 2", () => {
    sandbox(4);
    // A rollback moved every unit of the newest backup back to live: PATHS, DONE and COMPLETE
    // and an empty parent folder stay.
    const shell = join(root(), `.runtime-bak-${stamp(3)}`);
    rmSync(shell, { force: true, recursive: true });
    mkdirSync(join(shell, "apps"), { recursive: true });
    writeFileSync(
      join(shell, "PATHS"),
      "RUNTIME_SHA\nnode_modules\napps/web/node_modules\n"
    );
    writeFileSync(join(shell, "DONE"), "");
    writeFileSync(join(shell, "COMPLETE"), "");
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.lines).toContain(
      `not managed: .runtime-bak-${stamp(3)} (empty: its tree went back live in a rollback)`
    );
    expect(result.last).toBe("PRUNED: 1 backup(s)");
    expect(backupStamps()).toEqual(stamps(1, 3));
  });

  it("handles the folders that the restart script's real swap and rollback leave", () => {
    sandbox(3);
    const text = readFileSync(restartScript, "utf8");
    const start = text.indexOf("read -r -d '' SWAP_LIB <<'EOS'");
    const end = text.indexOf("\nEOS\n", start);
    expect(start).toBeGreaterThan(0);
    const lib = text.slice(text.indexOf("\n", start) + 1, end);
    const next = join(root(), ".runtime-next");
    mkdirSync(join(next, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(next, "node_modules", "pkg", "index.js"), "new");
    writeFileSync(join(next, "RUNTIME_SHA"), "0123456789ab\n");
    writeFileSync(join(next, "PATHS"), "RUNTIME_SHA\nnode_modules\n");
    const swap = spawnSync(
      "bash",
      [
        "-c",
        `${lib}\ncd "$1" && swap_paths .runtime-next .runtime-bak-${stamp(5)} strict && swap_paths .runtime-bak-${stamp(5)} .runtime-failed-${stamp(6)}`,
        "swap",
        root(),
      ],
      { encoding: "utf8" }
    );
    expect(swap.status).toBe(0);
    expect(readFileSync(join(root(), "RUNTIME_SHA"), "utf8")).toBe(
      "fedcba000099\n"
    );
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.lines).toContain(
      `not managed: .runtime-bak-${stamp(5)} (empty: its tree went back live in a rollback)`
    );
    expect(result.lines).toContain(
      `not managed: .runtime-failed-${stamp(6)} (failed tree of a rollback; 0 MiB with the files it shares by hard link)`
    );
    expect(deletedIn(result.lines)).toContain(`${stamp(0)}`);
    expect(backupStamps()).toEqual([...stamps(1, 2), stamp(5)]);
  });

  it("stops with exit 3 on an unfinished swap and changes nothing", () => {
    sandbox(5);
    for (const name of [
      `.runtime-bak-${stamp(9)}`,
      `.runtime-failed-${stamp(9)}`,
    ]) {
      mkdirSync(join(root(), name));
      writeFileSync(join(root(), name, "PATHS"), "node_modules\n");
      const before = names();
      const result = run(["--apply"]);
      expect(result.status).toBe(3);
      expect(result.last).toBe(
        `NOT PRUNED: an unfinished runtime swap: ${name} has neither COMPLETE nor UNDONE; repair it first (infra/quantvps/README.md, "Repair an unfinished runtime swap"); nothing changed`
      );
      expect(names()).toEqual(before);
      expect(existsSync(join(dir, "lock"))).toBe(false);
      writeFileSync(join(root(), name, "UNDONE"), "");
    }
    expect(run(["--apply"]).last).toContain(
      "PRUNED: 1 backup(s); more remain (2"
    );
  });

  it("skips with exit 8 while another process holds the restart lock", () => {
    sandbox(4);
    const before = names();
    const result = spawnSync(
      "bash",
      ["-c", 'exec 8>"$LOCK" && flock -n 8 && bash "$SCRIPT" --apply'],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...sandboxEnv(),
          LOCK: join(dir, "lock"),
          SCRIPT: script,
        },
      }
    );
    expect(result.status).toBe(8);
    expect(result.stdout).toContain(
      "NOT PRUNED: the restart lock is held (a restart, a stage or another prune runs); nothing deleted; run again later"
    );
    expect(names()).toEqual(before);
  });

  it("stops with exit 11 when the lock file cannot be opened or flock fails", () => {
    sandbox(4);
    mkdirSync(join(dir, "lock"));
    const before = names();
    const open = run(["--apply"]);
    expect(open.status).toBe(11);
    expect(open.last).toContain("NOT PRUNED: cannot open lock file");
    rmSync(join(dir, "lock"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "flock"), "#!/usr/bin/env bash\nexit 65\n");
    chmodSync(join(dir, "bin", "flock"), 0o755);
    const failed = run(["--apply"], {
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
    });
    expect(failed.status).toBe(11);
    expect(failed.last).toContain("(flock exit 65)");
    expect(names()).toEqual(before);
  });

  it("deletes renamed folders of an interrupted run first and counts them toward the limit", () => {
    sandbox(4);
    for (const ts of ["20261001T000000Z", "20261002T000000Z"]) {
      mkdirSync(join(root(), `.runtime-prune-${ts}`, "node_modules"), {
        recursive: true,
      });
    }
    const first = run(["--apply"]);
    expect(first.status).toBe(0);
    expect(deletedIn(first.lines)).toContain("20261001T000000Z");
    expect(first.last).toBe(
      "PRUNED: 1 backup(s); more remain (2 over the keep count, 1 renamed folder(s) wait); the next run continues"
    );
    expect(renamed()).toEqual([".runtime-prune-20261002T000000Z"]);
    expect(backupStamps()).toEqual(stamps(0, 4));
    expect(deletedIn(run(["--apply"]).lines)).toContain("20261002T000000Z");
    expect(deletedIn(run(["--apply"]).lines)).toContain(`${stamp(0)}`);
    expect(renamed()).toEqual([]);
    expect(backupStamps()).toEqual(stamps(1, 3));
  });
});

describe("remote call failures", { timeout: 30_000 }, () => {
  // A remote runner that fails the n-th call of one command (FAIL="<marker>:<n>") and runs every
  // other command against the sandbox.
  const RUNNER = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$CALLS"
[ "$name:$(grep -cx "$name" "$CALLS")" = "$FAIL" ] && exit 255
[ "$name" = runtime-prune-rename ] && [ -n "$BEFORE_RENAME" ] && bash -c "$BEFORE_RENAME"
exec bash -c "$cmd"
`;
  const runWithFailure = (fail: string, env: Record<string, string> = {}) => {
    writeFileSync(join(dir, "runner.sh"), RUNNER);
    chmodSync(join(dir, "runner.sh"), 0o755);
    return run(["--apply"], {
      BEFORE_RENAME: "",
      CALLS: join(dir, "calls"),
      FAIL: fail,
      VERTEX_WEB_SSH: join(dir, "runner.sh"),
      ...env,
    });
  };

  it("plans again on the host, so a backup that a deploy adds before the rename counts", () => {
    sandbox(3);
    const ts = stamp(3);
    const b = join(root(), `.runtime-bak-${ts}`);
    const add = `mkdir -p "${b}/node_modules" && printf 'node_modules\\n' >"${b}/PATHS" && : >"${b}/COMPLETE"`;
    const result = runWithFailure("none", { BEFORE_RENAME: add });
    expect(result.status).toBe(0);
    expect(deletedIn(result.lines)).toContain(`${stamp(0)}`);
    expect(backupStamps()).toEqual(stamps(1, 3));
    expect(run(["--apply"]).last).toBe("PRUNED: 1 backup(s)");
    expect(backupStamps()).toEqual(stamps(2, 2));
  });

  it("refuses the rename when a swap became unfinished after the first listing", () => {
    sandbox(4);
    const add = `mkdir -p "${root()}/.runtime-bak-${stamp(9)}"`;
    const result = runWithFailure("none", { BEFORE_RENAME: add });
    expect(result.status).toBe(3);
    expect(result.last).toContain("NOT PRUNED: an unfinished runtime swap:");
    expect(backupStamps()).toEqual([...stamps(0, 4), stamp(9)]);
  });

  it("stops with exit 3 and takes no lock when the first listing fails", () => {
    sandbox(4);
    const result = runWithFailure("runtime-prune-list:1");
    expect(result.status).toBe(3);
    expect(result.last).toBe(
      "NOT PRUNED: no complete listing of the checkout on QuantVPS; nothing changed"
    );
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  it("stops with exit 13 when the rename call fails, and the next run prunes", () => {
    sandbox(4);
    const result = runWithFailure("runtime-prune-rename:1");
    expect(result.status).toBe(13);
    expect(result.last).toContain("PARTIAL: the rename step did not complete");
    expect(backupStamps()).toEqual(stamps(0, 4));
    expect(deletedIn(run(["--apply"]).lines)).toContain(`${stamp(0)}`);
  });

  it("stops with exit 13 when the delete call fails, and the next run finishes it", () => {
    sandbox(4);
    const result = runWithFailure("runtime-prune-delete:1");
    expect(result.status).toBe(13);
    expect(result.last).toContain(
      "PARTIAL: the delete step failed; 1 backup(s) renamed"
    );
    expect(renamed()).toEqual([`.runtime-prune-${stamp(0)}`]);
    const next = run(["--apply"]);
    expect(next.status).toBe(0);
    expect(deletedIn(next.lines)).toContain(`${stamp(0)}`);
    expect(renamed()).toEqual([]);
    expect(backupStamps()).toEqual(stamps(1, 3));
  });

  it("stops with exit 13 when the listing after the delete fails", () => {
    sandbox(4);
    const result = runWithFailure("runtime-prune-list:2");
    expect(result.status).toBe(13);
    expect(result.last).toContain(
      "but the check after the delete got no complete listing"
    );
    expect(backupStamps()).toEqual(stamps(1, 3));
  });
});

describe("preconditions and usage", { timeout: 30_000 }, () => {
  it("is an executable file", () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
  });

  it("stops with exit 3 when the checkout or its RUNTIME_SHA is missing", () => {
    sandbox(4);
    rmSync(join(root(), "RUNTIME_SHA"));
    const result = run(["--apply"]);
    expect(result.status).toBe(3);
    expect(backupStamps()).toEqual(stamps(0, 4));
    expect(
      run([], { VERTEX_WEB_DIR: join(dir, "missing", "apps", "web") }).status
    ).toBe(3);
  });

  it("rejects wrong usage with exit 2 and changes nothing", () => {
    sandbox(4);
    for (const args of [["--bogus"], ["--apply", "--dry-run"], ["--plan"]]) {
      expect(run(args).status).toBe(2);
    }
    expect(backupStamps()).toEqual(stamps(0, 4));
  });
});

describe("contract with the restart and stage scripts", {
  timeout: 30_000,
}, () => {
  it("the unfinished-swap checks never look at renamed folders", () => {
    for (const file of [restartScript, stageScript]) {
      const text = readFileSync(file, "utf8");
      expect(text).toContain("for d in .runtime-bak-* .runtime-failed-*; do");
      expect(text).not.toContain(".runtime-prune-");
    }
  });

  it("uses the same default lock path and swap markers as the other scripts", () => {
    const own = readFileSync(script, "utf8");
    const lockPath =
      "${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}";
    for (const file of [restartScript, stageScript, webPruneScript, script]) {
      expect(readFileSync(file, "utf8")).toContain(lockPath);
    }
    const restart = readFileSync(restartScript, "utf8");
    expect(restart).toContain(': >"$to/COMPLETE"');
    expect(restart).toContain(': >"$to/UNDONE"');
    expect(restart).toContain(
      "swap_paths .runtime-next .runtime-bak-$RT_TS strict"
    );
    expect(own).toContain('[ -f \\"\\$d/COMPLETE\\" ]');
    expect(own).toContain('[ -f \\"\\$d/UNDONE\\" ]');
  });
});
