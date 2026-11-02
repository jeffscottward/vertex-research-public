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
  createBrowserPriceAlertsGateway,
  createPriceAlertsGateway,
  describePriceAlertFailure,
} from "./price-alerts-client.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
});

const fakeClient = () => {
  const procedures = {
    check: vi.fn(async () => ({ checked: 0 })),
    create: vi.fn(async () => ({ rule: { id: "rule-1" } })),
    list: vi.fn(async () => ({ rules: [] })),
    remove: vi.fn(async () => ({ id: "rule-1", removed: true })),
  };
  return {
    client: { priceAlerts: procedures } as unknown as ApiClient,
    procedures,
  };
};

describe("price alerts gateway", () => {
  it("maps each call to its priceAlerts procedure input", async () => {
    const fake = fakeClient();
    const gateway = createPriceAlertsGateway(fake.client);
    await gateway.list();
    expect(fake.procedures.list).toHaveBeenCalledWith({});
    const input = {
      kind: "above",
      level: "1",
      role: "price",
      symbol: "AAPL",
    } as const;
    await expect(gateway.create(input)).resolves.toEqual({ id: "rule-1" });
    expect(fake.procedures.create).toHaveBeenCalledWith(input);
    await expect(gateway.remove("rule-1")).resolves.toBeUndefined();
    expect(fake.procedures.remove).toHaveBeenCalledWith({ id: "rule-1" });
    await gateway.check();
    expect(fake.procedures.check).toHaveBeenCalledWith({});
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserPriceAlertsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.create({
      kind: "below",
      level: "2",
      role: "stop",
      symbol: "BAC",
    });
    await gateway.remove("rule-1");
    await gateway.check();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
  });

  it("describes failures with the server message or the operator notice", () => {
    expect(describePriceAlertFailure({ code: "FORBIDDEN" })).toBe(
      "Operator access required."
    );
    expect(
      describePriceAlertFailure({
        code: "BAD_REQUEST",
        message: " Add the symbol to your watchlist before creating an alert ",
      })
    ).toBe("Add the symbol to your watchlist before creating an alert");
    expect(describePriceAlertFailure({ message: " " })).toBe("Request failed.");
    expect(describePriceAlertFailure("boom")).toBe("Request failed.");
    expect(describePriceAlertFailure(null)).toBe("Request failed.");
  });
});
