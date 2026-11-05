import { describe, expect, it } from "vitest";
import { applySecurityHeaders } from "./security-headers";

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
});
