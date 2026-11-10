import { spawnSync } from "node:child_process";
import {
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

// The rig runs the research-lens data jobs from an export of this repo, pushes their output to
// QuantVPS, and the tailnet Caddy serves it. These tests keep the three files that must agree
// (units, push script, Caddy template) in step, and run the fetch script against a local git repo.
const here = (name: string): string =>
  fileURLToPath(new URL(name, import.meta.url));
const read = (name: string): string => readFileSync(here(name), "utf8");
const repoRoot = here("../../../");

const execStart = (unit: string): string[] => {
  const line = read(unit)
    .split("\n")
    .find((row) => row.startsWith("ExecStart="));
  if (line === undefined) {
    throw new Error(`${unit} has no ExecStart`);
  }
  return line.slice("ExecStart=".length).split(" ");
};
const argAfter = (argv: string[], flag: string): string => {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`missing ${flag}`);
  }
  return value;
};
const appScript = (argv: string[]): string => {
  const script = argv.find((arg) => arg.endsWith(".ts"));
  if (script === undefined) {
    throw new Error("no collector script");
  }
  return script.replace(
    "%h/.local/share/vertex-research-lenses/app/",
    repoRoot
  );
};

const rotation = execStart("./vertex-rotation-matrix.service");
const deepValue = execStart("./vertex-deep-value.service");
const rotationLatest = `${argAfter(rotation, "--out")}/latest.json`;
const deepValueLatest = `${argAfter(deepValue, "--out")}/latest.json`;

describe("research-lens rig units", () => {
  it("run collectors that exist in this repo", () => {
    for (const argv of [rotation, deepValue]) {
      expect(existsSync(appScript(argv))).toBe(true);
    }
  });

  it("feed deep value from the rotation matrix the other job writes", () => {
    expect(argAfter(deepValue, "--rotation")).toBe(rotationLatest);
  });

  it("push exactly the documents the collectors write", () => {
    const watched = read("./vertex-research-lenses-push.path")
      .split("\n")
      .filter((row) => row.startsWith("PathChanged="))
      .map((row) => row.slice("PathChanged=".length))
      .sort();
    expect(watched).toEqual([deepValueLatest, rotationLatest].sort());
    const push = read("./push-research-lenses.sh");
    for (const latest of [rotationLatest, deepValueLatest]) {
      expect(push).toContain(latest.replace("%h", "$HOME"));
    }
  });

  it("never run from the archived vertex-research checkout", () => {
    for (const file of [
      "./vertex-rotation-matrix.service",
      "./vertex-deep-value.service",
      "./vertex-research-lenses-push.path",
      "./push-research-lenses.sh",
      "./vertex-research-lenses-fetch",
    ]) {
      expect(read(file)).not.toMatch(
        /Github\/trading\/vertex-research(?:\/|-wt-)/u
      );
    }
  });
});

describe("tailnet Caddy template", () => {
  const caddy = read("../status/Caddyfile.tailnet");

  it("serves the pushed folder to the rig and the VPS itself before the rig-only fallback", () => {
    const route = caddy.indexOf("@lens_caller {");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(caddy.indexOf("@not_rig not remote_ip"));
    const block = caddy.slice(route, caddy.indexOf("@not_rig not remote_ip"));
    expect(block).toContain("remote_ip __RIG_IP__ __TS_IP__");
    expect(block).toContain("path /vertex-research-lenses/v1/*");
    expect(block).toContain(
      'header Authorization "Bearer {$VERTEX_STATUS_TOKEN}"'
    );
    expect(block).toContain("handle @lens_caller {");
    expect(block).toContain("uri strip_prefix /vertex-research-lenses/v1");
    // The container mounts /opt/vertex-status/private-v2 as /srv; the push script writes below it.
    const root = /root \* \/srv\/(\S+)/u.exec(block)?.[1];
    expect(read("./push-research-lenses.sh")).toContain(
      `DEST="\${RESEARCH_LENSES_DEST:-/opt/vertex-status/private-v2/${root}}"`
    );
  });
});

describe("vertex-research-lenses-fetch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  const git = (cwd: string, ...args: string[]): void => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  };

  const setup = (withCollector: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "vtx-lenses-"));
    dirs.push(root);
    const origin = join(root, "origin");
    mkdirSync(join(origin, "scripts/research-lenses"), { recursive: true });
    mkdirSync(join(origin, "apps"), { recursive: true });
    const collector = withCollector ? "collect-rotation-matrix.ts" : "other.ts";
    writeFileSync(
      join(origin, "scripts/research-lenses", collector),
      "export {};\n"
    );
    writeFileSync(join(origin, "apps/not-exported.txt"), "x\n");
    git(origin, "init", "-q", "-b", "main");
    git(origin, "add", ".");
    git(
      origin,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "-m",
      "init"
    );
    const clone = join(root, "clone");
    git(root, "clone", "-q", origin, clone);
    const home = join(root, "home");
    mkdirSync(home);
    const app = join(home, ".local/share/vertex-research-lenses/app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "stale.ts"), "old\n");
    const run = spawnSync("bash", [here("./vertex-research-lenses-fetch")], {
      encoding: "utf8",
      env: {
        HOME: home,
        LENSES_BRANCH: "main",
        LENSES_REPO: clone,
        PATH: process.env["PATH"] ?? "",
      },
    });
    return { app, run };
  };

  it("replaces the runner directory with only the research-lens scripts", () => {
    const { app, run } = setup(true);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("research lenses from origin/main");
    expect(
      existsSync(
        join(app, "scripts/research-lenses/collect-rotation-matrix.ts")
      )
    ).toBe(true);
    expect(existsSync(join(app, "apps"))).toBe(false);
    expect(existsSync(join(app, "stale.ts"))).toBe(false);
  });

  it("fails and keeps the previous runner directory when the branch has no collector", () => {
    const { app, run } = setup(false);
    expect(run.status).not.toBe(0);
    expect(existsSync(join(app, "stale.ts"))).toBe(true);
  });
});
