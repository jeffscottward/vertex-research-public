// What: the shell's own settings (site origin, which workspace windows were open, their bounds),
// stored as JSON in Electron's userData folder. A missing or invalid file falls back to defaults;
// writes go through a temp file and rename so a crash never leaves half a file.
// Used by: app.ts and window-manager.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { isWorkspaceId, type WorkspaceId } from "./workspaces.ts";

const BoundsSchema = z.object({
  height: z.number().int().min(200).max(20_000),
  width: z.number().int().min(200).max(20_000),
  x: z.number().int().min(-20_000).max(20_000),
  y: z.number().int().min(-20_000).max(20_000),
});
export type WindowBounds = z.infer<typeof BoundsSchema>;

export type DesktopSettings = Readonly<{
  bounds: Readonly<Partial<Record<WorkspaceId, WindowBounds>>>;
  openWorkspaces: readonly WorkspaceId[];
  siteUrl?: string;
}>;

export const DEFAULT_SETTINGS: DesktopSettings = Object.freeze({
  bounds: {},
  openWorkspaces: [],
});

const SITE_URL_MAX = 2048;

/**
 * Settings from stored JSON text. Each field is read on its own, so one bad entry (say, bounds
 * off every screen) drops only that entry and never the saved site or open windows.
 */
export const parseSettings = (raw: string | null): DesktopSettings => {
  if (raw === null) return DEFAULT_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return DEFAULT_SETTINGS;
  const { bounds, openWorkspaces, siteUrl } = parsed as Record<string, unknown>;
  const validBounds: Partial<Record<WorkspaceId, WindowBounds>> = {};
  if (typeof bounds === "object" && bounds !== null)
    for (const [id, value] of Object.entries(bounds)) {
      const entry = BoundsSchema.safeParse(value);
      if (isWorkspaceId(id) && entry.success) validBounds[id] = entry.data;
    }
  return {
    bounds: validBounds,
    openWorkspaces: Array.isArray(openWorkspaces)
      ? [...new Set(openWorkspaces.filter(isWorkspaceId))]
      : [],
    ...(typeof siteUrl === "string" && siteUrl.length <= SITE_URL_MAX
      ? { siteUrl }
      : {}),
  };
};

export interface SettingsStore {
  readonly load: () => DesktopSettings;
  readonly save: (settings: DesktopSettings) => void;
}

export const createFileSettingsStore = (file: string): SettingsStore => ({
  load: () => {
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      // First start or an unreadable file: defaults.
    }
    return parseSettings(raw);
  },
  save: (settings) => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temp, file);
  },
});
