import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Parameter sweep: the page opens with the default grid already run on the first stored series
// (no click). An operator then runs a custom grid, reads the heatmap for another metric, picks a
// cell and queues a full backtest run for it, which reports the same total return. A URL deep
// link opens a chosen rule and metric. Synthetic, clearly fictional daily bars; research only.

const DAY_MS = 86_400_000;

const syntheticBars = (size: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.05 + 10 * Math.sin(index / 20);
    return {
      c: close,
      h: close + 1,
      l: close - 1,
      o: close,
      t: index * DAY_MS,
      v: null,
    };
  });

const percentOf = (text: string): number =>
  Number(/(-?\d+(?:\.\d+)?)%/u.exec(text)?.[1]);

test.beforeAll(async () => {
  await resetDatabase();
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    await createMarketBarsRepository(resource.db).replaceSeries(
      {
        source: "Synthetic E2E bars (fictional)",
        sourceSha256: "f".repeat(64),
        symbol: "TEST",
        timeframe: "1d",
      },
      syntheticBars(1500)
    );
  } finally {
    await resource.close();
  }
});

test("an operator sweeps two parameters and runs the full backtest for one cell", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signInAs(page, E2E_IDENTITIES.alice);
  const submits: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/orpc/backtestRuns/submit")
      submits.push(request.url());
  });
  const opened = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/sweep"
  );
  await page.goto("/backtest-sweeps");
  await expect(
    page.getByRole("heading", { level: 1, name: "Parameter sweeps" })
  ).toBeVisible();
  // The default 6 x 8 grid runs on open; no Core 7 future is stored, so TEST is used.
  expect((await opened).ok()).toBe(true);
  const results = page.getByRole("region", { name: "Sweep results" });
  await expect(results.getByText(/^48 cells over/u)).toBeVisible();
  await expect(
    results.locator("[data-sweep-heatmap] tbody button")
  ).toHaveCount(48);
  await expect(page.getByLabel("Symbol and timeframe")).toHaveValue("TEST:1d");
  await expect(page).toHaveURL(/\/backtest-sweeps$/u);
  expect(submits).toHaveLength(0);

  await page.getByLabel("Dimension 1 from", { exact: true }).fill("5");
  await page.getByLabel("Dimension 1 to", { exact: true }).fill("30");
  await page.getByLabel("Dimension 1 step", { exact: true }).fill("5");
  await page.getByLabel("Dimension 2 from", { exact: true }).fill("40");
  await page.getByLabel("Dimension 2 to", { exact: true }).fill("120");
  await page.getByLabel("Dimension 2 step", { exact: true }).fill("20");
  await page.getByLabel("From", { exact: true }).fill("1970-06-01");
  await page.getByLabel("To", { exact: true }).fill("1973-12-31");
  const swept = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/sweep"
  );
  await page.getByRole("button", { name: "Run sweep" }).click();
  expect((await swept).ok()).toBe(true);

  await expect(results.getByText(/^30 cells over/u)).toBeVisible();
  const heatmap = results.locator("[data-sweep-heatmap]");
  await expect(heatmap.locator("tbody button")).toHaveCount(30);
  const robust = page.getByRole("region", { name: "Most robust cells" });
  await expect(robust.locator("tbody tr")).toHaveCount(20);

  await results.getByLabel("Metric", { exact: true }).selectOption("sharpe");
  await expect(results.getByText(/for sharpe ratio\./u)).toBeVisible();
  await expect(page).toHaveURL(/\?metric=sharpe$/u);
  await results
    .getByLabel("Metric", { exact: true })
    .selectOption("totalReturn");
  await results.getByLabel("Colour by", { exact: true }).selectOption("worst");
  await expect(
    results.getByText(/\(worst in neighbourhood\) by/u)
  ).toBeVisible();
  await testInfo.attach("parameter-sweep-heatmap-dark", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  // At phone width the heatmap scrolls inside its own box; the page does not.
  await page.setViewportSize({ height: 800, width: 375 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await testInfo.attach("parameter-sweep-heatmap-dark-375", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.setViewportSize({ height: 720, width: 1280 });

  const cell = heatmap.getByRole("button", { name: /^fast 10, slow 80:/u });
  await cell.click();
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  const selected = page.getByRole("region", { name: "Selected cell" });
  await expect(selected.getByText("Cell: fast 10, slow 80")).toBeVisible();
  const sweepReturn = percentOf(
    (await selected
      .getByText("Total return", { exact: true })
      .locator("xpath=following-sibling::dd")
      .textContent()) ?? ""
  );

  const submitted = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/submit"
  );
  await selected.getByRole("button", { name: "Run full backtest" }).click();
  expect((await submitted).ok()).toBe(true);
  await selected
    .getByRole("link", { name: "Open the backtest report" })
    .click();
  await expect(page).toHaveURL(/\/backtest-runs\?run=/u);
  const report = page.getByRole("region", { name: "Backtest report" });
  await expect(report.getByText("Total net profit")).toBeVisible({
    timeout: 30_000,
  });
  await expect(report.getByRole("heading", { level: 2 })).toContainText(
    "SMA cross 10/80"
  );
  const fullReturn = percentOf(
    (await report
      .getByText("Total return", { exact: true })
      .locator("xpath=following-sibling::dd")
      .textContent()) ?? ""
  );
  // The sweep shows one decimal, the report two; both come from the same engine run.
  expect(Math.abs(fullReturn - sweepReturn)).toBeLessThanOrEqual(0.05);
});

test("a URL deep link opens the chosen rule and metric with the sweep already run", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto(
    "/backtest-sweeps?rule=breakout&metric=sharpe&universe=bogus"
  );
  await expect(page.getByLabel("Rule", { exact: true })).toHaveValue(
    "breakout"
  );
  await expect(page.getByLabel("Universe", { exact: true })).toHaveValue(
    "core7-futures"
  );
  const results = page.getByRole("region", { name: "Sweep results" });
  // Breakout default grid: 6 x 6 cells, ranked by Sharpe.
  await expect(results.getByText(/^36 cells over/u)).toBeVisible();
  await expect(results.getByLabel("Metric", { exact: true })).toHaveValue(
    "sharpe"
  );
  await expect(results.getByText(/for sharpe ratio\./u)).toBeVisible();
  // The unknown universe leaves the URL; the default metric does too.
  await expect(page).toHaveURL(/\?rule=breakout&metric=sharpe$/u);
  await results
    .getByLabel("Metric", { exact: true })
    .selectOption("totalReturn");
  await expect(page).toHaveURL(/\?rule=breakout$/u);
});
