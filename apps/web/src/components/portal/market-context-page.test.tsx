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
import { MARKET_CONTEXT_REFRESH_MS } from "./market-context-workspace.tsx";
import { MARKET_FEEDS_REFRESH_MS } from "./market-feeds-workspace.tsx";

// Long enough for both workspace timers to fire once (both are one minute).
const BOTH_TIMERS_MS = Math.max(
  MARKET_CONTEXT_REFRESH_MS,
  MARKET_FEEDS_REFRESH_MS
);

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
  vi.useRealTimers();
});

const VOLATILITY: MarketVolatilityOutput = {
  implied: null,
  sourceErrors: [],
  spread: null,
  spx: null,
  vix: {
    asOf: "2026-10-20",
    change1d: 0.4,
    pct1y: 62,
    stale: false,
    value: 17.2,
  },
  vixeq: null,
  vvix: null,
};

const feeds = (
  stale: boolean,
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-03T14:59:00.000Z",
  gex: null,
  macro: null,
  missing: [],
  news: null,
  stale,
  ...overrides,
});

/** A gateway call per load; the test settles each answer later, in any order.
 * Executor form: the web tsconfig lib predates Promise.withResolvers. */
const queued = <Value,>() => {
  const answers: ((value: Value) => void)[] = [];
  const call = vi.fn(
    () =>
      new Promise<Value>((resolve) => {
        answers.push(resolve);
      })
  );
  return { answers, call };
};

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

const refreshDisabled = (container: HTMLElement) =>
  refreshButton(container)?.disabled;

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
    // Loads that settle before the busy render must not leave Refresh disabled.
    expect(refreshButton(container)?.disabled).toBe(false);
    await act(async () => refreshButton(container)?.click());
    expect(volatility).toHaveBeenCalledTimes(3);
    expect(refreshButton(container)?.disabled).toBe(false);
  });

  it.each<[string, MarketVolatilityOutput, MarketContextOutput, string]>([
    ["fresh, complete data", VOLATILITY, feeds(false), "Live"],
    [
      "a stale volatility series",
      {
        ...VOLATILITY,
        vvix: {
          asOf: "2026-10-17",
          change1d: null,
          pct1y: null,
          stale: true,
          value: 95,
        },
      },
      feeds(false),
      "Stale",
    ],
    [
      "a volatility source error",
      { ...VOLATILITY, sourceErrors: ["Cboe: HTTP 503"] },
      feeds(false),
      "Partial",
    ],
    [
      "a feed section the rig could not read",
      VOLATILITY,
      feeds(false, { missing: ["gex"] }),
      "Partial",
    ],
  ])("says %s → %s", async (_case, volatility, context, label) => {
    const container = await mount({
      contextGateway: { volatility: async () => volatility },
      feedsGateway: { context: async () => context },
    });
    expect(chip(container)).toBe(label);
  });

  it("holds Refresh while any load is in flight, from Refresh or the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const volatility = queued<MarketVolatilityOutput>();
    const context = queued<MarketContextOutput>();
    const container = await mount({
      contextGateway: { volatility: volatility.call },
      feedsGateway: { context: context.call },
    });
    expect(refreshDisabled(container)).toBe(true);
    await act(async () => volatility.answers[0]?.(VOLATILITY));
    // GEX, macro and news are still out.
    expect(refreshDisabled(container)).toBe(true);
    await act(async () => context.answers[0]?.(feeds(false)));
    expect(refreshDisabled(container)).toBe(false);
    expect(chip(container)).toBe("Live");

    await act(async () => refreshButton(container)?.click());
    expect(volatility.call).toHaveBeenCalledTimes(2);
    expect(context.call).toHaveBeenCalledTimes(2);
    expect(refreshDisabled(container)).toBe(true);
    // The data on screen stays while the refresh is out.
    expect(chip(container)).toBe("Live");
    await act(async () => context.answers[1]?.(feeds(false)));
    expect(refreshDisabled(container)).toBe(true);
    await act(async () => volatility.answers[1]?.(VOLATILITY));
    expect(refreshDisabled(container)).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(BOTH_TIMERS_MS);
    });
    expect(volatility.call).toHaveBeenCalledTimes(3);
    expect(context.call).toHaveBeenCalledTimes(3);
    expect(refreshDisabled(container)).toBe(true);
    await act(async () => {
      volatility.answers[2]?.(VOLATILITY);
      context.answers[2]?.(feeds(false));
    });
    expect(refreshDisabled(container)).toBe(false);
  });

  it("keeps the newer answer in the chip when an older load settles last", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const volatility = queued<MarketVolatilityOutput>();
    const context = queued<MarketContextOutput>();
    const container = await mount({
      contextGateway: { volatility: volatility.call },
      feedsGateway: { context: context.call },
    });
    await act(async () => {
      volatility.answers[0]?.(VOLATILITY);
      context.answers[0]?.(feeds(false));
    });
    await act(async () => refreshButton(container)?.click());
    // The minute timer fires while the Refresh loads are still out.
    await act(async () => {
      vi.advanceTimersByTime(BOTH_TIMERS_MS);
    });
    expect(volatility.call).toHaveBeenCalledTimes(3);
    expect(context.call).toHaveBeenCalledTimes(3);
    await act(async () => {
      volatility.answers[2]?.(VOLATILITY);
      context.answers[2]?.(feeds(false));
    });
    expect(chip(container)).toBe("Live");
    expect(refreshDisabled(container)).toBe(false);
    await act(async () => {
      volatility.answers[1]?.({ ...VOLATILITY, sourceErrors: ["Cboe: 503"] });
      context.answers[1]?.(feeds(true));
    });
    expect(chip(container)).toBe("Live");
    expect(refreshDisabled(container)).toBe(false);
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
