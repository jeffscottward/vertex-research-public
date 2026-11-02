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
  readSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "./core.ts";
import { assertIgnored } from "./files.ts";
import {
  parseSelectionManifest,
  planReviewedSelection,
  type InspectionInput,
  type InspectionReport,
} from "./inspection.ts";

const limit = 1024 * 1024;
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const fail: (code: string) => never = (code: string): never => {
  throw new ConfigurationError(code);
};
const identity = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const snapshot = (a: Stats, b: Stats): boolean =>
  identity(a, b) &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const anchored = (descriptor: number, name: string): string =>
  `/proc/self/fd/${descriptor}/${name}`;
interface Directory {
  descriptor: number;
  stat: Stats;
  parent: Directory | null;
  name: string;
}
type ReadPolicy = "metadata" | "private" | "source";
interface FileSnapshot {
  parent: Directory;
  name: string;
  stat: Stats | null;
  content: string | null;
  policy: ReadPolicy;
  protectedBy: Directory | null;
}

// Separate from the zero-effect inspector: held anchors and snapshots live through
// publication. No pathname read, readFileSync, credential hash or reference resolver.
class ReviewedFilesystem {
  readonly directories = new Map<string, Directory>();
  readonly reads = new Map<string, FileSnapshot>();
  readonly descriptors: number[] = [];
  readonly uid = process.getuid?.();

  open(target: string, flags: number, mode?: number): number {
    return openSync(target, flags, mode);
  }

  directory(target: string, create = false): Directory {
    const absolute = resolve(target);
    const cached = this.directories.get(absolute);
    if (cached !== undefined) return cached;
    if (this.directories.size >= 512) fail("reviewed-path-limit");
    if (this.uid === undefined || process.platform !== "linux")
      fail("reviewed-filesystem-unavailable");
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    if (this.descriptors.length === 0) {
      const proc = this.open("/proc/self/fd", flags);
      this.descriptors.push(proc);
      if (statfsSync(`/proc/self/fd/${proc}`).type !== 0x9f_a0)
        fail("reviewed-filesystem-unavailable");
    }
    const parent = absolute === "/" ? null : this.directory(dirname(absolute));
    // Recursive parent acquisition can fill the cache while this frame waits.
    // Enforce the bound again before this frame creates or opens another anchor.
    if (this.directories.size >= 512) fail("reviewed-path-limit");
    const name = absolute.slice(absolute.lastIndexOf("/") + 1);
    const path = parent === null ? "/" : anchored(parent.descriptor, name);
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
        if (parent !== null) fsyncSync(parent.descriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    }
    const descriptor = this.open(path, flags);
    this.descriptors.push(descriptor);
    const stat = fstatSync(descriptor);
    // System ancestors may be root-owned. Only the root-owned sticky /tmp may
    // be writable by others; all descendants and immediate file parents are checked.
    const stickyTemporaryRoot =
      absolute === "/tmp" && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !(stat.isDirectory() && [0, this.uid].includes(stat.uid)) ||
      ((stat.mode & 0o022) !== 0 && !stickyTemporaryRoot)
    ) {
      fail("reviewed-unsafe-directory");
    }
    if (!identity(stat, lstatSync(path))) fail("reviewed-ancestor-changed");
    const directory = { descriptor, stat, parent, name };
    this.directories.set(absolute, directory);
    return directory;
  }

  assertDirectories(): void {
    for (const directory of this.directories.values()) {
      const path =
        directory.parent === null
          ? "/"
          : anchored(directory.parent.descriptor, directory.name);
      const current = lstatSync(path);
      const held = fstatSync(directory.descriptor);
      if (
        !(
          identity(current, directory.stat) && identity(held, directory.stat)
        ) ||
        current.mode !== directory.stat.mode ||
        current.uid !== directory.stat.uid ||
        current.gid !== directory.stat.gid
      ) {
        fail("reviewed-ancestor-changed");
      }
    }
  }

  sourceProtection(parent: Directory): Directory {
    let current: Directory | null = parent;
    let protectedBy: Directory | null = null;
    // A private directory elsewhere in this transaction is not proof. Walk only
    // the actual held chain for this source, checking visible and held metadata.
    while (current !== null) {
      const path =
        current.parent === null
          ? "/"
          : anchored(current.parent.descriptor, current.name);
      const visible = lstatSync(path);
      const held = fstatSync(current.descriptor);
      for (const stat of [visible, held]) {
        if (
          !identity(stat, current.stat) ||
          stat.mode !== current.stat.mode ||
          stat.uid !== current.stat.uid ||
          stat.gid !== current.stat.gid
        ) {
          fail("reviewed-ancestor-changed");
        }
      }
      if (
        protectedBy === null &&
        held.uid === this.uid &&
        (held.mode & 0o7777) === 0o700
      )
        protectedBy = current;
      current = current.parent;
    }
    if (protectedBy === null) fail("reviewed-source-not-private");
    return protectedBy;
  }

  readAt(parent: Directory, name: string, policy: ReadPolicy): FileSnapshot {
    const parentStat = fstatSync(parent.descriptor);
    if (parentStat.uid !== this.uid || (parentStat.mode & 0o022) !== 0)
      fail("reviewed-unsafe-directory");
    const protectedBy =
      policy === "source" ? this.sourceProtection(parent) : null;
    const path = anchored(parent.descriptor, name);
    let descriptor: number | undefined;
    try {
      let before: Stats;
      try {
        before = lstatSync(path);
      } catch (error) {
        if (missing(error))
          return {
            parent,
            name,
            stat: null,
            content: null,
            policy,
            protectedBy,
          };
        throw error;
      }
      descriptor = this.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const stat = fstatSync(descriptor);
      if (
        !(snapshot(before, stat) && stat.isFile()) ||
        stat.nlink !== 1 ||
        stat.size > limit ||
        stat.uid !== this.uid ||
        (stat.mode & 0o022) !== 0 ||
        (policy === "private" && (stat.mode & 0o777) !== 0o600)
      ) {
        fail("reviewed-unsafe-file");
      }
      // Recheck after opening the leaf too: a mode/identity change during that
      // open must fail before even one byte from a 0644 source is consumed.
      if (policy === "source" && this.sourceProtection(parent) !== protectedBy)
        fail("reviewed-ancestor-changed");
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          size,
          buffer.length - size,
          size
        );
        if (count === 0) break;
        size += count;
      }
      if (
        size > limit ||
        size !== stat.size ||
        !snapshot(stat, fstatSync(descriptor)) ||
        !snapshot(stat, lstatSync(path))
      ) {
        fail("reviewed-input-changed");
      }
      if (policy === "source" && this.sourceProtection(parent) !== protectedBy)
        fail("reviewed-ancestor-changed");
      const content = buffer.toString("utf8", 0, size);
      // Lossy decoding would silently rewrite untouched bytes and even backups.
      if (!Buffer.from(content, "utf8").equals(buffer.subarray(0, size)))
        fail("reviewed-invalid-encoding");
      return { parent, name, stat, content, policy, protectedBy };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  read(target: string, policy: ReadPolicy = "metadata"): string | null {
    const absolute = resolve(target);
    const parent = this.directory(dirname(absolute));
    const name = absolute.slice(absolute.lastIndexOf("/") + 1);
    const current = this.readAt(parent, name, policy);
    const previous = this.reads.get(absolute);
    if (previous !== undefined) this.assertSnapshot(previous, current);
    this.reads.set(absolute, current);
    return current.content;
  }

  assertSnapshot(expected: FileSnapshot, current: FileSnapshot): void {
    if (
      expected.policy !== current.policy ||
      expected.protectedBy !== current.protectedBy ||
      expected.content !== current.content ||
      (expected.stat === null
        ? current.stat !== null
        : current.stat === null || !snapshot(expected.stat, current.stat))
    ) {
      fail("reviewed-input-changed");
    }
  }

  verify(except?: string): void {
    this.assertDirectories();
    for (const [path, expected] of this.reads) {
      if (path !== except)
        this.assertSnapshot(
          expected,
          this.readAt(expected.parent, expected.name, expected.policy)
        );
    }
  }

  stage(directory: Directory, name: string, content: string): FileSnapshot {
    if (Buffer.byteLength(content, "utf8") > limit) fail("reviewed-size-limit");
    const path = anchored(directory.descriptor, name);
    const descriptor = this.open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const staged = this.readAt(directory, name, "private");
    if (staged.content !== content) fail("reviewed-stage-changed");
    fsyncSync(directory.descriptor);
    return staged;
  }

  close(): void {
    let failed = false;
    for (const descriptor of this.descriptors.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        failed = true;
      }
    }
    if (failed) fail("reviewed-cleanup-failed");
  }
}

export type ReviewedApplyReport = Readonly<{
  version: 1;
  mode: "reviewed-apply";
  validation: "not-performed";
  status: "applied-to-master" | "unchanged" | "blocked" | "failed";
  addedNames: readonly string[];
  retainedNames: readonly string[];
  conflictingNames: readonly string[];
  inspection?: InspectionReport;
  reason?: string;
  recoveryDirectory: string | null;
  masterState: "unchanged" | "published" | "recovery-required";
  recoveryRequired: boolean;
  serialization: "shared-target-lock";
  publication: "exclusive-create-with-recovery-gap";
  projection: "not-performed-use-explicit-project";
}>;

// Only the canonical master is in this transaction. Projection remains the
// separate explicit project command; no root env, report, enable flag or service
// is reconciled. This API's root injection is trusted test infrastructure only.
//
// NO conditional rename is available in node:fs. Never use check-then-rename OVER
// a live target. Existing files are moved into a private recovery directory and
// verified there; candidate publication uses exclusive link, which cannot clobber
// a concurrent target. This is NOT CAS: a non-cooperating same-UID writer's
// just-replaced master can itself be displaced. Unexpected identity is retained
// privately and reported as recovery-required, never success. Supported writers
// share the target lock and leave the exclusively owned recovery directory alone.
// There is a brief missing-name window (NOT atomic replacement visibility).
// Crash/failure in that window needs manual recovery; both the durable backup and
// displaced inode are retained, even on success. Writers holding an old fd can only
// modify that retained inode, never the new master. No auto-rollback/retry or
// universal same-UID adversary/multi-file atomicity guarantee is made.
export const applyReviewed = (
  root: string,
  manifestPath: string
): ReviewedApplyReport => {
  const filesystem = new ReviewedFilesystem();
  const masterPath = resolve(root, "private/configuration/.env");
  let lock: Directory | null = null;
  let lockCreated = false;
  let parent: Directory | null = null;
  let recoveryDirectory: string | null = null;
  let masterState: ReviewedApplyReport["masterState"] = "unchanged";
  let result: ReviewedApplyReport = {
    version: 1,
    mode: "reviewed-apply",
    validation: "not-performed",
    status: "failed",
    addedNames: [],
    retainedNames: [],
    conflictingNames: [],
    recoveryDirectory,
    masterState,
    recoveryRequired: false,
    serialization: "shared-target-lock",
    publication: "exclusive-create-with-recovery-gap",
    projection: "not-performed-use-explicit-project",
  };
  try {
    if (
      !manifestPath ||
      manifestPath.includes("\0") ||
      manifestPath.includes("\\") ||
      manifestPath.split("/").includes("..")
    ) {
      fail("invalid-manifest");
    }
    const selectionPath = resolve(root, manifestPath);
    const initial = filesystem.read(selectionPath);
    if (initial === null) fail("missing-manifest");
    let manifest: ReturnType<typeof parseSelectionManifest>;
    try {
      manifest = parseSelectionManifest(JSON.parse(initial));
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      fail("invalid-manifest");
    }
    // No source selection can alter these destinations. Git checks are the only
    // child processes and operate solely on ignore/tracking metadata, not values.
    assertIgnored(root, "private/configuration/.env");
    assertIgnored(
      root,
      "private/configuration/.vertex-reviewed-probe/backup.env"
    );
    filesystem.directory(join(root, "private"), true);
    parent = filesystem.directory(dirname(masterPath), true);
    if (parent.stat.uid !== filesystem.uid || (parent.stat.mode & 0o022) !== 0)
      fail("reviewed-unsafe-directory");
    filesystem.assertDirectories();
    try {
      mkdirSync(anchored(parent.descriptor, ".env.vertex-lock"), {
        mode: 0o700,
      });
      lockCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
        fail("reviewed-lock-held");
      throw error;
    }
    lock = filesystem.directory(`${masterPath}.vertex-lock`);
    if (lock.stat.uid !== filesystem.uid || (lock.stat.mode & 0o777) !== 0o700)
      fail("reviewed-unsafe-lock");
    // Re-read and plan under the same lock used by legacy atomicPrivateWrite.
    filesystem.read(selectionPath);
    const schema = filesystem.read(join(root, ".env.example"));
    if (schema === null) fail("missing-schema");
    const existing = filesystem.read(masterPath, "private");
    // Sources may be 0644 only behind their own verified private ancestor chain.
    // Manifest/schema use the existing names-only metadata policy, not mode0600.
    const sources = manifest.sources.map((selection) => ({
      repository: selection.repository,
      path: selection.path,
      content: filesystem.read(
        resolve(root, "..", selection.repository, selection.path),
        "source"
      ),
    }));
    const input: InspectionInput = { manifest, schema, existing, sources };
    const plan = planReviewedSelection(input);
    result = {
      ...result,
      inspection: plan.report,
      retainedNames: plan.retainedNames,
      conflictingNames: plan.conflictingNames,
    };
    filesystem.verify();
    if (plan.conflictingNames.length > 0) {
      result = {
        ...result,
        status: "blocked",
        reason: "reviewed-selection-conflict",
      };
    } else if (plan.addedNames.length === 0) {
      result = { ...result, status: "unchanged" };
    } else {
      const transaction = `.vertex-reviewed-${randomUUID()}`;
      // Exact destination checks, not just the probe, before staging anything.
      const recoveryPath = `private/configuration/${transaction}`;
      for (const name of ["backup.env", "previous.env", "candidate.env"]) {
        assertIgnored(root, `${recoveryPath}/${name}`);
      }
      filesystem.assertDirectories();
      mkdirSync(anchored(parent.descriptor, transaction), { mode: 0o700 });
      recoveryDirectory = recoveryPath;
      const recovery = filesystem.directory(join(root, recoveryDirectory));
      if (
        (recovery.stat.mode & 0o777) !== 0o700 ||
        recovery.stat.uid !== filesystem.uid
      )
        fail("reviewed-unsafe-directory");
      fsyncSync(parent.descriptor);
      const staged = filesystem.stage(
        recovery,
        "candidate.env",
        plan.content ?? fail("reviewed-plan-unavailable")
      );
      if (existing !== null) filesystem.stage(recovery, "backup.env", existing);
      filesystem.verify();
      filesystem.assertSnapshot(
        staged,
        filesystem.readAt(recovery, "candidate.env", "private")
      );
      const target = anchored(parent.descriptor, ".env");
      if (existing !== null) {
        const expected =
          filesystem.reads.get(masterPath) ?? fail("reviewed-master-drift");
        // The destination is inside our exclusive pinned directory and never an
        // existing file. Retain the moved entry on any failure, even if a race
        // substituted it; do not follow it or delete somebody else's data.
        try {
          lstatSync(anchored(recovery.descriptor, "previous.env"));
          fail("reviewed-recovery-collision");
        } catch (error) {
          if (!missing(error)) throw error;
        }
        renameSync(target, anchored(recovery.descriptor, "previous.env"));
        masterState = "recovery-required";
        fsyncSync(recovery.descriptor);
        fsyncSync(parent.descriptor);
        const displaced = filesystem.readAt(
          recovery,
          "previous.env",
          "private"
        );
        if (
          displaced.stat === null ||
          expected.stat === null ||
          !identity(displaced.stat, expected.stat) ||
          displaced.content !== expected.content ||
          displaced.stat.mode !== expected.stat.mode ||
          displaced.stat.mtimeMs !== expected.stat.mtimeMs
        ) {
          fail("reviewed-displaced-target-changed");
        }
      }
      // Verify sources, manifest, schema and every anchor again after displacement.
      filesystem.verify(masterPath);
      filesystem.assertSnapshot(
        staged,
        filesystem.readAt(recovery, "candidate.env", "private")
      );
      linkSync(anchored(recovery.descriptor, "candidate.env"), target);
      masterState = "published";
      // Only our own staged name is removed. Never unlink the live destination,
      // old inode, backups or any unrecognized replacement during cleanup.
      const candidate = lstatSync(
        anchored(recovery.descriptor, "candidate.env")
      );
      if (staged.stat === null || !identity(candidate, staged.stat))
        fail("reviewed-stage-changed");
      unlinkSync(anchored(recovery.descriptor, "candidate.env"));
      fsyncSync(recovery.descriptor);
      fsyncSync(parent.descriptor);
      filesystem.verify(masterPath);
      const published = filesystem.readAt(parent, ".env", "private");
      if (
        published.stat === null ||
        !identity(published.stat, staged.stat) ||
        published.content !== plan.content
      )
        fail("reviewed-published-target-changed");
      result = {
        ...result,
        status: "applied-to-master",
        addedNames: plan.addedNames,
      };
    }
  } catch (error) {
    const reason =
      error instanceof ConfigurationError
        ? error.message
        : masterState === "published"
          ? "reviewed-published-durability-unknown"
          : masterState === "recovery-required"
            ? "reviewed-recovery-required"
            : "reviewed-apply-failed";
    result = { ...result, status: "failed", reason };
  } finally {
    try {
      if (lockCreated) {
        // mkdir succeeded but no verified descriptor: never guess ownership for
        // cleanup. Retain the name and explicitly require manual lock recovery.
        if (lock === null || parent === null)
          fail("reviewed-lock-recovery-required");
        const path = anchored(parent.descriptor, ".env.vertex-lock");
        const current = lstatSync(path);
        if (!identity(current, lock.stat)) fail("reviewed-lock-changed");
        // A failed displacement must block a later writer from treating the
        // missing master as an empty bundle. Post-publication failures likewise
        // retain the lock until a human reviews durability and single-link state.
        if (result.status !== "failed" || masterState === "unchanged") {
          rmdirSync(path);
          lockCreated = false;
          // Exclude our intentionally removed lock from final anchor checks.
          filesystem.directories.delete(`${masterPath}.vertex-lock`);
          fsyncSync(parent.descriptor);
        }
      }
    } catch (error) {
      result = {
        ...result,
        status: "failed",
        reason:
          error instanceof ConfigurationError &&
          error.message === "reviewed-lock-recovery-required"
            ? error.message
            : "reviewed-cleanup-failed",
      };
    }
    try {
      filesystem.close();
    } catch {
      result = {
        ...result,
        status: "failed",
        reason: "reviewed-cleanup-failed",
      };
    }
  }
  return {
    ...result,
    recoveryDirectory,
    masterState,
    recoveryRequired:
      result.status === "failed" &&
      (masterState !== "unchanged" ||
        recoveryDirectory !== null ||
        lockCreated ||
        result.reason === "reviewed-cleanup-failed"),
  };
};
