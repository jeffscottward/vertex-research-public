import type { Page } from "@playwright/test";

import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase, seedLongTextModelRun } from "./helpers/database.ts";

// Agent model runs (research only; no order path): the Agent runs page, a run page and the
// benchmark page (with the Frameworks section) fit a phone and a desktop. The seeded run's tool
// result is one 5000-character word, as the fake Vibe-Trading driver records, and a task fills
// the Agent tasks table.

let runId = "";
test.beforeAll(async () => {
  await resetDatabase();
  runId = await seedLongTextModelRun();
});

const pageWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth);

for (const viewport of [
  { height: 812, width: 375 },
  { height: 900, width: 1440 },
]) {
  test(`model run and benchmark pages stay within ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.admin);

    await page.goto("/agents");
    await page
      .getByLabel("New task title")
      .fill(`Narrow layout check ${viewport.width}`);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(
      page.getByRole("table", { name: "Agent tasks" })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Model runs table" }).locator("tbody tr")
    ).toHaveCount(1);
    expect.soft(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);

    await page.goto(`/agents/runs/${runId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "QAA · 2026-06-08 · vibe_trading"
    );
    await expect(page.getByText("Event 1 of 1")).toBeVisible();
    await page.getByRole("button", { name: "Show text" }).click();
    await expect(page.locator("li[data-seq] pre")).toBeVisible();
    expect.soft(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);

    await page.goto("/agents/benchmark");
    await expect(
      page.getByRole("region", { name: "Frameworks" }).locator("article")
    ).not.toHaveCount(0);
    expect.soft(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);
  });
}
