// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@darkfactory/api")>();
  return {
    ...actual,
    createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
      runtime.origins.push(options.baseUrl);
      return runtime.client!;
    }),
  };
});

import { fixtureSnapshot } from "./portfolio-monitor-fixture.ts";
import {
  createBrowserPortfolioMonitorGateway,
  createPortfolioMonitorGateway,
  describePortfolioMonitorFailure,
} from "./portfolio-monitor-client.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  return;
});

const fakeClient = () => {
  const snapshot = vi.fn(async () => fixtureSnapshot());
  return {
    snapshot,
    client: { portfolioMonitor: { snapshot } } as unknown as ApiClient,
  };
};

describe("portfolio monitor gateway", () => {
  it("reads portfolioMonitor.snapshot with an empty input", async () => {
    const { client, snapshot } = fakeClient();
    const result = await createPortfolioMonitorGateway(client).snapshot();
    expect(snapshot).toHaveBeenCalledWith({});
    return expect(result.readOnly).toBe(true);
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const { client, snapshot } = fakeClient();
    runtime.client = client;
    const gateway = createBrowserPortfolioMonitorGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.snapshot();
    await gateway.snapshot();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(snapshot).toHaveBeenCalledTimes(2);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});

describe("portfolio monitor failures", () => {
  it("keeps the oRPC code and message and classifies the failure", () => {
    expect(
      describePortfolioMonitorFailure({
        code: "NOT_CONFIGURED",
        message: "Portfolio monitor endpoint not configured",
      })
    ).toEqual({
      kind: "not-configured",
      code: "NOT_CONFIGURED",
      message: "Portfolio monitor endpoint not configured",
    });
    expect(
      describePortfolioMonitorFailure({
        code: "UNAVAILABLE",
        message: "IBKR portfolio service unavailable",
      }).kind
    ).toBe("unavailable");
    expect(
      describePortfolioMonitorFailure({
        code: "UPSTREAM_ERROR",
        message: "Portfolio snapshot request failed",
      }).kind
    ).toBe("unavailable");
    expect(
      describePortfolioMonitorFailure({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      }).kind
    ).toBe("unauthorized");
    return expect(
      describePortfolioMonitorFailure({
        code: "FORBIDDEN",
        message: "Forbidden",
      })
    ).toEqual({
      kind: "forbidden",
      code: "FORBIDDEN",
      message: "Operator access required",
    });
  });

  return it("falls back for unknown errors", () => {
    expect(describePortfolioMonitorFailure(new Error("network down"))).toEqual({
      kind: "error",
      code: "ERROR",
      message: "network down",
    });
    expect(describePortfolioMonitorFailure("text")).toEqual({
      kind: "error",
      code: "ERROR",
      message: "Request failed",
    });
    return expect(
      describePortfolioMonitorFailure({ code: "  ", message: "" })
    ).toEqual({ kind: "error", code: "ERROR", message: "Request failed" });
  });
});
