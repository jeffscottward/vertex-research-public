import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Setup replay: the page replays the default Core 7 series and setup on open, with no clicks,
// and a ?symbol=&setup= link opens that choice. Synthetic, clearly fictional daily bars.

const DAY_MS = 86_400_000;

const syntheticBars = (size: number, phase: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.05 + 10 * Math.sin((index + phase) / 15);
    return {
      c: close,
      h: close + 1,
      l: close - 1,
      o: close - 0.3,
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
    const repository = createMarketBarsRepository(resource.db);
    for (const [index, symbol] of ["ES=F", "NQ=F"].entries()) {
      await repository.replaceSeries(
        {
          source: "Synthetic E2E bars (fictional)",
          sourceSha256: String(index).repeat(64),
          symbol,
          timeframe: "1d",
        },
        syntheticBars(1500, index * 7)
      );
    }
  } finally {
    await resource.close();
  }
});

test("opens with a replay of the default series and setup, no clicks", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/setup-replay");
  await expect(
    page.getByRole("heading", { level: 1, name: "Setup replay" })
  ).toBeVisible();
  const results = page.locator('[data-setup-replay="results"]');
  await expect(results).toBeVisible();
  await expect(results).toContainText("on ES=F daily");
  await expect(page.locator('[data-stat="Occurrences"] dd')).toBeVisible();
  expect(new URL(page.url()).search).toBe("");

  await page
    .getByLabel("Target", { exact: true })
    .selectOption({ label: "3R" });
  await expect(page).toHaveURL(/[?&]target=3(?:&|$)/u);
  await expect(results).toContainText("target 3R");
});

test("a ?symbol=&setup= link opens that replay", async ({ page }) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/setup-replay");
  await expect(page.locator('[data-setup-replay="results"]')).toBeVisible();
  const setup = page.getByLabel("Setup", { exact: true });
  // The first setup is the default and stays out of the URL, so pick the second one.
  await expect(setup.locator("option")).not.toHaveCount(1);
  const chosenLabel =
    (await setup.locator("option").nth(1).textContent()) ?? "";
  await setup.selectOption({ index: 1 });
  await expect(page).toHaveURL(/[?&]setup=[^&]+/u);
  const setupId = new URL(page.url()).searchParams.get("setup") ?? "";
  expect(setupId).not.toBe("");

  await page.goto(`/setup-replay?symbol=NQ%3DF&setup=${setupId}`);
  const results = page.locator('[data-setup-replay="results"]');
  await expect(results).toContainText(`${chosenLabel} on NQ=F daily`);
  await expect(page.getByLabel("Daily series", { exact: true })).toHaveValue(
    "1"
  );
});
