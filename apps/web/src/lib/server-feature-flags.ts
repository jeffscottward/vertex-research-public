// What: Server-side helper for reading VERTEX_UI_FLAGS and client-override permission from env.
// Used by: apps/web/src/app/layout.tsx, apps/web/src/app/(portal)/settings/workspace/page.tsx.
import { areUiFlagClientOverridesAllowed } from "@darkfactory/config/server";

import {
  FEATURE_FLAGS_ENV_VAR,
  type FeatureFlagName,
  type FeatureFlagOverrides,
  type FeatureFlagValues,
  parseFeatureFlagTokens,
  resolveFeatureFlags,
} from "./feature-flags.ts";

export interface FeatureFlagsServerSnapshot {
  readonly allowClientOverrides: boolean;
  readonly envOverrides: FeatureFlagOverrides;
  readonly flags: FeatureFlagValues;
}

/** Reads server-side UI/research feature flags from environment bindings. */
export const getServerFeatureFlagSnapshot = (
  source: Readonly<Record<string, string | undefined>> = process.env
): FeatureFlagsServerSnapshot => {
  const allowClientOverrides = areUiFlagClientOverridesAllowed(source);
  const envOverrides = parseFeatureFlagTokens(source[FEATURE_FLAGS_ENV_VAR]);
  const flags = resolveFeatureFlags({
    allowClientOverrides: false,
    env: envOverrides,
  });
  return Object.freeze({
    allowClientOverrides,
    envOverrides,
    flags,
  });
};

/** Checks whether a single UI/research feature flag is enabled on the server. */
export const isServerFeatureFlagEnabled = (
  name: FeatureFlagName,
  source: Readonly<Record<string, string | undefined>> = process.env
): boolean => getServerFeatureFlagSnapshot(source).flags[name];
