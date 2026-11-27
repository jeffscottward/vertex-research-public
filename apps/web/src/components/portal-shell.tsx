// What: Signed-in Vertex Research workspace shell with shadcn sidebar-07 / dashboard-01 anatomy: collapsible inset sidebar (16rem, 3rem icon mode), SidebarInset, a site header with SidebarTrigger, separator, page title, assistant panel toggle and the user menu, and the assistant panel on the right. Under the page content it prints the research notice once, except on a page with an order, arming or approval control.
// Used by: apps/web/src/app/(portal)/layout.tsx.
// See: packages/ui/src/client/sidebar.tsx; apps/web/src/lib/navigation.ts#PORTAL_SIDEBAR_GROUPS; apps/web/src/components/user-menu.tsx; apps/web/src/components/portal/assistant-panel.tsx (right assistant panel); apps/web/src/lib/research-notice.ts (notice text and route rule).
"use client";

import { Button, Separator } from "@darkfactory/ui";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@darkfactory/ui/client/sidebar";
import { BellRing, ChevronRight, PanelLeft, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { ClickLogListener } from "../features/click-log/listener.tsx";
import { BrowserExperienceProvider } from "../features/experience/browser-provider.tsx";
import {
  EXPOSED_ROUTE_PATHS,
  isNavigationItemActive,
  isRouteExposed,
  type NavigationDisclosure,
  type NavigationGroup,
  type NavigationItem,
  PORTAL_SIDEBAR_DISCLOSURES,
  PORTAL_SIDEBAR_GROUPS,
  SETTINGS_NAVIGATION,
} from "../lib/navigation.ts";
import { portalBreadcrumb } from "../lib/portal-page-title.ts";
import {
  PORTAL_RESEARCH_NOTICE,
  researchNoticeApplies,
} from "../lib/research-notice.ts";
import { useUiState } from "../lib/ui-store.tsx";
import { BrandMark } from "./brand-mark.tsx";
import {
  CommandPalette,
  type PaletteItem,
  toPaletteItems,
} from "./command-palette.tsx";
import type { AssistantGateway } from "./portal/assistant-client.ts";
import {
  AssistantPanel,
  AssistantPanelProvider,
  AssistantPanelToggle,
} from "./portal/assistant-panel.tsx";
import {
  createResearchReadScope,
  observeResearchSessionScope,
  ResearchReadScopeProvider,
} from "./research/read-scope.tsx";
import {
  endResearchSession,
  subscribeToResearchSessionEnding,
} from "./research/session-ending.ts";
import { UserMenu } from "./user-menu.tsx";

interface PortalNavigationProps {
  readonly availableRoutes?: readonly string[];
}

const SIDEBAR_ITEMS: readonly NavigationItem[] = PORTAL_SIDEBAR_GROUPS.flatMap(
  (group) => group.items
);

/** A nested page (/agents/benchmark) marks only its own entry, not the parent entry (/agents). */
const isSidebarItemCurrent = (pathname: string, item: NavigationItem) =>
  isNavigationItemActive(pathname, item) &&
  !SIDEBAR_ITEMS.some(
    (other) =>
      other.href.length > item.href.length &&
      isNavigationItemActive(pathname, other)
  );

const PORTAL_NAVIGATION_ID = "portal-navigation";

/** Closes the native popover drawer after a mobile link click. */
const closePortalNavigation = () => {
  const drawer = document.getElementById(PORTAL_NAVIGATION_ID);
  const hidePopover = drawer?.hidePopover;
  if (typeof hidePopover === "function") hidePopover.call(drawer);
};

interface PortalNavigationListProps extends PortalNavigationProps {
  readonly mobile?: boolean;
}

interface PortalNavigationLinkProps {
  readonly item: NavigationItem;
  readonly mobile: boolean;
  readonly pathname: string;
}

const PortalNavigationLink = ({
  item,
  mobile,
  pathname,
}: PortalNavigationLinkProps) => {
  const active = isSidebarItemCurrent(pathname, item);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        {...(mobile ? {} : { tooltip: item.label })}
      >
        <Link
          aria-current={active ? "page" : undefined}
          href={item.href}
          {...(mobile ? { onClick: closePortalNavigation } : {})}
          prefetch={false}
        >
          <Icon aria-hidden="true" />
          <span>
            {item.label}
            {active ? <span className="sr-only">, current page</span> : null}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

interface PortalDisclosureProps {
  readonly disclosure: NavigationDisclosure;
  readonly items: readonly NavigationItem[];
  readonly mobile: boolean;
  readonly pathname: string;
}

/**
 * One collapsible entry for a disclosure's pages (backtest lab, smart money), so the sidebar
 * fits a 900px-high window. Native details/summary works before hydration; it opens on one of
 * its pages.
 */
const PortalDisclosure = ({
  disclosure,
  items,
  mobile,
  pathname,
}: PortalDisclosureProps) => {
  const open = items.some((item) => isNavigationItemActive(pathname, item));
  const Icon = disclosure.icon;
  return (
    <SidebarMenuItem>
      <details className="group/lab" data-slot={disclosure.id} open={open}>
        <SidebarMenuButton
          asChild
          {...(mobile ? {} : { tooltip: disclosure.label })}
        >
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <Icon aria-hidden="true" />
            <span>{disclosure.label}</span>
            <ChevronRight
              aria-hidden="true"
              className="ml-auto transition-transform group-open/lab:rotate-90 group-data-[collapsible=icon]:hidden"
            />
          </summary>
        </SidebarMenuButton>
        <SidebarMenu className="mt-1 ml-3.5 border-sidebar-border border-l pl-2 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:border-l-0 group-data-[collapsible=icon]:pl-0">
          {items.map((item) => (
            <PortalNavigationLink
              item={item}
              key={item.href}
              mobile={mobile}
              pathname={pathname}
            />
          ))}
        </SidebarMenu>
      </details>
    </SidebarMenuItem>
  );
};

/** Group entries in order; a disclosure entry takes the place of its first item. */
const groupEntries = (
  items: readonly NavigationItem[],
  mobile: boolean,
  pathname: string
): ReactNode[] =>
  items.flatMap((item) => {
    const disclosure = PORTAL_SIDEBAR_DISCLOSURES.find((entry) =>
      entry.hrefs.includes(item.href)
    );
    if (disclosure === undefined)
      return [
        <PortalNavigationLink
          item={item}
          key={item.href}
          mobile={mobile}
          pathname={pathname}
        />,
      ];
    const members = items.filter((entry) =>
      disclosure.hrefs.includes(entry.href)
    );
    if (item !== members[0]) return [];
    return [
      <PortalDisclosure
        disclosure={disclosure}
        items={members}
        key={disclosure.id}
        mobile={mobile}
        pathname={pathname}
      />,
    ];
  });

const PortalNavigation = ({
  availableRoutes = EXPOSED_ROUTE_PATHS,
  mobile = false,
}: PortalNavigationListProps) => {
  const pathname = usePathname() ?? "";
  const groups = PORTAL_SIDEBAR_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      isRouteExposed(item.href, availableRoutes)
    ),
  })).filter((group) => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <nav aria-label={mobile ? "Mobile portal navigation" : "Portal navigation"}>
      {groups.map((group, index) => (
        <PortalNavigationGroup
          group={group}
          key={group.label}
          mobile={mobile}
          open={
            index === 0 ||
            group.items.some((item) => isNavigationItemActive(pathname, item))
          }
          pathname={pathname}
        />
      ))}
    </nav>
  );
};

interface PortalNavigationGroupProps {
  readonly group: NavigationGroup;
  readonly mobile: boolean;
  readonly open: boolean;
  readonly pathname: string;
}

/**
 * One sidebar group as a native disclosure, so the open sidebar fits a 1440x900
 * window (owner decision 2026-10-24). The first group and the group of the current
 * page start open. In icon mode every group shows its items, because the label is hidden.
 */
const PortalNavigationGroup = ({
  group,
  mobile,
  open,
  pathname,
}: PortalNavigationGroupProps) => (
  <SidebarGroup className="py-0.5">
    <details
      className="group/section group-data-[collapsible=icon]:[&::details-content]:h-auto group-data-[collapsible=icon]:[&::details-content]:[content-visibility:visible]"
      data-slot="portal-group"
      open={open}
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <SidebarGroupLabel>
          <span>{group.label}</span>
          <ChevronRight
            aria-hidden="true"
            className="ml-auto transition-transform group-open/section:rotate-90"
          />
        </SidebarGroupLabel>
      </summary>
      <SidebarGroupContent>
        <SidebarMenu>{groupEntries(group.items, mobile, pathname)}</SidebarMenu>
      </SidebarGroupContent>
    </details>
  </SidebarGroup>
);

const PortalBrand = () => (
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton asChild className="[&>span]:p-1.5!">
        <a href="/">
          <BrandMark className="size-5!" />
          <span className="font-semibold text-base">Vertex Research</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
);

const PortalSidebar = ({
  availableRoutes = EXPOSED_ROUTE_PATHS,
}: PortalNavigationProps) => (
  <Sidebar collapsible="icon" mobileSheet={false} variant="inset">
    <SidebarHeader>
      <PortalBrand />
    </SidebarHeader>
    <SidebarContent>
      <PortalNavigation availableRoutes={availableRoutes} />
    </SidebarContent>
    <SidebarRail />
  </Sidebar>
);

/**
 * Mobile drawer: shadcn's left sheet look (18rem, bg-sidebar, border-r,
 * shadow-lg, black/50 backdrop) on the native popover API, so it opens and
 * closes before hydration and without JavaScript.
 */
const PortalMobileNavigation = ({
  availableRoutes = EXPOSED_ROUTE_PATHS,
}: PortalNavigationProps) => (
  <div
    aria-labelledby="portal-navigation-title"
    className="fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-dvh w-72 max-w-[calc(100%-3rem)] overflow-y-auto border-0 border-r bg-sidebar p-0 text-sidebar-foreground shadow-lg backdrop:bg-black/50 md:hidden"
    id={PORTAL_NAVIGATION_ID}
    popover="auto"
    role="dialog"
  >
    <div className="flex items-center justify-between gap-2 p-2">
      <h2 className="px-2 font-semibold text-base" id="portal-navigation-title">
        Navigation
      </h2>
      <button
        aria-label="Close portal navigation"
        autoFocus
        className="group/close inline-flex size-11 shrink-0 items-center justify-center outline-hidden"
        popoverTarget={PORTAL_NAVIGATION_ID}
        popoverTargetAction="hide"
        type="button"
      >
        <span className="inline-flex rounded-xs opacity-70 ring-offset-background transition-opacity group-hover/close:opacity-100 group-focus-visible/close:ring-2 group-focus-visible/close:ring-ring group-focus-visible/close:ring-offset-2">
          <X aria-hidden="true" className="size-4" />
        </span>
      </button>
    </div>
    <PortalNavigation availableRoutes={availableRoutes} mobile />
  </div>
);

/** Command palette entries: the exposed sidebar groups (core group labelled "Workspace") plus settings. */
const paletteItemsFor = (availableRoutes: readonly string[]): PaletteItem[] =>
  toPaletteItems([
    ...PORTAL_SIDEBAR_GROUPS.map((group) => ({
      group: group.label,
      items: group.items.filter((item) =>
        isRouteExposed(item.href, availableRoutes)
      ),
    })),
    {
      group: "Settings",
      items: SETTINGS_NAVIGATION.filter((item) =>
        isRouteExposed(item.href, availableRoutes)
      ),
    },
  ]);

interface PortalTopbarProps {
  readonly availableRoutes?: readonly string[];
  readonly onSessionEnding?: (() => void) | undefined;
  readonly userName: string;
}

const NOTIFICATIONS_HREF = "/price-alerts";
const SETTINGS_HREF = "/settings";

/**
 * Breadcrumb from the route: sidebar group, then the page. The group shows only in a top bar of
 * 62em or more (below, screen readers still read it), so a narrow top bar keeps the page title.
 * overflow-hidden keeps the text from painting over the search and quick actions when the
 * breadcrumb has no room.
 */
const PortalBreadcrumb = ({ pathname }: { readonly pathname: string }) => {
  const { section, title } = portalBreadcrumb(pathname);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {section === undefined ? null : (
          <li className="sr-only @min-[62em]/topbar:not-sr-only @min-[62em]/topbar:flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <span>{section}</span>
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </li>
        )}
        <li className="min-w-0">
          <p
            aria-current="page"
            className="min-w-0 flex-1 truncate font-medium text-base"
            data-slot="portal-page-title"
          >
            {title}
          </p>
        </li>
      </ol>
    </nav>
  );
};

/** Quick link in the top bar's action group (44px target). */
const TopbarLink = ({
  children,
  href,
  label,
}: {
  readonly children: ReactNode;
  readonly href: string;
  readonly label: string;
}) => (
  <Button asChild size="icon" variant="ghost">
    <Link aria-label={label} href={href} prefetch={false} title={label}>
      {children}
    </Link>
  </Button>
);

/**
 * Top bar (Fulcrum reference, owner 2026-11-04): breadcrumb left, a search box in the
 * middle that opens the command palette (Ctrl/Cmd+K), quick actions right. Below md the
 * trigger opens the native popover drawer; from md it collapses the sidebar.
 */
const PortalTopbar = ({
  availableRoutes = EXPOSED_ROUTE_PATHS,
  onSessionEnding,
  userName,
}: PortalTopbarProps) => {
  const pathname = usePathname() ?? "";
  return (
    // Sticky below lg so the assistant toggle stays reachable after scrolling on phones; it stays
    // in flow (no layout shift) and keeps the original static header from lg up.
    // The top bar is the `topbar` size container: from md the sidebar (and from lg the docked
    // assistant panel) narrows it, so its controls drop by the top bar's width, not the viewport's.
    // The thresholds are in em: in a container query em is the top bar's font size, so they grow
    // with the Font size preference (--font-scale) while the root font size stays 16px. Do not set
    // a font size on the header or its ancestors: it would move every threshold.
    <header
      className="@container/topbar sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background transition-[width,height] ease-in-out group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height) lg:static lg:z-auto lg:bg-transparent"
      data-slot="portal-topbar"
    >
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <Button
          aria-label="Open portal navigation"
          className="-m-2 md:hidden [&>[data-slot=button-chrome]]:size-7"
          popoverTarget={PORTAL_NAVIGATION_ID}
          popoverTargetAction="toggle"
          size="icon"
          variant="ghost"
        >
          <PanelLeft aria-hidden="true" />
        </Button>
        <PortalMobileNavigation availableRoutes={availableRoutes} />
        <SidebarTrigger
          className="hidden md:inline-flex"
          label="Toggle sidebar"
        />
        <Separator
          className="mx-2 data-[orientation=vertical]:h-4"
          orientation="vertical"
        />
        {/* The breadcrumb gives way first (its group below 62em of top bar), then the
            user name (below 52em), the search shortcut hint (below 38em), the search
            box text (below 35em) and the notifications and settings links (below 30em;
            the sidebar links to price alerts, the user menu to settings), so the header fits
            every width without sideways scroll (WCAG 1.4.10 reflow). */}
        <PortalBreadcrumb pathname={pathname} />
        <div
          className="flex @min-[35em]/topbar:flex-1 shrink-0 justify-center"
          data-slot="portal-search-slot"
        >
          <CommandPalette
            items={paletteItemsFor(availableRoutes)}
            trigger="search"
          />
        </div>
        <div
          className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2"
          data-slot="portal-quick-actions"
        >
          {isRouteExposed(NOTIFICATIONS_HREF, availableRoutes) ? (
            <span className="hidden md:@min-[30em]/topbar:inline-flex">
              <TopbarLink href={NOTIFICATIONS_HREF} label="Notifications">
                <BellRing aria-hidden="true" />
              </TopbarLink>
            </span>
          ) : null}
          {isRouteExposed(SETTINGS_HREF, availableRoutes) ? (
            <span className="hidden md:@min-[30em]/topbar:inline-flex">
              <TopbarLink href={SETTINGS_HREF} label="Settings">
                <Settings aria-hidden="true" />
              </TopbarLink>
            </span>
          ) : null}
          <AssistantPanelToggle />
          <UserMenu
            availableRoutes={availableRoutes}
            name={userName}
            onSessionEnding={onSessionEnding}
          />
        </div>
      </div>
    </header>
  );
};

/**
 * The research notice, printed once under the page content. A page with an order, arming or
 * approval control gets no notice: apps/web/src/lib/research-notice.ts holds the route rule.
 */
const PortalResearchNotice = () => {
  return researchNoticeApplies(usePathname()) ? (
    <p
      className="mt-2 text-muted-foreground text-xs"
      data-slot="portal-research-notice"
      role="note"
    >
      {PORTAL_RESEARCH_NOTICE}
    </p>
  ) : null;
};

export interface PortalShellProps {
  /** Assistant panel transport (tests); the browser gateway by default. */
  readonly assistantGateway?: AssistantGateway;
  readonly availableRoutes?: readonly string[];
  readonly children: ReactNode;
  /** The saved assistant panel choice from the request cookie; undefined when there is none. */
  readonly initialAssistantPanelOpen?: boolean | undefined;
  readonly isAdmin?: boolean;
  /**
   * Trusted principal key (user, role, session expiry) from the server layout.
   * When set, research reads stay blocked until the browser session matches it.
   */
  readonly sessionScopeKey?: string;
  readonly userName: string;
}

export const PortalShell = ({
  assistantGateway,
  availableRoutes = EXPOSED_ROUTE_PATHS,
  children,
  initialAssistantPanelOpen,
  sessionScopeKey,
  userName,
}: PortalShellProps) => {
  const sidebar = useUiState((state) => state.sidebar);
  const setSidebar = useUiState((state) => state.setSidebar);
  const [scope] = useState(() =>
    createResearchReadScope(sessionScopeKey === undefined)
  );
  useEffect(() => subscribeToResearchSessionEnding(scope), [scope]);
  useEffect(() => {
    if (sessionScopeKey === undefined) return;
    return observeResearchSessionScope(scope, sessionScopeKey);
  }, [scope, sessionScopeKey]);
  useEffect(() => {
    // Back/forward cache restores and page hides retire session-scoped reads.
    const retire = () => scope.invalidate();
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) scope.invalidate();
    };
    window.addEventListener("pagehide", retire);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("pageshow", restore);
    };
  }, [scope]);
  return (
    <ResearchReadScopeProvider scope={scope}>
      <ClickLogListener />
      <AssistantPanelProvider
        availableRoutes={availableRoutes}
        initialOpen={initialAssistantPanelOpen}
      >
        <SidebarProvider
          className="vx-workspace"
          onOpenChange={(open) => setSidebar(open ? "expanded" : "collapsed")}
          open={sidebar === "expanded"}
        >
          <PortalSidebar availableRoutes={availableRoutes} />
          <SidebarInset className="min-w-0" id="main-content" tabIndex={-1}>
            <PortalTopbar
              availableRoutes={availableRoutes}
              onSessionEnding={() => endResearchSession(scope)}
              userName={userName}
            />
            <div className="flex flex-1 flex-col">
              <div className="@container/main flex flex-1 flex-col gap-2">
                <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
                  <BrowserExperienceProvider>
                    {children}
                  </BrowserExperienceProvider>
                  <PortalResearchNotice />
                </div>
              </div>
            </div>
          </SidebarInset>
          <AssistantPanel
            {...(assistantGateway === undefined
              ? {}
              : { gateway: assistantGateway })}
          />
        </SidebarProvider>
      </AssistantPanelProvider>
    </ResearchReadScopeProvider>
  );
};
