import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The root README must not rot silently: every relative link resolves to a
// file (and to a heading when it has an anchor), and every script it names is
// a script in the root package.json. `bun run test:readme` runs this file
// alone. The pre-push hook and the CI coverage lane run it with the other
// operations tests. scripts/ci/ci-changes.sh treats the root README as code,
// so a README-only change takes the full lane. The light lane does not run
// this file: every test file runs exactly once in `verify`.
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

/**
 * Markdown lines outside fenced code blocks. A fence closes only on a line
 * that holds its own marker and nothing else.
 */
const proseLines = (markdown: string): string[] => {
  const lines: string[] = [];
  let fence = "";
  for (const line of markdown.split("\n")) {
    const [, marker = "", info = ""] =
      /^\s*(`{3,}|~{3,})(.*)$/u.exec(line) ?? [];
    if (fence === "") {
      // A backtick opener cannot carry a backtick in its info string.
      if (marker !== "" && !(marker.startsWith("`") && info.includes("`")))
        fence = marker;
      else lines.push(line);
    } else if (marker.startsWith(fence) && info.trim() === "") fence = "";
  }
  return lines;
};

/** Drops HTML tags, repeated until none is left (`<<b>i>` leaves no tag). */
const withoutTags = (text: string): string => {
  let current = text;
  for (;;) {
    const next = current.replace(/<[^>]+>/gu, "");
    if (next === current) return current;
    current = next;
  }
};

/**
 * GitHub heading anchors: inline Markdown and HTML tags dropped, lower case,
 * punctuation removed, spaces to dashes, `-1`, `-2` for repeated headings.
 */
const headingAnchors = (markdown: string): ReadonlySet<string> => {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(markdown)) {
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = withoutTags(heading.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1"))
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/gu, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
};

const readme = await read("README.md");
const prose = proseLines(readme).join("\n");
// Inline links, with an optional `<...>` wrapper and an optional title.
const linkMatches = [
  ...prose.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/gu),
];
const links = [...new Set(linkMatches.map(([, target = ""]) => target))].filter(
  (link) => !/^[a-z][a-z0-9+.-]*:/iu.test(link)
);
const targets = links.map((link) => {
  const [path = "", anchor] = link.split("#");
  return { anchor, link, path: path === "" ? "README.md" : decodeURI(path) };
});
// `bun run <script>` anywhere, and inline code that is only a script name
// (`verify:core`). A trailing colon (`vertex:`) names a script family.
const manifest = JSON.parse(await read("package.json")) as Readonly<{
  scripts: Readonly<Record<string, string>>;
}>;
const defined = Object.keys(manifest.scripts);
const scriptGroups = new Set(defined.map((script) => script.split(":")[0]));
const scriptNames = [
  ...new Set([
    ...[...readme.matchAll(/\bbun run ([\w-]+(?::[\w-]+)*:?)/gu)].map(
      ([, name = ""]) => name
    ),
    // Inline code counts only when its first segment is a script group, so
    // `node:fs` or a host and port are not read as scripts.
    ...[...prose.matchAll(/`([a-z][\w-]*(?::[\w-]+)*:?)`/gu)]
      .map(([, name = ""]) => name)
      .filter(
        (name) => name.includes(":") && scriptGroups.has(name.split(":")[0])
      ),
  ]),
];

describe("README invariants", () => {
  it("finds the README's links", () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it("finds the README's script names", () => {
    expect(scriptNames.length).toBeGreaterThan(5);
  });

  it("uses no reference-style or HTML links", () => {
    expect(prose).not.toMatch(/^\s*\[[^\]]+\]:\s|<a\s|href=/mu);
  });

  it("writes every inline link in a form this test can read", () => {
    expect(linkMatches.length).toBe(prose.split("](").length - 1);
  });

  it("links only to paths inside the repository", () => {
    expect(
      targets.filter(({ path }) => /^\/|(?:^|\/)\.\.(?:\/|$)/u.test(path))
    ).toEqual([]);
  });

  it("links only to files that exist", async () => {
    const missing: string[] = [];
    for (const { link, path } of targets) {
      if (!(await exists(path))) missing.push(link);
    }
    expect(missing).toEqual([]);
  });

  it("links only to headings that exist", async () => {
    const missing: string[] = [];
    for (const { anchor, link, path } of targets) {
      if (anchor === undefined || !path.endsWith(".md")) continue;
      if (!headingAnchors(await read(path)).has(anchor)) missing.push(link);
    }
    expect(missing).toEqual([]);
  });

  it("names only scripts that package.json defines", () => {
    expect(
      scriptNames.filter(
        (name) => !(name.endsWith(":") || Object.hasOwn(manifest.scripts, name))
      )
    ).toEqual([]);
  });

  it("names only script families that have a script", () => {
    expect(
      scriptNames.filter(
        (name) =>
          name.endsWith(":") &&
          !defined.some((script) => script.startsWith(name))
      )
    ).toEqual([]);
  });

  it("names no home-directory path", () => {
    expect(readme).not.toMatch(
      /~\/|\/home\/|\/Users\/|\/root\/|\$\{?HOME\b|%h\//u
    );
  });
});
