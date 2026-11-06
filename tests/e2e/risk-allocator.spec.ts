import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Advisory risk allocator. Pure computation on the server; no order path, and nothing here changes
// a cap or a setting. Without ?symbol= the page sizes the first watchlist symbol (the seeded E2E
// watchlist is empty, so it explains how to get a suggestion instead). Checked at phone (390 px) and
// desktop widths.

for (const viewport of [
  { height: 844, width: 390 },
  { height: 900, width: 1440 },
]) {
  test(`the risk allocator shows the caps, a default suggestion and refuses non-Crown shares at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/risk-allocator");
    await expect(
      page.getByRole("heading", { level: 1, name: "Risk allocator" })
    ).toBeVisible();
    const caps = page.getByRole("region", {
      exact: true,
      name: "Owner risk caps",
    });
    await expect(
      caps.getByRole("heading", { name: "Owner risk caps" })
    ).toBeVisible();
    await expect(caps).toContainText("It does not enforce or change them.");
    const suggestion = page.getByRole("region", {
      exact: true,
      name: "Sizing suggestion",
    });
    // Empty watchlist: an explanation with a way forward; otherwise the first symbol is sized.
    await expect(
      suggestion
        .getByRole("heading", { name: "No watchlist symbol to size" })
        .or(suggestion.getByTestId("max-units"))
    ).toBeVisible();
    // Every defaulted input is labelled as a default next to the field.
    await expect(
      suggestion.getByText("Default: 100,000 (example account size, not yours)")
    ).toBeVisible();
    await expect(
      suggestion.getByText("Default: 500 (example cost, not a quote)")
    ).toBeVisible();

    // ?symbol= sizes that symbol straight away with the default inputs.
    await page.goto("/risk-allocator?symbol=MSFT");
    await expect(
      page.getByRole("heading", { level: 1, name: "Risk allocator" })
    ).toBeVisible();
    await expect(page.getByLabel("Symbol", { exact: true })).toHaveValue(
      "MSFT"
    );
    await expect(
      page.getByRole("region", { name: "Suggestion for MSFT" })
    ).toBeVisible();
    await expect(page.getByTestId("max-units")).toHaveText(
      /^Max \d+ contracts/u
    );

    await page.getByLabel("Symbol", { exact: true }).fill("MSFT");
    await page.getByLabel("Expiry").fill("2099-01-16");
    await page.getByLabel("Premium per contract (USD)").fill("5000");
    await page.getByLabel("Net liquidation value (USD)").fill("1000000");
    await page.getByRole("button", { name: "Compute size" }).click();
    await expect(page.getByTestId("max-units")).toHaveText(
      "Max 4 contracts ($20,000)"
    );
    await expect(page.getByText("Rule set: Options only")).toBeVisible();
    await expect(page).toHaveURL(/\/risk-allocator\?symbol=MSFT$/u);

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
