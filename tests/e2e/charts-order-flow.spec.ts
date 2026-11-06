import type { Route } from "@playwright/test";

import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// /charts Order flow panel. The IBKR history service is not reachable in a browser run, so the
// bars, ticks and depth RPCs are answered with clearly fictional data; depth answers ENTITLEMENT
// (no L2 permission) so the honest unavailable state is exercised. Display only: no order path.

const DAY_SECONDS = 86_400;
const HALF_HOUR = 1800;
const START_SECONDS = Date.UTC(2024, 0, 1) / 1000;
// 2024-06-07 09:30 New York (EDT) for the 30-minute TPO bars and the tick window.
const SESSION_OPEN = Date.UTC(2024, 5, 7, 13, 30) / 1000;

const contract = {
  conId: 1,
  currency: "USD",
  exchange: "SMART",
  lastTradeDateOrContractMonth: null,
  localSymbol: "SPY",
  longName: "Synthetic E2E order flow (fictional)",
  matches: 1,
  multiplier: null,
  secType: "STK",
  timeZoneId: "US/Eastern",
};
const cache = { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 60 };
const instrument = {
  contractMonth: null,
  currency: "USD",
  exchange: "SMART",
  secType: "STK",
  symbol: "SPY",
};

const dailyBars = () =>
  Array.from({ length: 60 }, (_, index) => {
    const close = 100 + 5 * Math.sin(index / 6);
    return {
      c: close,
      h: close + 1.2,
      l: close - 1.4,
      o: close - 0.3,
      t: START_SECONDS + index * DAY_SECONDS,
      v: 1000,
    };
  });

const halfHourBars = () =>
  Array.from({ length: 13 }, (_, index) => {
    const mid = 100 + Math.sin(index / 2);
    return {
      c: mid + 0.1,
      h: mid + 0.4,
      l: mid - 0.4,
      o: mid - 0.1,
      t: SESSION_OPEN + index * HALF_HOUR,
      v: 500,
    };
  });

// RPCLink sends the input as JSON in the POST body (or ?data= for GET).
const requestText = (route: Route): string =>
  route.request().postData() ??
  new URL(route.request().url()).searchParams.get("data") ??
  "";

const fulfillJson = async (route: Route, json: unknown) =>
  await route.fulfill({
    body: JSON.stringify({ json }),
    contentType: "application/json",
    status: 200,
  });

const fulfillBars = async (route: Route) => {
  const tpo = requestText(route).includes("30 mins");
  const bars = tpo ? halfHourBars() : dailyBars();
  return await fulfillJson(route, {
    asOf: null,
    bars,
    cache,
    contract,
    count: bars.length,
    fetchedAt: "2024-06-09T00:00:00Z",
    receivedAt: "2024-06-09T00:00:01Z",
    request: {
      ...instrument,
      barSize: tpo ? "30 mins" : "1 day",
      duration: tpo ? "5 D" : "1 Y",
      useRTH: true,
      whatToShow: "TRADES",
    },
    source: "ibkr-gateway",
  });
};

const TICK_START = SESSION_OPEN + 4 * 3600;
const fulfillTicks = async (route: Route) => {
  const trades = Array.from({ length: 120 }, (_, index) => ({
    c: null,
    p: 100 + ((index * 7) % 5) / 100,
    s: 100,
    t: TICK_START + index,
    x: index % 2 === 0 ? "E2E-A" : "E2E-B",
  }));
  const quotes = Array.from({ length: 30 }, (_, index) => ({
    ap: 100.03,
    as: 4,
    bp: 100.01,
    bs: 3,
    t: TICK_START + index * 4,
  }));
  return await fulfillJson(route, {
    asOf: new Date((TICK_START + 119) * 1000).toISOString(),
    cache,
    contract,
    fetchedAt: "2024-06-07T17:32:00Z",
    quotes,
    receivedAt: "2024-06-07T17:32:01Z",
    request: { ...instrument, count: 500, quotes: true, useRTH: false },
    source: "ibkr-gateway",
    trades,
  });
};

const fulfillDepthEntitlement = async (route: Route) =>
  await route.fulfill({
    body: JSON.stringify({
      json: {
        code: "ENTITLEMENT",
        defined: true,
        message: "IBKR market data permissions missing for this request",
        status: 502,
      },
    }),
    contentType: "application/json",
    status: 502,
  });

// The STK chart also mounts the QuantData options panel; answer it with an empty snapshot.
const emptySection = { message: null, status: "empty" } as const;
const fulfillOptionsSnapshot = async (route: Route) =>
  await fulfillJson(route, {
    exposure: {
      ...emptySection,
      gexExpiry: null,
      maxPain: null,
      strikes: [],
      totalGex: null,
    },
    flow: {
      ...emptySection,
      buckets: [],
      callPremium: 0,
      events: [],
      hours: 24,
      putPremium: 0,
    },
    notes: [],
    rateLimited: false,
    receivedAt: "2024-06-09T00:00:01Z",
    retryAfterSeconds: null,
    source: "quantdata",
    spot: null,
    symbol: "SPY",
    volatility: {
      ...emptySection,
      skew: [],
      surface: { moneyness: [], rows: [] },
      termStructure: [],
    },
  });

test.beforeAll(() => resetDatabase());

test("Order flow loads on demand, renders every tab and shows the depth ENTITLEMENT", async ({
  browserErrors,
  page,
}, testInfo) => {
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/marketData/depth",
    status: 502,
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ height: 900, width: 375 });
  let tickCalls = 0;
  await page.route("**/api/orpc/marketData/bars", fulfillBars);
  await page.route("**/api/orpc/marketData/ticks", async (route) => {
    tickCalls += 1;
    return await fulfillTicks(route);
  });
  await page.route("**/api/orpc/marketData/depth", fulfillDepthEntitlement);
  await page.route(
    "**/api/orpc/optionsAnalytics/snapshot",
    fulfillOptionsSnapshot
  );
  await page.goto("/charts");

  const panel = page.locator('[data-order-flow="SPY"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(
    panel.getByRole("heading", { name: "Order flow" })
  ).toBeVisible();
  // Lazy: nothing fetched before the operator asks.
  expect(tickCalls).toBe(0);
  await panel.getByRole("button", { name: "Load order flow" }).click();

  const tabs = panel.getByRole("tablist", { name: "Order flow views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Time & Sales",
    "Order book",
    "Footprint",
    "Delta / CVD",
    "TPO",
  ]);
  const view = panel.getByRole("tabpanel");
  await expect(view.locator("[data-time-sales] tbody tr")).toHaveCount(120);
  await expect(view.locator("[data-tick-coverage]")).toContainText(
    "120 trades, 13:30:00-13:31:59 ET"
  );
  await expect(view.locator("[data-signing-counts]")).toContainText(
    "quote rule"
  );

  await tabs.getByRole("tab", { name: "Order book" }).click();
  const alert = view.getByRole("alert");
  await expect(alert).toHaveAttribute("data-error-code", "ENTITLEMENT");
  await expect(alert).toContainText(
    "The IBKR account has no L2 market depth permission for SPY on SMART"
  );
  await expect(alert).toContainText("subscriptions are not active");

  await tabs.getByRole("tab", { name: "Footprint" }).click();
  await expect(view.locator("[data-footprint]")).toBeVisible();
  await expect(view.locator("[data-window-note]")).toContainText(
    "Covers only the fetched tick window"
  );
  await tabs.getByRole("tab", { name: "Delta / CVD" }).click();
  await expect(view.locator("[data-cvd-chart]")).toBeVisible();
  await tabs.getByRole("tab", { name: "TPO" }).click();
  await expect(view.locator("[data-tpo-profile]")).toHaveAttribute(
    "data-tpo-profile",
    "2024-06-07"
  );

  // 375 px: wide grids scroll inside their own boxes, so the panel never widens the page.
  for (const name of ["Time & Sales", "Footprint", "TPO"]) {
    await tabs.getByRole("tab", { name }).click();
    const fit = await panel.evaluate((node) => ({
      inside: node.getBoundingClientRect().right <= window.innerWidth + 0.5,
      overflow: node.scrollWidth - node.clientWidth,
    }));
    expect(fit).toEqual({ inside: true, overflow: 0 });
  }

  const screenshot = testInfo.outputPath("charts-order-flow-375-dark.png");
  await panel.screenshot({ path: screenshot });
  await testInfo.attach("charts-order-flow-375-dark", {
    contentType: "image/png",
    path: screenshot,
  });
});
