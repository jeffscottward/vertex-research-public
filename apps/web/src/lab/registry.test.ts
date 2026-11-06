import { describe, expect, it } from "vitest";

import {
  defineLabEntries,
  findLabEntry,
  findLabEntryForRoute,
  groupLabEntries,
  type LabEntry,
  LabRegistryError,
  labEntryHref,
} from "./registry.ts";

const entry = (overrides: Partial<LabEntry> & { id: string }): LabEntry => ({
  group: "Overview",
  render: () => null,
  title: overrides.id,
  ...overrides,
});

describe("lab registry", () => {
  it("keeps valid entries in order and freezes the list", () => {
    const entries = defineLabEntries([
      entry({ group: "Markets & Research", id: "charts", route: "/charts" }),
      entry({ id: "dashboard", route: "/dashboard" }),
      entry({ group: "Settings", id: "settings-profile" }),
    ]);
    expect(entries.map((item) => item.id)).toEqual([
      "charts",
      "dashboard",
      "settings-profile",
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it.each([
    [[entry({ id: "Charts" })], "Invalid lab entry id: Charts"],
    [[entry({ id: "a--b" })], "Invalid lab entry id: a--b"],
    [[entry({ id: "a" }), entry({ id: "a" })], "Duplicate lab entry id: a"],
    [[entry({ group: "Nope", id: "a" })], "Unknown lab group for a: Nope"],
    [
      [entry({ id: "a", route: "/x" }), entry({ id: "b", route: "/x" })],
      "Duplicate lab route: /x",
    ],
  ])("rejects bad entries (%#)", (entries, message) => {
    expect(() => defineLabEntries(entries)).toThrow(
      new LabRegistryError(message)
    );
  });

  it("finds entries by id and by route", () => {
    const entries = defineLabEntries([
      entry({ id: "charts", route: "/charts" }),
      entry({ id: "todos" }),
    ]);
    expect(findLabEntry(entries, "todos")?.id).toBe("todos");
    expect(findLabEntry(entries, "missing")).toBeUndefined();
    expect(findLabEntryForRoute(entries, "/charts")?.id).toBe("charts");
    expect(findLabEntryForRoute(entries, "/todos")).toBeUndefined();
  });

  it("groups entries in group order and drops empty groups", () => {
    const groups = groupLabEntries([
      entry({ group: "Settings", id: "profile" }),
      entry({ group: "Markets & Research", id: "charts" }),
      entry({ id: "dashboard" }),
      entry({ id: "todos" }),
    ]);
    expect(
      groups.map(({ group, entries }) => [group, entries.map((e) => e.id)])
    ).toEqual([
      ["Overview", ["dashboard", "todos"]],
      ["Markets & Research", ["charts"]],
      ["Settings", ["profile"]],
    ]);
  });

  it("builds entry hrefs with optional params", () => {
    expect(labEntryHref("charts")).toBe("/lab/charts");
    expect(
      labEntryHref("charts", { interval: "", symbol: "NVDA", theme: undefined })
    ).toBe("/lab/charts?symbol=NVDA");
  });
});
