import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Advisory risk allocator. Pure computation on the server; no order path. Checked at phone
// (390 px) and desktop widths.

for (const viewport of [
  { height: 844, width: 390 },
  { height: 900, width: 1440 },
]) {
  test(`the risk allocator sizes options and refuses non-Crown shares at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/risk-allocator");
    await expect(
      page.getByRole("heading", { level: 1, name: "Risk allocator" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Owner risk caps" })
    ).toBeVisible();

    await page.getByLabel("Symbol").fill("MSFT");
    await page.getByLabel("Expiry").fill("2099-01-16");
    await page.getByLabel("Premium per contract (USD)").fill("5000");
    await page.getByLabel("Net liquidation value (USD)").fill("1000000");
    await page.getByRole("button", { name: "Compute size" }).click();
    await expect(page.getByTestId("max-units")).toHaveText(
      "Max 4 contracts ($20,000)"
    );
    await expect(page.getByText("Rule set: Options only")).toBeVisible();

    await page.getByLabel("Instrument").selectOption("share");
    await page.getByLabel("Price per share (USD)").fill("200");
    await page.getByRole("button", { name: "Compute size" }).click();
    await expect(page.getByTestId("max-units")).toHaveText("Max 0 shares ($0)");
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(width).toBeLessThanOrEqual(viewport.width);
  });
}
