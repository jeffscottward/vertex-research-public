import {
  chmodSync,
  closeSync,
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertIgnored,
  atomicPrivateWrite,
  ensurePrivateDirectory,
  readCanonicalSources,
  readRegular,
} from "./files.ts";

const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  fsyncSync: vi.fn(),
  unlinkSync: vi.fn(),
  closeSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  lstatSync: filesystem.lstatSync,
  openSync: filesystem.openSync,
  fsyncSync: filesystem.fsyncSync,
  unlinkSync: filesystem.unlinkSync,
  closeSync: filesystem.closeSync,
}));
vi.mock("node:child_process", () => ({ spawnSync: filesystem.spawnSync }));

beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const child =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  filesystem.lstatSync.mockReset().mockImplementation(original.lstatSync);
  filesystem.openSync.mockReset().mockImplementation(original.openSync);
  filesystem.fsyncSync.mockReset().mockImplementation(original.fsyncSync);
  filesystem.unlinkSync.mockReset().mockImplementation(original.unlinkSync);
  filesystem.closeSync.mockReset().mockImplementation(original.closeSync);
  filesystem.spawnSync.mockReset().mockImplementation(child.spawnSync);
  return;
});

const directories: string[] = [];
const filenames = [".env", ".env.schema", ".env.example"];
const repositories = [
  "gamma-forge",
  "vertex-quant",
  "vertex-research",
  "full-port",
  "darkfactory",
];
const layout = () => {
  const base = mkdtempSync(join(tmpdir(), "vertex-canonical-sources-test-"));
  directories.push(base);
  const root = join(base, "trading", "vertex-research-platform");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = Object.fromEntries(
    repositories.map((name) => [
      name,
      join(base, name === "darkfactory" ? "tools" : "trading", name),
    ])
  );
  for (const directory of Object.values(paths)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return { base, root, paths };
};

const labels = (repository: string) =>
  filenames.map((filename) => `${repository}/${filename}`);

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  return;
});

describe("canonical read-only source inventory", () => {
  it("reads every existing canonical input without changing bytes, identities, or modes", () => {
    const { root, paths } = layout();
    for (const path of Object.values(paths)) {
      for (const filename of filenames) {
        writeFileSync(
          join(path, filename),
          "QUANTDATA_API_KEY=fixture-only\n",
          { mode: 0o600 }
        );
      }
    }
    const target = join(paths["vertex-quant"]!, ".env");
    const before = lstatSync(target);
    const result = readCanonicalSources(root);
    expect(result.missing).toEqual([]);
    expect(result.sources.map(({ label }) => label)).toEqual(
      repositories.flatMap(labels)
    );
    expect(
      result.sources.every(
        ({ content }) => content === "QUANTDATA_API_KEY=fixture-only\n"
      )
    ).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(
      "QUANTDATA_API_KEY=fixture-only\n"
    );
    return expect(lstatSync(target)).toMatchObject({
      ino: before.ino,
      mode: before.mode,
      uid: before.uid,
    });
  });

  it("reports all filenames for an absent repository while retaining available sources", () => {
    const { root, paths } = layout();
    rmSync(paths["gamma-forge"]!, { recursive: true });
    writeFileSync(
      join(paths["vertex-quant"]!, ".env"),
      "QUANTDATA_API_KEY=fixture-only\n"
    );
    const result = readCanonicalSources(root);
    expect(result.sources).toEqual([
      {
        label: "vertex-quant/.env",
        content: "QUANTDATA_API_KEY=fixture-only\n",
      },
    ]);
    expect(result.missing).toEqual(
      repositories
        .flatMap(labels)
        .filter((label) => label !== "vertex-quant/.env")
    );
    return expect(result.missing).toEqual(
      expect.arrayContaining(labels("gamma-forge"))
    );
  });

  it("reports a genuinely absent multi-level tools directory without aborting the inventory", () => {
    const { base, root } = layout();
    rmSync(join(base, "tools"), { recursive: true });
    return expect(readCanonicalSources(root)).toEqual({
      sources: [],
      missing: repositories.flatMap(labels),
    });
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])(
    "does not misclassify %s filesystem errors as absent repositories",
    (code) => {
      const { root } = layout();
      const failure = Object.assign(
        new Error("fixture-private-filesystem-detail"),
        { code }
      );
      filesystem.lstatSync.mockImplementationOnce(() => {
        throw failure;
      });
      return expect(() => readCanonicalSources(root)).toThrow(failure);
    }
  );

  it("fails closed if filesystem inspection cannot even establish the root directory", async () => {
    const { root } = layout();
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    const failure = Object.assign(
      new Error("fixture-missing-filesystem-root"),
      { code: "ENOENT" }
    );
    filesystem.lstatSync.mockImplementation(
      (target: Parameters<typeof lstatSync>[0]) => {
        if (target === parse(root).root) throw failure;
        return original.lstatSync(target);
      }
    );
    try {
      return expect(() => readCanonicalSources(root)).toThrow(failure);
    } finally {
      filesystem.lstatSync.mockImplementation(original.lstatSync);
    }
  });

  it("does not enable missing-directory tolerance for private publication", () => {
    const { root } = layout();
    return expect(() =>
      atomicPrivateWrite(join(root, "absent", ".env"), "fixture-only", null)
    ).toThrow();
  });

  it("refuses a source directory owned by a different user", () => {
    const { root, paths } = layout();
    const stat = lstatSync(paths["gamma-forge"]!);
    Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
    filesystem.lstatSync.mockReturnValueOnce(stat);
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });

  it("refuses insecure source directories even when their input files are missing", () => {
    const { root, paths } = layout();
    chmodSync(paths["gamma-forge"]!, 0o777);
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });

  it("refuses insecure existing ancestors of missing repositories", () => {
    const { base, root } = layout();
    rmSync(join(base, "tools", "darkfactory"), { recursive: true });
    chmodSync(join(base, "tools"), 0o777);
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });

  it("refuses a regular file in place of a repository", () => {
    const { root, paths } = layout();
    const target = paths["gamma-forge"]!;
    rmSync(target, { recursive: true });
    writeFileSync(target, "fixture-only");
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });

  it.each([false, true])(
    "refuses repository symlinks even when dangling: %s",
    (dangling) => {
      const { base, root, paths } = layout();
      const target = paths["gamma-forge"]!;
      rmSync(target, { recursive: true });
      symlinkSync(
        dangling ? join(base, "absent") : paths["vertex-quant"]!,
        target
      );
      return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
    }
  );

  it("refuses a symlink ancestor even when the descendant repository is absent", () => {
    const { base, root, paths } = layout();
    rmSync(join(base, "tools"), { recursive: true });
    symlinkSync(paths["vertex-quant"]!, join(base, "tools"));
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });

  return it("refuses source-file symlinks rather than reporting their targets absent", () => {
    const { base, root, paths } = layout();
    symlinkSync(join(base, "absent"), join(paths["gamma-forge"]!, ".env"));
    return expect(() => readCanonicalSources(root)).toThrow("unsafe-path");
  });
});

describe("private file read boundary", () => {
  it("redacts operating-system read errors rather than returning absence", () => {
    const { root } = layout();
    filesystem.lstatSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture-private-path"), {
        code: "EACCES",
      });
    });
    return expect(() => readRegular(join(root, ".env"))).toThrow("read-failed");
  });

  it("detects a target replaced between inspection and opening and closes its descriptor", async () => {
    const { root } = layout();
    const target = join(root, ".env");
    const replacement = join(root, "replacement");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    writeFileSync(replacement, "fixture-replacement", { mode: 0o600 });
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    filesystem.openSync.mockImplementationOnce((path, flags) => {
      renameSync(replacement, target);
      return original.openSync(path, flags);
    });
    expect(() => readRegular(target, true)).toThrow("target-changed");
    expect(filesystem.closeSync).toHaveBeenCalledTimes(1);
    return expect(readFileSync(target, "utf8")).toBe("fixture-replacement");
  });

  it("rejects a device change even when an inode number is reused", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    const stat = lstatSync(target);
    Object.defineProperty(stat, "dev", { value: stat.dev + 1 });
    filesystem.lstatSync.mockReturnValueOnce(stat);
    expect(() => readRegular(target, true)).toThrow("target-changed");
    expect(filesystem.closeSync).toHaveBeenCalledTimes(1);
    return expect(readFileSync(target, "utf8")).toBe("fixture-original");
  });

  it("rejects hardlinked and oversized input without opening or modifying it", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    linkSync(target, join(root, "alias"));
    expect(() => readRegular(target)).toThrow("unsafe-path");
    const oversized = join(root, "oversized");
    writeFileSync(oversized, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(() => readRegular(oversized)).toThrow("unsafe-path");
    expect(filesystem.openSync).not.toHaveBeenCalled();
    return expect(readFileSync(target, "utf8")).toBe("fixture-original");
  });

  return it("requires private files to belong to the current user as well as having mode 0600", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    const stat = lstatSync(target);
    Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
    filesystem.lstatSync.mockReturnValueOnce(stat);
    expect(() => readRegular(target, true)).toThrow("unsafe-path");
    return expect(filesystem.openSync).not.toHaveBeenCalled();
  });
});

describe("atomic publication and cleanup failures", () => {
  it("detects changes after temporary-file preparation without overwriting the concurrent writer", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    expect(() =>
      atomicPrivateWrite(target, "fixture-planned", "fixture-original", () => {
        return writeFileSync(target, "fixture-concurrent", { mode: 0o600 });
      })
    ).toThrow("target-changed");
    expect(readFileSync(target, "utf8")).toBe("fixture-concurrent");
    return expect(readdirSync(root)).toEqual([".env"]);
  });

  it("does not steal another writer's lock or leave a temporary file", () => {
    const { root } = layout();
    const target = join(root, ".env");
    mkdirSync(`${target}.vertex-lock`, { mode: 0o700 });
    expect(() => atomicPrivateWrite(target, "fixture-planned", null)).toThrow(
      "write-failed"
    );
    expect(existsSync(target)).toBe(false);
    return expect(readdirSync(root)).toEqual([".env.vertex-lock"]);
  });

  it("closes and removes an unpublished temporary file if its fsync fails", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    filesystem.fsyncSync.mockImplementationOnce(() => {
      throw new Error("fixture-sensitive-storage-error");
    });
    expect(() =>
      atomicPrivateWrite(target, "fixture-planned", "fixture-original")
    ).toThrow("write-failed");
    expect(readFileSync(target, "utf8")).toBe("fixture-original");
    expect(readdirSync(root)).toEqual([".env"]);
    const temporaryOpen = filesystem.openSync.mock.calls.find(
      ([path]) => typeof path === "string" && path.endsWith(".tmp")
    );
    const temporaryIndex = filesystem.openSync.mock.calls.indexOf(
      temporaryOpen!
    );
    const descriptor = filesystem.openSync.mock.results[temporaryIndex]!
      .value as number;
    expect(filesystem.closeSync).toHaveBeenCalledWith(descriptor);
    return expect(() => closeSync(descriptor)).toThrow();
  });

  it.each([null, "fixture-original"])(
    "reports unknown durability after publication rather than promising rollback: %s",
    async (expected) => {
      const { root } = layout();
      const target = join(root, ".env");
      if (expected !== null) writeFileSync(target, expected, { mode: 0o600 });
      const original =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      filesystem.fsyncSync
        .mockImplementationOnce(original.fsyncSync)
        .mockImplementationOnce(() => {
          throw new Error("fixture-directory-fsync-detail");
        });
      expect(() =>
        atomicPrivateWrite(target, "fixture-published", expected)
      ).toThrow("published-durability-unknown");
      expect(readFileSync(target, "utf8")).toBe("fixture-published");
      expect(lstatSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(root)).toEqual([".env"]);
      const directoryIndex = filesystem.openSync.mock.calls.findIndex(
        ([path]) => path === root
      );
      return expect(filesystem.closeSync).toHaveBeenCalledWith(
        filesystem.openSync.mock.results[directoryIndex]!.value
      );
    }
  );

  return it("reports cleanup failure without altering the old target or pretending the lock is released", () => {
    const { root } = layout();
    const target = join(root, ".env");
    writeFileSync(target, "fixture-original", { mode: 0o600 });
    filesystem.unlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture-sensitive-cleanup-detail"), {
        code: "EACCES",
      });
    });
    expect(() =>
      atomicPrivateWrite(target, "fixture-planned", "fixture-original", () => {
        throw new Error("fixture-before-publication");
      })
    ).toThrow("cleanup-failed");
    expect(readFileSync(target, "utf8")).toBe("fixture-original");
    expect(existsSync(`${target}.vertex-lock`)).toBe(true);
    const temporary = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(temporary).toHaveLength(1);
    return expect(lstatSync(join(root, temporary[0]!)).mode & 0o777).toBe(
      0o600
    );
  });
});

describe("private destination directories", () => {
  it("creates owner-only directories and safely reuses them without changing existing content", () => {
    const { root } = layout();
    const directory = ensurePrivateDirectory(root);
    expect(directory).toBe(join(root, "private", "configuration"));
    writeFileSync(join(directory, "sentinel"), "fixture-only", { mode: 0o600 });
    const before = lstatSync(directory);
    expect(ensurePrivateDirectory(root)).toBe(directory);
    expect(lstatSync(directory).ino).toBe(before.ino);
    expect(readFileSync(join(directory, "sentinel"), "utf8")).toBe(
      "fixture-only"
    );
    expect(lstatSync(join(root, "private")).mode & 0o777).toBe(0o700);
    return expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it("redacts directory-creation failures", () => {
    const { root } = layout();
    expect(() => ensurePrivateDirectory(join(root, "missing"))).toThrow(
      "directory-failed"
    );
    return expect(existsSync(join(root, "missing"))).toBe(false);
  });

  return it("rejects unsafe existing private directories without creating descendants", () => {
    const { root } = layout();
    mkdirSync(join(root, "private"), { mode: 0o777 });
    chmodSync(join(root, "private"), 0o777);
    expect(() => ensurePrivateDirectory(root)).toThrow("unsafe-path");
    return expect(existsSync(join(root, "private", "configuration"))).toBe(
      false
    );
  });
});

describe("Git privacy boundary", () => {
  it("requires both ignored and untracked destinations in an actual synthetic repository", () => {
    const { root } = layout();
    expect(
      filesystem.spawnSync("git", ["init", "--quiet", root], { stdio: "pipe" })
        .status
    ).toBe(0);
    writeFileSync(join(root, ".gitignore"), "private/\n");
    expect(() =>
      assertIgnored(root, "private/configuration/.env")
    ).not.toThrow();
    return expect(() => assertIgnored(root, "public.env")).toThrow(
      "destination-not-private"
    );
  });

  return it("rejects a destination staged between the ignore and tracking checks", async () => {
    const { root } = layout();
    const child =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process"
      );
    expect(
      child.spawnSync("git", ["init", "--quiet", root], { stdio: "pipe" })
        .status
    ).toBe(0);
    writeFileSync(join(root, ".gitignore"), ".env\n");
    writeFileSync(join(root, ".env"), "fixture-only", { mode: 0o600 });
    filesystem.spawnSync.mockImplementation((command, args, options) => {
      if (args[0] === "ls-files") {
        expect(
          child.spawnSync("git", ["add", "--force", "--", ".env"], {
            cwd: root,
            stdio: "pipe",
          }).status
        ).toBe(0);
      }
      return child.spawnSync(command, args, options);
    });
    expect(() => assertIgnored(root, ".env")).toThrow(
      "destination-not-private"
    );
    return expect(readFileSync(join(root, ".env"), "utf8")).toBe(
      "fixture-only"
    );
  });
});
