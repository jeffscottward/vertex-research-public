import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PortalShell } from "../../components/portal-shell.tsx";
import { parseAssistantPanelCookie } from "../../lib/assistant-panel-cookie.ts";
import { portalRoutePathsFor } from "../../lib/navigation.ts";
import { getRequestPortalSession } from "../../lib/request-portal-session.ts";
import { portalSignInHref } from "../../lib/server-session.ts";

export default async function PortalLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie");
  const session = await getRequestPortalSession(
    cookieHeader,
    requestHeaders.get("cf-connecting-ip")
  );

  if (session === null) redirect(portalSignInHref(requestHeaders));

  const isAdmin = session.role === "admin";
  // Keys the client privacy lifetime (research read scope) by trusted user, role and session expiry.
  const sessionScopeKey = JSON.stringify([
    session.userId,
    session.role,
    session.expiresAt.toISOString(),
  ]);
  return (
    <PortalShell
      availableRoutes={portalRoutePathsFor({
        isAdmin,
        isOperator: session.isOperator,
      })}
      // The saved assistant panel choice, so the server renders the panel as the browser will.
      initialAssistantPanelOpen={parseAssistantPanelCookie(cookieHeader)}
      isAdmin={isAdmin}
      key={sessionScopeKey}
      sessionScopeKey={sessionScopeKey}
      userName={session.name}
    >
      {children}
    </PortalShell>
  );
}
