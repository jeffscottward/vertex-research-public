import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Research lenses (rotation matrix, TRUE SLAP deep value screen). The E2E server has no
// VERTEX_RESEARCH_LENSES_URL, so both pages must render and report "not configured" without failing.
// The on-demand score calls Yahoo and SEC, so it is not submitted here (and no ?symbol= is opened).
// Research only; no order path.

test("the rotation matrix page reports an unconfigured lens service and keeps the period in the URL", async ({
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
  await expect(
    page.getByRole("button", { exact: true, name: "Refresh" })
  ).toBeVisible();
  const matrix = page.getByRole("region", { exact: true, name: "Matrix" });
  const period = matrix.getByRole("group", { name: "Period" });
  await expect(
    period.getByRole("button", { exact: true, name: "1M" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(matrix.getByRole("alert")).toContainText(
    "Research lens endpoint not configured"
  );

  await period.getByRole("button", { exact: true, name: "6M" }).click();
  await expect(page).toHaveURL(/\/rotation-matrix\?period=6M$/u);
  await expect(
    period.getByRole("button", { exact: true, name: "6M" })
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto("/rotation-matrix?period=3M");
  await expect(
    page
      .getByRole("region", { exact: true, name: "Matrix" })
      .getByRole("group", { name: "Period" })
      .getByRole("button", { exact: true, name: "3M" })
  ).toHaveAttribute("aria-pressed", "true");
});

test("the deep value page keeps the ticker form and screen controls usable without a stored ranking", async ({
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
  const ranking = page.getByRole("region", {
    exact: true,
    name: "TRUE SLAP ranking",
  });
  await expect(ranking.getByRole("alert")).toContainText(
    "Stored ranking unavailable: Research lens endpoint not configured"
  );
  // No ?symbol=: the score panel shows only its form, no scorecard.
  const score = page.getByRole("region", {
    exact: true,
    name: "Ticker scorecard",
  });
  await expect(score.getByLabel("Score any ticker")).toBeEditable();
  await expect(
    score.getByRole("button", { exact: true, name: "Score" })
  ).toBeEnabled();
  await expect(score.getByRole("region")).toHaveCount(0);

  // The screen filters live in the ranking panel header and in the URL.
  await ranking.getByLabel("Show", { exact: true }).selectOption("ours");
  await ranking.getByLabel("Min score", { exact: true }).fill("6");
  await ranking.getByLabel("Hide penny / illiquid / dilution").check();
  await expect(page).toHaveURL(/\/deep-value\?show=ours&min=6&hide=1$/u);

  await page.goto("/deep-value?show=re-entry&q=ore");
  await expect(
    page
      .getByRole("region", { exact: true, name: "TRUE SLAP ranking" })
      .getByLabel("Show", { exact: true })
  ).toHaveValue("re-entry");
  await expect(
    page
      .getByRole("region", { exact: true, name: "TRUE SLAP ranking" })
      .getByLabel("Filter", { exact: true })
  ).toHaveValue("ore");
});
