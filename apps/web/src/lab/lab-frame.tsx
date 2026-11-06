// What: Portal-like frame for UI lab entries: the portal sidebar look (same groups, icons and inset) and
// a top bar, so lab screenshots look like the real page. Links go to lab entries, never to live pages.
// Used by: apps/web/src/lab/lab-views.tsx.
// See: apps/web/src/components/portal-shell.tsx (the real shell; owned by vertex-ui-shell, not imported here).
"use client";

import { Badge, Button, Separator } from "@darkfactory/ui";
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
import { ChevronRight, FlaskConical, PanelLeft } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import {
  type NavigationGroup,
  type NavigationItem,
  PORTAL_SIDEBAR_GROUPS,
} from "../lib/navigation.ts";
import { LAB_THEME_ATTRIBUTE, type LabTheme } from "./params.ts";
import {
  findLabEntryForRoute,
  type LabEntry,
  labEntryHref,
} from "./registry.ts";

/** Sidebar item -> lab entry href; null when no entry stands for that route. */
export const labSidebarHref = (
  entries: readonly LabEntry[],
  item: NavigationItem
): string | null => {
  const entry = findLabEntryForRoute(entries, item.href);
  return entry === undefined ? null : labEntryHref(entry.id);
};

const LabSidebarGroup = ({
  activeRoute,
  entries,
  group,
  open,
}: Readonly<{
  activeRoute: string | undefined;
  entries: readonly LabEntry[];
  group: NavigationGroup;
  open: boolean;
}>) => (
  <SidebarGroup className="py-0.5">
    <details className="group/section" data-slot="portal-group" open={open}>
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
        <SidebarMenu>
          {group.items.map((item) => {
            const href = labSidebarHref(entries, item);
            const active = item.href === activeRoute;
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                >
                  <a
                    aria-current={active ? "page" : undefined}
                    aria-disabled={href === null ? true : undefined}
                    href={href ?? "/lab"}
                  >
                    <Icon aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </details>
  </SidebarGroup>
);

export interface LabFrameProps {
  readonly activeRoute?: string | undefined;
  readonly children: ReactNode;
  readonly entries: readonly LabEntry[];
  readonly theme: LabTheme;
  /** Top-bar link that flips ?theme= on the current page. */
  readonly themeToggleHref: string;
  readonly title: string;
}

export const LabFrame = ({
  activeRoute,
  children,
  entries,
  theme,
  title,
  themeToggleHref,
}: LabFrameProps) => {
  const dataTheme = LAB_THEME_ATTRIBUTE[theme];
  // Portaled menus and the page background follow the lab theme too.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.setAttribute("data-theme", dataTheme);
    return () => {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    };
  }, [dataTheme]);
  const groups = PORTAL_SIDEBAR_GROUPS;
  return (
    <div
      className="min-h-dvh bg-sidebar text-foreground"
      data-lab-frame=""
      data-theme={dataTheme}
    >
      <SidebarProvider className="vx-workspace">
        <Sidebar collapsible="icon" mobileSheet={false} variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="[&>span]:p-1.5!">
                  <a href="/lab">
                    <BrandMark className="size-5!" />
                    <span className="font-semibold text-base">
                      Vertex Research
                    </span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="Lab portal navigation">
              {groups.map((group, index) => (
                <LabSidebarGroup
                  activeRoute={activeRoute}
                  entries={entries}
                  group={group}
                  key={group.label}
                  open={
                    index === 0 ||
                    group.items.some((item) => item.href === activeRoute)
                  }
                />
              ))}
            </nav>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-w-0" id="main-content" tabIndex={-1}>
          <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b">
            <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
              {/* Same look as the portal's drawer button; in the lab it opens the index. */}
              <Button
                asChild
                className="-m-2 md:hidden [&>[data-slot=button-chrome]]:size-7"
                size="icon"
                variant="ghost"
              >
                <a aria-label="Open the UI lab index" href="/lab">
                  <PanelLeft aria-hidden="true" />
                </a>
              </Button>
              <SidebarTrigger
                className="hidden md:inline-flex"
                label="Toggle sidebar"
              />
              <Separator
                className="mx-2 data-[orientation=vertical]:h-4"
                orientation="vertical"
              />
              <p
                className="min-w-0 flex-1 truncate font-medium text-base"
                data-slot="portal-page-title"
              >
                {title}
              </p>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Badge data-lab-badge="" variant="outline">
                  <FlaskConical aria-hidden="true" />
                  Demo data
                </Badge>
                <a
                  className="inline-flex min-h-11 items-center rounded-md px-2 text-muted-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  href={themeToggleHref}
                >
                  {theme === "dark" ? "Light" : "Dark"}
                </a>
              </div>
            </div>
          </header>
          <div className="flex flex-1 flex-col">
            <div className="@container/main flex flex-1 flex-col gap-2">
              <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
                {children}
              </div>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
};
