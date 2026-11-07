import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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

const NAME = /(?<![\w.-])((?:[a-z0-9-]+\.)*?)([a-z0-9-]+)\.ts\.net\b/gi;
const MAX_BYTES = 4 * 1024 * 1024;

/** Every `*.ts.net` tailnet label in `text` that is not a placeholder. */
function realTailnetLabels(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(NAME)) {
    const label = (match[2] ?? "").toLowerCase();
    if (!Object.hasOwn(PLACEHOLDER_TAILNETS, label)) hits.push(label);
  }
  return hits;
}

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

describe("public tailnet names", () => {
  it("recognises real and placeholder tailnet labels", () => {
    expect(realTailnetLabels("https://rig.tail000000.ts.net:8443/x")).toEqual(
      []
    );
    expect(
      realTailnetLabels("demo.example-tailnet.ts.net and h.ts.net")
    ).toEqual([]);
    expect(realTailnetLabels("https://box.tail9f3a21.ts.net")).toEqual([
      "tail9f3a21",
    ]);
    expect(realTailnetLabels("vps.cat-crocodile.ts.net")).toEqual([
      "cat-crocodile",
    ]);
    // Regex sources that only mention the domain are not names.
    expect(realTailnetLabels(String.raw`/\.ts\.net$/`)).toEqual([]);
  });

  it(
    "no tracked file names a real tailnet",
    async () => {
      const offenders: string[] = [];
      for (const file of await trackedFiles()) {
        let data: Buffer;
        try {
          data = await readFile(`${root}${file}`);
        } catch {
          continue; // deleted in the working tree
        }
        if (data.length > MAX_BYTES || data.includes(0)) continue;
        const labels = realTailnetLabels(data.toString("utf8"));
        // Report the file and a count only, never the name itself.
        if (labels.length > 0) offenders.push(`${file} (${labels.length})`);
      }
      expect(offenders).toEqual([]);
    },
    scaledTimeout(120_000)
  );
});
