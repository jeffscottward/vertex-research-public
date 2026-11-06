import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Sector rotation map. The E2E database holds no collected sector rotation rows, so the stored
// sector map answers NOT_FOUND and the page must say so without failing. Custom lists call Yahoo,
// so none is applied here. Research only; no order path.

test("the sector rotation page reports a map that is not yet collected", async ({
  browserErrors,
  page,
}) => {
  // NOT_FOUND answers HTTP 404; the page shows it as an alert.
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/sectorRotation/map",
    status: 404,
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/sector-rotation");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sector rotation" })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Weekly" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("alert")).toContainText(
    "Sector rotation not yet collected. The nightly job fills it after the US close."
  );
  await expect(page.getByText("Not the RRG® / JdK algorithm.")).toBeVisible();
  // The header chip and primary action reflect the failed load.
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  // The controls live in the map panel header.
  await expect(
    page.getByRole("region", { name: "Rotation map" }).getByLabel("Tail length")
  ).toBeVisible();
  // The daily map is not collected either; the tab switch reloads and keeps the notice.
  await page.getByRole("tab", { name: "Daily" }).click();
  await expect(page.getByRole("tab", { name: "Daily" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("alert")).toContainText(
    "Sector rotation not yet collected"
  );
  // Settings are kept in the URL and restored on reload.
  await expect(page).toHaveURL(/[?&]timeframe=daily/u);
  await page.getByLabel("Tail length").selectOption("20");
  await expect(page).toHaveURL(/[?&]tail=20/u);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Daily" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByLabel("Tail length")).toHaveValue("20");
  // A custom list waits for Apply and does not call the map.
  await page.getByLabel("Universe").selectOption("custom");
  await expect(
    page.getByText("Type up to 30 tickers and select Apply to draw them.")
  ).toBeVisible();
  await expect(
    page.getByLabel("Tickers (comma or space separated)")
  ).toBeEditable();
  await expect(page).toHaveURL(/[?&]universe=custom/u);
});

test("the sector rotation page fits a 375px screen", async ({
  browserErrors,
  page,
}) => {
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/sectorRotation/map",
    status: 404,
  });
  await page.setViewportSize({ height: 800, width: 375 });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/sector-rotation");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sector rotation" })
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
