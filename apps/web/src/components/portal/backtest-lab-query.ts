// URL query state, a debounce hook and a small result cache for the Backtest lab pages
// (/setup-replay, /backtest-sweeps, /strategy-builder, /backtest-runs, /portfolio-combos,
// /autopilot). Each page opens with a default state; its choices live in the address bar so a
// view can be linked and restored. A missing or unknown parameter falls back to the default.

import { useEffect, useState } from "react";
import { z } from "zod";

/** The current query string, or "" during server rendering. */
export const currentSearch = (): string =>
  typeof window === "undefined" ? "" : window.location.search;

// The URL is untrusted input, so every parameter is parsed with Zod at this boundary.
const ParamSchema = z.string().trim().min(1);

const oneOf = <T extends string | number>(allowed: readonly T[]) =>
  z.custom<T>((value) => allowed.some((entry) => entry === value));

/** A non-empty trimmed parameter value, or null. */
export const readParam = (search: string, name: string): string | null => {
  const parsed = ParamSchema.safeParse(new URLSearchParams(search).get(name));
  return parsed.success ? parsed.data : null;
};

/** The parameter when it is one of `allowed`, else `fallback`. */
export const pickParam = <T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T => {
  const parsed = oneOf(allowed).safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

/** The parameter as one of the `allowed` numbers, else `fallback`. */
export const pickNumberParam = <T extends number>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T => {
  const parsed = z
    .string()
    .transform(Number)
    .pipe(oneOf(allowed))
    .safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

const ListSchema = z
  .string()
  .transform((raw) => raw.split(","))
  .pipe(z.array(z.string().trim()))
  .transform((values) => [...new Set(values.filter((entry) => entry !== ""))]);

/** The parameter as a list of unique non-empty comma-separated values, at most `limit`. */
export const readListParam = (
  search: string,
  name: string,
  limit: number
): string[] => {
  const parsed = ListSchema.safeParse(readParam(search, name));
  return parsed.success ? parsed.data.slice(0, limit) : [];
};

export type QueryUpdates = Readonly<
  Record<string, string | number | null | undefined>
>;

/**
 * Returns `search` with each update applied, keeping other parameters. Null, undefined, "" and a
 * value equal to its entry in `defaults` remove the parameter, so default views keep clean URLs.
 */
export const withQuery = (
  search: string,
  updates: QueryUpdates,
  defaults: QueryUpdates = {}
): string => {
  const params = new URLSearchParams(search);
  for (const [name, raw] of Object.entries(updates)) {
    const value = raw === null || raw === undefined ? "" : String(raw);
    const fallback = defaults[name];
    if (
      value === "" ||
      (fallback !== null &&
        fallback !== undefined &&
        value === String(fallback))
    ) {
      params.delete(name);
    } else params.set(name, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** Writes the updates to the address bar without a navigation or a history entry. */
export const writeQuery = (
  updates: QueryUpdates,
  defaults: QueryUpdates = {}
): void => {
  if (typeof window === "undefined") return;
  const { hash, pathname, search } = window.location;
  const next = withQuery(search, updates, defaults);
  if (next === search) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${next}${hash}`
  );
};

/** `value`, updated only after it stays unchanged for `delayMs`. */
export const useDebouncedValue = <T>(value: T, delayMs: number): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
};

export type ResultCache<V> = Readonly<{
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
}>;

/** A least-recently-used cache that keeps at most `limit` results. */
export const createResultCache = <V>(limit: number): ResultCache<V> => {
  const entries = new Map<string, V>();
  return {
    get: (key) => {
      if (!entries.has(key)) return;
      const value = entries.get(key) as V;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break;
        entries.delete(oldest);
      }
    },
  };
};

/** A stable cache key for a JSON-serialisable request. */
export const cacheKey = (input: unknown): string => JSON.stringify(input);
