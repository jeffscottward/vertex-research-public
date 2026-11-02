import { parseAppearancePreference } from "@darkfactory/state";

import {
  type AnonymousThemePreference,
  DEFAULT_ANONYMOUS_THEME,
  parseThemeCookieHeader,
  type ThemeCookieParseResult,
} from "./theme.ts";

export type TrustedThemePreferenceLoader = () => Promise<unknown>;
export const INDETERMINATE_THEME = Symbol("indeterminate-theme");

/*
 * vinext calls each layout twice per request: a probe pass (vinext
 * server/app-page-probe.js, app-page-execution.js) and then the render.
 * React `cache()` does not span the probe, so without this each RootLayout
 * request opened two request DB scopes for the same theme read. `headers()`
 * returns one object per request, so keying on it shares one load inside a
 * request and never across requests; a failed load stays with its request.
 */
const trustedThemeLoads = new WeakMap<object, Promise<unknown>>();

export const loadTrustedThemeOncePerRequest = (
  requestKey: object,
  load: TrustedThemePreferenceLoader
): Promise<unknown> => {
  const pending = trustedThemeLoads.get(requestKey);
  if (pending !== undefined) return pending;
  const started = load();
  trustedThemeLoads.set(requestKey, started);
  return started;
};

const TRUSTED_KEYS = Object.freeze([
  "theme",
  "fontSize",
  "density",
  "radius",
  "updatedAt",
]);

const parseTrustedPreference = (
  value: unknown
): Readonly<AnonymousThemePreference> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const updatedAt = record["updatedAt"];
  if (
    keys.length !== TRUSTED_KEYS.length ||
    !keys.every((key) => TRUSTED_KEYS.includes(key)) ||
    !(
      updatedAt === null ||
      (updatedAt instanceof Date && Number.isFinite(updatedAt.getTime()))
    )
  )
    return null;
  return parseAppearancePreference(record);
};

export interface ResolvedRequestTheme {
  readonly authority: "indeterminate" | "anonymous" | "trusted";
  readonly cookie: ThemeCookieParseResult;
  readonly preference: Readonly<AnonymousThemePreference>;
}

export const resolveRequestTheme = async ({
  cookieHeader,
  loadTrustedPreference = async () => undefined,
}: {
  readonly cookieHeader: unknown;
  readonly loadTrustedPreference?: TrustedThemePreferenceLoader;
}): Promise<ResolvedRequestTheme> => {
  const trustedPreference = await loadTrustedPreference();
  const cookie = parseThemeCookieHeader(cookieHeader);
  if (trustedPreference === INDETERMINATE_THEME) {
    return {
      authority: "indeterminate",
      cookie,
      preference: DEFAULT_ANONYMOUS_THEME,
    };
  }
  if (trustedPreference !== undefined) {
    return {
      authority: "trusted",
      cookie,
      preference:
        parseTrustedPreference(trustedPreference) ?? DEFAULT_ANONYMOUS_THEME,
    };
  }
  return {
    authority: "anonymous",
    cookie,
    preference:
      cookie.status === "valid" ? cookie.preference : DEFAULT_ANONYMOUS_THEME,
  };
};
