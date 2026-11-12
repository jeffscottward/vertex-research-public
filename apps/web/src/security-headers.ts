// Security headers for every page response (audit P1-7, sec-20 item 7).
// BASE_CSP is also the static fallback in infra/quantvps/Caddyfile; keep them
// equal. Page responses add a per-request script nonce (see scriptCsp).
export const BASE_CSP =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

// 16 random bytes, base64: no HTML escape characters, so vinext accepts it.
export function createScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

// Same-origin script files load as before; inline scripts (the RSC payload
// vinext streams) run only with this request's nonce. vinext reads the nonce
// back from the request's Content-Security-Policy header and stamps it on its
// own scripts; the root layout stamps it on the theme bootstrap.
export function scriptCsp(nonce: string): string {
  return `${BASE_CSP}; script-src 'self' 'nonce-${nonce}'`;
}

// Reads the nonce back from a header that scriptCsp built (the root layout uses
// the request header the proxy set).
export function scriptNonceFromCsp(csp: string | null): string | undefined {
  return csp?.match(
    /(?:^|;)\s*script-src [^;]*'nonce-([A-Za-z0-9+/=]+)'/u
  )?.[1];
}

export function applySecurityHeaders(
  headers: Headers,
  protocol: string,
  forwardedProto: string | null,
  nonce?: string
) {
  const isHttps = protocol === "https:" || forwardedProto === "https";
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set(
    "Content-Security-Policy",
    nonce === undefined ? BASE_CSP : scriptCsp(nonce)
  );
  if (isHttps) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
}
