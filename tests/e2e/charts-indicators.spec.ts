import type { Page, Route } from "@playwright/test";

import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// /charts indicator overlays. The IBKR history service is not reachable in a
// browser run, so the bars RPC is answered with clearly fictional bars.
// Display only: no order path exists on this page.

const DAY_SECONDS = 86_400;
const START_SECONDS = Date.UTC(2024, 0, 1) / 1000;

const syntheticBars = (size: number) =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + 10 * Math.sin(index / 6) + index * 0.1;
    return {
      t: START_SECONDS + index * DAY_SECONDS,
      o: close - 0.3,
      h: close + 1.2,
      l: close - 1.4,
      c: close,
      v: 1000 + ((index * 37) % 400),
    };
  });

const barsResponse = () => {
  const bars = syntheticBars(160);
  const last = bars.at(-1);
  return {
    source: "ibkr-gateway",
    request: {
      symbol: "SPY",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
      barSize: "1 day",
      duration: "1 Y",
      whatToShow: "TRADES",
      useRTH: true,
      contractMonth: null,
    },
    contract: {
      conId: 1,
      secType: "STK",
      localSymbol: "SPY",
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: null,
      multiplier: null,
      longName: "Synthetic E2E bars (fictional)",
      timeZoneId: "UTC",
      matches: 1,
    },
    bars,
    count: bars.length,
    fetchedAt: "2024-06-09T00:00:00Z",
    asOf: last === undefined ? null : new Date(last.t * 1000).toISOString(),
    cache: { hit: false, ageSeconds: 0, ttlSeconds: 60, stale: false },
    receivedAt: "2024-06-09T00:00:01Z",
  };
};

const fulfillBars = async (route: Route) =>
  await route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({ json: barsResponse() }),
  });

// The STK chart also mounts the QuantData options panel. CI has no QuantData
// key, so its snapshot RPC gets a fictional, empty (but schema-valid) answer.
const emptySection = { status: "empty", message: null } as const;
const fulfillOptionsSnapshot = async (route: Route) =>
  await route.fulfill({
    contentType: "application/json",
    status: 200,
    body: JSON.stringify({
      json: {
        symbol: "SPY",
        source: "quantdata",
        receivedAt: "2024-06-09T00:00:01Z",
        spot: null,
        rateLimited: false,
        retryAfterSeconds: null,
        notes: [],
        volatility: {
          ...emptySection,
          termStructure: [],
          skew: [],
          surface: { moneyness: [], rows: [] },
        },
        exposure: {
          ...emptySection,
          strikes: [],
          maxPain: null,
          totalGex: null,
          gexExpiry: null,
        },
        flow: {
          ...emptySection,
          hours: 24,
          callPremium: 0,
          putPremium: 0,
          events: [],
          buckets: [],
        },
      },
    }),
  });

const chartCanvases = (page: Page) =>
  page.locator("figure.vx-chart-panel canvas");

test.beforeAll(() => resetDatabase());

test("indicator checkboxes add and remove Vertex chart studies", async ({
  page,
}, testInfo) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.route("**/api/orpc/marketData/bars", fulfillBars);
  await page.route(
    "**/api/orpc/optionsAnalytics/snapshot",
    fulfillOptionsSnapshot
  );
  await page.goto("/charts");

  const indicators = page.locator("[data-vertex-studies]");
  await expect(indicators.getByRole("checkbox")).toHaveCount(9);
  await expect(chartCanvases(page).first()).toBeVisible({ timeout: 20_000 });
  const options = page.locator('[data-options-analytics="SPY"]');
  await expect(options).toBeVisible();
  // The mocked snapshot reached the panel: three empty sections, no error.
  await expect(options.locator('[data-section-status="empty"]')).toHaveCount(3);
  await expect(options.locator("[data-error-code]")).toHaveCount(0);
  const baseline = await chartCanvases(page).count();
  const candlePane = chartCanvases(page).first();
  const before = await candlePane.screenshot();

  // Candle-pane overlays draw on existing canvases (their pixels change);
  // pane studies add panes.
  for (const label of [
    "Bollinger 20, 2",
    "Parabolic SAR",
    "SMMA 20",
    "LWMA 20",
  ])
    await indicators.getByRole("checkbox", { name: label }).check();
  await expect(chartCanvases(page)).toHaveCount(baseline);
  await expect
    .poll(async () => (await candlePane.screenshot()).equals(before))
    .toBe(false);

  for (const label of [
    "ATR 14",
    "MACD 12, 26, 9",
    "Stochastic 14, 3, 3",
    "ADX 14",
    "RVOL at time 20",
  ])
    await indicators.getByRole("checkbox", { name: label }).check();
  await expect
    .poll(async () => await chartCanvases(page).count())
    .toBeGreaterThan(baseline);
  const withPanes = await chartCanvases(page).count();
  expect((withPanes - baseline) % 5).toBe(0);
  // The chart grows per pane study, so the candle pane keeps a usable height.
  const candleBox = await candlePane.boundingBox();
  expect(candleBox?.height ?? 0).toBeGreaterThan(200);

  const screenshot = testInfo.outputPath("charts-indicators-dark.png");
  await page.locator("main").screenshot({ path: screenshot });
  await testInfo.attach("charts-indicators-dark", {
    path: screenshot,
    contentType: "image/png",
  });

  for (const label of [
    "ATR 14",
    "MACD 12, 26, 9",
    "Stochastic 14, 3, 3",
    "ADX 14",
    "RVOL at time 20",
  ])
    await indicators.getByRole("checkbox", { name: label }).uncheck();
  await expect(chartCanvases(page)).toHaveCount(baseline);
  await expect(
    indicators.getByRole("checkbox", { name: "Bollinger 20, 2" })
  ).toBeChecked();
});
