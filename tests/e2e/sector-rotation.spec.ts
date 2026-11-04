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
  // The daily map is not collected either; the tab switch reloads and keeps the notice.
  await page.getByRole("tab", { name: "Daily" }).click();
  await expect(page.getByRole("tab", { name: "Daily" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("alert")).toContainText(
    "Sector rotation not yet collected"
  );
  // A custom list waits for Apply and does not call the map.
  await page.getByLabel("Universe").selectOption("custom");
  await expect(
    page.getByText("Type up to 30 tickers and select Apply to draw them.")
  ).toBeVisible();
  await expect(
    page.getByLabel("Tickers (comma or space separated)")
  ).toBeEditable();
});
