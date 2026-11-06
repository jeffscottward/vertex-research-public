import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { LabEntry } from "../registry.ts";
import { LAB_ENTRIES, orderLabEntries } from "./index.ts";

const PORTAL_APP = fileURLToPath(
  new URL("../../app/(portal)", import.meta.url)
);

/** Every (portal) page route, e.g. "/charts", "/research/reports/[reportId]". */
const portalPageRoutes = (dir = PORTAL_APP): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return portalPageRoutes(path);
    if (name !== "page.tsx") return [];
    return [`/${relative(PORTAL_APP, dir).split(sep).join("/")}`];
  });

const entry = (id: string, route?: string): LabEntry => ({
  group: "Overview",
  id,
  title: id,
  ...(route === undefined ? {} : { route }),
  render: () => null,
});

describe("lab entries", () => {
  it("has one entry for every portal page", () => {
    const routes = LAB_ENTRIES.flatMap((item) =>
      item.route === undefined ? [] : [item.route]
    );
    expect([...routes].sort()).toEqual(portalPageRoutes().sort());
  });

  it("orders sidebar routes first, then the rest in listed order", () => {
    const ordered = orderLabEntries([
      entry("settings", "/settings/appearance"),
      entry("charts", "/charts"),
      entry("loose"),
      entry("dashboard", "/dashboard"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      "dashboard",
      "charts",
      "settings",
      "loose",
    ]);
  });
});
