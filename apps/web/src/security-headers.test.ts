import { describe, expect, it } from "vitest";
import {
  applySecurityHeaders,
  BASE_CSP,
  createScriptNonce,
  scriptCsp,
  scriptNonceFromCsp,
} from "./security-headers";

describe("security headers (audit P1-7)", () => {
  it("forbids framing and sets the baseline headers", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "http:", null);
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
    );
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin"
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("adds HSTS only behind https", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "http:", "https");
    expect(headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000"
    );
    const direct = new Headers();
    applySecurityHeaders(direct, "https:", null);
    expect(direct.get("Strict-Transport-Security")).not.toBeNull();
  });

  it("adds a nonce-only script-src for page responses", () => {
    const nonce = createScriptNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
    expect(createScriptNonce()).not.toBe(nonce);
    const headers = new Headers();
    applySecurityHeaders(headers, "http:", null, nonce);
    const csp = headers.get("Content-Security-Policy");
    expect(csp).toBe(`${BASE_CSP}; script-src 'self' 'nonce-${nonce}'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(scriptNonceFromCsp(csp)).toBe(nonce);
  });

  it("reads no nonce from a policy without one", () => {
    expect(scriptNonceFromCsp(null)).toBeUndefined();
    expect(scriptNonceFromCsp(BASE_CSP)).toBeUndefined();
    expect(scriptNonceFromCsp(scriptCsp("abc"))).toBe("abc");
  });
});
