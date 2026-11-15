// What: Navigation manifest: public, support, auth, portal sidebar, settings tabs, route-page map and legacy redirects.
// Used by: apps/web/src/components/portal-shell.tsx, apps/web/src/components/user-menu.tsx, apps/web/src/components/settings/settings-navigation.tsx.
// See: design-system/darkfactory/MASTER.md (Navigation); apps/web/src/features/generated-navigation.ts.
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AudioWaveform,
  BellRing,
  Blocks,
  BookOpen,
  BookOpenText,
  Bot,
  BotMessageSquare,
  Boxes,
  CalendarDays,
  ChartCandlestick,
  ChartLine,
  ClipboardCheck,
  Dna,
  FileCheck,
  FileText,
  FlaskConical,
  Gauge,
  Gem,
  GitCompareArrows,
  GraduationCap,
  Grid3x3,
  History,
  House,
  Inbox,
  Info,
  KeyRound,
  Landmark,
  Layers,
  LayoutGrid,
  LayoutList,
  Library,
  Lightbulb,
  ListChecks,
  ListOrdered,
  ListTodo,
  LockKeyhole,
  Mail,
  MapPin,
  MessageSquare,
  Newspaper,
  NotebookPen,
  Orbit,
  Palette,
  Play,
  Plug,
  Rewind,
  Scale,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  SlidersHorizontal,
  Sparkles,
  SpellCheck,
  Timer,
  UserPlus,
  UserRound,
  Wallet,
  Waves,
  Wrench,
  Zap,
} from "lucide-react";
import {
  GENERATED_FEATURE_NAVIGATION,
  GENERATED_FEATURE_ROUTE_PAGE_FILES,
  GENERATED_FEATURE_ROUTE_PATHS,
} from "../features/generated-navigation.ts";

export interface NavigationItem {
  readonly exact?: boolean;
  readonly href: `/${string}` | "/";
  readonly icon: LucideIcon;
  readonly label: string;
}

export interface NavigationGroup {
  readonly items: readonly NavigationItem[];
  /** Visible group label. */
  readonly label: string;
}

export const PUBLIC_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { exact: true, href: "/", icon: House, label: "Home" },
  { href: "/features", icon: Sparkles, label: "Platform" },
  { href: "/solutions", icon: Boxes, label: "Method" },
  { href: "/resources", icon: BookOpen, label: "Field guide" },
  { href: "/about", icon: Info, label: "About" },
  { href: "/sign-in", icon: LockKeyhole, label: "Sign in" },
]);

export const SUPPORT_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { href: "/contact", icon: Mail, label: "Contact" },
  { href: "/legal/privacy", icon: FileText, label: "Privacy" },
  { href: "/legal/terms", icon: FileText, label: "Terms" },
]);

export const AUTH_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { href: "/sign-up", icon: UserPlus, label: "Sign up" },
  { href: "/forgot-password", icon: KeyRound, label: "Forgot password" },
  { href: "/reset-password", icon: KeyRound, label: "Reset password" },
]);

/** Overview: the landing page and the owner's decision queue (audit IA map, section 5). */
export const PORTAL_OVERVIEW_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/dashboard", icon: Gauge, label: "Mission control" },
    { href: "/today", icon: Inbox, label: "Decision inbox" },
    { href: "/todos", icon: ListTodo, label: "Todos" },
  ]);

/** Portfolio: one destination for account positions, orders and P&L. */
export const PORTAL_PORTFOLIO_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/portfolio", icon: Wallet, label: "Portfolio" },
    { href: "/journal", icon: NotebookPen, label: "Trade journal" },
  ]);

/** Markets & Research: chat, charts, watchlist, papers and research screens. */
export const PORTAL_RESEARCH_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/research", icon: MessageSquare, label: "Research" },
    { href: "/charts", icon: ChartCandlestick, label: "Charts" },
    { href: "/flow", icon: AudioWaveform, label: "Flow" },
    { href: "/watchlist", icon: ListChecks, label: "Watchlist" },
    { href: "/price-alerts", icon: BellRing, label: "Price alerts" },
    { href: "/news", icon: Newspaper, label: "News monitor" },
    { href: "/calendar", icon: CalendarDays, label: "Calendar" },
    { href: "/baskets", icon: ShoppingBasket, label: "Baskets" },
    { href: "/pick-lists", icon: ListOrdered, label: "Pick lists" },
    { href: "/plays", icon: Lightbulb, label: "Plays" },
    { href: "/papers", icon: ScrollText, label: "Papers" },
    { href: "/rotation-matrix", icon: Grid3x3, label: "Rotation matrix" },
    { href: "/sector-rotation", icon: Orbit, label: "Sector rotation" },
    { href: "/deep-value", icon: Gem, label: "Deep value screen" },
    { href: "/congress-trades", icon: Landmark, label: "Congress trades" },
    { href: "/risk-allocator", icon: Scale, label: "Risk allocator" },
    { href: "/markets", icon: Waves, label: "Market context" },
  ]);

/**
 * Backtest lab: research tools shown under one collapsible sidebar entry, so the
 * sidebar fits a 1440x900 window. The items stay in PORTAL_STRATEGY_NAVIGATION for
 * page titles, the command palette and route lists. Keep them adjacent there.
 */
export const PORTAL_BACKTEST_LAB: Readonly<{
  hrefs: readonly string[];
  icon: LucideIcon;
  label: string;
}> = Object.freeze({
  hrefs: Object.freeze([
    "/instant-backtest",
    "/setup-replay",
    "/backtest-runs",
    "/backtest-sweeps",
    "/portfolio-combos",
    "/forward-drift",
    "/strategy-builder",
    "/autopilot",
  ]),
  icon: FlaskConical,
  label: "Backtest lab",
});

/** Strategies & Backtests: strategy records, reviews, backtests and optimizations. */
export const PORTAL_STRATEGY_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/library", icon: Library, label: "Strategy library" },
    { href: "/academy", icon: GraduationCap, label: "Academy" },
    { href: "/strategies", icon: ClipboardCheck, label: "Strategy reviews" },
    { href: "/backtests", icon: ChartLine, label: "Backtests" },
    { href: "/instant-backtest", icon: Zap, label: "Instant backtest" },
    { href: "/setup-replay", icon: Rewind, label: "Setup replay" },
    { href: "/backtest-runs", icon: Play, label: "Backtest runs" },
    {
      href: "/backtest-sweeps",
      icon: LayoutGrid,
      label: "Parameter sweeps",
    },
    { href: "/portfolio-combos", icon: Layers, label: "Portfolio combos" },
    { href: "/forward-drift", icon: Activity, label: "Forward drift" },
    { href: "/strategy-builder", icon: Blocks, label: "Strategy builder" },
    { href: "/autopilot", icon: Dna, label: "Autopilot" },
    { href: "/optimizations", icon: SlidersHorizontal, label: "Optimizations" },
  ]);

/** Agents & Automation: agent runs and deployments. */
export const PORTAL_AUTOMATION_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/agents", icon: Bot, label: "Agent runs" },
    {
      href: "/agents/benchmark",
      icon: GitCompareArrows,
      label: "Model benchmark",
    },
    { href: "/deployments", icon: Server, label: "Deployments" },
    { href: "/drafts", icon: FileCheck, label: "Order drafts" },
    { href: "/engines", icon: Timer, label: "Engines" },
    { href: "/semantic-terms", icon: SpellCheck, label: "Semantic terms" },
  ]);

/** Data & Ops: scoped readers of governed records. */
export const PORTAL_DATA_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { href: "/audit", icon: History, label: "Audit" },
  { href: "/modules", icon: Boxes, label: "Modules" },
  { href: "/connections", icon: Plug, label: "Connections" },
]);

/** Generated feature destinations (`pnpm generate:feature`), listed after the Data & Ops items. */
export const FEATURE_NAVIGATION: readonly NavigationItem[] = Object.freeze(
  GENERATED_FEATURE_NAVIGATION.map((item) => ({
    ...item,
    icon: LayoutList,
  }))
);

/** Portal sidebar groups, in display order (audit IA map). Filter items with `isRouteExposed`. */
export const PORTAL_SIDEBAR_GROUPS: readonly NavigationGroup[] = Object.freeze([
  { items: PORTAL_OVERVIEW_NAVIGATION, label: "Overview" },
  { items: PORTAL_PORTFOLIO_NAVIGATION, label: "Portfolio" },
  { items: PORTAL_RESEARCH_NAVIGATION, label: "Markets & Research" },
  { items: PORTAL_STRATEGY_NAVIGATION, label: "Strategies & Backtests" },
  { items: PORTAL_AUTOMATION_NAVIGATION, label: "Agents & Automation" },
  {
    items: [...PORTAL_DATA_NAVIGATION, ...FEATURE_NAVIGATION],
    label: "Data & Ops",
  },
]);

/**
 * Portal pages reached from another page, not from the sidebar. The assistant and
 * the knowledge chat open from Research, so the sidebar has one chat entry (audit IA map, sections 5 and 7).
 */
const PORTAL_LINKED_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { href: "/assistant", icon: BotMessageSquare, label: "Assistant" },
  { href: "/knowledge", icon: BookOpenText, label: "Knowledge chat" },
]);

/** Product navigation: every portal destination in sidebar order. */
export const PORTAL_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  ...PORTAL_OVERVIEW_NAVIGATION,
  ...PORTAL_PORTFOLIO_NAVIGATION,
  ...PORTAL_RESEARCH_NAVIGATION,
  ...PORTAL_STRATEGY_NAVIGATION,
  ...PORTAL_AUTOMATION_NAVIGATION,
  ...PORTAL_DATA_NAVIGATION,
]);

/** The single settings destination in the user menu. */
export const SETTINGS_ENTRY: NavigationItem = Object.freeze({
  href: "/settings",
  icon: Settings,
  label: "Settings",
});

/** First page of the settings area; `/settings` and `/settings/account` redirect here. */
export const SETTINGS_HOME_PATH = "/settings/account/profile" as const;

/** High-level settings tabs. "Administration" is exposed to administrators only. */
export const SETTINGS_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  { href: "/settings/account", icon: UserRound, label: "Account" },
  {
    href: "/settings/administration",
    icon: ShieldCheck,
    label: "Administration",
  },
  { href: "/settings/appearance", icon: Palette, label: "Appearance" },
  { href: "/settings/workspace", icon: Wrench, label: "Workspace" },
]);

/** Sections inside the Account settings tab. */
export const ACCOUNT_SETTINGS_NAVIGATION: readonly NavigationItem[] =
  Object.freeze([
    { href: "/settings/account/profile", icon: UserRound, label: "Profile" },
    { href: "/settings/account/address", icon: MapPin, label: "Address" },
    {
      href: "/settings/account/preferences",
      icon: SlidersHorizontal,
      label: "Preferences",
    },
    {
      href: "/settings/account/security",
      icon: LockKeyhole,
      label: "Security",
    },
  ]);

/** Vertex product routes. Operator-only ones (OPERATOR_PORTAL_ROUTE_PATHS) are removed for non-operators by `portalRoutePathsFor`. */
const VERTEX_PORTAL_ROUTE_PATHS = Object.freeze([
  "/research",
  "/assistant",
  "/agents",
  "/agents/benchmark",
  "/papers",
  "/library",
  "/academy",
  "/backtests",
  "/instant-backtest",
  "/setup-replay",
  "/backtest-runs",
  "/backtest-sweeps",
  "/portfolio-combos",
  "/forward-drift",
  "/strategy-builder",
  "/rotation-matrix",
  "/sector-rotation",
  "/deep-value",
  "/congress-trades",
  "/risk-allocator",
  "/markets",
  "/knowledge",
  "/optimizations",
  "/autopilot",
  "/charts",
  "/flow",
  "/deployments",
  "/drafts",
  "/engines",
  "/semantic-terms",
  "/watchlist",
  "/price-alerts",
  "/news",
  "/baskets",
  "/pick-lists",
  "/plays",
  "/todos",
  "/today",
  "/portfolio",
  "/journal",
  "/calendar",
  "/strategies",
  "/audit",
  "/modules",
  "/connections",
] as const);

/** Routes every signed-in member can open. */
export const MEMBER_PORTAL_ROUTE_PATHS = Object.freeze([
  "/dashboard",
  ...VERTEX_PORTAL_ROUTE_PATHS,
  ...GENERATED_FEATURE_ROUTE_PATHS,
  "/settings",
  "/settings/account",
  "/settings/account/profile",
  "/settings/account/address",
  "/settings/account/preferences",
  "/settings/account/security",
  "/settings/appearance",
  "/settings/workspace",
] as const);

/** Routes only administrators can open. */
export const ADMIN_PORTAL_ROUTE_PATHS = Object.freeze([
  ...MEMBER_PORTAL_ROUTE_PATHS,
  "/settings/administration",
] as const);

/**
 * Routes whose data the API serves only to operators (`requireOperator` in
 * packages/api). They are hidden from the sidebar, command palette and route
 * list of non-operators. The API still enforces the rule.
 */
export const OPERATOR_PORTAL_ROUTE_PATHS = Object.freeze([
  "/assistant",
  "/agents",
  "/agents/benchmark",
  "/papers",
  "/library",
  "/academy",
  "/backtests",
  "/instant-backtest",
  "/setup-replay",
  "/backtest-runs",
  "/backtest-sweeps",
  "/portfolio-combos",
  "/forward-drift",
  "/strategy-builder",
  "/rotation-matrix",
  "/sector-rotation",
  "/deep-value",
  "/congress-trades",
  "/risk-allocator",
  "/price-alerts",
  "/news",
  "/markets",
  "/knowledge",
  "/optimizations",
  "/autopilot",
  "/charts",
  "/flow",
  "/deployments",
  "/drafts",
  "/baskets",
  "/pick-lists",
  "/plays",
  "/engines",
  "/semantic-terms",
  "/journal",
  "/calendar",
] as const);

/** Portal routes this session can open, by role (admin) and operator status. */
export const portalRoutePathsFor = ({
  isAdmin,
  isOperator,
}: {
  readonly isAdmin: boolean;
  readonly isOperator: boolean;
}): readonly string[] => {
  const routes: readonly string[] = isAdmin
    ? ADMIN_PORTAL_ROUTE_PATHS
    : MEMBER_PORTAL_ROUTE_PATHS;
  if (isOperator) return routes;
  const operatorOnly: readonly string[] = OPERATOR_PORTAL_ROUTE_PATHS;
  return Object.freeze(routes.filter((path) => !operatorOnly.includes(path)));
};

/**
 * Old portal URLs and their settings destination. Each keeps a page that
 * redirects, so bookmarks and deep links keep working.
 */
export const LEGACY_ROUTE_REDIRECTS = Object.freeze({
  "/account": SETTINGS_HOME_PATH,
  "/account/address": "/settings/account/address",
  "/account/preferences": "/settings/account/preferences",
  "/account/profile": "/settings/account/profile",
  "/account/security": "/settings/account/security",
  "/admin": "/settings/administration",
  "/admin/users": "/settings/administration",
  // Data & evidence was dropped (owner decision 2026-10-30): no dataset or
  // evidence list exists, and its exact-ID lookups were removed.
  "/data": "/research",
} as const);

export const EXPOSED_ROUTE_PATHS = Object.freeze([
  "/",
  "/features",
  "/solutions",
  "/resources",
  "/about",
  "/sign-in",
  "/contact",
  "/legal/privacy",
  "/legal/terms",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  ...ADMIN_PORTAL_ROUTE_PATHS,
] as const);

export const ROUTE_PAGE_FILES: Readonly<Record<string, string>> = Object.freeze(
  {
    "/": "(public)/page.tsx",
    "/about": "(public)/about/page.tsx",
    "/contact": "(public)/contact/page.tsx",
    "/dashboard": "(portal)/dashboard/page.tsx",
    ...Object.fromEntries(
      VERTEX_PORTAL_ROUTE_PATHS.map((path) => [
        path,
        `(portal)${path}/page.tsx`,
      ])
    ),
    "/features": "(public)/features/page.tsx",
    "/forgot-password": "(auth)/forgot-password/page.tsx",
    "/legal/privacy": "(public)/legal/privacy/page.tsx",
    "/legal/terms": "(public)/legal/terms/page.tsx",
    "/reset-password": "(auth)/reset-password/page.tsx",
    "/resources": "(public)/resources/page.tsx",
    "/settings": "(portal)/settings/page.ts",
    "/settings/account": "(portal)/settings/account/page.ts",
    "/settings/account/address": "(portal)/settings/account/address/page.tsx",
    "/settings/account/preferences":
      "(portal)/settings/account/preferences/page.tsx",
    "/settings/account/profile": "(portal)/settings/account/profile/page.tsx",
    "/settings/account/security": "(portal)/settings/account/security/page.tsx",
    "/settings/administration": "(portal)/settings/administration/page.tsx",
    "/settings/appearance": "(portal)/settings/appearance/page.tsx",
    "/settings/workspace": "(portal)/settings/workspace/page.tsx",
    "/sign-in": "(auth)/sign-in/page.tsx",
    "/sign-up": "(auth)/sign-up/page.tsx",
    "/solutions": "(public)/solutions/page.tsx",
    ...GENERATED_FEATURE_ROUTE_PAGE_FILES,
  }
);

/** Page files of the legacy redirects in `LEGACY_ROUTE_REDIRECTS`. */
export const LEGACY_ROUTE_PAGE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    "/account": "(portal)/account/page.ts",
    "/account/address": "(portal)/account/address/page.ts",
    "/account/preferences": "(portal)/account/preferences/page.ts",
    "/account/profile": "(portal)/account/profile/page.ts",
    "/account/security": "(portal)/account/security/page.ts",
    "/admin": "(portal)/admin/page.ts",
    "/admin/users": "(portal)/admin/users/page.ts",
    "/data": "(portal)/data/page.ts",
  });

export const ALL_NAVIGATION: readonly NavigationItem[] = Object.freeze([
  ...PUBLIC_NAVIGATION,
  ...SUPPORT_NAVIGATION,
  ...AUTH_NAVIGATION,
  ...PORTAL_NAVIGATION,
  ...PORTAL_LINKED_NAVIGATION,
  ...FEATURE_NAVIGATION,
  SETTINGS_ENTRY,
  ...SETTINGS_NAVIGATION,
  ...ACCOUNT_SETTINGS_NAVIGATION,
]);

export const isRouteExposed = (
  href: string,
  availableRoutes: readonly string[] = EXPOSED_ROUTE_PATHS
): boolean => availableRoutes.includes(href);

export const isNavigationItemActive = (
  pathname: string,
  item: Pick<NavigationItem, "href" | "exact">
): boolean => {
  if (item.exact || item.href === "/") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
};
