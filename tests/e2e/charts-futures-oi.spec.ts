import type { Page, Route } from "@playwright/test";

import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// /charts open-interest change pane for ES and NQ. Neither the IBKR history service nor stored
// CME figures exist in a browser run, so the bars RPC and the macro series RPC are answered
// with clearly fictional data. Display only: no order path exists on this page.

const DAY_SECONDS = 86_400;
const LAST_DAY_SECONDS = Date.UTC(2026, 10, 20) / 1000;
const SUB_PANE_PX = 96;
const SUB_PANE_TOLERANCE_PX = 2;
const HINT =
  "Open interest is a daily figure. Choose the 1D interval to see it.";
const NEWEST =
  "Open interest, ES futures, all contract months (CME, preliminary): 2,127,055 contracts on 2026-11-19, +11,802 against 2026-11-18.";

const isoDate = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

// 40 weekdays that end on Friday 2026-11-20, oldest first (00:00 UTC, like IBKR daily bars).
const tradingDays = (): number[] => {
  const days: number[] = [];
  for (let time = LAST_DAY_SECONDS; days.length < 40; time -= DAY_SECONDS) {
    const weekday = new Date(time * 1000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.unshift(time);
  }
  return days;
};

const syntheticBar = (t: number, index: number) => {
  const close = 6800 + 40 * Math.sin(index / 5) + index;
  return {
    c: close,
    h: close + 12,
    l: close - 14,
    o: close - 3,
    t,
    v: 1000 + ((index * 37) % 400),
  };
};

const barsResponse = (barSize: "1 day" | "5 mins") => {
  const bars =
    barSize === "1 day"
      ? tradingDays().map(syntheticBar)
      : Array.from({ length: 120 }, (_, index) =>
          syntheticBar(LAST_DAY_SECONDS + 14 * 3600 + index * 300, index)
        );
  const last = bars.at(-1);
  return {
    asOf: last === undefined ? null : new Date(last.t * 1000).toISOString(),
    bars,
    cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 60 },
    contract: {
      conId: 1,
      currency: "USD",
      exchange: "CME",
      lastTradeDateOrContractMonth: null,
      localSymbol: "ES",
      longName: "Synthetic E2E future (fictional)",
      matches: 1,
      multiplier: "50",
      secType: "CONTFUT",
      timeZoneId: "UTC",
    },
    count: bars.length,
    fetchedAt: "2026-11-21T00:00:00Z",
    receivedAt: "2026-11-21T00:00:01Z",
    request: {
      barSize,
      contractMonth: null,
      currency: "USD",
      duration: barSize === "1 day" ? "1 Y" : "5 D",
      exchange: "CME",
      secType: "CONTFUT",
      symbol: "ES",
      useRTH: true,
      whatToShow: "TRADES",
    },
    source: "ibkr-gateway",
  };
};

// Every bars request is answered as the ES continuous future, so the first load of the page
// (the SPY default of the form) already shows the futures view. The bar size follows the request.
const fulfillBars = async (route: Route) => {
  const request = route.request();
  const sent = `${decodeURIComponent(request.url())} ${request.postData() ?? ""}`;
  return await route.fulfill({
    body: JSON.stringify({
      json: barsResponse(/5[ +]mins/.test(sent) ? "5 mins" : "1 day"),
    }),
    contentType: "application/json",
    status: 200,
  });
};

// Fictional figures for every daily bar except the newest (2026-11-20 has no figure yet).
const macroResponse = () => {
  const dates = tradingDays().slice(0, -1).map(isoDate);
  const points = dates.map((date, index) => ({
    date,
    value: 2_000_000 + ((index * 7919) % 30_000),
  }));
  const fixed = [
    { date: "2026-11-18", value: 2_115_253 },
    { date: "2026-11-19", value: 2_127_055 },
  ];
  return {
    from: dates[0],
    series: [
      {
        firstDate: dates[0],
        frequency: "daily",
        id: "CME_ES_OI",
        lastDate: "2026-11-19",
        name: "ES open interest (fictional E2E figures)",
        pointCount: points.length,
        points: [...points.slice(0, -fixed.length), ...fixed],
        source: "CME",
        unit: "contracts",
        updatedAt: "2026-11-20T10:02:00.000Z",
      },
    ],
  };
};

let macroReads = 0;
const fulfillMacro = async (route: Route) => {
  macroReads += 1;
  return await route.fulfill({
    // The meta entry marks `updatedAt` as a Date for the oRPC client.
    body: JSON.stringify({
      json: macroResponse(),
      meta: [[1, "series", 0, "updatedAt"]],
    }),
    contentType: "application/json",
    status: 200,
  });
};

const chartBox = (page: Page) => page.locator("[data-chart-canvas]").first();
const chartHeight = async (page: Page): Promise<number> =>
  (await chartBox(page).boundingBox())?.height ?? 0;
const hasNoHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth
  );

test.beforeAll(() => resetDatabase());

for (const view of [
  { colorScheme: "dark", height: 1100, width: 1440 },
  { colorScheme: "light", height: 812, width: 375 },
] as const)
  test(`OI change pane under the ES daily chart at ${view.width} px ${view.colorScheme}`, async ({
    page,
  }, testInfo) => {
    macroReads = 0;
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.setViewportSize({ height: view.height, width: view.width });
    await page.route("**/api/orpc/marketData/bars", fulfillBars);
    await page.route(/\/api\/orpc\/openbb\/macro(\?|$)/, fulfillMacro);
    await page.goto("/charts");

    // The quick pick makes the form agree with the stubbed ES continuous future.
    await page.getByLabel("Quick pick").selectOption("ES (E-mini S&P)");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(
      page.locator("[data-chart-canvas] canvas").first()
    ).toBeVisible({ timeout: 20_000 });

    const panel = page.locator('[data-futures-oi="ES"]');
    const checkbox = page.getByRole("checkbox", { name: "Open interest" });
    await expect(panel.getByText(NEWEST)).toBeVisible();
    await expect(
      panel.getByText("Figures last written 2026-11-20 10:02 UTC.")
    ).toBeVisible();
    await expect(
      panel.getByText(
        "1 loaded trading day after 2026-11-19 has no CME figure yet."
      )
    ).toBeVisible();
    await expect(
      panel.getByText("Open interest by trading day (last 10 stored days)")
    ).toBeVisible();
    await expect(panel.locator("tbody tr")).toHaveCount(10);
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeEnabled();
    expect(await hasNoHorizontalOverflow(page)).toBe(true);

    const screenshot = testInfo.outputPath(
      `charts-futures-oi-${view.width}-${view.colorScheme}.png`
    );
    await page.locator("main").screenshot({ path: screenshot });
    await testInfo.attach(`charts-futures-oi-${view.width}`, {
      contentType: "image/png",
      path: screenshot,
    });

    // Without the pane the chart box is one sub-pane (6rem = 96 px) lower; the series is not
    // read again.
    const withPane = await chartHeight(page);
    await checkbox.uncheck();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () =>
        Math.abs(withPane - (await chartHeight(page)) - SUB_PANE_PX)
      )
      .toBeLessThanOrEqual(SUB_PANE_TOLERANCE_PX);
    await checkbox.check();
    await expect(panel.getByText(NEWEST)).toBeVisible();
    await expect.poll(async () => await chartHeight(page)).toBe(withPane);
    const dailyReads = macroReads;
    expect(dailyReads).toBeGreaterThan(0);

    // 5-minute bars: the control stays, disabled, with its hint; nothing is read.
    await page
      .locator("[data-chart-toolbar]")
      .getByRole("button", { name: "5m", exact: true })
      .click();
    await expect(checkbox).toBeDisabled();
    // The hint id is generated; the checkbox names its hint as its accessible description.
    await expect(checkbox).toHaveAccessibleDescription(HINT);
    await expect(
      page.locator("[data-chart-toolbar]").getByText(HINT, { exact: true })
    ).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(macroReads).toBe(dailyReads);
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  });
