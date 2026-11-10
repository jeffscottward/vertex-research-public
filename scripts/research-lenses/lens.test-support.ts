// Test doubles for the research-lens jobs: an in-memory file system and a scripted IO.

import { dirname } from "node:path";
import type { LensFetch, LensFs, LensIo } from "./lens-io.ts";

export type MemoryFs = Readonly<{
  fs: LensFs;
  files: Map<string, string>;
}>;

const enoent = (path: string): Error =>
  Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

/** Files keyed by absolute path; directories exist implicitly (or once made with mkdir). */
export const memoryFs = (initial: Record<string, string> = {}): MemoryFs => {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>();
  const under = (path: string): string[] =>
    [...files.keys(), ...dirs].filter((key) => key.startsWith(`${path}/`));
  const fs: LensFs = {
    exists: (path) => files.has(path),
    mkdir: async (path) => {
      dirs.add(path);
      return;
    },
    readdir: async (path) => {
      const children = under(path).map(
        (key) => key.slice(path.length + 1).split("/")[0] as string
      );
      if (children.length === 0 && !dirs.has(path)) throw enoent(path);
      return [...new Set(children)];
    },
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw enoent(path);
      return text;
    },
    rename: async (from, to) => {
      files.set(to, files.get(from) as string);
      files.delete(from);
      dirs.add(dirname(to));
    },
    rm: async (path) => {
      for (const key of under(path)) {
        files.delete(key);
        dirs.delete(key);
      }
      dirs.delete(path);
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
  };
  return { files, fs };
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

export type TestIo = Readonly<{
  io: LensIo;
  files: Map<string, string>;
  stderr: string[];
  sleeps: number[];
  requests: string[];
}>;

export const NOW = new Date("2026-11-10T12:00:00.000Z");

/** A LensIo over memory files and a scripted fetch; records stderr, sleeps and request URLs. */
export const testIo = (
  options: Readonly<{
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
    fetch?: LensFetch;
    files?: Record<string, string>;
  }> = {}
): TestIo => {
  const memory = memoryFs(options.files);
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const requests: string[] = [];
  const fetch = options.fetch ?? (async () => jsonResponse({}, 404));
  const io: LensIo = {
    argv: ["bun", "job.ts", ...(options.argv ?? [])],
    env: options.env ?? { MWB_STATE_DIR: "/state" },
    fetch: (url, init) => {
      requests.push(url);
      return fetch(url, init);
    },
    fs: memory.fs,
    homeDir: "/home/test",
    now: () => NOW,
    rootDir: "/repo",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        return true;
      },
    },
  };
  return { files: memory.files, io, requests, sleeps, stderr };
};

/** A Nasdaq screener download with `count` rows built by `row(i)` (at least 1000 to pass the check). */
export const screenerDocument = (
  count: number,
  row: (i: number) => Record<string, unknown>
): unknown => ({
  data: { rows: Array.from({ length: count }, (_, i) => row(i)) },
});

/** Yahoo chart document: one bar per day ending 2026-11-09, closes as given. */
export const yahooChart = (
  closes: readonly (number | null)[],
  options: Readonly<{
    adjusted?: boolean;
    endDay?: string;
    meta?: Record<string, unknown>;
    volume?: number;
  }> = {}
): unknown => {
  const end = Date.parse(`${options.endDay ?? "2026-11-09"}T14:30:00Z`) / 1000;
  const timestamp = closes.map(
    (_, i) => end - (closes.length - 1 - i) * 86_400
  );
  const quote = {
    close: closes,
    volume: closes.map(() => options.volume ?? 1_000_000),
  };
  return {
    chart: {
      result: [
        {
          indicators: {
            quote: [quote],
            ...(options.adjusted === false
              ? {}
              : { adjclose: [{ adjclose: closes }] }),
          },
          meta: options.meta ?? {},
          timestamp,
        },
      ],
    },
  };
};
