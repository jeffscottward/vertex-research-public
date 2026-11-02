import {
  createNodeDatabase,
  createStrategyLibraryRepository,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Strategy library sources: an operator filters the library by a source tag and follows the
// source links named in a description. Fictional strategies and .test links; research only.

test.beforeAll(async () => {
  await resetDatabase();
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    const repository = createStrategyLibraryRepository(resource.db);
    // Other specs and Playwright retries share the run database: create each fixture once.
    const existing = new Set(
      (await repository.list({ search: "Fictional" })).map((row) => row.name)
    );
    if (!existing.has("Fictional sourced trend")) {
      await repository.create({
        description:
          "Fictional example. Dashboard: https://dashboard.example.test/strategies/e2e-source GitHub: https://code.example.test/e2e-source.py Research only.",
        kind: "external",
        name: "Fictional sourced trend",
        section: "QuantJourney weights",
        tags: ["quantjourney", "weights"],
      });
    }
    if (!existing.has("Fictional unsourced idea")) {
      await repository.create({
        kind: "python",
        name: "Fictional unsourced idea",
      });
    }
  } finally {
    await resource.close();
  }
});

test("an operator filters the library by source and opens the source links", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { level: 1, name: "Strategy library" })
  ).toBeVisible();
  await expect(page.getByText("Fictional unsourced idea")).toBeVisible();

  const listed = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/strategyLibrary/list" &&
      (candidate.request().postData() ?? "").includes("quantjourney")
  );
  await page
    .getByLabel("Source filter", { exact: true })
    .selectOption("quantjourney");
  expect((await listed).ok()).toBe(true);
  await expect(page.getByText("Fictional unsourced idea")).toHaveCount(0);
  await expect(page.getByText("Fictional sourced trend")).toBeVisible();
  // The QuantJourney rows of migration 0033 carry the same source tag.
  await expect(
    page.getByText("QuantJourney W01: Daily SMA Trend")
  ).toBeVisible();
  await page
    .getByLabel("Search strategies", { exact: true })
    .fill("Fictional sourced");

  await page.getByRole("button", { name: "Cards" }).click();
  const card = page.locator("[data-strategy-card]");
  await expect(card).toHaveCount(1);
  const links = card.locator("[data-strategy-links] a");
  await expect(links).toHaveText([
    "dashboard.example.test",
    "code.example.test",
  ]);
  await expect(links.first()).toHaveAttribute(
    "href",
    "https://dashboard.example.test/strategies/e2e-source"
  );
  await expect(links.first()).toHaveAttribute("target", "_blank");

  await card.getByRole("link", { name: "Fictional sourced trend" }).click();
  const detail = page.locator("[data-strategy-detail]");
  await expect(detail.locator("[data-strategy-links] a")).toHaveCount(2);
});
