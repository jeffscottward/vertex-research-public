import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXECUTION_CONTROL_MODULES,
  EXECUTION_CONTROL_ROUTES,
  EXECUTION_GATEWAY_EXPORTS,
  PORTAL_RESEARCH_NOTICE,
  researchNoticeApplies,
} from "./research-notice.ts";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const portalRoot = path.join(sourceRoot, "app", "(portal)");

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const isSource = (file: string): boolean =>
  /\.tsx?$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !file.endsWith(".d.ts");

const IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
// Imports that load no code: styles, data and images.
const ASSET_PATTERN = /\.(?:css|json|svg|png|jpg|webp|woff2?)$/;

/** The file a relative import names, or null when no source file is there. */
const resolveImport = (from: string, specifier: string): string | null => {
  const target = path.resolve(path.dirname(from), specifier);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate)
    ) ?? null
  );
};

const unresolved: string[] = [];

const relativeImports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)].flatMap((match) => {
    const specifier = match[1] ?? "";
    if (ASSET_PATTERN.test(specifier)) return [];
    const target = resolveImport(file, specifier);
    if (target === null) {
      unresolved.push(`${path.relative(sourceRoot, file)} -> ${specifier}`);
      return [];
    }
    return [target];
  });

/** Every source file a route file loads, by its relative imports (static and `import()`). */
const importClosure = (entry: string): ReadonlySet<string> => {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const target of relativeImports(file)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
};

/** "/stock/symbol" for app/(portal)/stock/[symbol]/page.tsx; "/" for a file of the group itself. */
const routeOf = (routeFile: string): string =>
  `/${path
    .relative(portalRoot, path.dirname(routeFile))
    .split(path.sep)
    .filter((segment) => segment !== "" && !segment.startsWith("("))
    .map((segment) => segment.replace(/^\[+\.{0,3}|\]+$/g, ""))
    .join("/")}`;

const fromSource = (module: string): string => path.join(sourceRoot, module);
const executionModules = new Set(EXECUTION_CONTROL_MODULES.map(fromSource));

// Every file the router can render for a portal route, not only its page.
const ROUTE_FILE =
  /[/\\](?:page|layout|template|error|loading|default|not-found)\.tsx?$/;

const routeFiles = walk(portalRoot)
  .filter((file) => ROUTE_FILE.test(file) && isSource(file))
  .map((file) => ({
    file: path.relative(sourceRoot, file),
    hasExecutionControl: [...importClosure(file)].some((loaded) =>
      executionModules.has(loaded)
    ),
    isPage: /[/\\]page\.tsx?$/.test(file),
    route: routeOf(file),
  }));

// Any use of an order, arming, broker-recovery or deployment-request namespace of the API client:
// a call, a destructured name, a bracket access or a type.
const PROCEDURE_USE =
  /\b(?:vertexOrders|goLiveDrafts|nautilusArm|ibkrRecovery|deploymentRequests)\b/;

const sources = walk(sourceRoot)
  .filter(isSource)
  // Server route handlers mount the API; they are not pages. The rule file names the exports.
  .filter(
    (file) =>
      !file.startsWith(path.join(sourceRoot, "app", "api")) &&
      file !== fromSource("lib/research-notice.ts")
  )
  .map((file) => ({ file, text: readFileSync(file, "utf8") }));

// The shell prints the notice once per page. A page title subtitle (the description of
// PageHeader) that repeats it, as words or through a notice constant, prints it twice. The check
// reads the description at the call of PageHeader; it does not follow a value into a wrapper.
const NOTICE_WORDS = /research[- ]only|authori[sz]e/i;
const NOTICE_CONSTANT = /\b[A-Z][A-Z0-9_]*NOTICE\b/;
const repeatsNotice = (description: string): boolean =>
  NOTICE_WORDS.test(description) || NOTICE_CONSTANT.test(description);

/**
 * The end of the quoted string or the braced expression that starts at `start`. Another start
 * (an element without braces) throws: the walk cannot read it, and a skipped prop would hide a
 * description.
 */
const valueEnd = (text: string, start: number): number => {
  const first = text[start];
  if (first === '"' || first === "'") {
    const close = text.indexOf(first, start + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (first !== "{")
    throw new Error(`prop value not read: ${text.slice(start, start + 40)}`);
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return index + 1;
  }
  return text.length;
};

const TAG_END = /\s*\/?>/y;

/** The source text of the `description` value of every `<PageHeader>` in a file. */
const pageHeaderDescriptions = (text: string): string[] =>
  [...text.matchAll(/<PageHeader\b/g)].flatMap((match) => {
    // Walk the props of the opening tag: a name, then a string or a braced value.
    const prop = /\s*(?:([\w:.-]+)(=)?|(\{))/y;
    let at = match.index + match[0].length;
    prop.lastIndex = at;
    for (let found = prop.exec(text); found !== null; found = prop.exec(text)) {
      // A spread or a comment: skip the braces.
      if (found[3] !== undefined)
        prop.lastIndex = valueEnd(text, found.index + found[0].length - 1);
      else if (found[2] !== undefined) {
        const end = valueEnd(text, prop.lastIndex);
        if (found[1] === "description")
          return [text.slice(prop.lastIndex, end)];
        prop.lastIndex = end;
      }
      at = prop.lastIndex;
    }
    // The walk must stop at the end of the opening tag. Another stop is a prop that it cannot read.
    TAG_END.lastIndex = at;
    if (!TAG_END.test(text))
      throw new Error(`PageHeader props not read: ${text.slice(at, at + 40)}`);
    return [];
  });

describe("portal research notice", () => {
  it("keeps the reviewed wording", () => {
    expect(PORTAL_RESEARCH_NOTICE).toBe(
      "Research only: nothing here authorizes a trade."
    );
  });

  it("applies to research routes and to no execution route or its children", () => {
    expect(researchNoticeApplies("/research")).toBe(true);
    expect(researchNoticeApplies("/pick-lists")).toBe(true);
    expect(researchNoticeApplies("/portfolio-combos")).toBe(true);
    expect(researchNoticeApplies("/settings/appearance")).toBe(true);
    expect(researchNoticeApplies(null)).toBe(false);
    for (const route of EXECUTION_CONTROL_ROUTES) {
      expect(researchNoticeApplies(route)).toBe(false);
      expect(researchNoticeApplies(`${route}/detail`)).toBe(false);
    }
  });

  it("names execution modules and gateway files that exist", () => {
    for (const module of [
      ...EXECUTION_CONTROL_MODULES,
      ...Object.keys(EXECUTION_GATEWAY_EXPORTS),
    ]) {
      expect(existsSync(fromSource(module)), module).toBe(true);
    }
  });

  it("finds the portal route files and resolves every import on the way", () => {
    const pages = routeFiles.filter((entry) => entry.isPage);
    expect(pages.length).toBeGreaterThan(40);
    expect(pages.map((page) => page.route)).toContain("/stock/symbol");
    expect(routeFiles.map((entry) => entry.file)).toContain(
      path.join("app", "(portal)", "layout.tsx")
    );
    expect(unresolved).toEqual([]);
  });

  it("never prints the notice on a route that loads an order, arming, recovery or approval control", () => {
    const wrong = routeFiles
      .filter(
        (entry) =>
          entry.hasExecutionControl && researchNoticeApplies(entry.route)
      )
      .map((entry) => `${entry.route} (${entry.file})`);
    expect(wrong).toEqual([]);
  });

  it("lists no execution route without such a control", () => {
    const stale = EXECUTION_CONTROL_ROUTES.filter(
      (route) =>
        !routeFiles.some(
          (entry) => entry.route === route && entry.hasExecutionControl
        )
    );
    expect(stale).toEqual([]);
  });

  it("lists every file that uses an order, arming, recovery or deployment-request namespace", () => {
    const known = new Set(
      [
        ...EXECUTION_CONTROL_MODULES,
        ...Object.keys(EXECUTION_GATEWAY_EXPORTS),
      ].map(fromSource)
    );
    const callers = sources
      .filter((source) => PROCEDURE_USE.test(source.text))
      .map((source) => source.file);
    // The scan sees the calls: each client module that holds one is found.
    expect(callers.length).toBeGreaterThanOrEqual(4);
    expect(
      callers
        .filter((file) => !known.has(file))
        .map((file) => path.relative(sourceRoot, file))
    ).toEqual([]);
  });

  it("lists every file that uses an approval export of a shared client file", () => {
    for (const [gateway, names] of Object.entries(EXECUTION_GATEWAY_EXPORTS)) {
      const uses = new RegExp(`\\b(?:${names.join("|")})\\b`);
      const users = sources
        .filter(
          (source) =>
            source.file !== fromSource(gateway) && uses.test(source.text)
        )
        .map((source) => source.file);
      expect(users.length).toBeGreaterThan(0);
      expect(
        users
          .filter((file) => !executionModules.has(file))
          .map((file) => path.relative(sourceRoot, file))
      ).toEqual([]);
    }
  });

  it("repeats the notice in no page title subtitle", () => {
    expect(
      pageHeaderDescriptions('<PageHeader {...rest} title="A" />')
    ).toEqual([]);
    expect(
      pageHeaderDescriptions(
        '<PageHeader description="One. Research only." title="A" />'
      )
    ).toEqual(['"One. Research only."']);
    expect(
      pageHeaderDescriptions(
        "<PageHeader\n status={<b>x</b>}\n description={<>One {link}. {A_NOTICE}</>}\n />"
      )
    ).toEqual(["{<>One {link}. {A_NOTICE}</>}"]);
    expect(
      pageHeaderDescriptions(
        "<PageHeader data-x1=\"a\" description='One. Research only.' />"
      )
    ).toEqual(["'One. Research only.'"]);
    // A prop that the walk cannot read fails the test; it never hides a description.
    expect(() =>
      pageHeaderDescriptions(
        '<PageHeader icon=<b /> description="Research only." />'
      )
    ).toThrow("prop value not read");
    expect(() =>
      pageHeaderDescriptions('<PageHeader title="A" ? description="B" />')
    ).toThrow("PageHeader props not read");
    expect(repeatsNotice("{REPORTS_NOTICE}")).toBe(true);
    expect(repeatsNotice('"One. Research only; no orders."')).toBe(true);
    expect(repeatsNotice('"A row does not authorize a trade."')).toBe(true);
    expect(repeatsNotice('"Tracking only: no orders. See the notice."')).toBe(
      false
    );
    expect(
      sources.flatMap((source) =>
        pageHeaderDescriptions(source.text)
          .filter(repeatsNotice)
          .map(
            (description) =>
              `${path.relative(sourceRoot, source.file)}: ${description}`
          )
      )
    ).toEqual([]);
  });
});
