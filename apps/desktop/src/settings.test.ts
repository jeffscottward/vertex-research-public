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
    expect(parseSettings('{"openWorkspaces":["orders"]}')).toBe(
      DEFAULT_SETTINGS
    );
    expect(parseSettings('{"bounds":{"charts":{"width":5}}}')).toBe(
      DEFAULT_SETTINGS
    );
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
