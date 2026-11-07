import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFileSettingsStore,
  DEFAULT_SETTINGS,
  parseSettings,
} from "./settings.ts";

const bounds = { height: 800, width: 1200, x: 10, y: 20 };

describe("parseSettings", () => {
  it("returns defaults for missing, malformed or invalid JSON", () => {
    expect(parseSettings(null)).toBe(DEFAULT_SETTINGS);
    expect(parseSettings("{")).toBe(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toBe(DEFAULT_SETTINGS);
    expect(parseSettings("[]")).toBe(DEFAULT_SETTINGS);
    expect(parseSettings('"text"')).toBe(DEFAULT_SETTINGS);
  });

  it("drops only the invalid entries and keeps the rest", () => {
    expect(
      parseSettings(
        JSON.stringify({
          bounds: {
            charts: { height: 800, width: 1200, x: -32_000, y: -32_000 },
            journal: bounds,
            orders: bounds,
          },
          openWorkspaces: ["orders", "journal", 7],
          siteUrl: "https://vertex.example",
        })
      )
    ).toEqual({
      bounds: { journal: bounds },
      openWorkspaces: ["journal"],
      siteUrl: "https://vertex.example",
    });
    expect(
      parseSettings(
        JSON.stringify({
          bounds: null,
          openWorkspaces: "charts",
          siteUrl: "x".repeat(2049),
        })
      )
    ).toEqual({ bounds: {}, openWorkspaces: [] });
    expect(parseSettings('{"siteUrl":5}')).toEqual({
      bounds: {},
      openWorkspaces: [],
    });
  });

  it("fills defaults and drops duplicate open workspaces", () => {
    expect(parseSettings("{}")).toEqual({ bounds: {}, openWorkspaces: [] });
    expect(
      parseSettings(
        JSON.stringify({
          bounds: { charts: bounds },
          openWorkspaces: ["charts", "journal", "charts"],
          siteUrl: "https://vertex.example",
        })
      )
    ).toEqual({
      bounds: { charts: bounds },
      openWorkspaces: ["charts", "journal"],
      siteUrl: "https://vertex.example",
    });
  });
});

describe("createFileSettingsStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { force: true, recursive: true });
  });
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "vertex-desktop-"));
    dirs.push(dir);
    return join(dir, "nested", "settings.json");
  };

  it("loads defaults before the first save", () => {
    expect(createFileSettingsStore(tempFile()).load()).toBe(DEFAULT_SETTINGS);
  });

  it("saves owner-only JSON and loads it back", () => {
    const file = tempFile();
    const store = createFileSettingsStore(file);
    const settings = {
      bounds: { dashboard: bounds },
      openWorkspaces: ["dashboard" as const],
      siteUrl: "https://vertex.example",
    };
    store.save(settings);
    expect(store.load()).toEqual(settings);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settings);
    expect((statSync(file).mode % 0o1000).toString(8)).toBe("600");
  });

  it("treats a corrupt file as defaults", () => {
    const file = tempFile();
    const store = createFileSettingsStore(file);
    store.save(DEFAULT_SETTINGS);
    writeFileSync(file, "garbage");
    expect(store.load()).toBe(DEFAULT_SETTINGS);
  });
});
