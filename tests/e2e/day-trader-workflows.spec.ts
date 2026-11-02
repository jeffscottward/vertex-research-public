import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";
import type { Locator, Page } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import {
  type BrowserErrorGuard,
  E2E_IDENTITIES,
  expect,
  signInAs,
  test,
} from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Day-trader workflows: congress PTR feed, news monitor, setup replay and price alerts.
// CI runs the browser lane without internet, so the House Clerk, Yahoo and SEC reads fail
// there; those pages must then show an accessible error instead of breaking. The setup
// replay runs on synthetic, clearly fictional stored bars and is fully deterministic.
// Set E2E_SCREENSHOT_DIR (host network only) to also save full-page screenshots of the
// four pages after their live data loaded. Research only; no order path.

const VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 812, width: 375 },
] as const;

const DAY_MS = 86_400_000;
const FIRST_BAR_T = Date.UTC(2018, 0, 2);
const LIVE_TIMEOUT_MS = 60_000;
const CONGRESS_FEED = "/api/orpc/congressTrades/feed";

// resetDatabase keeps stored bar series, and later specs open the first series in the list,
// so this spec replaces the shared fictional TEST series like the other specs instead of
// adding new symbols.
const SERIES_SYMBOL = "TEST";
const SERIES_BARS = 1200;

/** A seeded random walk with overnight gaps, so every setup preset occurs. */
const syntheticWalk = (size: number, seed: number): MarketBarRow[] => {
  // Deterministic noise in [0, 1): the fractional part of a scaled sine.
  let draw = 0;
  const next = (): number => {
    draw += 1;
    const x = Math.sin(seed * 12.9898 + draw * 78.233) * 43_758.5453;
    return x - Math.floor(x);
  };
  const bars: MarketBarRow[] = [];
  let previousClose = 100;
  for (let index = 0; index < size; index += 1) {
    const open = previousClose * (1 + (next() - 0.49) * 0.04);
    const close = open * (1 + (next() - 0.49) * 0.04);
    bars.push({
      c: close,
      h: Math.max(open, close) * (1 + next() * 0.01),
      l: Math.min(open, close) * (1 - next() * 0.01),
      o: open,
      t: FIRST_BAR_T + index * DAY_MS,
      v: null,
    });
    previousClose = close;
  }
  return bars;
};

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
        sourceSha256: "d".repeat(64),
        symbol: SERIES_SYMBOL,
        timeframe: "1d",
      },
      syntheticWalk(SERIES_BARS, 11)
    );
  } finally {
    await resource.close();
  }
});

/** The House Clerk read fails without internet (503 unavailable, 502 upstream, 404 no index). */
const allowCongressFeedFailure = (browserErrors: BrowserErrorGuard): void => {
  for (const status of [404, 502, 503]) {
    browserErrors.allowHttpError({
      method: "POST",
      pathname: CONGRESS_FEED,
      status,
    });
  }
};

/** The page itself never scrolls sideways; wide tables scroll inside their own box. */
const expectNoPageOverflow = async (page: Page, width: number) => {
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth
  );
  expect(scrollWidth, `page overflow at ${width} px`).toBeLessThanOrEqual(
    width + 1
  );
};

const openPage = async (page: Page, path: string, title: string) => {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { level: 1, name: title })
  ).toBeVisible();
};

const addToWatchlist = async (page: Page, symbols: readonly string[]) => {
  await openPage(page, "/watchlist", "Watchlist");
  // The list must have loaded before an add, or its answer races the first read.
  await expect(page.getByText("Loading watchlist…")).toHaveCount(0);
  await page.getByLabel("Symbols to add").fill(symbols.join(", "));
  await page.getByRole("button", { exact: true, name: "Add symbols" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Added \d+/u })
  ).toContainText("rejected 0");
};

/** The feed table, or the alert that says the House Clerk could not be read. */
const congressOutcome = (page: Page) =>
  page
    .getByRole("region", { name: "PTR filings" })
    .or(page.getByRole("alert").filter({ hasText: "Filings unavailable" }));

const runReplay = async (page: Page): Promise<Locator> => {
  await page
    .getByLabel("Daily series", { exact: true })
    .selectOption({ label: "TEST daily (1,200 bars)" });
  await page.getByRole("button", { exact: true, name: "Run replay" }).click();
  const results = page.locator('[data-setup-replay="results"]');
  await expect(results).toBeVisible();
  await expect(results).toContainText(
    "on TEST daily, 2018-01-02 to 2021-04-15 (1,200 bars)"
  );
  return results;
};

const replayCards = [
  "Occurrences",
  "Win rate",
  "Average R",
  "Planned expectancy (R)",
  "Paths in profit",
  "Median total R",
] as const;

for (const viewport of VIEWPORTS) {
  test(`day-trader pages render at ${viewport.width} px`, async ({
    browserErrors,
    page,
  }) => {
    test.setTimeout(180_000);
    allowCongressFeedFailure(browserErrors);
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.admin);

    await openPage(page, "/congress-trades", "Congress trades");
    await expect(congressOutcome(page)).toBeVisible({
      timeout: LIVE_TIMEOUT_MS,
    });
    await expectNoPageOverflow(page, viewport.width);

    // The seeded watchlist is empty: the monitor points to the watchlist page.
    await openPage(page, "/news", "News monitor");
    await expect(page.getByText("Your watchlist is empty")).toBeVisible();
    await expect(
      page.getByRole("link", { exact: true, name: "Open watchlist" })
    ).toHaveAttribute("href", "/watchlist");
    await expectNoPageOverflow(page, viewport.width);

    await openPage(page, "/price-alerts", "Price alerts");
    await expect(
      page.getByRole("link", { exact: true, name: "watchlist" })
    ).toHaveAttribute("href", "/watchlist");
    await expect(
      page.getByRole("button", { name: "Check now" })
    ).toBeDisabled();
    await expectNoPageOverflow(page, viewport.width);

    await openPage(page, "/setup-replay", "Setup replay");
    const results = await runReplay(page);
    for (const label of replayCards) {
      await expect(results.locator(`[data-stat="${label}"] dd`)).toHaveText(
        /\d/u
      );
    }
    const rows = results.getByRole("region", {
      name: "Occurrence table, scrolls sideways on small screens",
    });
    await expect(rows.locator("tbody tr").first()).toBeVisible();
    await expect(
      results.locator('[data-stat="Occurrences"] dd')
    ).not.toHaveText("0");
    await expectNoPageOverflow(page, viewport.width);
  });
}

test("the setup replay gives the same numbers for the same choices", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.admin);
  await openPage(page, "/setup-replay", "Setup replay");
  const cardText = (results: Locator) =>
    Promise.all(
      replayCards.map((label) =>
        results.locator(`[data-stat="${label}"] dd`).textContent()
      )
    );
  const first = await cardText(await runReplay(page));
  const firstRows = await page.locator("tbody tr").count();
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Setup replay" })
  ).toBeVisible();
  const second = await cardText(await runReplay(page));
  expect(second).toEqual(first);
  expect(await page.locator("tbody tr").count()).toBe(firstRows);
});

test("an operator creates a price alert for a watchlist symbol", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.admin);
  await addToWatchlist(page, ["KO"]);

  await openPage(page, "/price-alerts", "Price alerts");
  await page.getByLabel("Symbol", { exact: true }).selectOption("KO");
  await page.getByLabel("Condition", { exact: true }).selectOption("above");
  await page.getByLabel("Level", { exact: true }).fill("1000");
  await page.getByLabel("Role", { exact: true }).selectOption("target");
  await page.getByLabel("Note (optional)").fill("E2E research notice");
  await page.getByRole("button", { exact: true, name: "Create alert" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Alert created for KO." })
  ).toBeVisible();

  const active = page.getByRole("region", { name: "Active (1)" });
  await expect(active).toBeVisible();
  const rule = active.getByRole("listitem");
  await expect(rule).toHaveCount(1);
  await expect(rule).toContainText("KO");
  await expect(rule).toContainText("at or above 1000");
  await expect(rule).toContainText("Target");
  await expect(rule).toContainText("Last checked never");
  await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled();

  // The rule is stored: it is still listed after a reload, and at phone width.
  await page.setViewportSize(VIEWPORTS[1]);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Active (1)" }).getByRole("listitem")
  ).toContainText("at or above 1000");
  await expectNoPageOverflow(page, VIEWPORTS[1].width);
});

test("live screenshots of the four day-trader pages", async ({
  browserErrors,
  page,
}) => {
  const directory = process.env["E2E_SCREENSHOT_DIR"];
  test.skip(
    directory === undefined || directory === "",
    "Set E2E_SCREENSHOT_DIR on a networked host to save live screenshots."
  );
  if (directory === undefined) return;
  test.setTimeout(600_000);
  allowCongressFeedFailure(browserErrors);
  await mkdir(directory, { recursive: true });
  await signInAs(page, E2E_IDENTITIES.admin);
  await addToWatchlist(page, ["TSLA", "AAPL", "KO"]);

  // One rule that a live quote triggers (KO trades far below 1000) and one that stays active.
  await openPage(page, "/price-alerts", "Price alerts");
  for (const [kind, level] of [
    ["below", "1000"],
    ["above", "100000"],
  ] as const) {
    await page.getByLabel("Symbol", { exact: true }).selectOption("KO");
    await page.getByLabel("Condition", { exact: true }).selectOption(kind);
    await page.getByLabel("Level", { exact: true }).fill(level);
    await page
      .getByRole("button", { exact: true, name: "Create alert" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Alert created for KO." })
    ).toBeVisible();
  }
  await page.getByRole("button", { exact: true, name: "Check now" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Checked \d+ rule/u })
  ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  const shoot = async (name: string, width: number) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      fullPage: true,
      path: join(directory, `${name}-${width}.png`),
    });
  };

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);

    await openPage(page, "/congress-trades", "Congress trades");
    await expect(congressOutcome(page)).toBeVisible({
      timeout: LIVE_TIMEOUT_MS,
    });
    await shoot("congress-trades", viewport.width);

    await openPage(page, "/news", "News monitor");
    await expect(
      page.getByRole("heading", { level: 2, name: "TSLA" })
    ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
    await shoot("news", viewport.width);

    await openPage(page, "/setup-replay", "Setup replay");
    await runReplay(page);
    await shoot("setup-replay", viewport.width);

    await openPage(page, "/price-alerts", "Price alerts");
    await expect(
      page.getByRole("heading", { level: 2, name: /^Triggered \(/u })
    ).toBeVisible();
    await shoot("price-alerts", viewport.width);
  }
});
