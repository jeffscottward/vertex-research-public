import {
  fixturePosition,
  fixtureSnapshot,
} from "../../apps/web/src/components/portal/portfolio-monitor-fixture.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { captureMockEvidence } from "./helpers/evidence.ts";

// Per-position Close / Buy / Sell buttons on Portfolio > Positions (owner 2026-11-04). The E2E
// server has no ibkr-monitor URL, so the snapshot is stubbed with fictional rows. Orders use the
// server's simulated mock gateway (VERTEX_ORDERS_ENABLED unset), whose fictional account holds
// neither MOCKX nor MOCKS, so every review here is refused. This spec never presses Confirm.

const snapshot = fixtureSnapshot({
  positions: [
    fixturePosition({
      avgPrice: 150,
      costBasis: 300,
      dailyPnl: 0,
      description: "MOCKX 20281215 50 C",
      id: "3001",
      last: 2,
      marketValue: 400,
      position: 2,
      secType: "OPT",
      symbol: "MOCKX",
      unrealized: 100,
      unrealizedPct: 33,
      weightPct: 1,
    }),
    fixturePosition({
      avgPrice: 10,
      costBasis: 100,
      dailyPnl: 0,
      description: "MOCKS",
      id: "3002",
      last: 11,
      marketValue: 110,
      position: 10,
      secType: "STK",
      symbol: "MOCKS",
      unrealized: 10,
      unrealizedPct: 10,
      weightPct: 1,
    }),
  ],
});

for (const viewport of [
  { height: 844, name: "mobile", width: 390 },
  { height: 900, name: "desktop", width: 1440 },
]) {
  test(`position buttons open a confirm dialog that Cancel closes (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    // No order may ever leave the page: any submit request is aborted and fails the test.
    const submitAttempts: string[] = [];
    await page.route(
      /\/api\/orpc\/vertexOrders\/(?:submit|comboSubmit)(?:[/?]|$)/u,
      (route) => {
        submitAttempts.push(route.request().url());
        return route.abort();
      }
    );
    await page.route("**/api/orpc/ibkrMonitor/snapshot", (route) =>
      route.fulfill({ json: { json: snapshot, meta: [] } })
    );
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    await signInAs(page, E2E_IDENTITIES.admin);
    await page.goto("/portfolio");
    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page.locator("th", { hasText: "Actions" })).toBeVisible();
    await expect(
      page.getByText(
        "Close, Buy and Sell open a confirm dialog. Nothing is sent until you confirm there."
      )
    ).toBeVisible();

    const option = page.locator('[data-position-id="3001"]');
    const close = option.locator('[data-position-action="close"]');
    await expect(close).toHaveAccessibleName("Close MOCKX 20281215 50 C");
    await expect(close).toBeEnabled();
    // The mock gates report the kill switch off, so an unpaired option can also be bought or sold.
    await expect(option.locator('[data-position-action="buy"]')).toBeEnabled();
    await expect(option.locator('[data-position-action="sell"]')).toBeEnabled();

    // Shares can only be closed here (options only for new positions): one Close button.
    const shares = page.locator('[data-position-id="3002"]');
    await expect(shares.locator("[data-position-action]")).toHaveCount(1);
    const closeShares = shares.locator('[data-position-action="close"]');
    await expect(closeShares).toHaveAccessibleName("Close MOCKS shares");
    await expect(closeShares).toBeEnabled();

    await captureMockEvidence(
      page,
      testInfo.outputPath(`position-actions-${viewport.name}.png`)
    );

    // Option close: a marketable SELL of both held contracts at the mark - 5% (2 x 1.90 x 100).
    await close.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Close MOCKX 20281215 50 call");
    await expect(dialog).toContainText("SELL");
    await expect(dialog).toContainText("Held contracts");
    await expect(dialog).toContainText("Limit (LMT), day");
    await expect(dialog).toContainText("Estimated proceeds");
    await expect(dialog).toContainText("$380.00");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await captureMockEvidence(
      page,
      testInfo.outputPath(`position-dialog-${viewport.name}.png`)
    );
    await dialog.getByRole("button", { name: "Review order" }).click();
    // The simulated mock account does not hold MOCKX, so the server refuses the sale and no
    // confirm button appears.
    await expect(dialog).toContainText("SELL only closes held contracts");
    await expect(dialog.getByRole("button", { name: /Confirm:/ })).toHaveCount(
      0
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Share close: a marketable SELL of the 10 held shares at the mark - 1% (10 x 10.89).
    await closeShares.click();
    await expect(dialog).toContainText("Close MOCKS shares");
    await expect(dialog).toContainText("Held shares");
    await expect(dialog).toContainText("$108.90");
    await dialog.getByRole("button", { name: "Review order" }).click();
    await expect(dialog).toContainText(
      "shares can only be closed or reduced here"
    );
    await expect(dialog.getByRole("button", { name: /Confirm:/ })).toHaveCount(
      0
    );
    // Escape cancels as well.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(submitAttempts).toEqual([]);
  });
}
