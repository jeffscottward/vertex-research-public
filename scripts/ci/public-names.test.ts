import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";

// Public-repository gate (card vertex-tailnet-rotate, 2026-11-07): a real tailnet DNS name leaked once
// through docs in git history. Every tracked file may name a Tailscale MagicDNS host only with a
// placeholder tailnet label; any other `*.ts.net` tailnet label fails this test.

const root = fileURLToPath(new URL("../../", import.meta.url));
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

/** Every `*.ts.net` tailnet label in `text` that is not a placeholder. */
function realTailnetLabels(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(NAME)) {
    const label = (match[1] ?? "").toLowerCase();
    if (!Object.hasOwn(PLACEHOLDER_TAILNETS, label)) hits.push(label);
  }
  return hits;
}

async function trackedFiles(): Promise<Array<{ file: string; link: boolean }>> {
  // `-s` shows the mode: submodules (gitlinks, mode 160000) are directories, not files to scan.
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "-s"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("160000 "))
    .map((entry) => ({
      file: entry.slice(entry.indexOf("\t") + 1),
      link: entry.startsWith("120000 "),
    }));
}

describe("public tailnet names", () => {
  it("recognises real and placeholder tailnet labels", () => {
    expect(realTailnetLabels("https://rig.tail000000.ts.net:8443/x")).toEqual(
      []
    );
    expect(
      realTailnetLabels("demo.example-tailnet.ts.net and h.ts.net")
    ).toEqual([]);
    // Non-placeholder examples are joined at run time so this file passes its own scan.
    const real = ["tail9f3a21", "cat-crocodile"];
    expect(realTailnetLabels(`https://box.${real[0]}.ts.net`)).toEqual([
      real[0],
    ]);
    expect(realTailnetLabels(`vps.${real[1]}.ts.net`)).toEqual([real[1]]);
    // Regex-escaped names and names after `.`, `*` or `_` are still names.
    expect(realTailnetLabels(`omarchy-rig\\.${real[0]}\\.ts\\.net`)).toEqual([
      real[0],
    ]);
    expect(
      realTailnetLabels(`*.${real[0]}.ts.net __h.${real[1]}.ts.net__`)
    ).toEqual(real);
    // Regex sources that only mention the domain are not names.
    expect(realTailnetLabels(String.raw`/\.ts\.net$/`)).toEqual([]);
  });

  it(
    "no tracked file names a real tailnet",
    async () => {
      const offenders: string[] = [];
      for (const { file, link } of await trackedFiles()) {
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
        // Report the file and a count only, never the name itself.
        if (inPath + inText > 0)
          offenders.push(
            `file #${offenders.length + 1} (${inPath + inText})${inPath ? "" : `: ${file}`}`
          );
      }
      expect(offenders).toEqual([]);
    },
    scaledTimeout(120_000)
  );
});
