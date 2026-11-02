import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Owner to-do list: add, edit, mark done, filter by tag, delete, and reload persistence.

test.beforeAll(async () => {
  await resetDatabase();
});

test("redirects a signed-out visitor to sign-in", async ({ page }) => {
  await page.goto("/todos");
  await expect(page).toHaveURL(/\/sign-in/u);
});

test("a signed-in user manages to-dos and they persist across reloads", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/todos");
  await expect(
    page.getByRole("heading", { level: 1, name: "Todos" })
  ).toBeVisible();
  await expect(page.getByText("No to-dos. Add one above.")).toBeVisible();

  await page.locator("#todo-new-title").fill("Paper-search API keys");
  await page.locator("#todo-new-due").fill("2026-10-30");
  await page.locator("#todo-new-tags").fill("research");
  await page.locator("#todo-new-url").fill("https://example.com/item");
  await page.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByText('Added "Paper-search API keys"')).toBeVisible();

  await page.locator("#todo-new-title").fill("Broker check");
  await page.locator("#todo-new-tags").fill("broker");
  await page.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByText('Added "Broker check"')).toBeVisible();

  await page.getByRole("button", { name: "#research" }).click();
  const rows = page.locator("li[data-todo-id]");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(rows).toHaveCount(2);

  await page.getByRole("button", { name: "Edit: Broker check" }).click();
  await page.locator('[id$="-title"]').last().fill("Broker check v2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText('Saved "Broker check v2"')).toBeVisible();

  await page
    .getByRole("button", { name: "Mark done: Paper-search API keys" })
    .click();
  await expect(
    page.locator('li[data-status="done"]', {
      hasText: "Paper-search API keys",
    })
  ).toBeVisible();

  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Broker check v2");
  await expect(rows.last()).toHaveAttribute("data-status", "done");

  await page.getByRole("button", { name: "Delete: Broker check v2" }).click();
  await page
    .getByRole("button", { name: "Confirm delete: Broker check v2" })
    .click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(rows).toHaveCount(1);
});
