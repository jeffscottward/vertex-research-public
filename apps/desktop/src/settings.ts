// What: the shell's own settings (site origin, which workspace windows were open, their bounds),
// stored as JSON in Electron's userData folder. A missing or invalid file falls back to defaults;
// writes go through a temp file and rename so a crash never leaves half a file.
// Used by: app.ts and window-manager.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { WORKSPACES, type WorkspaceId } from "./workspaces.ts";

const WORKSPACE_IDS = WORKSPACES.map((workspace) => workspace.id) as [
  WorkspaceId,
  ...WorkspaceId[],
];

const BoundsSchema = z.object({
  height: z.number().int().min(200).max(20_000),
  width: z.number().int().min(200).max(20_000),
  x: z.number().int().min(-20_000).max(20_000),
  y: z.number().int().min(-20_000).max(20_000),
});
export type WindowBounds = z.infer<typeof BoundsSchema>;

const SettingsSchema = z.object({
  bounds: z.partialRecord(z.enum(WORKSPACE_IDS), BoundsSchema).default({}),
  openWorkspaces: z.array(z.enum(WORKSPACE_IDS)).default([]),
  siteUrl: z.string().max(2048).optional(),
});
export type DesktopSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: DesktopSettings = Object.freeze({
  bounds: {},
  openWorkspaces: [],
});

/** Settings from stored JSON text; anything unreadable or invalid yields the defaults. */
export const parseSettings = (raw: string | null): DesktopSettings => {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_SETTINGS;
    return {
      ...parsed.data,
      openWorkspaces: [...new Set(parsed.data.openWorkspaces)],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
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
