import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXECUTION_CONTROL_MODULES,
  EXECUTION_CONTROL_ROUTES,
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

const IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

const relativeImports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)].flatMap((match) => {
    const target = path.resolve(path.dirname(file), match[1] ?? "");
    return existsSync(target) && /\.tsx?$/.test(target) ? [target] : [];
  });

/** Every source file a route file loads, by its relative imports. */
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

/** "/stock/symbol" for app/(portal)/stock/[symbol]/page.tsx. */
const routeOf = (pageFile: string): string =>
  `/${path
    .relative(portalRoot, path.dirname(pageFile))
    .split(path.sep)
    .filter((segment) => segment !== "" && !segment.startsWith("("))
    .map((segment) => segment.replace(/^\[+\.{0,3}|\]+$/g, ""))
    .join("/")}`;

const executionModules = new Set(
  EXECUTION_CONTROL_MODULES.map((module) => path.join(sourceRoot, module))
);

const pages = walk(portalRoot)
  .filter((file) => /[/\\]page\.tsx?$/.test(file))
  .map((file) => ({
    file: path.relative(sourceRoot, file),
    hasExecutionControl: [...importClosure(file)].some((loaded) =>
      executionModules.has(loaded)
    ),
    route: routeOf(file),
  }));

describe("portal research notice", () => {
  it("keeps the reviewed wording", () => {
    expect(PORTAL_RESEARCH_NOTICE).toBe(
      "Research only: nothing here authorizes a trade."
    );
  });

  it("applies to research routes and to no execution route or its children", () => {
    expect(researchNoticeApplies("/research")).toBe(true);
    expect(researchNoticeApplies("/portfolio-combos")).toBe(true);
    expect(researchNoticeApplies("/settings/appearance")).toBe(true);
    expect(researchNoticeApplies(null)).toBe(false);
    for (const route of EXECUTION_CONTROL_ROUTES) {
      expect(researchNoticeApplies(route)).toBe(false);
      expect(researchNoticeApplies(`${route}/detail`)).toBe(false);
    }
  });

  it("names execution modules that exist", () => {
    for (const module of executionModules) {
      expect(existsSync(module), module).toBe(true);
    }
  });

  it("finds the portal route files", () => {
    expect(pages.length).toBeGreaterThan(40);
    expect(pages.map((page) => page.route)).toContain("/stock/symbol");
  });

  it("never prints the notice on a route that loads an order, arming, recovery or approval control", () => {
    const wrong = pages
      .filter(
        (page) => page.hasExecutionControl && researchNoticeApplies(page.route)
      )
      .map((page) => `${page.route} (${page.file})`);
    expect(wrong).toEqual([]);
  });

  it("lists no execution route without such a control", () => {
    const stale = EXECUTION_CONTROL_ROUTES.filter(
      (route) =>
        !pages.some((page) => page.route === route && page.hasExecutionControl)
    );
    expect(stale).toEqual([]);
  });
});
