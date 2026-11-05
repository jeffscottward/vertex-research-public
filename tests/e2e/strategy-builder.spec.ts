import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";
import type { Locator } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Strategy builder: an operator edits a definition visually, the JSON text follows, and the
// definition runs as a backtest. The builder-made SMA 10/40 cross must report the same result as
// the golden smaCross rule over the same bars. Synthetic, clearly fictional bars; research only.

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

const metric = (scope: Locator, label: string) =>
  scope
    .locator("dt")
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::dd");

test("an operator builds a strategy visually and backtests it", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  // Opening the page never queues a run.
  const submits: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/orpc/backtestRuns/submit")
      submits.push(request.url());
  });
  await page.goto("/strategy-builder");
  await expect(
    page.getByRole("heading", { level: 1, name: "Strategy builder" })
  ).toBeVisible();
  const text = page.getByLabel("Definition text", { exact: true });

  // Default state: the SMA cross template, the first stored series and a plain notice.
  await expect(page.getByText("The definition is valid.")).toBeVisible();
  await expect(page.getByText(/No builder run exists yet\./u)).toBeVisible();
  await expect(
    page.getByLabel("Symbol and timeframe", { exact: true })
  ).toHaveValue("TEST:1d");
  expect(submits).toHaveLength(0);

  // Text edits are validated at once.
  await text.fill("{ broken");
  await expect(page.getByText("(root): Not valid JSON")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run backtest" })
  ).toBeDisabled();

  // Loading a template from the visual builder rewrites the text.
  await page.getByLabel("Template", { exact: true }).selectOption("smaCross");
  await expect(page.getByText("The definition is valid.")).toBeVisible();

  // Build an SMA 10/40 cross with the visual controls.
  await page.getByLabel("Strategy name", { exact: true }).fill("Builder cross");
  for (const prefix of ["Entry 1", "Exit 1"]) {
    await page
      .getByLabel(`${prefix} left length (bars)`, { exact: true })
      .fill("10");
    await page
      .getByLabel(`${prefix} right length (bars)`, { exact: true })
      .fill("40");
  }
  const definition = JSON.parse(await text.inputValue()) as {
    name: string;
    entry: { all: { left: { length: number }; right: { length: number } }[] };
  };
  expect(definition.name).toBe("Builder cross");
  expect(definition.entry.all[0]?.left.length).toBe(10);
  expect(definition.entry.all[0]?.right.length).toBe(40);

  await page.getByLabel("From", { exact: true }).fill("1970-06-01");
  await page.getByLabel("To", { exact: true }).fill("1973-12-31");
  const submitted = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/backtestRuns/submit"
  );
  await page.getByRole("button", { name: "Run backtest" }).click();
  expect((await submitted).ok()).toBe(true);

  const result = page.getByRole("region", { name: "Backtest result" });
  await expect(result.getByText("The backtest finished.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    result.getByText(/Strategy Builder cross revision/u)
  ).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath("strategy-builder-dark.png"),
  });
  await expect(page).toHaveURL(/[?&]run=/u);
  const runUrl = page.url();

  // Reopening the page shows the latest builder run without a new submit.
  await page.goto("/strategy-builder");
  await expect(
    page
      .getByRole("region", { name: "Backtest result" })
      .getByText("The backtest finished.")
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Strategy name", { exact: true })).toHaveValue(
    "Builder cross"
  );
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "1970-06-01"
  );
  // The run deep link opens the same run.
  await page.goto(runUrl);
  await expect(
    page.getByRole("region", { name: "Backtest result" })
  ).toBeVisible({ timeout: 30_000 });
  expect(submits).toHaveLength(1);

  const netProfit = await metric(result, "Total net profit").textContent();
  const totalTrades = await metric(result, "Total trades").textContent();
  expect(Number(totalTrades)).toBeGreaterThan(1);

  // Compile parity: the golden smaCross 10/40 rule over the same bars reports the same result.
  await page.goto("/backtest-runs");
  await page.getByLabel("Fast average (bars)", { exact: true }).fill("10");
  await page.getByLabel("Slow average (bars)", { exact: true }).fill("40");
  await page.getByLabel("Cost per side (bps)", { exact: true }).fill("0");
  await page.getByLabel("From", { exact: true }).fill("1970-06-01");
  await page.getByLabel("To", { exact: true }).fill("1973-12-31");
  await page.getByRole("button", { name: "Run backtest" }).click();
  const report = page.getByRole("region", { name: "Backtest report" });
  await expect(metric(report, "Total net profit")).toHaveText(netProfit ?? "", {
    timeout: 30_000,
  });
  await expect(metric(report, "Total trades")).toHaveText(totalTrades ?? "");
});
