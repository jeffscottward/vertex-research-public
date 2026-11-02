import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every signed-in router prefetch renders the portal layout (one session read)
// and the root layout (one theme read), each in its own request DB scope.
// vinext keeps rendering a prefetch after the client cancels it, so a page of
// default-prefetch links fills the 8-scope isolate cap and the next real read
// answers 503 DATABASE_CAPACITY. Portal links therefore opt out, like the
// sidebar (app-foundation.test.ts).
const SOURCE_ROOT = join(import.meta.dirname);
// Everything the signed-in portal renders: its routes, its components, the
// settings navigation, and the shell and user menu around every page.
const PORTAL_SOURCE_DIRECTORIES = [
  join(SOURCE_ROOT, "app", "(portal)"),
  join(SOURCE_ROOT, "components", "portal"),
  join(SOURCE_ROOT, "components", "settings"),
];
const PORTAL_SOURCE_FILES = [
  join(SOURCE_ROOT, "components", "portal-shell.tsx"),
  join(SOURCE_ROOT, "components", "user-menu.tsx"),
];

const sourceFilesIn = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".tsx") &&
        !entry.name.includes(".test.")
    )
    .map((entry) => join(entry.parentPath, entry.name));

const portalLinkSources = (): { file: string; source: string }[] =>
  [...PORTAL_SOURCE_DIRECTORIES.flatMap(sourceFilesIn), ...PORTAL_SOURCE_FILES]
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes("next/link"));

/** The opening `<Link ...>` tags of a source file; braces may hold `>`. */
const linkOpeningTags = (source: string): string[] => {
  const tags: string[] = [];
  for (const match of source.matchAll(/<Link\b/gu)) {
    let depth = 0;
    let end = match.index;
    while (end < source.length) {
      const character = source[end];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
      end += 1;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
};

describe("portal router links", () => {
  it("finds the portal sources, each importing next/link as Link", () => {
    const sources = portalLinkSources();
    expect(sources.length).toBeGreaterThan(PORTAL_SOURCE_FILES.length);
    // The tag scan below matches `<Link`; another binding name would hide links from it.
    return expect(
      sources
        .filter(
          ({ source }) => !/^import Link from "next\/link";$/mu.test(source)
        )
        .map(({ file }) => relative(SOURCE_ROOT, file))
    ).toEqual([]);
  });

  it("turns off prefetch on every next/link in the portal", () => {
    const offenders = portalLinkSources()
      .flatMap(({ file, source }) =>
        linkOpeningTags(source)
          .filter((tag) => !/\bprefetch=\{false\}/u.test(tag))
          .map(
            (tag) =>
              `${relative(SOURCE_ROOT, file)}: ${tag.replace(/\s+/gu, " ").slice(0, 80)}`
          )
      )
      .sort();
    return expect(offenders).toEqual([]);
  });
});
