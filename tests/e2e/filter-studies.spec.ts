import {
  createAgentOpsRepository,
  createBacktestResultsRepository,
  createNodeDatabase,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Filter studies on /backtests: the committed ADX and RVOL study summary (research only; no
// order path). Checked at phone (375 px) and desktop widths; the tables scroll inside their box.
// One recorded backtest makes the wide results table render above the studies, so the page
// width check also covers that table (its sr-only header labels once widened the page).

test.beforeAll(async () => {
  await resetDatabase();
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    const task = await createAgentOpsRepository(resource.db).createTask({
      agent: "e2e",
      kind: "backtest",
      title: "Filter studies width fixture (fictional)",
    });
    await createBacktestResultsRepository(resource.db).record({
      dataSource: "Synthetic E2E series (fictional)",
      equity: [
        { equity: 100_000, t: "2021-01-04" },
        { equity: 101_000, t: "2021-11-19" },
      ],
      instruments: "AAA,BBB",
      metrics: {},
      periodEnd: "2021-11-19",
      periodStart: "2021-01-04",
      strategy: "Fictional width fixture strategy",
      taskId: task.id,
    });
  } finally {
    await resource.close();
  }
});

for (const viewport of [
  { height: 812, width: 375 },
  { height: 900, width: 1440 },
]) {
  test(`the Backtests page shows the filter studies at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/backtests");
    const results = page.getByRole("table", { name: "Backtest results" });
    await expect(
      results
        .getByRole("row", { name: /Fictional width fixture strategy/u })
        .first()
    ).toBeVisible();
    const section = page.getByRole("region", { name: "Filter studies" });
    await expect(section).toBeVisible();
    const daily = section.getByRole("table").first();
    await expect(daily.locator("tbody tr")).toHaveCount(13);
    await expect(
      daily.getByRole("row", { name: /20-day breakout ADX\(14\) > 20/u })
    ).toContainText("DROP");
    await expect(
      section.getByRole("table").nth(1).locator("tbody tr")
    ).toHaveCount(2);
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(width).toBeLessThanOrEqual(viewport.width);
    for (const [name, target] of [
      ["page", page],
      ["section", section],
    ] as const) {
      const screenshot = testInfo.outputPath(
        `filter-studies-${name}-${viewport.width}.png`
      );
      await target.screenshot({ path: screenshot });
      await testInfo.attach(`filter-studies-${name}-${viewport.width}`, {
        contentType: "image/png",
        path: screenshot,
      });
    }
  });
}
