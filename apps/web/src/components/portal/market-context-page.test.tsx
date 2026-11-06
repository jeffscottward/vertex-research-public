// @vitest-environment jsdom
import type {
  ApiClient,
  MarketContextOutput,
  MarketVolatilityOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: null as ApiClient | null }));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn(() => runtime.client as ApiClient),
}));

import {
  MarketContextPage,
  type MarketContextPageProps,
} from "./market-context-page.tsx";

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
});

const VOLATILITY: MarketVolatilityOutput = {
  vix: {
    value: 17.2,
    asOf: "2026-10-20",
    change1d: 0.4,
    pct1y: 62,
    stale: false,
  },
  vixeq: null,
  vvix: null,
  spread: null,
  spx: null,
  implied: null,
  sourceErrors: [],
};

const feeds = (stale: boolean): MarketContextOutput => ({
  generatedAt: "2026-11-03T14:59:00.000Z",
  stale,
  missing: [],
  gex: null,
  macro: null,
  news: null,
});

const mount = async (
  props: MarketContextPageProps = {}
): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<MarketContextPage {...props} />));
  return container;
};

/** Header chip text without StatusBadge's screen-reader "Status:" prefix. */
const chip = (container: HTMLElement) =>
  container
    .querySelector("[data-market-status]")
    ?.textContent?.replace(/^Status:\s*/u, "");

const refreshButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh"
  );

describe("Market context page", () => {
  it("shows one header with a loading chip and a disabled Refresh until both feeds answer", async () => {
    const container = await mount({
      contextGateway: { volatility: () => new Promise(() => undefined) },
      feedsGateway: { context: () => new Promise(() => undefined) },
    });
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("Market context");
    expect(chip(container)).toBe("Loading");
    expect(refreshButton(container)?.disabled).toBe(true);
  });

  it("sums both feeds into the chip and refreshes both on Refresh", async () => {
    let stale = false;
    const volatility = vi.fn(async () => VOLATILITY);
    const context = vi.fn(async () => feeds(stale));
    const container = await mount({
      contextGateway: { volatility },
      feedsGateway: { context },
    });
    expect(chip(container)).toBe("Live");
    expect(refreshButton(container)?.disabled).toBe(false);
    stale = true;
    await act(async () => refreshButton(container)?.click());
    expect(volatility).toHaveBeenCalledTimes(2);
    expect(context).toHaveBeenCalledTimes(2);
    expect(chip(container)).toBe("Stale");
  });

  it("says Partial when one feed fails and uses the browser clients by default", async () => {
    runtime.client = {
      ibkrMonitor: { volatility: vi.fn(async () => VOLATILITY) },
      marketContext: {
        get: vi.fn(async () => {
          throw {
            code: "UNAVAILABLE",
            message: "No market context pushed yet",
          };
        }),
      },
    } as unknown as ApiClient;
    const container = await mount();
    expect(
      container.querySelector('[data-market-state="ready"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-feeds-state="error"]')
    ).not.toBeNull();
    expect(chip(container)).toBe("Partial");
  });
});
