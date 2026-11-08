import { type NextRequest, NextResponse } from "next/server";
import {
  LEGACY_ROUTE_REDIRECTS,
  SETTINGS_HOME_PATH,
} from "./lib/navigation.ts";
import {
  applySecurityHeaders,
  createScriptNonce,
  scriptCsp,
} from "./security-headers";

// Alias routes answer a real 307 here. Their page files still call redirect(),
// but a loading.tsx boundary streams those pages, which turns redirect() into a
// 200 document with a one-second meta refresh (Next.js does the same).
const ROUTE_ALIAS_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  ...LEGACY_ROUTE_REDIRECTS,
  "/privacy": "/legal/privacy",
  "/settings": SETTINGS_HOME_PATH,
  "/settings/account": SETTINGS_HOME_PATH,
  "/terms": "/legal/terms",
});

// Pass the requested path to server components so the portal guard can send
// signed-out users back to the page they asked for after sign-in.
// Any client-supplied x-pathname is overwritten; server-session.ts still
// validates the value against the allowed portal roots.
export function proxy(request: NextRequest) {
  // "/terms/" is the same alias as "/terms" (one trailing slash, never the root).
  const pathname = request.nextUrl.pathname;
  const aliasTarget =
    ROUTE_ALIAS_REDIRECTS[
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname
    ];
  let response: NextResponse;
  let nonce: string | undefined;
  if (aliasTarget === undefined) {
    nonce = createScriptNonce();
    const headers = new Headers(request.headers);
    headers.set(
      "x-pathname",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );
    // vinext and the root layout read the script nonce from this request
    // header; it overwrites any client-supplied value.
    headers.set("content-security-policy", scriptCsp(nonce));
    headers.delete("content-security-policy-report-only");
    response = NextResponse.next({ request: { headers } });
  } else {
    // A relative Location, as redirect() sends, keeps the query string.
    response = new NextResponse(null, {
      headers: { Location: `${aliasTarget}${request.nextUrl.search}` },
      status: 307,
    });
  }
  applySecurityHeaders(
    response.headers,
    request.nextUrl.protocol,
    request.headers.get("x-forwarded-proto"),
    nonce
  );
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/|assets/|@|favicon).*)"],
};
