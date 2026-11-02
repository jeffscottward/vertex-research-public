// @vitest-environment jsdom
import type { ApiClient, SetupReplayRunInput } from "@darkfactory/api";
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
  createBrowserSetupReplayGateway,
  createSetupReplayGateway,
  describeSetupReplayFailure,
} from "./setup-replay-client.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
});

const input: SetupReplayRunInput = {
  maxHoldBars: 10,
  paths: 1000,
  seriesId: "SPY:1d",
  setup: "breakout20",
  stop: { kind: "atr", multiple: 2 },
  targetR: 2,
};

const fakeClient = () => {
  const series = vi.fn(async () => ({ series: [] }));
  const presets = vi.fn(async () => ({ presets: [] }));
  const run = vi.fn(async () => ({ ran: true }));
  return {
    client: {
      instantBacktest: { series },
      setupReplay: { presets, run },
    } as unknown as ApiClient,
    presets,
    run,
    series,
  };
};

describe("setup replay gateway", () => {
  it("maps each call to its procedure", async () => {
    const fake = fakeClient();
    const gateway = createSetupReplayGateway(fake.client);
    await gateway.series();
    await gateway.presets();
    await gateway.run(input);
    expect(fake.series).toHaveBeenCalledTimes(1);
    expect(fake.presets).toHaveBeenCalledTimes(1);
    expect(fake.run).toHaveBeenCalledWith(input);
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserSetupReplayGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.series();
    await gateway.presets();
    await gateway.run(input);
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
  });

  it("describes failures in one line", () => {
    expect(describeSetupReplayFailure({ code: "FORBIDDEN" })).toBe(
      "Operator access required."
    );
    expect(describeSetupReplayFailure(new Error(" Too short "))).toBe(
      "Too short"
    );
    expect(describeSetupReplayFailure({ message: 4 })).toBe("Request failed.");
    expect(describeSetupReplayFailure(null)).toBe("Request failed.");
    expect(describeSetupReplayFailure("boom")).toBe("Request failed.");
  });
});
