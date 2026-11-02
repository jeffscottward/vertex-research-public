// What: Server guard for the Administration settings tab: anonymous requests sign in, members see a 403 message.
// Used by: apps/web/src/app/(portal)/settings/administration/page.tsx.
// See: packages/api/src/contracts/admin-users.ts (the API enforces the same rule).
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SETTINGS_HOME_PATH } from "../../../../lib/navigation.ts";
import { getRequestPortalSession } from "../../../../lib/request-portal-session.ts";
import { portalSignInHref } from "../../../../lib/server-session.ts";

/** Shown instead of a silent redirect when a member opens an admin URL directly (audit P2-4). */
export const AdministrationForbidden = () => (
  <div
    className="space-y-2 rounded-md border border-border p-4"
    data-admin-access="forbidden"
    role="alert"
  >
    <h2 className="font-medium text-base">403: administrators only</h2>
    <p className="text-muted-foreground text-sm">
      Administration is limited to workspace administrators. Your account does
      not have the administrator role.
    </p>
    <Link
      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
      href={SETTINGS_HOME_PATH}
      prefetch={false}
    >
      Back to your account settings
    </Link>
  </div>
);

export default async function AdministrationSettingsLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const requestHeaders = await headers();
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  if (session === null) {
    return redirect(portalSignInHref(requestHeaders));
  }
  if (session.role !== "admin") {
    return <AdministrationForbidden />;
  }
  return <>{children}</>;
}
