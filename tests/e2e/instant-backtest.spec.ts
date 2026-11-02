import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Instant backtest: an operator changes a rule parameter and the result updates in place.
// Synthetic, clearly fictional daily bars; research only, no order path.

const DAY_MS = 86_400_000;
const RELOAD_MARKER = "instantBacktestReloadMarker";

const syntheticBars = (size: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.05 + 10 * Math.sin(index / 40);
    return {
      t: index * DAY_MS,
      o: close,
      h: close + 1,
      l: close - 1,
      c: close,
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
        symbol: "TEST",
        timeframe: "1d",
        source: "Synthetic E2E bars (fictional)",
        sourceSha256: "f".repeat(64),
      },
      syntheticBars(1500)
    );
  } finally {
    await resource.close();
  }
});

test("a parameter change re-runs the backtest without a page reload", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/instant-backtest");
  await expect(
    page.getByRole("heading", { level: 1, name: "Instant backtest" })
  ).toBeVisible();
  const status = page.locator("[data-instant-status]");
  const totalReturn = page.locator('[data-stat="Total return"] dd');
  const trades = page.locator('[data-stat="Trades"] dd');
  await expect(status).toHaveAttribute("data-instant-status", "ready");
  await expect(status).toHaveText(/^Updated in \d+ ms/u);
  await expect(page.getByText("Synthetic E2E bars (fictional)")).toBeVisible();
  const before = `${await totalReturn.textContent()} ${await trades.textContent()}`;
  await page.evaluate((key) => Reflect.set(window, key, true), RELOAD_MARKER);

  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/instantBacktest/run"
  );
  await page.getByLabel("Fast average (bars)", { exact: true }).fill("10");
  expect((await response).ok()).toBe(true);
  await expect(status).toHaveAttribute("data-instant-status", "ready");
  await expect
    .poll(
      async () =>
        `${await totalReturn.textContent()} ${await trades.textContent()}`
    )
    .not.toBe(before);
  expect(
    await page.evaluate((key) => Reflect.get(window, key), RELOAD_MARKER)
  ).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/instant-backtest");

  await page.getByLabel("Fast average (bars)", { exact: true }).fill("300");
  await expect(page.getByRole("alert")).toHaveText(
    "The fast average must be shorter than the slow average."
  );
});
