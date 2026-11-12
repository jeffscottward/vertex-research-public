import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The root README must not rot silently: every relative link resolves to a
// file (and to a heading when it has an anchor), and every `bun run` command
// it names is a script in the root package.json.
const rootUrl = new URL("../../", import.meta.url);
const read = (path: string): Promise<string> =>
  readFile(new URL(path, rootUrl), "utf8");

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(new URL(path, rootUrl));
    return true;
  } catch {
    return false;
  }
};

/** GitHub heading anchors: lower case, punctuation removed, spaces to dashes. */
const headingAnchors = (markdown: string): ReadonlySet<string> => {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (heading?.[1] !== undefined) {
      anchors.add(
        heading[1]
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/\s/gu, "-")
      );
    }
  }
  return anchors;
};

const readme = await read("README.md");
const links = [...readme.matchAll(/\]\(([^)\s]+)\)/gu)].map(
  ([, target = ""]) => target
);
const commands = [...readme.matchAll(/\bbun run ([\w:.-]+)/gu)].map(
  ([, name = ""]) => name
);

describe("README invariants", () => {
  it("names links and commands to check", () => {
    expect(links.length).toBeGreaterThan(10);
    expect(commands.length).toBeGreaterThan(5);
  });

  it("links only to files and headings that exist", async () => {
    const broken: string[] = [];
    for (const link of new Set(links)) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(link)) continue;
      const [path = "", anchor] = link.split("#");
      const target = path === "" ? "README.md" : decodeURI(path);
      if (!(await exists(target))) broken.push(link);
      else if (
        anchor !== undefined &&
        target.endsWith(".md") &&
        !headingAnchors(await read(target)).has(anchor)
      ) {
        broken.push(link);
      }
    }
    expect(broken).toEqual([]);
  });

  it("names only bun scripts that package.json defines", async () => {
    const manifest = JSON.parse(await read("package.json")) as Readonly<{
      scripts: Readonly<Record<string, string>>;
    }>;
    const missing = [...new Set(commands)].filter(
      // `bun run vertex:*` names a script family, not one script.
      (name) => !(name.endsWith(":") || name in manifest.scripts)
    );
    expect(missing).toEqual([]);
  });

  it("names no home-directory path", () => {
    expect(readme).not.toMatch(/~\/|\/home\/|\/Users\//u);
  });
});
