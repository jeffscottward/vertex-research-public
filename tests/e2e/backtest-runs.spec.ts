import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Backtest runs: an operator queues a run over a date range, the page follows it to completion and
// shows the report, trade table and replay. Synthetic, clearly fictional daily bars; research only.

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

test("an operator runs a backtest and replays its trades", async ({ page }) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/backtest-runs");
  await expect(
    page.getByRole("heading", { level: 1, name: "Backtest runs" })
  ).toBeVisible();
  await page.getByLabel("Fast average (bars)", { exact: true }).fill("10");
  await page.getByLabel("Slow average (bars)", { exact: true }).fill("40");
  await page.getByLabel("Initial capital", { exact: true }).fill("25000");
  await page.getByLabel("From", { exact: true }).fill("1970-06-01");
  await page.getByLabel("To", { exact: true }).fill("1973-12-31");
  const submitted = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/submit"
  );
  await page.getByRole("button", { name: "Run backtest" }).click();
  expect((await submitted).ok()).toBe(true);

  const report = page.getByRole("region", { name: "Backtest report" });
  await expect(report.getByText("Total net profit")).toBeVisible({
    timeout: 30_000,
  });
  await expect(report.getByText("Initial deposit")).toBeVisible();
  await expect(report.getByText("25,000.00")).toBeVisible();
  await expect(report.getByText("Maximal drawdown")).toBeVisible();
  const rows = report.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(1);
  const total = await rows.count();

  const replay = page.getByRole("region", { name: "Trade replay" });
  await expect(replay.getByText(`Trade ${total} of ${total}`)).toBeVisible();
  await replay.getByRole("button", { name: "Previous trade" }).click();
  await expect(
    replay.getByText(`Trade ${total - 1} of ${total}`)
  ).toBeVisible();

  const recent = page.getByRole("region", { name: "Recent runs" });
  await expect(recent.getByText(/TEST 1d .* succeeded/u).first()).toBeVisible();
});

test("the page opens the latest succeeded run with no clicks", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  const submits: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/orpc/backtestRuns/submit")
      submits.push(request.url());
  });
  await page.goto("/backtest-runs");
  const report = page.getByRole("region", { name: "Backtest report" });
  await expect(report.getByText("Total net profit")).toBeVisible({
    timeout: 30_000,
  });
  expect(new URL(page.url()).search).toBe("");

  // An unknown ?run= falls back to the latest succeeded run.
  await page.goto("/backtest-runs?run=missing-run");
  await expect(report.getByText("Total net profit")).toBeVisible({
    timeout: 30_000,
  });
  expect(submits).toHaveLength(0);
});
