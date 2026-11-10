// Public-repository gate (card vertex-tailnet-rotate, 2026-11-07; light lane: vertex-public-names-light-lane,
// 2026-11-09): a real tailnet DNS name leaked once through docs in git history. Every tracked file may name a
// Tailscale MagicDNS host only with a placeholder tailnet label; any other `*.ts.net` tailnet label fails.
// The CI "Changes" job runs scripts/public-names.ts (the CLI over this module) with plain Node on every PR and
// push, so docs-only light-lane changes are scanned too; on a PR it also scans everything the PR's commits
// publish. This detects leaks after a push; it cannot stop one, and commits replaced by a force-push before
// their run finished are not rescanned.

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Placeholder tailnet labels (the label directly before `.ts.net`). Never add a real one. */
const PLACEHOLDER_TAILNETS: Readonly<Record<string, true>> = {
  example: true,
  "example-tailnet": true,
  h: true,
  tail1: true,
  tail000000: true,
  tailnet: true,
};

// The tailnet label is the DNS label right before `.ts.net`; `\.` escapes (regex sources) count as dots.
const NAME = /(?<![a-z0-9-])([a-z0-9-]+)\\?\.ts\\?\.net(?![a-z0-9-])/gi;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Every `*.ts.net` tailnet label in `text` that is not a placeholder. */
export function realTailnetLabels(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(NAME)) {
    const label = String(match[1]).toLowerCase();
    if (!Object.hasOwn(PLACEHOLDER_TAILNETS, label)) hits.push(label);
  }
  return hits;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "latin1",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Offender descriptions (file and count, never the name) for tracked files in the working tree. */
export async function scanTracked(
  root: string,
  maxBytes = MAX_BYTES
): Promise<string[]> {
  // `-s` shows the mode: submodules (gitlinks, mode 160000) are directories, not files to scan.
  const entries = (await git(root, ["ls-files", "-z", "-s"]))
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("160000 "));
  const offenders: string[] = [];
  for (const entry of entries) {
    const file = Buffer.from(
      entry.slice(entry.indexOf("\t") + 1),
      "latin1"
    ).toString("utf8");
    const link = entry.startsWith("120000 ");
    const inPath = realTailnetLabels(file).length;
    let data: Buffer;
    try {
      // A tracked symlink stores only its target path; scan that text, never follow it.
      data = link
        ? Buffer.from(await readlink(`${root}${file}`))
        : await readFile(`${root}${file}`);
    } catch (error) {
      // Deleted in the working tree: nothing to scan. Anything else (EACCES, EISDIR) must not hide a file.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Too large to scan is a failure, not a pass. latin1 keeps every byte (binaries); dropping NUL bytes
    // makes UTF-16 text readable as well.
    const inText =
      data.length > maxBytes
        ? 1
        : realTailnetLabels(data.toString("latin1").replaceAll("\0", ""))
            .length;
    if (inPath + inText > 0)
      offenders.push(
        `file #${offenders.length + 1} (${inPath + inText})${inPath ? "" : `: ${file}`}`
      );
  }
  return offenders;
}

/**
 * Offender descriptions (commit or object, and count; never the name) for everything the commits in
 * `base..head` publish: their messages, the paths they add and the full content of every new blob. Blobs are
 * read whole (not as diffs), so binary, UTF-16, `-diff` and merge-introduced content is scanned too.
 */
export async function scanRange(
  root: string,
  range: string,
  maxBytes = MAX_BYTES
): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}\.\.[0-9a-f]{7,64}$/i.test(range))
    throw new Error(`bad commit range: ${range}`);
  const offenders: string[] = [];
  const messages = await git(root, ["log", "--format=%x00%H%n%B", range]);
  for (const chunk of messages.split("\0").slice(1)) {
    // Git refuses NUL bytes in commit messages, so each chunk starts with the hash.
    const sha = chunk.slice(0, chunk.indexOf("\n"));
    const count = realTailnetLabels(chunk.slice(sha.length)).length;
    if (count > 0)
      offenders.push(`commit message ${sha.slice(0, 12)} (${count})`);
  }
  // `rev-list --objects` lists every commit, tree and blob reachable from head but not base, with its path.
  const listed = await git(root, [
    "-c",
    "core.quotePath=false",
    "rev-list",
    "--objects",
    range,
  ]);
  for (const line of listed.split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    const sha = space < 0 ? line : line.slice(0, space);
    const inPath = realTailnetLabels(line.slice(sha.length)).length;
    if (inPath > 0)
      offenders.push(`path of object ${sha.slice(0, 12)} (${inPath})`);
    if ((await git(root, ["cat-file", "-t", sha])).trim() !== "blob") continue;
    const size = Number((await git(root, ["cat-file", "-s", sha])).trim());
    const inText =
      size > maxBytes
        ? 1
        : realTailnetLabels(
            (await git(root, ["cat-file", "blob", sha])).replaceAll("\0", "")
          ).length;
    if (inText > 0) offenders.push(`blob ${sha.slice(0, 12)} (${inText})`);
  }
  return offenders;
}

/** Tracked-file offenders plus, when `range` is set, offenders in that commit range. */
export async function scanAll(root: string, range?: string): Promise<string[]> {
  return [
    ...(await scanTracked(root)),
    ...(range ? await scanRange(root, range) : []),
  ];
}

interface CliIo {
  root: string;
  stderr: { write: (text: string) => unknown };
  stdout: { write: (text: string) => unknown };
}

/** CLI (`node scripts/public-names.ts [<base-sha>..<head-sha>]`): exit code 1 when anything leaks. */
export async function runPublicNamesCli(
  argv: string[],
  io: CliIo
): Promise<number> {
  const range = argv[0] || undefined;
  const offenders = await scanAll(io.root, range);
  if (offenders.length > 0) {
    io.stderr.write(
      `public-names: real tailnet names found (names withheld):\n${offenders.join("\n")}\n`
    );
    return 1;
  }
  io.stdout.write(
    `public-names: clean (tracked files${range ? ` and commits ${range}` : ""})\n`
  );
  return 0;
}
