// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  createBrowserAgentFrameworksGateway,
  FRAMEWORK_STATUS_LABELS,
  POINT_IN_TIME_LABELS,
} from "./agent-frameworks-client.ts";

const { calls, createApiClient } = vi.hoisted(() => {
  const calls: unknown[] = [];
  const createApiClient = vi.fn((_options: unknown) => ({
    agentModelRuns: {
      frameworks: async (input: unknown) => {
        calls.push(input);
        return { frameworks: [{ id: "vibe_trading" }] };
      },
    },
  }));
  return { calls, createApiClient };
});

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient,
}));

describe("browser frameworks gateway", () => {
  it("reads the sheets through one lazily created client", async () => {
    const gateway = createBrowserAgentFrameworksGateway();
    expect(createApiClient).not.toHaveBeenCalled();
    expect(await gateway.frameworks()).toEqual([{ id: "vibe_trading" }]);
    expect(await gateway.frameworks()).toEqual([{ id: "vibe_trading" }]);
    expect(createApiClient).toHaveBeenCalledTimes(1);
    expect(createApiClient).toHaveBeenCalledWith({
      baseUrl: window.location.origin,
    });
    expect(calls).toEqual([{}, {}]);
  });

  it("labels every status and point-in-time value", () => {
    expect(Object.keys(FRAMEWORK_STATUS_LABELS).sort()).toEqual([
      "adapted",
      "external",
      "reimplemented",
    ]);
    expect(POINT_IN_TIME_LABELS.no).toBe("Not point in time");
  });
});
