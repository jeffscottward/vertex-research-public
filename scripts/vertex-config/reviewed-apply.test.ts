import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, runConfigurationEntrypoint } from "./cli.ts";
import { parseAssignments } from "./core.ts";
import { readInspectionRegular } from "./files.ts";
import { applyReviewed } from "./reviewed-apply.ts";

// The registry records the reviewing machine's absolute roots; re-root it beside
// this checkout so the fixtures hold wherever the repository is cloned.
vi.mock(
  "../../docs/vertex-rebuild/migration-matrix.json",
  async (importOriginal) =>
    (await import("./registry.test-support.ts")).rerootRegistry(importOriginal)
);

const effects = vi.hoisted(() => ({
  before: null as ((operation: string, args: unknown[]) => void) | null,
  after: null as
    | ((operation: string, args: unknown[], result: unknown) => void)
    | null,
  calls: [] as { operation: string; args: unknown[] }[],
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: effects.spawn }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = {};
  for (const name of [
    "openSync",
    "closeSync",
    "fstatSync",
    "lstatSync",
    "statfsSync",
    "readSync",
    "mkdirSync",
    "writeFileSync",
    "fchmodSync",
    "fsyncSync",
    "linkSync",
    "renameSync",
    "unlinkSync",
    "rmdirSync",
  ]) {
    wrapped[name] = (...args: unknown[]) => {
      effects.calls.push({ operation: name, args });
      effects.before?.(name, args);
      const result = (
        actual[name as keyof typeof actual] as (...args: unknown[]) => unknown
      )(...args);
      effects.after?.(name, args, result);
      return result;
    };
  }
  return { ...actual, ...wrapped };
});

const directories: string[] = [];
const key = "FINANCIAL_DATASETS_API_KEY";
const alias = "FINANCIALDATASETS_API_KEY";
const fixture = (existing: string | null = null, parent = FIXTURE_PARENT) => {
  const base = mkdtempSync(join(parent, "vertex-reviewed-synthetic-"));
  directories.push(base);
  const root = join(base, "trading", "vertex-research-platform");
  const source = join(base, "trading", "gamma-forge", "forge", ".env.local");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  writeFileSync(
    source,
    `${alias}=fixture-selected\nUNSELECTED=fixture-untouched\n`,
    { mode: 0o600 }
  );
  writeFileSync(join(root, ".env.example"), `${key}=\nQUANTDATA_API_KEY=\n`, {
    mode: 0o644,
  });
  writeFileSync(
    join(root, ".env"),
    "CUSTOM=fixture-root-preserved\nRESEARCH_RUNTIME_STATE=disabled\n",
    { mode: 0o600 }
  );
  const manifest = {
    version: 1,
    sources: [
      { repository: "gamma-forge", path: "forge/.env.local", keys: [alias] },
    ],
  };
  const manifestPath = join(root, "selection.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const configuration = join(root, "private", "configuration");
  const master = join(configuration, ".env");
  if (existing !== null) {
    mkdirSync(configuration, { recursive: true, mode: 0o700 });
    writeFileSync(master, existing, { mode: 0o600 });
  }
  effects.calls = [];
  return { base, root, source, manifest, manifestPath, configuration, master };
};

const original = () => vi.importActual<typeof import("node:fs")>("node:fs");

// reviewed-apply rejects a group- or world-writable ancestor, except the
// root-owned sticky /tmp. A runner TMPDIR under /var/tmp (mode 1777, for
// example /var/tmp/gh-vertex on rig-vertex) would fail every fixture as
// reviewed-unsafe-directory, so fixtures then live in /tmp instead. Hosts
// whose tmpdir() has acceptable ancestry keep using it.
const hasUnsafeAncestor = async (start: string): Promise<boolean> => {
  const fs = await original();
  for (let path = fs.realpathSync(start); ; path = dirname(path)) {
    const stat = fs.lstatSync(path);
    const stickyTemporaryRoot =
      path === "/tmp" && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      ![0, process.getuid!()].includes(stat.uid) ||
      ((stat.mode & 0o022) !== 0 && !stickyTemporaryRoot)
    )
      return true;
    if (path === "/") return false;
  }
};
const FIXTURE_PARENT = (await hasUnsafeAncestor(tmpdir())) ? "/tmp" : tmpdir();
const onceBefore = (
  operation: string,
  predicate: (args: unknown[]) => boolean,
  action: (args: unknown[]) => void
): void => {
  effects.before = (name, args) => {
    if (name !== operation || !predicate(args)) return;
    effects.before = null;
    return action(args);
  };
};
const onceAfter = (
  operation: string,
  predicate: (args: unknown[], result: unknown) => boolean,
  action: (args: unknown[], result: unknown) => void
): void => {
  effects.after = (name, args, result) => {
    if (name !== operation || !predicate(args, result)) return;
    effects.after = null;
    return action(args, result);
  };
};
const isPath = (args: unknown[], suffix: string): boolean =>
  typeof args[0] === "string" && args[0].endsWith(suffix);
const pathForFd = (fs: typeof import("node:fs"), descriptor: unknown): string =>
  fs.readlinkSync(`/proc/self/fd/${descriptor}`);
const valuesAt = (path: string) =>
  Object.fromEntries(
    parseAssignments(readFileSync(path, "utf8")).map((entry) => [
      entry.name,
      entry.value,
    ])
  );
const apply = (f: ReturnType<typeof fixture>) => {
  const sourceBefore = readFileSync(f.source, "utf8");
  const rootBefore = readFileSync(join(f.root, ".env"), "utf8");
  const result = applyReviewed(f.root, "selection.json");
  expect(readFileSync(f.source, "utf8")).toBe(sourceBefore);
  expect(readFileSync(join(f.root, ".env"), "utf8")).toBe(rootBefore);
  expect(JSON.stringify(result)).not.toMatch(
    /fixture-selected|fixture-untouched|fixture-root-preserved|fixture-old|fixture-new|op:\/\//
  );
  expect(result.projection).toBe("not-performed-use-explicit-project");
  expect(existsSync(join(f.configuration, "projections"))).toBe(false);
  expect(existsSync(`${f.master}.vertex-lock`)).toBe(false);
  return result;
};

// Mirror a private home containing non-writable public-mode repository parents.
// The platform's separate private directory is deliberately NOT on the source chain.
const sourceChain = (
  f: ReturnType<typeof fixture>,
  privateAncestor = true
): string[] => {
  const chain = [
    f.base,
    join(f.base, "trading"),
    join(f.base, "trading", "gamma-forge"),
    dirname(f.source),
  ];
  for (const path of chain) {
    chmodSync(path, path === f.base && privateAncestor ? 0o700 : 0o755);
  }
  chmodSync(f.source, 0o644);
  return chain;
};

// tmpdir() itself can sit behind a mode0700 directory of the current user (the
// rig CI runner's private TMPDIR). That directory would be private proof for
// every fixture source. Tests whose premise is absent private ancestry report
// such outer ancestors as mode0755, so only ancestors inside the fixture count.
const withoutOuterPrivateAncestors = async (
  f: ReturnType<typeof fixture>,
  next:
    | ((operation: string, args: unknown[], result: unknown) => void)
    | null = null
): Promise<void> => {
  const fs = await original();
  const outer = new Set<string>();
  for (let path = fs.realpathSync(dirname(f.base)); ; path = dirname(path)) {
    outer.add(path);
    if (path === "/") break;
  }
  const target = (operation: string, args: unknown[]): string | null => {
    try {
      if (operation === "fstatSync") return pathForFd(fs, args[0]);
      if (operation === "lstatSync") return fs.realpathSync(args[0] as string);
    } catch {
      return null;
    }
    return null;
  };
  effects.after = (operation, args, result) => {
    const path = target(operation, args);
    if (path !== null && outer.has(path)) {
      const stat = result as Stats;
      if (stat.uid === process.getuid!() && (stat.mode & 0o7777) === 0o700)
        Object.defineProperty(stat, "mode", {
          value: (stat.mode & ~0o7777) | 0o755,
        });
    }
    return next?.(operation, args, result);
  };
};

beforeEach(() => {
  effects.before = null;
  effects.after = null;
  effects.calls = [];
  effects.spawn
    .mockReset()
    .mockImplementation((command: string, args: string[]) => {
      if (command !== "git" || !["check-ignore", "ls-files"].includes(args[0]!))
        throw new Error("unexpected child process");
      return { status: args[0] === "check-ignore" ? 0 : 1 };
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network operation");
    })
  );
  return;
});
afterEach(() => {
  effects.before = null;
  effects.after = null;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  return;
});

describe("reviewed master-only publication", () => {
  it("publishes a unique canonical value, single-link 0600, without modifying sources/settings or projecting", () => {
    const f = fixture();
    const sourceStat = lstatSync(f.source);
    const result = apply(f);
    expect(result).toMatchObject({
      status: "applied-to-master",
      masterState: "published",
      addedNames: [key],
      validation: "not-performed",
    });
    expect(valuesAt(f.master)).toEqual({ [key]: "fixture-selected" });
    expect(lstatSync(f.master)).toMatchObject({
      nlink: 1,
      uid: process.getuid!(),
    });
    expect(lstatSync(f.master).mode & 0o777).toBe(0o600);
    expect(readInspectionRegular(f.master, true)).toBe(
      readFileSync(f.master, "utf8")
    );
    expect(lstatSync(f.source)).toMatchObject({
      ino: sourceStat.ino,
      mode: sourceStat.mode,
      mtimeMs: sourceStat.mtimeMs,
    });
    expect(
      effects.spawn.mock.calls.every(
        ([command, args]) =>
          command === "git" && ["check-ignore", "ls-files"].includes(args[0])
      )
    ).toBe(true);
    return expect(readdirSync(join(f.root, result.recoveryDirectory!))).toEqual(
      []
    );
  });

  it("extends an existing master while preserving unrelated bytes and durable backups", () => {
    const existing =
      "# exact preserved bytes\nUNKNOWN='fixture-old'\nQUANTDATA_API_KEY=fixture-previous\nRESEARCH_RUNTIME_STATE=disabled\n";
    const f = fixture(existing);
    const before = lstatSync(f.master);
    const result = apply(f);
    expect(result.status).toBe("applied-to-master");
    expect(readFileSync(f.master, "utf8").startsWith(existing)).toBe(true);
    const recovery = join(f.root, result.recoveryDirectory!);
    expect(lstatSync(recovery).mode & 0o777).toBe(0o700);
    for (const name of ["backup.env", "previous.env"]) {
      expect(readFileSync(join(recovery, name), "utf8")).toBe(existing);
      expect(lstatSync(join(recovery, name)).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(recovery, name)).nlink).toBe(1);
    }
    expect(lstatSync(join(recovery, "previous.env")).ino).toBe(before.ino);
    expect(lstatSync(f.master).ino).not.toBe(before.ino);
    expect(lstatSync(f.master).nlink).toBe(1);
    return expect(existsSync(join(recovery, "candidate.env"))).toBe(false);
  });

  it("keeps the identical master inode and mtime with no backup or staging", () => {
    const f = fixture(`${key}=fixture-selected\nUNKNOWN=fixture-preserve\n`);
    const before = lstatSync(f.master);
    const result = apply(f);
    expect(result).toMatchObject({
      status: "unchanged",
      addedNames: [],
      retainedNames: [key],
      recoveryDirectory: null,
      masterState: "unchanged",
    });
    expect(lstatSync(f.master)).toMatchObject({
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    });
    return expect(readdirSync(f.configuration)).toEqual([".env"]);
  });

  it("reports a sanitized conflict without replacing a nonempty master or staging any eligible peer", () => {
    const existing = `${key}=fixture-old\n`;
    const f = fixture(existing);
    f.manifest.sources[0]!.keys.push("QUANTDATA_API_KEY");
    writeFileSync(
      f.source,
      `${alias}=fixture-selected\nQUANTDATA_API_KEY=fixture-new\n`
    );
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    const before = lstatSync(f.master);
    const result = apply(f);
    expect(result).toMatchObject({
      status: "blocked",
      conflictingNames: [key],
      addedNames: [],
      recoveryDirectory: null,
      masterState: "unchanged",
    });
    expect(readFileSync(f.master, "utf8")).toBe(existing);
    expect(lstatSync(f.master).ino).toBe(before.ino);
    return expect(readdirSync(f.configuration)).toEqual([".env"]);
  });

  it("treats a previous dry-run as neither value pin nor application authority", () => {
    const f = fixture();
    const output = { write: vi.fn() };
    expect(
      run(
        ["consolidate", "--dry-run", "--manifest", "selection.json"],
        f.root,
        output
      )
    ).toBe(0);
    expect(existsSync(f.configuration)).toBe(false);
    writeFileSync(f.source, `${alias}=fixture-current-at-apply\n`);
    const result = apply(f);
    expect(result.status).toBe("applied-to-master");
    return expect(valuesAt(f.master)[key]).toBe("fixture-current-at-apply");
  });

  it.each([
    "OPENAI_API_KEY",
    "QUANTVPS_SSH_PASSWORD",
    "UNKNOWN_NAME",
    "IBKR_READ_ONLY",
  ])("never stages unsupported/excluded selected name %s", (name) => {
    const f = fixture();
    f.manifest.sources[0]!.keys = [name];
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    writeFileSync(f.source, `${name}=fixture-selected\n`);
    expect(apply(f)).toMatchObject({
      status: "unchanged",
      addedNames: [],
      recoveryDirectory: null,
    });
    return expect(existsSync(f.master)).toBe(false);
  });

  return it.each([
    "op://fixture-vault/item/field",
    "${UNRESOLVED}",
    "placeholder-value",
    "",
  ])("never resolves or stages ineligible value %#", (value) => {
    const f = fixture();
    writeFileSync(f.source, `${alias}='${value}'\n`);
    expect(apply(f).status).toBe("unchanged");
    return expect(existsSync(f.master)).toBe(false);
  });
});

describe("reviewed apply rejects unsafe filesystem inputs", () => {
  it.each(["source", "master", "manifest", "schema"])(
    "rejects a symlink or hardlinked %s without following it",
    (name) => {
      for (const kind of ["symlink", "hardlink"]) {
        const f = fixture("UNKNOWN=fixture-old\n");
        const path =
          name === "source"
            ? f.source
            : name === "master"
              ? f.master
              : name === "manifest"
                ? f.manifestPath
                : join(f.root, ".env.example");
        const other = join(f.base, `foreign-${kind}`);
        renameSync(path, other);
        if (kind === "symlink") {
          symlinkSync(other, path);
        } else {
          linkSync(other, path);
        }
        const before = readFileSync(other, "utf8");
        const result = applyReviewed(f.root, "selection.json");
        expect(result.status).toBe("failed");
        expect(result.masterState).toBe("unchanged");
        expect(readFileSync(other, "utf8")).toBe(before);
        expect(result.addedNames).toEqual([]);
      }
    }
  );

  it.each([
    "source-parent",
    "private-parent",
    "configuration",
    "manifest-parent",
  ])("rejects symlink ancestor %s", (location) => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const path =
      location === "source-parent"
        ? dirname(f.source)
        : location === "private-parent"
          ? dirname(f.configuration)
          : location === "configuration"
            ? f.configuration
            : join(f.root, "selection-parent");
    let manifest = "selection.json";
    if (location === "manifest-parent") {
      symlinkSync(f.root, path, "dir");
      manifest = "selection-parent/selection.json";
    } else {
      const originalPath = `${path}-held`;
      renameSync(path, originalPath);
      symlinkSync(originalPath, path, "dir");
    }
    return expect(applyReviewed(f.root, manifest).status).toBe("failed");
  });

  it.each([
    "source",
    "master",
    "manifest",
    "schema",
    "source-parent",
    "private-parent",
  ])("rejects unsafe permissions at %s rather than changing them", (name) => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const path =
      name === "source"
        ? f.source
        : name === "master"
          ? f.master
          : name === "manifest"
            ? f.manifestPath
            : name === "schema"
              ? join(f.root, ".env.example")
              : name === "source-parent"
                ? dirname(f.source)
                : dirname(f.configuration);
    chmodSync(path, name.endsWith("parent") ? 0o777 : 0o666);
    const before = lstatSync(path).mode;
    const result = applyReviewed(f.root, "selection.json");
    expect(result.status).toBe("failed");
    return expect(lstatSync(path).mode).toBe(before);
  });

  it("still requires mode0600 for the master even behind a private ancestor", () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    chmodSync(f.master, 0o644);
    expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
    expect(lstatSync(f.master).mode & 0o777).toBe(0o644);
    return expect(readFileSync(f.master, "utf8")).toBe("UNKNOWN=fixture-old\n");
  });

  it.each(["source", "master", "schema", "manifest"])(
    "rejects oversized %s within bounded reads",
    (name) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const path =
        name === "source"
          ? f.source
          : name === "master"
            ? f.master
            : name === "schema"
              ? join(f.root, ".env.example")
              : f.manifestPath;
      writeFileSync(path, "x".repeat(1024 * 1024 + 1));
      effects.calls = [];
      expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
      return expect(
        effects.calls
          .filter((call) => call.operation === "readSync")
          .every((call) => (call.args[3] as number) <= 1024 * 1024 + 1)
      ).toBe(true);
    }
  );

  it.each(["source", "master", "schema", "manifest"])(
    "rejects lossy UTF-8 in %s without rewriting bytes or backups",
    (name) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const path =
        name === "source"
          ? f.source
          : name === "master"
            ? f.master
            : name === "schema"
              ? join(f.root, ".env.example")
              : f.manifestPath;
      const bytes = Buffer.concat([
        readFileSync(path),
        Buffer.from([0x23, 0xff, 0x0a]),
      ]);
      writeFileSync(path, bytes);
      const originalMaster = readFileSync(f.master);
      const result = applyReviewed(f.root, "selection.json");
      expect(result).toMatchObject({
        status: "failed",
        reason: "reviewed-invalid-encoding",
        masterState: "unchanged",
        recoveryDirectory: null,
      });
      expect(readFileSync(path)).toEqual(bytes);
      return expect(readFileSync(f.master)).toEqual(originalMaster);
    }
  );

  it("rejects a foreign file owner on the opened descriptor", async () => {
    const f = fixture();
    const fs = await original();
    onceAfter(
      "fstatSync",
      (args) => pathForFd(fs, args[0]) === f.source,
      (_args, stat) => {
        return Object.defineProperty(stat, "uid", {
          value: process.getuid!() + 1,
        });
      }
    );
    expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
    return expect(existsSync(f.master)).toBe(false);
  });

  it("fails closed without verified procfs", () => {
    const f = fixture();
    onceAfter(
      "statfsSync",
      () => true,
      (_args, stat) => {
        return Object.defineProperty(stat, "type", { value: 0 });
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result.reason).toBe("reviewed-filesystem-unavailable");
    return expect(existsSync(f.configuration)).toBe(false);
  });

  it("bounds anchors while unwinding a deep uncached manifest branch and closes every opened descriptor", async () => {
    const f = fixture();
    const fs = await original();
    const deep = join(f.root, ...Array.from({ length: 520 }, () => "d"));
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    const manifestPath = join(deep, "selection.json");
    fs.writeFileSync(manifestPath, JSON.stringify(f.manifest), { mode: 0o600 });
    const opened: number[] = [];
    const closed: number[] = [];
    let anchors = 0;
    effects.calls = [];
    effects.after = (operation, args, result) => {
      if (operation === "openSync") {
        opened.push(result as number);
        if (
          args[0] !== "/proc/self/fd" &&
          ((args[1] as number) & fs.constants.O_DIRECTORY) !== 0
        )
          anchors += 1;
      }
      if (operation === "closeSync") return closed.push(args[0] as number);
      return;
    };
    const result = applyReviewed(f.root, manifestPath);
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-path-limit",
      masterState: "unchanged",
      recoveryRequired: false,
      recoveryDirectory: null,
    });
    expect(anchors).toBe(512);
    expect([...closed].sort()).toEqual([...opened].sort());
    expect(
      effects.calls.filter((call) =>
        [
          "mkdirSync",
          "writeFileSync",
          "fchmodSync",
          "fsyncSync",
          "linkSync",
          "renameSync",
          "unlinkSync",
          "rmdirSync",
        ].includes(call.operation)
      )
    ).toEqual([]);
    expect(effects.spawn).not.toHaveBeenCalled();
    return expect(existsSync(f.configuration)).toBe(false);
  });

  it("rejects a shared legacy lock without deleting or modifying it", () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    mkdirSync(`${f.master}.vertex-lock`, { mode: 0o700 });
    writeFileSync(
      join(`${f.master}.vertex-lock`, "foreign-owner"),
      "fixture-preserve"
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result.reason).toBe("reviewed-lock-held");
    return expect(
      readFileSync(join(`${f.master}.vertex-lock`, "foreign-owner"), "utf8")
    ).toBe("fixture-preserve");
  });

  it("explicitly requires recovery when lock mkdir succeeded but descriptor acquisition failed", () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    onceBefore(
      "openSync",
      (args) => isPath(args, "/.env.vertex-lock"),
      () => {
        throw Object.assign(new Error("fixture-descriptor-limit"), {
          code: "EMFILE",
        });
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-lock-recovery-required",
      recoveryRequired: true,
      recoveryDirectory: null,
      masterState: "unchanged",
    });
    expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
    expect(readFileSync(f.master, "utf8")).toBe("UNKNOWN=fixture-old\n");
    return expect(
      effects.calls.filter((call) => call.operation === "rmdirSync")
    ).toEqual([]);
  });

  return it("refuses destinations Git reports tracked or not ignored before creating private state", () => {
    const f = fixture();
    effects.spawn.mockReturnValue({ status: 1 });
    expect(applyReviewed(f.root, "selection.json").reason).toBe(
      "destination-not-private"
    );
    return expect(existsSync(f.configuration)).toBe(false);
  });
});

describe("stale plans and descriptor-anchored races", () => {
  it.each(["source", "manifest", "schema", "master"])(
    "detects changed %s while staging without touching the old master",
    async (name) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const fs = await original();
      const path =
        name === "source"
          ? f.source
          : name === "manifest"
            ? f.manifestPath
            : name === "schema"
              ? join(f.root, ".env.example")
              : f.master;
      const replacement =
        name === "manifest"
          ? JSON.stringify({
              version: 1,
              sources: [{ ...f.manifest.sources[0], keys: [key] }],
            })
          : name === "schema"
            ? `${key}=\n`
            : name === "master"
              ? "UNKNOWN=fixture-concurrent\n"
              : `${alias}=fixture-concurrent\n`;
      onceBefore(
        "openSync",
        (args) => isPath(args, "/candidate.env"),
        () => fs.writeFileSync(path, replacement)
      );
      const result = applyReviewed(f.root, "selection.json");
      expect(result).toMatchObject({
        status: "failed",
        masterState: "unchanged",
        addedNames: [],
      });
      expect(readFileSync(f.master, "utf8")).toBe(
        name === "master" ? replacement : "UNKNOWN=fixture-old\n"
      );
      return expect(
        existsSync(join(f.root, result.recoveryDirectory!, "previous.env"))
      ).toBe(false);
    }
  );

  it("detects identical-byte source replacement by identity, not a credential-derived hash", async () => {
    const f = fixture();
    const fs = await original();
    const text = readFileSync(f.source, "utf8");
    onceBefore(
      "openSync",
      (args) => isPath(args, "/candidate.env"),
      () => {
        fs.renameSync(f.source, `${f.source}-old`);
        return fs.writeFileSync(f.source, text, { mode: 0o600 });
      }
    );
    expect(applyReviewed(f.root, "selection.json")).toMatchObject({
      status: "failed",
      masterState: "unchanged",
    });
    return expect(existsSync(f.master)).toBe(false);
  });

  it.each(["source", "configuration"])(
    "detects %s ancestor replacement without reading/writing a redirected tree",
    async (name) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const fs = await original();
      const path = name === "source" ? dirname(f.source) : f.configuration;
      const displaced = `${path}-old`;
      onceBefore(
        "openSync",
        (args) => isPath(args, "/candidate.env"),
        () => {
          fs.renameSync(path, displaced);
          fs.mkdirSync(path, { mode: 0o700 });
          return fs.writeFileSync(
            join(path, name === "source" ? ".env.local" : ".env"),
            "FOREIGN=fixture-preserve\n",
            { mode: 0o600 }
          );
        }
      );
      const result = applyReviewed(f.root, "selection.json");
      expect(result.status).toBe("failed");
      expect(
        readFileSync(
          join(path, name === "source" ? ".env.local" : ".env"),
          "utf8"
        )
      ).toBe("FOREIGN=fixture-preserve\n");
      const heldMaster =
        name === "configuration" ? join(displaced, ".env") : f.master;
      return expect(readFileSync(heldMaster, "utf8")).toBe(
        "UNKNOWN=fixture-old\n"
      );
    }
  );

  it("rejects file growth during bounded descriptor reads", async () => {
    const f = fixture();
    const fs = await original();
    onceAfter(
      "readSync",
      (args) => pathForFd(fs, args[0]) === f.source,
      () => {
        return fs.appendFileSync(f.source, "x".repeat(1024 * 1024 + 1));
      }
    );
    expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
    return expect(existsSync(f.master)).toBe(false);
  });

  it("preserves a target inserted immediately before exclusive initial publication", async () => {
    const f = fixture();
    const fs = await original();
    onceBefore(
      "linkSync",
      () => true,
      () =>
        fs.writeFileSync(f.master, "FOREIGN=fixture-concurrent\n", {
          mode: 0o600,
        })
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "unchanged",
    });
    expect(readFileSync(f.master, "utf8")).toBe("FOREIGN=fixture-concurrent\n");
    return expect(
      readFileSync(
        join(f.root, result.recoveryDirectory!, "candidate.env"),
        "utf8"
      )
    ).toContain("fixture-selected");
  });

  it("preserves the unexpected inode moved at the non-CAS displacement boundary and reports recovery required", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    onceBefore(
      "renameSync",
      () => true,
      () => {
        fs.renameSync(f.master, `${f.master}-concurrent-backup`);
        return fs.writeFileSync(f.master, "FOREIGN=fixture-concurrent\n", {
          mode: 0o600,
        });
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "recovery-required",
      reason: "reviewed-displaced-target-changed",
      addedNames: [],
    });
    expect(existsSync(f.master)).toBe(false);
    const recovery = join(f.root, result.recoveryDirectory!);
    expect(readFileSync(join(recovery, "backup.env"), "utf8")).toBe(
      "UNKNOWN=fixture-old\n"
    );
    expect(readFileSync(join(recovery, "previous.env"), "utf8")).toBe(
      "FOREIGN=fixture-concurrent\n"
    );
    expect(readFileSync(`${f.master}-concurrent-backup`, "utf8")).toBe(
      "UNKNOWN=fixture-old\n"
    );
    expect(
      effects.calls.filter((call) => call.operation === "linkSync")
    ).toHaveLength(0);
    expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
    expect(applyReviewed(f.root, "selection.json").reason).toBe(
      "reviewed-lock-held"
    );
    expect(existsSync(f.master)).toBe(false);
    return expect(readFileSync(join(recovery, "previous.env"), "utf8")).toBe(
      "FOREIGN=fixture-concurrent\n"
    );
  });

  it("never overwrites a master recreated after displacement; retains both prior and candidate files", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    onceAfter(
      "renameSync",
      () => true,
      () =>
        fs.writeFileSync(f.master, "FOREIGN=fixture-concurrent\n", {
          mode: 0o600,
        })
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "recovery-required",
    });
    expect(readFileSync(f.master, "utf8")).toBe("FOREIGN=fixture-concurrent\n");
    const recovery = join(f.root, result.recoveryDirectory!);
    expect(readFileSync(join(recovery, "previous.env"), "utf8")).toBe(
      "UNKNOWN=fixture-old\n"
    );
    return expect(existsSync(join(recovery, "candidate.env"))).toBe(true);
  });

  it("detects source change after displacement and retains explicit recoverable missing-target state", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    onceAfter(
      "renameSync",
      () => true,
      () => fs.writeFileSync(f.source, `${alias}=fixture-changed\n`)
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "recovery-required",
    });
    expect(existsSync(f.master)).toBe(false);
    return expect(
      readFileSync(
        join(f.root, result.recoveryDirectory!, "previous.env"),
        "utf8"
      )
    ).toBe("UNKNOWN=fixture-old\n");
  });

  it("does not unlink a concurrent replacement of its staged candidate", async () => {
    const f = fixture();
    const fs = await original();
    onceAfter(
      "linkSync",
      () => true,
      (args) => {
        const candidate = args[0] as string;
        fs.unlinkSync(candidate);
        return fs.writeFileSync(candidate, "FOREIGN=fixture-retain\n", {
          mode: 0o600,
        });
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "published",
      reason: "reviewed-stage-changed",
    });
    expect(
      readFileSync(
        join(f.root, result.recoveryDirectory!, "candidate.env"),
        "utf8"
      )
    ).toBe("FOREIGN=fixture-retain\n");
    return expect(valuesAt(f.master)[key]).toBe("fixture-selected");
  });

  it("reports a changed source after publication as failed, not as current-source success", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    onceAfter(
      "linkSync",
      () => true,
      () => fs.writeFileSync(f.source, `${alias}=fixture-new-source\n`)
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "published",
      recoveryRequired: true,
    });
    expect(valuesAt(f.master)[key]).toBe("fixture-selected");
    expect(
      readFileSync(
        join(f.root, result.recoveryDirectory!, "backup.env"),
        "utf8"
      )
    ).toBe("UNKNOWN=fixture-old\n");
    return expect(lstatSync(f.master).nlink).toBe(1);
  });

  it("preserves late writes through the old inode in previous.env, not the new master", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    const descriptor = fs.openSync(f.master, fs.constants.O_RDWR);
    try {
      const result = applyReviewed(f.root, "selection.json");
      expect(result.status).toBe("applied-to-master");
      fs.writeSync(descriptor, "UNKNOWN=fixture-late-write\n", 0, "utf8");
      expect(valuesAt(f.master)[key]).toBe("fixture-selected");
      expect(
        readFileSync(
          join(f.root, result.recoveryDirectory!, "previous.env"),
          "utf8"
        )
      ).toBe("UNKNOWN=fixture-late-write\n");
      return expect(
        readFileSync(
          join(f.root, result.recoveryDirectory!, "backup.env"),
          "utf8"
        )
      ).toBe("UNKNOWN=fixture-old\n");
    } finally {
      fs.closeSync(descriptor);
    }
  });

  return it("does not remove a replacement lock during cleanup", async () => {
    const f = fixture();
    const fs = await original();
    onceAfter(
      "linkSync",
      () => true,
      () => {
        fs.renameSync(
          `${f.master}.vertex-lock`,
          `${f.master}.vertex-lock-original`
        );
        fs.mkdirSync(`${f.master}.vertex-lock`, { mode: 0o700 });
        return fs.writeFileSync(
          join(`${f.master}.vertex-lock`, "owner"),
          "fixture-retain"
        );
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-cleanup-failed",
      masterState: "published",
    });
    expect(readFileSync(join(`${f.master}.vertex-lock`, "owner"), "utf8")).toBe(
      "fixture-retain"
    );
    return expect(existsSync(`${f.master}.vertex-lock-original`)).toBe(true);
  });
});

describe("write failure and recovery semantics", () => {
  it.each([
    "candidate-open",
    "candidate-write",
    "candidate-sync",
    "backup-open",
    "displace",
    "publish",
  ])(
    "fails safely at %s with retained private recovery artifacts",
    async (point) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const fs = await original();
      const operation = point.endsWith("open")
        ? "openSync"
        : point === "candidate-write"
          ? "writeFileSync"
          : point === "candidate-sync"
            ? "fsyncSync"
            : point === "displace"
              ? "renameSync"
              : "linkSync";
      const matches = (args: unknown[]): boolean => {
        if (point === "candidate-open") return isPath(args, "/candidate.env");
        if (point === "backup-open") return isPath(args, "/backup.env");
        if (point === "candidate-write" || point === "candidate-sync")
          return (
            typeof args[0] === "number" &&
            pathForFd(fs, args[0]).endsWith("/candidate.env")
          );
        return true;
      };
      onceBefore(operation, matches, () => {
        throw new Error("fixture-sensitive-write-error");
      });
      const result = applyReviewed(f.root, "selection.json");
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(
        "fixture-sensitive-write-error"
      );
      expect(result.masterState).toBe(
        point === "publish" ? "recovery-required" : "unchanged"
      );
      expect(existsSync(`${f.master}.vertex-lock`)).toBe(point === "publish");
      if (point === "publish") {
        expect(existsSync(f.master)).toBe(false);
        expect(
          readFileSync(
            join(f.root, result.recoveryDirectory!, "previous.env"),
            "utf8"
          )
        ).toBe("UNKNOWN=fixture-old\n");
      } else {
        expect(readFileSync(f.master, "utf8")).toBe("UNKNOWN=fixture-old\n");
      }
      for (const name of readdirSync(join(f.root, result.recoveryDirectory!))) {
        expect(
          lstatSync(join(f.root, result.recoveryDirectory!, name)).mode & 0o777
        ).toBe(0o600);
      }
    }
  );

  it("reports publication with unknown durability rather than rollback/success after a final fsync failure", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    onceAfter(
      "linkSync",
      () => true,
      () => {
        return onceBefore(
          "fsyncSync",
          () => true,
          () => {
            throw new Error("fixture-durability-error");
          }
        );
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "published",
      addedNames: [],
      recoveryRequired: true,
      reason: "reviewed-published-durability-unknown",
    });
    expect(lstatSync(f.master).nlink).toBe(1);
    expect(valuesAt(f.master)[key]).toBe("fixture-selected");
    expect(
      existsSync(join(f.root, result.recoveryDirectory!, "backup.env"))
    ).toBe(true);
    return expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
  });

  it("fsyncs candidate, backup and recovery directory before displacing the existing master", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    const fs = await original();
    const synced: string[] = [];
    let displaced = false;
    effects.after = (operation, args) => {
      if (operation === "fsyncSync") synced.push(pathForFd(fs, args[0]));
      if (operation === "renameSync") {
        displaced = true;
        expect(synced.some((path) => path.endsWith("/candidate.env"))).toBe(
          true
        );
        expect(synced.some((path) => path.endsWith("/backup.env"))).toBe(true);
        return expect(
          synced.some(
            (path) =>
              path.includes("/.vertex-reviewed-") && !path.endsWith(".env")
          )
        ).toBe(true);
      }
      return;
    };
    expect(applyReviewed(f.root, "selection.json").status).toBe(
      "applied-to-master"
    );
    return expect(displaced).toBe(true);
  });

  it("never reports success if candidate unlink fails and preserves the explicit two-link recovery state", () => {
    const f = fixture();
    onceBefore(
      "unlinkSync",
      () => true,
      () => {
        throw new Error("fixture-unlink-error");
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      masterState: "published",
      recoveryRequired: true,
    });
    expect(lstatSync(f.master).nlink).toBe(2);
    expect(() => readInspectionRegular(f.master, true)).toThrow(
      "inspection-read-failed"
    );
    expect(
      existsSync(join(f.root, result.recoveryDirectory!, "candidate.env"))
    ).toBe(true);
    return expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
  });

  it("closes every successfully opened descriptor on a read failure", () => {
    const f = fixture();
    const opened: number[] = [];
    const closed: number[] = [];
    effects.after = (operation, args, result) => {
      if (operation === "openSync") opened.push(result as number);
      if (operation === "closeSync") return closed.push(args[0] as number);
      return;
    };
    onceBefore(
      "readSync",
      () => true,
      () => {
        throw new Error("fixture-read-error");
      }
    );
    expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
    return expect([...closed].sort()).toEqual([...opened].sort());
  });

  return it("does not treat lock cleanup failure as a successful apply", () => {
    const f = fixture();
    onceBefore(
      "rmdirSync",
      () => true,
      () => {
        throw new Error("fixture-cleanup-error");
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-cleanup-failed",
      masterState: "published",
    });
    return expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
  });
});

describe("explicit reviewed-apply CLI boundary", () => {
  it("returns only sanitized master-only JSON for the exact explicit invocation", () => {
    const f = fixture();
    let output = "";
    const code = run(
      ["consolidate", "--apply-reviewed", "--manifest", "selection.json"],
      f.root,
      { write: (text) => (output += text) }
    );
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      mode: "reviewed-apply",
      status: "applied-to-master",
      projection: "not-performed-use-explicit-project",
    });
    return expect(output).not.toMatch(
      /fixture-selected|fixture-untouched|fixture-root-preserved/
    );
  });

  it("returns a nonzero sanitized conflict rather than silently invoking legacy consolidation", () => {
    const f = fixture(`${key}=fixture-old\n`);
    let output = "";
    expect(
      run(
        ["consolidate", "--apply-reviewed", "--manifest", "selection.json"],
        f.root,
        { write: (text) => (output += text) }
      )
    ).toBe(1);
    expect(JSON.parse(output).status).toBe("blocked");
    expect(readFileSync(f.master, "utf8")).toBe(`${key}=fixture-old\n`);
    return expect(output).not.toContain("fixture-old");
  });

  it.each(
    [
      ["consolidate", "--apply-reviewed"],
      ["consolidate", "--apply-reviewed", "--manifest"],
      ["consolidate", "--apply-reviewed", "--manifest", "--manifest"],
      ["consolidate", "--apply-reviewed", "--manifest", "--dry-run"],
      ["consolidate", "--dry-run", "--manifest", "--apply-reviewed"],
      [
        "consolidate",
        "--dry-run",
        "--apply-reviewed",
        "--manifest",
        "selection.json",
      ],
      [
        "consolidate",
        "--apply-reviewed",
        "--dry-run",
        "--manifest",
        "selection.json",
      ],
      [
        "consolidate",
        "--apply-reviewed",
        "--manifest",
        "selection.json",
        "--manifest",
        "other.json",
      ],
      ["consolidate", "--manifest", "selection.json", "--apply-reviewed"],
      ["project", "--apply-reviewed", "--manifest", "selection.json"],
      ["consolidate", "--apply-reviewed", "--manifest=selection.json"],
    ].map((args) => ({ args }))
  )("rejects malformed/ambiguous invocation %# before I/O", ({ args }) => {
    const f = fixture();
    effects.calls = [];
    let output = "";
    expect(run(args, f.root, { write: (text) => (output += text) })).toBe(1);
    expect(output).toContain("usage:");
    expect(effects.calls).toEqual([]);
    return expect(effects.spawn).not.toHaveBeenCalled();
  });

  it.each(["", "../selection.json", "bad\\selection.json", "bad\0.json"])(
    "rejects unsafe manifest argument %# without I/O",
    (path) => {
      const f = fixture();
      effects.calls = [];
      expect(applyReviewed(f.root, path)).toMatchObject({
        status: "failed",
        reason: "invalid-manifest",
      });
      expect(effects.calls).toEqual([]);
      return expect(effects.spawn).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid selection manifests before source reads or private directory creation", () => {
    const f = fixture();
    writeFileSync(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        sources: [{ repository: "unapproved", path: ".env", keys: [key] }],
      })
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid-manifest-repository",
    });
    expect(existsSync(f.configuration)).toBe(false);
    return expect(effects.spawn).not.toHaveBeenCalled();
  });

  it("binds apply to the approved production checkout before any reads or Git calls", () => {
    const f = fixture();
    const output = { write: vi.fn() };
    const exitState = { exitCode: 0 };
    effects.calls = [];
    runConfigurationEntrypoint({
      isMain: true,
      argv: [
        "bun",
        "cli.ts",
        "consolidate",
        "--apply-reviewed",
        "--manifest",
        "selection.json",
      ],
      moduleUrl: pathToFileURL(join(f.root, "scripts/vertex-config/cli.ts"))
        .href,
      output,
      exitState,
    });
    expect(exitState.exitCode).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: unapproved-inspection-location\n"
    );
    expect(effects.calls).toEqual([]);
    return expect(effects.spawn).not.toHaveBeenCalled();
  });

  return it("retains zero-lock zero-write dry-run behavior with the new module imported", () => {
    const f = fixture();
    effects.calls = [];
    const output = { write: vi.fn() };
    expect(
      run(
        ["consolidate", "--dry-run", "--manifest", "selection.json"],
        f.root,
        output
      )
    ).toBe(0);
    expect(
      effects.calls.filter((call) =>
        [
          "mkdirSync",
          "writeFileSync",
          "fchmodSync",
          "fsyncSync",
          "linkSync",
          "renameSync",
          "unlinkSync",
          "rmdirSync",
        ].includes(call.operation)
      )
    ).toEqual([]);
    expect(effects.spawn).not.toHaveBeenCalled();
    return expect(existsSync(f.configuration)).toBe(false);
  });
});

describe("source-only private-ancestor read policy", () => {
  it.each([0o644, 0o640, 0o600])(
    "accepts source mode %i only behind its own private ancestor without mutating originals",
    (mode) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      const chain = sourceChain(f);
      chmodSync(f.source, mode);
      const sourceBefore = lstatSync(f.source);
      const parentsBefore = chain.map((path) => ({
        path,
        stat: lstatSync(path),
      }));
      const result = apply(f);
      expect(result.status).toBe("applied-to-master");
      expect(lstatSync(f.source)).toMatchObject({
        ino: sourceBefore.ino,
        mode: sourceBefore.mode,
        uid: sourceBefore.uid,
        nlink: 1,
        mtimeMs: sourceBefore.mtimeMs,
        ctimeMs: sourceBefore.ctimeMs,
      });
      for (const { path, stat } of parentsBefore) {
        expect(lstatSync(path)).toMatchObject({
          ino: stat.ino,
          mode: stat.mode,
          uid: stat.uid,
        });
      }
      expect(lstatSync(f.master).mode & 0o777).toBe(0o600);
      for (const name of ["backup.env", "previous.env"]) {
        expect(
          lstatSync(join(f.root, result.recoveryDirectory!, name)).mode & 0o777
        ).toBe(0o600);
      }
    }
  );

  // Other tests use FIXTURE_PARENT, which is tmpdir() and can be outside /tmp on
  // the rig CI runner, so this one holds the only-/tmp exception for writable
  // root-owned ancestors on every host.
  it("accepts the root-owned sticky /tmp as a world-writable system ancestor", () => {
    const f = fixture("UNKNOWN=fixture-old\n", "/tmp");
    sourceChain(f);
    expect(lstatSync("/tmp")).toMatchObject({ uid: 0 });
    expect(lstatSync("/tmp").mode & 0o1777).toBe(0o1777);
    return expect(apply(f).status).toBe("applied-to-master");
  });

  it("rejects absent private source ancestry before source bytes despite separate private target directories", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    sourceChain(f, false);
    const fs = await original();
    let sourceReads = 0;
    effects.before = (operation, args) => {
      if (operation === "readSync" && pathForFd(fs, args[0]) === f.source)
        return (sourceReads += 1);
      return;
    };
    await withoutOuterPrivateAncestors(f);
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-source-not-private",
      masterState: "unchanged",
    });
    expect(sourceReads).toBe(0);
    expect(readFileSync(f.master, "utf8")).toBe("UNKNOWN=fixture-old\n");
    expect(lstatSync(f.configuration).mode & 0o777).toBe(0o700);
    return expect(lstatSync(f.source).mode & 0o777).toBe(0o644);
  });

  it("does not accept a mode0700 ancestor owned by somebody else as its private proof", async () => {
    const f = fixture();
    sourceChain(f);
    const fs = await original();
    let sourceReads = 0;
    effects.before = (operation, args) => {
      if (operation === "readSync" && pathForFd(fs, args[0]) === f.source)
        return (sourceReads += 1);
      return;
    };
    await withoutOuterPrivateAncestors(f, (operation, args, result) => {
      const target =
        operation === "fstatSync"
          ? pathForFd(fs, args[0])
          : operation === "lstatSync"
            ? fs.realpathSync(args[0] as string)
            : null;
      if (target === f.base)
        return Object.defineProperty(result, "uid", {
          value: process.getuid!() === 0 ? 1 : 0,
        });
      return;
    });
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-source-not-private",
    });
    expect(sourceReads).toBe(0);
    return expect(existsSync(f.master)).toBe(false);
  });

  it.each(["relaxed-proof", "replaced-parent", "wrong-owner-held"])(
    "rejects %s after source open before reading any source bytes",
    async (change) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      sourceChain(f);
      const fs = await original();
      let sourceDescriptor: number | null = null;
      let sourceReads = 0;
      effects.before = (operation, args) => {
        if (operation === "readSync" && args[0] === sourceDescriptor)
          return (sourceReads += 1);
        return;
      };
      onceAfter(
        "fstatSync",
        (args) => pathForFd(fs, args[0]) === f.source,
        (args) => {
          sourceDescriptor = args[0] as number;
          if (change === "relaxed-proof") {
            return fs.chmodSync(f.base, 0o755);
          }
          if (change === "replaced-parent") {
            const repository = dirname(dirname(f.source));
            fs.renameSync(repository, `${repository}-old`);
            return fs.mkdirSync(repository, { mode: 0o755 });
          }
          return onceAfter(
            "fstatSync",
            (next) => pathForFd(fs, next[0]) === f.base,
            (_next, stat) => {
              return Object.defineProperty(stat, "uid", {
                value: process.getuid!() + 1,
              });
            }
          );
        }
      );
      const result = applyReviewed(f.root, "selection.json");
      expect(result).toMatchObject({
        status: "failed",
        reason: "reviewed-ancestor-changed",
        masterState: "unchanged",
      });
      expect(sourceDescriptor).not.toBeNull();
      expect(sourceReads).toBe(0);
      return expect(readFileSync(f.master, "utf8")).toBe(
        "UNKNOWN=fixture-old\n"
      );
    }
  );

  it.each(["read", "stage", "displaced"])(
    "revalidates source protection after %s without silently weakening rereads",
    async (boundary) => {
      const f = fixture("UNKNOWN=fixture-old\n");
      sourceChain(f);
      const fs = await original();
      if (boundary === "read") {
        onceAfter(
          "readSync",
          (args) => pathForFd(fs, args[0]) === f.source,
          () => fs.chmodSync(f.base, 0o755)
        );
      } else if (boundary === "stage") {
        onceBefore(
          "openSync",
          (args) => isPath(args, "/candidate.env"),
          () => fs.chmodSync(f.base, 0o755)
        );
      } else {
        onceAfter(
          "renameSync",
          () => true,
          () => fs.chmodSync(f.base, 0o755)
        );
      }
      const result = applyReviewed(f.root, "selection.json");
      expect(result.status).toBe("failed");
      expect(result.masterState).toBe(
        boundary === "displaced" ? "recovery-required" : "unchanged"
      );
      if (boundary === "displaced") {
        expect(existsSync(f.master)).toBe(false);
        expect(existsSync(`${f.master}.vertex-lock`)).toBe(true);
        return expect(
          readFileSync(
            join(f.root, result.recoveryDirectory!, "previous.env"),
            "utf8"
          )
        ).toBe("UNKNOWN=fixture-old\n");
      }
      return expect(readFileSync(f.master, "utf8")).toBe(
        "UNKNOWN=fixture-old\n"
      );
    }
  );

  it.each([0o664, 0o646, 0o602])(
    "rejects writable source mode %i even behind verified mode0700 ancestry",
    async (mode) => {
      const f = fixture();
      sourceChain(f);
      chmodSync(f.source, mode);
      const fs = await original();
      let sourceReads = 0;
      effects.before = (operation, args) => {
        if (operation === "readSync" && pathForFd(fs, args[0]) === f.source)
          return (sourceReads += 1);
        return;
      };
      expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
      expect(sourceReads).toBe(0);
      expect(lstatSync(f.source).mode & 0o777).toBe(mode);
      return expect(existsSync(f.master)).toBe(false);
    }
  );

  it.each(["hardlink", "symlink"])(
    "rejects a %s to a mode0644 source even behind private ancestry",
    (kind) => {
      const f = fixture();
      sourceChain(f);
      const other = join(dirname(f.source), "foreign.env");
      renameSync(f.source, other);
      if (kind === "hardlink") {
        linkSync(other, f.source);
      } else {
        symlinkSync(other, f.source);
      }
      const before = readFileSync(other);
      expect(applyReviewed(f.root, "selection.json").status).toBe("failed");
      expect(readFileSync(other)).toEqual(before);
      expect(lstatSync(other).mode & 0o777).toBe(0o644);
      return expect(existsSync(f.master)).toBe(false);
    }
  );

  it("preserves metadata policy for a mode0644 names-only manifest outside the source's private chain", () => {
    const f = fixture();
    chmodSync(f.base, 0o755);
    chmodSync(join(f.base, "trading"), 0o755);
    chmodSync(f.root, 0o755);
    chmodSync(f.manifestPath, 0o644);
    // The source still has its own current-UID mode0700 repository parent.
    chmodSync(dirname(dirname(f.source)), 0o700);
    const manifestBefore = lstatSync(f.manifestPath);
    expect(apply(f).status).toBe("applied-to-master");
    return expect(lstatSync(f.manifestPath)).toMatchObject({
      mode: manifestBefore.mode,
      ino: manifestBefore.ino,
      mtimeMs: manifestBefore.mtimeMs,
      ctimeMs: manifestBefore.ctimeMs,
    });
  });

  return it("does not weaken private staging-file mode checks when sources use the relaxed policy", async () => {
    const f = fixture("UNKNOWN=fixture-old\n");
    sourceChain(f);
    const fs = await original();
    onceAfter(
      "fsyncSync",
      (args) => pathForFd(fs, args[0]).endsWith("/candidate.env"),
      (args) => {
        return fs.fchmodSync(args[0] as number, 0o644);
      }
    );
    const result = applyReviewed(f.root, "selection.json");
    expect(result).toMatchObject({
      status: "failed",
      reason: "reviewed-unsafe-file",
      masterState: "unchanged",
    });
    return expect(readFileSync(f.master, "utf8")).toBe("UNKNOWN=fixture-old\n");
  });
});
