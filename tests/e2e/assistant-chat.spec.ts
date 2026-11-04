import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";
import { FAKE_ASSISTANT_REPLY } from "./helpers/fake-assistant-model.ts";

// One chat entry: the sidebar links Research only; the assistant opens from the Research
// page. The operator sends a message, the E2E fake model (tests/e2e/helpers/fake-assistant-model.ts)
// returns a stubbed reply, and a reload keeps the stored transcript. No real model key.

const MESSAGE = "Fictional stub question";

test.beforeAll(async () => {
  await resetDatabase();
});

test("the assistant opens from Research, replies and keeps the transcript after reload", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/research");

  // The sidebar lists Research (marked as the current page) and no Assistant entry.
  await expect(
    page.getByRole("link", { name: /^Research\b/u }).first()
  ).toHaveAttribute("href", "/research");
  await expect(page.getByRole("link", { name: /^Assistant\b/u })).toHaveCount(
    0
  );

  await page.getByRole("link", { name: "Open the research assistant" }).click();
  await expect(page).toHaveURL(/\/assistant$/u);

  await page.getByLabel("Message").fill(MESSAGE);
  await page.getByRole("button", { name: "Send" }).click();

  const transcript = page.getByRole("list", { name: "Transcript" });
  await expect(transcript).toContainText(MESSAGE);
  await expect(transcript).toContainText(FAKE_ASSISTANT_REPLY);

  await page.reload();
  await page
    .getByRole("navigation", { name: "Assistant threads" })
    .getByRole("button", { name: new RegExp(MESSAGE, "u") })
    .click();
  const reloaded = page.getByRole("list", { name: "Transcript" });
  await expect(reloaded).toContainText(MESSAGE);
  await expect(reloaded).toContainText(FAKE_ASSISTANT_REPLY);
});
