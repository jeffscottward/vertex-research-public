import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Owner order screen (Portfolio > Orders). The E2E server leaves VERTEX_ORDERS_ENABLED unset, so
// every call uses the simulated mock gateway and nothing can reach IBKR. Mock data only. The mock
// account lives in the server process, so each viewport run uses its own symbol.

for (const viewport of [
  { name: "mobile", symbol: "MOCKM", width: 390, height: 844 },
  { name: "desktop", symbol: "MOCKW", width: 1440, height: 900 },
]) {
  test(`orders need a review before send and a confirm before cancel (${viewport.name})`, async ({
    browserErrors,
    page,
  }, testInfo) => {
    // The Positions view (ibkr-monitor) loads first; the E2E server has no ibkr-monitor URL.
    browserErrors.allowHttpError({
      method: "GET",
      pathname: "/api/orpc/ibkr-monitor/snapshot",
      status: 503,
    });
    browserErrors.allowHttpError({
      method: "POST",
      pathname: "/api/orpc/ibkrMonitor/snapshot",
      status: 503,
    });
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await signInAs(page, E2E_IDENTITIES.admin);
    await page.goto("/portfolio");
    await page.getByRole("tab", { name: "Vertex orders" }).click();
    // The IBKR monitor's own status (above the tabs) is also on the page: scope to the open view.
    await expect(
      page
        .getByRole("tabpanel")
        .getByRole("status")
        .filter({ hasText: "Orders disabled" })
    ).toBeVisible();
    await expect(page.getByText("Not cancellable here")).toBeVisible();

    await page.getByLabel("Underlying symbol").fill(viewport.symbol);
    await page.getByLabel("Expiry").fill("2028-01-21");
    await page.getByLabel("Strike").fill("100");
    await page.getByLabel("Contracts").fill("2");
    await page.getByLabel("Limit price per share").fill("10");
    await expect(page.getByRole("button", { name: /Send order/ })).toHaveCount(
      0
    );
    await page.getByRole("button", { name: "Review order" }).click();
    const review = page.getByRole("region", { name: "Order review" });
    await expect(review).toContainText(`${viewport.symbol} 20280121 100 call`);
    await expect(review).toContainText("LEAPS cap 6% NLV per name");
    await expect(review).toContainText("Passes all order rules");
    await page.screenshot({
      path: testInfo.outputPath(`orders-review-${viewport.name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Send order (simulated)" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Order submitted (simulated)"
    );

    // Over the 2% short-dated cap: the review shows the reason and no send button.
    await page.getByLabel("Underlying symbol").fill("MOCKE");
    await page.getByLabel("Expiry").fill("2026-12-18");
    await page.getByLabel("Strike").fill("50");
    await page.getByLabel("Contracts").fill("5");
    await page.getByLabel("Limit price per share").fill("10");
    await page.getByRole("button", { name: "Review order" }).click();
    await expect(
      page.getByRole("region", { name: "Order review" })
    ).toContainText("the cap is 2%");
    await expect(page.getByRole("button", { name: /Send order/ })).toHaveCount(
      0
    );
    await page.getByRole("button", { name: "Back" }).click();

    await page.getByRole("button", { name: "Cancel…" }).first().click();
    const cancel = page.getByRole("region", { name: "Cancel review" });
    await expect(cancel).toContainText("BUY");
    await page.screenshot({
      path: testInfo.outputPath(`orders-cancel-${viewport.name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Send cancel (simulated)" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Cancel cancelled (simulated)"
    );
  });
}
