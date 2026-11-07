import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import {
  captureMockEvidence,
  findLayoutProblems,
  useDarkEvidence,
} from "./helpers/evidence.ts";

// Portfolio layout defects the owner flagged (2026-11-05, card vertex-portfolio-layout-bugs):
// the sidebar nav starts at the top, the skip link shows only on keyboard focus, the sticky tab
// bar never covers the open view, and nothing is cut off on the right at phone width. Dark mode,
// 375 and 1440 px. Mock data only: the E2E server has no ibkr-monitor URL and leaves
// VERTEX_ORDERS_ENABLED unset, so nothing can reach IBKR.

for (const viewport of [
  { height: 812, name: "phone", symbol: "MOCKL", width: 375 },
  { height: 900, name: "desktop", symbol: "MOCKD", width: 1440 },
]) {
  test(`portfolio layout: nav at top, hidden skip link, no overlap, no clipping (${viewport.name})`, async ({
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
    await useDarkEvidence(page);
    await signInAs(page, E2E_IDENTITIES.admin);
    await page.goto("/portfolio?tab=orders");

    // Dark theme: the page background is dark.
    const background = await page.evaluate(() => {
      const match = /\d+(\.\d+)?/gu.exec(
        getComputedStyle(document.body).backgroundColor
      );
      return match === null ? 255 : Number(match[0]);
    });
    expect(background).toBeLessThan(80);

    // The skip link is in the page but not shown until keyboard focus.
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toHaveCSS("opacity", "0");

    const bar = page.getByRole("tablist", { name: "Portfolio views" });
    const heading = page.getByRole("heading", {
      name: "Orders · options only",
    });
    await expect(heading).toBeVisible();

    // Desktop: the sidebar nav starts at the top of the screen.
    const brand = page
      .locator("[data-sidebar=sidebar]")
      .getByRole("link", { name: /Vertex Research/u })
      .first();
    if (viewport.width >= 768)
      expect((await brand.boundingBox())?.y ?? 999).toBeLessThan(80);

    // Keyboard focus on a field that sits under the stuck tab bar moves it below the bar.
    const symbol = page.getByLabel("Underlying symbol", { exact: true });
    await symbol.evaluate((element) =>
      window.scrollTo({
        behavior: "instant",
        top: element.getBoundingClientRect().top + window.scrollY - 8,
      })
    );
    await symbol.focus();
    const barBox = await bar.boundingBox();
    const symbolBox = await symbol.boundingBox();
    // On failure, say where the bar is stuck and how far the page can scroll.
    const barState = await bar.evaluate((element) => {
      const style = getComputedStyle(element);
      const root = document.documentElement;
      return `top=${style.top} position=${style.position} scrollY=${Math.round(window.scrollY)} maxScroll=${root.scrollHeight - root.clientHeight}`;
    });
    expect(
      symbolBox?.y ?? -1,
      `field under the tab bar (${barState})`
    ).toBeGreaterThanOrEqual((barBox?.y ?? 0) + (barBox?.height ?? 0));

    // A jump to the heading (from the bottom, with the bar stuck) stops below the tab bar, and
    // nothing covers the heading.
    await page.evaluate(() =>
      window.scrollTo({
        behavior: "instant",
        top: document.documentElement.scrollHeight,
      })
    );
    // Instant: the page has scroll-behavior smooth, and a smooth jump would be measured mid-way.
    await heading.evaluate((element) =>
      element.scrollIntoView({ behavior: "instant", block: "start" })
    );
    const headingBox = await heading.boundingBox();
    const stuckBar = await bar.boundingBox();
    expect(headingBox?.y ?? -1).toBeGreaterThanOrEqual(
      (stuckBar?.y ?? 0) + (stuckBar?.height ?? 0)
    );
    expect(
      await heading.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + 4,
          box.top + box.height / 2
        );
        return hit !== null && element.contains(hit);
      })
    ).toBe(true);

    await page.evaluate(() =>
      window.scrollTo({ behavior: "instant", left: 0, top: 0 })
    );

    // Nothing is cut off on the right: the order form, then the vertical review with its gate.
    expect(await findLayoutProblems(page)).toEqual([]);
    await page
      .getByLabel("Spread underlying symbol")
      .fill(`${viewport.symbol}`);
    await page.getByLabel("Spread expiry").fill("2028-01-21");
    await page.getByLabel("Buy strike").fill("100");
    await page.getByLabel("Sell strike").fill("110");
    await page.getByLabel("Spreads").fill("1");
    await page.getByLabel(/Net limit per share/u).fill("4");
    await page.getByRole("button", { name: "Review vertical" }).click();
    await expect(
      page.getByRole("region", { name: "Vertical review" })
    ).toContainText("Debit vertical");
    expect(await findLayoutProblems(page)).toEqual([]);
    await captureMockEvidence(
      page,
      testInfo.outputPath(`mock-portfolio-orders-${viewport.name}.png`)
    );

    // The Positions view (ibkr-monitor not configured here) also fits.
    await page.getByRole("tab", { name: "Positions" }).click();
    await expect(page).toHaveURL(/[?&]tab=positions(?:&|$)/u);
    expect(await findLayoutProblems(page)).toEqual([]);
    await captureMockEvidence(
      page,
      testInfo.outputPath(`mock-portfolio-positions-${viewport.name}.png`)
    );

    // Keyboard: the first Tab shows the skip link.
    await page.goto("/portfolio?tab=orders");
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveCSS("opacity", "1");
  });
}
