import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";
import { realTailnetLabels, scanRange, scanTracked } from "./public-names.ts";

// Public-repository gate (card vertex-tailnet-rotate): see scripts/ci/public-names.ts. CI also runs that
// script in the always-on "Changes" job so docs-only (light-lane) PRs are scanned.

const root = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

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
      expect(await scanTracked(root)).toEqual([]);
    },
    scaledTimeout(120_000)
  );

  it(
    "flags a real name added anywhere in a commit range, even if removed later",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "public-names-"));
      const run = (...args: string[]) =>
        execFileAsync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: dir }
        );
      const sha = async () => (await run("rev-parse", "HEAD")).stdout.trim();
      await run("init", "-q");
      await writeFile(join(dir, "a.md"), "rig.tailnet.ts.net\n");
      await run("add", ".");
      await run("commit", "-qm", "base");
      const base = await sha();
      await writeFile(join(dir, "a.md"), `rig.${"tail9f3a21"}.ts.net\n`);
      await run("commit", "-qam", "leak");
      await writeFile(join(dir, "a.md"), "rig.tailnet.ts.net\n");
      await run("commit", "-qam", "fix");
      const head = await sha();
      expect(await scanTracked(`${dir}/`)).toEqual([]);
      const hits = await scanRange(dir, `${base}..${head}`);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatch(/^commit [0-9a-f]{12} \(1\)$/);
      await expect(scanRange(dir, "main; rm -rf /")).rejects.toThrow(
        /bad commit range/
      );
    },
    scaledTimeout(30_000)
  );
});
