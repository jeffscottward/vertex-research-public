// What: Settings page frame: the "Settings" title and the Account / Administration / Appearance tabs.
// Used by: every route under apps/web/src/app/(portal)/settings.
// See: apps/web/src/lib/navigation.ts#SETTINGS_NAVIGATION; apps/web/src/app/(portal)/settings/administration/layout.tsx (admin guard).
import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SettingsNavigation } from "../../../components/settings/settings-navigation.tsx";
import { portalRoutePathsFor } from "../../../lib/navigation.ts";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";
import { portalSignInHref } from "../../../lib/server-session.ts";

export const metadata = { title: "Settings" };

export default async function SettingsLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const requestHeaders = await headers();
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  if (session === null) return redirect(portalSignInHref(requestHeaders));

  return (
    <div className="mx-auto w-full max-w-portal space-y-4">
      <PageHeader title="Settings" />
      <SettingsNavigation
        availableRoutes={portalRoutePathsFor({
          isAdmin: session.role === "admin",
          isOperator: session.isOperator,
        })}
        menu="settings"
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
