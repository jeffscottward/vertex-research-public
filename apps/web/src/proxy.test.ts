import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_ROUTE_REDIRECTS,
  SETTINGS_HOME_PATH,
} from "./lib/navigation.ts";
import { config, proxy } from "./proxy.ts";

// vinext provides next/server only inside the app build. vi.mock is hoisted above
// the imports and loads vinext's shim in its place (a mock factory can only import
// lazily).
vi.mock("next/server", () => import("vinext/shims/server"));

const ALIASES = {
  ...LEGACY_ROUTE_REDIRECTS,
  "/privacy": "/legal/privacy",
  "/settings": SETTINGS_HOME_PATH,
  "/settings/account": SETTINGS_HOME_PATH,
  "/terms": "/legal/terms",
};

describe("proxy", () => {
  it.each(Object.entries(ALIASES))(
    "answers %s with a relative 307 to %s",
    (alias, target) => {
      const response = proxy(new NextRequest(`https://app.test${alias}`));
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toBe(target);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Strict-Transport-Security")).not.toBeNull();
      expect(response.headers.get("x-middleware-next")).toBeNull();
    }
  );

  it("keeps the query string on an alias redirect", () => {
    const response = proxy(
      new NextRequest("http://app.test/terms?from=footer")
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/legal/terms?from=footer");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("passes any other path on with a trusted x-pathname", () => {
    const response = proxy(
      new NextRequest("http://app.test/legal/privacy?tab=1", {
        headers: { "x-forwarded-proto": "https", "x-pathname": "/forged" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe(
      "/legal/privacy?tab=1"
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Strict-Transport-Security")).not.toBeNull();
  });

  it("does not run for API, build asset or framework paths", () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`, "u");
    expect(pattern.test("/privacy")).toBe(true);
    expect(pattern.test("/api/orpc/health")).toBe(false);
    expect(pattern.test("/_next/static/chunks/a.js")).toBe(false);
  });
});
