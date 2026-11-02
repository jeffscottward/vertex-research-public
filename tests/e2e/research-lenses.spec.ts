import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Research lenses (rotation matrix, TRUE SLAP deep value screen). The E2E server has no
// VERTEX_RESEARCH_LENSES_URL, so both pages must render and report "not configured" without failing.
// The on-demand score calls Yahoo and SEC, so it is not submitted here. Research only; no order path.

test("the rotation matrix page reports an unconfigured lens service", async ({
  browserErrors,
  page,
}) => {
  // NOT_CONFIGURED answers HTTP 503; the page shows it as an alert.
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/researchLenses/rotationMatrix",
    status: 503,
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/rotation-matrix");
  await expect(
    page.getByRole("heading", { level: 1, name: "Rotation matrix" })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "1M" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("alert")).toContainText(
    "Research lens endpoint not configured"
  );
});

test("the deep value page keeps the ticker form usable without a stored ranking", async ({
  browserErrors,
  page,
}) => {
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/researchLenses/deepValue",
    status: 503,
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/deep-value");
  await expect(
    page.getByRole("heading", { level: 1, name: "Deep value screen" })
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Stored ranking unavailable: Research lens endpoint not configured"
  );
  await expect(page.getByLabel("Score any ticker")).toBeEditable();
  await expect(page.getByRole("button", { name: "Score" })).toBeEnabled();
});
