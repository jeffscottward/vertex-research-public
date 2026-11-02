import { type NextRequest, NextResponse } from "next/server";
import { applySecurityHeaders } from "./security-headers";

// Pass the requested path to server components so the portal guard can send
// signed-out users back to the page they asked for after sign-in.
// Any client-supplied x-pathname is overwritten; server-session.ts still
// validates the value against the allowed portal roots.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(
    "x-pathname",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  const response = NextResponse.next({ request: { headers } });
  applySecurityHeaders(
    response.headers,
    request.nextUrl.protocol,
    request.headers.get("x-forwarded-proto")
  );
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/|assets/|@|favicon).*)"],
};
