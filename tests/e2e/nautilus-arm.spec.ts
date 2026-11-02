import type { Locator, Page } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import type { FakeNodeScenario } from "./helpers/fake-ibkr-recovery.ts";

// Mission control account card: the Nautilus node badge, the Arm dialog and one-click Disarm. The
// server talks to the fake QuantVPS bridge from tests/e2e/helpers/fake-ibkr-recovery.ts. No real
// node can be armed here.

const STATEMENT = "I arm the Nautilus node; it may submit live orders.";
const REASON = "E2E check of the arm dialog; fake bridge only";

const nodeScenario = async (name: FakeNodeScenario): Promise<void> => {
  const response = await fetch(`${e2eEnvironment().recoveryOrigin}/__node`, {
    body: JSON.stringify({ scenario: name }),
    method: "POST",
  });
  expect(response.status).toBe(200);
};

const nodePosts = async (): Promise<Record<string, unknown>[]> => {
  const response = await fetch(`${e2eEnvironment().recoveryOrigin}/__calls`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("nodePosts" in body))
    throw new Error("The fake bridge returned no node call list");
  return Array.isArray(body.nodePosts) ? body.nodePosts : [];
};

// The badge and its buttons sit in the account card. A role locator skips the hidden copy of the
// card that React's streamed reveal leaves in the DOM for a moment after a full page load.
const shownCard = (page: Page): Locator =>
  page.getByRole("region", { exact: true, name: "IBKR account" });

test.afterEach(async () => {
  await nodeScenario("disarmed");
});

test("Arm needs reason, password and statement; Disarm is one click", async ({
  browserErrors,
  page,
}, testInfo) => {
  // The wrong-password step answers 403 on purpose.
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/nautilusArm/arm",
    status: 403,
  });
  for (const message of [
    "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    "Failed to load resource: the server responded with a status of 403 ()",
  ])
    browserErrors.allowConsoleError({ message, pathname: "/dashboard" });
  await nodeScenario("disarmed");
  await signInAs(page, E2E_IDENTITIES.admin);
  await page.goto("/dashboard");
  const card = shownCard(page);
  const badge = card.locator("[data-nautilus-badge]");
  await expect(badge).toHaveAttribute(
    "data-nautilus-badge",
    "running-disarmed"
  );
  await expect(badge).toContainText("Running · Disarmed");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("nautilus-badge-disarmed.png"),
  });

  // The dialog shows the statement; Cancel sends nothing.
  const arm = card.getByRole("button", { exact: true, name: "Arm" });
  await arm.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-nautilus-statement]")).toHaveText(
    STATEMENT
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nodePosts()).toHaveLength(0);

  // A wrong password arms nothing.
  await arm.click();
  await dialog.getByLabel("Reason").fill(REASON);
  await dialog.getByLabel("Your password").fill("not-the-password");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("nautilus-arm-dialog.png"),
  });
  await dialog.getByRole("button", { name: "Arm the node" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Password check failed; the node was not armed"
  );
  expect(await nodePosts()).toHaveLength(0);

  // The right password arms once, with the reason and the statement.
  await dialog.getByLabel("Your password").fill(E2E_IDENTITIES.admin.password);
  await dialog.getByRole("button", { name: "Arm the node" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(badge).toHaveAttribute("data-nautilus-badge", "running-armed");
  await expect(badge).toContainText("Running · Armed");
  await expect(card.locator("[data-nautilus-detail]")).toContainText(REASON);
  const sent = await nodePosts();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    action: "arm",
    imageVersion: "1.4.2-e2e",
    reason: REASON,
    statement: STATEMENT,
  });
  expect(JSON.stringify(sent)).not.toContain(E2E_IDENTITIES.admin.password);
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("nautilus-badge-armed.png"),
  });

  // Disarm: one click, no password.
  await card.getByRole("button", { name: "Disarm" }).click();
  await expect(badge).toHaveAttribute(
    "data-nautilus-badge",
    "running-disarmed"
  );
  expect((await nodePosts()).at(-1)).toMatchObject({ action: "disarm" });
});

test("A stopped node shows Down and no Arm button", async ({
  page,
}, testInfo) => {
  await nodeScenario("down");
  await signInAs(page, E2E_IDENTITIES.admin);
  await page.goto("/dashboard");
  const card = shownCard(page);
  const badge = card.locator("[data-nautilus-badge]");
  await expect(badge).toHaveAttribute("data-nautilus-badge", "down");
  await expect(badge).toContainText("Down");
  await expect(
    card.getByRole("button", { exact: true, name: "Arm" })
  ).toHaveCount(0);
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("nautilus-badge-down.png"),
  });
});
