// What: UI lab entries for Data & Ops (audit, modules, connections) and every Settings page, with fake
// experience reads, a fake module catalog and fake account, security, admin and appearance gateways.
// Settings entries repeat the settings layouts' visible frame (title, tabs, account sections).
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import type { AdminUsersListInput } from "@darkfactory/api";
import { PageHeader, SectionHeader } from "@darkfactory/ui";
import type { ReactNode } from "react";

import type { AccountGateway } from "../../components/account/account-client.ts";
import { AddressPageClient } from "../../components/account/address-page-client.tsx";
import { PreferencesPageClient } from "../../components/account/preferences-page-client.tsx";
import { ProfilePageClient } from "../../components/account/profile-page-client.tsx";
import type { SecurityGateway } from "../../components/account/security-client.ts";
import { SecurityPageClient } from "../../components/account/security-page-client.tsx";
import type { AdminUsersGateway } from "../../components/admin/admin-users-client.ts";
import { AdminUsersPageClient } from "../../components/admin/admin-users-page-client.tsx";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
  ResearchScopedWorkspace,
} from "../../components/research/read-scope.tsx";
import { ResearchHeading } from "../../components/research/research-views.tsx";
import { ModulesWorkspace } from "../../components/research/research-workspace.tsx";
import type { VertexReadGateway } from "../../components/research/vertex-client.ts";
import { AppearanceSettings } from "../../components/settings/appearance-settings.tsx";
import { SettingsNavigation } from "../../components/settings/settings-navigation.tsx";
import type { AppearanceSelection } from "../../components/theme-menu.tsx";
import type { ExperienceServices } from "../../features/experience/ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "../../features/experience/shared.tsx";
import {
  AuditWorkspace,
  ConnectionsWorkspace,
  SettingsWorkspaceSections,
} from "../../features/experience/utilities.tsx";
import { portalRoutePathsFor } from "../../lib/navigation.ts";
import { labReadOnly } from "../fixtures/core.ts";
import {
  LAB_ADDRESSES,
  LAB_GATEWAYS,
  LAB_MODULES,
  LAB_PREFERENCES,
  LAB_PROFILE,
  LAB_SCOPE,
  LAB_SESSIONS,
  LAB_USERS,
  labAuditProjections,
  labGatewayStatus,
} from "../fixtures/data-settings.ts";
import type { LabEntry } from "../registry.ts";

const unavailable = createUnavailableExperienceServices();

const labDataServices: ExperienceServices = {
  ...unavailable,
  reads: {
    ...unavailable.reads,
    audit: () => labAuditProjections(),
    gateway: (input) => Promise.resolve(labGatewayStatus(input)),
    gateways: () => Promise.resolve(LAB_GATEWAYS),
    scopes: () => Promise.resolve([LAB_SCOPE]),
  },
};

const labModulesGateway: VertexReadGateway = {
  modules: () => Promise.resolve(LAB_MODULES),
};

const labAccountGateway: AccountGateway = {
  createAddress: labReadOnly,
  getPreferences: () => Promise.resolve(LAB_PREFERENCES),
  getProfile: () => Promise.resolve(LAB_PROFILE),
  listAddresses: () => Promise.resolve([...LAB_ADDRESSES]),
  removeAddress: labReadOnly,
  setPrimaryAddress: labReadOnly,
  updateAddress: labReadOnly,
  updatePreferences: labReadOnly,
  updateProfile: labReadOnly,
};

const labSecurityGateway: SecurityGateway = {
  changePassword: labReadOnly,
  listSessions: () => Promise.resolve(LAB_SESSIONS),
  revokeOtherSessions: labReadOnly,
};

/** Search filters the fictional directory by name or email, like the real directory. */
export const labAdminUsersGateway: AdminUsersGateway = {
  list: (input: AdminUsersListInput) => {
    const query = input.query?.toLowerCase() ?? "";
    return Promise.resolve({
      ...LAB_USERS,
      items: LAB_USERS.items.filter((user) =>
        `${user.name} ${user.email}`.toLowerCase().includes(query)
      ),
    });
  },
};

/** Appearance choices never save or apply: the lab must not touch the real theme. */
export const labAppearanceSelection: AppearanceSelection = {
  disabled: false,
  error: null,
  select: () => undefined,
  statusMessage: null,
  triggerLabel: "Appearance settings",
};

/** A verified research read scope, as the portal shell supplies for a signed-in user. */
const LabScope = ({ children }: { readonly children: ReactNode }) => (
  <ResearchReadScopeProvider scope={createResearchReadScope()}>
    <ExperienceProvider services={labDataServices}>
      {children}
    </ExperienceProvider>
  </ResearchReadScopeProvider>
);

/** apps/web/src/app/(portal)/settings/layout.tsx, as an admin operator sees it. */
const SettingsFrame = ({
  route,
  children,
}: {
  readonly route: string;
  readonly children: ReactNode;
}) => (
  <div className="mx-auto w-full max-w-portal space-y-4">
    <PageHeader title="Settings" />
    <SettingsNavigation
      availableRoutes={portalRoutePathsFor({ isAdmin: true, isOperator: true })}
      currentPath={route}
      menu="settings"
    />
    <div className="min-w-0">{children}</div>
  </div>
);

/** apps/web/src/app/(portal)/settings/account/layout.tsx inside the settings frame. */
const AccountFrame = ({
  route,
  children,
}: {
  readonly route: string;
  readonly children: ReactNode;
}) => (
  <SettingsFrame route={route}>
    <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-6">
      <SettingsNavigation currentPath={route} menu="account" />
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  </SettingsFrame>
);

const SettingsSection = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <div className="space-y-4">
    <SectionHeader title={title} />
    {children}
  </div>
);

export const DATA_SETTINGS_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Data & Ops",
    id: "audit",
    render: () => (
      <LabScope>
        <AuditWorkspace />
      </LabScope>
    ),
    route: "/audit",
    title: "Audit",
  },
  {
    group: "Data & Ops",
    id: "modules",
    render: () => (
      <LabScope>
        <ResearchHeading title="Modules" />
        <ResearchScopedWorkspace>
          <ModulesWorkspace gateway={labModulesGateway} />
        </ResearchScopedWorkspace>
      </LabScope>
    ),
    route: "/modules",
    title: "Modules",
  },
  {
    group: "Data & Ops",
    id: "connections",
    render: () => (
      <LabScope>
        <ConnectionsWorkspace />
      </LabScope>
    ),
    route: "/connections",
    title: "Connections",
  },
  {
    group: "Settings",
    id: "settings-profile",
    render: () => (
      <AccountFrame route="/settings/account/profile">
        <SettingsSection title="Profile">
          <ProfilePageClient gateway={labAccountGateway} />
        </SettingsSection>
      </AccountFrame>
    ),
    route: "/settings/account/profile",
    title: "Profile",
  },
  {
    group: "Settings",
    id: "settings-address",
    render: () => (
      <AccountFrame route="/settings/account/address">
        <SettingsSection title="Addresses">
          <AddressPageClient gateway={labAccountGateway} />
        </SettingsSection>
      </AccountFrame>
    ),
    route: "/settings/account/address",
    title: "Addresses",
  },
  {
    group: "Settings",
    id: "settings-preferences",
    render: () => (
      <AccountFrame route="/settings/account/preferences">
        <SettingsSection title="Preferences">
          <PreferencesPageClient gateway={labAccountGateway} />
        </SettingsSection>
      </AccountFrame>
    ),
    route: "/settings/account/preferences",
    title: "Preferences",
  },
  {
    group: "Settings",
    id: "settings-security",
    render: () => (
      <AccountFrame route="/settings/account/security">
        <SettingsSection title="Security">
          <SecurityPageClient gateway={labSecurityGateway} />
        </SettingsSection>
      </AccountFrame>
    ),
    route: "/settings/account/security",
    title: "Security",
  },
  {
    group: "Settings",
    id: "settings-administration",
    render: () => (
      <SettingsFrame route="/settings/administration">
        <SettingsSection title="Users">
          <AdminUsersPageClient gateway={labAdminUsersGateway} />
        </SettingsSection>
      </SettingsFrame>
    ),
    route: "/settings/administration",
    title: "Administration",
  },
  {
    group: "Settings",
    id: "settings-appearance",
    render: () => (
      <SettingsFrame route="/settings/appearance">
        <SettingsSection title="Appearance">
          <AppearanceSettings selection={labAppearanceSelection} />
        </SettingsSection>
      </SettingsFrame>
    ),
    route: "/settings/appearance",
    title: "Appearance",
  },
  {
    group: "Settings",
    id: "settings-workspace",
    render: () => (
      <SettingsFrame route="/settings/workspace">
        <LabScope>
          <SettingsWorkspaceSections />
        </LabScope>
      </SettingsFrame>
    ),
    route: "/settings/workspace",
    title: "Workspace settings",
  },
];
