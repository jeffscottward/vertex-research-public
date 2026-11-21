// @vitest-environment jsdom
import type { ApiClient, OpenbbInsiderClustersOutput } from "@darkfactory/api";
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
      return runtime.client as ApiClient;
    }),
  };
});

import {
  createBrowserInsiderClustersGateway,
  createInsiderClustersGateway,
} from "./insider-clusters-client.ts";

const output: OpenbbInsiderClustersOutput = {
  clusters: [],
  coverage: {
    incompleteDays: [],
    lastOkAt: null,
    lastRunAt: null,
    lastStatus: null,
    newestCompleteDay: null,
    overdue: true,
  },
  days: 7,
  delay: "Filed within 2 business days",
  receivedAt: "2026-10-13T15:00:00.000Z",
  source: "SEC EDGAR Form 4",
};

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
});

const fakeClient = () => {
  const insiderClusters = vi.fn(async () => output);
  return {
    client: { openbb: { insiderClusters } } as unknown as ApiClient,
    insiderClusters,
  };
};

describe("insider clusters gateway", () => {
  it("sends the window", async () => {
    const fake = fakeClient();
    expect(
      await createInsiderClustersGateway(fake.client).clusters({ days: 14 })
    ).toBe(output);
    expect(fake.insiderClusters).toHaveBeenCalledWith({ days: 14 });
  });

  it("creates the browser client once, lazily, at the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserInsiderClustersGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.clusters({ days: 7 });
    await gateway.clusters({ days: 30 });
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(fake.insiderClusters).toHaveBeenCalledTimes(2);
  });
});
