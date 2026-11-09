// Public-repository gate (card vertex-tailnet-rotate, 2026-11-07; light lane: vertex-public-names-light-lane,
// 2026-11-09): a real tailnet DNS name leaked once through docs in git history. Every tracked file may name a
// Tailscale MagicDNS host only with a placeholder tailnet label; any other `*.ts.net` tailnet label fails.
// The CI "Changes" job runs this file directly with Node (no install) on every PR and push, so docs-only
// light-lane changes are scanned too; with a commit range it also scans every line those commits added.
//
//   node scripts/ci/public-names.ts [<base>..<head>]

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Placeholder tailnet labels (the label directly before `.ts.net`). Never add a real one. */
export const PLACEHOLDER_TAILNETS: Readonly<Record<string, true>> = {
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
    const label = (match[1] ?? "").toLowerCase();
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
export async function scanTracked(root: string): Promise<string[]> {
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
      data.length > MAX_BYTES
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

/** Offender descriptions (commit and count, never the name) for lines added by commits in `range`. */
export async function scanRange(
  root: string,
  range: string
): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}\.\.[0-9a-f]{7,64}$/i.test(range))
    throw new Error(`bad commit range: ${range}`);
  const log = await git(root, [
    "log",
    "-p",
    "--binary",
    "--no-color",
    "--format=%x00%H",
    range,
  ]);
  const offenders: string[] = [];
  for (const chunk of log.split("\0").filter(Boolean)) {
    const sha = chunk.slice(
      0,
      chunk.indexOf("\n") === -1 ? undefined : chunk.indexOf("\n")
    );
    const added = chunk
      .split("\n")
      .filter(
        (line) =>
          (line.startsWith("+") && !line.startsWith("+++ ")) ||
          line.startsWith("diff --git ")
      )
      .join("\n");
    const count = realTailnetLabels(added).length;
    if (count > 0) offenders.push(`commit ${sha.slice(0, 12)} (${count})`);
  }
  return offenders;
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const range = process.argv[2];
  const offenders = [
    ...(await scanTracked(root)),
    ...(range ? await scanRange(root, range) : []),
  ];
  if (offenders.length > 0) {
    console.error(
      `public-names: real tailnet names found (names withheld):\n${offenders.join("\n")}`
    );
    process.exit(1);
  }
  console.log(
    `public-names: clean (tracked files${range ? ` and commits ${range}` : ""})`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main();
