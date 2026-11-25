// What: Client React context, hooks, and declarative gate for experimental UI/research feature flags.
// Used by: apps/web/src/app/layout.tsx, apps/web/src/components/feature-flags-panel.tsx,
//          apps/web/src/lab/entries/data-settings.tsx.
"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_STORAGE_KEY,
  type FeatureFlagName,
  type FeatureFlagOverrides,
  type FeatureFlagValues,
  parseFeatureFlagSearchParams,
  parseFeatureFlagTokens,
  type ResolvedFeatureFlag,
  resolveFeatureFlagEntries,
  resolveFeatureFlags,
  serializeFeatureFlagOverrides,
} from "../lib/feature-flags.ts";

export interface FeatureFlagsContextValue {
  readonly allowClientOverrides: boolean;
  readonly clearOverrides: () => void;
  readonly flags: FeatureFlagValues;
  readonly localOverrides: FeatureFlagOverrides;
  readonly queryOverrides: FeatureFlagOverrides;
  readonly resolved: readonly ResolvedFeatureFlag[];
  readonly setOverride: (name: FeatureFlagName, value: boolean | null) => void;
}

const EMPTY_OVERRIDES: FeatureFlagOverrides = Object.freeze({});
const NOOP = (): void => undefined;

const DEFAULT_CONTEXT: FeatureFlagsContextValue = Object.freeze({
  allowClientOverrides: false,
  clearOverrides: NOOP,
  flags: DEFAULT_FEATURE_FLAGS,
  localOverrides: EMPTY_OVERRIDES,
  queryOverrides: EMPTY_OVERRIDES,
  resolved: resolveFeatureFlagEntries(),
  setOverride: NOOP,
});

const FeatureFlagsContext =
  createContext<FeatureFlagsContextValue>(DEFAULT_CONTEXT);

const readStoredOverrides = (): FeatureFlagOverrides => {
  try {
    return parseFeatureFlagTokens(
      window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)
    );
  } catch {
    return EMPTY_OVERRIDES;
  }
};

const writeStoredOverrides = (overrides: FeatureFlagOverrides): void => {
  try {
    const serialized = serializeFeatureFlagOverrides(overrides);
    if (serialized.length === 0) {
      window.localStorage.removeItem(FEATURE_FLAGS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, serialized);
  } catch {
    // Ignore storage quota or private-mode security errors; in-memory state still updates.
  }
};

export interface FeatureFlagsProviderProps {
  readonly allowClientOverrides?: boolean;
  readonly children: ReactNode;
  readonly envOverrides?: FeatureFlagOverrides | undefined;
  /** Optional explicit query source (used by UI lab entries to pass route searchParams). */
  readonly initialQuery?: string | URLSearchParams | undefined;
}

export const FeatureFlagsProvider = ({
  allowClientOverrides = false,
  children,
  envOverrides = EMPTY_OVERRIDES,
  initialQuery,
}: FeatureFlagsProviderProps) => {
  const pathname = usePathname();
  const [localOverrides, setLocalOverrides] =
    useState<FeatureFlagOverrides>(EMPTY_OVERRIDES);
  const localOverridesRef = useRef<FeatureFlagOverrides>(EMPTY_OVERRIDES);
  const [browserQueryOverrides, setBrowserQueryOverrides] =
    useState<FeatureFlagOverrides>(EMPTY_OVERRIDES);

  const explicitQueryKey =
    initialQuery === undefined
      ? null
      : typeof initialQuery === "string"
        ? initialQuery
        : initialQuery.toString();

  const explicitQueryOverrides = useMemo(
    () =>
      explicitQueryKey === null
        ? null
        : parseFeatureFlagSearchParams(explicitQueryKey),
    [explicitQueryKey]
  );

  const queryOverrides = explicitQueryOverrides ?? browserQueryOverrides;

  // Sync localStorage overrides on mount and across tabs.
  useEffect(() => {
    if (!allowClientOverrides) {
      localOverridesRef.current = EMPTY_OVERRIDES;
      setLocalOverrides(EMPTY_OVERRIDES);
      return;
    }
    const stored = readStoredOverrides();
    localOverridesRef.current = stored;
    setLocalOverrides(stored);
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === FEATURE_FLAGS_STORAGE_KEY) {
        const refreshed = readStoredOverrides();
        localOverridesRef.current = refreshed;
        setLocalOverrides(refreshed);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [allowClientOverrides]);

  // Sync browser ?ff= query overrides on route changes (pathname) and browser history navigation.
  useEffect(() => {
    if (!allowClientOverrides || explicitQueryKey !== null) {
      setBrowserQueryOverrides(EMPTY_OVERRIDES);
      return;
    }
    const syncQuery = (): void => {
      setBrowserQueryOverrides(
        parseFeatureFlagSearchParams(window.location.search)
      );
    };
    syncQuery();
    window.addEventListener("popstate", syncQuery);
    return () => {
      window.removeEventListener("popstate", syncQuery);
    };
  }, [allowClientOverrides, explicitQueryKey, pathname]);

  const setOverride = useCallback(
    (name: FeatureFlagName, enabled: boolean | null): void => {
      if (!allowClientOverrides) return;
      const next: Partial<Record<FeatureFlagName, boolean>> = {
        ...localOverridesRef.current,
      };
      if (enabled === null) {
        delete next[name];
      } else {
        next[name] = enabled;
      }
      const frozen = Object.freeze(next);
      writeStoredOverrides(frozen);
      localOverridesRef.current = frozen;
      setLocalOverrides(frozen);
    },
    [allowClientOverrides]
  );

  const clearOverrides = useCallback((): void => {
    if (!allowClientOverrides) return;
    writeStoredOverrides(EMPTY_OVERRIDES);
    localOverridesRef.current = EMPTY_OVERRIDES;
    setLocalOverrides(EMPTY_OVERRIDES);
  }, [allowClientOverrides]);

  const value = useMemo<FeatureFlagsContextValue>(() => {
    const resolved = resolveFeatureFlagEntries({
      allowClientOverrides,
      env: envOverrides,
      localStorage: localOverrides,
      query: queryOverrides,
    });
    const flags = resolveFeatureFlags({
      allowClientOverrides,
      env: envOverrides,
      localStorage: localOverrides,
      query: queryOverrides,
    });
    return Object.freeze({
      allowClientOverrides,
      clearOverrides,
      flags,
      localOverrides: allowClientOverrides ? localOverrides : EMPTY_OVERRIDES,
      queryOverrides: allowClientOverrides ? queryOverrides : EMPTY_OVERRIDES,
      resolved,
      setOverride,
    });
  }, [
    allowClientOverrides,
    clearOverrides,
    envOverrides,
    localOverrides,
    queryOverrides,
    setOverride,
  ]);

  return (
    <FeatureFlagsContext.Provider value={value}>
      {children}
    </FeatureFlagsContext.Provider>
  );
};

export const useFeatureFlags = (): FeatureFlagsContextValue =>
  useContext(FeatureFlagsContext);

export const useFeatureFlag = (name: FeatureFlagName): boolean =>
  useFeatureFlags().flags[name];

export interface FeatureGateProps {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly flag: FeatureFlagName;
}

export const FeatureGate = ({
  children,
  fallback = null,
  flag,
}: FeatureGateProps): ReactNode => (useFeatureFlag(flag) ? children : fallback);
