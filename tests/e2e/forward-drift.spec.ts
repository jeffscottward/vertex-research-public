import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Forward drift: an operator runs a backtest, pins it as the baseline of a drift monitor, records
// synthetic paper results that cross the alert thresholds and acknowledges an in-app alert.
// Synthetic, clearly fictional bars and paper data; paper only, no order path.

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

test("an operator records paper results that drift from the backtest and acknowledges the alert", async ({
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
  await page.getByLabel("To", { exact: true }).fill("1973-12-31");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(succeeded).toHaveCount(before + 1, { timeout: 30_000 });

  await page.goto("/forward-drift");
  await expect(
    page.getByRole("heading", { level: 1, name: "Forward drift" })
  ).toBeVisible();
  // Runs and monitors persist across retries in one run database, so counts are relative.
  const inbox = page.getByRole("region", { name: "Open drift alerts" });
  const inboxHeading = inbox.getByRole("heading", {
    name: /^Open drift alerts \(\d+\)$/u,
  });
  await expect(inboxHeading).toBeVisible();
  const open = Number(
    /\((\d+)\)/u.exec((await inboxHeading.textContent()) ?? "")?.[1]
  );
  await page.getByLabel("Monitor name", { exact: true }).fill("TEST paper");
  await page.getByRole("button", { name: "Create monitor" }).click();

  const panel = page.getByRole("region", { name: "Drift panel" });
  await expect(
    panel.getByRole("heading", { name: "TEST paper" })
  ).toBeVisible();
  await expect(panel.getByText("Not enough data").first()).toBeVisible();

  // A 70% fall and twelve losing trades: at least drawdown and losing streak reach their alert
  // thresholds. Profit factor and win rate depend on the baseline run's own trades.
  await page
    .getByLabel("Paper equity points (time, equity)", { exact: true })
    .fill("2026-10-01, 10000\n2026-10-02, 9000\n2026-10-03, 3000");
  await page
    .getByLabel("Closed paper trades (time, pnl)", { exact: true })
    .fill(
      Array.from(
        { length: 12 },
        (_, index) => `2026-10-03T${String(index).padStart(2, "0")}:00, -50`
      ).join("\n")
    );
  const recorded = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname ===
      "/api/orpc/backtestRuns/drift/record"
  );
  await page.getByRole("button", { name: "Record and check drift" }).click();
  expect((await recorded).ok()).toBe(true);

  const raised = panel.getByText(/^New alerts from this recording: \d+$/u);
  await expect(raised).toBeVisible();
  const count = Number((await raised.textContent())?.split(": ")[1]);
  expect(count).toBeGreaterThanOrEqual(2);
  const checks = panel.getByRole("table", { name: "Drift checks" });
  await expect(
    checks.getByRole("row", { name: /^Max drawdown .*Status: Alert/u })
  ).toBeVisible();
  await expect(
    checks.getByRole("row", { name: /^Losing streak .*Status: Alert/u })
  ).toBeVisible();
  await expect(
    panel.getByRole("img", {
      name: "Baseline and paper equity, each from its own start",
    })
  ).toBeVisible();

  await expect(
    inbox.getByRole("heading", { name: `Open drift alerts (${open + count})` })
  ).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: "test-results/forward-drift-dark.png",
  });
  await inbox.getByRole("button", { name: "Acknowledge" }).first().click();
  await expect(
    inbox.getByRole("heading", {
      name: `Open drift alerts (${open + count - 1})`,
    })
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Monitor alerts" })
      .getByText("Acknowledged")
  ).toHaveCount(1);
});
