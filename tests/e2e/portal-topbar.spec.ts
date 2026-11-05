import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Portal top bar (Fulcrum structure): breadcrumb, search box that opens the command palette,
// quick actions. Checked at phone (375 px) and desktop widths.

for (const viewport of [
  { height: 812, width: 375 },
  { height: 900, width: 1440 },
]) {
  test(`the top bar search opens the palette and offers a ticker at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/watchlist");
    const topbar = page.locator('[data-slot="portal-topbar"]');
    await expect(
      topbar.getByRole("navigation", { name: "Breadcrumb" })
    ).toBeVisible();
    const search = topbar
      .getByRole("button", { name: "Search ticker or page" })
      .filter({ visible: true });
    await expect(search).toHaveCount(1);
    await search.click();
    const dialog = page.getByRole("dialog", { name: "Jump to a page" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox").fill("nvda");
    await expect(
      dialog.getByRole("option", { name: /Open NVDA/u })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(width).toBeLessThanOrEqual(viewport.width);
  });
}
