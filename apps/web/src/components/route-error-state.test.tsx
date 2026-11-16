// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/account",
  useRouter: () => ({ refresh }),
}));

import AccountSettingsError from "../app/(portal)/settings/account/error.tsx";
import WatchlistError from "../app/(portal)/watchlist/error.tsx";
import {
  type RouteError,
  routeErrorCause,
  routeErrorText,
} from "./route-error-state.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  refresh.mockClear();
});

const at = new Date("2026-11-15T14:05:00Z");
const withDigest = (message: string, digest: string): RouteError =>
  Object.assign(new Error(message), { digest });

const renderBoundary = async (
  Boundary: typeof WatchlistError,
  error: RouteError
) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const reset = vi.fn();
  await act(async () => root.render(<Boundary error={error} reset={reset} />));
  return { container, reset, root };
};

describe("route error state", () => {
  it("classifies each cause", () => {
    expect(routeErrorCause(new Error("Request failed: 401"))).toBe(
      "session-expired"
    );
    expect(routeErrorCause(new Error("FORBIDDEN"))).toBe("session-expired");
    expect(routeErrorCause(new Error("UNAUTHORIZED"))).toBe("session-expired");
    expect(routeErrorCause(new Error("session cookie parse bug"))).toBe(
      "render-error"
    );
    expect(routeErrorCause(new Error("TypeError: Failed to fetch"))).toBe(
      "network-failed"
    );
    expect(routeErrorCause(new Error("NetworkError when fetching"))).toBe(
      "network-failed"
    );
    expect(routeErrorCause(new Error("ERR_NETWORK"))).toBe("network-failed");
    expect(routeErrorCause(new Error("request timed out"))).toBe(
      "network-failed"
    );
    expect(routeErrorCause(new Error("network config missing"))).toBe(
      "render-error"
    );
    expect(routeErrorCause(withDigest("hidden", "abc123"))).toBe(
      "server-error"
    );
    expect(routeErrorCause(new Error("x is undefined"))).toBe("render-error");
    expect(routeErrorCause(undefined)).toBe("render-error");
  });

  it("states page, time, cause, reference and next step", () => {
    const text = routeErrorText(
      "Baskets",
      withDigest("boom", "abc123"),
      at,
      "No data was changed."
    );
    expect(text.title).toBe("Baskets failed to render at 14:05 UTC");
    expect(text.description).toBe(
      "Cause: the server hit an error while rendering. Reference: abc123. No data was changed. Select Try again to render this page again."
    );
    expect(
      routeErrorText("Journal", new Error("401"), at, "").description
    ).toContain("Sign in again");
    expect(
      routeErrorText("Journal", new Error("Failed to fetch"), at, "")
        .description
    ).toContain("network request failed");
    expect(routeErrorText("Journal", undefined, at, "").description).toContain(
      "the page code hit an error"
    );
    expect(
      routeErrorText("Journal", undefined, at, "").description
    ).not.toContain("Reference");
  });

  it("retries a client render error with reset only", async () => {
    const { container, reset, root } = await renderBoundary(
      WatchlistError,
      new Error("Failed to fetch")
    );
    expect(container.querySelector("a")).toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/failed to render at \d\d:\d\d UTC/);
    expect(container.textContent).not.toContain("unavailable");
    await act(async () => root.unmount());
  });

  it("refreshes server data before reset on a server error", async () => {
    const { container, reset, root } = await renderBoundary(
      AccountSettingsError,
      withDigest("hidden", "d1")
    );
    await act(async () => container.querySelector("button")?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Reference: d1.");
    await act(async () => root.unmount());
  });

  it("offers sign-in back to this page on a session error", async () => {
    const { container, root } = await renderBoundary(
      AccountSettingsError,
      new Error("UNAUTHORIZED")
    );
    const signIn = container.querySelector("a");
    expect(signIn?.textContent).toBe("Sign in");
    expect(signIn?.getAttribute("href")).toBe(
      "/sign-in?callbackURL=%2Fsettings%2Faccount"
    );
    expect(container.textContent).toContain("Try again");
    await act(async () => root.unmount());
  });
});
