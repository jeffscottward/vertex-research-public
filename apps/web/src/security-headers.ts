// Security headers for every page response (audit P1-7).
// The CSP holds only frame-ancestors so it cannot block app scripts or styles;
// a full script CSP needs a separate nonce change.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export function applySecurityHeaders(
  headers: Headers,
  protocol: string,
  forwardedProto: string | null
) {
  const isHttps = protocol === "https:" || forwardedProto === "https";
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (isHttps) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
}
