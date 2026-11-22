import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutGitRepositoryEnvironment } from "../lib/git-env.ts";
import { regularFilesOf } from "./apply.ts";
import {
  ALLOWED_LEFTOVERS,
  applyPlan,
  identityLeftovers,
  unexpectedLeftovers,
} from "./leftovers.ts";
import { parseInitArguments, planInit, type TrackedFile } from "./plan.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const text = (path: string, content: string): TrackedFile => ({
  bytes: new TextEncoder().encode(content),
  path,
});

describe("applyPlan", () => {
  it("applies edits, renames and deletions to the tracked files", () => {
    const kept = text("kept.md", "kept");
    expect(
      applyPlan(
        [
          kept,
          text("edited.md", "old"),
          text("old-name.md", "moved"),
          text("both.md", "old"),
          text("gone.md", "gone"),
        ],
        {
          deletions: ["gone.md"],
          edits: [
            { content: "new", path: "edited.md", replacements: 1 },
            { content: "new", path: "both.md", replacements: 1 },
          ],
          renames: [
            { from: "old-name.md", to: "new-name.md" },
            { from: "both.md", to: "both-renamed.md" },
          ],
        }
      )
    ).toEqual([
      kept,
      text("edited.md", "new"),
      text("new-name.md", "moved"),
      text("both-renamed.md", "new"),
    ]);
  });
});

describe("identityLeftovers", () => {
  it("reports template identity in paths and in text, with the match count", () => {
    expect(
      identityLeftovers([
        text("clean.md", "Acme Labs"),
        text("docs/plan.md", "DarkFactory by jeffscottward, darkfactory"),
        text("docs/darkfactory.md", "clean"),
        { bytes: new Uint8Array([0, 100, 97, 114, 107]), path: "image.webp" },
        {
          bytes: new Uint8Array([0, ...new TextEncoder().encode("jeffscott")]),
          path: "jeffscott.bin",
        },
      ])
    ).toEqual([
      "docs/plan.md: 3",
      "docs/darkfactory.md (path)",
      "jeffscott.bin (path)",
    ]);
  });

  it("counts the same file the same way on every call", () => {
    const files = [text("darkfactory.md", "darkfactory")];
    const expected = ["darkfactory.md (path)", "darkfactory.md: 1"];
    expect(identityLeftovers(files)).toEqual(expected);
    expect(identityLeftovers(files)).toEqual(expected);
  });
});

describe("unexpectedLeftovers", () => {
  it("keeps only the leftovers that the allowed list does not name", () => {
    const allowed = ["docs/record.json: 2"];
    expect(
      unexpectedLeftovers(
        [text("docs/record.json", "jeffscott jeffscott")],
        allowed
      )
    ).toEqual([]);
    // A different count in an allowed file is a new leak.
    expect(
      unexpectedLeftovers(
        [text("docs/record.json", "jeffscott"), text("new.md", "DarkFactory")],
        allowed
      )
    ).toEqual(["docs/record.json: 1", "new.md: 1"]);
  });
});

describe("the tracked files of this repository", () => {
  // The clone-based acceptance test makes the same check with the real init, but it runs
  // only nightly and for init changes. Five times a new document named the template or its
  // owner account and the failure first showed up in a later, unrelated CI run. This test
  // runs on every push: reword the line it names (for example "the owner", "the public
  // repository", "the upstream template") or, for a recorded provenance file that must not
  // change, add the entry to ALLOWED_LEFTOVERS with the reason.
  it("keep no template identity after a planned init", async () => {
    const paths = regularFilesOf(
      execFileSync("git", ["ls-files", "-s", "-z"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: withoutGitRepositoryEnvironment(process.env),
        maxBuffer: 64 * 1024 * 1024,
      })
    );
    const files = await Promise.all(
      paths.map(async (path) => ({
        bytes: new Uint8Array(
          await readFile(join(repositoryRoot, path)).catch((cause: unknown) => {
            throw new Error(
              `Tracked file ${path} cannot be read from the working tree: restore it or stage its deletion`,
              { cause }
            );
          })
        ),
        path,
      }))
    );
    const parsed = parseInitArguments(
      [
        "--name",
        "Acme Labs",
        "--slug",
        "acme-labs",
        "--scope",
        "@acme",
        "--domain",
        "acme.dev",
        "--repo",
        "acme/acme-labs",
      ],
      2026
    );
    if (parsed.kind !== "options") throw new Error("identity rejected");
    const initialized = applyPlan(
      files,
      planInit(parsed.options.identity, files)
    );

    expect(unexpectedLeftovers(initialized)).toEqual([]);
    // An entry that no longer matches is stale: remove it from ALLOWED_LEFTOVERS.
    const leftovers = identityLeftovers(initialized);
    expect(
      ALLOWED_LEFTOVERS.filter((entry) => !leftovers.includes(entry))
    ).toEqual([]);
  }, 120_000);
});
