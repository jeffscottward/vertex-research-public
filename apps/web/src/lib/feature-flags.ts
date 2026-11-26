// What: Minimal, typed UI/research feature-flag registry and deterministic resolver.
// Used by: apps/web/src/lib/server-feature-flags.ts, apps/web/src/components/feature-flags-provider.tsx,
//          apps/web/src/components/feature-flags-panel.tsx.
// Guard: UI and research views only. Never gate or alter execution, live orders, arming, or risk settings.

export type FeatureFlagArea = "ui" | "research";

export interface FeatureFlagDefinition {
  readonly area: FeatureFlagArea;
  readonly defaultEnabled: false;
  readonly description: string;
  readonly label: string;
}

/**
 * Typed registry of experimental UI/research flags.
 * Every flag defaults off so prototypes ship dark without altering production views.
 */
export const FEATURE_FLAG_REGISTRY = Object.freeze({
  "research-prototype-slot": Object.freeze({
    area: "research",
    defaultEnabled: false,
    description:
      "Shows an opt-in research prototype callout in Workspace settings for staging experimental research views.",
    label: "Research prototype callout",
  }),
  "ui-experiments-panel": Object.freeze({
    area: "ui",
    defaultEnabled: false,
    description:
      "Shows a non-invasive experimental UI preview banner in Workspace settings to verify flag isolation.",
    label: "Experimental UI preview banner",
  }),
} as const satisfies Readonly<Record<string, FeatureFlagDefinition>>);

export type FeatureFlagName = keyof typeof FEATURE_FLAG_REGISTRY;

export type FeatureFlagValues = Readonly<Record<FeatureFlagName, boolean>>;

export type FeatureFlagOverrides = Readonly<
  Partial<Record<FeatureFlagName, boolean>>
>;

export type FeatureFlagSource = "default" | "env" | "localStorage" | "query";

export interface ResolvedFeatureFlag {
  readonly enabled: boolean;
  readonly name: FeatureFlagName;
  readonly source: FeatureFlagSource;
}

export interface ResolveFeatureFlagsInput {
  readonly allowClientOverrides?: boolean;
  readonly env?: FeatureFlagOverrides;
  readonly localStorage?: FeatureFlagOverrides;
  readonly query?: FeatureFlagOverrides;
}

export const FEATURE_FLAGS_ENV_VAR = "VERTEX_UI_FLAGS" as const;
export const FEATURE_FLAGS_QUERY_PARAM = "ff" as const;
export const FEATURE_FLAGS_STORAGE_KEY = "vertex.ui-flags.v1" as const;

const MAX_FEATURE_FLAG_INPUT_LENGTH = 2048;

export const FEATURE_FLAG_NAMES: readonly FeatureFlagName[] = Object.freeze(
  Object.keys(FEATURE_FLAG_REGISTRY) as FeatureFlagName[]
);

export const DEFAULT_FEATURE_FLAGS: FeatureFlagValues = Object.freeze(
  FEATURE_FLAG_NAMES.reduce(
    (flags, name) => {
      flags[name] = FEATURE_FLAG_REGISTRY[name].defaultEnabled;
      return flags;
    },
    {} as Record<FeatureFlagName, boolean>
  )
);

const isFeatureFlagName = (value: string): value is FeatureFlagName =>
  Object.hasOwn(FEATURE_FLAG_REGISTRY, value);

const parseBooleanToken = (value: string): boolean | undefined => {
  switch (value.toLowerCase()) {
    case "1":
    case "on":
    case "true":
      return true;
    case "0":
    case "false":
    case "off":
      return false;
    default:
      return undefined;
  }
};

/**
 * Parses a comma-separated flag list (env, query, or localStorage) into typed overrides.
 * Supports: `flag`, `flag=on|off|true|false|1|0`, `-flag`, `!flag`.
 * Unrecognized names and malformed values are ignored safely without throwing.
 */
export const parseFeatureFlagTokens = (
  raw: string | null | undefined
): FeatureFlagOverrides => {
  if (typeof raw !== "string") return Object.freeze({});
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FEATURE_FLAG_INPUT_LENGTH) {
    return Object.freeze({});
  }
  const overrides: Partial<Record<FeatureFlagName, boolean>> = {};
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    if (token.startsWith("-") || token.startsWith("!")) {
      const name = token.slice(1).trim().toLowerCase();
      if (isFeatureFlagName(name)) overrides[name] = false;
      continue;
    }
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      const name = token.toLowerCase();
      if (isFeatureFlagName(name)) overrides[name] = true;
      continue;
    }
    const name = token.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = token.slice(separatorIndex + 1).trim();
    const parsed = parseBooleanToken(rawValue);
    if (isFeatureFlagName(name) && parsed !== undefined) {
      overrides[name] = parsed;
    }
  }
  return Object.freeze(overrides);
};

/**
 * Canonical serialization for localStorage persistence in registry order: `flag=on,other=off`.
 */
export const serializeFeatureFlagOverrides = (
  overrides: FeatureFlagOverrides
): string =>
  FEATURE_FLAG_NAMES.flatMap((name) => {
    const value = overrides[name];
    return typeof value === "boolean"
      ? [`${name}=${value ? "on" : "off"}`]
      : [];
  }).join(",");

/**
 * Extracts `?ff=...` query overrides (supports comma lists and repeated `ff` params).
 */
export const parseFeatureFlagSearchParams = (
  search: string | URLSearchParams
): FeatureFlagOverrides => {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const merged: Partial<Record<FeatureFlagName, boolean>> = {};
  for (const value of params.getAll(FEATURE_FLAGS_QUERY_PARAM)) {
    Object.assign(merged, parseFeatureFlagTokens(value));
  }
  return Object.freeze(merged);
};

/**
 * Resolves every registered flag with precedence:
 * query (when client overrides allowed) > localStorage (when allowed) > env > default (false).
 */
export const resolveFeatureFlagEntries = (
  input: ResolveFeatureFlagsInput = {}
): readonly ResolvedFeatureFlag[] => {
  const allowClientOverrides = input.allowClientOverrides === true;
  const env = input.env ?? {};
  const localStorage = allowClientOverrides ? (input.localStorage ?? {}) : {};
  const query = allowClientOverrides ? (input.query ?? {}) : {};

  return Object.freeze(
    FEATURE_FLAG_NAMES.map((name): ResolvedFeatureFlag => {
      if (typeof query[name] === "boolean") {
        return Object.freeze({ enabled: query[name], name, source: "query" });
      }
      if (typeof localStorage[name] === "boolean") {
        return Object.freeze({
          enabled: localStorage[name],
          name,
          source: "localStorage",
        });
      }
      if (typeof env[name] === "boolean") {
        return Object.freeze({ enabled: env[name], name, source: "env" });
      }
      return Object.freeze({
        enabled: FEATURE_FLAG_REGISTRY[name].defaultEnabled,
        name,
        source: "default",
      });
    })
  );
};

/** Resolves effective boolean values for every registered flag. */
export const resolveFeatureFlags = (
  input: ResolveFeatureFlagsInput = {}
): FeatureFlagValues => {
  const values = {} as Record<FeatureFlagName, boolean>;
  for (const entry of resolveFeatureFlagEntries(input)) {
    values[entry.name] = entry.enabled;
  }
  return Object.freeze(values);
};
