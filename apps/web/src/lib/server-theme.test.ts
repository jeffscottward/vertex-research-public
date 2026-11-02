import { describe, expect, it, vi } from "vitest";

import {
  INDETERMINATE_THEME,
  loadTrustedThemeOncePerRequest,
} from "./server-theme.ts";

const TRUSTED = Object.freeze({ theme: "github-light" });

describe("trusted theme load per request", () => {
  it("dispatches once for two calls with the same request headers", async () => {
    const requestHeaders = new Headers({ cookie: "session=a" });
    const load = vi.fn(async () => TRUSTED);

    const probe = loadTrustedThemeOncePerRequest(requestHeaders, load);
    const render = loadTrustedThemeOncePerRequest(requestHeaders, load);

    expect(render).toBe(probe);
    await expect(probe).resolves.toBe(TRUSTED);
    await expect(render).resolves.toBe(TRUSTED);
    return expect(load).toHaveBeenCalledTimes(1);
  });

  it("dispatches again for a different request", async () => {
    const load = vi.fn(async () => TRUSTED);

    await loadTrustedThemeOncePerRequest(new Headers(), load);
    await loadTrustedThemeOncePerRequest(new Headers(), load);

    return expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed or indeterminate load inside its own request", async () => {
    const failedRequest = new Headers();
    const failure = new Error("dispatch failed");
    const failing = vi.fn(async () => {
      throw failure;
    });
    await expect(
      loadTrustedThemeOncePerRequest(failedRequest, failing)
    ).rejects.toBe(failure);
    await expect(
      loadTrustedThemeOncePerRequest(failedRequest, failing)
    ).rejects.toBe(failure);
    expect(failing).toHaveBeenCalledTimes(1);

    const indeterminateRequest = new Headers();
    const indeterminate = vi.fn(async () => INDETERMINATE_THEME);
    await expect(
      loadTrustedThemeOncePerRequest(indeterminateRequest, indeterminate)
    ).resolves.toBe(INDETERMINATE_THEME);
    await expect(
      loadTrustedThemeOncePerRequest(indeterminateRequest, indeterminate)
    ).resolves.toBe(INDETERMINATE_THEME);
    expect(indeterminate).toHaveBeenCalledTimes(1);

    const next = vi.fn(async () => TRUSTED);
    await expect(
      loadTrustedThemeOncePerRequest(new Headers(), next)
    ).resolves.toBe(TRUSTED);
    return expect(next).toHaveBeenCalledTimes(1);
  });
});
