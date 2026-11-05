"use client";

import { useCallback, useLayoutEffect, useState } from "react";

// Browser-only preferences (tab, columns, sort, refresh interval). Never account data.
export const readStored = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export const writeStored = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the in-memory value still applies.
    return;
  }
};

// The first render uses the default so server and client markup match.
// The stored value loads in a layout effect (before paint), so there is no visible jump.
// `normalize` must be a stable module function.
export const useStoredState = <T,>(
  key: string,
  normalize: (value: unknown) => T
): readonly [T, (next: T) => void] => {
  const [value, setValue] = useState<T>(() => normalize(undefined));
  useLayoutEffect(() => {
    setValue(normalize(readStored(key)));
    return;
  }, [key, normalize]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      return writeStored(key, next);
    },
    [key]
  );
  return [value, update] as const;
};
