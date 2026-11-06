// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { describe, expect, it, vi } from "vitest";

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
      return runtime.client as ApiClient;
    }),
  };
});

import { createBrowserSignalAlertsGateway } from "./signal-alerts-client.ts";

describe("browser signal alerts gateway", () => {
  it("creates the client lazily, once, on the page origin", async () => {
    const signals = {
      backfill: vi.fn(async () => ({})),
      check: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ rule: { id: "rule-1" } })),
      dismiss: vi.fn(async () => ({ rule: { id: "rule-1" } })),
      events: vi.fn(async () => ({ events: [] })),
      list: vi.fn(async () => ({ rules: [] })),
      propose: vi.fn(async () => ({ ok: false, reason: "x" })),
      remove: vi.fn(async () => ({ id: "rule-1", removed: true })),
      start: vi.fn(async () => ({ rule: { id: "rule-1" } })),
    };
    runtime.client = { priceAlerts: { signals } } as unknown as ApiClient;
    const gateway = createBrowserSignalAlertsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.create({} as never);
    await gateway.backfill({} as never);
    await gateway.propose("watch NQ");
    await gateway.start("rule-1");
    await gateway.dismiss("rule-1");
    await gateway.remove("rule-1");
    await gateway.check();
    await gateway.events(null);
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(
      Object.values(signals).every((fn) => fn.mock.calls.length === 1)
    ).toBe(true);
    expect(Object.isFrozen(gateway)).toBe(true);
  });
});
