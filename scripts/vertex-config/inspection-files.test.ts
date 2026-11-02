import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, runConfigurationEntrypoint } from "./cli.ts";
import { collectInspection, readInspectionRegular } from "./files.ts";

// The registry records the reviewing machine's absolute roots; re-root it beside
// this checkout so the fixtures hold wherever the repository is cloned.
vi.mock(
  "../../docs/vertex-rebuild/migration-matrix.json",
  async (importOriginal) =>
    (await import("./registry.test-support.ts")).rerootRegistry(importOriginal)
);

const guard = vi.hoisted(() => ({
  active: false,
  writes: [] as string[],
  reads: [] as string[],
  opens: [] as string[],
  processes: 0,
  opened: [] as number[],
  closed: [] as number[],
  bytesRead: 0,
  afterStat: null as ((descriptor: number) => void) | null,
  afterRead: null as ((descriptor: number) => void) | null,
  beforeOpen: null as ((path: string) => void) | null,
  statOverride: null as
    | ((
        descriptor: number,
        stat: import("node:fs").Stats
      ) => import("node:fs").Stats)
    | null,
  maxRead: null as number | null,
  procType: null as number | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guarded: Record<string, unknown> = {};
  for (const name of [
    "mkdirSync",
    "writeFileSync",
    "appendFileSync",
    "renameSync",
    "linkSync",
    "unlinkSync",
    "rmdirSync",
    "rmSync",
    "chmodSync",
    "fchmodSync",
    "fsyncSync",
    "symlinkSync",
    "truncateSync",
  ]) {
    guarded[name] = (...args: unknown[]) => {
      if (guard.active) {
        guard.writes.push(name);
        throw new Error("unexpected mutation");
      }
      return (
        actual[name as keyof typeof actual] as (...args: unknown[]) => unknown
      )(...args);
    };
  }
  return {
    ...actual,
    ...guarded,
    openSync: (path: string, flags: number, mode?: number) => {
      if (guard.active) {
        guard.opens.push(path);
        if (
          (flags &
            (actual.constants.O_WRONLY |
              actual.constants.O_RDWR |
              actual.constants.O_CREAT |
              actual.constants.O_TRUNC |
              actual.constants.O_APPEND)) !==
          0
        ) {
          guard.writes.push("openSync");
          throw new Error("unexpected write open");
        }
        guard.beforeOpen?.(path);
      }
      const descriptor = actual.openSync(path, flags, mode);
      if (guard.active) {
        guard.opened.push(descriptor);
        if ((flags & actual.constants.O_DIRECTORY) === 0) {
          guard.reads.push(actual.readlinkSync(`/proc/self/fd/${descriptor}`));
        }
      }
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      actual.closeSync(descriptor);
      if (guard.active) return guard.closed.push(descriptor);
      return;
    },
    fstatSync: (descriptor: number) => {
      const stat = actual.fstatSync(descriptor);
      guard.afterStat?.(descriptor);
      return guard.statOverride === null
        ? stat
        : guard.statOverride(descriptor, stat);
    },
    statfsSync: (path: string) => {
      const stat = actual.statfsSync(path);
      return guard.procType === null ? stat : { ...stat, type: guard.procType };
    },
    readSync: (
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const count = actual.readSync(
        descriptor,
        buffer,
        offset,
        guard.maxRead === null ? length : Math.min(length, guard.maxRead),
        position
      );
      if (guard.active) guard.bytesRead += count;
      guard.afterRead?.(descriptor);
      return count;
    },
  };
});
vi.mock("node:child_process", () => ({
  spawnSync: () => {
    guard.processes += 1;
    throw new Error("unexpected child process");
  },
}));

const directories: string[] = [];
const key = "FINANCIAL_DATASETS_API_KEY";
const makeFixture = () => {
  const base = mkdtempSync(join(tmpdir(), "vertex-inspection-only-"));
  directories.push(base);
  const root = join(base, "trading", "vertex-research-platform");
  const source = join(base, "trading", "gamma-forge", "forge", ".env.local");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(base, "trading", "gamma-forge", "forge"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    source,
    "FINANCIALDATASETS_API_KEY=fixture-source\nUNSELECTED=fixture-never-output\n",
    { mode: 0o600 }
  );
  writeFileSync(join(root, ".env.example"), `${key}=\n`, { mode: 0o600 });
  // Deliberately unlike generated defaults: dry-run must never reconcile this.
  writeFileSync(join(root, ".env"), "UNRELATED=fixture-local-customization\n", {
    mode: 0o600,
  });
  const manifest = {
    version: 1,
    sources: [
      {
        repository: "gamma-forge",
        path: "forge/.env.local",
        keys: ["FINANCIALDATASETS_API_KEY"],
      },
    ],
  };
  const manifestPath = join(root, "selection.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return {
    base,
    root,
    source,
    manifest,
    manifestPath,
    master: join(root, "private", "configuration", ".env"),
  };
};

const snapshot = (directory: string): unknown[] => {
  const rows: unknown[] = [];
  const visit = (relative: string): void => {
    const path = join(directory, relative);
    const stat = lstatSync(path);
    rows.push({
      relative,
      mode: stat.mode,
      ino: stat.ino,
      mtime: stat.mtimeMs,
      size: stat.size,
      content: stat.isFile() ? readFileSync(path, "utf8") : null,
    });
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        visit(join(relative, entry));
      }
    }
  };
  visit("");
  return rows;
};

const resetGuard = (): void => {
  guard.writes = [];
  guard.reads = [];
  guard.opens = [];
  guard.opened = [];
  guard.closed = [];
  guard.bytesRead = 0;
  guard.processes = 0;
};

const executeReadOnly = (
  fixture: ReturnType<typeof makeFixture>,
  args: readonly string[] = [
    "consolidate",
    "--dry-run",
    "--manifest",
    "selection.json",
  ]
) => {
  const before = snapshot(fixture.base);
  const fetch = vi.fn(() => {
    throw new Error("unexpected provider access");
  });
  vi.stubGlobal("fetch", fetch);
  resetGuard();
  let output = "";
  guard.active = true;
  let code: number;
  try {
    code = run(args, fixture.root, { write: (text) => (output += text) });
  } finally {
    guard.active = false;
  }
  expect(guard.writes).toEqual([]);
  expect(guard.processes).toBe(0);
  expect([...guard.closed].sort()).toEqual([...guard.opened].sort());
  expect(fetch).not.toHaveBeenCalled();
  expect(snapshot(fixture.base)).toEqual(before);
  expect(output).not.toMatch(
    /fixture-source|fixture-master|fixture-never-output|fixture-local-customization|op:\/\//
  );
  return { code, output, reads: [...guard.reads] };
};

afterEach(() => {
  guard.active = false;
  guard.afterStat = null;
  guard.afterRead = null;
  guard.beforeOpen = null;
  guard.maxRead = null;
  guard.procType = null;
  guard.statOverride = null;
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  return;
});

describe("read-only selection collector and CLI", () => {
  it("collects only the selected nested local file and never creates private state", () => {
    const fixture = makeFixture();
    const result = executeReadOnly(fixture);
    expect(result.code).toBe(0);
    expect(result.reads).toEqual([
      fixture.manifestPath,
      join(fixture.root, ".env.example"),
      fixture.source,
    ]);
    return expect(JSON.parse(result.output)).toMatchObject({
      mode: "names-only-dry-run",
      eligibleNames: [key],
      selectedNames: [key],
      entries: [
        {
          groups: [
            {
              id: "g1",
              origins: [
                {
                  repository: "gamma-forge",
                  path: "forge/.env.local",
                  kind: "source",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("preserves an existing master and inventory byte-for-byte on conflict", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.root, "private", "configuration"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(fixture.master, `${key}=fixture-master\n`, { mode: 0o600 });
    writeFileSync(
      join(fixture.root, "private", "configuration", "inventory.json"),
      "fixture-existing-receipt",
      { mode: 0o600 }
    );
    const result = executeReadOnly(fixture);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      conflictingNames: [key],
      entries: [{ decision: "retain-existing-master" }],
    });
    return expect(result.reads).not.toContain(join(fixture.root, ".env"));
  });

  it("reports absent selected files without creating or recursively discovering them", () => {
    const fixture = makeFixture();
    fixture.manifest.sources[0]!.path = "not-present/deep/.env";
    writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
    const result = executeReadOnly(fixture);
    expect(result.code).toBe(0);
    expect(result.reads).not.toContain(fixture.source);
    return expect(
      JSON.parse(result.output).entries[0].observations[0].reason
    ).toBe("missing-file");
  });

  it.each([
    "../.env",
    "/.env",
    "forge/../.env",
    "forge\\.env",
    "./forge/.env.local",
  ])("rejects source traversal before reading credentials %#", (path) => {
    const fixture = makeFixture();
    fixture.manifest.sources[0]!.path = path;
    writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
    const result = executeReadOnly(fixture);
    expect(result.code).toBe(1);
    expect(result.output).toBe("vertex-config: invalid-manifest-path\n");
    return expect(result.reads).toEqual([fixture.manifestPath]);
  });

  it.each(["", "../selection.json", "forge\\selection.json", "bad\0.json"])(
    "rejects unsafe manifest locations %#",
    (path) => {
      const fixture = makeFixture();
      const result = executeReadOnly(fixture, [
        "consolidate",
        "--dry-run",
        "--manifest",
        path,
      ]);
      expect(result.code).toBe(1);
      expect(result.reads).toEqual([]);
      return expect(result.output).toBe("vertex-config: invalid-manifest\n");
    }
  );

  it.each([
    "manifest",
    "source",
    "schema",
    "master",
    "source-parent",
    "master-parent",
    "missing-source-below-symlink",
    "manifest-parent",
  ])("fails closed on symlinks at %s", (location) => {
    const fixture = makeFixture();
    const target = join(fixture.base, "synthetic-target");
    writeFileSync(target, `${key}=fixture-never-output\n`, { mode: 0o600 });
    let args = ["consolidate", "--dry-run", "--manifest", "selection.json"];
    if (
      location === "manifest" ||
      location === "source" ||
      location === "schema"
    ) {
      const path =
        location === "manifest"
          ? fixture.manifestPath
          : location === "source"
            ? fixture.source
            : join(fixture.root, ".env.example");
      rmSync(path);
      symlinkSync(target, path);
    } else if (location === "master") {
      mkdirSync(join(fixture.root, "private", "configuration"), {
        recursive: true,
        mode: 0o700,
      });
      symlinkSync(target, fixture.master);
    } else if (location === "master-parent") {
      symlinkSync(fixture.base, join(fixture.root, "private"), "dir");
    } else if (location === "manifest-parent") {
      symlinkSync(fixture.root, join(fixture.root, "linked"), "dir");
      args = [
        "consolidate",
        "--dry-run",
        "--manifest",
        "linked/selection.json",
      ];
    } else {
      const parent = join(fixture.base, "trading", "gamma-forge", "forge");
      rmSync(parent, { recursive: true });
      symlinkSync(fixture.base, parent, "dir");
      if (location === "missing-source-below-symlink") {
        fixture.manifest.sources[0]!.path = "forge/missing/deep/.env";
        writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
      }
    }
    const result = executeReadOnly(fixture, args);
    expect(result.code).toBe(1);
    expect(result.output).toBe("vertex-config: inspection-read-failed\n");
    return expect(result.reads).not.toContain(target);
  });

  it.each([
    "missing-manifest",
    "invalid-json",
    "invalid-shape",
    "missing-schema",
    "invalid-source",
    "invalid-master",
    "unsafe-master",
    "directory-source",
  ])("does not write on %s failure", (scenario) => {
    const fixture = makeFixture();
    if (scenario === "missing-manifest") rmSync(fixture.manifestPath);
    if (scenario === "invalid-json")
      writeFileSync(fixture.manifestPath, "{fixture-never-output");
    if (scenario === "invalid-shape")
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify({ ...fixture.manifest, roots: [fixture.base] })
      );
    if (scenario === "missing-schema")
      rmSync(join(fixture.root, ".env.example"));
    if (scenario === "invalid-source")
      writeFileSync(fixture.source, "invalid fixture-never-output");
    if (scenario === "invalid-master" || scenario === "unsafe-master") {
      mkdirSync(join(fixture.root, "private", "configuration"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(fixture.master, "UNKNOWN=fixture-master\n", {
        mode: scenario === "unsafe-master" ? 0o644 : 0o600,
      });
    }
    if (scenario === "directory-source") {
      rmSync(fixture.source);
      mkdirSync(fixture.source, { mode: 0o700 });
    }
    const result = executeReadOnly(fixture);
    expect(result.code).toBe(1);
    return expect(result.output).not.toContain(fixture.base);
  });

  it.each(
    [
      ["consolidate", "--dry-run"],
      ["consolidate", "--manifest", "selection.json"],
      ["project", "--dry-run", "--manifest", "selection.json"],
      ["consolidate", "--dry-run", "--manifest", "selection.json", "--apply"],
    ].map((args) => ({ args }))
  )(
    "does not fall through to mutation on malformed dry-run arguments %#",
    ({ args }) => {
      const fixture = makeFixture();
      const result = executeReadOnly(fixture, args);
      expect(result.code).toBe(1);
      expect(result.reads).toEqual([]);
      return expect(result.output).toContain("usage:");
    }
  );

  it("keeps collection separate from planning and treats content as inert input", () => {
    const fixture = makeFixture();
    const result = collectInspection(fixture.root, fixture.manifestPath);
    expect(result.sources).toEqual([
      {
        repository: "gamma-forge",
        path: "forge/.env.local",
        content:
          "FINANCIALDATASETS_API_KEY=fixture-source\nUNSELECTED=fixture-never-output\n",
      },
    ]);
    return expect(result.existing).toBeNull();
  });

  it("rejects a relocated production entrypoint before any file open", () => {
    const fixture = makeFixture();
    const before = snapshot(fixture.base);
    resetGuard();
    const output = { write: vi.fn() };
    const exitState: { exitCode?: number | string } = {};
    guard.active = true;
    try {
      runConfigurationEntrypoint({
        isMain: true,
        argv: [
          "bun",
          "cli.ts",
          "consolidate",
          "--dry-run",
          "--manifest",
          fixture.manifestPath,
        ],
        moduleUrl: pathToFileURL(
          join(fixture.root, "scripts", "vertex-config", "cli.ts")
        ).href,
        output,
        exitState,
      });
    } finally {
      guard.active = false;
    }
    expect(exitState.exitCode).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: unapproved-inspection-location\n"
    );
    expect(guard.opens).toEqual([]);
    expect(guard.writes).toEqual([]);
    return expect(snapshot(fixture.base)).toEqual(before);
  });

  return it("accepts the approved entrypoint location without weakening argument validation", () => {
    resetGuard();
    const output = { write: vi.fn() };
    const exitState: { exitCode?: number | string } = {};
    guard.active = true;
    try {
      // Incomplete arguments deliberately stop before any real credential read.
      runConfigurationEntrypoint({
        isMain: true,
        argv: ["bun", "cli.ts", "consolidate", "--dry-run"],
        moduleUrl:
          "file:///synthetic/vertex-research-platform/scripts/vertex-config/cli.ts",
        output,
        exitState,
        approvedCheckout: "/synthetic/vertex-research-platform/",
      });
    } finally {
      guard.active = false;
    }
    expect(exitState.exitCode).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining("vertex-config: usage:")
    );
    return expect(guard.opens).toEqual([]);
  });
});

const guardedRead = (target: string, privateFile = false): string | null => {
  resetGuard();
  guard.active = true;
  try {
    return readInspectionRegular(target, privateFile);
  } finally {
    guard.active = false;
    expect(guard.writes).toEqual([]);
    expect([...guard.closed].sort()).toEqual([...guard.opened].sort());
  }
};

describe("descriptor-anchored inspection reads", () => {
  it("pins the verified parent across a concurrent ancestor-to-symlink replacement", async () => {
    const fixture = makeFixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const parent = join(fixture.base, "trading", "gamma-forge", "forge");
    const pinned = `${parent}-pinned`;
    const outside = join(fixture.base, "unselected-outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(
      join(outside, ".env.local"),
      "FINANCIALDATASETS_API_KEY=fixture-outside-never-read\n",
      { mode: 0o600 }
    );
    const outsideBefore = snapshot(outside);
    let swapped = false;
    guard.afterStat = (descriptor) => {
      if (
        !swapped &&
        actual.readlinkSync(`/proc/self/fd/${descriptor}`) === parent
      ) {
        // Test-only adversary bypasses the production mutation guards. This runs
        // after fstat has checked the parent but before the selected leaf opens.
        actual.renameSync(parent, pinned);
        actual.symlinkSync(outside, parent, "dir");
        return (swapped = true);
      }
      return;
    };
    expect(guardedRead(fixture.source)).toBe(
      "FINANCIALDATASETS_API_KEY=fixture-source\nUNSELECTED=fixture-never-output\n"
    );
    expect(swapped).toBe(true);
    expect(guard.reads).toEqual([join(pinned, ".env.local")]);
    expect(guard.reads.some((path) => path.startsWith(outside))).toBe(false);
    expect(snapshot(outside)).toEqual(outsideBefore);
    guard.afterStat = null;
    // A new inspection must reject the replacement; it cannot follow it.
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(guard.reads).toEqual([]);
  });

  it("rejects a symlink inserted before an ancestor descriptor is acquired", async () => {
    const fixture = makeFixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const parent = join(fixture.base, "trading", "gamma-forge", "forge");
    const outside = join(fixture.base, "unselected-outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(
      join(outside, ".env.local"),
      "FINANCIALDATASETS_API_KEY=fixture-outside-never-read\n"
    );
    guard.beforeOpen = (path) => {
      if (path.endsWith("/forge")) {
        actual.renameSync(parent, `${parent}-pinned`);
        actual.symlinkSync(outside, parent, "dir");
        return (guard.beforeOpen = null);
      }
      return;
    };
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(guard.reads).toEqual([]);
  });

  it("fails closed on an unsupported host or unverified procfs", () => {
    const fixture = makeFixture();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    expect(guard.opens).toEqual([]);
    vi.unstubAllGlobals();
    vi.stubGlobal("process", { ...process, getuid: undefined });
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    expect(guard.opens).toEqual([]);
    vi.unstubAllGlobals();
    guard.procType = 0;
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(guard.reads).toEqual([]);
  });

  it("fails closed when descriptor anchors are unavailable", () => {
    const fixture = makeFixture();
    guard.beforeOpen = () => {
      throw Object.assign(new Error("fixture-private-path"), {
        code: "EACCES",
      });
    };
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(guard.reads).toEqual([]);
  });

  it("rejects a root-directory target and an unsafe nearest parent", async () => {
    const fixture = makeFixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    expect(() => guardedRead("/")).toThrow("inspection-read-failed");
    actual.chmodSync(
      join(fixture.base, "trading", "gamma-forge", "forge"),
      0o770
    );
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(() =>
      guardedRead(
        join(fixture.base, "trading", "gamma-forge", "forge", "missing", ".env")
      )
    ).toThrow("inspection-read-failed");
  });

  it.each([false, true])(
    "checks descriptor owner for private file %s or nearest parent",
    async (privateFile) => {
      const fixture = makeFixture();
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const target = privateFile
        ? fixture.source
        : join(fixture.base, "trading", "gamma-forge", "forge");
      guard.statOverride = (descriptor, stat) => {
        if (actual.readlinkSync(`/proc/self/fd/${descriptor}`) === target) {
          stat.uid += 1;
        }
        return stat;
      };
      return expect(() => guardedRead(fixture.source, privateFile)).toThrow(
        "inspection-read-failed"
      );
    }
  );

  it("checks link count and initial size on the opened descriptor", async () => {
    const fixture = makeFixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const other = join(fixture.base, "same-inode");
    actual.linkSync(fixture.source, other);
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    actual.unlinkSync(other);
    actual.writeFileSync(fixture.source, Buffer.alloc(1024 * 1024 + 1));
    expect(() => guardedRead(fixture.source)).toThrow("inspection-read-failed");
    return expect(guard.bytesRead).toBe(0);
  });

  it("supports empty files, short reads and the exact byte limit", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.source, "");
    expect(guardedRead(fixture.source)).toBe("");
    writeFileSync(fixture.source, "fixture-short");
    guard.maxRead = 3;
    expect(guardedRead(fixture.source)).toBe("fixture-short");
    guard.maxRead = null;
    const maximum = "a".repeat(1024 * 1024);
    writeFileSync(fixture.source, maximum);
    expect(guardedRead(fixture.source)).toBe(maximum);
    return expect(guard.bytesRead).toBe(1024 * 1024);
  });

  it.each(["grow-before-read", "truncate-before-read", "truncate-after-read"])(
    "rejects concurrent %s with bounded reads",
    async (mutation) => {
      const fixture = makeFixture();
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      let changed = false;
      const change = (descriptor: number): void => {
        if (
          !changed &&
          actual.readlinkSync(`/proc/self/fd/${descriptor}`) === fixture.source
        ) {
          changed = true;
          actual.writeFileSync(
            fixture.source,
            mutation === "grow-before-read"
              ? Buffer.alloc(1024 * 1024 + 64)
              : ""
          );
        }
      };
      if (mutation === "truncate-after-read") {
        guard.afterRead = change;
      } else guard.afterStat = change;
      expect(() => guardedRead(fixture.source)).toThrow(
        "inspection-read-failed"
      );
      expect(changed).toBe(true);
      return expect(guard.bytesRead).toBeLessThanOrEqual(1024 * 1024 + 1);
    }
  );

  return it.each(["mtimeMs", "ctimeMs", "nlink"])(
    "rejects changed descriptor %s after reading",
    async (field) => {
      const fixture = makeFixture();
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      let stats = 0;
      guard.statOverride = (descriptor, stat) => {
        if (
          actual.readlinkSync(`/proc/self/fd/${descriptor}`) === fixture.source
        ) {
          stats += 1;
          if (stats === 2) {
            if (field === "mtimeMs") stat.mtimeMs += 1;
            if (field === "ctimeMs") stat.ctimeMs += 1;
            if (field === "nlink") stat.nlink += 1;
          }
        }
        return stat;
      };
      expect(() => guardedRead(fixture.source)).toThrow(
        "inspection-read-failed"
      );
      return expect(stats).toBe(2);
    }
  );
});
