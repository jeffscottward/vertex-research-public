import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestPortalSession: vi.fn(),
  headers: vi.fn(
    async () =>
      new Headers({
        "cf-connecting-ip": "203.0.113.42",
        cookie: "better-auth.session_token=opaque",
        "x-pathname": "/watchlist",
      })
  ),
  portalSignInHref: vi.fn(() => "/sign-in?callbackURL=%2Fwatchlist"),
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: mocks.getRequestPortalSession,
}));
vi.mock("../../lib/server-session.ts", () => ({
  portalSignInHref: mocks.portalSignInHref,
}));
vi.mock("../../components/portal-shell.tsx", () => ({
  PortalShell: "portal-shell",
}));

import { AddressPageClient } from "../../components/account/address-page-client.tsx";
import { PreferencesPageClient } from "../../components/account/preferences-page-client.tsx";
import { ProfilePageClient } from "../../components/account/profile-page-client.tsx";
import { SecurityPageClient } from "../../components/account/security-page-client.tsx";
import { AdminUsersPageClient } from "../../components/admin/admin-users-page-client.tsx";
import { AppearanceSettings } from "../../components/settings/appearance-settings.tsx";
import { SettingsNavigation } from "../../components/settings/settings-navigation.tsx";
import {
  ADMIN_PORTAL_ROUTE_PATHS,
  LEGACY_ROUTE_REDIRECTS,
  MEMBER_PORTAL_ROUTE_PATHS,
  OPERATOR_PORTAL_ROUTE_PATHS,
  portalRoutePathsFor,
} from "../../lib/navigation.ts";
import LegacyAddressPage from "./account/address/page.ts";
import LegacyAccountPage from "./account/page.ts";
import LegacyPreferencesPage from "./account/preferences/page.ts";
import LegacyProfilePage from "./account/profile/page.ts";
import LegacySecurityPage from "./account/security/page.ts";
import LegacyAdminPage from "./admin/page.ts";
import LegacyAdminUsersPage from "./admin/users/page.ts";
import LegacyDataPage from "./data/page.ts";
import DashboardError from "./dashboard/error.tsx";
import DashboardLoading from "./dashboard/loading.tsx";
import PortalLayout from "./layout.tsx";
import AddressSettingsPage from "./settings/account/address/page.tsx";
import AccountSettingsError from "./settings/account/error.tsx";
import AccountSettingsLayout from "./settings/account/layout.tsx";
import AccountSettingsLoading from "./settings/account/loading.tsx";
import AccountSettingsPage from "./settings/account/page.ts";
import PreferencesSettingsPage from "./settings/account/preferences/page.tsx";
import ProfileSettingsPage from "./settings/account/profile/page.tsx";
import SecuritySettingsPage from "./settings/account/security/page.tsx";
import AdministrationSettingsError from "./settings/administration/error.tsx";
import AdministrationSettingsLoading from "./settings/administration/loading.tsx";
import AdministrationSettingsPage from "./settings/administration/page.tsx";
import AppearanceSettingsPage from "./settings/appearance/page.tsx";
import SettingsLayout, {
  metadata as settingsMetadata,
} from "./settings/layout.tsx";
import SettingsPage from "./settings/page.ts";

type RuntimeElement = ReactElement<{
  readonly action?: ReactNode;
  readonly actions?: ReactNode;
  readonly availableRoutes?: readonly string[];
  readonly children?: ReactNode;
  readonly href?: string;
  readonly id?: string;
  readonly menu?: string;
  readonly onClick?: (() => void) | undefined;
  readonly title?: ReactNode;
}>;

const runtimeElements = (node: ReactNode): readonly RuntimeElement[] => {
  if (!isValidElement<RuntimeElement["props"]>(node)) return [];
  return [
    node,
    ...Children.toArray([
      node.props.children,
      node.props.action,
      node.props.actions,
    ]).flatMap(runtimeElements),
  ];
};

const runtimeElement = (
  node: ReactNode,
  type: RuntimeElement["type"]
): RuntimeElement | undefined => {
  return runtimeElements(node).find((element) => element.type === type);
};

beforeEach(() => vi.clearAllMocks());

describe("PortalLayout", () => {
  it("redirects an anonymous server request before returning protected content", async () => {
    mocks.getRequestPortalSession.mockResolvedValueOnce(null);

    await expect(PortalLayout({ children: "protected" })).rejects.toThrow(
      "REDIRECT:/sign-in?callbackURL=%2Fwatchlist"
    );
    expect(mocks.getRequestPortalSession).toHaveBeenCalledWith(
      "better-auth.session_token=opaque",
      "203.0.113.42"
    );
    return expect(mocks.redirect).toHaveBeenCalledOnce();
  });

  it.each(["/modules", "/data", "/research"])(
    "requires a server session for %s before returning workspace content",
    async (path) => {
      const callback = `/sign-in?callbackURL=${encodeURIComponent(path)}`;
      mocks.headers.mockResolvedValueOnce(new Headers({ "x-pathname": path }));
      mocks.portalSignInHref.mockReturnValueOnce(callback);
      mocks.getRequestPortalSession.mockResolvedValueOnce(null);
      await expect(
        PortalLayout({ children: "private research" })
      ).rejects.toThrow(`REDIRECT:${callback}`);
      expect(mocks.redirect).toHaveBeenCalledWith(callback);
    }
  );

  it("keys the client privacy lifetime by trusted user, role, and session expiry", async () => {
    const session = activeSession("member");
    const scopes: unknown[] = [];
    for (const projected of [
      session,
      { ...session, userId: "second-user" },
      { ...session, role: "admin" as const },
      { ...session, expiresAt: new Date("2030-01-02T00:00:00.000Z") },
    ]) {
      mocks.getRequestPortalSession.mockResolvedValueOnce(projected);
      const result = await PortalLayout({ children: "protected" });
      const expected = JSON.stringify([
        projected.userId,
        projected.role,
        projected.expiresAt.toISOString(),
      ]);
      expect(result.key).toBe(expected);
      expect(result.props.sessionScopeKey).toBe(expected);
      scopes.push(result.key);
    }
    expect(new Set(scopes).size).toBe(4);
  });

  it("passes the saved assistant panel choice from the request cookie", async () => {
    const results: unknown[] = [];
    for (const cookie of [
      "better-auth.session_token=opaque; vx.assistantPanel=open",
      "vx.assistantPanel=closed",
      "better-auth.session_token=opaque",
    ]) {
      mocks.headers.mockResolvedValueOnce(new Headers({ cookie }));
      mocks.getRequestPortalSession.mockResolvedValueOnce(
        activeSession("member")
      );
      const result = await PortalLayout({ children: "protected" });
      results.push(result.props.initialAssistantPanelOpen);
    }
    return expect(results).toEqual([true, false, undefined]);
  });

  return it.each([
    ["member", false, true, MEMBER_PORTAL_ROUTE_PATHS],
    ["admin", true, true, ADMIN_PORTAL_ROUTE_PATHS],
    [
      "member",
      false,
      false,
      MEMBER_PORTAL_ROUTE_PATHS.filter(
        (path) =>
          !(OPERATOR_PORTAL_ROUTE_PATHS as readonly string[]).includes(path)
      ),
    ],
  ])(
    "renders role-gated routes for an active %s session (operator: %s/%s)",
    async (role, isAdmin, isOperator, availableRoutes) => {
      mocks.getRequestPortalSession.mockResolvedValueOnce({
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        isOperator,
        name: "Example User",
        role,
        status: "active",
        userId: "user-1",
      });

      const result = await PortalLayout({ children: "protected" });

      expect(result.type).toBe("portal-shell");
      expect(result.props.children).toBe("protected");
      expect(result.props.isAdmin).toBe(isAdmin);
      expect(result.props.userName).toBe("Example User");
      return expect(result.props.availableRoutes).toEqual(availableRoutes);
    }
  );
});

describe("operator route filter", () =>
  it("removes operator-only pages for non-operators and keeps them for operators", () => {
    expect(portalRoutePathsFor({ isAdmin: false, isOperator: true })).toBe(
      MEMBER_PORTAL_ROUTE_PATHS
    );
    expect(portalRoutePathsFor({ isAdmin: true, isOperator: true })).toBe(
      ADMIN_PORTAL_ROUTE_PATHS
    );
    const member = portalRoutePathsFor({ isAdmin: false, isOperator: false });
    const admin = portalRoutePathsFor({ isAdmin: true, isOperator: false });
    for (const path of OPERATOR_PORTAL_ROUTE_PATHS) {
      expect(MEMBER_PORTAL_ROUTE_PATHS).toContain(path);
      expect(member).not.toContain(path);
      expect(admin).not.toContain(path);
    }
    expect(member).toEqual(
      expect.arrayContaining(["/dashboard", "/research", "/portfolio"])
    );
    expect(Object.isFrozen(member)).toBe(true);
    return expect(admin).toContain("/settings/administration");
  }));

describe("portal route manifests", () =>
  it("gives members every portal page and administrators the Administration tab too", () => {
    expect(MEMBER_PORTAL_ROUTE_PATHS).toEqual([
      "/dashboard",
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
      "/deployments",
      "/engines",
      "/watchlist",
      "/price-alerts",
      "/news",
      "/baskets",
      "/pick-lists",
      "/todos",
      "/today",
      "/portfolio",
      "/strategies",
      "/audit",
      "/modules",
      "/connections",
      "/settings",
      "/settings/account",
      "/settings/account/profile",
      "/settings/account/address",
      "/settings/account/preferences",
      "/settings/account/security",
      "/settings/appearance",
      "/settings/workspace",
    ]);
    return expect(ADMIN_PORTAL_ROUTE_PATHS).toEqual([
      ...MEMBER_PORTAL_ROUTE_PATHS,
      "/settings/administration",
    ]);
  }));

const activeSession = (role: "admin" | "member") => ({
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  isOperator: true,
  name: "Example User",
  role,
  status: "active",
  userId: "user-1",
});

describe("settings layout", () => {
  it("redirects an anonymous request to sign in", async () => {
    mocks.getRequestPortalSession.mockResolvedValueOnce(null);
    await expect(SettingsLayout({ children: "settings" })).rejects.toThrow(
      "REDIRECT:/sign-in?callbackURL=%2Fwatchlist"
    );
    return expect(mocks.getRequestPortalSession).toHaveBeenCalledWith(
      "better-auth.session_token=opaque",
      "203.0.113.42"
    );
  });

  return it.each([
    ["member", MEMBER_PORTAL_ROUTE_PATHS],
    ["admin", ADMIN_PORTAL_ROUTE_PATHS],
  ] as const)(
    "renders the Settings title and role-filtered tabs for a %s",
    async (role, availableRoutes) => {
      mocks.getRequestPortalSession.mockResolvedValueOnce(activeSession(role));
      const layout = await SettingsLayout({ children: "settings content" });
      const elements = runtimeElements(layout);
      expect(
        elements.some((element) => element.props.title === "Settings")
      ).toBe(true);
      const tabs = runtimeElement(layout, SettingsNavigation);
      expect(tabs?.props).toEqual({ availableRoutes, menu: "settings" });
      expect(
        elements.some(
          (element) => element.props.children === "settings content"
        )
      ).toBe(true);
      return expect(settingsMetadata).toEqual({ title: "Settings" });
    }
  );
});

describe("portal route leaf composition", () => {
  it("redirects the settings and account indexes to the profile section", () => {
    expect(() => SettingsPage()).toThrow("REDIRECT:/settings/account/profile");
    expect(() => AccountSettingsPage()).toThrow(
      "REDIRECT:/settings/account/profile"
    );
    return expect(mocks.redirect).toHaveBeenCalledTimes(2);
  });

  it("redirects every legacy account, admin and data URL", () => {
    const legacyPages = [
      ["/account", LegacyAccountPage],
      ["/account/profile", LegacyProfilePage],
      ["/account/address", LegacyAddressPage],
      ["/account/preferences", LegacyPreferencesPage],
      ["/account/security", LegacySecurityPage],
      ["/admin", LegacyAdminPage],
      ["/admin/users", LegacyAdminUsersPage],
      ["/data", LegacyDataPage],
    ] as const;
    for (const [path, Page] of legacyPages) {
      expect(() => Page()).toThrow(`REDIRECT:${LEGACY_ROUTE_REDIRECTS[path]}`);
    }
    expect(LEGACY_ROUTE_REDIRECTS).toEqual({
      "/account": "/settings/account/profile",
      "/account/address": "/settings/account/address",
      "/account/preferences": "/settings/account/preferences",
      "/account/profile": "/settings/account/profile",
      "/account/security": "/settings/account/security",
      "/admin": "/settings/administration",
      "/admin/users": "/settings/administration",
      "/data": "/research",
    });
    return expect(mocks.redirect).toHaveBeenCalledTimes(legacyPages.length);
  });

  it("renders the account sections navigation and every account client leaf", () => {
    const layout = AccountSettingsLayout({ children: "account content" });
    expect(runtimeElement(layout, SettingsNavigation)?.props).toEqual({
      menu: "account",
    });
    expect(
      runtimeElements(layout).some(
        (element) => element.props.children === "account content"
      )
    ).toBe(true);

    for (const [Page, Client, title] of [
      [AddressSettingsPage, AddressPageClient, "Addresses"],
      [PreferencesSettingsPage, PreferencesPageClient, "Preferences"],
      [ProfileSettingsPage, ProfilePageClient, "Profile"],
      [SecuritySettingsPage, SecurityPageClient, "Security"],
    ] as const) {
      const page = Page();
      expect(runtimeElement(page, Client)).toBeDefined();
      expect(
        runtimeElements(page).some((element) => element.props.title === title)
      ).toBe(true);
    }
  });

  it("renders the administration directory and the appearance form", () => {
    expect(
      runtimeElement(AdministrationSettingsPage(), AdminUsersPageClient)
    ).toBeDefined();
    return expect(
      runtimeElement(AppearanceSettingsPage(), AppearanceSettings)
    ).toBeDefined();
  });

  it("wires every portal error boundary to its supplied retry action", () => {
    const reset = vi.fn();
    const boundaries = [
      AccountSettingsError({ error: new Error("account"), reset }),
      AdministrationSettingsError({ error: new Error("admin"), reset }),
      DashboardError({ reset }),
    ];

    for (const boundary of boundaries) {
      const retry = runtimeElements(boundary).find(
        (element) => element.props.onClick === reset
      );
      expect(retry).toBeDefined();
      retry?.props.onClick?.();
    }
    return expect(reset).toHaveBeenCalledTimes(boundaries.length);
  });

  return it("announces every portal loading boundary without exposing live data", () => {
    for (const loading of [
      AccountSettingsLoading(),
      AdministrationSettingsLoading(),
      DashboardLoading(),
    ]) {
      expect(loading.props).toMatchObject({
        "aria-busy": "true",
        role: "status",
      });
    }
  });
});
