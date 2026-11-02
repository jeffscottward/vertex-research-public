import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ConfigurationError,
  project,
  serialize,
  type Projection,
  type Source,
  type Values,
} from "./core.ts";
import {
  parseSelectionManifest,
  type InspectionInput,
  type InspectionSource,
} from "./inspection.ts";

const absent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

const checkParents = (target: string, allowMissing = false): boolean => {
  let parent = dirname(resolve(target));
  let firstExisting = true;
  let missing = false;
  while (true) {
    let stat: Stats;
    try {
      stat = lstatSync(parent);
    } catch (error) {
      if (!(allowMissing && absent(error)) || parent === parse(parent).root)
        throw error;
      missing = true;
      parent = dirname(parent);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ConfigurationError("unsafe-path");
    if (
      firstExisting &&
      ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())
    ) {
      throw new ConfigurationError("unsafe-path");
    }
    firstExisting = false;
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
  return !missing;
};

export const readRegular = (
  target: string,
  privateFile = false
): string | null => {
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 1024 * 1024
    ) {
      throw new ConfigurationError("unsafe-path");
    }
    if (
      privateFile &&
      ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
    ) {
      throw new ConfigurationError("unsafe-path");
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new ConfigurationError("target-changed");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (absent(error)) return null;
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("read-failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

// The exclusive lock serializes this tool; expected content prevents stale plans.
// A same-directory, fsynced 0600 temporary file is linked/renamed only when complete.

// Cleanup for an attempted private write. A leftover temporary that cannot be
// removed fails closed and keeps the lock directory for manual review.
const releaseWrite = (
  descriptor: number | undefined,
  temporary: string,
  lock: string | null
): void => {
  if (descriptor !== undefined) closeSync(descriptor);
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (!absent(error)) throw new ConfigurationError("cleanup-failed");
  }
  if (lock !== null) rmdirSync(lock);
};
export const atomicPrivateWrite = (
  target: string,
  content: string,
  expected: string | null,
  beforePublish: () => void = () => undefined
): void => {
  const destination = resolve(target);
  checkParents(destination);
  const lock = `${destination}.vertex-lock`;
  const temporary = join(
    dirname(destination),
    `.vertex-config-${randomUUID()}.tmp`
  );
  let locked = false;
  let descriptor: number | undefined;
  let published = false;
  try {
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
    if (readRegular(destination, true) !== expected)
      throw new ConfigurationError("target-changed");
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforePublish();
    if (readRegular(destination, true) !== expected)
      throw new ConfigurationError("target-changed");
    if (expected === null) {
      linkSync(temporary, destination);
      published = true;
      unlinkSync(temporary);
    } else {
      renameSync(temporary, destination);
      published = true;
    }
    const directory = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (published) throw new ConfigurationError("published-durability-unknown");
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("write-failed");
  } finally {
    releaseWrite(descriptor, temporary, locked ? lock : null);
  }
};

export const assertIgnored = (root: string, relativePath: string): void => {
  const ignored = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", relativePath],
    { cwd: root, stdio: "pipe" }
  );
  const tracked = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", relativePath],
    { cwd: root, stdio: "pipe" }
  );
  if (ignored.status !== 0 || tracked.status !== 1) {
    throw new ConfigurationError("destination-not-private");
  }
};

export const ensurePrivateDirectory = (root: string): string => {
  const privateRoot = join(root, "private");
  const configuration = join(privateRoot, "configuration");
  for (const path of [privateRoot, configuration]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST")
        throw new ConfigurationError("directory-failed");
    }
    checkParents(join(path, ".env"));
  }
  return configuration;
};

export const readCanonicalSources = (
  root: string
): { sources: Source[]; missing: string[] } => {
  const sources: Source[] = [];
  const missing: string[] = [];
  for (const repository of [
    "gamma-forge",
    "vertex-quant",
    "vertex-research",
    "full-port",
    "darkfactory",
  ]) {
    const directory =
      repository === "darkfactory"
        ? resolve(root, "../../tools/darkfactory")
        : resolve(root, "..", repository);
    // Missing descendants do not excuse a symlink or unsafe existing ancestor.
    const available = checkParents(join(directory, ".env"), true);
    for (const filename of [".env", ".env.schema", ".env.example"]) {
      const label = `${repository}/${filename}`;
      const content = available ? readRegular(join(directory, filename)) : null;
      if (content === null) {
        missing.push(label);
      } else sources.push({ label, content });
    }
  }
  return { sources, missing };
};

// Linux procfs provides openat-style anchors without resolving any user-controlled
// ancestor twice. Each component is opened relative to an already-held directory
// descriptor with NOFOLLOW; renamed/replaced ancestors cannot redirect later reads.
export const readInspectionRegular = (
  target: string,
  privateFile = false
): string | null => {
  const descriptors: number[] = [];
  const uid = process.getuid?.();
  const remember = (descriptor: number): number => {
    descriptors.push(descriptor);
    return descriptor;
  };
  const safeParent = (descriptor: number): void => {
    const stat = fstatSync(descriptor);
    if ((stat.mode & 0o022) !== 0 || stat.uid !== uid) {
      throw new ConfigurationError("inspection-read-failed");
    }
  };
  const openChild = (
    parent: number,
    name: string,
    flags: number
  ): number | null => {
    try {
      return remember(openSync(`/proc/self/fd/${parent}/${name}`, flags));
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  };
  try {
    if (process.platform !== "linux" || uid === undefined)
      throw new ConfigurationError("inspection-read-failed");
    const directoryFlags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const proc = remember(openSync("/proc/self/fd", directoryFlags));
    if (statfsSync(`/proc/self/fd/${proc}`).type !== 0x9f_a0)
      throw new ConfigurationError("inspection-read-failed");
    let parent = remember(openSync("/", directoryFlags));
    const parts = resolve(target).split("/").filter(Boolean);
    const filename = parts.pop();
    if (filename === undefined)
      throw new ConfigurationError("inspection-read-failed");
    for (const part of parts) {
      const next = openChild(parent, part, directoryFlags);
      if (next === null) {
        safeParent(parent);
        return null;
      }
      parent = next;
    }
    safeParent(parent);
    const descriptor = openChild(
      parent,
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    if (descriptor === null) return null;
    const stat = fstatSync(descriptor);
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) {
      throw new ConfigurationError("inspection-read-failed");
    }
    if (privateFile && ((stat.mode & 0o777) !== 0o600 || stat.uid !== uid)) {
      throw new ConfigurationError("inspection-read-failed");
    }
    // Never let a concurrent writer grow an initially small file into an
    // unbounded read. Reject changed snapshots rather than planning partial data.
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        null
      );
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(descriptor);
    if (
      size > limit ||
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1
    ) {
      throw new ConfigurationError("inspection-read-failed");
    }
    return buffer.toString("utf8", 0, size);
  } catch {
    throw new ConfigurationError("inspection-read-failed");
  } finally {
    for (const descriptor of descriptors.reverse()) {
      closeSync(descriptor);
    }
  }
};

// Read-only path: never creates the private directory, locks, receipts or defaults.
export const collectInspection = (
  root: string,
  manifestPath: string
): InspectionInput => {
  const readChecked = readInspectionRegular;
  if (
    !manifestPath ||
    manifestPath.includes("\0") ||
    manifestPath.includes("\\") ||
    manifestPath.split("/").includes("..")
  ) {
    throw new ConfigurationError("invalid-manifest");
  }
  const text = readChecked(resolve(root, manifestPath));
  if (text === null) throw new ConfigurationError("missing-manifest");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigurationError("invalid-manifest");
  }
  // Validate every selection before opening any credential-bearing source.
  const manifest = parseSelectionManifest(value);
  const schema = readChecked(join(root, ".env.example"));
  if (schema === null) throw new ConfigurationError("missing-schema");
  const existing = readChecked(join(root, "private/configuration/.env"), true);
  const sources: InspectionSource[] = manifest.sources.map((source) => ({
    repository: source.repository,
    path: source.path,
    content: readChecked(resolve(root, "..", source.repository, source.path)),
  }));
  return { manifest, schema, existing, sources };
};

export const writeProjection = (
  target: string,
  bundle: Values,
  selection: Projection
): void => {
  const content = serialize(project(bundle, selection));
  atomicPrivateWrite(target, content, null);
};
