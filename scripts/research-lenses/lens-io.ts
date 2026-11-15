// Shared runtime helpers for the research-lens data jobs (rotation matrix, TRUE SLAP deep value).
// The rig runs these jobs with Bun from a `git archive <ref> scripts/research-lenses` extract: no
// node_modules and no workspace packages. Runtime files here import only node:* builtins and
// sibling files. Every side effect (network, file system, clock, sleep, log) goes through LensIo so
// tests can replace it.

import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export type LensFetch = (url: string, init: RequestInit) => Promise<Response>;

export type LensFs = Readonly<{
  exists: (path: string) => boolean;
  mkdir: (path: string) => Promise<unknown>;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  writeFile: (path: string, text: string) => Promise<void>;
}>;

export type LensIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch: LensFetch;
  fs: LensFs;
  homeDir: string;
  /** Repository (or archive extract) root: relative --out paths resolve here, as in vertex-research. */
  rootDir: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

/** The real file system, recursive mkdir and forced recursive rm. */
export const nodeLensFs: LensFs = {
  exists: (path) => existsSync(path),
  mkdir: (path) => mkdir(path, { recursive: true }),
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  rename: (from, to) => rename(from, to),
  rm: (path) => rm(path, { force: true, recursive: true }),
  writeFile: (path, text) => writeFile(path, text),
};

/** scripts/research-lenses/../.. is the repository root, or the root of a `git archive` extract. */
export const LENS_ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const sleepMs = (ms: number): Promise<void> => delay(ms);

/** Process-backed IO for a real run. */
export const nodeLensIo = (): LensIo => ({
  argv: process.argv,
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  fs: nodeLensFs,
  homeDir: homedir(),
  now: () => new Date(),
  rootDir: LENS_ROOT_DIR,
  sleep: sleepMs,
  stderr: process.stderr,
});

/**
 * Runs `run` with process IO when the module is the entry point (Bun and Node set
 * import.meta.main) and sets the process exit code from its result.
 */
export const runIfMain = async (
  meta: Readonly<{ main?: boolean; url: string }>,
  run: (io: LensIo) => Promise<number>,
  makeIo: () => LensIo = nodeLensIo,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  }
): Promise<void> => {
  if (meta.main !== true) return;
  setExitCode(await run(makeIo()));
};

/** `--name value` from argv, as in vertex-research: the default when the flag is absent or has no value. */
export const argValue = (
  argv: readonly string[],
  name: string,
  fallback: string
): string => {
  const index = argv.indexOf(name);
  return index > 0 ? (argv[index + 1] ?? fallback) : fallback;
};

/** One stderr line prefixed with the ISO time (console.error(new Date().toISOString(), ...parts)). */
export const logLine = (io: LensIo, ...parts: readonly unknown[]): void => {
  io.stderr.write(`${[io.now().toISOString(), ...parts].join(" ")}\n`);
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Writes `${file}.tmp` and renames it into place so a reader never sees a partial file. */
export const writeAtomic = async (
  fs: LensFs,
  file: string,
  text: string
): Promise<void> => {
  await fs.mkdir(dirname(file));
  await fs.writeFile(`${file}.tmp`, text);
  await fs.rename(`${file}.tmp`, file);
};

/** Parsed JSON, or null when the file is missing or not JSON. */
export const readJsonOrNull = async (
  fs: LensFs,
  file: string
): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(file));
  } catch {
    return null;
  }
};

/** Reads a field (or array index) from parsed JSON without trusting its shape. */
export const field = (value: unknown, key: string | number): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string | number, unknown>)[key]
    : undefined;

/** Walks a path of fields; undefined as soon as one is missing (like `a?.b?.[0]?.c`). */
export const dig = (
  value: unknown,
  ...keys: readonly (string | number)[]
): unknown =>
  keys.reduce<unknown>((current, key) => field(current, key), value);

/**
 * Ticker list from a market-watch-bot state value: an array of strings or {symbol} objects, or an
 * object keyed by ticker. Anything else is empty.
 */
export const symbolsOf = (value: unknown): string[] => {
  if (!value) return [];
  if (!Array.isArray(value)) return Object.keys(value as object);
  return value
    .map((item: unknown) =>
      typeof item === "string" ? item : field(item, "symbol")
    )
    .filter(Boolean)
    .map(String);
};

/** market-watch-bot state directory (MWB_STATE_DIR, else ~/Github/trading/market-watch-bot/state). */
export const mwbStateDir = (io: LensIo): string =>
  io.env["MWB_STATE_DIR"] ||
  resolve(io.homeDir, "Github/trading/market-watch-bot/state");

/** Runs `task` over `items` with `width` workers; `onDone` sees the running completion count. */
export const pool = async <T>(
  items: readonly T[],
  width: number,
  task: (item: T) => Promise<void>,
  onDone: (done: number) => void
): Promise<void> => {
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await task(item);
        done += 1;
        onDone(done);
      }
    })
  );
};

/** Nasdaq screener row fields shared by both jobs. */
export type ScreenerRow = Readonly<{
  symbol: string;
  name: string | undefined;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  volume: number;
  price: number;
}>;

export const NASDAQ_SCREENER_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true";

/** Maps the Nasdaq screener download (one request) to rows; throws below 1000 rows. */
export const screenerRows = (document: unknown): ScreenerRow[] => {
  const rows = field(field(document, "data"), "rows");
  if (!Array.isArray(rows) || rows.length < 1000)
    throw new Error("Nasdaq screener returned too few rows");
  return rows.map((row: unknown) => {
    const name = field(row, "name");
    return {
      industry: (field(row, "industry") as string | undefined) || null,
      marketCap: Number(field(row, "marketCap")) || null,
      name: typeof name === "string" ? name : undefined,
      price: Number(String(field(row, "lastsale")).replace(/[$,]/g, "")) || 0,
      sector: (field(row, "sector") as string | undefined) || null,
      symbol: String(field(row, "symbol")).trim().toUpperCase(),
      volume: Number(field(row, "volume")) || 0,
    };
  });
};

/** Yahoo chart symbol: BRK.B -> BRK-B (first separator only, as in vertex-research). */
export const yahooSymbol = (symbol: string): string =>
  symbol.replace(".", "-").replace("/", "-");
