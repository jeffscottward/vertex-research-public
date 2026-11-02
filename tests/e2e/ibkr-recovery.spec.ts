import type { Locator, Page } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import type { FakeRecoveryScenario } from "./helpers/fake-ibkr-recovery.ts";

// Mission control account card "Send IBKR 2FA request". The server talks to the fake QuantVPS
// recovery service from tests/e2e/helpers/fake-ibkr-recovery.ts (global setup), which starts
// nothing. No real 2FA request can leave this run.

const STATEMENT =
  "I request IBKR recovery only; this does not authorize trading.";

const scenario = async (name: FakeRecoveryScenario): Promise<void> => {
  const response = await fetch(
    `${e2eEnvironment().recoveryOrigin}/__scenario`,
    {
      body: JSON.stringify({ scenario: name }),
      method: "POST",
    }
  );
  expect(response.status).toBe(200);
};

const posts = async (): Promise<unknown[]> => {
  const response = await fetch(`${e2eEnvironment().recoveryOrigin}/__calls`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("posts" in body))
    throw new Error("The fake recovery service returned no call list");
  return Array.isArray(body.posts) ? body.posts : [];
};

// After a full page load, React streams each Suspense boundary into a hidden
// `<div hidden id="S:n">` and reveals it a moment later. During the reveal the
// page briefly holds a hidden copy of the account card beside the shown one, so a
// CSS locator such as [data-account-glance] can match two elements. A role
// locator skips hidden nodes; every card query is scoped to the shown copy.
const shownCard = (page: Page): Locator =>
  page.getByRole("region", { exact: true, name: "IBKR account" });

test.afterEach(async () => {
  await scenario("logged-in");
});

for (const viewport of [
  { height: 844, name: "mobile", width: 390 },
  { height: 900, name: "desktop", width: 1440 },
]) {
  test(`2FA request button follows the gateway login state (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    await scenario("logged-in");
    await signInAs(page, E2E_IDENTITIES.admin);
    await page.goto("/dashboard");
    // The account card holds the control. The E2E server has no IBKR_MONITOR_URL, so the
    // card reports "not configured" and sends no snapshot request; the 2FA control still works.
    const card = shownCard(page);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-account-glance", "true");
    await expect(
      card.locator('[data-monitor-state="not-configured"]')
    ).toBeVisible();
    // Logged in: no button, no login badge.
    await expect(
      card.getByRole("button", { name: "Send IBKR 2FA request" })
    ).toHaveCount(0);
    await expect(card.getByText("IBKR login:")).toHaveCount(0);

    // Logged out: badge and button appear.
    await scenario("logged-out");
    await page.reload();
    await expect(card.getByText("IBKR login: logged out")).toBeVisible();
    const send = card.getByRole("button", { name: "Send IBKR 2FA request" });
    await expect(send).toBeEnabled();
    const box = await send.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Confirm dialog with the exact statement; Cancel sends nothing.
    await send.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(STATEMENT);
    await expect(dialog.locator("[data-recovery-statement]")).toHaveText(
      STATEMENT
    );
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`ibkr-2fa-confirm-${viewport.name}.png`),
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await posts()).toHaveLength(0);

    // Confirm: one request with the statement, then every progress step.
    await send.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirm and send" })
      .click();
    const progress = card.locator("[data-ibkr-recovery-state]");
    await expect(progress).toHaveAttribute(
      "data-ibkr-recovery-state",
      "waiting-for-approval",
      { timeout: 15_000 }
    );
    await expect(progress).toContainText("Waiting for approval on your phone");
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`ibkr-2fa-waiting-${viewport.name}.png`),
    });
    await expect(progress).toHaveAttribute(
      "data-ibkr-recovery-state",
      "verifying",
      { timeout: 15_000 }
    );
    await expect(progress).toHaveAttribute(
      "data-ibkr-recovery-state",
      "logged-in",
      { timeout: 15_000 }
    );
    await expect(progress).toContainText("Logged in; account snapshot OK");
    await expect(progress).toContainText("Requested by you");
    // Logged in again: the button is gone.
    await expect(send).toHaveCount(0);
    const sent = await posts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ dryRun: false, statement: STATEMENT });
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`ibkr-2fa-logged-in-${viewport.name}.png`),
    });
  });
}

test("2FA request button is disabled during the cooldown", async ({
  page,
}, testInfo) => {
  await scenario("cooldown");
  await signInAs(page, E2E_IDENTITIES.admin);
  await page.goto("/dashboard");
  const card = shownCard(page);
  const send = card.getByRole("button", { name: "Send IBKR 2FA request" });
  await expect(send).toBeDisabled();
  await expect(card.locator("#ibkr-recovery-hint")).toContainText(
    "Next request possible at"
  );
  const progress = card.locator("[data-ibkr-recovery-state]");
  await expect(progress).toContainText("Timed out; no approval was received");
  await expect(progress).toContainText("Requested by another operator");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("ibkr-2fa-cooldown.png"),
  });
  // Dark mode: the warning badge, hint and progress tones use theme tokens.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(
    page.locator("html").evaluate((node) => getComputedStyle(node).colorScheme)
  ).resolves.toContain("dark");
  await expect(progress).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("ibkr-2fa-cooldown-dark.png"),
  });
  await send.click({ force: true }).catch(() => undefined);
  expect(await posts()).toHaveLength(0);
});
