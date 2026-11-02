import {
  createAgentOpsRepository,
  createBacktestResultsRepository,
  createNodeDatabase,
  createStrategyLibraryRepository,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Backtest quant methods: significance, multiple testing over the strategy's trial ledger,
// volatility clustering and the pairs research lens, shown in the backtest detail view.
// Synthetic, clearly fictional series; research only.

const DAY_MS = 86_400_000;
const START = Date.UTC(2021, 0, 4);

const equitySeries = (size: number, drift: number, wave: number) =>
  Array.from({ length: size }, (_, index) => ({
    t: new Date(START + index * DAY_MS).toISOString().slice(0, 10),
    equity:
      100_000 *
      (1 + drift) ** index *
      (1 + wave * Math.sin(index * 1.3) * (1 + 0.5 * Math.sin(index / 25))),
  }));

let pairsBacktestId = "";

test.beforeAll(async () => {
  await resetDatabase();
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    const task = await createAgentOpsRepository(resource.db).createTask({
      kind: "backtest",
      agent: "e2e",
      title: "Quant methods fixture (fictional)",
    });
    const strategy = await createStrategyLibraryRepository(resource.db).create({
      name: "Fictional pair",
      kind: "python",
    });
    const backtests = createBacktestResultsRepository(resource.db);
    const record = (drift: number, metrics: Record<string, number | string>) =>
      backtests.record({
        taskId: task.id,
        strategyId: strategy.id,
        strategy: "Pairs z-score spread AAA/BBB",
        instruments: "AAA,BBB",
        periodStart: "2021-01-04",
        periodEnd: "2021-11-19",
        dataSource: "Synthetic E2E series (fictional)",
        metrics,
        equity: equitySeries(320, drift, 0.004),
      });
    await record(0.0001, {});
    await record(-0.0002, {});
    pairsBacktestId = (
      await record(0.0008, {
        "pair.legs": "AAA/BBB",
        "pair.hedge_ratio": 1.5,
        "pair.adf_t": -6.33,
        "pair.adf_p": 0.000_000_3,
        "pair.crit_5pct": -3.36,
        "pair.half_life_bars": 2.56,
        "pair.entry_z": 2,
        "pair.exit_z": 0.5,
        "pair.stop_z": 4,
        "pair.cost_bps": 5,
        "pair.formation_bars": 200,
        "pair.lookback": 60,
        "pair.round_trips": 9,
      })
    ).id;
  } finally {
    await resource.close();
  }
});

test("an operator reads significance, multiple testing, volatility and the pairs lens", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/backtests?id=${pairsBacktestId}&tab=validation`);
  const detail = page.locator(`[data-backtest-detail="${pairsBacktestId}"]`);
  await expect(detail).toBeVisible({ timeout: 30_000 });

  const significance = detail.locator("[data-significance]");
  await expect(
    significance.locator('[data-test-row="t-test, mean return per period"]')
  ).toBeVisible();
  await expect(
    significance.locator(
      '[data-test-row="Stationary bootstrap, Sharpe (ann.)"]'
    )
  ).toBeVisible();

  const multiple = detail.locator('[data-multiple-testing="strategy"]');
  await expect(multiple.locator('[data-stat="Trials"] dd')).toHaveText("3");
  await expect(multiple.locator('[data-stat="Deflated Sharpe"] dd')).toHaveText(
    /%$/u
  );
  await expect(
    multiple.locator('[data-stat="Discoveries (5% FDR)"] dd')
  ).toHaveText(/of 3$/u);

  const pairs = detail.locator("[data-pairs-lens]");
  await expect(
    pairs.getByRole("heading", { name: /^Pairs lens: AAA\/BBB/u })
  ).toBeVisible();
  await expect(
    pairs.locator("p", { hasText: "Cointegrated at the 5% level" })
  ).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath("backtest-validation-dark.png"),
  });

  await page.getByRole("tab", { name: "Risk" }).click();
  const volatility = detail.locator("[data-volatility]");
  await expect(volatility.locator('[data-stat="GARCH α"] dd')).not.toHaveText(
    "—"
  );
  await expect(
    volatility.locator('[data-stat="21-period vol (ann.)"] dd')
  ).toHaveText(/%$/u);
  await expect(
    volatility.locator("p", { hasText: "does not size any order" })
  ).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath("backtest-risk-dark.png"),
  });
});
