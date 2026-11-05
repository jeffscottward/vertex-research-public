import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Portfolio layout (owner 2026-11-04): page header -> collapsible Summary -> sticky tab bar ->
// tab content. The summary fold is remembered; the open tab is in ?tab=; the tab bar stays on
// screen while the content scrolls and does not move when the tab changes. Mock data only:
// the E2E server has no ibkr-monitor URL and leaves VERTEX_ORDERS_ENABLED unset.

for (const viewport of [
  { height: 844, name: "mobile", width: 390 },
  { height: 900, name: "desktop", width: 1440 },
]) {
  test(`portfolio summary folds and the tab bar stays on screen (${viewport.name})`, async ({
    browserErrors,
    page,
  }, testInfo) => {
    browserErrors.allowHttpError({
      method: "POST",
      pathname: "/api/orpc/ibkrMonitor/snapshot",
      status: 503,
    });
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    await signInAs(page, E2E_IDENTITIES.admin);
    await page.goto("/portfolio");

    const summary = page.getByRole("button", { name: "Summary" });
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.getByRole("button", { name: "Summary" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    const bar = page.getByRole("tablist", { name: "Portfolio views" });
    await page.getByRole("tab", { name: "Vertex orders" }).click();
    await expect(page).toHaveURL(/[?&]tab=orders(?:&|$)/u);
    // Scroll to the end of the long orders view: the tab bar stays at the top of the screen.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(bar).toBeInViewport();
    const before = await bar.boundingBox();
    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page).toHaveURL(/[?&]tab=positions(?:&|$)/u);
    await expect(bar).toBeInViewport();
    const after = await bar.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? -100))).toBeLessThanOrEqual(
      2
    );
    await page.screenshot({
      fullPage: false,
      path: testInfo.outputPath(`portfolio-tabs-${viewport.name}.png`),
    });

    // A link with ?tab= opens that view.
    await page.goto("/portfolio?tab=pnl");
    await expect(page.getByRole("tab", { name: "P&L" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
}
