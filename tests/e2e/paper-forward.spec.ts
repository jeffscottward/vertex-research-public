import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Paper forward runner: an operator pins a backtest run as a drift baseline, starts the paper
// runner, runs one tick over the stored bars after the backtest end date and stops it again.
// Synthetic, clearly fictional bars; paper only (simulated fills), no broker or order path.

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

test("an operator starts the paper runner, records one tick and stops it", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/backtest-runs");
  await page.waitForLoadState("networkidle");
  const succeeded = page
    .getByRole("region", { name: "Recent runs" })
    .getByText(/TEST 1d .* succeeded/u);
  const before = await succeeded.count();
  await page.getByLabel("Fast average (bars)", { exact: true }).fill("10");
  await page.getByLabel("Slow average (bars)", { exact: true }).fill("40");
  await page.getByLabel("From", { exact: true }).fill("1970-06-01");
  // The stored bars end in February 1974, so about 500 bars follow the backtest end date.
  await page.getByLabel("To", { exact: true }).fill("1972-09-30");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(succeeded).toHaveCount(before + 1, { timeout: 30_000 });

  await page.goto("/forward-drift");
  await page.getByLabel("Monitor name", { exact: true }).fill("TEST runner");
  await page.getByRole("button", { name: "Create monitor" }).click();
  const runner = page.getByRole("region", { name: "Paper forward runner" });
  await expect(runner.getByText("Stopped")).toBeVisible();
  await expect(runner.getByText("Last tick: never")).toBeVisible();

  await runner.getByRole("button", { name: "Start paper runner" }).click();
  await expect(runner.getByText("Running", { exact: true })).toBeVisible();

  const ticked = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname ===
      "/api/orpc/backtestRuns/drift/paperTick"
  );
  await runner.getByRole("button", { name: "Run one tick now" }).click();
  expect((await ticked).ok()).toBe(true);
  const status = runner.getByRole("status");
  await expect(status).toHaveText(/^Tick: \d+ points, \d+ trades/u);
  const points = Number(
    /^Tick: (\d+)/u.exec((await status.textContent()) ?? "")?.[1]
  );
  expect(points).toBeGreaterThan(100);
  const panel = page.getByRole("region", { name: "Drift panel" });
  await expect(panel.getByText(`Paper: ${points} points`)).toBeVisible();

  // A second tick finds no new settled bars and records nothing.
  await runner.getByRole("button", { name: "Run one tick now" }).click();
  await expect(status).toHaveText(
    "Tick: 0 points, 0 trades, 0 new alerts. No new settled bars after the forward start"
  );
  await page.screenshot({
    fullPage: true,
    path: "test-results/paper-forward-dark.png",
  });

  await runner.getByRole("button", { name: "Stop paper runner" }).click();
  await expect(runner.getByText("Stopped")).toBeVisible();
});
