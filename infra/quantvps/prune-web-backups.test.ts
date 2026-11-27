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

const addFamilyPair = (
  family: "bak" | "failed" | "undeployed",
  ts: string,
  sha = "",
  pinned = false
): void => {
  mkdirSync(join(web(), `dist.${family}-${ts}`, "server"), { recursive: true });
  mkdirSync(join(web(), `.wrangler.${family}-${ts}`, "deploy"), {
    recursive: true,
  });
  writeFileSync(join(web(), `dist.${family}-${ts}`, "server", "a.js"), "x");
  if (sha) {
    writeFileSync(
      join(web(), `dist.${family}-${ts}`, "DEPLOYED_SHA"),
      `${sha}\n`
    );
  }
  if (pinned) {
    writeFileSync(join(web(), `dist.${family}-${ts}`, "PINNED"), "");
  }
};

const addPair = (ts: string, sha = ""): void => addFamilyPair("bak", ts, sha);

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
const familyPairStamps = (family: "bak" | "failed" | "undeployed"): string[] =>
  names()
    .filter((name) => name.startsWith(`dist.${family}-`))
    .map((name) => name.slice(`dist.${family}-`.length));
const pairStamps = (): string[] => familyPairStamps("bak");
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

  it.each(["l", "f"])(
    "does not finish a rename while a dist.bak name of type %s exists",
    (type) => {
      const lines = plan(
        [
          ...pairLines(2),
          `N ${type} dist.bak-20261120T000000Z`,
          "N d .wrangler.bak-20261120T000000Z",
          "N d dist.prune-20261120T000000Z",
        ],
        ["--apply"]
      );
      expect(of(lines, "finish")).toEqual([]);
      expect(of(lines, "skip").sort()).toEqual([
        ".wrangler.bak-20261120T000000Z a renamed name with this timestamp exists; remove one by hand",
        "dist.bak-20261120T000000Z not a directory",
      ]);
      expect(lines).toContain("waiting 0");
    }
  );

  it("does not count a renamed folder beside a .wrangler.bak symlink as waiting", () => {
    const lines = plan(
      [
        ...pairLines(12),
        "N l .wrangler.bak-20261001T000000Z",
        "N d dist.prune-20261001T000000Z",
      ],
      ["--apply"]
    );
    expect(of(lines, "finish")).toEqual([]);
    expect(lines).toContain("waiting 0");
    expect(of(lines, "delete")).toEqual([stamp(0), stamp(1)]);
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

  it("manages failed and undeployed pairs, skips half-pairs, and ignores other names", () => {
    const lines = plan([
      ...pairLines(1),
      "N d dist.failed-20261101T000000Z",
      "N d .wrangler.undeployed-20261101T000000Z",
      "N d dist.other",
    ]);
    expect(of(lines, "unmanaged")).toEqual([]);
    expect(of(lines, "skip")).toEqual([
      ".wrangler.undeployed-20261101T000000Z no dist.undeployed pair",
      "dist.failed-20261101T000000Z no .wrangler.failed pair",
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
      `prune-web-backups: mode=preview folder=${shown(web())} keep=10 keep_failed=2 keep_undeployed=2 limit=3`
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
      "note: 5 complete pairs are over the keep count; one --apply run deletes up to 3 (bak first, then failed, then undeployed)"
    );
    expect(result.stdout).toMatch(
      /^summary mode=preview pairs_before=15 pinned=0 pinned_mib=0 delete=5 over=5 bak_over=5 failed_over=0 undeployed_over=0 leftover_folders=0 used_before_mib=\d+$/m
    );
    expect(names()).toEqual(before);
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  const homeUsable = (): boolean => {
    try {
      accessSync(homedir(), constants.W_OK);
      return homedir().startsWith("/home/");
    } catch {
      return false;
    }
  };
  // The only test with a sandbox outside the temp folder: the mask applies to /home/<user>/.
  it.skipIf(!homeUsable())(
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

  it("reports managed failed pairs and skipped names without a not managed line", () => {
    sandbox(1);
    mkdirSync(join(web(), "dist.failed-20261101T000000Z"));
    mkdirSync(join(web(), ".wrangler.failed-20261101T000000Z"));
    mkdirSync(join(web(), "dist.bak-old"));
    const result = run();
    expect(result.stdout).not.toContain("not managed:");
    expect(result.stdout).toMatch(
      /^keep dist\.failed-20261101T000000Z none \d+ MiB$/m
    );
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
      /^summary mode=apply pairs_before=11 renamed=1 deleted=1 pairs_after=10 pinned=0 pinned_mib=0 over_after=0 bak_over_after=0 failed_over_after=0 undeployed_over_after=0 leftover_folders=0 /m
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
        `^\\S+ delete ${stamp(0)} abcdef000000 bak\\n\\S+ run renamed=1 keep=10 keep_failed=2 keep_undeployed=2 rc=0\\n$`
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
      "PARTIAL: the delete step failed; 1 pair(s) renamed, 0 pair(s) deleted, 2 renamed folder(s) left; run --apply again"
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

  it.each([
    ["dist.prune", "file"],
    ["dist.prune", "symlink"],
    [".wrangler.prune", "file"],
    [".wrangler.prune", "symlink"],
  ])(
    "blocks a pair whose rename target %s is a %s and renames nothing of it",
    (name, kind) => {
      sandbox(13);
      const target = join(web(), `${name}-${stamp(0)}`);
      if (kind === "file") {
        writeFileSync(target, "x");
      } else {
        symlinkSync("missing", target);
      }
      for (const _ of [1, 2]) {
        expect(run(["--apply"]).status).toBe(0);
      }
      expect(pairStamps()).toEqual([stamp(0), ...stamps(3, 10)]);
      expect(renamed()).toEqual([`${name}-${stamp(0)}`]);
    }
  );

  it.each(["file", "symlink"])(
    "leaves a .wrangler.bak alone when its dist.bak is a %s beside a renamed folder",
    (kind) => {
      sandbox(10);
      const ts = "20261120T000000Z";
      if (kind === "file") {
        writeFileSync(join(web(), `dist.bak-${ts}`), "x");
      } else {
        symlinkSync("dist", join(web(), `dist.bak-${ts}`));
      }
      mkdirSync(join(web(), `.wrangler.bak-${ts}`, "deploy"), {
        recursive: true,
      });
      mkdirSync(join(web(), `dist.prune-${ts}`));
      const before = names();
      const result = run(["--apply"]);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("finished");
      expect(names()).toEqual(before);
      expect(existsSync(join(web(), `.wrangler.bak-${ts}`, "deploy"))).toBe(
        true
      );
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
    expect(preview.stdout).toMatch(
      /pairs_before=10 pinned=0 pinned_mib=0 delete=0 over=0 bak_over=0 failed_over=0 undeployed_over=0 /
    );
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 0 pairs");
    expect(names()).toEqual(before);
    expect(pairStamps().filter((ts) => ts.length === 16)).toEqual(
      stamps(0, 10)
    );
  });

  it("never touches skipped names", () => {
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
[ "$name" = prune-rename ] && [ -n "$BEFORE_RENAME" ] && bash -c "$BEFORE_RENAME"
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

  it("plans again on the host, so pairs that a deploy adds before the rename count", () => {
    sandbox(11);
    const add = [stamp(11), stamp(12)]
      .map(
        (ts) =>
          `mkdir -p "${web()}/dist.bak-${ts}" "${web()}/.wrangler.bak-${ts}"`
      )
      .join(" && ");
    const result = runWithFailure("none", { BEFORE_RENAME: add });
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 3 pairs");
    expect(pairStamps()).toEqual(stamps(3, 10));
  });

  it("still deletes renamed pairs that wait when a rename fails in every run", () => {
    sandbox(16);
    // A stub `mv` that fails for one .wrangler.bak folder: its pair stays half renamed.
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "mv"),
      `#!/usr/bin/env bash\ncase "$*" in *.wrangler.bak-${stamp(0)}*) exit 1 ;; esac\nexec /usr/bin/env -u PATH PATH="$REAL_PATH" mv "$@"\n`
    );
    chmodSync(join(dir, "bin", "mv"), 0o755);
    const env = {
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
      REAL_PATH: process.env["PATH"] ?? "",
    };
    for (const _ of [1, 2, 3, 4]) {
      const result = run(["--apply"], env);
      expect(result.status).toBe(13);
      expect(result.last).toContain("PARTIAL: a rename step failed");
    }
    // The half-renamed pair stays; the pairs after it were renamed and deleted in later runs.
    expect(names()).toContain(`dist.prune-${stamp(0)}`);
    expect(names()).toContain(`.wrangler.bak-${stamp(0)}`);
    expect(renamed()).toEqual([`dist.prune-${stamp(0)}`]);
    expect(pairStamps()).toEqual(stamps(6, 10));
  });

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

describe("failed and undeployed families (--plan)", { timeout: 30_000 }, () => {
  const famLines = (
    family: "bak" | "failed" | "undeployed",
    from: number,
    count: number
  ): string[] =>
    stamps(from, count).flatMap((ts) => [
      `N d dist.${family}-${ts}`,
      `N d .wrangler.${family}-${ts}`,
    ]);

  it("keeps the newest 2 failed and newest 2 undeployed pairs and deletes older ones", () => {
    const lines = plan([
      ...famLines("failed", 0, 4),
      ...famLines("undeployed", 10, 3),
    ]);
    expect(of(lines, "delete")).toEqual([
      `${stamp(0)} failed`,
      `${stamp(1)} failed`,
      `${stamp(10)} undeployed`,
    ]);
    expect(of(lines, "keep")).toEqual([
      `${stamp(2)} failed`,
      `${stamp(3)} failed`,
      `${stamp(11)} undeployed`,
      `${stamp(12)} undeployed`,
    ]);
    expect(of(lines, "over")).toEqual(["3"]);
    expect(of(lines, "over_bak")).toEqual(["0"]);
    expect(of(lines, "over_failed")).toEqual(["2"]);
    expect(of(lines, "over_undeployed")).toEqual(["1"]);
  });

  it("protects pinned undeployed pairs outside keep=2 and skips unreadable ones fail-closed", () => {
    const lines = plan([
      `N p dist.undeployed-${stamp(0)}`,
      `N d .wrangler.undeployed-${stamp(0)}`,
      `N u dist.undeployed-${stamp(1)}`,
      `N d .wrangler.undeployed-${stamp(1)}`,
      ...famLines("undeployed", 2, 3),
    ]);
    expect(of(lines, "pinned")).toEqual([`${stamp(0)} undeployed`]);
    expect(of(lines, "delete")).toEqual([`${stamp(2)} undeployed`]);
    expect(of(lines, "keep")).toEqual([
      `${stamp(3)} undeployed`,
      `${stamp(4)} undeployed`,
    ]);
    expect(of(lines, "skip")).toEqual([
      `.wrangler.undeployed-${stamp(1)} no dist.undeployed pair`,
      `dist.undeployed-${stamp(1)} not readable; cannot check PINNED`,
    ]);
  });

  it("does not shadow malformed prune-failed or prune-undeployed names under prune-", () => {
    const lines = plan([
      "N d dist.prune-failed-bad",
      "N d .wrangler.prune-failed-bad",
      "N d dist.prune-undeployed-bad",
      "N d .wrangler.prune-undeployed-bad",
      "N d dist.prune-bad",
    ]);
    expect(of(lines, "leftover")).toEqual([]);
    expect(of(lines, "skip")).toEqual([
      ".wrangler.prune-failed-bad name form",
      ".wrangler.prune-undeployed-bad name form",
      "dist.prune-bad name form",
      "dist.prune-failed-bad name form",
      "dist.prune-undeployed-bad name form",
    ]);
  });

  it("isolates same-second timestamps across bak, failed, and undeployed with disjoint staging", () => {
    const t = stamp(0);
    const lines = plan(
      [
        ...pairLines(11),
        `N d dist.failed-${t}`,
        `N d .wrangler.failed-${t}`,
        ...famLines("failed", 1, 2),
        `N d dist.undeployed-${t}`,
        `N d .wrangler.undeployed-${t}`,
        ...famLines("undeployed", 1, 2),
        `N d dist.prune-failed-${t}`,
      ],
      ["--apply"]
    );
    expect(of(lines, "delete")).toEqual([t, `${t} undeployed`]);
    expect(of(lines, "blocked")).toEqual([`${t} failed`]);
    expect(of(lines, "finish")).toEqual([]);
  });

  it("isolates interrupted rename finish detection per family", () => {
    const t = stamp(0);
    const lines = plan([
      `N d dist.prune-failed-${t}`,
      `N d .wrangler.bak-${t}`,
      `N d .wrangler.failed-${t}`,
    ]);
    expect(of(lines, "finish")).toEqual([`${t} failed`]);
    expect(of(lines, "skip")).toEqual([`.wrangler.bak-${t} no dist.bak pair`]);
  });

  it("allocates global LIMIT=3 budget (limit - waiting) in bak -> failed -> undeployed order", () => {
    const lines = plan(
      [
        ...pairLines(12),
        ...famLines("failed", 20, 4),
        ...famLines("undeployed", 30, 4),
        `N d dist.prune-undeployed-${stamp(99)}`,
      ],
      ["--apply"]
    );
    expect(of(lines, "waiting")).toEqual(["1"]);
    expect(of(lines, "delete")).toEqual([stamp(0), stamp(1)]);
    expect(of(lines, "over")).toEqual(["6"]);
    expect(of(lines, "over_bak")).toEqual(["2"]);
    expect(of(lines, "over_failed")).toEqual(["2"]);
    expect(of(lines, "over_undeployed")).toEqual(["2"]);
  });

  it("sorts leftover and skip lines lexicographically and preserves bak parity with baseline", () => {
    const lines = plan(
      [
        ...pairLines(14),
        `N d dist.prune-${stamp(100)}`,
        `N d .wrangler.bak-${stamp(100)}`,
        `N d dist.prune-${stamp(0)}`,
        "N d dist.bak-zzz",
        "N d dist.bak-aaa",
      ],
      ["--apply"]
    );
    expect(of(lines, "blocked")).toEqual([stamp(0)]);
    expect(of(lines, "delete")).toEqual([stamp(1), stamp(2)]);
    expect(of(lines, "keep")).toEqual([stamp(3), ...stamps(4, 10)]);
    expect(of(lines, "finish")).toEqual([stamp(100)]);
    expect(of(lines, "leftover")).toEqual([
      `dist.prune-${stamp(0)}`,
      `dist.prune-${stamp(100)}`,
    ]);
    expect(of(lines, "skip")).toEqual([
      "dist.bak-aaa name form",
      "dist.bak-zzz name form",
    ]);
    expect(of(lines, "waiting")).toEqual(["1"]);
    expect(of(lines, "over")).toEqual(["4"]);
  });
});

describe("failed and undeployed families (sandbox)", {
  timeout: 30_000,
}, () => {
  it("previews all three families with pinned size and accurate per-family summary", () => {
    sandbox(10);
    for (let i = 0; i < 3; i += 1) {
      addFamilyPair("failed", stamp(20 + i), `fa11ed00000${i}`);
    }
    addFamilyPair("undeployed", stamp(30), "deadbeef0000", true);
    for (let i = 1; i <= 3; i += 1) {
      addFamilyPair("undeployed", stamp(30 + i), `deadbeef000${i}`);
    }
    const result = run();
    expect(result.status).toBe(0);
    expect(result.last).toBe("PREVIEW: nothing deleted");
    expect(result.stdout).not.toContain("not managed:");
    expect(result.stdout).toMatch(
      new RegExp(
        `^delete dist\\.failed-${stamp(20)} fa11ed000000 \\d+ MiB$`,
        "m"
      )
    );
    expect(result.stdout).toMatch(
      new RegExp(
        `^pinned dist\\.undeployed-${stamp(30)} deadbeef0000 \\d+ MiB$`,
        "m"
      )
    );
    expect(result.stdout).toMatch(
      new RegExp(
        `^delete dist\\.undeployed-${stamp(31)} deadbeef0001 \\d+ MiB$`,
        "m"
      )
    );
    expect(result.stdout).toMatch(
      /^summary mode=preview pairs_before=17 pinned=1 pinned_mib=\d+ delete=2 over=2 bak_over=0 failed_over=1 undeployed_over=1 leftover_folders=0 used_before_mib=\d+$/m
    );
  });

  it("deletes older failed and undeployed pairs, keeps pinned pairs, and logs family tags", () => {
    sandbox(10);
    for (let i = 0; i < 3; i += 1) {
      addFamilyPair("failed", stamp(20 + i), `fa11ed00000${i}`);
    }
    addFamilyPair("undeployed", stamp(30), "111111111111", true);
    for (let i = 1; i <= 3; i += 1) {
      addFamilyPair("undeployed", stamp(30 + i), `22222222222${i}`);
    }
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 2 pairs");
    expect(result.stdout).toContain(
      `  renamed ${stamp(20)} fa11ed000000 failed`
    );
    expect(result.stdout).toContain(
      `  renamed ${stamp(31)} 222222222221 undeployed`
    );
    expect(familyPairStamps("failed")).toEqual([stamp(21), stamp(22)]);
    expect(familyPairStamps("undeployed")).toEqual([
      stamp(30),
      stamp(32),
      stamp(33),
    ]);
    expect(renamed()).toEqual([]);
    const log = readFileSync(
      join(dir, "state", "vertex-web-prune.log"),
      "utf8"
    );
    expect(log).toMatch(
      new RegExp(
        `^\\S+ delete ${stamp(20)} fa11ed000000 failed\\n\\S+ delete ${stamp(31)} 222222222221 undeployed\\n\\S+ run renamed=2 keep=10 keep_failed=2 keep_undeployed=2 rc=0\\n$`
      )
    );
  });

  it("drains a multi-family backlog in bak -> failed -> undeployed order under LIMIT=3", () => {
    sandbox(12);
    for (let i = 0; i < 4; i += 1) {
      addFamilyPair("failed", stamp(20 + i));
      addFamilyPair("undeployed", stamp(30 + i));
    }
    const first = run(["--apply"]);
    expect(first.status).toBe(0);
    expect(first.last).toBe(
      "PRUNED: 3 pairs; more remain (3 over the keep count, 0 renamed pair(s) wait); the next run continues"
    );
    expect(pairStamps()).toEqual(stamps(2, 10));
    expect(familyPairStamps("failed")).toEqual(stamps(21, 3));
    expect(familyPairStamps("undeployed")).toEqual(stamps(30, 4));

    const second = run(["--apply"]);
    expect(second.status).toBe(0);
    expect(second.last).toBe("PRUNED: 3 pairs");
    expect(familyPairStamps("failed")).toEqual([stamp(22), stamp(23)]);
    expect(familyPairStamps("undeployed")).toEqual([stamp(32), stamp(33)]);
  });

  it("handles same-second timestamps across bak, failed, and undeployed without collision or SHA overwrite", () => {
    const t = stamp(0);
    sandbox(11);
    addFamilyPair("failed", t, "fa11ed000000");
    addFamilyPair("failed", stamp(1), "fa11ed000001");
    addFamilyPair("failed", stamp(2), "fa11ed000002");
    addFamilyPair("undeployed", t, "deadbeef0000");
    addFamilyPair("undeployed", stamp(1), "deadbeef0001");
    addFamilyPair("undeployed", stamp(2), "deadbeef0002");
    const preview = run();
    expect(preview.stdout).toMatch(
      new RegExp(`^delete ${t} abcdef000000 \\d+ MiB$`, "m")
    );
    expect(preview.stdout).toMatch(
      new RegExp(`^delete dist\\.failed-${t} fa11ed000000 \\d+ MiB$`, "m")
    );
    expect(preview.stdout).toMatch(
      new RegExp(`^delete dist\\.undeployed-${t} deadbeef0000 \\d+ MiB$`, "m")
    );
    const apply = run(["--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.last).toBe("PRUNED: 3 pairs");
    expect(pairStamps()).toEqual(stamps(1, 10));
    expect(familyPairStamps("failed")).toEqual([stamp(1), stamp(2)]);
    expect(familyPairStamps("undeployed")).toEqual([stamp(1), stamp(2)]);
  });

  it("finishes an interrupted failed rename without touching .wrangler.bak-<TS>", () => {
    sandbox(10);
    const t = stamp(50);
    mkdirSync(join(web(), `dist.prune-failed-${t}`));
    mkdirSync(join(web(), `.wrangler.failed-${t}`));
    mkdirSync(join(web(), `.wrangler.bak-${t}`));
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 1 pairs");
    expect(result.stdout).toContain(`  finished ${t} failed`);
    expect(existsSync(join(web(), `dist.prune-failed-${t}`))).toBe(false);
    expect(existsSync(join(web(), `.wrangler.failed-${t}`))).toBe(false);
    expect(existsSync(join(web(), `.wrangler.bak-${t}`))).toBe(true);
  });

  it("protects an in-flight failed rename in DELETE while .wrangler.failed-<TS> exists", () => {
    sandbox(10);
    const t = stamp(50);
    mkdirSync(join(web(), `dist.prune-failed-${t}`));
    mkdirSync(join(web(), `.wrangler.failed-${t}`));
    // Fail the rename command with @@END 1 so DELETE runs while .wrangler.failed-<TS> still exists.
    const runner = join(dir, "fail-rename.sh");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
if [ "$name" = prune-rename ]; then
  echo "@@END 1"
  exit 0
fi
exec bash -c "$cmd"
`
    );
    chmodSync(runner, 0o755);
    const result = run(["--apply"], { VERTEX_WEB_SSH: runner });
    expect(result.status).toBe(13);
    expect(existsSync(join(web(), `dist.prune-failed-${t}`))).toBe(true);
    expect(existsSync(join(web(), `.wrangler.failed-${t}`))).toBe(true);
  });

  it("skips cleanly with exit 0 if PINNED appears between preview and RENAME", () => {
    sandbox(10);
    for (let i = 0; i < 3; i += 1) {
      addFamilyPair("undeployed", stamp(30 + i));
    }
    const runner = join(dir, "pin-between.sh");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
if [ "$name" = prune-rename ]; then
  touch "${web()}/dist.undeployed-${stamp(30)}/PINNED"
fi
exec bash -c "$cmd"
`
    );
    chmodSync(runner, 0o755);
    const res = run(["--apply"], { VERTEX_WEB_SSH: runner });
    expect(res.status).toBe(0);
    expect(res.last).toBe("PRUNED: 0 pairs");
    expect(familyPairStamps("undeployed")).toEqual([
      stamp(30),
      stamp(31),
      stamp(32),
    ]);
  });

  it("rejects an unwritable undeployed tree before staging so bak pruning is not starved", () => {
    sandbox(11);
    for (let i = 0; i < 3; i += 1) {
      addFamilyPair("undeployed", stamp(30 + i));
    }
    const lockedDir = join(web(), `dist.undeployed-${stamp(30)}`, "server");
    chmodSync(lockedDir, 0o555);
    try {
      const result = run(["--apply"]);
      expect(result.status).toBe(13);
      expect(result.last).toContain("PARTIAL: a rename step failed");
      expect(pairStamps()).toEqual(stamps(1, 10));
      expect(existsSync(join(web(), `dist.undeployed-${stamp(30)}`))).toBe(
        true
      );
      expect(
        existsSync(join(web(), `dist.prune-undeployed-${stamp(30)}`))
      ).toBe(false);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("skips unreadable 0000 dist.undeployed-<TS> fail-closed without deleting it", () => {
    sandbox(10);
    addFamilyPair("undeployed", stamp(30), "deadbeef0000", true);
    addFamilyPair("undeployed", stamp(31));
    addFamilyPair("undeployed", stamp(32));
    const unreadable = join(web(), `dist.undeployed-${stamp(30)}`);
    chmodSync(unreadable, 0o000);
    try {
      const result = run(["--apply"]);
      expect(result.status).toBe(0);
      expect(result.last).toBe("PRUNED: 0 pairs");
      expect(result.stdout).toContain(
        `skip dist.undeployed-${stamp(30)} (not readable; cannot check PINNED)`
      );
      expect(existsSync(unreadable)).toBe(true);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });

  it("reports both rename and delete steps when both fail in one run", () => {
    sandbox(10);
    addFamilyPair("undeployed", stamp(30));
    addFamilyPair("undeployed", stamp(31));
    addFamilyPair("undeployed", stamp(32));
    const lockedDir = join(web(), `dist.undeployed-${stamp(30)}`, "server");
    chmodSync(lockedDir, 0o555);
    const runner = join(dir, "fail-del.sh");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
[ "$name" = prune-delete ] && exit 1
exec bash -c "$cmd"
`
    );
    chmodSync(runner, 0o755);
    try {
      const result = run(["--apply"], { VERTEX_WEB_SSH: runner });
      expect(result.status).toBe(13);
      expect(result.last).toContain(
        "PARTIAL: both rename and delete steps failed"
      );
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("emits the full extended summary on the no-op --apply fast path", () => {
    sandbox(10);
    addFamilyPair("undeployed", stamp(30), "deadbeef0000", true);
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.last).toBe("PRUNED: 0 pairs");
    expect(result.stdout).toMatch(
      /^summary mode=apply pairs_before=11 renamed=0 deleted=0 pairs_after=11 pinned=1 pinned_mib=\d+ over_after=0 bak_over_after=0 failed_over_after=0 undeployed_over_after=0 leftover_folders=0 used_before_mib=\d+ used_after_mib=\d+$/m
    );
  });

  it("matches restart-when-idle.sh rollback naming for failed pairs", () => {
    const restart = readFileSync(restartScript, "utf8");
    expect(restart).toContain(
      "mv dist dist.failed-$NOW && mv .wrangler .wrangler.failed-$NOW"
    );
    const ts = "20261127T123456Z";
    const lines = plan([`N d dist.failed-${ts}`, `N d .wrangler.failed-${ts}`]);
    expect(of(lines, "keep")).toEqual([`${ts} failed`]);
  });
});
