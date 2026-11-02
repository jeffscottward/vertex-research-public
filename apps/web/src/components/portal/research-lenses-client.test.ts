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
      return runtime.client as ApiClient;
    }),
  };
});

import {
  createBrowserResearchLensesGateway,
  createResearchLensesGateway,
  describeResearchLensFailure,
} from "./research-lenses-client.ts";
import {
  deepValueFixture,
  deepValueScore,
  rotationFixture,
} from "./research-lenses-test-fixtures.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  return;
});

const fakeClient = () => {
  const rotationMatrix = vi.fn(async () => rotationFixture("3M"));
  const deepValue = vi.fn(async () => deepValueFixture());
  const deepValueScore$ = vi.fn(async () => deepValueScore());
  return {
    rotationMatrix,
    deepValue,
    deepValueScore: deepValueScore$,
    client: {
      researchLenses: {
        rotationMatrix,
        deepValue,
        deepValueScore: deepValueScore$,
      },
    } as unknown as ApiClient,
  };
};

describe("research lenses gateway", () => {
  it("maps each call to its researchLenses procedure input", async () => {
    const fake = fakeClient();
    const gateway = createResearchLensesGateway(fake.client);
    expect((await gateway.rotationMatrix("3M")).period).toBe("3M");
    expect(fake.rotationMatrix).toHaveBeenCalledWith({ period: "3M" });
    await gateway.deepValue();
    expect(fake.deepValue).toHaveBeenCalledWith({});
    await gateway.score("SIRI");
    return expect(fake.deepValueScore).toHaveBeenCalledWith({ symbol: "SIRI" });
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserResearchLensesGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.rotationMatrix("1M");
    await gateway.deepValue();
    await gateway.score("AAA");
    expect(runtime.origins).toEqual([window.location.origin]);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});

describe("research lens failure text", () => {
  return it("keeps the server message and names operator access", () => {
    expect(
      describeResearchLensFailure({
        code: "FORBIDDEN",
        status: 403,
        message: "Operator access required",
      })
    ).toBe("Operator access required.");
    expect(
      describeResearchLensFailure({
        message: "  Deep value scorecard not yet collected ",
      })
    ).toBe("Deep value scorecard not yet collected");
    expect(describeResearchLensFailure({ message: " " })).toBe(
      "Request failed."
    );
    return expect(describeResearchLensFailure("boom")).toBe("Request failed.");
  });
});
