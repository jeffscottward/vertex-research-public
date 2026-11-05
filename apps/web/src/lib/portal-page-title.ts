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

export interface PortalBreadcrumb {
  /** Sidebar group of the page ("Settings" for settings pages); undefined when unknown. */
  readonly section: string | undefined;
  readonly title: string;
}

const SETTINGS_ITEMS: readonly NavigationItem[] = [
  ...SETTINGS_NAVIGATION,
  SETTINGS_ENTRY,
];

/** Breadcrumb for the top bar: the page's sidebar group, then the page title. */
export const portalBreadcrumb = (pathname: string): PortalBreadcrumb => {
  const title = portalPageTitle(pathname);
  const group = PORTAL_SIDEBAR_GROUPS.find((candidate) =>
    candidate.items.some(
      (item) => item.label === title && isNavigationItemActive(pathname, item)
    )
  );
  if (group !== undefined) return { section: group.label, title };
  const settings = SETTINGS_ITEMS.some((item) =>
    isNavigationItemActive(pathname, item)
  );
  return { section: settings ? "Settings" : undefined, title };
};
