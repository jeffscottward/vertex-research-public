import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Portfolio combos: an operator runs two backtests; the combos page opens with them already
// combined on one deposit (no clicks), re-combines on a change and keeps the choice in the URL
// (`?runs=`). Synthetic, clearly fictional daily bars; research only.

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

test("an operator combines two backtest runs on one deposit", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/backtest-runs");
  await page.waitForLoadState("networkidle");
  const succeeded = page
    .getByRole("region", { name: "Recent runs" })
    .getByText(/TEST 1d .* succeeded/u);
  for (const fast of ["10", "5"]) {
    const before = await succeeded.count();
    await page.getByLabel("Fast average (bars)", { exact: true }).fill(fast);
    await page.getByLabel("Slow average (bars)", { exact: true }).fill("40");
    await page.getByLabel("From", { exact: true }).fill("1970-06-01");
    await page.getByLabel("To", { exact: true }).fill("1973-12-31");
    const submitted = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/submit"
    );
    await page.getByRole("button", { name: "Run backtest" }).click();
    expect((await submitted).ok()).toBe(true);
    await expect(succeeded).toHaveCount(before + 1, { timeout: 30_000 });
  }

  // Opening the page must never queue a new backtest.
  const submits: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/backtestRuns/submit"))
      submits.push(request.url());
  });
  await page.goto("/portfolio-combos");
  await expect(
    page.getByRole("heading", { level: 1, name: "Portfolio combos" })
  ).toBeVisible();
  const boxes = page.getByRole("checkbox");
  // Newest first: the two runs made above are the first two rows, both picked by default
  // with an equal share each, and combined without pressing a button.
  await expect(boxes.nth(1)).toBeVisible({ timeout: 30_000 });
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  const weights = page.getByLabel(/^Weight for /u);
  await expect(weights.nth(0)).toHaveValue("0.5");
  await expect(weights.nth(1)).toHaveValue("0.5");
  const report = page.getByRole("region", { name: "Combined portfolio" });
  await expect(report.getByText("Final equity")).toBeVisible({
    timeout: 30_000,
  });
  await expect(report.getByText("100,000.00").first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get("runs")).toBeNull();

  // A new deposit re-combines on its own after a short pause.
  await page.getByLabel("Shared deposit", { exact: true }).fill("200000");
  await expect(report.getByText("200,000.00")).toBeVisible();
  await expect(
    report.getByRole("img", { name: "Combined equity curve" })
  ).toBeVisible();
  await expect(report.locator("tbody tr")).toHaveCount(4);
  await expect(
    report.getByText(/robust|degrading|insufficient/u).first()
  ).toBeVisible();
  expect(submits).toEqual([]);

  // Dropping a run writes the choice to the URL; the link restores it.
  await boxes.nth(1).uncheck();
  await expect(page).toHaveURL(/[?&]runs=[^&]+/u);
  const link = page.url();
  await page.goto(link);
  await expect(page.getByRole("checkbox").nth(1)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("checkbox").nth(0)).toBeChecked();
  await expect(page.getByRole("checkbox").nth(1)).not.toBeChecked();
  await expect(page.getByLabel(/^Weight for /u)).toHaveValue("1");
  await expect(
    page
      .getByRole("region", { name: "Combined portfolio" })
      .getByText("Final equity")
  ).toBeVisible({ timeout: 30_000 });
  expect(submits).toEqual([]);

  await page.goto("/portfolio-combos");
  await expect(
    page.getByRole("region", { name: "Combined portfolio" })
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    fullPage: true,
    path: "test-results/portfolio-combos-dark.png",
  });
});
