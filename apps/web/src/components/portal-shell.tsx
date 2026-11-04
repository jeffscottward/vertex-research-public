// What: Signed-in Vertex Research workspace shell with shadcn sidebar-07 / dashboard-01 anatomy: collapsible inset sidebar (16rem, 3rem icon mode), SidebarInset, a site header with SidebarTrigger, separator, page title, assistant panel toggle and the user menu, and the assistant panel on the right.
// Used by: apps/web/src/app/(portal)/layout.tsx.
// See: packages/ui/src/client/sidebar.tsx; apps/web/src/lib/navigation.ts#PORTAL_SIDEBAR_GROUPS; apps/web/src/components/user-menu.tsx; apps/web/src/components/portal/assistant-panel.tsx (right assistant panel).
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
import { ChevronRight, PanelLeft, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { ClickLogListener } from "../features/click-log/listener.tsx";
import { BrowserExperienceProvider } from "../features/experience/browser-provider.tsx";
import {
  EXPOSED_ROUTE_PATHS,
  isNavigationItemActive,
  isRouteExposed,
  type NavigationGroup,
  type NavigationItem,
  PORTAL_BACKTEST_LAB,
  PORTAL_SIDEBAR_GROUPS,
  SETTINGS_NAVIGATION,
} from "../lib/navigation.ts";
import { portalPageTitle } from "../lib/portal-page-title.ts";
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

interface PortalBacktestLabProps {
  readonly items: readonly NavigationItem[];
  readonly mobile: boolean;
  readonly pathname: string;
}

/**
 * One collapsible entry for the backtest lab pages, so the sidebar fits a 900px-high
 * window. Native details/summary works before hydration; it opens on a lab page.
 */
const PortalBacktestLab = ({
  items,
  mobile,
  pathname,
}: PortalBacktestLabProps) => {
  const open = items.some((item) => isNavigationItemActive(pathname, item));
  const Icon = PORTAL_BACKTEST_LAB.icon;
  return (
    <SidebarMenuItem>
      <details className="group/lab" data-slot="backtest-lab" open={open}>
        <SidebarMenuButton
          asChild
          {...(mobile ? {} : { tooltip: PORTAL_BACKTEST_LAB.label })}
        >
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <Icon aria-hidden="true" />
            <span>{PORTAL_BACKTEST_LAB.label}</span>
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

/** Group entries in order; the lab entry takes the place of its first item. */
const groupEntries = (
  items: readonly NavigationItem[],
  mobile: boolean,
  pathname: string
): ReactNode[] => {
  const lab = items.filter((item) =>
    PORTAL_BACKTEST_LAB.hrefs.includes(item.href)
  );
  return items.flatMap((item) => {
    if (!lab.includes(item)) {
      return [
        <PortalNavigationLink
          item={item}
          key={item.href}
          mobile={mobile}
          pathname={pathname}
        />,
      ];
    }
    if (item !== lab[0]) return [];
    return [
      <PortalBacktestLab
        items={lab}
        key="backtest-lab"
        mobile={mobile}
        pathname={pathname}
      />,
    ];
  });
};

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

/** dashboard-01 SiteHeader. Below md the trigger opens the native popover drawer; from md it collapses the sidebar. */
const PortalTopbar = ({
  availableRoutes = EXPOSED_ROUTE_PATHS,
  onSessionEnding,
  userName,
}: PortalTopbarProps) => {
  const pathname = usePathname() ?? "";
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
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
        {/* The title gives way first: with the command palette and user menu the
            header must still fit 375px (WCAG 1.4.10 reflow). */}
        <p
          className="min-w-0 flex-1 truncate font-medium text-base"
          data-slot="portal-page-title"
        >
          {portalPageTitle(pathname)}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <CommandPalette items={paletteItemsFor(availableRoutes)} />
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
