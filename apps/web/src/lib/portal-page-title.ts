// What: Portal page title: the most specific navigation label that matches a pathname.
// Used by: apps/web/src/components/portal-shell.tsx (site header); apps/web/src/components/portal/assistant-panel.tsx (page context).
// See: apps/web/src/lib/navigation.ts#PORTAL_SIDEBAR_GROUPS.
import {
  isNavigationItemActive,
  type NavigationItem,
  PORTAL_SIDEBAR_GROUPS,
  SETTINGS_ENTRY,
  SETTINGS_NAVIGATION,
} from "./navigation.ts";

const TITLE_SOURCES: readonly NavigationItem[] = [
  ...PORTAL_SIDEBAR_GROUPS.flatMap((group) => group.items),
  ...SETTINGS_NAVIGATION,
  SETTINGS_ENTRY,
];

/** Page title for the site header: the most specific matching navigation label. */
export const portalPageTitle = (pathname: string): string =>
  TITLE_SOURCES.filter((item) => isNavigationItemActive(pathname, item)).sort(
    (left, right) => right.href.length - left.href.length
  )[0]?.label ?? "Vertex Research";
