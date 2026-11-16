import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withoutGitRepositoryEnvironment } from "../lib/git-env.ts";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";
import {
  discordServerIds,
  privateNames,
  realTailnetLabels,
  runPublicNamesCli,
  scanAll,
  scanRange,
  scanTracked,
} from "./public-names.ts";

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
    expect(realTailnetLabels(`dev-rig\\.${real[0]}\\.ts\\.net`)).toEqual([
      real[0],
    ]);
    expect(
      realTailnetLabels(`*.${real[0]}.ts.net __h.${real[1]}.ts.net__`)
    ).toEqual(real);
    // Regex sources that only mention the domain are not names.
    expect(realTailnetLabels(String.raw`/\.ts\.net$/`)).toEqual([]);
  });

  it("recognises Discord server IDs in links", () => {
    // The ID is joined at run time so this file passes its own scan.
    const server = ["1234567890", "123456789"].join("");
    expect(
      discordServerIds(`https://discord.com/channels/${server}/1/2`)
    ).toEqual([server]);
    expect(discordServerIds(`discordapp.com/channels/${server}`)).toEqual([
      server,
    ]);
    // Escaped regex or JSON sources are still links.
    expect(discordServerIds(`discord\\.com\\/channels\\/${server}`)).toEqual([
      server,
    ]);
    // Short test IDs and the 1000000000000000001 placeholder are not server IDs.
    expect(
      discordServerIds(
        "discord.com/channels/1/2/3 discord.com/channels/1000000000000000001/2"
      )
    ).toEqual([]);
    expect(privateNames(`discord.com/channels/${server} h.ts.net`)).toEqual([
      server,
    ]);
  });

  it(
    "no tracked file names a real tailnet",
    async () => {
      expect(await scanTracked(root)).toEqual([]);
    },
    scaledTimeout(120_000)
  );

  // Non-placeholder labels are joined at run time so this file passes its own scan.
  const leak = (label = "tail9f3a21") => `rig.${label}.ts.net`;

  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  async function tempRepo() {
    const dir = `${await mkdtemp(join(tmpdir(), "public-names-"))}/`;
    tempDirs.push(dir);
    const git = async (...args: string[]) =>
      (
        await execFileAsync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          // A hook exports GIT_DIR and GIT_INDEX_FILE; without this the helper would write to the real repository.
          { cwd: dir, env: withoutGitRepositoryEnvironment() }
        )
      ).stdout.trim();
    await git("init", "-q", "-b", "main");
    await writeFile(join(dir, "a.md"), `${leak("tailnet")}\n`);
    await git("add", ".");
    await git("commit", "-qm", "base");
    return { base: await git("rev-parse", "HEAD"), dir, git };
  }

  it(
    "scans tracked paths, symlink targets, UTF-16 text and oversize files, and skips deleted files",
    async () => {
      const { dir, git } = await tempRepo();
      expect(await scanTracked(dir)).toEqual([]);
      await mkdir(join(dir, leak()));
      await writeFile(join(dir, leak(), "x.md"), "ok\n");
      await symlink(leak(), join(dir, "link"));
      await writeFile(join(dir, "u16.txt"), Buffer.from(leak(), "utf16le"));
      await writeFile(join(dir, "gone.md"), "x\n");
      await git("add", ".");
      await rm(join(dir, "gone.md"));
      expect(await scanTracked(dir)).toEqual([
        "file #1 (1): link",
        "file #2 (1)",
        "file #3 (1): u16.txt",
      ]);
      expect(await scanTracked(dir, 1)).toHaveLength(4);
      // A tracked path that cannot be read (here a directory) fails rather than passing.
      await rm(join(dir, "u16.txt"));
      await mkdir(join(dir, "u16.txt"));
      await expect(scanTracked(dir)).rejects.toThrow(/EISDIR/);
    },
    scaledTimeout(30_000)
  );

  it(
    "flags what a commit range publishes: added lines, messages, paths, merges, binary and -diff blobs",
    async () => {
      const { dir, git, base } = await tempRepo();
      const range = async () => `${base}..${await git("rev-parse", "HEAD")}`;
      await writeFile(join(dir, "a.md"), `++ ${leak()}\n`);
      await git("commit", "-qam", "added line");
      await writeFile(join(dir, "a.md"), `${leak("tailnet")}\n`);
      await git("commit", "-qam", `message ${leak()}`);
      await git("switch", "-qc", "side");
      await writeFile(join(dir, ".gitattributes"), "*.bin -diff\n");
      await writeFile(
        join(dir, "x.bin"),
        Buffer.concat([Buffer.from([0]), Buffer.from(leak(), "utf16le")])
      );
      await git("add", ".");
      await git("commit", "-qm", "side");
      await git("switch", "-q", "main");
      await git("merge", "-q", "--no-ff", "-m", "merge", "side");
      await git("rm", "-q", "x.bin");
      await writeFile(join(dir, `${leak()}.md`), "ok\n");
      await git("add", ".");
      await git("commit", "-qm", "path");
      const hits = await scanRange(dir, await range());
      expect(
        hits.filter((hit) => hit.startsWith("commit message "))
      ).toHaveLength(1);
      expect(
        hits.filter((hit) => hit.startsWith("path of object "))
      ).toHaveLength(1);
      // The `++ ` line and the -diff binary UTF-16 blob.
      expect(hits.filter((hit) => hit.startsWith("blob "))).toHaveLength(2);
      for (const hit of hits)
        expect(hit).toMatch(/^[a-z ]+ [0-9a-f]{12} \(1\)$/);
      // Too large to scan is a failure, not a pass.
      expect(
        (await scanRange(dir, await range(), 1)).filter((hit) =>
          hit.startsWith("blob ")
        ).length
      ).toBeGreaterThan(2);
      expect(await scanAll(dir)).toEqual(["file #1 (1)"]);
      expect(await scanAll(dir, await range())).toHaveLength(hits.length + 1);
      const out: string[] = [];
      const io = {
        root: dir,
        stderr: { write: (x: string) => out.push(`E ${x}`) },
        stdout: { write: (x: string) => out.push(`O ${x}`) },
      };
      expect(await runPublicNamesCli([await range()], io)).toBe(1);
      expect(out.pop()).toMatch(
        /^E public-names: real tailnet names found \(names withheld\):\n/
      );
      await rm(join(dir, `${leak()}.md`));
      expect(await runPublicNamesCli([""], io)).toBe(0);
      expect(out.pop()).toBe("O public-names: clean (tracked files)\n");
      expect(await runPublicNamesCli([`${base}..${base}`], io)).toBe(0);
      expect(out.pop()).toBe(
        `O public-names: clean (tracked files and commits ${base}..${base})\n`
      );
      await expect(scanRange(dir, "main; rm -rf /")).rejects.toThrow(
        /bad commit range/
      );
    },
    scaledTimeout(30_000)
  );
});
