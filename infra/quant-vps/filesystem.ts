import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { releaseFailure, type ReleaseManifest } from "./contract.ts";
import { sha256 } from "./authority.ts";

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
};

export const assertSafeParents = async (
  path: string,
  state?: Readonly<{ path: string; uid: number }>
): Promise<void> => {
  let parent = posix.dirname(path);
  while (true) {
    const stat = await lstat(parent);
    const owner =
      state && (parent === state.path || parent.startsWith(`${state.path}/`))
        ? state.uid
        : 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== owner ||
      (stat.mode & 0o022) !== 0
    )
      releaseFailure("unsafe-parent");
    if (parent === "/") break;
    parent = posix.dirname(parent);
  }
};

export const readSafeFile = async (
  path: string,
  maximum: number,
  uid = 0,
  state?: Readonly<{ path: string; uid: number }>
): Promise<Buffer> => {
  await assertSafeParents(path, state);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      before.size > maximum
    )
      releaseFailure("unsafe-file");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length > maximum ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      releaseFailure("file-drift");
    return bytes;
  } finally {
    await file.close();
  }
};

export const fingerprintFile = async (
  path: string,
  uid: number,
  state?: Readonly<{ path: string; uid: number }>
): Promise<string> => {
  await assertSafeParents(path, state);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      before.size > 16_000_000_000
    )
      releaseFailure("unsafe-journal");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(1_048_576);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 16_000_000_000) releaseFailure("journal-size");
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== after.size
    )
      releaseFailure("journal-drift");
    return `${before.dev}:${before.ino}:${before.size}:${digest.digest("hex")}`;
  } finally {
    await file.close();
  }
};

export const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export const atomicWrite = async (
  path: string,
  bytes: Uint8Array,
  requestId: string,
  mode = 0o600,
  owner?: Readonly<{ uid: number; gid: number }>,
  state?: Readonly<{ path: string; uid: number }>
): Promise<void> => {
  await assertSafeParents(path, state);
  if (await pathExists(path)) {
    const previous = await lstat(path);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)
      releaseFailure("write-target");
  }
  const temporary = `${path}.${requestId}.pending`;
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode
  );
  try {
    if (owner) await file.chown(owner.uid, owner.gid);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  // A failed transaction leaves its uniquely named evidence; never clobber or
  // clean up an unknown previous attempt, or unlink any journal/owner/WAL file.
  await rename(temporary, path);
  await syncDirectory(posix.dirname(path));
};

export const assertSealedRelease = async (
  root: string,
  manifest: ReleaseManifest,
  expectedManifestSha256: string
): Promise<void> => {
  await assertSafeParents(`${root}/release-manifest.json`);
  const manifestBytes = await readSafeFile(
    `${root}/release-manifest.json`,
    16_777_216
  );
  if (sha256(manifestBytes) !== expectedManifestSha256)
    releaseFailure("installed-manifest");
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const observed = new Set<string>();
  const directories = new Set(manifest.directories);
  const observedDirectories = new Set<string>();
  let count = 0;
  const walk = async (
    directory: string,
    relative: string,
    depth: number
  ): Promise<void> => {
    if (depth > 32) releaseFailure("release-depth");
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o222) !== 0
    )
      releaseFailure("mutable-artifact-directory");
    for (const name of await readdir(directory)) {
      if (++count > 100_000) releaseFailure("release-entries");
      const path = relative ? `${relative}/${name}` : name;
      const absolute = posix.join(directory, name);
      const entry = await lstat(absolute);
      if (entry.isDirectory()) {
        if (!directories.has(path)) releaseFailure("unexpected-directory");
        observedDirectories.add(path);
        await walk(absolute, path, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.uid !== 0 ||
        entry.nlink !== 1
      )
        releaseFailure("artifact-kind");
      if (path === "release-manifest.json") {
        if ((entry.mode & 0o7777) !== 0o444) releaseFailure("mutable-manifest");
        continue;
      }
      const file = expected.get(path);
      if (
        !file ||
        entry.size !== file.size ||
        (entry.mode & 0o7777) !== Number.parseInt(file.mode, 8)
      )
        releaseFailure("artifact-inventory");
      const digest = await fingerprintFile(absolute, 0);
      if (digest.split(":").at(-1) !== file.sha256)
        releaseFailure("artifact-digest");
      observed.add(path);
    }
  };
  await walk(root, "", 0);
  if (observed.size !== expected.size) releaseFailure("artifact-missing");
  if (observedDirectories.size !== directories.size)
    releaseFailure("directory-missing");
};

export const exclusiveFileLock = async <T>(
  path: string,
  work: () => Promise<T>
): Promise<T> => {
  await assertSafeParents(path);
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  const own = await file.stat();
  try {
    await file.sync();
    await syncDirectory(posix.dirname(path));
    return await work();
  } finally {
    await file.close();
    const current = await lstat(path);
    if (current.dev !== own.dev || current.ino !== own.ino)
      releaseFailure("lock-replaced");
    await unlink(path);
    await syncDirectory(posix.dirname(path));
  }
};
