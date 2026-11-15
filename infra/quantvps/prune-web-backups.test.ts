import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The retention rule for the web build backups on QuantVPS. No test reaches QuantVPS: the remote
// runner is `bash -c`, so every remote command (listing, rename, delete) runs against a temp
// folder on the test machine. Each test starts several processes, so the groups get a 30 s
// timeout, like the process tests of the restart script.
const script = fileURLToPath(
  new URL("./prune-web-backups.sh", import.meta.url)
);
const restartScript = fileURLToPath(
  new URL("./restart-when-idle.sh", import.meta.url)
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
const web = (): string => join(dir, "web");
/** The folder as the script prints it: a user name in /home/<user>/ is shown as *. */
const shown = (path: string): string =>
  path.replace(/^\/home\/[^/]+\//, "/home/*/");

const addPair = (ts: string, sha = ""): void => {
  mkdirSync(join(web(), `dist.bak-${ts}`, "server"), { recursive: true });
  mkdirSync(join(web(), `.wrangler.bak-${ts}`, "deploy"), { recursive: true });
  writeFileSync(join(web(), `dist.bak-${ts}`, "server", "a.js"), "x");
  if (sha) {
    writeFileSync(join(web(), `dist.bak-${ts}`, "DEPLOYED_SHA"), `${sha}\n`);
  }
};

/** A sandbox apps/web folder with a live build and `pairs` backup pairs. */
const sandbox = (pairs: number, root = tmpdir()): void => {
  dir = mkdtempSync(join(root, "prune-web-backups-"));
  mkdirSync(join(web(), "dist", "server"), { recursive: true });
  mkdirSync(join(web(), ".wrangler", "deploy"), { recursive: true });
  writeFileSync(join(web(), "dist", "server", "live.js"), "live");
  writeFileSync(join(web(), "DEPLOYED_SHA"), "abcdef000009\n");
  for (let n = 0; n < pairs; n += 1) {
    addPair(stamp(n), `abcdef${String(n).padStart(6, "0")}`);
  }
};

const names = (): string[] => readdirSync(web()).sort();
const pairStamps = (): string[] =>
  names()
    .filter((name) => name.startsWith("dist.bak-"))
    .map((name) => name.slice("dist.bak-".length));
const renamed = (): string[] =>
  names().filter((name) => name.includes(".prune-"));

const sandboxEnv = (): Record<string, string> => ({
  VERTEX_RESTART_LOCK: join(dir, "lock"),
  VERTEX_WEB_DIR: web(),
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
  dir = dir || mkdtempSync(join(tmpdir(), "prune-web-backups-"));
  const file = join(dir, "listing");
  writeFileSync(file, `${listing.join("\n")}\n`);
  const result = spawnSync("bash", [script, "--plan", file, ...args], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim().split("\n");
};
const pairLines = (count: number): string[] =>
  stamps(0, count).flatMap((ts) => [
    `N d dist.bak-${ts}`,
    `N d .wrangler.bak-${ts}`,
  ]);
const of = (lines: string[], kind: string): string[] =>
  lines
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => line.slice(kind.length + 1));

describe("rule (--plan)", { timeout: 30_000 }, () => {
  it("keeps every pair when there are 10 or fewer", () => {
    const lines = plan(pairLines(4));
    expect(of(lines, "keep")).toEqual(stamps(0, 4));
    expect(of(lines, "delete")).toEqual([]);
    expect(lines).toContain("over 0");
    expect(lines.at(-1)).toBe("plan-ok");
    expect(of(plan(pairLines(10)), "delete")).toEqual([]);
  });

  it("marks the oldest pair of 11 and keeps the newest 10", () => {
    const lines = plan(pairLines(11));
    expect(of(lines, "delete")).toEqual([stamp(0)]);
    expect(of(lines, "keep")).toEqual(stamps(1, 10));
  });

  it("orders pairs by the timestamp in the name, not by listing order", () => {
    const lines = plan([...pairLines(12)].reverse());
    expect(of(lines, "delete")).toEqual([stamp(0), stamp(1)]);
    expect(of(lines, "keep")).toEqual(stamps(2, 10));
  });

  it("previews every pair over the keep count", () => {
    const lines = plan(pairLines(16));
    expect(of(lines, "delete")).toEqual(stamps(0, 6));
    expect(lines).toContain("over 6");
  });

  it("limits an apply plan to the oldest 3 pairs", () => {
    const lines = plan(pairLines(16), ["--apply"]);
    expect(of(lines, "delete")).toEqual(stamps(0, 3));
    expect(of(lines, "keep")).toEqual(stamps(3, 13));
    expect(lines).toContain("over 6");
    expect(of(plan(pairLines(12), ["--apply"]), "delete")).toEqual(
      stamps(0, 2)
    );
  });

  it("counts renamed pairs that wait for their delete toward the limit", () => {
    const waiting = [
      "N d dist.prune-20261001T000000Z",
      "N d .wrangler.prune-20261001T000000Z",
      "N d .wrangler.prune-20261002T000000Z",
    ];
    const lines = plan([...pairLines(16), ...waiting], ["--apply"]);
    expect(of(lines, "delete")).toEqual([stamp(0)]);
    const full = plan(
      [...pairLines(16), ...waiting, "N d dist.prune-20261003T000000Z"],
      ["--apply"]
    );
    expect(of(full, "delete")).toEqual([]);
    expect(full.at(-1)).toBe("plan-ok");
  });

  it("skips half pairs, other name forms and symlinks", () => {
    const lines = plan([
      ...pairLines(2),
      "N d dist.bak-20261201T000000Z",
      "N d .wrangler.bak-20261202T000000Z",
      "N d dist.bak-old",
      "N l dist.bak-20261203T000000Z",
      "N d .wrangler.bak-20261203T000000Z",
    ]);
    expect(of(lines, "keep")).toEqual([stamp(0), stamp(1)]);
    expect(of(lines, "skip").sort()).toEqual([
      ".wrangler.bak-20261202T000000Z no dist.bak pair",
      ".wrangler.bak-20261203T000000Z no dist.bak pair",
      "dist.bak-20261201T000000Z no .wrangler.bak pair",
      "dist.bak-20261203T000000Z not a directory",
      "dist.bak-old name form",
    ]);
  });

  it("never reads a pair from a listing line with a blank or another unusual character", () => {
    const lines = plan([
      ...pairLines(10),
      "B",
      "N d dist.bak-20261201T000000Z ",
      "N d .wrangler.bak-20261201T000000Z",
      "N d dist.bak-2026 1202T000000Z",
      "N d  dist.bak-20261203T000000Z",
      "N d dist.bak-20261204T000000Z\t",
      "N d dist.bak-2026$(id)T000000Z",
    ]);
    expect(of(lines, "keep")).toEqual(stamps(0, 10));
    expect(of(lines, "delete")).toEqual([]);
    expect(lines).toContain("strange 6");
    expect(of(lines, "skip")).toEqual([
      ".wrangler.bak-20261201T000000Z no dist.bak pair",
    ]);
  });

  it("blocks a pair whose timestamp already has a renamed folder and goes on with the next pair", () => {
    const lines = plan(
      [...pairLines(13), `N d .wrangler.prune-${stamp(0)}`],
      ["--apply"]
    );
    expect(of(lines, "blocked")).toEqual([stamp(0)]);
    expect(of(lines, "delete")).toEqual([stamp(1), stamp(2)]);
    expect(of(lines, "keep")).toEqual(stamps(3, 10));
    expect(lines).toContain("waiting 0");
  });

  it("reports failed and undeployed folders as unmanaged and ignores other names", () => {
    const lines = plan([
      ...pairLines(1),
      "N d dist.failed-20261101T000000Z",
      "N d .wrangler.undeployed-20261101T000000Z",
      "N d dist.other",
    ]);
    expect(of(lines, "unmanaged").sort()).toEqual([
      ".wrangler.undeployed-20261101T000000Z",
      "dist.failed-20261101T000000Z",
    ]);
    expect(lines.join("\n")).not.toContain("dist.other");
  });

  it("finishes an interrupted rename and lists renamed folders as leftovers", () => {
    const lines = plan([
      ...pairLines(1),
      "N d dist.prune-20261001T000000Z",
      "N d .wrangler.bak-20261001T000000Z",
      "N d .wrangler.prune-20261002T000000Z",
    ]);
    expect(of(lines, "finish")).toEqual(["20261001T000000Z"]);
    expect(of(lines, "leftover").sort()).toEqual([
      ".wrangler.prune-20261002T000000Z",
      "dist.prune-20261001T000000Z",
    ]);
    expect(of(lines, "skip")).toEqual([]);
  });
});

describe("preview", { timeout: 30_000 }, () => {
  it("prints the plan and changes nothing", () => {
    sandbox(14);
    addPair(stamp(14));
    const before = names();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.last).toBe("PREVIEW: nothing deleted");
    expect(result.lines[0]).toBe(
      `prune-web-backups: mode=preview folder=${shown(web())} keep=10 limit=3`
    );
    expect(result.stdout).toMatch(
      new RegExp(`^delete ${stamp(0)} abcdef000000 \\d+ MiB$`, "m")
    );
    expect(result.stdout).toMatch(
      new RegExp(`^keep ${stamp(9)} abcdef000009 \\d+ MiB = live$`, "m")
    );
    expect(result.stdout).toMatch(
      new RegExp(`^keep ${stamp(14)} none \\d+ MiB$`, "m")
    );
    expect(result.stdout).toContain(
      "note: 5 complete pairs are over the keep count; one --apply run deletes the oldest 3"
    );
    expect(result.stdout).toMatch(
      /^summary mode=preview pairs_before=15 delete=5 over=5 leftover_folders=0 used_before_mib=\d+$/m
    );
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it.skipIf(!homedir().startsWith("/home/"))(
    "prints a folder under /home without the user name",
    () => {
      sandbox(1, homedir());
      const first = run().lines[0] ?? "";
      expect(first).toMatch(/ folder=\/home\/\*\//);
      expect(first).not.toContain(homedir());
    }
  );

  it("accepts --dry-run as the preview", () => {
    sandbox(12);
    const before = names();
    expect(run(["--dry-run"]).last).toBe("PREVIEW: nothing deleted");
    expect(names()).toEqual(before);
  });

  it("reports names it does not manage", () => {
    sandbox(1);
    mkdirSync(join(web(), "dist.failed-20261101T000000Z"));
    mkdirSync(join(web(), ".wrangler.failed-20261101T000000Z"));
    mkdirSync(join(web(), "dist.bak-old"));
    const result = run();
    expect(result.stdout).toContain("not managed: 2 *.failed-* folder(s)");
    expect(result.stdout).toContain("skip dist.bak-old (name form)");
  });
});

describe("--apply", { timeout: 30_000 }, () => {
  it("deletes the oldest pair of 11 and writes the record", () => {
    sandbox(11);
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 1 pairs");
    expect(result.stdout).toMatch(
      /^summary mode=apply pairs_before=11 renamed=1 deleted=1 pairs_after=10 over_after=0 leftover_folders=0 /m
    );
    expect(pairStamps()).toEqual(stamps(1, 10));
    expect(renamed()).toEqual([]);
    expect(existsSync(join(web(), "dist", "server", "live.js"))).toBe(true);
    expect(existsSync(join(web(), ".wrangler", "deploy"))).toBe(true);
    const log = readFileSync(
      join(dir, "state", "vertex-web-prune.log"),
      "utf8"
    );
    expect(log).toMatch(
      new RegExp(
        `^\\S+ delete ${stamp(0)} abcdef000000\\n\\S+ run renamed=1 keep=10 rc=0\\n$`
      )
    );
  });

  it("does nothing and takes no lock when no pair is over the keep count", () => {
    sandbox(10);
    const before = names();
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 0 pairs");
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  it("deletes at most 3 pairs per run and finishes a backlog over later runs", () => {
    sandbox(17);
    const first = run(["--apply"]);
    expect(first.status).toBe(0);
    expect(first.last).toBe(
      "PRUNED: 3 pairs; more remain (4 over the keep count, 0 renamed pair(s) wait); the next run continues"
    );
    expect(pairStamps()).toEqual(stamps(3, 14));
    expect(run(["--apply"]).last).toContain("PRUNED: 3 pairs; more remain (1");
    expect(run(["--apply"]).last).toBe("PRUNED: 1 pairs");
    expect(pairStamps()).toEqual(stamps(7, 10));
    expect(renamed()).toEqual([]);
  });

  it("skips with exit 8 while another process holds the restart lock", () => {
    sandbox(11);
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

  it("stops with exit 11 when the lock file cannot be opened", () => {
    sandbox(11);
    mkdirSync(join(dir, "lock"));
    const before = names();
    const result = run(["--apply"]);
    expect(result.status).toBe(11);
    expect(result.last).toContain("NOT PRUNED: cannot open lock file");
    expect(names()).toEqual(before);
  });

  it("stops with exit 11 when flock fails for another reason", () => {
    sandbox(11);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "flock"), "#!/usr/bin/env bash\nexit 65\n");
    chmodSync(join(dir, "bin", "flock"), 0o755);
    const before = names();
    const result = run(["--apply"], {
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
    });
    expect(result.status).toBe(11);
    expect(result.last).toContain("(flock exit 65)");
    expect(names()).toEqual(before);
  });

  it("finishes an interrupted run before it renames more pairs", () => {
    sandbox(16);
    // An earlier run renamed three pairs and stopped: one pair is half renamed, one is half deleted.
    mkdirSync(join(web(), "dist.prune-20261001T000000Z"));
    mkdirSync(join(web(), ".wrangler.bak-20261001T000000Z"));
    mkdirSync(join(web(), ".wrangler.prune-20261002T000000Z"));
    mkdirSync(join(web(), "dist.prune-20261003T000000Z"));
    mkdirSync(join(web(), ".wrangler.prune-20261003T000000Z"));
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finished 20261001T000000Z");
    expect(result.last).toBe(
      "PRUNED: 3 pairs; more remain (6 over the keep count, 0 renamed pair(s) wait); the next run continues"
    );
    expect(names().filter((name) => name.includes("202610"))).toEqual([]);
    expect(pairStamps()).toEqual(stamps(0, 16));
  });

  it("deletes exactly 3 of 5 renamed pairs that wait and renames no further pair", () => {
    sandbox(12);
    for (const ts of ["01", "02", "03", "04", "05"]) {
      mkdirSync(join(web(), `dist.prune-202610${ts}T000000Z`));
      mkdirSync(join(web(), `.wrangler.prune-202610${ts}T000000Z`));
    }
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe(
      "PRUNED: 3 pairs; more remain (2 over the keep count, 2 renamed pair(s) wait); the next run continues"
    );
    expect(renamed()).toEqual([
      ".wrangler.prune-20261004T000000Z",
      ".wrangler.prune-20261005T000000Z",
      "dist.prune-20261004T000000Z",
      "dist.prune-20261005T000000Z",
    ]);
    expect(pairStamps()).toEqual(stamps(0, 12));
  });

  it("reports a failed delete with exit 13 and finishes on the next run", () => {
    sandbox(11);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "rm"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(dir, "bin", "rm"), 0o755);
    const failed = run(["--apply"], {
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
    });
    expect(failed.status).toBe(13);
    expect(failed.last).toBe(
      "PARTIAL: 1 pair(s) renamed, 0 pair(s) deleted, 2 renamed folder(s) left; run --apply again"
    );
    expect(renamed()).toEqual([
      `.wrangler.prune-${stamp(0)}`,
      `dist.prune-${stamp(0)}`,
    ]);
    expect(pairStamps()).toEqual(stamps(1, 10));
    const again = run(["--apply"]);
    expect(again.status).toBe(0);
    expect(again.last).toBe("PRUNED: 1 pairs");
    expect(renamed()).toEqual([]);
  });

  it("leaves a pair with an existing rename target alone and goes on, run after run", () => {
    sandbox(12);
    mkdirSync(join(web(), `.wrangler.prune-${stamp(0)}`));
    const first = run(["--apply"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`blocked ${stamp(0)} (a renamed name`);
    expect(first.last).toBe(
      "PRUNED: 1 pairs; 1 blocked pair(s) need a person (see the blocked lines)"
    );
    expect(pairStamps()).toEqual([stamp(0), ...stamps(2, 10)]);
    const second = run(["--apply"]);
    expect(second.status).toBe(0);
    expect(second.last).toBe(
      "PRUNED: 0 pairs; 1 blocked pair(s) need a person (see the blocked lines)"
    );
    expect(names()).toContain(`.wrangler.prune-${stamp(0)}`);
    expect(pairStamps()).toEqual([stamp(0), ...stamps(2, 10)]);
  });

  it.each(["file", "symlink"])(
    "blocks a pair whose rename target is a %s and renames nothing of it",
    (kind) => {
      sandbox(13);
      const target = join(web(), `.wrangler.prune-${stamp(0)}`);
      if (kind === "file") {
        writeFileSync(target, "x");
      } else {
        symlinkSync("missing", target);
      }
      for (const _ of [1, 2]) {
        expect(run(["--apply"]).status).toBe(0);
      }
      expect(pairStamps()).toEqual([stamp(0), ...stamps(3, 10)]);
      expect(renamed()).toEqual([`.wrangler.prune-${stamp(0)}`]);
    }
  );

  it("does not count a renamed folder that it cannot delete toward the limit", () => {
    sandbox(14);
    for (const ts of [
      "20261001T000000Z",
      "20261002T000000Z",
      "20261003T000000Z",
    ]) {
      mkdirSync(join(web(), `dist.prune-${ts}`));
      writeFileSync(join(web(), `.wrangler.bak-${ts}`), "x");
    }
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toContain("PRUNED: 3 pairs; more remain (1 over");
    expect(pairStamps().filter((ts) => ts.startsWith("202611"))).toEqual(
      stamps(3, 11)
    );
    expect(renamed()).toHaveLength(3);
  });

  it("never treats a folder name with a blank or a newline as a pair", () => {
    sandbox(10);
    // A name with a trailing blank beside a real second half, a name with a space, and a name
    // whose newlines spell listing lines of three newer pairs.
    mkdirSync(join(web(), "dist.bak-20261120T000000Z "));
    mkdirSync(join(web(), ".wrangler.bak-20261120T000000Z"));
    mkdirSync(join(web(), "dist.failed-old copy"));
    const forged = stamps(600, 3)
      .flatMap((ts) => [`N d dist.bak-${ts}`, `N d .wrangler.bak-${ts}`])
      .join("\n");
    mkdirSync(join(web(), `dist.bak-x\n${forged}`));
    const before = names();
    const preview = run();
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(
      "skip: 3 name(s) with a blank or another unusual character (never touched)"
    );
    expect(preview.stdout).toMatch(/pairs_before=10 delete=0 over=0 /);
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 0 pairs");
    expect(names()).toEqual(before);
    expect(pairStamps().filter((ts) => ts.length === 16)).toEqual(
      stamps(0, 10)
    );
  });

  it("never touches skipped and unmanaged names", () => {
    sandbox(11);
    const untouched = [
      "dist.failed-20261001T000000Z",
      "dist.undeployed-20261001T000000Z",
      "dist.bak-old",
      "dist.bak-20261001T000000Z",
      ".wrangler.bak-20261002T000000Z",
      ".wrangler.bak-20261003T000000Z",
    ];
    for (const name of untouched) {
      mkdirSync(join(web(), name));
    }
    symlinkSync("dist", join(web(), "dist.bak-20261003T000000Z"));
    expect(run(["--apply"]).last).toBe("PRUNED: 1 pairs");
    expect(names()).toEqual(
      expect.arrayContaining([...untouched, "dist.bak-20261003T000000Z"])
    );
    expect(
      lstatSync(join(web(), "dist.bak-20261003T000000Z")).isSymbolicLink()
    ).toBe(true);
    expect(renamed()).toEqual([]);
    expect(existsSync(join(web(), "dist", "server", "live.js"))).toBe(true);
  });
});

describe("remote call failures", { timeout: 30_000 }, () => {
  // A remote runner that fails the n-th call of one command (FAIL="<marker>:<n>") and runs every
  // other command against the sandbox.
  const RUNNER = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$CALLS"
[ "$name:$(grep -cx "$name" "$CALLS")" = "$FAIL" ] && exit 255
exec bash -c "$cmd"
`;
  const runWithFailure = (fail: string) => {
    writeFileSync(join(dir, "runner.sh"), RUNNER);
    chmodSync(join(dir, "runner.sh"), 0o755);
    return run(["--apply"], {
      CALLS: join(dir, "calls"),
      FAIL: fail,
      VERTEX_WEB_SSH: join(dir, "runner.sh"),
    });
  };

  it("stops with exit 3 and takes no lock when the first listing fails", () => {
    sandbox(11);
    const before = names();
    const result = runWithFailure("prune-list:1");
    expect(result.status).toBe(3);
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  it("stops with exit 13 when the rename call fails, and the next run prunes", () => {
    sandbox(11);
    const before = names();
    const result = runWithFailure("prune-rename:1");
    expect(result.status).toBe(13);
    expect(result.last).toContain("PARTIAL: the rename step did not complete");
    expect(names()).toEqual(before);
    expect(run(["--apply"]).last).toBe("PRUNED: 1 pairs");
  });

  it("stops with exit 13 when the delete call fails, and the next run finishes it", () => {
    sandbox(11);
    const result = runWithFailure("prune-delete:1");
    expect(result.status).toBe(13);
    expect(renamed()).toHaveLength(2);
    expect(pairStamps()).toEqual(stamps(1, 10));
    expect(run(["--apply"]).last).toBe("PRUNED: 1 pairs");
    expect(renamed()).toEqual([]);
  });

  it("stops with exit 13 when the listing after the delete fails", () => {
    sandbox(11);
    const result = runWithFailure("prune-list:2");
    expect(result.status).toBe(13);
    expect(result.last).toContain("got no complete listing");
    expect(pairStamps()).toEqual(stamps(1, 10));
    expect(renamed()).toEqual([]);
  });
});

describe("preconditions and usage", { timeout: 30_000 }, () => {
  it("is an executable file", () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
  });

  it.each(["dist", ".wrangler"])(
    "stops with exit 3 when the folder has no live %s",
    (name) => {
      sandbox(11);
      rmSync(join(web(), name), { recursive: true });
      const before = names();
      const result = run(["--apply"]);
      expect(result.status).toBe(3);
      expect(result.last).toBe(
        "NOT PRUNED: no complete listing of apps/web on QuantVPS; nothing changed"
      );
      expect(names()).toEqual(before);
    }
  );

  it("stops with exit 3 when the folder does not exist or the runner gives no answer", () => {
    sandbox(0);
    expect(run([], { VERTEX_WEB_DIR: join(dir, "missing") }).status).toBe(3);
    expect(run([], { VERTEX_WEB_SSH: "true" }).status).toBe(3);
  });

  it("rejects wrong usage with exit 2 and changes nothing", () => {
    sandbox(12);
    const before = names();
    expect(run(["--bogus"]).status).toBe(2);
    expect(run(["--apply", "--dry-run"]).status).toBe(2);
    expect(run(["--dry-run", "--apply"]).status).toBe(2);
    expect(run(["--plan"]).status).toBe(2);
    expect(run(["--plan", join(dir, "missing")]).status).toBe(2);
    expect(names()).toEqual(before);
  });
});

describe("contract with restart-when-idle.sh", { timeout: 30_000 }, () => {
  // A remote runner for the restart script's dry run: its `candidate` command runs against the
  // sandbox, and every other command answers nothing.
  const RUNNER = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
[ "$name" = candidate ] && exec bash -c "$cmd"
exit 0
`;

  it("leaves the newest pair as the rollback source of the restart script", () => {
    sandbox(13);
    expect(run(["--apply"]).last).toBe("PRUNED: 3 pairs");
    writeFileSync(join(dir, "runner.sh"), RUNNER);
    chmodSync(join(dir, "runner.sh"), 0o755);
    const result = spawnSync("bash", [restartScript, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        VERTEX_WEB_DIR: web(),
        VERTEX_WEB_SSH: join(dir, "runner.sh"),
      },
    });
    expect(result.stdout).toContain(`rollback source: ${stamp(12)} `);
  });

  it("uses the same default lock path and name pattern as the restart script", () => {
    const prune = readFileSync(script, "utf8");
    const restart = readFileSync(restartScript, "utf8");
    const lockDefault =
      "${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}";
    expect(restart).toContain(lockDefault);
    expect(prune).toContain(lockDefault);
    const glob =
      "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z";
    expect(restart).toContain(`dist.bak-${glob}`);
    expect(prune).toContain(`TS_GLOB='${glob}'`);
  });
});
