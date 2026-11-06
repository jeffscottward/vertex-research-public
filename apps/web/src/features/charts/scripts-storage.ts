// Saved user scripts and the scripts applied per symbol, in browser storage. Every read is
// validated and bounded; nothing here throws (storage may be missing, full or blocked).

import type { ScriptInputValue } from "@darkfactory/scripting";
import type { ScriptInputs } from "./script-sandbox.ts";

export const SCRIPTS_STORAGE_KEY = "vx.charts.scripts.v1";
export const SAVED_SCRIPTS_MAX = 50;
export const ACTIVE_SCRIPTS_MAX = 8;
const SCRIPT_TITLE_MAX = 80;
// Same bound as @darkfactory/scripting SCRIPT_SOURCE_MAX.
const SAVED_SOURCE_MAX = 16_000;
const ID_MAX = 80;

export type SavedScript = Readonly<{
  id: string;
  title: string;
  source: string;
  updatedAt: number;
}>;

// An applied script that can be restored: "saved:<id>" or "template:<id>", plus its inputs.
export type ActiveScript = Readonly<{ ref: string; inputs: ScriptInputs }>;

export type ScriptStore = Pick<Storage, "getItem" | "setItem">;

export const activeScriptsKey = (symbol: string): string =>
  `vx.charts.scripts.active.v1.${symbol.trim().toUpperCase()}`;

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX;

const validSavedScript = (value: unknown): value is SavedScript => {
  if (typeof value !== "object" || value === null) return false;
  const { id, title, source, updatedAt } = value as Record<string, unknown>;
  return (
    validId(id) &&
    typeof title === "string" &&
    title.length <= SCRIPT_TITLE_MAX &&
    typeof source === "string" &&
    source.length <= SAVED_SOURCE_MAX &&
    typeof updatedAt === "number" &&
    Number.isSafeInteger(updatedAt) &&
    updatedAt >= 0
  );
};

const validInputValue = (value: unknown): value is ScriptInputValue =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 200);

const parseInputs = (value: unknown): ScriptInputs | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const entries = Object.entries(value);
  if (entries.length > 64) return null;
  if (
    !entries.every(([key, input]) => key.length <= 64 && validInputValue(input))
  )
    return null;
  return Object.fromEntries(entries);
};

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// Invalid entries and duplicate ids are dropped; the newest first, at most 50.
export const parseSavedScripts = (
  raw: string | null
): readonly SavedScript[] => {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  return parsed
    .filter(validSavedScript)
    .filter((script) => {
      if (seen.has(script.id)) return false;
      seen.add(script.id);
      return true;
    })
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, SAVED_SCRIPTS_MAX);
};

export const parseActiveScripts = (
  raw: string | null
): readonly ActiveScript[] => {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const { ref, inputs } = entry as Record<string, unknown>;
      const parsedInputs = parseInputs(inputs);
      if (
        typeof ref !== "string" ||
        !/^(saved|template):.{1,80}$/.test(ref) ||
        parsedInputs === null
      )
        return [];
      return [{ inputs: parsedInputs, ref }];
    })
    .slice(0, ACTIVE_SCRIPTS_MAX);
};

const read = (store: ScriptStore | null, key: string): string | null => {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

// false when storage is missing or refused the write.
const write = (store: ScriptStore | null, key: string, value: unknown) => {
  if (store === null) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const loadSavedScripts = (
  store: ScriptStore | null
): readonly SavedScript[] =>
  parseSavedScripts(read(store, SCRIPTS_STORAGE_KEY));

export const storeSavedScripts = (
  store: ScriptStore | null,
  scripts: readonly SavedScript[]
): boolean =>
  write(store, SCRIPTS_STORAGE_KEY, scripts.slice(0, SAVED_SCRIPTS_MAX));

export const loadActiveScripts = (
  store: ScriptStore | null,
  symbol: string
): readonly ActiveScript[] =>
  parseActiveScripts(read(store, activeScriptsKey(symbol)));

export const storeActiveScripts = (
  store: ScriptStore | null,
  symbol: string,
  active: readonly ActiveScript[]
): boolean =>
  write(store, activeScriptsKey(symbol), active.slice(0, ACTIVE_SCRIPTS_MAX));

// Replace by id or add; the edited script moves first. Bounded: the oldest falls off.
export const upsertSavedScript = (
  scripts: readonly SavedScript[],
  script: SavedScript
): readonly SavedScript[] =>
  [
    {
      ...script,
      source: script.source.slice(0, SAVED_SOURCE_MAX),
      title: script.title.slice(0, SCRIPT_TITLE_MAX),
    },
    ...scripts.filter((entry) => entry.id !== script.id),
  ].slice(0, SAVED_SCRIPTS_MAX);

export const removeSavedScript = (
  scripts: readonly SavedScript[],
  id: string
): readonly SavedScript[] => scripts.filter((entry) => entry.id !== id);

export const newScriptId = (
  now: number,
  random: () => number = Math.random
): string =>
  `s${Math.max(0, Math.trunc(now)).toString(36)}${Math.floor(
    random() * 1_679_616
  )
    .toString(36)
    .padStart(4, "0")}`;
