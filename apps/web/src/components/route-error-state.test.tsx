// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

const at = new Date("2026-11-15T14:05:00Z");
const withDigest = (message: string, digest: string): RouteError =>
  Object.assign(new Error(message), { digest });

describe("route error state", () => {
  it("classifies each cause", () => {
    expect(routeErrorCause(new Error("401 Unauthorized"))).toBe(
      "session-expired"
    );
    expect(routeErrorCause(new Error("Failed to fetch"))).toBe(
      "network-failed"
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
      "Cause: the server hit an error while rendering. Reference: abc123. No data was changed. Select Try again to reload it."
    );
    expect(
      routeErrorText("Journal", new Error("session expired"), at, "")
        .description
    ).toContain("Sign in again");
    expect(
      routeErrorText("Journal", new Error("network down"), at, "").description
    ).toContain("network request failed");
    expect(
      routeErrorText("Journal", undefined, at, "").description
    ).not.toContain("Reference");
  });

  it("renders boundaries with a working retry", async () => {
    for (const Boundary of [WatchlistError, AccountSettingsError]) {
      const container = document.createElement("div");
      const root = createRoot(container);
      const reset = vi.fn();
      await act(async () =>
        root.render(
          <Boundary error={new Error("Failed to fetch")} reset={reset} />
        )
      );
      await act(async () => container.querySelector("button")?.click());
      expect(reset).toHaveBeenCalledTimes(1);
      expect(container.textContent).toMatch(
        /failed to render at \d\d:\d\d UTC/
      );
      expect(container.textContent).not.toContain("unavailable");
      await act(async () => root.unmount());
    }
  });
});
