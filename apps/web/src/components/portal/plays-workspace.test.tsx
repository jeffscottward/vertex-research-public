// @vitest-environment jsdom
import type { ApiClient, Play, PlaysListOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  createBrowserPlaysGateway,
  PLAYS_INTRO,
  PlaysWorkspace,
} from "./plays-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
});

// Fictional fixture: MOCKX is not a real ticker and this is not a real idea.
const play = (overrides: Partial<Play> = {}): Play => ({
  createdAt: "2026-11-07T12:00:00.000Z",
  definedRisk: true,
  exitRule: "Close at 50% loss or 2 days before expiry",
  id: "mockx-call-spread",
  legs: [
    {
      expiry: "2099-01-16",
      quantity: 1,
      right: "call",
      side: "buy",
      strike: 50,
    },
    {
      expiry: "2099-01-16",
      quantity: 1,
      right: "call",
      side: "sell",
      strike: 55,
    },
  ],
  maxLossUsd: 125,
  notes: "Fixture note",
  sourceUrl: "https://example.test/mockx",
  status: "idea",
  structure: "Jan 50/55 call debit spread",
  thesis: "Fixture thesis for a made-up ticker",
  ticker: "MOCKX",
  trigger: "MOCKX closes above 50",
  updatedAt: "2026-11-07T12:00:00.000Z",
  ...overrides,
});

const ready = (overrides: Partial<PlaysListOutput> = {}): PlaysListOutput => ({
  plays: [
    play(),
    play({
      id: "mockx-put",
      maxLossUsd: 80,
      notes: null,
      sourceUrl: null,
      status: "armed",
    }),
  ],
  ...overrides,
});

const mount = async (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

describe("PlaysWorkspace", () => {
  it("lists plays with the read-only notice, the columns and a defined max loss", async () => {
    const container = await mount(
      <PlaysWorkspace gateway={{ list: async () => ready() }} />
    );
    expect(container.querySelector('[role="note"]')?.textContent).toBe(
      PLAYS_INTRO
    );
    expect(PLAYS_INTRO).toBe(
      "Potential option trades. Ideas only: nothing here places an order. Every play needs a defined max loss (≤2% NLV) and an exit rule."
    );
    expect(
      [...container.querySelectorAll("thead th")].map((th) => th.textContent)
    ).toEqual([
      "Ticker",
      "Status",
      "Thesis",
      "Structure",
      "Legs",
      "Max loss",
      "Risk",
      "Trigger",
      "Exit",
      "Source",
    ]);
    const first = container.querySelector('[data-play="mockx-call-spread"]');
    expect(first?.textContent).toContain("MOCKX");
    expect(first?.textContent).toContain("Fixture note");
    expect(first?.textContent).toContain("Jan 50/55 call debit spread");
    expect(
      [...(first?.querySelectorAll("[data-play-leg]") ?? [])].map(
        (leg) => leg.textContent
      )
    ).toEqual(["buy 1 2099-01-16 50 call", "sell 1 2099-01-16 55 call"]);
    expect(
      first?.querySelector("[data-play-defined-risk]")?.textContent
    ).toContain("Defined risk");
    expect(first?.textContent).toContain("Close at 50% loss");
    expect(first?.textContent).toContain("MOCKX closes above 50");
    expect(first?.querySelector("[data-play-max-loss]")?.textContent).toBe(
      "$125"
    );
    const link = first?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.test/mockx");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("target")).toBe("_blank");
    const second = container.querySelector('[data-play="mockx-put"]');
    expect(
      second
        ?.querySelector("[data-play-status]")
        ?.getAttribute("data-play-status")
    ).toBe("armed");
    expect(second?.querySelector("a")).toBeNull();
    expect(second?.textContent).toContain("—");
    expect(container.textContent).toContain("no order or approve");
    // Read-only: the only button anywhere on the ready page would be an order action.
    expect(container.querySelector("button")).toBeNull();
  });

  it("never links a non-https source", async () => {
    const container = await mount(
      <PlaysWorkspace
        gateway={{
          list: async () =>
            ready({ plays: [play({ sourceUrl: "javascript:alert(1)" })] }),
        }}
      />
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows the empty state", async () => {
    const empty = await mount(
      <PlaysWorkspace gateway={{ list: async () => ready({ plays: [] }) }} />
    );
    expect(empty.querySelector("[data-plays-empty]")?.textContent).toBe(
      "No plays yet."
    );
    expect(empty.querySelector("table")).toBeNull();
  });

  it("shows a storage failure with a retry, and access-required for non-operators", async () => {
    let fail = true;
    const container = await mount(
      <PlaysWorkspace
        gateway={{
          list: async () => {
            if (fail)
              throw {
                code: "STORAGE_ERROR",
                message: "Plays storage is unavailable",
              };
            return ready();
          },
        }}
      />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "STORAGE_ERROR: Plays storage is unavailable"
    );
    fail = false;
    await act(async () => container.querySelector("button")?.click());
    expect(
      container.querySelector('[data-plays-state="ready"]')
    ).not.toBeNull();
    const denied = await mount(
      <PlaysWorkspace
        gateway={{
          list: async () => {
            throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
          },
        }}
      />
    );
    expect(
      denied
        .querySelector("[data-operator-feature]")
        ?.getAttribute("data-operator-feature")
    ).toBe("plays");
  });

  it("shows loading first", async () => {
    let resolve: (value: PlaysListOutput) => void = () => undefined;
    const pending = new Promise<PlaysListOutput>((done) => {
      resolve = done;
    });
    const container = await mount(
      <PlaysWorkspace gateway={{ list: () => pending }} />
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading plays…"
    );
    await act(async () => resolve(ready()));
    expect(
      container.querySelector('[data-plays-state="ready"]')
    ).not.toBeNull();
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const list = vi.fn(async () => ready());
    runtime.client = { plays: { list } } as unknown as ApiClient;
    const gateway = createBrowserPlaysGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.list();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
    await mount(<PlaysWorkspace />);
    expect(list).toHaveBeenCalledTimes(3);
  });
});
