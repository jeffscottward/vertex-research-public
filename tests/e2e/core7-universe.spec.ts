import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Core 7 default universe (owner decision 2026-11-03): every backtest, sweep and Autopilot form
// opens with "Core 7 futures" selected and its first stored member preselected. Synthetic, clearly
// fictional daily bars stored under real symbols; research only.

const DAY_MS = 86_400_000;

const syntheticBars = (size: number, base: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = base + index * 0.05 + 10 * Math.sin(index / 20);
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
    const repository = createMarketBarsRepository(resource.db);
    for (const [index, symbol] of ["SPY", "NQ=F", "ES=F", "TEST"].entries()) {
      await repository.replaceSeries(
        {
          symbol,
          timeframe: "1d",
          source: "Synthetic E2E bars (fictional)",
          sourceSha256: String(index).repeat(64),
        },
        syntheticBars(900, 100 + index * 50)
      );
    }
  } finally {
    await resource.close();
  }
});

for (const { path, heading, seriesLabel } of [
  {
    path: "/instant-backtest",
    heading: "Instant backtest",
    seriesLabel: "Bars",
  },
  {
    path: "/backtest-runs",
    heading: "Backtest runs",
    seriesLabel: "Symbol and timeframe",
  },
  {
    path: "/backtest-sweeps",
    heading: "Parameter sweeps",
    seriesLabel: "Symbol and timeframe",
  },
  { path: "/autopilot", heading: "Autopilot", seriesLabel: "Bar series" },
] as const) {
  test(`${path} opens with Core 7 futures and ES=F preselected`, async ({
    page,
  }) => {
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: heading })
    ).toBeVisible();
    const universe = page.getByLabel("Universe", { exact: true });
    await expect(universe).toHaveValue("core7-futures");
    const series = page.getByLabel(seriesLabel, { exact: true });
    await expect(series).toHaveValue("ES=F:1d");
    // Members in market order only: ES=F, then NQ=F; SPY and TEST are not Core 7 futures.
    await expect(series.locator("option")).toHaveCount(2);
    await universe.selectOption("core7-etf-twins");
    await expect(series).toHaveValue("SPY:1d");
  });
}

// Pages without a universe choice still open on the first stored Core 7 futures series.
test("/strategy-builder opens on ES=F", async ({ page }) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/strategy-builder");
  await expect(
    page.getByLabel("Symbol and timeframe", { exact: true })
  ).toHaveValue("ES=F:1d");
});

test("/setup-replay opens on ES=F and replays it without input", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/setup-replay");
  await expect(
    page.getByLabel("Daily series", { exact: true }).locator("option:checked")
  ).toHaveText(/^ES=F daily/u);
  await expect(page.locator('[data-setup-replay="results"]')).toBeVisible();
});
